import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { children_filter, diff_line, parse_diff, parse_listing } from "../../src/server/borg/parsing.ts";
import { BorgRepository, WAITING_FOR_AGENT, progress_from_lines, topmost_excluded, type BorgConfig } from "../../src/server/borg/repository.ts";
import {
  INHIBIT_SCRIPT, piped, preflight_script, skip_reason, ssh_endpoint, then_steps, when_folder_empty, with_preflight, wrap_job,
} from "../../src/server/borg/shell.ts";
import { Harness } from "./testing.ts";
import { ActionPlan, CollectResult, LongRunPlan, cmd_result, type ActionStart, type CmdResult, type DownloadPlan } from "../../src/server/borg/types.ts";
import type { LongRunPoll } from "../../src/shared/agent_protocol.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_CFG: BorgConfig = {
  id: "test-borg",
  max_age: "1d",
  repo: "ssh://borg@host/srv/repo",
};

const BACKUP_CFG: BorgConfig = { ...BASE_CFG, source_paths: ["/home", "/etc"] };

const FULL_CFG: BorgConfig = {
  ...BASE_CFG, source_paths: ["/home"], canary_path: "home/canary", keep_daily: 7,
  allow_delete: true, allow_purge: true, exclude: ["*.tmp"],
};

const CANARY_CFG: BorgConfig = { ...BASE_CFG, canary_path: "/Storage/System/.x-monitor-canary", collect_stats: false };

const CHECK_CFG: BorgConfig = { ...BASE_CFG, repo: "/srv/local", check_units: ["borgmatic-check.service"], collect_stats: false };

const RESTORE_CFG: BorgConfig = { ...BASE_CFG, restore_dir: "/var/tmp/r", require_sudo: true };

const DELETE_CFG: BorgConfig = { ...BASE_CFG, allow_delete: true, keep_daily: 7 };

const PURGE_CFG: BorgConfig = { ...BASE_CFG, allow_purge: true, exclude: ["fm:*/.cache"], exclude_if_present: [".nobackup"] };

const CHAIN_CFG: BorgConfig = { ...BACKUP_CFG, keep_daily: 7, prune_after_backup: true, compact_after_backup: true };

const TRACKED_CFG: BorgConfig = {
  ...BASE_CFG, repo: "/srv/local", collect_stats: false, check_kinds: { repository: "8d", extract: "32d" },
};

const PRUNE_OUTPUT = [
  "Keeping archive (rule: daily #1):            backup-2026-09-23T00:00:00           Tue, 2026-09-22 19:00:00 [d0e5]",
  "Would prune:                                 backup-2026-09-22T00:00:00           Mon, 2026-09-21 19:00:00 [43a8]",
  "Keeping archive (rule: weekly #1):           backup-2026-09-21T00:00:00           Sun, 2026-09-20 19:00:00 [c598]",
].join("\n");

const LISTING = [
  "d\t0\t2026-09-20T10:00:00.000000\tStorage/System/etc",
  "-\t2048\t2026-09-20T10:01:00.000000\tStorage/System/notes.txt",
  "d\t\t\tStorage/System/var",
].join("\n");

