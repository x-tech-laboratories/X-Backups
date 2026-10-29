// One borg repository watched and driven over a shell on its host's agent, with borg 1 or borg 2 as borg_version says.
//
// Each poll lists the archives as JSON, plus `borg info --json` when collect_stats is on, each as its own command; they run
// one after another so the calls never fight over borg's cache lock. A borg error, an empty repo, or a newest archive older than max_age is
// failed; an unreachable host, a missing borg, an unreadable repo, a lock borg gave up on, or unparseable output is
// unavailable. Optional extras are a restore canary, check freshness read from systemd units or tracked per kind, and
// actions that back up, browse, restore, download, diff, check, compact, prune, delete and purge, the last ones as long runs
// the agent keeps going on its own.

import { readFileSync } from "node:fs";

import {
  CHECK_KINDS, TRACKED_CHECKS, canary_verdict, check_run_kind, check_unit_script, covered_by_check_run,
  merge_unit, observed_unit, parse_check_units, type CheckState,
} from "./checks.ts";
import { format_age, format_duration, parse_duration } from "./durations.ts";
import {
  LIST_FORMAT, PRUNE_LINE, RepoView, children_filter, decode_json, diff_line, format_size, is_object, parse_diff,
  parse_listing, parse_size, split_run_output, type ArchiveEntry, type DiffChange, type ListingEntry,
} from "./parsing.ts";
import {
  BASE_DIR_VAR, INHIBIT_SCRIPT, PASSPHRASE_VAR, STEP_MARK, archive_member, as_list, failure_hint, list_unavailable, piped, preflight_script,
  redact, shell_quote, skip_reason, ssh_endpoint, then_steps, when_folder_empty, with_passphrase, with_preflight, wrap_job,
} from "./shell.ts";
import type { LongRunPoll } from "../../shared/agent_protocol.ts";
import {
  ActionPlan, CollectResult, LongRunPlan, empty_state, type ActionStart, type CanaryRecord, type ChecksRecord, type CmdResult, type Command,
  type DownloadPlan, type RunRecord, type RunStore, type LogEntry, type MonitorStatus, type RepositoryState, type RepositoryStats,
  type StorageRecord,
} from "./types.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

const KEEP_OPTIONS = [
  "keep_within", "keep_last", "keep_secondly", "keep_minutely", "keep_hourly",
  "keep_daily", "keep_weekly", "keep_monthly", "keep_yearly",
] as const;

type KeepOption = typeof KEEP_OPTIONS[number];

export interface BorgConfig extends Partial<Record<KeepOption, number | string>> {
  id?: string;
  timeout?: number | string;
  repo?: string;
  max_age?: number | string;
  warn_age?: number | string;
  quota?: number | string;
  passphrase?: string;
  passphrase_file?: string;
  passphrase_command?: string;
  borg_version?: number;
  borg_bin?: string;
  lock_wait?: number | string;
  require_sudo?: boolean;
  list_archives?: number;
  collect_stats?: boolean;
  ssh_key?: string;
  rsh?: string;
  source_paths?: string | string[];
  exclude?: string | string[];
  exclude_from?: string;
  exclude_caches?: boolean;
  exclude_if_present?: string | string[];
  one_file_system?: boolean;
  compression?: string;
  archive_prefix?: string;
  cache_dir?: string;
  backup_lock_wait?: number | string;
  canary_path?: string;
  canary_interval?: number | string;
  canary_warn_age?: number | string;
  canary_max_age?: number | string;
  check_units?: string | string[];
  check_max_age?: number | string;
  check_warn_age?: number | string;
  restore_dir?: string;
  browse_limit?: number;
  prune_match?: string;
  allow_delete?: boolean;
  check_verify_data?: boolean;
  allow_purge?: boolean;
  purge_match?: string;
  prune_after_backup?: boolean;
  compact_after_backup?: boolean;
  skip_when_unreachable?: boolean;
  skip_while_active?: string | string[];
  job_nice?: number | string;
  job_io_idle?: boolean;
  inhibit_sleep?: boolean;
  job_lock?: string;
  check_kinds?: Record<string, number | string>;
}

// What a target narrows its repository to: the archives it lists and judges fresh, and the target that offers the
// repository's own actions, compact and check, when that is another one polling the same repository.
export interface TargetScope {
  list_match?: string | null;
  repository_actions_on?: string | null;
}

// Keeps the "Processing" lines and the top-most excluded path of each dropped tree, then exits with borg's status.
export function topmost_excluded(flag: string): string {
  return `awk -v flag=${shell_quote(flag + " ")} '/^__x_backups_rc=/ { rc = substr($0, 16); next } ` +
    "index($0, flag) == 1 { p = substr($0, 3); if (top != \"\" && index(p, top \"/\") == 1) next; top = p; print; next } " +
    "{ top = \"\"; print } END { exit rc }'";
}

// How many listed folders the browser keeps before forgetting the least recently used.
const LISTING_CACHE = 256;

// How many archives' diffs are kept for the archive page before forgetting the least recently used.
const DIFF_CACHE = 16;

// What a run shows while its host's agent is away; the run keeps going on the host and is followed again on reconnect.
export const WAITING_FOR_AGENT = "Waiting for its host's agent to connect";

// ── Action shapes ────────────────────────────────────────────────────────────

export interface ActionSpec {
  name: string;
  action_id: string;
  // The run kinds that show this action as running.
  run?: string | string[];
  confirm?: string;
  detached?: boolean;
}

export type ActionState = "normal" | "accent" | "disabled" | "hidden";

export interface BackupSummary {
  repo: string | null;
  newest_archive_epoch: number | null;
  newest_archive_age: number | null;
  max_age: number;
  fresh: boolean;
  restore_check: boolean | null;
  restore_checked_epoch: number | null;
  repo_checks: boolean | null;
  repo_checked_epoch: number | null;
}

interface CachedListing {
  archive: string;
  member: string;
  entries: ListingEntry[];
}

// ── Repository ───────────────────────────────────────────────────────────────

export class BorgRepository {
  static readonly DEFAULT_TIMEOUT = 180;

  readonly name: string;
  readonly id: string;
  timeout: number;
  state: RepositoryState = empty_state();
  runs: RunStore | null = null;

  repo: string | null;
  max_age: number;
  // Each warning age gives a warning before its maximum age turns critical; zero leaves it off.
  warn_age: number;
  // The most the repository may store, in bytes, which its storage bar is drawn against; zero leaves it to the filesystem.
  quota: number;
  passphrase: string | null;
  passphrase_file: string | null;
  passphrase_command: string | null;
  borg_version: 1 | 2;
  borg_bin: string;
  lock_wait: number | string;
  require_sudo: boolean;
  list_archives: number;
  collect_stats: boolean;
  ssh_key: string | null;
  rsh: string | null;

  source_paths: string[];
  exclude: string[];
  exclude_from: string | null;
  exclude_caches: boolean;
  exclude_if_present: string[];
  one_file_system: boolean;
  compression: string;
  archive_prefix: string;
  cache_dir: string;
  // Only a configured folder is known to be writable on a watch-only host, so polls otherwise use a throwaway one.
  cache_dir_configured: boolean;
  backup_lock_wait: number | string;
  canary_path: string | null;
  canary_interval: number;
  canary_warn_age: number;
  canary_max_age: number;
  check_units: string[];
  check_max_age: number;
  check_warn_age: number;
  restore_dir: string;
  browse_limit: number;
  retention: Partial<Record<KeepOption, number | string>>;
  prune_match: string;
  allow_delete: boolean;
  check_verify_data: boolean;
  allow_purge: boolean;
  // Unset means every archive, since the repo may be shared with the tool that owns it.
  purge_match: string | null;

  prune_after_backup: boolean;
  compact_after_backup: boolean;
  skip_when_unreachable: boolean;
  skip_while_active: string[];
  job_nice: number | null;
  job_io_idle: boolean;
  inhibit_sleep: boolean;
  job_lock: string | null;
  check_kinds: Record<string, number>;
  list_match: string | null;
  repository_actions_on: string | null;

  poll_calls: string[] = [];
  // Archives never change once written, so a folder listed once stays true until the archive is deleted.
  private listings = new Map<string, CachedListing>();
  // Each diffed pair's changes, keyed by both names since a prune can change the archive before one.
  private diffs = new Map<string, { changes: DiffChange[]; more: boolean }>();