afterEach(() => {
  vi.useRealTimers();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function make(config: BorgConfig = BASE_CFG): Harness {
  return new Harness("test-borg", config);
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

// Local time with microseconds, the way borg writes archive times.
function iso(epoch: number): string {
  const date = new Date(epoch * 1000);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.000000`;
}

function list_json(epoch: number | null = null): string {
  const archives = epoch === null ? [] : [{ name: "host-2024", start: iso(epoch) }];
  return JSON.stringify({ repository: { location: "/srv/repo" }, archives });
}

function multi_json(...epochs: number[]): string {
  return JSON.stringify({
    repository: { location: "/srv/repo", last_modified: epochs.length > 0 ? iso(epochs[0]) : "" },
    encryption: { mode: "repokey-blake2" },
    archives: epochs.map((epoch, index) => ({ name: `archive-${index}`, start: iso(epoch) })),
  });
}

function info_json(total = 1000, csize = 500, unique = 250): string {
  return JSON.stringify({
    cache: { stats: { total_size: total, total_csize: csize, unique_csize: unique, total_chunks: 100, total_unique_chunks: 50 } },
    repository: { location: "/srv/repo" },
  });
}

function collect(harness: Harness, list_result: CmdResult, info_result?: CmdResult): CollectResult {
  const outputs = [list_result];
  if (harness.repository.collect_stats) outputs.push(info_result ?? cmd_result(0, "{}", ""));
  return harness.run_cycle((_command, index) => outputs[index]);
}

function messages(result: CollectResult): string {
  return result.logs.map(([message]) => message).join(" | ");
}

// Drives one poll, answering each planned call by name and the listing with a fresh archive.
function cycle_with(harness: Harness, extra: Record<string, CmdResult> = {}): CollectResult {
  const answers: Record<string, CmdResult> = {
    list: cmd_result(0, list_json(now() - 60), ""),
    info: cmd_result(0, "{}", ""),
    ...extra,
  };
  return harness.run_cycle((_command, index) => answers[harness.repository.poll_calls[index]]);
}

// Runs a poll that lists these archives, newest first.
function listed(harness: Harness, ...names: string[]): void {
  const archives = names.map((name, index) => ({ name, start: iso(now() - 3600 * (index + 1)) }));
  collect(harness, cmd_result(0, JSON.stringify({ archives }), ""));
}

function checks_out(options: { ok?: number; end?: number; start?: number; errs?: [number, string][] } = {}): CmdResult {
  const line = (epoch: number | undefined, text: string): string => epoch ? `${epoch}.000000 host systemd[1]: ${text}` : "";
  const lines = [
    "unit=borgmatic-check.service",
    "ok=" + line(options.ok, "Finished Checks."),
    "end=" + (options.end
      ? line(options.end, "borgmatic-check.service: Failed with result 'exit-code'.")
      : line(options.ok, "Finished Checks.")),
    "start=" + line(options.start, "Starting Checks..."),
  ];
  for (const [epoch, repo] of options.errs ?? []) {
    lines.push(`err=${epoch}.0 host borgmatic[9]: Command 'borg check --info ${repo}' returned non-zero exit status 1.`);
  }
  return cmd_result(0, lines.join("\n"), "");
}

// What the agent answers one poll of a run with, its output read up to its whole size.
function job_poll(size: number, exit_code: number | null, alive: boolean, out: string): LongRunPoll {
  const state = alive ? "running" : exit_code === null ? "lost" : "exited";
  return { state, exit_code, alive, size, new_output: out, next_offset: size };
}

interface ActionParams {
  archive?: string;
  path?: string;
  paths?: string[];
  kind?: string;
  target?: string;
  fresh?: boolean;
}

// Starts an action by the id the page sends, the way an API route calls its method.
function start(harness: Harness, action_id: string, params: ActionParams = {}): ActionStart {
  const repository = harness.repository;
  const archive = params.archive ?? null;
  const starts: Record<string, () => ActionStart> = {
    run_backup: () => repository.run_backup(),
    dry_run_backup: () => repository.dry_run_backup(),
    prune_preview: () => repository.prune_preview(),
    verify_restore: () => repository.verify_restore(),
    browse_archive: () => repository.browse_archive(archive, params.path),
    restore_archive: () => repository.restore_archive(
      archive, [...(params.path ? [params.path] : []), ...(params.paths ?? [])], params.target ?? null, params.fresh !== false,
    ),
    check_repo: () => repository.check_repo(params.kind),
    compact_repo: () => repository.compact_repo(),
    prune_repo: () => repository.prune_repo(),
    delete_archive: () => repository.delete_archive(archive),
    break_lock: () => repository.break_lock(),
    purge_preview: () => repository.purge_preview(),
    purge_excluded: () => repository.purge_excluded(),
    diff_archive: () => repository.diff_archive(archive),
  };
  return starts[action_id]();
}

// Answers a long run the way the poller does: its preflight's result first, then the agent starting it.
function settle_long_run(plan: LongRunPlan, preflight: CmdResult): CollectResult {
  return plan.read_preflight(preflight) ?? plan.read_start(plan.record(), null);
}

// Starts an action, and has its agent start it when it is a long run.
function launch(harness: Harness, action_id = "run_backup", params: ActionParams = {}): CollectResult {
  const plan = start(harness, action_id, params);
  const outcome = plan instanceof CollectResult ? plan
    : plan instanceof LongRunPlan ? settle_long_run(plan, cmd_result(0, "", "")) : plan.read([cmd_result(0, "", "")]);
  harness.apply(outcome);
  return outcome;
}

// One poll of the running job on its agent, and the job advanced from its output.
function poll_once(harness: Harness, poll: LongRunPoll): CollectResult {
  const run = harness.repository.active_run();
  expect(run).not.toBeNull();
  const result = harness.repository.read_run_poll(run!, poll);
  harness.apply(result);
  return result;
}

function finish_job(harness: Harness, action_id: string, exit_code: number, params: ActionParams = {}): void {
  launch(harness, action_id, params);
  poll_once(harness, job_poll(5, exit_code, false, ""));
}

function plan_of(harness: Harness, action_id: string, params: ActionParams = {}): ActionPlan {
  const plan = start(harness, action_id, params);
  expect(plan).toBeInstanceOf(ActionPlan);
  return plan as ActionPlan;
}

function long_run_of(harness: Harness, action_id: string, params: ActionParams = {}): LongRunPlan {
  const plan = start(harness, action_id, params);
  expect(plan).toBeInstanceOf(LongRunPlan);
  return plan as LongRunPlan;
}

// The shell an action sends: a plan's first command, or a long run's preflight and then its command.
function command_of(harness: Harness, action_id: string, params: ActionParams = {}): string {
  const plan = start(harness, action_id, params);
  if (plan instanceof LongRunPlan) return [plan.preflight, plan.command].filter((part) => part !== null).join("; ");
  expect(plan).toBeInstanceOf(ActionPlan);
  return (plan as ActionPlan).commands[0];
}

function refusal_of(harness: Harness, action_id: string, params: ActionParams = {}): CollectResult {
  const plan = start(harness, action_id, params);
  expect(plan).toBeInstanceOf(CollectResult);
  return plan as CollectResult;
}

// Starts an action and reads the given results as its answer, the first as a long run's preflight.
function outcome_of(harness: Harness, action_id: string, results: CmdResult[], params: ActionParams = {}): CollectResult {
  const plan = start(harness, action_id, params);
  if (plan instanceof LongRunPlan) return settle_long_run(plan, results[0]);
  return plan_of(harness, action_id, params).read(results);
}

// The command an action sends with its nested quoting removed, so arguments read as typed.
function unquoted(command: string): string {
  return command.replace(/["'\\]/g, "");
}

function action_ids(harness: Harness): string[] {
  return harness.repository.get_actions().map((action) => action.action_id);
}

function action(harness: Harness, action_id: string) {
  return harness.repository.get_actions().find((spec) => spec.action_id === action_id)!;
}

// Every command a poll sends, as one text to search.
function poll_text(harness: Harness): string {
  return harness.repository.commands().map((command) => command.text).join("\n");
}

// Runs generated shell for real, so its control flow is tested rather than its spelling.
function sh(script: string, env?: NodeJS.ProcessEnv) {
  const run = spawnSync("sh", ["-c", script], { encoding: "utf8", timeout: 30_000, env });
  return { stdout: run.stdout, stderr: run.stderr, returncode: run.status ?? -1 };
}

function scratch_dir(): string {
  return mkdtempSync(join(tmpdir(), "x-backups-test-"));
}

// ── Freshness ────────────────────────────────────────────────────────────────

describe("freshness", () => {
  it("calls a recent archive online", () => {
    const harness = make();
    collect(harness, cmd_result(0, list_json(now() - 3600), ""));
    expect(harness.outcomes.latest_status()).toBe("online");
  });

  it("calls an archive past warn_age but within max_age a warning", () => {
    const harness = make({ ...BASE_CFG, warn_age: "12h" });
    collect(harness, cmd_result(0, list_json(now() - 18 * 3600), ""));
    expect(harness.outcomes.latest_status()).toBe("warning");
  });

  it("calls a stale archive failed", () => {
    const harness = make();
    collect(harness, cmd_result(0, list_json(now() - 3 * 24 * 3600), ""));
    expect(harness.outcomes.latest_status()).toBe("failed");
  });

  it("calls an empty repo failed", () => {
    const harness = make();
    collect(harness, cmd_result(0, list_json(null), ""));
    expect(harness.outcomes.latest_status()).toBe("failed");
  });
});

// ── Storage ──────────────────────────────────────────────────────────────────

describe("storage", () => {
  it("reads a local repository's filesystem with df, and keeps the last reading when df fails", () => {
    const harness = make({ ...BASE_CFG, repo: "/srv/local", collect_stats: false });
    const df = cmd_result(0, "     1B-blocks       Avail\n4000000000000 1000000000000\n", "");
    harness.run_cycle((_command, index) => [cmd_result(0, list_json(now() - 3600), ""), df][index]);
    expect(harness.repository.state.storage).toMatchObject({ size: 4_000_000_000_000, available: 1_000_000_000_000 });

    harness.run_cycle((_command, index) => [cmd_result(0, list_json(now() - 3600), ""), cmd_result(1, "", "df: no such file")][index]);
    expect(harness.repository.state.storage).toMatchObject({ size: 4_000_000_000_000 });
  });

  it("reads no filesystem for a repository over SSH", () => {
    expect(make().repository.poll_plan().map(([name]) => name)).not.toContain("space");
  });

  it("reads a quota in bytes or with a unit", () => {
    expect(make({ ...BASE_CFG, quota: "500G" }).repository.quota).toBe(500 * 1024 ** 3);
    expect(make({ ...BASE_CFG, quota: "1.5T" }).repository.quota).toBe(1.5 * 1024 ** 4);
    expect(make({ ...BASE_CFG, quota: 2048 }).repository.quota).toBe(2048);
    expect(() => make({ ...BASE_CFG, quota: "lots" })).toThrow("Unrecognised size");
  });
});

// ── Logging ──────────────────────────────────────────────────────────────────

describe("logging", () => {
  it("logs each archive", () => {
    const result = collect(make(), cmd_result(0, multi_json(now() - 3600, now() - 90000, now() - 180000), ""));
    for (const name of ["archive-0", "archive-1", "archive-2"]) expect(messages(result)).toContain(name);
  });

  it("logs the repository's details", () => {
    const result = collect(make(), cmd_result(0, multi_json(now() - 3600), ""));
    expect(messages(result)).toContain("/srv/repo");
    expect(messages(result)).toContain("repokey-blake2");
  });

  it("logs archives newest first", () => {
    const result = collect(make(), cmd_result(0, multi_json(now() - 180000, now() - 3600, now() - 90000), ""));
    const names = result.logs.filter(([message]) => message.startsWith("  archive-")).map(([message]) => message.trim().split(" ")[0]);
    expect(names).toEqual(["archive-1", "archive-2", "archive-0"]);
  });

  it("logs the command with the passphrase hidden", () => {
    const result = collect(make({ ...BASE_CFG, passphrase: "s3cret" }), cmd_result(0, multi_json(now() - 3600), ""));
    expect(messages(result)).toContain("borg list");
    expect(messages(result)).not.toContain("s3cret");
  });

  it("logs a failure's exit code and a hint", () => {
    const result = collect(make(), cmd_result(1, "", "sudo: borg: command not found"));
    expect(messages(result)).toContain("exit 1");
    expect(messages(result)).toContain("not on PATH");
  });

  it("points a publickey failure at ssh_key", () => {
    const result = collect(make(), cmd_result(2, "", "Remote: borg@heimdall.technet: Permission denied (publickey)."));
    expect(messages(result)).toContain("ssh_key");
    expect(messages(result)).not.toContain("require_sudo");
  });

  it("points a permission failure at require_sudo", () => {
    const result = collect(make(), cmd_result(2, "", "Permission denied: '/srv/repo/config'"));
    expect(messages(result)).toContain("require_sudo");
  });

  it("logs a snippet of output it could not parse", () => {
    const result = collect(make(), cmd_result(0, "Warning: something odd", ""));
    expect(messages(result)).toContain("Warning: something odd");
  });
});

// ── Failures ─────────────────────────────────────────────────────────────────

describe("failures", () => {
  it.each([
    ["a borg error", cmd_result(2, "", "Repository is locked"), "failed"],
    ["unparseable output", cmd_result(0, "not json", ""), "unavailable"],
    ["an unreachable host", cmd_result(-1, "", "Agent 'h' is not connected"), "unavailable"],
    ["a missing borg binary", cmd_result(1, "", "sudo: borg: command not found"), "unavailable"],
    ["an unreadable repo", cmd_result(2, "", "Permission denied: '/srv/repo/config'"), "unavailable"],
    ["a repo lock timeout", cmd_result(2, "", "Failed to create/acquire the lock /srv/repo/lock.exclusive (timeout)."), "unavailable"],
    ["a cache lock timeout", cmd_result(2, "", "Failed to create/acquire the lock /var/cache/x-monitor-borg/.cache/borg/abc/lock.exclusive (timeout)."), "unavailable"],
  ])("calls %s %s", (_label, result, status) => {
    const harness = make();
    collect(harness, result);
    expect(harness.outcomes.latest_status()).toBe(status);
  });

  it("fails without a repo", () => {
    const { repo: _repo, ...config } = BASE_CFG;
    const harness = make(config);
    expect(harness.repository.commands()).toEqual([]);
    harness.run_cycle();
    expect(harness.outcomes.latest_status()).toBe("failed");
  });
});

// ── State ────────────────────────────────────────────────────────────────────

describe("state", () => {
  it("records the newest archive's time", () => {
    const harness = make();
    const epoch = now() - 500;
    collect(harness, cmd_result(0, list_json(epoch), ""));
    expect(Math.abs(harness.repository.state.last_backup_epoch! - epoch)).toBeLessThanOrEqual(1);
  });

  it("records the archive count", () => {
    const harness = make();
    collect(harness, cmd_result(0, list_json(now()), ""));
    expect(harness.repository.state.archive_count).toBe(1);
  });
});

// ── Commands ─────────────────────────────────────────────────────────────────

describe("list command", () => {
  it("defaults max_age to one day", () => {
    const { max_age: _max_age, ...config } = BASE_CFG;
    expect(make(config).repository.max_age).toBe(86400);
  });

  it("asks for the newest archives as JSON", () => {
    const command = make().repository.list_command();
    expect(command).toContain("borg list");
    expect(command).toContain("--last 10");
    expect(command).toContain("--json");
    expect(command).toContain("ssh://borg@host/srv/repo");
  });

  it("honours the repo lock on every read", () => {
    const repository = make().repository;
    const reads = [repository.list_command(), repository.info_command(), ...repository.canary_calls("a1").map(([, command]) => command)];
    expect(reads.some((command) => command.includes("--bypass-lock"))).toBe(false);
    expect(repository.list_command()).toContain("--lock-wait 30");
  });

  it("gives borg a writable base folder", () => {
    const command = make().repository.list_command();
    expect(command).toContain('BORG_BASE_DIR="$__x_backups_base"');
    expect(command).toContain("__x_backups_base=$(mktemp -d)");
  });

  it("feeds the passphrase to borg on stdin, never on the command line", () => {
    const [command] = make({ ...BASE_CFG, passphrase: "s3cret" }).repository.commands();
    expect(command.text).not.toContain("s3cret");
    expect(command.text).toMatch(/^IFS= read -r __x_backups_passphrase; /);
    expect(command.text).toContain(`printf '%s\\n' "$__x_backups_passphrase" | BORG_PASSPHRASE_FD=0 `);
    expect(command.stdin).toBe("s3cret\n");
  });

  it("hands a real shell's borg the passphrase on its stdin", () => {
    const fake_borg = join(scratch_dir(), "borg");
    writeFileSync(fake_borg, `#!/bin/sh\nIFS= read -r line <&"$BORG_PASSPHRASE_FD"; echo "got $line"\n`, { mode: 0o755 });
    const [command] = make({ ...BASE_CFG, borg_bin: fake_borg, passphrase: "two words" }).repository.commands();

    const result = spawnSync("sh", ["-c", command.text], { input: command.stdin!, encoding: "utf8" });

    expect(result.stdout.trim()).toBe("got two words");
  });

  it("sends no stdin to a call that needs no passphrase", () => {
    const [command] = make().repository.commands();
    expect(command.text).not.toContain("read -r");
    expect(command.stdin).toBeNull();
  });

  it("uses BORG_PASSCOMMAND for a passphrase command", () => {
    const command = make({ ...BASE_CFG, passphrase_command: "cat /run/secret" }).repository.list_command();
    expect(command).toContain("BORG_PASSCOMMAND=");
    expect(command).not.toContain("BORG_PASSPHRASE");
  });

  it("sends a passphrase file's contents on stdin", () => {
    const file = join(scratch_dir(), "borg.pass");
    writeFileSync(file, "s3cret-from-file\n");
    const [command] = make({ ...BASE_CFG, passphrase_file: file }).repository.commands();
    expect(command.stdin).toBe("s3cret-from-file\n");
    expect(command.text).not.toContain("s3cret-from-file");
    expect(command.text).not.toContain("BORG_PASSCOMMAND=");
    expect(command.text).not.toContain(file);
  });

  it("prefers an inline passphrase over a file", () => {
    const file = join(scratch_dir(), "borg.pass");
    writeFileSync(file, "from-file");
    const [command] = make({ ...BASE_CFG, passphrase: "inline-wins", passphrase_file: file }).repository.commands();
    expect(command.stdin).toBe("inline-wins\n");
  });

  it("leaves the passphrase out when its file is missing", () => {
    const [command] = make({ ...BASE_CFG, passphrase_file: join(scratch_dir(), "nope") }).repository.commands();
    expect(command.text).not.toContain("BORG_PASSPHRASE");
    expect(command.text).not.toContain("BORG_PASSCOMMAND=");
    expect(command.stdin).toBeNull();
  });

  it("sets no passphrase when none is configured", () => {
    const command = make().repository.list_command();
    expect(command).not.toContain("BORG_PASSPHRASE");
    expect(command).not.toContain("BORG_PASSCOMMAND=");
  });

  it("lists as many archives as configured, at least one", () => {
    expect(make({ ...BASE_CFG, list_archives: 3 }).repository.list_command()).toContain("--last 3");
    expect(make({ ...BASE_CFG, list_archives: 0 }).repository.list_command()).toContain("--last 1");
  });

  it("sets BORG_RSH from an ssh key", () => {
    const command = make({ ...BASE_CFG, ssh_key: "/run/secrets/x_monitor_ssh_key" }).repository.list_command();
    for (const part of ["BORG_RSH=", "/run/secrets/x_monitor_ssh_key", "IdentitiesOnly=yes", "BatchMode=yes"]) {
      expect(command).toContain(part);
    }
  });

  it("uses the ssh key for backups too", () => {
    const repository = make({ ...BASE_CFG, source_paths: ["/home"], ssh_key: "/run/secrets/k" }).repository;
    expect(repository.backup_command()).toContain("BORG_RSH=");
  });

  it("lets rsh override the ssh key", () => {
    const command = make({ ...BASE_CFG, ssh_key: "/run/secrets/k", rsh: "ssh -J jump.host" }).repository.list_command();
    expect(command).toContain("ssh -J jump.host");
    expect(command).not.toContain("/run/secrets/k");
  });

  it("sets no BORG_RSH without a key", () => {
    expect(make().repository.list_command()).not.toContain("BORG_RSH=");
  });

  it("gives borg a longer timeout by default, which can be overridden", () => {
    expect(make().repository.timeout).toBe(BorgRepository.DEFAULT_TIMEOUT);
    expect(make({ ...BASE_CFG, timeout: "10m" }).repository.timeout).toBe(600);
  });

  it("runs without sudo by default", () => {
    expect(make().repository.list_command()).not.toContain("sudo");
  });

  it("puts the passphrase pipe first, then sudo, then the environment, then borg", () => {
    const command = make({ ...BASE_CFG, require_sudo: true, passphrase: "s3cret" }).repository.list_command();
    expect(command.indexOf("printf ")).toBeLessThan(command.indexOf("sudo -n "));
    expect(command.indexOf("sudo -n ")).toBeLessThan(command.indexOf("BORG_PASSPHRASE_FD=0"));
    expect(command.indexOf("BORG_PASSPHRASE_FD=0")).toBeLessThan(command.indexOf("borg list"));
  });

  it("supports a local repo path", () => {
    expect(make({ ...BASE_CFG, repo: "/mnt/backups/repo" }).repository.list_command()).toContain("/mnt/backups/repo");
  });

  it("uses a custom borg binary and lock wait", () => {
    const command = make({ ...BASE_CFG, borg_bin: "/opt/borg", lock_wait: 30 }).repository.list_command();
    expect(command).toContain("/opt/borg list");
    expect(command).toContain("--lock-wait 30");
  });
});

// ── Separate calls ───────────────────────────────────────────────────────────

describe("separate calls", () => {
  it("sends each call as its own command, list before info, never backgrounded", () => {
    const commands = make().repository.commands();
    expect(commands).toHaveLength(2);
    expect(commands[0].text).toContain("borg list");
    expect(commands[1].text).toContain("borg info");
    expect(commands.some((command) => command.text.includes(" & "))).toBe(false);
  });

  it("polls once with stats off", () => {
    expect(poll_text(make({ ...BASE_CFG, collect_stats: false }))).not.toContain("borg info");
  });

  it("keeps each call's own exit code", () => {
    const result = collect(make(), cmd_result(0, multi_json(now() - 60), ""), cmd_result(2, "", "borg info exploded"));
    expect(result.status).toBe("online");
    expect(messages(result)).toContain("borg info failed (exit 2)");
  });

  it("keeps each call's own streams", () => {
    const result = collect(make(), cmd_result(0, multi_json(now() - 60), "Remote: Replaying segments..."));
    expect(result.status).toBe("online");
  });

  it("hands each call the poll's timeout and sets no deadline of its own", () => {
    const harness = make({ ...BASE_CFG, require_sudo: true, timeout: "30m" });
    expect(harness.repository.commands().map((command) => command.timeout)).toEqual([1800, 1800]);
    expect(poll_text(harness)).not.toContain("timeout");
  });

  it("gives each call its own throwaway base folder", () => {
    expect(poll_text(make()).split("$(mktemp -d)").length - 1).toBe(2);
  });
});

// ── Lock hints ───────────────────────────────────────────────────────────────

describe("lock hints", () => {
  it("points a repo lock at a running backup", () => {
    const result = collect(make(), cmd_result(2, "", "Failed to create/acquire the lock /srv/repo/lock.exclusive (timeout)."));
    expect(messages(result)).toContain("a backup may be running");
    expect(messages(result)).not.toContain("chunks cache");
  });

  it("points a cache lock at the shared cache folder", () => {
    const result = collect(make(), cmd_result(2, "", "Failed to create/acquire the lock /var/cache/x-monitor-borg/.cache/borg/abc123/lock.exclusive (timeout)."));
    expect(messages(result)).toContain("chunks cache");
    expect(messages(result)).toContain("cache_dir");
    expect(messages(result)).not.toContain("a backup may be running");
  });
});

// ── Actions ──────────────────────────────────────────────────────────────────

describe("actions", () => {
  it("offers only repo actions without further config", () => {
    expect(action_ids(make())).toEqual(["check_repo", "compact_repo"]);
  });

  it("offers backups once source paths are set", () => {
    expect(action_ids(make({ ...BASE_CFG, source_paths: ["/home"] }))).toEqual(expect.arrayContaining(["run_backup", "dry_run_backup"]));
  });

  it("offers every tool when configured", () => {
    expect(action_ids(make(FULL_CFG))).toEqual([
      "run_backup", "dry_run_backup", "verify_restore", "check_repo", "compact_repo",
      "prune_preview", "prune_repo", "purge_preview", "purge_excluded", "break_lock",
    ]);
  });

  it("asks before destructive tools and names the repo", () => {
    const harness = make(FULL_CFG);
    for (const action_id of ["prune_repo", "purge_excluded", "break_lock"]) {
      const spec = action(harness, action_id);
      expect(spec.confirm).toContain(BASE_CFG.repo);
    }
  });

  it("lights up Check while it runs and greys out other jobs", () => {
    const harness = make(FULL_CFG);
    launch(harness, "check_repo");
    const repository = harness.repository;
    expect(repository.action_state(action(harness, "check_repo"))).toBe("accent");
    expect(repository.action_state(action(harness, "run_backup"))).toBe("disabled");
    expect(repository.action_state(action(harness, "break_lock"))).toBe("disabled");
    expect(repository.action_state(action(harness, "verify_restore"))).toBe("normal");
  });

  it("leaves Break Lock normal while no job runs", () => {
    const harness = make(FULL_CFG);
    expect(harness.repository.action_state(action(harness, "break_lock"))).toBe("normal");
  });

  it("refuses a backup without source paths", () => {
    const plan = refusal_of(make(), "run_backup");
    expect(plan.success).toBe(false);
    expect(messages(plan)).toContain("source_paths");
  });
});

// ── Backup command ───────────────────────────────────────────────────────────