  constructor(name: string, config: BorgConfig, scope: TargetScope = {}) {
    this.name = name;
    this.id = config.id ?? name;
    this.timeout = parse_duration(config.timeout ?? BorgRepository.DEFAULT_TIMEOUT);

    this.repo = config.repo ?? null;
    this.max_age = parse_duration(config.max_age ?? "1d");
    this.warn_age = parse_duration(config.warn_age ?? 0);
    if (this.warn_age > 0 && this.warn_age >= this.max_age) throw new Error("warn_age must be shorter than max_age");
    this.quota = parse_size(config.quota ?? 0);
    this.passphrase = config.passphrase ?? null;
    this.passphrase_file = config.passphrase_file ?? null;
    this.passphrase_command = config.passphrase_command ?? null;
    const version = config.borg_version ?? 1;
    if (version !== 1 && version !== 2) throw new Error(`borg_version must be 1 or 2, not ${version}`);
    this.borg_version = version;
    this.borg_bin = config.borg_bin ?? (version === 2 ? "borg2" : "borg");
    this.lock_wait = config.lock_wait ?? 30;
    this.require_sudo = Boolean(config.require_sudo ?? false);
    this.list_archives = Math.max(1, Math.trunc(Number(config.list_archives ?? 10)));
    this.collect_stats = Boolean(config.collect_stats ?? true);
    this.ssh_key = config.ssh_key ?? null;
    this.rsh = config.rsh ?? null;

    this.source_paths = as_list(config.source_paths);
    this.exclude = as_list(config.exclude);
    this.exclude_from = config.exclude_from ?? null;
    this.exclude_caches = Boolean(config.exclude_caches ?? true);
    this.exclude_if_present = as_list(config.exclude_if_present);
    this.one_file_system = Boolean(config.one_file_system ?? true);
    this.compression = config.compression ?? "zstd";
    this.archive_prefix = config.archive_prefix ?? name;
    this.cache_dir = config.cache_dir ?? "/var/cache/x-monitor-borg";
    this.cache_dir_configured = Boolean(config.cache_dir);
    this.backup_lock_wait = config.backup_lock_wait ?? 600;
    this.canary_path = config.canary_path ?? null;
    this.canary_interval = parse_duration(config.canary_interval ?? "1d");
    this.canary_warn_age = parse_duration(config.canary_warn_age ?? 0);
    this.canary_max_age = parse_duration(config.canary_max_age ?? 0);
    if (this.canary_warn_age > 0 && this.canary_max_age > 0 && this.canary_warn_age >= this.canary_max_age) throw new Error("canary_warn_age must be shorter than canary_max_age");
    this.check_units = as_list(config.check_units);
    this.check_max_age = parse_duration(config.check_max_age ?? "8d");
    this.check_warn_age = parse_duration(config.check_warn_age ?? 0);
    this.restore_dir = config.restore_dir ?? "/var/tmp/x-backups-restore";
    this.browse_limit = Math.max(1, Math.trunc(Number(config.browse_limit ?? 2000)));
    this.retention = {};
    for (const key of KEEP_OPTIONS) {
      const value = config[key];
      if (value !== undefined && value !== null && value !== "" && value !== 0) this.retention[key] = value;
    }
    if (version === 2 && this.retention.keep_within !== undefined && this.retention.keep_last !== undefined) {
      throw new Error("borg 2 takes keep_within and keep_last as one --keep, so set only one of them");
    }
    this.prune_match = config.prune_match ?? `${this.archive_prefix}-*`;
    this.allow_delete = Boolean(config.allow_delete ?? false);
    this.check_verify_data = Boolean(config.check_verify_data ?? false);
    this.allow_purge = Boolean(config.allow_purge ?? false);
    this.purge_match = config.purge_match ?? null;

    this.prune_after_backup = Boolean(config.prune_after_backup ?? false);
    this.compact_after_backup = Boolean(config.compact_after_backup ?? false);
    if (this.prune_after_backup && Object.keys(this.retention).length === 0) {
      throw new Error("prune_after_backup needs a keep_* retention policy");
    }
    this.skip_when_unreachable = Boolean(config.skip_when_unreachable ?? true);
    this.skip_while_active = as_list(config.skip_while_active);
    this.job_nice = config.job_nice !== undefined && config.job_nice !== null ? Math.trunc(Number(config.job_nice)) : null;
    this.job_io_idle = Boolean(config.job_io_idle ?? false);
    this.inhibit_sleep = Boolean(config.inhibit_sleep ?? false);
    this.job_lock = config.job_lock ?? null;
    this.check_kinds = {};
    for (const [kind, age] of Object.entries(config.check_kinds ?? {})) this.check_kinds[kind] = parse_duration(age);
    const unknown = Object.keys(this.check_kinds).filter((kind) => !(TRACKED_CHECKS as readonly string[]).includes(kind)).sort();
    if (unknown.length > 0) {
      throw new Error(`check_kinds has unknown kinds ${JSON.stringify(unknown)}; use repository, archives, data or extract`);
    }
    this.list_match = scope.list_match ?? null;
    this.repository_actions_on = scope.repository_actions_on ?? null;
  }

  // ── Building borg commands ─────────────────────────────────────────────────

  // The passphrase borg reads from stdin, or null when none is set or its file cannot be read.
  private secret(): string | null {
    if (this.passphrase !== null) return this.passphrase;
    if (this.passphrase_file === null) return null;
    try {
      return readFileSync(this.passphrase_file, "utf8").replace(/\n+$/, "");
    } catch {
      return null;
    }
  }

  // The stdin for commands that read the passphrase, or null when none of them does.
  private stdin_for(commands: string[]): string | null {
    if (!commands.some((command) => command.includes(PASSPHRASE_VAR))) return null;
    const secret = this.secret();
    return secret === null ? null : secret + "\n";
  }

  private env_prefix(persistent_cache: boolean, has_secret: boolean): string[] {
    const env: string[] = [];
    if (has_secret) {
      env.push("BORG_PASSPHRASE_FD=0");
    } else if (this.passphrase === null && this.passphrase_file === null && this.passphrase_command !== null) {
      env.push("BORG_PASSCOMMAND=" + shell_quote(this.passphrase_command));
    }
    env.push("BORG_RELOCATED_REPO_ACCESS_IS_OK=no");
    // Borg 2 reports warnings and errors as many specific codes, and legacy folds them back into borg 1's 1 and 2.
    if (this.borg_version === 2) env.push("BORG_EXIT_CODES=legacy");

    if (this.rsh || this.ssh_key) {
      const rsh = this.rsh || `ssh -i ${shell_quote(this.ssh_key!)} -o IdentitiesOnly=yes -o BatchMode=yes`;
      env.push("BORG_RSH=" + shell_quote(rsh));
    }

    if (persistent_cache && this.cache_dir) {
      env.push("BORG_BASE_DIR=" + shell_quote(this.cache_dir));
    } else {
      env.push(`BORG_BASE_DIR="$${BASE_DIR_VAR}"`);
    }
    return env;
  }

  private build(args: string[], options: { persistent_cache?: boolean } = {}): string {
    const persistent_cache = options.persistent_cache ?? false;
    const has_secret = this.secret() !== null;
    // printf is a shell builtin, so the passphrase reaches borg's stdin without ever being an argument.
    const feed = has_secret ? [`printf '%s\\n' "$${PASSPHRASE_VAR}"`, "|"] : [];
    const prefix = this.require_sudo ? ["sudo", "-n"] : [];
    const command = [...feed, ...prefix, ...this.env_prefix(persistent_cache, has_secret), ...args.map(shell_quote)].join(" ");
    if (persistent_cache && this.cache_dir) return command;
    // The trap keeps the throwaway folder throwaway, since borg builds a full chunks cache in it every poll.
    return `${BASE_DIR_VAR}=$(mktemp -d); trap 'rm -rf "$${BASE_DIR_VAR}"' EXIT; ${command}`;
  }

  // The repository as borg takes it: a bare path in borg 1, after -r in borg 2.
  private repo_args(): string[] {
    return this.borg_version === 2 ? ["-r", this.repo!] : [this.repo!];
  }

  // One archive as borg takes it: repo::name in borg 1, -r and the bare name in borg 2.
  private archive_args(archive: string): string[] {
    return this.borg_version === 2 ? ["-r", this.repo!, archive] : [`${this.repo}::${archive}`];
  }

  // The archives whose names match a shell pattern.
  private match_args(pattern: string): string[] {
    return this.borg_version === 2 ? ["-a", `sh:${pattern}`] : ["--glob-archives", pattern];
  }

  // The named calls this poll makes, in the order they run.
  poll_plan(): [name: string, command: string][] {
    const calls: [string, string][] = [["list", this.list_command()]];
    if (this.collect_stats) calls.push(["info", this.info_command()]);
    const archive = this.canary_archive();
    if (archive && this.canary_due()) calls.push(...this.canary_calls(archive));
    if (this.check_units.length > 0) calls.push(["checks", check_unit_script(this.check_units)]);
    const path = this.local_path();
    if (path !== null) calls.push(["space", `df -B1 --output=size,avail -- ${shell_quote(path)}`]);
    return calls;
  }

  // The repository's folder when it is on the host itself, the only case whose free space a poll can read.
  private local_path(): string | null {
    if (!this.repo || this.repo.includes("://") || /^[^/]*:/.test(this.repo)) return null;
    return this.repo;
  }