describe("backup command", () => {
  it("includes the sources and the repo archive", () => {
    const command = make(BACKUP_CFG).repository.backup_command();
    expect(command).toContain("borg create");
    expect(command).toContain("/home");
    expect(command).toContain("/etc");
    expect(command).toContain("ssh://borg@host/srv/repo::");
  });

  it("names the archive by prefix and a sortable time", () => {
    const name = make({ ...BACKUP_CFG, archive_prefix: "nightly" }).repository.default_archive_name();
    expect(name).toMatch(/^nightly-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });

  it("names the archive in local time", () => {
    const previous = process.env.TZ;
    process.env.TZ = "America/Jamaica";
    try {
      const stamp = make({ ...BACKUP_CFG, archive_prefix: "nightly" }).repository.default_archive_name().slice("nightly-".length);
      const [date, time] = stamp.split("T");
      const [year, month, day] = date.split("-").map(Number);
      const [hour, minute, second] = time.split(":").map(Number);
      expect(Math.abs(new Date(year, month - 1, day, hour, minute, second).getTime() - Date.now())).toBeLessThan(5000);
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it("defaults the archive prefix to the repository's name", () => {
    expect(make(BACKUP_CFG).repository.default_archive_name()).toMatch(/^test-borg-/);
  });

  it("passes the excludes", () => {
    const command = make({ ...BACKUP_CFG, exclude: ["/home/*/.cache", "*.tmp"] }).repository.backup_command();
    expect(command.split("--exclude ").length - 1).toBeGreaterThanOrEqual(2);
    expect(command).toContain("/home/*/.cache");
    expect(command).toContain("*.tmp");
  });

  it("accepts a bare string for exclude and source_paths", () => {
    const repository = make({ ...BACKUP_CFG, exclude: "/tmp" }).repository;
    expect(repository.exclude).toEqual(["/tmp"]);
    expect(repository.backup_command()).toContain("/tmp");
    expect(make({ ...BASE_CFG, source_paths: "/home" }).repository.source_paths).toEqual(["/home"]);
  });

  it("passes the exclude file and markers", () => {
    expect(make({ ...BACKUP_CFG, exclude_from: "/etc/borg.excludes" }).repository.backup_command()).toContain("--exclude-from /etc/borg.excludes");
    expect(make({ ...BACKUP_CFG, exclude_if_present: [".nobackup"] }).repository.backup_command()).toContain("--exclude-if-present .nobackup");
  });

  it("stays on one file system unless told not to", () => {
    expect(make(BACKUP_CFG).repository.backup_command()).toContain("--one-file-system");
    expect(make({ ...BACKUP_CFG, one_file_system: false }).repository.backup_command()).not.toContain("--one-file-system");
  });

  it("excludes caches by default", () => {
    expect(make(BACKUP_CFG).repository.backup_command()).toContain("--exclude-caches");
  });

  it("compresses with zstd unless configured", () => {
    expect(make(BACKUP_CFG).repository.backup_command()).toContain("--compression zstd");
    expect(make({ ...BACKUP_CFG, compression: "zstd,10" }).repository.backup_command()).toContain("--compression zstd,10");
  });

  it("uses the persistent cache folder", () => {
    const command = make(BACKUP_CFG).repository.backup_command();
    expect(command).toContain("BORG_BASE_DIR=/var/cache/x-monitor-borg");
    expect(command).not.toContain("mktemp");
    expect(command).not.toContain("rm -rf");
    expect(make({ ...BACKUP_CFG, cache_dir: "/srv/borgcache" }).repository.backup_command()).toContain("BORG_BASE_DIR=/srv/borgcache");
  });

  it("still gives polls a throwaway base folder", () => {
    const command = poll_text(make(BACKUP_CFG));
    expect(command).toContain("$(mktemp -d)");
    expect(command).toContain("trap 'rm -rf");
    expect(command.indexOf("mktemp -d")).toBeLessThan(command.indexOf("BORG_BASE_DIR="));
  });

  it("applies a configured cache folder to polls", () => {
    const repository = make({ ...BASE_CFG, cache_dir: "/srv/borgcache" }).repository;
    for (const command of [repository.list_command(), repository.info_command()]) {
      expect(command).toContain("BORG_BASE_DIR=/srv/borgcache");
      expect(command).not.toContain("mktemp");
      expect(command).not.toContain("rm -rf");
    }
  });

  it("waits longer for the lock, as configured", () => {
    expect(make(BACKUP_CFG).repository.backup_command()).toContain("--lock-wait 600");
    expect(make({ ...BACKUP_CFG, backup_lock_wait: 30 }).repository.backup_command()).toContain("--lock-wait 30");
  });

  it("reports structured progress", () => {
    const command = make(BACKUP_CFG).repository.backup_command();
    expect(command).toContain("--log-json");
    expect(command).toContain("--progress");
  });

  it("swaps stats for a dry run flag on a dry run", () => {
    const repository = make(BACKUP_CFG).repository;
    expect(repository.backup_command({ dry_run: true })).toContain("--dry-run");
    expect(repository.backup_command({ dry_run: true })).not.toContain("--stats");
    expect(repository.backup_command()).toContain("--stats");
    expect(repository.backup_command()).not.toContain("--dry-run");
  });

  it("reads the passphrase from stdin and honours sudo", () => {
    expect(make({ ...BACKUP_CFG, passphrase: "s3cret" }).repository.backup_command()).toContain("BORG_PASSPHRASE_FD=0");
    expect(make({ ...BACKUP_CFG, require_sudo: true }).repository.backup_command()).toMatch(/^sudo -n /);
  });
});

// ── Backup launch ────────────────────────────────────────────────────────────

describe("backup launch", () => {
  it("records the running job", () => {
    const harness = make(BACKUP_CFG);
    const outcome = launch(harness, "run_backup") as CollectResult;
    expect(outcome.success).toBe(true);
    const job = harness.runs.running()!;
    expect(job.kind).toBe("backup");
    expect(job.agent_run).toBe("run-1");
    expect(job.state).toBe("running");
    expect(outcome.content).toBe("Backup started (run #1)");
  });

  it("records a dry run under its own kind", () => {
    const harness = make(BACKUP_CFG);
    launch(harness, "dry_run_backup");
    expect(harness.runs.running()!.kind).toBe("dry-run");
  });

  it("records no job when the preflight cannot run", () => {
    const harness = make(BACKUP_CFG);
    const outcome = outcome_of(harness, "run_backup", [cmd_result(-1, "", "No agent is connected for odin.")]);
    harness.apply(outcome);
    expect(outcome.success).toBe(false);
    expect(harness.runs.recent()).toEqual([]);
  });

  it("ends the job's record when the agent cannot start it", () => {
    const harness = make(BACKUP_CFG);
    const plan = long_run_of(harness, "run_backup");
    const outcome = plan.read_start(plan.record(), "No agent is connected for odin.");
    expect(outcome.success).toBe(false);
    expect(harness.runs.running()).toBeNull();
    expect(harness.runs.recent()[0]).toMatchObject({ state: "failed", error: "Could not start: No agent is connected for odin." });
  });

  it("stores the launched command with the passphrase hidden", () => {
    const harness = make(BACKUP_CFG);
    harness.repository.passphrase = "s3cret";
    launch(harness);
    const stored = harness.runs.running()!.command;
    expect(stored).not.toContain("s3cret");
    expect(stored).toContain("BORG_PASSPHRASE_FD=0");
  });

  it("hands the passphrase to the long run through its environment", () => {
    const plan = long_run_of(make({ ...BACKUP_CFG, passphrase: "s3cret" }), "run_backup");
    expect(plan.command).toMatch(/^IFS= read -r __x_backups_passphrase; export __x_backups_passphrase; /);
    expect(plan.command).not.toContain("s3cret");
    expect(plan.preflight).not.toContain("__x_backups_passphrase");
    expect(plan.stdin).toBe("s3cret\n");
  });

  it("refuses a second backup while one runs", () => {
    const harness = make(BACKUP_CFG);
    launch(harness);
    expect(messages(refusal_of(harness, "run_backup"))).toContain("already running");
  });
});

// ── Backup polling ───────────────────────────────────────────────────────────

describe("backup polling", () => {
  it("keeps a running job running", () => {
    const harness = make(BACKUP_CFG);
    launch(harness);
    poll_once(harness, job_poll(10, null, true, "working\n"));
    expect(harness.runs.running()).not.toBeNull();
  });

  it("leaves the job running, waiting for its agent, when the poll goes unanswered", () => {
    const harness = make(BACKUP_CFG);
    launch(harness);
    const result = harness.repository.read_run_unreachable(harness.runs.running()!, "No agent is connected for odin.");
    expect(harness.runs.running()!.progress).toBe(WAITING_FOR_AGENT);
    expect(messages(result)).toContain("Could not poll");
    expect(result.status).toBeNull();
    poll_once(harness, job_poll(0, null, true, ""));
    expect(harness.runs.running()!.progress).toBeNull();
  });

  it("marks a job its agent no longer knows as lost", () => {
    const harness = make(BACKUP_CFG);
    launch(harness);
    const result = harness.repository.read_run_lost(harness.runs.running()!, "odin");
    expect(harness.runs.running()).toBeNull();
    expect(harness.runs.recent()[0].error).toContain("Lost: the agent on odin no longer knows this run");
    expect(result.status).toBe("failed");
  });

  it("keeps reading a job that has ended until all its output is read", () => {
    const harness = make(BACKUP_CFG);
    launch(harness);
    poll_once(harness, { state: "exited", exit_code: 0, alive: false, size: 20, new_output: "first\n", next_offset: 6 });
    expect(harness.runs.running()!.output_seq).toBe(6);
    poll_once(harness, { state: "exited", exit_code: 0, alive: false, size: 20, new_output: "the rest of it", next_offset: 20 });
    expect(harness.runs.output(1)).toEqual(["first", "the rest of it"]);
    expect(harness.runs.recent()[0].state).toBe("succeeded");
  });

  it("records a stopped job as cancelled", () => {
    const harness = make(BACKUP_CFG);
    launch(harness);
    const result = poll_once(harness, { state: "stopped", exit_code: 143, alive: false, size: 0, new_output: "", next_offset: 0 });
    expect(harness.runs.recent()[0].state).toBe("cancelled");
    expect(result.content).toBe("Backup cancelled");
  });

  it("never judges a job started mid-cycle by the listing's output", () => {
    const harness = make(BACKUP_CFG);
    const commands = harness.repository.commands();
    expect(commands.length).toBeGreaterThanOrEqual(1);
    launch(harness);
    harness.apply(harness.repository.parse(commands.map(() => cmd_result(1, "", "repo busy"))));
    expect(harness.runs.running()).not.toBeNull();
  });

  it("marks a finished job succeeded", () => {
    const harness = make(BACKUP_CFG);
    launch(harness);
    poll_once(harness, job_poll(20, 0, false, "done\n"));
    expect(harness.runs.running()).toBeNull();
    expect(harness.runs.recent()[0].state).toBe("succeeded");
  });

  it("keeps a finished job's last line though it arrives without its newline", () => {
    const harness = make(BACKUP_CFG);
    launch(harness);
    poll_once(harness, job_poll(30, null, true, "first line\nhalf a li"));
    const run_id = harness.runs.recent()[0].id;
    expect(harness.runs.output(run_id)).toEqual(["first line"]);
    poll_once(harness, job_poll(40, 3, false, "half a line"));
    expect(harness.runs.output(run_id)).toEqual(["first line", "half a line"]);
  });

  it("marks borg's warning exit as finished with warnings", () => {
    const harness = make(BACKUP_CFG);
    launch(harness);
    poll_once(harness, job_poll(5, 1, false, ""));
    expect(harness.runs.recent()[0].state).toBe("warning");
  });

  it("counts borg's error exit as failure", () => {
    const harness = make(BACKUP_CFG);
    launch(harness);
    poll_once(harness, job_poll(5, 2, false, ""));
    expect(harness.runs.recent()[0].state).toBe("failed");
    expect(harness.runs.recent()[0].exit_code).toBe(2);
  });

  it("fails a process that died without an exit file", () => {
    const harness = make(BACKUP_CFG);
    launch(harness);
    poll_once(harness, job_poll(5, null, false, "partial"));
    expect(harness.runs.recent()[0].state).toBe("failed");
  });

  it("reads progress from borg's JSON log", () => {
    const harness = make(BACKUP_CFG);
    launch(harness);
    const progress = JSON.stringify({ type: "archive_progress", path: "/home/user/file.txt", original_size: 1048576, deduplicated_size: 524288, nfiles: 42 });
    poll_once(harness, job_poll(progress.length + 1, null, true, progress + "\n"));
    expect(harness.runs.running()!.progress).toContain("42 files");
    expect(harness.runs.running()!.progress).toContain("/home/user/file.txt");
  });

  it("ignores progress lines with zero counters", () => {
    const harness = make(BACKUP_CFG);
    launch(harness);
    const real = JSON.stringify({ original_size: 1048576, deduplicated_size: 524288, nfiles: 42, path: "src/big.bin", type: "archive_progress", finished: false });
    const opening = JSON.stringify({ original_size: 0, deduplicated_size: 0, nfiles: 0, path: "src", type: "archive_progress", finished: false });
    poll_once(harness, job_poll(real.length + 1, null, true, real + "\n"));
    expect(harness.runs.running()!.progress).toContain("42 files");
    const offset = harness.runs.running()!.output_seq;
    poll_once(harness, job_poll(offset + opening.length + 1, null, true, opening + "\n"));
    expect(harness.runs.running()!.progress).toContain("42 files");
  });

  it("stores the output lines", () => {
    const harness = make(BACKUP_CFG);
    launch(harness);
    poll_once(harness, job_poll(12, 0, false, "line1\nline2\n"));
    expect(harness.runs.output(harness.runs.recent()[0].id)).toEqual(["line1", "line2"]);
  });

  it("completes a partial line across polls", () => {
    const harness = make(BACKUP_CFG);
    launch(harness);
    poll_once(harness, job_poll(4, null, true, "par"));
    const run_id = harness.runs.running()!.id;
    expect(harness.runs.output(run_id)).toEqual([]);
    poll_once(harness, job_poll(8, 0, false, "partial\n"));
    expect(harness.runs.output(run_id)).toEqual(["partial"]);
  });

  it("counts consumed output in bytes", () => {
    const harness = make(BACKUP_CFG);
    launch(harness);
    poll_once(harness, job_poll(6, null, true, "café\n"));
    expect(harness.runs.running()!.output_seq).toBe(6);
  });
});

// ── Repository stats ─────────────────────────────────────────────────────────

describe("repository stats", () => {
  it("asks for info as JSON", () => {
    const command = make().repository.info_command();
    expect(command).toContain("borg info");
    expect(command).toContain("--json");
  });

  it("records the stats", () => {
    const harness = make();
    collect(harness, cmd_result(0, list_json(now() - 60), ""), cmd_result(0, info_json(), ""));
    expect(harness.repository.state.stats!.original_size).toBe(1000);
    expect(harness.repository.state.stats!.deduplicated_size).toBe(250);
  });

  it("derives the dedup ratio", () => {
    const harness = make();
    collect(harness, cmd_result(0, list_json(now() - 60), ""), cmd_result(0, info_json(1000, 500, 250), ""));
    expect(harness.repository.state.stats!.dedup_ratio).toBeCloseTo(4);
  });

  it("skips the info call with stats off", () => {
    expect(make({ ...BASE_CFG, collect_stats: false }).repository.commands()).toHaveLength(1);
  });

  it.each([
    ["a failed info call", cmd_result(2, "", "info exploded")],
    ["unparseable info", cmd_result(0, "not json", "")],
  ])("tolerates %s", (_label, info) => {
    const harness = make();
    collect(harness, cmd_result(0, list_json(now() - 60), ""), info);
    expect(harness.outcomes.latest_status()).toBe("online");
  });

  it("still fails an empty repo", () => {
    const harness = make();
    collect(harness, cmd_result(0, list_json(null), ""));
    expect(harness.outcomes.latest_status()).toBe("failed");
  });

  it("records no stats when the cache stats are missing", () => {
    const harness = make();
    collect(harness, cmd_result(0, list_json(now() - 60), ""), cmd_result(0, JSON.stringify({ repository: {} }), ""));
    expect(harness.repository.state.stats).toBeNull();
  });

  it("logs to the events the page reads", () => {
    const harness = make();
    collect(harness, cmd_result(0, list_json(now() - 60), ""));
    expect(harness.outcomes.events.length).toBeGreaterThan(0);
  });
});

// ── Archive cache ────────────────────────────────────────────────────────────

describe("archive cache", () => {
  it("caches the archives for the page", () => {
    const harness = make({ ...BASE_CFG, collect_stats: false });
    harness.run_cycle(() => cmd_result(0, multi_json(now() - 3600, now() - 7200), ""));
    const { archives, repository } = harness.repository.state;
    expect(archives.map((archive) => archive.name)).toEqual(["archive-0", "archive-1"]);
    expect(repository.location).toBe("/srv/repo");
  });

  it("is empty before the first poll", () => {
    const { archives, repository } = make().repository.state;
    expect([archives, repository]).toEqual([[], {}]);
  });

  it("merges each archive's sizes from info", () => {
    const harness = make();
    const info = JSON.stringify({
      cache: { stats: { total_size: 1000, total_csize: 500, unique_csize: 250 } },
      archives: [{ name: "archive-0", stats: { original_size: 400000, compressed_size: 300000, deduplicated_size: 1024, nfiles: 42 } }],
    });
    collect(harness, cmd_result(0, multi_json(now() - 3600), ""), cmd_result(0, info, ""));
    const first = harness.repository.state.archives.find((archive) => archive.name === "archive-0")!;
    expect(first.original).toBe(400000);
    expect(first.deduplicated).toBe(1024);
    expect(first.nfiles).toBe(42);
  });

  it("asks info for as many archives as it lists", () => {
    expect(make({ ...BASE_CFG, list_archives: 5 }).repository.info_command()).toContain("--last 5");
  });

  it("keeps archive names when info has no per-archive stats", () => {
    const harness = make();
    collect(harness, cmd_result(0, multi_json(now() - 3600), ""), cmd_result(0, JSON.stringify({ cache: { stats: { total_size: 10, unique_csize: 5 } } }), ""));
    const { archives } = harness.repository.state;
    expect(archives.map((archive) => archive.name)).toEqual(["archive-0"]);
    expect(archives[0]).not.toHaveProperty("original");
  });
});

// ── Restore canary ───────────────────────────────────────────────────────────

describe("restore canary", () => {
  it("waits for an archive to be known", () => {
    const harness = make(CANARY_CFG);
    harness.repository.commands();
    expect(harness.repository.poll_calls).toEqual(["list"]);
  });

  it("extracts the canary from the newest archive once one is known", () => {
    const harness = make(CANARY_CFG);
    cycle_with(harness);
    const command = poll_text(harness);
    expect(harness.repository.poll_calls).toEqual(["list", "canary", "canary_live"]);
    expect(command).toContain("extract --stdout");
    expect(command.replaceAll("'", "")).toContain("host-2024 Storage/System/.x-monitor-canary");
  });

  it("reads the live canary without sudo first", () => {
    const canary = join(scratch_dir(), ".x-monitor-canary");
    writeFileSync(canary, "token");
    const harness = make({ ...CANARY_CFG, canary_path: canary, require_sudo: true });
    cycle_with(harness);
    const live = new Map(harness.repository.poll_plan()).get("canary_live")!;
    // Run for real, with no sudo on the path.
    const result = sh(live, { PATH: "/run/current-system/sw/bin:/usr/bin:/bin" });
    expect(result.returncode).toBe(0);
    expect(result.stdout).toBe("token");
    expect(live).toContain("|| sudo -n cat");
  });

  it("passes a matching canary", () => {
    const harness = make(CANARY_CFG);
    cycle_with(harness);
    harness.repository.commands();
    cycle_with(harness, { canary: cmd_result(0, "token", ""), canary_live: cmd_result(0, "token\n", "") });
    expect(harness.repository.state.canary!.ok).toBe(true);
    expect(harness.outcomes.latest_status()).toBe("online");
  });

  it("fails on a differing canary", () => {
    const harness = make(CANARY_CFG);
    cycle_with(harness);
    harness.repository.commands();
    cycle_with(harness, { canary: cmd_result(0, "old", ""), canary_live: cmd_result(0, "new", "") });
    expect(harness.repository.state.canary!.ok).toBe(false);
    expect(harness.outcomes.latest_status()).toBe("failed");
  });

  it("stays failed after a failed canary until one passes", () => {
    const harness = make(CANARY_CFG);
    cycle_with(harness);
    harness.repository.commands();
    cycle_with(harness, { canary: cmd_result(1, "", "Include pattern 'x' never matched."), canary_live: cmd_result(0, "t", "") });
    harness.repository.commands();
    expect(harness.repository.poll_calls).not.toContain("canary");
    cycle_with(harness);
    expect(harness.outcomes.latest_status()).toBe("failed");
  });

  it("reaches no verdict on a locked repo", () => {
    const harness = make(CANARY_CFG);
    cycle_with(harness);
    harness.repository.commands();
    cycle_with(harness, { canary: cmd_result(2, "", "Failed to create/acquire the lock /r/lock (timeout)."), canary_live: cmd_result(0, "t", "") });
    expect(harness.repository.state.canary).toBeNull();
    expect(harness.outcomes.latest_status()).toBe("online");
  });

  it("records the verdict of the Verify Restore action", () => {
    const harness = make(CANARY_CFG);
    cycle_with(harness);
    const plan = plan_of(harness, "verify_restore");
    expect(plan.commands).toHaveLength(2);
    expect(plan.commands[0]).toContain("extract --stdout");
    expect(plan.detached).toBe(true);
    expect(plan.timeout).toBeNull();
    const outcome = outcome_of(harness, "verify_restore", [cmd_result(0, "t", ""), cmd_result(0, "t", "")]);
    harness.apply(outcome);
    expect(outcome.success).toBe(true);
    expect(outcome.status).toBeNull();
    expect(harness.repository.state.canary!.ok).toBe(true);
  });
});

// ── Check freshness ──────────────────────────────────────────────────────────

describe("check freshness", () => {
  it("passes a recent success", () => {
    const harness = make(CHECK_CFG);
    harness.repository.commands();
    cycle_with(harness, { checks: checks_out({ ok: now() - 3600 }) });
    expect(harness.repository.state.checks!.passed).toBe(true);
    expect(harness.outcomes.latest_status()).toBe("online");
  });

  it("fails a stale success", () => {
    const harness = make(CHECK_CFG);
    harness.repository.commands();
    cycle_with(harness, { checks: checks_out({ ok: now() - 10 * 86400 }) });
    expect(harness.outcomes.latest_status()).toBe("failed");
  });

  it("fails with no record", () => {
    const harness = make(CHECK_CFG);
    harness.repository.commands();
    cycle_with(harness, { checks: checks_out() });
    expect(harness.outcomes.latest_status()).toBe("failed");
  });

  it("fails on a failure naming this repo", () => {
    const harness = make(CHECK_CFG);
    harness.repository.commands();
    cycle_with(harness, { checks: checks_out({ ok: now() - 86400, end: now() - 60, start: now() - 600, errs: [[now() - 70, "/srv/local"]] }) });
    expect(harness.outcomes.latest_status()).toBe("failed");
  });

  it("passes a failure naming only another repo", () => {
    const harness = make(CHECK_CFG);
    harness.repository.commands();
    cycle_with(harness, { checks: checks_out({ end: now() - 60, start: now() - 600, errs: [[now() - 70, "ssh://borg@far/srv/local"]] }) });
    expect(harness.repository.state.checks!.passed).toBe(true);
    expect(harness.outcomes.latest_status()).toBe("online");
  });

  it("keeps the last success after the journal rotates", () => {
    const harness = make(CHECK_CFG);
    harness.repository.commands();
    cycle_with(harness, { checks: checks_out({ ok: now() - 3600 }) });
    harness.repository.commands();
    cycle_with(harness, { checks: checks_out() });
    expect(harness.outcomes.latest_status()).toBe("online");
  });

  it("reads only systemd's own lines", () => {
    const harness = make(CHECK_CFG);
    harness.repository.commands();
    expect(poll_text(harness)).toContain("_PID=1");
  });
});

// ── Prune preview ────────────────────────────────────────────────────────────

describe("prune preview", () => {
  it("is refused without retention", () => {
    const outcome = refusal_of(make(), "prune_preview");
    expect(outcome.success).toBe(false);
    expect(outcome.status).toBeNull();
  });

  it("is a dry run with the configured policy", () => {
    const command = command_of(make({ ...BASE_CFG, keep_daily: 7, keep_within: "6H", archive_prefix: "odin" }), "prune_preview");
    expect(command).toContain("prune --dry-run --list");
    expect(command).toContain("--keep-daily 7");
    expect(command).toContain("--keep-within 6H");
    expect(command).toContain("--glob-archives 'odin-*'");
  });

  it("lists what would go", () => {
    const harness = make({ ...BASE_CFG, keep_daily: 1 });
    const content = outcome_of(harness, "prune_preview", [cmd_result(0, "", PRUNE_OUTPUT)]).content!;
    expect(content).toContain("Would prune 1 of 3");
    expect(content.split("Keeping")[0]).toContain("backup-2026-09-22T00:00:00");
  });

  it("leaves the status alone when it fails", () => {
    const harness = make({ ...BASE_CFG, keep_daily: 1 });
    const outcome = outcome_of(harness, "prune_preview", [cmd_result(2, "", "Failed to create/acquire the lock")]);
    expect(outcome.success).toBe(false);
    expect(outcome.status).toBeNull();
    expect(outcome.content).toContain("locked");
  });
});

// ── Browse ───────────────────────────────────────────────────────────────────

function run_filter(member: string, lines: string): string {
  const listing = join(scratch_dir(), "listing");
  writeFileSync(listing, lines + "\n");
  const run = sh(`${children_filter(member)} ${listing}`);
  expect(run.returncode).toBe(0);
  return run.stdout;
}

describe("browse", () => {
  it("lists the path through the children filter", () => {
    const command = command_of(make(), "browse_archive", { archive: "a1", path: "/Storage/System/" });
    expect(command.replaceAll("'", "")).toContain("::a1 Storage/System");
    expect(command).toContain("awk -v p=Storage/System/");
  });

  it("lists the whole archive at the top level", () => {
    const command = command_of(make(), "browse_archive", { archive: "a1", path: "" });
    expect(command).not.toContain("::a1 --format");
    expect(command).toContain("awk -v p=''");
  });

  it("filters to direct children only", () => {
    const out = run_filter("Storage", [
      "d\t0\t2026-09-20T10:00:00\tStorage",
      "-\t5\t2026-09-20T10:00:00\tStorage/a.txt",
      "-\t5\t2026-09-20T10:00:00\tStorage/deep/b.txt",
    ].join("\n"));
    expect(out.trimEnd().split("\n")).toEqual(["-\t5\t2026-09-20T10:00:00\tStorage/a.txt", "d\t\t\tStorage/deep"]);
  });

  it("makes up parents borg never stored", () => {
    const out = run_filter("", [
      "-\t5\t2026-09-20T10:00:00\tStorage/System/a",
      "-\t5\t2026-09-20T10:00:00\tStorage/System/b",
      "-\t5\t2026-09-20T10:00:00\thome/x",
    ].join("\n"));
    expect(out.trimEnd().split("\n")).toEqual(["d\t\t\tStorage", "d\t\t\thome"]);
  });

  it("keeps a path with a tab in it", () => {
    expect(run_filter("", "-\t5\t2026-09-20T10:00:00\ta\tb").trimEnd().split("\n")).toEqual(["-\t5\t2026-09-20T10:00:00\ta\tb"]);
  });

  it("parses and caches the listing", () => {
    const harness = make();
    const outcome = outcome_of(harness, "browse_archive", [cmd_result(0, LISTING, "")], { archive: "a1", path: "Storage/System" });
    expect(outcome.success).toBe(true);
    const entries = harness.repository.listing("a1", "/Storage/System/")!;
    expect(entries.map((entry) => entry.name)).toEqual(["etc", "var", "notes.txt"]);
    expect(entries[2].size).toBe(2048);
    expect(entries[2].mtime).toBe("2026-09-20 10:01");
  });

  it("serves a cached folder without borg", () => {
    const harness = make();
    harness.repository.read_browse(cmd_result(0, LISTING, ""), "a1", "Storage/System");
    const outcome = refusal_of(harness, "browse_archive", { archive: "a1", path: "Storage/System" });
    expect(outcome).toBeInstanceOf(CollectResult);
    expect(outcome.success).toBe(true);
    expect(outcome.content).toContain("3 entries");
  });

  it("lets a real item beat a made-up folder", () => {
    const entries = parse_listing("d\t\t\tx/etc\nd\t0\t2026-09-20T10:00:00\tx/etc");
    expect(entries).toHaveLength(1);
    expect(entries[0].mtime).toBe("2026-09-20 10:00");
  });

  it("caps the output", () => {
    const harness = make({ ...BASE_CFG, browse_limit: 2 });
    expect(command_of(harness, "browse_archive", { archive: "a1", path: "" })).toContain("awk 'NR <= 3'");
    const lines = ["a", "b", "c"].map((name) => `-\t1\t\t${name}`).join("\n");
    const content = outcome_of(harness, "browse_archive", [cmd_result(0, lines, "")], { archive: "a1", path: "" }).content;
    expect(content).toContain("first 2 entries");
    expect(content).not.toContain("\nc ");
  });

  it("refuses climbing paths", () => {
    expect(refusal_of(make(), "browse_archive", { archive: "a1", path: "x/../../etc" }).success).toBe(false);
  });

  it("never caches a failed listing", () => {
    const harness = make();
    harness.repository.read_browse(cmd_result(2, "", "boom"), "a1", "");
    expect(harness.repository.listing("a1", "")).toBeNull();
  });
});

// ── Restore ──────────────────────────────────────────────────────────────────

describe("restore", () => {
  it("extracts into a new folder under restore_dir", () => {
    const command = command_of(make(RESTORE_CFG), "restore_archive", { archive: "a1", path: "/Storage/System/x" });
    expect(command).toContain("sudo -n mkdir -p /var/tmp/r/a1-");
    expect(command).toContain("extract");
    expect(command.replaceAll("'", "")).toContain("::a1 Storage/System/x");
  });

  it("records a restore job", () => {
    const harness = make(RESTORE_CFG);
    const outcome = outcome_of(harness, "restore_archive", [cmd_result(0, "77\n", "")], { archive: "a1", path: "etc" });
    harness.apply(outcome);
    expect(harness.runs.running()!.kind).toBe("restore");
    expect(outcome.content).toContain("/var/tmp/r/a1-");
  });

  it("refuses a whole-archive restore", () => {
    expect(refusal_of(make(), "restore_archive", { archive: "a1", path: "/" }).success).toBe(false);
  });

  it("is refused while a job runs", () => {
    const harness = make(RESTORE_CFG);
    launch(harness, "restore_archive", { archive: "a1", path: "etc" });
    expect(refusal_of(harness, "restore_archive", { archive: "a1", path: "etc" }).success).toBe(false);
  });

  it("restores into a new dated folder inside a chosen folder", () => {
    const command = command_of(make(RESTORE_CFG), "restore_archive", { archive: "a1", path: "etc", target: "/srv/restored/" });
    expect(command).toContain("sudo -n mkdir -p /srv/restored/a1-");
  });

  it("restores into a chosen folder itself only while it is empty", () => {
    const folder = join(scratch_dir(), "chosen folder");
    const command = command_of(make({ ...BASE_CFG, restore_dir: "/unused" }), "restore_archive", { archive: "a1", path: "etc", target: folder, fresh: false });
    expect(command).toContain("-mindepth 1 -maxdepth 1");
    // The check before borg, run for real: a missing or empty folder passes, one holding anything stops the restore.
    const check = when_folder_empty(folder, "", "echo restored");
    expect(sh(check).stdout).toBe("restored\n");
    mkdirSync(folder);
    expect(sh(check).stdout).toBe("restored\n");
    writeFileSync(join(folder, "live-file"), "keep me");
    const refused = sh(check);
    expect(refused.returncode).toBe(3);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("it is not empty");
  });

  it("refuses a relative or dotted folder", () => {
    expect(refusal_of(make(RESTORE_CFG), "restore_archive", { archive: "a1", path: "etc", target: "srv/x" }).content).toContain("absolute path");
    expect(refusal_of(make(RESTORE_CFG), "restore_archive", { archive: "a1", path: "etc", target: "/srv/../etc" }).content).toContain("'..'");
  });

  it("restores several ticked paths at once", () => {
    const command = command_of(make(RESTORE_CFG), "restore_archive", { archive: "a1", paths: ["/etc/x", "home/y"] });
    expect(command.replaceAll("'", "")).toContain("::a1 etc/x home/y");
  });

  it("refuses the lot when one path climbs", () => {
    expect(refusal_of(make(RESTORE_CFG), "restore_archive", { archive: "a1", paths: ["etc", "../x"] }).success).toBe(false);
  });

  it("turns extract progress into the summary", () => {
    const line = JSON.stringify({ type: "progress_percent", message: " 50.0% Extracting: etc/x", finished: false });
    expect(progress_from_lines([line])).toBe("50.0% Extracting: etc/x");
  });
});

// ── Backup summary ───────────────────────────────────────────────────────────

describe("backup summary", () => {
  it("reports freshness and the extras", () => {
    const harness = make(CANARY_CFG);
    cycle_with(harness);
    const summary = harness.repository.backup_summary();
    expect(summary.fresh).toBe(true);
    expect(summary.restore_check).toBeNull();
    expect(summary.repo_checks).toBeNull();
  });
});

// ── Maintenance ──────────────────────────────────────────────────────────────

describe("maintenance", () => {
  it.each([
    ["check_repo", "check", "check --progress"],
    ["compact_repo", "compact", "compact --progress"],
    ["prune_repo", "prune", "prune --list --stats --glob-archives"],
  ])("runs %s as a detached %s job", (action_id, kind, args) => {
    const harness = make(DELETE_CFG);
    const command = command_of(harness, action_id);
    expect(command).toContain(args);
    expect(command).toContain("--log-json");
    launch(harness, action_id);
    expect(harness.runs.running()!.kind).toBe(kind);
  });

  it("prunes by the retention policy for real", () => {
    const command = command_of(make(DELETE_CFG), "prune_repo");
    expect(command).toContain("--keep-daily 7");
    expect(command).not.toContain("--dry-run");
  });

  it("verifies data only when asked", () => {
    expect(command_of(make(), "check_repo")).not.toContain("--verify-data");
    expect(command_of(make({ ...BASE_CFG, check_verify_data: true }), "check_repo")).toContain("--verify-data");
  });

  it.each(["prune_repo", "delete_archive", "break_lock"])("keeps %s off by default", (action_id) => {
    const outcome = refusal_of(make({ ...BASE_CFG, keep_daily: 7 }), action_id, { archive: "a1" });
    expect(outcome.success).toBe(false);
    expect(outcome.content).toContain("allow_delete");
  });

  it("runs one job at a time", () => {
    const harness = make(DELETE_CFG);
    launch(harness, "check_repo");
    expect(refusal_of(harness, "compact_repo").success).toBe(false);
    expect(refusal_of(harness, "break_lock").success).toBe(false);
  });

  it("breaks the lock directly", () => {
    const harness = make(DELETE_CFG);
    expect(command_of(harness, "break_lock")).toContain("break-lock");
    expect(outcome_of(harness, "break_lock", [cmd_result(0, "", "")]).success).toBe(true);
  });

  it("turns check progress into the summary", () => {
    const line = JSON.stringify({ type: "progress_message", message: "Checking segments 12.0%", finished: false });
    expect(progress_from_lines([line])).toBe("Checking segments 12.0%");
  });
});

// ── Purge ────────────────────────────────────────────────────────────────────

describe("purge", () => {
  it.each([["purge_preview", "purge-preview"], ["purge_excluded", "purge"]])("runs %s as a detached %s job", (action_id, kind) => {
    const harness = make(PURGE_CFG);
    launch(harness, action_id);
    expect(harness.runs.running()!.kind).toBe(kind);
  });

  it("rewrites with the backup's exclusions, then compacts", () => {
    const command = unquoted(command_of(make(PURGE_CFG), "purge_excluded"));
    expect(command).toContain("recreate --info --stats");
    expect(command).not.toContain("--dry-run");
    expect(command).toContain("--exclude fm:*/.cache");
    expect(command).toContain("--exclude-if-present .nobackup");
    expect(command.indexOf("delete --glob-archives *.recreate")).toBeLessThan(command.indexOf("recreate --info"));
    expect(command.indexOf("recreate --info")).toBeLessThan(command.indexOf("compact --progress"));
  });

  it("covers every archive unless purge_match is set", () => {
    const everything = unquoted(command_of(make(PURGE_CFG), "purge_excluded"));
    expect(everything).toContain("--glob-archives *.recreate");
    expect(everything).not.toContain("--glob-archives Odin-*");
    const scoped = unquoted(command_of(make({ ...PURGE_CFG, purge_match: "Odin-*" }), "purge_excluded"));
    expect(scoped).toContain("recreate --info --stats --progress --glob-archives Odin-*");
  });

  it("previews with a dry run listing only excluded items", () => {
    const command = command_of(make(PURGE_CFG), "purge_preview");
    expect(command).toContain("recreate --dry-run --list --filter=x");
    expect(command).not.toContain("compact");
  });

  it.each(["purge_preview", "purge_excluded"])("keeps %s off by default", (action_id) => {
    const outcome = refusal_of(make({ ...PURGE_CFG, allow_purge: false }), action_id);
    expect(outcome.success).toBe(false);
    expect(outcome.content).toContain("allow_purge");
  });

  it("needs something to exclude", () => {
    expect(refusal_of(make({ ...BASE_CFG, allow_purge: true, exclude_caches: false }), "purge_excluded").success).toBe(false);
  });

  it("turns Processing lines into the summary", () => {
    expect(progress_from_lines(["Processing Odin-2026-07-23", "0 B O 0 B C 0 B D 0 N src"])).toBe("Processing Odin-2026-07-23");
  });
});

// ── Delete ───────────────────────────────────────────────────────────────────

describe("delete", () => {
  it("deletes a listed archive", () => {
    const harness = make(DELETE_CFG);
    listed(harness, "b2", "b1");
    const command = command_of(harness, "delete_archive", { archive: "b1" });
    expect(command).toContain("delete --stats");
    expect(command).toContain("::b1");
    expect(launch(harness, "delete_archive", { archive: "b1" }).content).toContain("for b1");
  });

  it("refuses an archive it has not listed", () => {
    const harness = make(DELETE_CFG);
    listed(harness, "b2");
    expect(refusal_of(harness, "delete_archive", { archive: "nope" }).success).toBe(false);
  });

  it("forgets the deleted archive's listings", () => {
    const harness = make(DELETE_CFG);
    listed(harness, "b2", "b1");
    harness.repository.read_browse(cmd_result(0, LISTING, ""), "b1", "");
    harness.repository.delete_archive("b1");
    expect(harness.repository.listing("b1", "")).toBeNull();
  });
});

// ── Download ─────────────────────────────────────────────────────────────────

describe("download", () => {
  function listed_repository(config: BorgConfig = BASE_CFG): BorgRepository {
    const harness = make(config);
    listed(harness, "b2", "b1");
    return harness.repository;
  }

  function download_of(repository: BorgRepository, archive: string, paths: string[], kind: string): DownloadPlan {
    const download = repository.download(archive, paths, kind);
    expect(download).not.toBeInstanceOf(CollectResult);
    return download as DownloadPlan;
  }

  it("does not start beside a running job", () => {
    const harness = make();
    listed(harness, "b2", "b1");
    launch(harness, "compact_repo");
    const download = harness.repository.download("b1", ["etc"], "tar");
    expect(download).toBeInstanceOf(CollectResult);
    expect((download as CollectResult).content).toContain("download once it ends");
  });

  it("streams one file through extract --stdout under its own name", () => {
    const plan = download_of(listed_repository(), "b1", ["/home/me/notes.txt"], "file");
    expect(plan.command).toContain("extract --stdout --lock-wait 30 ssh://borg@host/srv/repo::b1 home/me/notes.txt");
    expect(plan.command).not.toContain("export-tar");
    expect(plan).toMatchObject({ filename: "notes.txt", content_type: "application/octet-stream", stdin: null });
  });

  it("streams a folder as a gzipped tar named after the archive and folder", () => {
    const plan = download_of(listed_repository(), "b1", ["home/me"], "tar");
    expect(plan.command).toContain("export-tar --tar-filter=gzip --lock-wait 30 ssh://borg@host/srv/repo::b1 - home/me");
    expect(plan.filename).toBe("b1-me.tar.gz");
    expect(plan.content_type).toBe("application/gzip");
  });

  it("puts several paths in one tar named after the archive", () => {
    const plan = download_of(listed_repository(), "b1", ["etc", "home/it's here"], "tar");
    expect(plan.command).toContain(`::b1 - etc 'home/it'"'"'s here'`);
    expect(plan.filename).toBe("b1.tar.gz");
  });

  it("runs under sudo and feeds the passphrase on stdin", () => {
    const plan = download_of(listed_repository({ ...BASE_CFG, require_sudo: true, passphrase: "s3cret" }), "b1", ["etc/hosts"], "file");
    expect(plan.command).toMatch(/^IFS= read -r __x_backups_passphrase; /);
    expect(plan.command).toContain(`"$__x_backups_passphrase" | sudo -n BORG_PASSPHRASE_FD=0 `);
    expect(plan.command).not.toContain("s3cret");
    expect(plan.stdin).toBe("s3cret\n");
  });

  it("refuses a path that climbs, an unlisted archive and a bad kind", () => {
    const repository = listed_repository();
    expect(repository.download("b1", ["etc/../shadow"], "file")).toBeInstanceOf(CollectResult);
    expect(repository.download("nope", ["etc"], "tar")).toBeInstanceOf(CollectResult);
    expect(repository.download(null, ["etc"], "tar")).toBeInstanceOf(CollectResult);
    expect(repository.download("b1", ["etc"], "zip")).toBeInstanceOf(CollectResult);
  });

  it("refuses a file download that does not name exactly one file", () => {
    const repository = listed_repository();
    expect(repository.download("b1", ["a", "b"], "file")).toBeInstanceOf(CollectResult);
    expect(repository.download("b1", ["/"], "file")).toBeInstanceOf(CollectResult);
  });

  it("names the failure with a hint", () => {
    const message = make().repository.download_failure(2, "Repository /srv/repo does not exist.\n");
    expect(message).toContain("borg failed (exit 2): Repository /srv/repo does not exist.");
    expect(message).toContain("Hint:");
  });
});

// ── Capped output ────────────────────────────────────────────────────────────

describe("capped output", () => {
  it("keeps the call's exit status through the pipe", () => {
    const result = sh(piped("sh -c 'echo first; echo oops >&2; exit 3'", "cat"));
    expect(result).toEqual({ stdout: "first\n", stderr: "oops\n", returncode: 3 });
  });

  it("cuts lines at the limit without failing the call", () => {
    const result = sh(piped("seq 1 5000", "awk 'NR <= 2'"));
    expect(result.stdout).toBe("1\n2\n");
    expect(result.returncode).toBe(0);
  });

  it("caps Diff's listing to browse_limit", () => {
    const harness = make({ ...BASE_CFG, browse_limit: 2 });
    listed(harness, "b2", "b1");
    expect(command_of(harness, "diff_archive", { archive: "b2" })).toContain("awk 'NR <= 3'");
  });
});

// ── Diff ─────────────────────────────────────────────────────────────────────

describe("diff", () => {
  it("compares with the previous archive", () => {
    const harness = make();
    listed(harness, "b3", "b2", "b1");
    const command = command_of(harness, "diff_archive", { archive: "b2" }).replaceAll("'", "");
    expect(command).toContain("diff");
    expect(command).toContain("::b1 b2");
  });

  it("runs detached", () => {
    const harness = make();
    listed(harness, "b2", "b1");
    const plan = plan_of(harness, "diff_archive", { archive: "b2" });
    expect(plan.detached).toBe(true);
    expect(plan.timeout).toBeNull();
  });

  it("has nothing to compare for the oldest archive", () => {
    const harness = make();
    listed(harness, "b2", "b1");
    expect(refusal_of(harness, "diff_archive", { archive: "b1" }).success).toBe(false);
  });

  it("shows the changes", () => {
    const harness = make();
    listed(harness, "b2", "b1");
    const out = "added       1.20 kB etc/new\nremoved     0 B etc/old";
    const outcome = outcome_of(harness, "diff_archive", [cmd_result(0, out, "")], { archive: "b2" });
    expect(outcome.content!.startsWith("Changes from b1 to b2: 2")).toBe(true);
    expect(outcome.content).toContain("etc/new");
    expect(outcome.logs).toEqual([["Changes from b1 to b2: 2", "INFO"]]);
  });

  it("reads borg's JSON lines into changes and keeps them for the archive", () => {
    const harness = make();
    listed(harness, "b2", "b1");
    const out = [
      JSON.stringify({ path: "etc/new", changes: [{ type: "added", size: 1200 }] }),
      JSON.stringify({ path: "etc/conf", changes: [{ type: "modified", added: 7, removed: 2 }, { type: "mode", old_mode: "-rw-r--r--", new_mode: "-rw-------" }] }),
      JSON.stringify({ path: "etc", changes: [{ type: "mtime" }] }),
    ].join("\n");
    const outcome = outcome_of(harness, "diff_archive", [cmd_result(0, out, "")], { archive: "b2" });

    expect(outcome.content).toContain("added 1.2 KB etc/new");
    expect(outcome.content).toContain("modified +7 B -2 B [mode] etc/conf");
    expect(harness.repository.diff("b2")!.changes.map((change) => change.kind)).toEqual(["added", "modified", "metadata"]);
    expect(harness.repository.diff("b3")).toBeNull();
  });

  it("still counts the changes without its archive", () => {
    const harness = make();
    listed(harness, "b2", "b1");
    const outcome = harness.repository.read_diff(cmd_result(0, "added       1.20 kB etc/new", ""), null);
    expect(outcome.logs).toEqual([["Changes in the archive: 1", "INFO"]]);
  });
});

describe("parse_diff", () => {
  it("keeps a line that is not JSON as it is", () => {
    const [change] = parse_diff("added       1.20 kB etc/new");
    expect(change).toEqual({ path: "added       1.20 kB etc/new", kind: "other", added_bytes: 0, removed_bytes: 0, details: [] });
    expect(diff_line(change)).toBe("added       1.20 kB etc/new");
  });

  it("names removed folders and changed links", () => {
    const changes = parse_diff([
      JSON.stringify({ path: "old", changes: [{ type: "removed directory" }] }),
      JSON.stringify({ path: "link", changes: [{ type: "changed link" }] }),
    ].join("\n"));
    expect(changes.map((change) => change.kind)).toEqual(["removed", "modified"]);
    expect(changes[1].details).toEqual(["changed link"]);
  });
});

// ── Job preflight ────────────────────────────────────────────────────────────

describe("job preflight", () => {
  it("probes an ssh repo's server banner first", () => {
    const command = command_of(make(BACKUP_CFG), "run_backup");
    expect(command).toContain("/dev/tcp/host/22");
    expect(long_run_of(make(BACKUP_CFG), "run_backup").preflight).toContain("/dev/tcp/host/22");
    expect(long_run_of(make(BACKUP_CFG), "run_backup").command).not.toContain("/dev/tcp");
  });

  it("uses the URL's port", () => {
    expect(command_of(make({ ...BACKUP_CFG, repo: "ssh://borg@far.example:2222/srv/repo" }), "run_backup")).toContain("/dev/tcp/far.example/2222");
  });

  it.each([[{ repo: "/srv/local" }], [{ skip_when_unreachable: false }]])("launches directly with %o", (config) => {
    expect(command_of(make({ ...BACKUP_CFG, ...config }), "run_backup")).not.toContain("/dev/tcp");
  });

  it("tests for a running unit", () => {
    const command = command_of(make({ ...BACKUP_CFG, skip_while_active: ["borg-check.service"] }), "check_repo");
    expect(command).toContain("systemctl is-active --quiet borg-check.service");
  });

  it("records no job for a skipped launch and does not call it a failure", () => {
    const harness = make(BACKUP_CFG);
    const outcome = outcome_of(harness, "run_backup", [cmd_result(0, "__XBACKUPS_SKIP__ host:22 is not answering SSH\n", "")]);
    expect(outcome.success).toBe(true);
    expect(outcome.status).toBeNull();
    expect(harness.runs.running()).toBeNull();
    expect(outcome.content).toBe("Backup skipped: host:22 is not answering SSH");
  });

  it("skips a closed port and never launches", () => {
    const out = sh(with_preflight(preflight_script(["127.0.0.1", 1], []), "echo launched")).stdout;
    expect(out).not.toContain("launched");
    expect(skip_reason(out)).toBe("127.0.0.1:1 is not answering SSH");
  });

  it("launches when the unit is inactive", () => {
    expect(sh(with_preflight(preflight_script(null, ["x-monitor-no-such-unit.service"]), "echo launched")).stdout.trim()).toBe("launched");
  });

  it("never probes a host the shell could misread", () => {
    expect(ssh_endpoint("ssh://borg@$(reboot)/srv")).toBeNull();
  });
});

// ── Backup chain ─────────────────────────────────────────────────────────────

describe("backup chain", () => {
  it("backs up alone by default", () => {
    const command = command_of(make({ ...BACKUP_CFG, keep_daily: 7 }), "run_backup");
    expect(command).not.toContain(" prune ");
    expect(command).not.toContain(" compact ");
  });

  it("prunes, then compacts, after the create", () => {
    const command = unquoted(command_of(make(CHAIN_CFG), "run_backup"));
    expect(command.indexOf("create")).toBeLessThan(command.indexOf("prune --list --stats"));
    expect(command.indexOf("prune --list --stats")).toBeLessThan(command.indexOf("compact --progress"));
    expect(command).toContain("--keep-daily 7");
  });

  it("never prunes on a dry run", () => {
    const command = command_of(make(CHAIN_CFG), "dry_run_backup");
    expect(command).not.toContain(" prune ");
    expect(command).not.toContain(" compact ");
  });

  it("needs a retention policy to prune after a backup", () => {
    expect(() => make({ ...BACKUP_CFG, prune_after_backup: true })).toThrow(/keep_/);
  });

  it.each([[0, true, 0], [1, true, 1], [2, false, 2]])("after exit %i runs steps: %s, exiting %i", (first, ran, status) => {
    const result = sh(then_steps(`(exit ${first})`, [["Pruning", "echo pruned"]]));
    expect(result.stdout.includes("pruned")).toBe(ran);
    expect(result.returncode).toBe(status);
  });

  it("fails the job and stops the rest when a step fails", () => {
    const result = sh(then_steps("true", [["Pruning", "(exit 2)"], ["Compacting", "echo compacted"]]));
    expect(result.returncode).toBe(2);
    expect(result.stdout).not.toContain("compacted");
  });

  it("turns each step into the progress", () => {
    expect(progress_from_lines(["==> Compacting"])).toBe("Compacting");
  });
});

// ── Job wrappers ─────────────────────────────────────────────────────────────

describe("job wrappers", () => {
  it("adds no wrappers by default", () => {
    const command = command_of(make(BACKUP_CFG), "run_backup");
    for (const wrapper of ["nice", "flock", "systemd-inhibit"]) expect(command).not.toContain(wrapper);
  });

  it("wraps the whole job in the lock, then the inhibitor, then the priority", () => {
    const config = { ...CHAIN_CFG, job_lock: "/run/lock/x-monitor-borg", inhibit_sleep: true, job_nice: 19, job_io_idle: true };
    const command = unquoted(command_of(make(config), "run_backup"));
    const order = ["flock /run/lock/x-monitor-borg sh -c", "systemd-inhibit", "--what=sleep:shutdown", "nice -n 19 ionice -c 3 sh -c", "create", "compact --progress"];
    const positions = order.map((part) => command.indexOf(part));
    expect(positions.every((position) => position > -1)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it("never wraps a poll", () => {
    const repository = make({ ...BACKUP_CFG, job_nice: 19, job_lock: "/run/lock/x" }).repository;
    const command = repository.commands().map((call) => call.text).join("\n");
    expect(command).not.toContain("nice");
    expect(command).not.toContain("flock");
  });

  it("runs the job without the inhibitor on a host that has none", () => {
    const bin = scratch_dir();
    symlinkSync(sh("command -v sh").stdout.trim(), join(bin, "sh"));
    const result = sh(wrap_job("echo ran; (exit 3)", ["sh", "-c", INHIBIT_SCRIPT, "why"], null), { PATH: bin });
    expect(result.stdout.trim()).toBe("ran");
    expect(result.returncode).toBe(3);
  });

  it("keeps the wrapped job's exit status", () => {
    if (sh("command -v flock").returncode !== 0) return;
    const lock = join(scratch_dir(), "job.lock");
    const result = sh(wrap_job("echo ran; (exit 3)", ["flock", lock, "nice", "-n", "19"], lock));
    expect(result.stdout.trim()).toBe("ran");
    expect(result.returncode).toBe(3);
  });
});

// ── Check kinds ──────────────────────────────────────────────────────────────

describe("check kinds", () => {
  it.each([
    ["repository", "--repository-only", "check-repository"],
    ["archives", "--archives-only", "check-archives"],
    ["data", "--verify-data", "check-data"],
  ])("runs a %s check with %s as %s", (kind, option, job) => {
    const harness = make();
    expect(command_of(harness, "check_repo", { kind })).toContain(option);
    launch(harness, "check_repo", { kind });
    expect(harness.runs.running()!.kind).toBe(job);
  });

  it("dry runs the newest archive for an extract check", () => {
    const harness = make();
    listed(harness, "b2", "b1");
    const command = unquoted(command_of(harness, "check_repo", { kind: "extract" }));
    expect(command).toContain("extract --dry-run");
    expect(command).toContain("::b2");
  });

  it("needs a listed archive for an extract check", () => {
    expect(refusal_of(make(), "check_repo", { kind: "extract" }).success).toBe(false);
  });

  it("refuses an unknown kind", () => {
    expect(refusal_of(make(), "check_repo", { kind: "everything" }).success).toBe(false);
  });

  it("calls an unknown tracked kind a config error", () => {
    expect(() => make({ ...BASE_CFG, check_kinds: { weekly: "8d" } })).toThrow(/check_kinds/);
  });

  it("renews what a finished check covered", () => {
    const harness = make({ ...TRACKED_CFG, check_kinds: { repository: "8d" } });
    finish_job(harness, "check_repo", 0, { kind: "data" });
    expect(harness.repository.state.checks!.passed).toBe(true);
    harness.repository.commands();
    cycle_with(harness);
    expect(harness.outcomes.latest_status()).toBe("online");
  });

  it("gives a kind never run one max age", () => {
    const harness = make(TRACKED_CFG);
    finish_job(harness, "check_repo", 0, { kind: "repository" });
    harness.repository.commands();
    cycle_with(harness);
    expect(harness.repository.state.checks!.passed).toBe(true);
    expect(harness.outcomes.latest_status()).toBe("online");
  });

  it("fails a kind never run once its max age has passed", () => {
    const harness = make(TRACKED_CFG);
    finish_job(harness, "check_repo", 0, { kind: "repository" });
    harness.repository.commands();
    cycle_with(harness);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 33 * 86400 * 1000);
    finish_job(harness, "check_repo", 0, { kind: "repository" });
    harness.repository.commands();
    cycle_with(harness);
    expect(harness.repository.state.checks!.passed).toBe(false);
    expect(harness.outcomes.latest_status()).toBe("failed");
  });

  it("reads a kind never run as pending", () => {
    const harness = make({ ...TRACKED_CFG, check_kinds: { extract: "32d" } });
    harness.repository.commands();
    cycle_with(harness);
    expect(harness.repository.state.checks!.passed).toBe(true);
    expect(harness.repository.state.checks!.oldest_ok_epoch).toBe(0);
  });

  it("fails after a failed check until one succeeds", () => {
    const harness = make({ ...TRACKED_CFG, check_kinds: { repository: "8d" } });
    finish_job(harness, "check_repo", 2, { kind: "repository" });
    harness.repository.commands();
    cycle_with(harness);
    expect(harness.outcomes.latest_status()).toBe("failed");
    finish_job(harness, "check_repo", 0, { kind: "repository" });
    harness.repository.commands();
    cycle_with(harness);
    expect(harness.outcomes.latest_status()).toBe("online");
  });

  it("judges units and kinds together", () => {
    const harness = make({ ...CHECK_CFG, check_kinds: { extract: "32d" } });
    harness.repository.commands();
    cycle_with(harness, { checks: checks_out({ ok: now() - 3600 }) });
    finish_job(harness, "check_repo", 2, { kind: "extract" });
    harness.repository.commands();
    cycle_with(harness, { checks: checks_out({ ok: now() - 3600 }) });
    expect(harness.outcomes.latest_status()).toBe("failed");
    finish_job(harness, "check_repo", 0, { kind: "extract" });
    harness.repository.commands();
    cycle_with(harness, { checks: checks_out({ ok: now() - 3600 }) });
    expect(harness.outcomes.latest_status()).toBe("online");
  });
});

// ── Borg 2 ───────────────────────────────────────────────────────────────────

describe("borg 2", () => {
  const BORG2_CFG: BorgConfig = { ...FULL_CFG, borg_version: 2, repo: "ssh://borg@host//srv/repo", keep_within: "6H" };

  it("runs borg2 with legacy exit codes unless borg_bin says otherwise", () => {
    const command = make(BORG2_CFG).repository.list_command();
    expect(command).toContain("BORG_EXIT_CODES=legacy ");
    expect(command).toContain(" borg2 repo-list ");
    expect(make({ ...BORG2_CFG, borg_bin: "/opt/borg" }).repository.list_command()).toContain(" /opt/borg repo-list");
    expect(make().repository.list_command()).not.toContain("BORG_EXIT_CODES");
  });

  it("names the repository with -r and an archive by its bare name", () => {
    const repository = make(BORG2_CFG).repository;
    expect(repository.list_command()).toContain("borg2 repo-list --last 10 --json --lock-wait 30 -r ssh://borg@host//srv/repo");
    expect(repository.info_command()).toContain("borg2 info --json --last 10 --lock-wait 30 -r ssh://borg@host//srv/repo");
    expect(repository.backup_command({ archive_name: "a1" })).toContain("--lock-wait 600 -r ssh://borg@host//srv/repo a1 /home");
    expect(repository.canary_calls("a1")[0][1]).toContain("-r ssh://borg@host//srv/repo a1 home/canary");
    expect(repository.backup_command()).not.toContain("::");
  });

  it("prunes every matching archive as one group, with --keep for keep_within", () => {
    const harness = make(BORG2_CFG);
    const preview = command_of(harness, "prune_preview");
    expect(preview).toContain("--group-by none -a 'sh:test-borg-*' --keep 6H --keep-daily 7 -r");
    expect(unquoted(command_of(harness, "prune_repo"))).toContain("prune --list --group-by none -a sh:test-borg-* --keep 6H");
    expect(plan_of(harness, "prune_preview").read([cmd_result(0, PRUNE_OUTPUT, "")]).content).toContain("Policy: --keep 6H --keep-daily 7");
  });

  it("refuses keep_within beside keep_last", () => {
    expect(() => make({ ...BORG2_CFG, keep_last: 3 })).toThrow("set only one");
    expect(make({ ...FULL_CFG, keep_within: "6H", keep_last: 3 }).repository.borg_version).toBe(1);
  });

  it("refuses a version other than 1 or 2", () => {
    expect(() => make({ ...BASE_CFG, borg_version: 3 })).toThrow("borg_version must be 1 or 2");
  });

  it("deletes, diffs and checks by archive name after -r", () => {
    const harness = make(BORG2_CFG);
    listed(harness, "b2", "b1");
    expect(unquoted(command_of(harness, "delete_archive", { archive: "b1" }))).toContain("delete --list -r ssh://borg@host//srv/repo b1");
    expect(command_of(harness, "diff_archive", { archive: "b2" })).toContain("-r ssh://borg@host//srv/repo b1 b2");
    expect(unquoted(command_of(harness, "check_repo", { kind: "extract" }))).toContain("extract --dry-run --progress -r ssh://borg@host//srv/repo b2");
    expect(unquoted(command_of(harness, "compact_repo"))).toContain("compact --progress -r ssh://borg@host//srv/repo");
  });

  it("downloads from an archive named after -r", () => {
    const harness = make(BORG2_CFG);
    listed(harness, "b1");
    const plan = harness.repository.download("b1", ["etc"], "tar") as DownloadPlan;
    expect(plan.command).toContain("export-tar --tar-filter=gzip --lock-wait 30 -r ssh://borg@host//srv/repo b1 - etc");
  });

  it("purges with borg 2's match patterns and previews its - flag", () => {
    const harness = make({ ...BORG2_CFG, purge_match: "Odin-*" });
    const purge = unquoted(command_of(harness, "purge_excluded"));
    expect(purge).toContain("delete -a sh:*.recreate -r");
    expect(purge).toContain("recreate --info --stats --progress -a sh:Odin-*");
    const preview = command_of(harness, "purge_preview");
    expect(preview).toContain("--filter=-");
    expect(preview).toContain("awk -v flag=");
  });

  it("keeps the top-most excluded path from borg 2's preview", () => {
    const input = "Processing Odin-1 abc\n- home/.cache\n- home/.cache/x\n+ etc\n__x_backups_rc=0\n";
    const result = spawnSync("sh", ["-c", topmost_excluded("-")], { input, encoding: "utf8" });
    expect(result.stdout).toBe("Processing Odin-1 abc\n- home/.cache\n+ etc\n");
    expect(result.status).toBe(0);
  });

  it("reads archive sizes without warning about the missing repository stats", () => {
    const harness = make({ ...BASE_CFG, borg_version: 2 });
    const list = JSON.stringify({
      repository: { location: "/srv/repo" }, encryption: { encryption: "aes256-ocb" },
      archives: [{ name: "a1", time: iso(now() - 60) }],
    });
    const info = JSON.stringify({ archives: [{ name: "a1", stats: { original_size: 5054, nfiles: 4 } }] });
    const result = collect(harness, cmd_result(0, list, ""), cmd_result(0, info, ""));
    expect(result.status).toBe("online");
    expect(messages(result)).toContain("encryption=aes256-ocb");
    expect(messages(result)).not.toContain("Could not parse borg info output");
    expect(harness.repository.state.archives[0]).toMatchObject({ name: "a1", original: 5054, nfiles: 4 });
    expect(harness.repository.state.stats).toBeNull();
  });

  it("reads an added or removed file's size from borg 2's diff", () => {
    const changes = parse_diff([
      JSON.stringify({ path: "etc/new", changes: [{ added: 44, removed: 0, type: "added" }] }),
      JSON.stringify({ path: "etc/old", changes: [{ added: 0, removed: 12, type: "removed" }] }),
    ].join("\n"));
    expect(changes.map((change) => [change.kind, change.added_bytes, change.removed_bytes])).toEqual([["added", 44, 0], ["removed", 0, 12]]);
  });
});