  private read_options(): { persistent_cache: boolean } {
    return { persistent_cache: this.cache_dir_configured };
  }

  list_command(): string {
    // Never add --bypass-lock to a read: borg rewrites the index on open, and unlocked mid-compaction that corrupts it.
    const command = this.borg_version === 2 ? "repo-list" : "list";
    return this.build([
      this.borg_bin, command, "--last", String(this.list_archives), ...this.list_scope(), "--json", "--lock-wait", String(this.lock_wait), ...this.repo_args(),
    ], this.read_options());
  }

  info_command(): string {
    return this.build([
      this.borg_bin, "info", "--json", "--last", String(this.list_archives), ...this.list_scope(), "--lock-wait", String(this.lock_wait), ...this.repo_args(),
    ], this.read_options());
  }

  // A target lists only its own archives, so another target's newer archive never makes it look fresh.
  private list_scope(): string[] {
    return this.list_match === null ? [] : this.match_args(this.list_match);
  }

  backup_command(options: { archive_name?: string; dry_run?: boolean } = {}): string {
    const name = options.archive_name || this.default_archive_name();
    const args = [this.borg_bin, "create", "--log-json", "--progress", "--compression", this.compression];
    args.push(options.dry_run ? "--dry-run" : "--stats");
    if (this.one_file_system) args.push("--one-file-system");
    args.push(...this.exclude_args());
    args.push("--lock-wait", String(this.backup_lock_wait));
    args.push(...this.archive_args(name));
    args.push(...this.source_paths);
    return this.build(args, { persistent_cache: true });
  }

  // The exclusions a backup applies, which a purge also uses to rewrite existing archives to match.
  private exclude_args(): string[] {
    const args: string[] = [];
    if (this.exclude_caches) args.push("--exclude-caches");
    for (const marker of this.exclude_if_present) args.push("--exclude-if-present", marker);
    for (const pattern of this.exclude) args.push("--exclude", pattern);
    if (this.exclude_from) args.push("--exclude-from", this.exclude_from);
    return args;
  }

  // The prefix and the local time, matching the names borgmatic and Vorta give their archives.
  default_archive_name(): string {
    return `${this.archive_prefix}-${local_stamp(new Date())}`;
  }

  // ── Polling ────────────────────────────────────────────────────────────────

  // A poll's borg calls; while a run is going, its owner follows the run on its agent instead.
  commands(): Command[] {
    const timeout = this.timeout || null;
    if (!this.repo) return [];
    const plan = this.poll_plan();
    this.poll_calls = plan.map(([name]) => name);
    // df needs no passphrase, so it is not handed one.
    return plan.map(([name, text]) => name === "space" ? { text, timeout, stdin: null } : { text: with_passphrase(text), timeout, stdin: this.stdin_for([text]) });
  }

  // The run going now that its agent knows of, which a poll follows in place of listing the repository.
  active_run(): RunRecord | null {
    const run = this.runs ? this.runs.running() : null;
    return run && run.agent_run ? run : null;
  }

  parse(results: CmdResult[]): CollectResult {
    if (!this.repo) return CollectResult.failed("No 'repo' configured for borg monitor");

    const names = this.poll_calls.length > 0 ? this.poll_calls : (this.collect_stats ? ["list", "info"] : ["list"]);
    const by_name = new Map(names.map((name, index) => [name, results[index]]));
    const list_result = by_name.get("list")!;
    const { stdout, stderr, exit_code } = list_result;
    const logs: LogEntry[] = [[`Running: ${redact(this.list_command())}`, "INFO"]];
    const state: RepositoryState = { ...this.state, last_poll_epoch: now_seconds() };

    if (exit_code !== 0) {
      const detail = (stderr || stdout).trim();
      logs.push([`borg list failed (exit ${exit_code}): ${detail}`, "ERROR"]);
      const hint = failure_hint(detail);
      if (hint) logs.push([hint, "ERROR"]);
      return new CollectResult({ state, logs, status: list_unavailable(exit_code, detail) ? "unavailable" : "failed" });
    }

    const view = RepoView.from_stdout(stdout);
    if (!view.valid) {
      logs.push(["Could not parse borg output — no archive timestamps found", "ERROR"]);
      const snippet = (stdout || stderr || "").trim().slice(0, 500);
      if (snippet) logs.push([`Raw output was: ${snippet}`, "ERROR"]);
      return new CollectResult({ state, logs, status: "unavailable" });
    }

    logs.push(...this.repo_detail_logs(view));
    Object.assign(state, {
      archives: view.archives, repository: view.info, archive_count: view.raw_count, last_backup_epoch: view.newest_epoch,
    });

    if (view.raw_count === 0 || view.newest_epoch === 0) {
      logs.push(["No archives in repository", "WARNING"]);
      return new CollectResult({ state, logs, status: "failed" });
    }

    let status: MonitorStatus;
    const age = now_seconds() - view.newest_epoch;
    if (age > this.max_age) {
      logs.push([`Last archive was ${format_age(age)}, exceeds max_age of ${format_duration(this.max_age)}`, "WARNING"]);
      status = "failed";
    } else {
      logs.push([`Last archive ${format_age(age)}`, "INFO"]);
      status = "online";
    }

    if (this.collect_stats && by_name.has("info")) {
      const stats = this.parse_repo_stats(by_name.get("info")!, view.archives);
      if (stats.stats !== null) state.stats = stats.stats;
      logs.push(...stats.logs);
      if (stats.merged_archives !== null) state.archives = stats.merged_archives;
    }

    const space = by_name.get("space");
    if (space !== undefined) state.storage = parse_space(space) ?? state.storage ?? null;

    const extras = [this.fold_canary(by_name, state, logs), this.fold_checks(by_name, state, logs)];
    if (extras.includes("failed")) status = "failed";
    else if (status === "online" && this.past_warning_age(state, view.newest_epoch)) status = "warning";
    return new CollectResult({ state, logs, status });
  }

  // Whether the newest archive, the oldest passing check or the canary is past its warning age; each age is off at zero.
  private past_warning_age(state: RepositoryState, newest_epoch: number): boolean {
    const now = now_seconds();
    const past = (epoch: number | null | undefined, limit: number) => limit > 0 && Boolean(epoch) && now - epoch! > limit;
    return past(newest_epoch, this.warn_age)
      || past(state.checks?.oldest_ok_epoch, this.check_warn_age)
      || (this.canary_path !== null && past(state.canary?.checked_epoch, this.canary_warn_age));
  }

  private repo_detail_logs(view: RepoView): LogEntry[] {
    const logs: LogEntry[] = [];
    const parts: string[] = [];
    if (view.info.location) parts.push(`location=${view.info.location}`);
    if (view.info.encryption) parts.push(`encryption=${view.info.encryption}`);
    if (view.info.last_modified) parts.push(`last_modified=${view.info.last_modified}`);
    if (parts.length > 0) logs.push(["Repository: " + parts.join(", "), "INFO"]);

    if (view.archives.length === 0) return logs;
    logs.push([`${view.archives.length} most recent archive(s):`, "INFO"]);
    for (const archive of view.archives) {
      const age = archive.epoch ? format_age(now_seconds() - archive.epoch) : "unknown age";
      logs.push([`  ${archive.name} (${age})`, "INFO"]);
    }
    return logs;
  }

  // Reads `borg info` output into repository stats and per-archive sizes merged onto the listed archives.
  private parse_repo_stats(info_result: CmdResult, archives: ArchiveEntry[]): { stats: RepositoryStats | null; logs: LogEntry[]; merged_archives: ArchiveEntry[] | null } {
    const { exit_code, stdout, stderr } = info_result;
    if (exit_code !== 0) {
      return { stats: null, logs: [[`borg info failed (exit ${exit_code}): ${(stderr || stdout).trim().slice(0, 200)}`, "WARNING"]], merged_archives: null };
    }

    const data = decode_json(stdout);
    const sizes = parse_archive_sizes(data);
    let merged_archives: ArchiveEntry[] | null = null;
    if (sizes.size > 0 && archives.length > 0) {
      merged_archives = archives.map((archive) => ({ ...archive, ...sizes.get(archive.name) }));
    }
    // Borg 2 keeps no repository-wide sizes, so only the archives' own are read.
    if (this.borg_version === 2) return { stats: null, logs: [], merged_archives };

    const stats = parse_stats(data);
    if (Object.keys(stats).length === 0) {
      return { stats: null, logs: [["Could not parse borg info output", "WARNING"]], merged_archives };
    }

    const logs: LogEntry[] = [];
    const original = stats.original_size ?? 0;
    const deduplicated = stats.deduplicated_size ?? 0;
    if (original && deduplicated) {
      const ratio = original / deduplicated;
      stats.dedup_ratio = ratio;
      logs.push([`Repo size: ${format_size(deduplicated)} on disk for ${format_size(original)} of data (${ratio.toFixed(1)}x reduction)`, "INFO"]);
    }
    return { stats, logs, merged_archives };
  }

  // ── Restore canary ─────────────────────────────────────────────────────────

  // The newest archive the last poll saw, which the canary is restored from.
  private canary_archive(): string | null {
    if (!this.canary_path) return null;
    return this.state.archives[0]?.name ?? null;
  }

  private canary_due(): boolean {
    const canary = this.state.canary;
    return canary === null || Date.now() / 1000 - canary.checked_epoch >= this.canary_interval;
  }

  // Extracts the canary from the archive to stdout, then reads the live file it should match.
  canary_calls(archive: string): [name: string, command: string][] {
    const extract = this.build([
      this.borg_bin, "extract", "--stdout", "--lock-wait", String(this.lock_wait),
      ...this.archive_args(archive), archive_member(this.canary_path) || this.canary_path!,
    ], this.read_options());
    const path = shell_quote(this.canary_path!);
    // A canary is normally world-readable, and sudo rules allowing only borg would refuse `sudo cat`; braced so one redirect covers both.
    const live = this.require_sudo ? `{ cat ${path} 2>/dev/null || sudo -n cat ${path}; }` : `cat ${path}`;
    return [["canary", extract], ["canary_live", live]];
  }

  // The verdict of a restore check that ran, or null when none ran or it reached no verdict.
  private read_canary(by_name: Map<string, CmdResult>, logs: LogEntry[]): CanaryRecord | null {
    if (!by_name.has("canary")) return null;
    const [verdict, detail] = canary_verdict(by_name.get("canary")!, by_name.get("canary_live")!);
    if (verdict === null) {
      logs.push([`Restore check skipped: ${detail}`, "WARNING"]);
      return null;
    }
    logs.push([`Restore check ${verdict ? "passed" : "failed"}: ${detail}`, verdict ? "INFO" : "ERROR"]);
    return { ok: verdict, checked_epoch: now_seconds(), detail };
  }

  // Records this poll's restore check if one ran, and answers failed while the last verdict stands failed.
  private fold_canary(by_name: Map<string, CmdResult>, state: RepositoryState, logs: LogEntry[]): MonitorStatus | null {
    const canary = this.read_canary(by_name, logs);
    if (canary !== null) state.canary = canary;
    if (!this.canary_path) return null;
    return state.canary !== null && !state.canary.ok ? "failed" : null;
  }

  // ── Check freshness ────────────────────────────────────────────────────────

  private stored_checks(): Record<string, CheckState> {
    return { ...this.state.checks?.checks };
  }

  // Folds the check units' journal into the stored record and answers failed when any check is failed or stale.
  private fold_checks(by_name: Map<string, CmdResult>, state: RepositoryState, logs: LogEntry[]): MonitorStatus | null {
    if (this.check_units.length === 0 && Object.keys(this.check_kinds).length === 0) return null;
    const states = this.stored_checks();
    const result = by_name.get("checks");
    if (result !== undefined) {
      const seen = parse_check_units(result.stdout);
      if (Object.keys(seen).length === 0) {
        logs.push([`Could not read the check units' journal: ${(result.stderr || "no output").trim().slice(0, 200)}`, "WARNING"]);
        if (Object.keys(this.check_kinds).length === 0) return null;
      } else {
        for (const unit of this.check_units) {
          states[unit] = merge_unit(states[unit] ?? {}, observed_unit(seen[unit] ?? { err: [], values: {} }, this.repo!));
        }
      }
    }
    state.checks = this.judge_checks(states, logs);
    return state.checks.passed ? null : "failed";
  }

  // Every check held to an age, by its stored name, with its label, max age and the setting that sets it.
  private expected_checks(): Map<string, [label: string, max_age: number, setting: string]> {
    const expected = new Map<string, [string, number, string]>();
    for (const unit of this.check_units) expected.set(unit, [unit, this.check_max_age, "check_max_age"]);
    for (const [kind, max_age] of Object.entries(this.check_kinds)) expected.set(kind, [`${kind} check`, max_age, `check_kinds.${kind}`]);
    return expected;
  }

  // Judges every expected check against its maximum age, keeping all the records and logging each problem.
  private judge_checks(states: Record<string, CheckState>, logs: LogEntry[]): ChecksRecord {
    const now = now_seconds();
    const problems: string[] = [];
    const oks: number[] = [];
    for (const [name, [label, max_age, setting]] of this.expected_checks()) {
      const state = states[name] ?? {};
      if (Object.hasOwn(this.check_kinds, name) && !state.ok && !state.failed) {
        // A kind never run gets one max age from when it was first expected, so a new schedule has time to reach it.
        const since = state.since || now;
        states[name] = { ...state, since };
        if (now - since <= max_age) {
          logs.push([`Repository check: ${label} has not run yet`, "INFO"]);
        } else {
          problems.push(`${label} has not run within ${setting} of ${format_duration(max_age)}`);
        }
        continue;
      }
      oks.push(state.ok || 0);
      if (state.failed) {
        problems.push(`${label} last run failed: ${state.error || "see its journal"}`);
      } else if (!state.ok) {
        problems.push(`${label} has no successful run on record`);
      } else if (now - state.ok > max_age) {
        problems.push(`${label} last succeeded ${format_age(now - state.ok)}, exceeds ${setting} of ${format_duration(max_age)}`);
      }
    }
    for (const problem of problems) logs.push([`Repository check: ${problem}`, "ERROR"]);
    if (oks.length > 0 && problems.length === 0) {
      logs.push([`Repository checks passed, oldest ${format_age(now - Math.min(...oks))}`, "INFO"]);
    }
    return { checks: states, passed: problems.length === 0, oldest_ok_epoch: oks.length > 0 ? Math.min(...oks) : 0 };
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  get_actions(): ActionSpec[] {
    const actions: ActionSpec[] = [];
    const has_retention = Object.keys(this.retention).length > 0;
    if (this.source_paths.length > 0) {
      actions.push(
        { name: "Run Backup", action_id: "run_backup", run: "backup" },
        { name: "Dry Run", action_id: "dry_run_backup", run: "dry-run" },
      );
    }
    if (this.canary_path) {
      actions.push({ name: "Verify Restore", action_id: "verify_restore", detached: true });
    }
    if (this.repo && this.repository_actions_on === null) {
      actions.push(
        { name: "Check", action_id: "check_repo", run: Object.keys(CHECK_KINDS).map(check_run_kind) },
        { name: "Compact", action_id: "compact_repo", run: "compact" },
      );
    }
    if (has_retention) {
      actions.push({ name: "Prune Preview", action_id: "prune_preview" });
    }
    if (this.allow_delete && has_retention) {
      actions.push({
        name: "Prune", action_id: "prune_repo", run: "prune",
        confirm: `Prune ${this.repo} by its retention policy? Archives it drops are gone for good — run Prune Preview ` +
          "first to see which. Space is freed by a Compact afterwards.",
      });
    }
    if (this.allow_purge) {
      actions.push(
        { name: "Purge Preview", action_id: "purge_preview", run: "purge-preview" },
        {
          name: "Purge Excluded", action_id: "purge_excluded", run: "purge",
          confirm: `Rewrite every archive in ${this.repo} without the files its exclude patterns now drop, then compact? ` +
            "Those files are gone from every archive for good — run Purge Preview first to see which. It holds the " +
            "repository lock for the whole run, so backups wait until it ends.",
        },
      );
    }
    if (this.allow_delete) {
      actions.push({
        name: "Break Lock", action_id: "break_lock",
        confirm: `Break the locks on ${this.repo}? Only do this when no borg process is using it; breaking a live lock ` +
          "can corrupt the repository.",
      });
    }
    return actions;
  }

  // How an action shows now: accent while its run is going, disabled while another is, else normal.
  action_state(action: ActionSpec): ActionState {
    // Break Lock greys out while a run is going, since that run holds the lock it would break.
    if (action.action_id === "break_lock" && this.active_run() !== null) return "disabled";
    if (action.detached && this.runs) return this.runs.action_run(action.action_id) ? "accent" : "normal";
    const run = this.runs && action.run ? this.runs.running() : null;
    if (run === null) return "normal";
    const kinds = typeof action.run === "string" ? [action.run] : action.run ?? [];
    return kinds.includes(run.kind) ? "accent" : "disabled";
  }

  // Says why a run was skipped from its preflight's output, or that the preflight could not run, or null to go ahead.
  private read_preflight(kind: string, result: CmdResult): CollectResult | null {
    if (result.exit_code !== 0) {
      return CollectResult.failed(`Failed to launch ${kind}: ${(result.stderr || result.stdout).trim().slice(0, 200)}`);
    }
    const skipped = skip_reason(result.stdout);
    if (skipped === null) return null;
    const message = `${capitalize(kind)} skipped: ${skipped}`;
    return new CollectResult({ logs: [[message, "WARNING"]], content: message, success: true });
  }

  // Reports a run its agent started, or ends the run's record with why the agent could not start it.
  private read_start(kind: string, started: string, run_id: number, failure: string | null): CollectResult {
    if (failure !== null) {
      this.runs!.finish(run_id, "failed", { exit_code: -1, error: `Could not start: ${failure}` });
      return CollectResult.failed(`Failed to launch ${kind}: ${failure.slice(0, 200)}`);
    }
    const message = `${capitalize(kind)} started (run #${run_id})${started}`;
    return new CollectResult({ logs: [[message, "INFO"]], content: message, success: true });
  }

  // Compact and the repository check run once for the whole repository, from the target that offers them.
  private repository_refusal(): CollectResult | null {
    if (this.repository_actions_on === null) return null;
    return BorgRepository.refused(`Compact and check act on the whole repository, so they run from ${this.repository_actions_on}`);
  }

  // An action outcome that reports a problem without touching the monitor's status.
  static refused(message: string): CollectResult {
    return new CollectResult({ logs: [[message, "WARNING"]], content: message, success: false });
  }

  // A single borg call as an action, bounded like a poll, with its stdout filtered and cut to the first lines.
  private run_one(call: string, read: (result: CmdResult) => CollectResult, limit?: number, keep?: string): ActionPlan {
    return new ActionPlan([with_passphrase(capped(call, limit, keep))], ([result]) => read(result), {
      timeout: this.timeout || null, stdin: this.stdin_for([call]),
    });
  }

  // Borg calls as a detached action whose output reaches its log as it is written, the first one cut to the first lines.
  private run_detached(calls: string[], read: (results: CmdResult[]) => CollectResult, limit?: number): ActionPlan {
    const commands = calls.map((call, index) => with_passphrase(index === 0 ? capped(call, limit) : call));
    return new ActionPlan(commands, read, { stdin: this.stdin_for(calls), detached: true });
  }

  // Launches the command as a long run on the host's agent, after any preflight that may skip it.
  private launch(kind: string, command: string, started = ""): LongRunPlan {
    const wrapped = wrap_job(command, this.run_wrappers(kind), this.job_lock);
    const preflight = this.preflight();
    return new LongRunPlan({
      kind,
      preflight: preflight === null ? null : with_preflight(preflight, "true"),
      command: with_passphrase(wrapped, { exported: true }),
      stdin: this.stdin_for([command]),
      read_preflight: (result) => this.read_preflight(kind, result),
      record: () => this.runs!.create(kind, redact(wrapped)),
      read_start: (run_id, failure) => this.read_start(kind, started, run_id, failure),
    });
  }

  // The argv every run goes under: the shared job lock, the sleep inhibitor where the host has one, then the lowered
  // priority.
  private run_wrappers(kind: string): string[] {
    const argv: string[] = [];
    if (this.job_lock) argv.push("flock", this.job_lock);
    if (this.inhibit_sleep) argv.push("sh", "-c", INHIBIT_SCRIPT, `X-Backups borg ${kind} for ${this.name}`);
    if (this.job_nice !== null) argv.push("nice", "-n", String(this.job_nice));
    if (this.job_io_idle) argv.push("ionice", "-c", "3");
    return argv;
  }

  // Shell that finds a reason to skip a run before it starts, such as a repository server that is not answering.
  private preflight(): string | null {
    const endpoint = this.skip_when_unreachable ? ssh_endpoint(this.repo) : null;
    return preflight_script(endpoint, this.skip_while_active);
  }

  // The refusal for starting a run without a repo or while another one runs, else null.
  private run_refusal(what: string): CollectResult | null {
    if (!this.repo) return BorgRepository.refused(`Cannot ${what}: no 'repo' configured`);
    if (this.active_run() !== null) return BorgRepository.refused("A run is already going for this monitor");
    return null;
  }

  // ── Backup ─────────────────────────────────────────────────────────────────

  private backup_refusal(): CollectResult | null {
    if (!this.repo) return CollectResult.failed("Cannot back up: no 'repo' configured");
    if (this.source_paths.length === 0) return CollectResult.failed("Cannot back up: no 'source_paths' configured");
    if (this.active_run() !== null) return CollectResult.failed("A backup is already running for this monitor", "WARNING", null);
    return null;
  }

  dry_run_backup(): ActionStart {
    return this.backup_refusal() ?? this.launch("dry-run", this.backup_command({ dry_run: true }));
  }

  run_backup(): ActionStart {
    const refusal = this.backup_refusal();
    if (refusal) return refusal;
    const steps: [string, string][] = [];
    if (this.prune_after_backup) steps.push(["Pruning", this.maintenance_command([...this.prune_args(), ...this.repo_args()])]);
    // Compact acts on the whole repository, so of the targets sharing one only the one offering its actions compacts.
    if (this.compact_after_backup && this.repository_actions_on === null) steps.push(["Compacting", this.maintenance_command(["compact", "--progress", ...this.repo_args()])]);
    return this.launch("backup", then_steps(this.backup_command(), steps));
  }

  // ── Prune preview ──────────────────────────────────────────────────────────

  // Each keep_* setting as its borg option, where borg 2 folds keep_within and keep_last into --keep.
  private retention_flags(): [option: string, value: string][] {
    return Object.entries(this.retention).map(([key, value]) => {
      const keeps_any = this.borg_version === 2 && (key === "keep_within" || key === "keep_last");
      return [keeps_any ? "--keep" : "--" + key.replaceAll("_", "-"), String(value)];
    });
  }

  // The archives prune weighs, which borg 2 would otherwise split by name and so never prune a uniquely named one.
  private prune_scope(): string[] {
    const scope = this.match_args(this.prune_match);
    return this.borg_version === 2 ? ["--group-by", "none", ...scope] : scope;
  }

  private prune_preview_command(): string {
    const args = [this.borg_bin, "prune", "--dry-run", "--list", "--lock-wait", String(this.lock_wait), ...this.prune_scope()];
    args.push(...this.retention_flags().flat(), ...this.repo_args());
    return this.build(args, this.read_options());
  }

  prune_preview(): ActionStart {
    if (!this.repo) return BorgRepository.refused("Cannot preview a prune: no 'repo' configured");
    if (Object.keys(this.retention).length === 0) return BorgRepository.refused("Cannot preview a prune: no keep_* retention configured");
    return this.run_one(this.prune_preview_command(), (result) => this.read_prune_preview(result));
  }

  read_prune_preview(call: CmdResult): CollectResult {
    const text = [call.stdout, call.stderr].filter(Boolean).join("\n");
    if (call.exit_code !== 0) {
      const hint = failure_hint(text);
      return BorgRepository.refused(`borg prune --dry-run failed (exit ${call.exit_code}): ${text.trim().slice(0, 300)}` + (hint ? `\n${hint}` : ""));
    }
    const keep: string[] = [];
    const prune: string[] = [];
    for (const line of text.split(/\r\n|\r|\n/)) {
      const groups = PRUNE_LINE.exec(line.trim())?.groups;
      if (!groups) continue;
      if (groups.prune) {
        prune.push(`  ${groups.name}  ${groups.date}`);
      } else {
        keep.push(`  ${groups.name}  ${groups.date}  (${groups.rule})`);
      }
    }
    const policy = this.retention_flags().map(([option, value]) => `${option} ${value}`).join(" ");
    const lines = [`Policy: ${policy}`, `Archives matching: ${this.prune_match}`, ""];
    lines.push(`Would prune ${prune.length} of ${prune.length + keep.length} archive(s):`);
    lines.push(...(prune.length > 0 ? prune : ["  (none)"]));
    lines.push("", `Keeping ${keep.length}:`, ...(keep.length > 0 ? keep : ["  (none)"]));
    return new CollectResult({
      logs: [[`Prune preview: would prune ${prune.length}, keep ${keep.length}`, "INFO"]],
      content: lines.join("\n"),
      success: true,
    });
  }

  // ── Verify restore ─────────────────────────────────────────────────────────

  verify_restore(): ActionStart {
    if (!this.canary_path) return BorgRepository.refused("Cannot verify a restore: no 'canary_path' configured");
    const archive = this.canary_archive();
    if (!archive) return BorgRepository.refused("Cannot verify a restore: no archive has been listed yet");
    return this.run_detached(this.canary_calls(archive).map(([, command]) => command), (results) => this.read_verify_restore(results));
  }

  read_verify_restore(results: CmdResult[]): CollectResult {
    const [canary, canary_live] = results;
    const by_name = new Map([["canary", canary], ["canary_live", canary_live]]);
    const logs: LogEntry[] = [];
    const record = this.read_canary(by_name, logs);
    const message = logs.length > 0 ? logs[logs.length - 1][0] : "Restore check reached no verdict";
    const state = record === null ? null : { ...this.state, canary: record };
    return new CollectResult({ state, content: message, logs, success: record?.ok === true });
  }

  // ── Browse ─────────────────────────────────────────────────────────────────

  // The children of the path in the archive as last listed, or null when that folder has not been listed yet.
  listing(archive: string, path: string): ListingEntry[] | null {
    const key = listing_key(archive, archive_member(path) || "");
    const cached = this.listings.get(key);
    if (cached === undefined) return null;
    this.listings.delete(key);
    this.listings.set(key, cached);
    return cached.entries;
  }

  browse_archive(archive: string | null, path = ""): ActionStart {
    const member = archive_member(path);
    if (!this.repo || !archive) return BorgRepository.refused("Cannot browse: no archive given");
    if (member === null) return BorgRepository.refused("A path may not contain '.' or '..' components");
    const cached = this.listing(archive, member);
    if (cached !== null) {
      return new CollectResult({ content: this.listing_text(archive, member, cached), success: true });
    }
    const args = [this.borg_bin, "list", "--format", LIST_FORMAT, "--lock-wait", String(this.lock_wait), ...this.archive_args(archive)];
    if (member) args.push(member);
    const read = (result: CmdResult) => this.read_browse(result, archive, path);
    return this.run_one(this.build(args, this.read_options()), read, this.browse_limit + 1, children_filter(member));
  }

  read_browse(call: CmdResult, archive: string, path: string): CollectResult {
    if (call.exit_code !== 0) {
      const detail = (call.stderr || call.stdout).trim();
      const hint = failure_hint(detail);
      return BorgRepository.refused(`borg list failed (exit ${call.exit_code}): ${detail.slice(0, 300)}` + (hint ? `\n${hint}` : ""));
    }
    const member = archive_member(path) || "";
    const entries = parse_listing(call.stdout);
    // A listing longer than browse_limit is kept one entry over it, which is how the browser knows it was cut short.
    this.listings.set(listing_key(archive, member), { archive, member, entries });
    while (this.listings.size > LISTING_CACHE) this.listings.delete(this.listings.keys().next().value!);
    return new CollectResult({ content: this.listing_text(archive, member, entries), success: true });
  }

  private listing_text(archive: string, member: string, entries: ListingEntry[]): string {
    const where = `${archive}:/${member}`;
    if (entries.length === 0) return `${where} — nothing at that path`;
    let header = `${where} — ${entries.length} entries`;
    if (entries.length > this.browse_limit) {
      entries = entries.slice(0, this.browse_limit);
      header = `${where} — first ${this.browse_limit} entries (raise browse_limit for more)`;
    }
    const lines = entries.map((entry) => entry.dir ? `${entry.name}/` : `${entry.name}  ${format_size(entry.size || 0)}  ${entry.mtime}`);
    return [header, "", ...lines].join("\n");
  }

  // ── Restore ────────────────────────────────────────────────────────────────

  // Extracts the paths into the destination, never over live files: a folder that already holds anything is refused
  // before borg starts, which is what keeps a restore into a chosen folder from overwriting it.
  private restore_command(archive: string, members: string[], destination: string): string {
    const extract = this.build([
      this.borg_bin, "extract", "--log-json", "--progress", "--lock-wait", String(this.backup_lock_wait), ...this.archive_args(archive), ...members,
    ], { persistent_cache: true });
    const sudo = this.require_sudo ? "sudo -n " : "";
    const quoted = shell_quote(destination);
    return when_folder_empty(destination, sudo, `${sudo}mkdir -p ${quoted} && cd ${quoted} && ${extract}`);
  }

  // Restores into a new dated folder inside the target (restore_dir unless one is given), or into the target itself
  // when `fresh` is false, which must then be empty or not exist yet.
  restore_archive(archive: string | null, paths: string[], target: string | null = null, fresh = true): ActionStart {
    const members = paths.map(archive_member);
    if (!this.repo || !archive) return BorgRepository.refused("Cannot restore: no archive given");
    if (members.some((member) => member === null)) return BorgRepository.refused("A path may not contain '.' or '..' components");
    if (members.length === 0 || !members.every(Boolean)) {
      return BorgRepository.refused("Give the path to restore — a whole archive is not restored from here");
    }
    const folder = (target?.trim() || this.restore_dir).replace(/\/+$/, "") || "/";
    const problem = target_problem(folder);
    if (problem) return BorgRepository.refused(`Cannot restore into ${folder}: ${problem}`);
    const refusal = this.run_refusal("restore");
    if (refusal) return refusal;
    const destination = fresh ? `${folder === "/" ? "" : folder}/${archive}-${utc_compact_stamp(new Date())}` : folder;
    return this.launch("restore", this.restore_command(archive, members as string[], destination), ` into ${destination}`);
  }

  // ── Download ───────────────────────────────────────────────────────────────

  // One file as itself, or folders and several paths as one gzipped tar, read from the archive to stdout.
  download(archive: string | null, paths: string[], kind: string): DownloadPlan | CollectResult {
    if (!this.repo || !archive) return BorgRepository.refused("Cannot download: no archive given");
    // Only a listed archive may be read, so a stale or hand-typed name cannot reach borg.
    if (!this.state.archives.some((listed) => listed.name === archive)) {
      return BorgRepository.refused(`Cannot download from ${archive}: it is not in the archive list`);
    }
    const members = paths.map(archive_member);
    if (members.some((member) => member === null)) return BorgRepository.refused("A path may not contain '.' or '..' components");
    // A download holds the repository's lock like a backup would wait on, so it does not start beside a run of ours.
    if (this.active_run() !== null) return BorgRepository.refused("A run is going on this repository; download once it ends");
    const named = members.filter(Boolean) as string[];
    const source = this.archive_args(archive);
    const lock_wait = ["--lock-wait", String(this.lock_wait)];

    let call: string;
    let filename: string;
    let content_type: string;
    if (kind === "file") {
      if (named.length !== 1 || members.length !== 1) return BorgRepository.refused("A file download names exactly one file");
      call = this.build([this.borg_bin, "extract", "--stdout", ...lock_wait, ...source, named[0]], this.read_options());
      filename = named[0].slice(named[0].lastIndexOf("/") + 1);
      content_type = "application/octet-stream";
    } else if (kind === "tar") {
      if (named.length !== members.length) return BorgRepository.refused("Give the paths to download, or none for the whole archive");
      call = this.build([this.borg_bin, "export-tar", "--tar-filter=gzip", ...lock_wait, ...source, "-", ...named], this.read_options());
      const folder = named.length === 1 ? named[0].slice(named[0].lastIndexOf("/") + 1) : "";
      filename = `${archive}${folder ? `-${folder}` : ""}.tar.gz`;
      content_type = "application/gzip";
    } else {
      return BorgRepository.refused(`Unknown download kind '${kind}': use file or tar`);
    }
    return { command: with_passphrase(call), stdin: this.stdin_for([call]), filename, content_type };
  }

  // What the page shows when borg ended a download before sending anything.
  download_failure(exit_code: number, stderr: string): string {
    const detail = stderr.trim();
    const hint = failure_hint(detail);
    return `borg failed (exit ${exit_code}): ${detail.slice(0, 300) || "no output"}` + (hint ? `\n${hint}` : "");
  }

  // ── Maintenance ────────────────────────────────────────────────────────────

  private maintenance_command(args: string[]): string {
    return this.build([this.borg_bin, ...args, "--log-json", "--lock-wait", String(this.backup_lock_wait)], { persistent_cache: true });
  }

  check_repo(kind = this.check_verify_data ? "data" : "all"): ActionStart {
    if (!Object.hasOwn(CHECK_KINDS, kind)) {
      return BorgRepository.refused(`Unknown check kind '${kind}': use ${Object.keys(CHECK_KINDS).join(", ")}`);
    }
    const refusal = this.repository_refusal() ?? this.run_refusal("check the repository");
    if (refusal) return refusal;
    if (kind === "extract") {
      const newest = this.state.archives[0]?.name ?? null;
      if (!newest) return BorgRepository.refused("Cannot run an extract check: no archive listed yet");
      const command = this.maintenance_command(["extract", "--dry-run", "--progress", ...this.archive_args(newest)]);
      return this.launch(check_run_kind(kind), command, ` on ${newest}`);
    }
    const args = ["check", "--progress", ...CHECK_KINDS[kind].options];
    return this.launch(check_run_kind(kind), this.maintenance_command([...args, ...this.repo_args()]));
  }

  compact_repo(): ActionStart {
    const refusal = this.repository_refusal() ?? this.run_refusal("compact the repository");
    if (refusal) return refusal;
    return this.launch("compact", this.maintenance_command(["compact", "--progress", ...this.repo_args()]));
  }

  prune_repo(): ActionStart {
    if (!this.allow_delete) return BorgRepository.refused("Pruning is off for this monitor — set allow_delete: true to enable it");
    if (Object.keys(this.retention).length === 0) return BorgRepository.refused("Cannot prune: no keep_* retention configured");
    const refusal = this.run_refusal("prune");
    if (refusal) return refusal;
    return this.launch("prune", this.maintenance_command([...this.prune_args(), ...this.repo_args()]));
  }

  // The prune that applies the retention policy for real, shared by the Prune action and the one after a backup.
  private prune_args(): string[] {
    const stats = this.borg_version === 2 ? [] : ["--stats"];
    return ["prune", "--list", ...stats, ...this.prune_scope(), ...this.retention_flags().flat()];
  }

  delete_archive(archive: string | null): ActionStart {
    if (!this.allow_delete) return BorgRepository.refused("Deleting archives is off for this monitor — set allow_delete: true to enable it");
    // Only a listed archive may be deleted, so a stale or hand-typed name cannot reach borg.
    if (!archive || !this.state.archives.some((listed) => listed.name === archive)) {
      return BorgRepository.refused(`Cannot delete ${archive || "an unnamed archive"}: it is not in the archive list`);
    }
    const refusal = this.run_refusal("delete an archive");
    if (refusal) return refusal;
    for (const [key, cached] of this.listings) {
      if (cached.archive === archive) this.listings.delete(key);
    }

    const report = this.borg_version === 2 ? "--list" : "--stats";
    return this.launch("delete", this.maintenance_command(["delete", report, ...this.archive_args(archive)]), ` for ${archive}`);
  }

  // ── Purge ──────────────────────────────────────────────────────────────────

  private purge_refusal(): CollectResult | null {
    if (!this.allow_purge) return BorgRepository.refused("Purging is off for this monitor — set allow_purge: true to enable it");
    if (!(this.exclude.length > 0 || this.exclude_from || this.exclude_if_present.length > 0 || this.exclude_caches)) {
      return BorgRepository.refused("Cannot purge: no exclude patterns configured");
    }
    return this.run_refusal("purge excluded files");
  }

  private purge_scope(): string[] {
    return this.purge_match ? this.match_args(this.purge_match) : [];
  }

  purge_preview(): ActionStart {
    const refusal = this.purge_refusal();
    if (refusal) return refusal;
    // Recreate marks an excluded item x in borg 1 and - in borg 2.
    const flag = this.borg_version === 2 ? "-" : "x";
    const recreate = this.build([
      this.borg_bin, "recreate", "--dry-run", "--list", `--filter=${flag}`, ...this.purge_scope(), ...this.exclude_args(),
      "--lock-wait", String(this.backup_lock_wait), ...this.repo_args(),
    ], { persistent_cache: true });
    return this.launch("purge-preview", `{ ${recreate} 2>&1; echo "__x_backups_rc=$?"; } | ${topmost_excluded(flag)}`);
  }

  purge_excluded(): ActionStart {
    const refusal = this.purge_refusal();
    if (refusal) return refusal;
    const scope = this.purge_scope();
    // An interrupted recreate leaves a <name>.recreate archive that makes the next attempt fail at once.
    const leftovers = this.maintenance_command(["delete", ...this.match_args("*.recreate"), ...this.repo_args()]);
    const recreate = this.maintenance_command(["recreate", "--info", "--stats", "--progress", ...scope, ...this.exclude_args(), ...this.repo_args()]);
    const compact = this.maintenance_command(["compact", "--progress", ...this.repo_args()]);
    // A plain exit would leave before the run records its status, so a subshell carries the failure instead.
    return this.launch("purge", `${leftovers}; ${recreate}; rc=$?; if [ "$rc" -le 1 ]; then ${compact}; else (exit "$rc"); fi`);
  }

  // ── Break lock ─────────────────────────────────────────────────────────────

  break_lock(): ActionStart {
    if (!this.allow_delete) return BorgRepository.refused("Breaking locks is off for this monitor — set allow_delete: true to enable it");
    const refusal = this.run_refusal("break the lock");
    if (refusal) return refusal;
    return this.run_one(this.build([this.borg_bin, "break-lock", ...this.repo_args()], { persistent_cache: true }), (result) => this.read_break_lock(result));
  }

  read_break_lock(call: CmdResult): CollectResult {
    if (call.exit_code !== 0) {
      return BorgRepository.refused(`borg break-lock failed (exit ${call.exit_code}): ${(call.stderr || call.stdout).trim().slice(0, 300)}`);
    }
    const message = "Broke the repository and cache locks";
    return new CollectResult({ logs: [[message, "WARNING"]], content: message, success: true });
  }

  // ── Diff ───────────────────────────────────────────────────────────────────

  // The listed archive just older than this one, which a diff compares it against.
  private previous_archive(archive: string): string | null {
    const names = this.state.archives.map((listed) => listed.name);
    const index = names.indexOf(archive);
    if (index === -1) return null;
    return index + 1 < names.length ? names[index + 1] : null;
  }

  diff_archive(archive: string | null): ActionStart {
    if (!this.repo || !archive) return BorgRepository.refused("Cannot diff: no archive given");
    const older = this.previous_archive(archive);
    if (older === null) return BorgRepository.refused(`${archive} is the oldest listed archive — there is nothing before it to compare`);
    const call = this.build(
      [this.borg_bin, "diff", "--json-lines", "--lock-wait", String(this.lock_wait), ...this.archive_args(older), archive], this.read_options(),
    );
    return this.run_detached([call], ([result]) => this.read_diff(result, archive), this.browse_limit + 1);
  }

  // A run adopted after a restart has lost its archive, so it passes null.
  read_diff(call: CmdResult, archive: string | null): CollectResult {
    if (call.exit_code !== 0) {
      const detail = (call.stderr || call.stdout).trim();
      const hint = failure_hint(detail);
      return BorgRepository.refused(`borg diff failed (exit ${call.exit_code}): ${detail.slice(0, 300)}` + (hint ? `\n${hint}` : ""));
    }
    let changes = parse_diff(call.stdout);
    const span = archive ? `from ${this.previous_archive(archive)} to ${archive}` : "in the archive";
    let header = `Changes ${span}: ${changes.length}`;
    const more = changes.length > this.browse_limit;
    if (more) {
      changes = changes.slice(0, this.browse_limit);
      header = `${header.slice(0, header.lastIndexOf(":"))}: first ${this.browse_limit} (raise browse_limit for more)`;
    }
    const key = archive ? diff_key(this.previous_archive(archive), archive) : null;
    if (key !== null) {
      this.diffs.delete(key);
      this.diffs.set(key, { changes, more });
      while (this.diffs.size > DIFF_CACHE) this.diffs.delete(this.diffs.keys().next().value!);
    }
    const lines = changes.map(diff_line);
    return new CollectResult({
      logs: [[header, "INFO"]],
      content: [header, "", ...(lines.length > 0 ? lines : ["(no changes)"])].join("\n"),
      success: true,
    });
  }

  // The archive's changes against the one before it as last diffed, or null when it has not been diffed yet.
  diff(archive: string): { changes: DiffChange[]; more: boolean } | null {
    return this.diffs.get(diff_key(this.previous_archive(archive), archive)) ?? null;
  }

  // ── Following a run ────────────────────────────────────────────────────────

  // Advances a run from what its agent reports, finishing it once it has ended and all its output is read.
  read_run_poll(run: RunRecord, poll: LongRunPoll): CollectResult {
    const runs = this.runs!;
    const ended = !poll.alive && poll.next_offset >= poll.size;
    const [lines, consumed] = split_run_output(poll.new_output, ended);
    if (lines.length > 0) {
      runs.append_output(run.id, lines);
      runs.bump_output_seq(run.id, run.output_seq + consumed);
    }
    const summary = progress_from_lines(lines);
    if (summary) runs.set_progress(run.id, summary);
    else if (run.progress === WAITING_FOR_AGENT) runs.set_progress(run.id, null);
    if (!ended) return new CollectResult();

    const kind = run.kind;
    if (poll.state === "stopped") {
      runs.finish(run.id, "cancelled", { exit_code: poll.exit_code, error: "Cancelled" });
      const message = `${capitalize(kind)} cancelled`;
      return new CollectResult({ logs: [[message, "WARNING"]], content: message, success: true });
    }
    // The process vanished without an exit code, such as when the host rebooted mid-run.
    if (poll.exit_code === null) {
      runs.finish(run.id, "failed", { exit_code: -1, error: "Process ended without writing an exit code" });
      return CollectResult.failed(`${capitalize(kind)} ended unexpectedly`);
    }

    const exit_code = poll.exit_code;
    const succeeded = exit_code === 0 || exit_code === 1;
    const state = exit_code === 0 ? "succeeded" : exit_code === 1 ? "warning" : "failed";
    runs.finish(run.id, state, { exit_code, error: succeeded ? null : `Exited with status ${exit_code}` });

    let outcome: CollectResult;
    if (exit_code === 0) {
      outcome = new CollectResult({ logs: [[`${capitalize(kind)} completed successfully`, "INFO"]], success: true });
    } else if (exit_code === 1) {
      outcome = new CollectResult({ logs: [[`${capitalize(kind)} completed with warnings (exit 1)`, "WARNING"]], success: true });
    } else {
      outcome = CollectResult.failed(`${capitalize(kind)} failed (exit ${exit_code})`);
    }
    this.record_check_run(kind, succeeded, exit_code, outcome);
    return outcome;
  }

  // A run whose agent could not be asked keeps going on its host, so it waits for the agent rather than failing, noted
  // once as it starts waiting.
  read_run_unreachable(run: RunRecord, reason: string): CollectResult {
    if (run.progress === WAITING_FOR_AGENT) return new CollectResult();
    this.runs!.set_progress(run.id, WAITING_FOR_AGENT);
    return new CollectResult({ logs: [[`Could not poll the running ${run.kind}: ${reason.slice(0, 200)}`, "WARNING"]] });
  }

  // A run its agent no longer knows, as when the host's state folder was wiped, whose outcome nobody can tell.
  read_run_lost(run: RunRecord, host: string): CollectResult {
    this.runs!.finish(run.id, "failed", { exit_code: -1, error: `Lost: the agent on ${host} no longer knows this run, so its outcome is unknown.` });
    return CollectResult.failed(`${capitalize(run.kind)} lost: the agent on ${host} no longer knows it`);
  }

  // A cancel the agent could not carry out, which leaves the run going.
  read_cancel_failed(run: RunRecord, reason: string): CollectResult {
    return BorgRepository.refused(`Could not cancel the ${run.kind}: ${reason.slice(0, 200)}`);
  }

  // Stores a finished Check's outcome against every tracked check it covers, so check_kinds can judge their age.
  private record_check_run(kind: string, succeeded: boolean, exit_code: number, outcome: CollectResult): void {
    const covered = covered_by_check_run(kind);
    if (covered.length === 0) return;
    const now = now_seconds();
    const states = this.stored_checks();
    for (const name of covered) {
      const state: CheckState = { ...states[name], end: now, failed: !succeeded, error: succeeded ? null : `${kind} exited with status ${exit_code}` };
      if (succeeded) state.ok = now;
      states[name] = state;
    }
    outcome.state = { ...this.state, checks: this.judge_checks(states, outcome.logs) };
  }

  // ── Page values ────────────────────────────────────────────────────────────

  // This repository's backup health in one flat record, for a roll-up across repositories.
  backup_summary(): BackupSummary {
    const now = now_seconds();
    const epoch = this.state.last_backup_epoch;
    const newest = epoch ? Math.trunc(epoch) : null;
    const canary = this.canary_path ? this.state.canary : null;
    const checks = this.expected_checks().size > 0 ? this.state.checks : null;
    return {
      repo: this.repo,
      newest_archive_epoch: newest,
      newest_archive_age: newest ? now - newest : null,
      max_age: this.max_age,
      fresh: Boolean(newest) && now - newest! <= this.max_age,
      restore_check: canary === null ? null : canary.ok,
      restore_checked_epoch: canary === null ? null : Math.trunc(canary.checked_epoch),
      repo_checks: checks === null ? null : checks.passed,
      repo_checked_epoch: checks && checks.oldest_ok_epoch ? Math.trunc(checks.oldest_ok_epoch) : null,
    };
  }

  archive_rows(): Record<string, string>[] {
    const now = now_seconds();
    return this.state.archives.map((archive) => ({
      name: archive.name ?? "?",
      created: archive.epoch ? local_minute(new Date(archive.epoch * 1000)) : "unknown",
      age: archive.epoch ? format_age(now - archive.epoch) : "unknown",
      size: archive.original !== undefined ? format_size(archive.original) : "--",
      added: archive.deduplicated !== undefined ? format_size(archive.deduplicated) : "--",
      files: archive.nfiles !== undefined ? Math.trunc(archive.nfiles).toLocaleString("en-US") : "--",
    }));
  }
}

// ── Progress ─────────────────────────────────────────────────────────────────

// The latest human progress line in a batch of newly read run output.
export function progress_from_lines(lines: string[]): string | null {
  let summary: string | null = null;
  for (const text of lines) {
    // A chained run names each step, and recreate prints which archive it is on as plain text.
    if (text.startsWith(STEP_MARK)) {
      summary = text.slice(STEP_MARK.length).trim();
      continue;
    }
    if (text.startsWith("Processing ")) {
      summary = text.trim();
      continue;
    }
    if (!text.startsWith("{")) continue;
    let record: unknown;
    try {
      record = JSON.parse(text);
    } catch {
      continue;
    }
    if (!is_object(record)) continue;
    if (record.type === "progress_message" || record.type === "progress_percent") {
      if (record.message && !record.finished) summary = String(record.message).trim();
      continue;
    }
    if (record.type !== "archive_progress" || record.finished) continue;
    const original = Number(record.original_size) || 0;
    const deduplicated = Number(record.deduplicated_size) || 0;
    const nfiles = Number(record.nfiles) || 0;
    if (!(original || deduplicated || nfiles)) continue;
    summary = `${nfiles} files, ${format_size(original)} read, ${format_size(deduplicated)} new`;
    if (record.path) summary += ` — ${record.path}`;
  }
  return summary;
}

// ── Output caps ──────────────────────────────────────────────────────────────

// The call with its stdout kept by the filter and cut to the first limit lines, or the call alone when it needs neither.
function capped(call: string, limit?: number, keep?: string): string {
  // awk keeps reading past the limit where head would stop, so the call never dies of a closed pipe.
  const readers = [...(keep ? [keep] : []), ...(limit ? [`awk 'NR <= ${Math.trunc(limit)}'`] : [])];
  return readers.length > 0 ? piped(call, readers.join(" | ")) : call;
}

// ── Stats readers ────────────────────────────────────────────────────────────

function parse_stats(data: Record<string, unknown>): RepositoryStats {
  const cache = data.cache;
  const stats = is_object(cache) ? cache.stats : null;
  if (!is_object(stats)) return {};
  const fields: [source: string, target: keyof RepositoryStats][] = [
    ["total_size", "original_size"],
    ["total_csize", "compressed_size"],
    ["unique_csize", "deduplicated_size"],
    ["total_chunks", "total_chunks"],
    ["total_unique_chunks", "unique_chunks"],
  ];
  const out: RepositoryStats = {};
  for (const [source, target] of fields) {
    const value = stats[source];
    if (typeof value === "number") out[target] = value;
  }
  return out;
}

function parse_archive_sizes(data: Record<string, unknown>): Map<string, Partial<ArchiveEntry>> {
  const fields: [source: string, target: keyof ArchiveEntry][] = [
    ["original_size", "original"],
    ["compressed_size", "compressed"],
    ["deduplicated_size", "deduplicated"],
    ["nfiles", "nfiles"],
  ];
  const out = new Map<string, Partial<ArchiveEntry>>();
  const archives = Array.isArray(data.archives) ? data.archives : [];
  for (const archive of archives) {
    if (!is_object(archive) || !archive.name || !is_object(archive.stats)) continue;
    const entry: Record<string, number> = {};
    for (const [source, target] of fields) {
      const value = archive.stats[source];
      if (typeof value === "number") entry[target] = value;
    }
    if (Object.keys(entry).length > 0) out.set(String(archive.name), entry);
  }
  return out;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function now_seconds(): number {
  return Math.floor(Date.now() / 1000);
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

function listing_key(archive: string, member: string): string {
  return JSON.stringify([archive, member]);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

// Local time as 2026-10-25T14:30:00.
function local_stamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// Local time as 2026-10-25 14:30.
function local_minute(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// UTC time as 20261025T143000.
function utc_compact_stamp(date: Date): string {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

// The diff cache's key for an archive and the one before it.
function diff_key(older: string | null, archive: string): string {
  return `${older ?? ""}\n${archive}`;
}

// The filesystem size and free bytes from `df --output=size,avail`'s last line, or null when df failed.
function parse_space(result: CmdResult): StorageRecord | null {
  const numbers = result.exit_code === 0 ? result.stdout.trim().split("\n").at(-1)?.trim().split(/\s+/).map(Number) : undefined;
  if (numbers?.length !== 2 || numbers.some((value) => !Number.isFinite(value))) return null;
  return { size: numbers[0], available: numbers[1], read_epoch: now_seconds() };
}

// Why a folder cannot be restored into, or null: it must be absolute, plain, and not hold `.` or `..` steps.
function target_problem(folder: string): string | null {
  if (!folder.startsWith("/")) return "give an absolute path";
  if (/[\0\n\r]/.test(folder)) return "the path holds a control character";
  if (folder.split("/").some((part) => part === "." || part === "..")) return "the path may not contain '.' or '..' steps";
  return null;
}
