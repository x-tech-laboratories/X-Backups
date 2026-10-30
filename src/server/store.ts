// Keeps each target's state, its poll history, archives, events and runs in one SQLite file under X_BACKUPS_STATE_DIR,
// each row beside the host, job and repository its target is built from, and the page's overrides of declared tasks.

// ── Imports ──────────────────────────────────────────────────────────────────

import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import type { HealthSample } from "../shared/agent_protocol.ts";
import { distinct_grants, grants_from_repository } from "./access.ts";
import type { Timer } from "./timers.ts";
import { own_host_name } from "./config.ts";
import type { CollectResult, LogLevel, MonitorStatus, RepositoryState, RunRecord, RunState, RunStore } from "./borg/types.ts";

// ── Rows ─────────────────────────────────────────────────────────────────────

// A target with the entities it is built from; a repository only watched has no job.
export interface TargetKey {
  target_id: string;
  host: string;
  job: string | null;
  repository: string;
}

// The entity names a row keeps beside its target, null on an older row of a target no longer configured.
export interface TargetColumns {
  target_id: string;
  host: string | null;
  job: string | null;
  repository: string | null;
}

// A host as the store needs it, to move rows kept under its address to its name.
export interface HostKey {
  name: string;
  kind: string;
  address: string | null;
}

export interface PollRow {
  epoch: number;
  status: MonitorStatus | null;
  original_size: number | null;
  compressed_size: number | null;
  deduplicated_size: number | null;
  total_chunks: number | null;
  unique_chunks: number | null;
  archive_count: number | null;
  last_backup_epoch: number | null;
  canary_ok: boolean | null;
  checks_passed: boolean | null;
}

export interface ArchiveRow {
  name: string;
  epoch: number;
  original_size: number | null;
  compressed_size: number | null;
  deduplicated_size: number | null;
  file_count: number | null;
}

export interface EventRow extends TargetColumns {
  id: number;
  epoch: number;
  level: LogLevel;
  message: string;
}

export interface TimerRow extends Timer {
  host: string;
  read_epoch: number;
}

// One run of a timer as a read saw it, or one it should have made and did not, with a result of "missed".
export interface TimerRunRow {
  host: string;
  unit: string;
  epoch: number;
  result: string | null;
  exit_status: number | null;
}

export interface HostSampleRow extends HealthSample {
  host: string;
  epoch: number;
}

// Why a run left going over SSH, before agents, was ended when the database was opened.
const ssh_run_lost = "Lost: it was started over SSH, which X-Backups no longer uses, so its outcome is unknown.";

// A host's readings are kept for a week, the longest span its charts draw.
const host_sample_retention_in_seconds = 7 * 86400;

// A timer run is kept this long, enough for several weeks of the calendar.
const timer_run_retention_in_seconds = 90 * 86400;

// How far before its listed elapse a timer may trigger and still count as that run, for systemd's AccuracySec.
const timer_trigger_slack_in_seconds = 60;

export interface RunRow extends RunRecord, TargetColumns {
  // The id of the task the run belongs to, such as "job:web:backup", or null for an action started by hand.
  task: string | null;
  started_epoch: number;
  ended_epoch: number | null;
}

// What changed, so a page that listens can fetch only what it shows.
export interface Change {
  kind: "repository" | "run" | "timers" | "hosts" | "config" | "tasks";
  target_id: string | null;
  run_id?: number;
}

// The targets whose rows a viewer sees, and the repositories whose own runs, compact and check, they see too.
export interface VisibleRows {
  targets: string[];
  repositories: string[];
}

export interface RunFilter {
  target_id?: string;
  host?: string;
  job?: string;
  repository?: string;
  // What a viewer sees, when they do not see everything.
  visible?: VisibleRows;
  // A kind matches itself and its variants, so "check" also matches "check-data".
  kind?: string;
  state?: string;
  since_epoch?: number;
  limit?: number;
  offset?: number;
}

// A task switched on or off from the page, over what its config says.
export interface TaskOverride {
  task_id: string;
  enabled: boolean;
  changed_by: string;
  changed_epoch: number;
}

export interface EventFilter {
  target_id?: string;
  host?: string;
  job?: string;
  repository?: string;
  visible?: VisibleRows;
  level?: string;
  limit?: number;
  offset?: number;
}

// ── Schema ───────────────────────────────────────────────────────────────────

// The tables keyed by target, each with the entity names beside.
const target_tables = ["repository_states", "polls", "archives", "events", "runs"] as const;

// The tables keyed by a host's name.
const host_tables = ["timers", "timer_runs", "timer_upcoming", "host_samples"] as const;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS repository_states (
    target_id TEXT PRIMARY KEY,
    host TEXT,
    job TEXT,
    repository TEXT,
    state TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS polls (
    target_id TEXT NOT NULL,
    host TEXT,
    job TEXT,
    repository TEXT,
    epoch INTEGER NOT NULL,
    status TEXT,
    original_size INTEGER,
    compressed_size INTEGER,
    deduplicated_size INTEGER,
    total_chunks INTEGER,
    unique_chunks INTEGER,
    archive_count INTEGER,
    last_backup_epoch INTEGER,
    canary_ok INTEGER,
    checks_passed INTEGER,
    PRIMARY KEY (target_id, epoch)
  );
  CREATE TABLE IF NOT EXISTS archives (
    target_id TEXT NOT NULL,
    host TEXT,
    job TEXT,
    repository TEXT,
    name TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    original_size INTEGER,
    compressed_size INTEGER,
    deduplicated_size INTEGER,
    file_count INTEGER,
    PRIMARY KEY (target_id, name)
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    target_id TEXT NOT NULL,
    host TEXT,
    job TEXT,
    repository TEXT,
    epoch INTEGER NOT NULL,
    level TEXT NOT NULL,
    message TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY,
    target_id TEXT NOT NULL,
    host TEXT,
    job TEXT,
    repository TEXT,
    task TEXT,
    kind TEXT NOT NULL,
    command TEXT NOT NULL,
    agent_run TEXT,
    state TEXT NOT NULL,
    progress TEXT,
    output_seq INTEGER NOT NULL DEFAULT 0,
    exit_code INTEGER,
    error TEXT,
    started_epoch INTEGER NOT NULL,
    ended_epoch INTEGER
  );
  CREATE TABLE IF NOT EXISTS run_output (
    run_id INTEGER NOT NULL,
    line_number INTEGER NOT NULL,
    line TEXT NOT NULL,
    PRIMARY KEY (run_id, line_number)
  );
  CREATE TABLE IF NOT EXISTS timers (
    host TEXT NOT NULL,
    unit TEXT NOT NULL,
    service TEXT NOT NULL,
    next_epoch INTEGER,
    last_epoch INTEGER,
    result TEXT,
    exit_status INTEGER,
    read_epoch INTEGER NOT NULL,
    PRIMARY KEY (host, unit)
  );
  CREATE TABLE IF NOT EXISTS timer_runs (
    host TEXT NOT NULL,
    unit TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    result TEXT,
    exit_status INTEGER,
    PRIMARY KEY (host, unit, epoch)
  );
  CREATE TABLE IF NOT EXISTS host_samples (
    host TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    load1 REAL NOT NULL,
    cpus INTEGER NOT NULL,
    memory_total INTEGER NOT NULL,
    memory_available INTEGER NOT NULL,
    disk_size INTEGER NOT NULL,
    disk_available INTEGER NOT NULL,
    PRIMARY KEY (host, epoch)
  );
  CREATE TABLE IF NOT EXISTS timer_upcoming (
    host TEXT NOT NULL,
    unit TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    PRIMARY KEY (host, unit, epoch)
  );
  CREATE INDEX IF NOT EXISTS events_by_target ON events (target_id, id);
  CREATE INDEX IF NOT EXISTS runs_by_target ON runs (target_id, id);
  CREATE TABLE IF NOT EXISTS users (
    name TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    jobs TEXT,
    password_hash TEXT,
    totp_secret TEXT,
    totp_pending TEXT,
    totp_last_step INTEGER,
    recovery_codes TEXT,
    created_epoch INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tokens (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL,
    created_epoch INTEGER NOT NULL,
    last_used_epoch INTEGER
  );
  CREATE TABLE IF NOT EXISTS task_overrides (
    task_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL,
    changed_by TEXT NOT NULL,
    changed_epoch INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agent_tokens (
    host TEXT PRIMARY KEY,
    hash TEXT NOT NULL UNIQUE,
    created_epoch INTEGER NOT NULL,
    last_seen_epoch INTEGER
  );
`;

// ── Store ────────────────────────────────────────────────────────────────────

export class Store {
  private readonly database: DatabaseSync;
  // Emits a "change" with a Change after each write a page might show.
  readonly changes = new EventEmitter();
  // The configured targets by id, whose entity names each new row takes.
  private readonly targets = new Map<string, TargetKey>();

  // A path of ":memory:" keeps everything in memory, for tests.
  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.migrate();
    this.database.exec(SCHEMA);
    // Every open page listens, so more listeners than Node's default is normal rather than a leak.
    this.changes.setMaxListeners(0);
  }

  changed(change: Change): void {
    this.changes.emit("change", change);
  }

  // Opens the database in the folder X_BACKUPS_STATE_DIR names, creating the folder if needed.
  static open_from_environment(): Store {
    const directory = process.env.X_BACKUPS_STATE_DIR ?? "state";
    mkdirSync(directory, { recursive: true });
    return new Store(join(directory, "x-backups.sqlite"));
  }

  close(): void {
    this.database.close();
  }

  // ── Targets ──────────────────────────────────────────────────────────────

  // Brings a database from before targets and runs to today's tables, keeping every row; running it again changes nothing.
  private migrate(): void {
    const tables = new Set(this.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => String(row.name)));
    if (tables.has("jobs") && !tables.has("runs")) this.database.exec("ALTER TABLE jobs RENAME TO runs");
    if (tables.has("job_output") && !tables.has("run_output")) this.database.exec("ALTER TABLE job_output RENAME TO run_output");
    if (this.columns("run_output").has("job_id")) this.database.exec("ALTER TABLE run_output RENAME COLUMN job_id TO run_id");
    this.database.exec("DROP INDEX IF EXISTS events_by_repository");
    this.database.exec("DROP INDEX IF EXISTS jobs_by_repository");
    for (const table of target_tables) {
      const columns = this.columns(table);
      // A table not made yet is made whole by the schema.
      if (columns.size === 0) continue;
      if (columns.has("repository_id")) this.database.exec(`ALTER TABLE ${table} RENAME COLUMN repository_id TO target_id`);
      for (const column of ["host", "job", "repository", ...(table === "runs" ? ["task", "agent_run"] : [])]) {
        if (!columns.has(column)) this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
      }
    }
    // A run started over SSH has no agent to follow it, so one still going is ended as lost.
    const run_columns = this.columns("runs");
    if (run_columns.has("workdir")) {
      this.run(
        "UPDATE runs SET state = 'failed', exit_code = -1, error = ?, ended_epoch = ? WHERE state = 'running' AND agent_run IS NULL",
        ssh_run_lost, now_seconds(),
      );
      for (const column of ["workdir", "pid"]) {
        if (run_columns.has(column)) this.database.exec(`ALTER TABLE runs DROP COLUMN ${column}`);
      }
    }
  }

  private columns(table: string): Set<string> {
    return new Set(this.all(`PRAGMA table_info(${table})`).map((row) => String(row.name)));
  }

  // Takes the configured targets and hosts: new rows take each target's entity names, rows kept before they had any
  // are given them, and a host's timers and readings kept under its address move to its name.
  adopt_targets(targets: TargetKey[], hosts: HostKey[] = []): void {
    this.transaction(() => {
      for (const target of targets) {
        this.targets.set(target.target_id, target);
        for (const table of target_tables) {
          this.run(
            `UPDATE ${table} SET host = ?, job = ?, repository = ? WHERE target_id = ? AND repository IS NULL`,
            target.host, target.job, target.repository, target.target_id,
          );
        }
      }
      for (const host of hosts) {
        // Rows were kept under the address commands reached, or "local" for this machine.
        const old_key = host.address ?? own_host_name;
        if (host.kind !== "managed" || old_key === host.name || hosts.some((other) => other.name === old_key)) continue;
        for (const table of host_tables) {
          this.run(`UPDATE OR IGNORE ${table} SET host = ? WHERE host = ?`, host.name, old_key);
          this.run(`DELETE FROM ${table} WHERE host = ?`, old_key);
        }
      }
      this.adopt_grants(targets);
    });
  }

  // Turns each user's older grants on repositories into grants on the jobs writing there, read against the configured
  // targets, then drops the column they were kept in; a repository no job writes to stays granted as itself.
  private adopt_grants(targets: TargetKey[]): void {
    const columns = this.columns("users");
    if (!columns.has("repositories")) return;
    if (!columns.has("jobs")) this.database.exec("ALTER TABLE users ADD COLUMN jobs TEXT");
    for (const row of this.all("SELECT name, repositories FROM users WHERE repositories IS NOT NULL")) {
      const names = JSON.parse(String(row.repositories)) as string[];
      const grants = distinct_grants(names.flatMap((name) => grants_from_repository(name, targets)));
      this.run("UPDATE users SET jobs = ? WHERE name = ?", JSON.stringify(grants), String(row.name));
    }
    this.database.exec("ALTER TABLE users DROP COLUMN repositories");
  }

  // The entity names a new row of the target takes.
  names(target_id: string): [host: string | null, job: string | null, repository: string | null] {
    const target = this.targets.get(target_id);
    return target === undefined ? [null, null, null] : [target.host, target.job, target.repository];
  }

  // ── Target state ─────────────────────────────────────────────────────────

  load_state(target_id: string): RepositoryState | null {
    const row = this.get("SELECT state FROM repository_states WHERE target_id = ?", target_id);
    return row ? JSON.parse(String(row.state)) as RepositoryState : null;
  }

  // Keeps what a poll or action reports: its new state, its events, and for a poll one history row.
  apply(target_id: string, result: CollectResult, options: { poll: boolean; epoch?: number }): void {
    const epoch = options.epoch ?? now_seconds();
    this.transaction(() => {
      if (result.state !== null) this.save_state(target_id, result.state);
      if (options.poll && result.state !== null) this.add_poll(target_id, epoch, result.state, result.status);
      // A repository poll's routine lines would bury everything else, so only its warnings and errors are kept.
      const routine = options.poll && result.status !== null;
      for (const [message, level] of result.logs) {
        if (routine && level === "INFO") continue;
        this.run(
          "INSERT INTO events (target_id, host, job, repository, epoch, level, message) VALUES (?, ?, ?, ?, ?, ?, ?)",
          target_id, ...this.names(target_id), epoch, level, message,
        );
      }
    });
    this.changed({ kind: "repository", target_id });
  }

  private save_state(target_id: string, state: RepositoryState): void {
    this.run(
      `INSERT INTO repository_states (target_id, host, job, repository, state) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (target_id) DO UPDATE SET state = excluded.state`,
      target_id, ...this.names(target_id), JSON.stringify(state),
    );
    for (const archive of state.archives) {
      this.run(
        `INSERT INTO archives (target_id, host, job, repository, name, epoch, original_size, compressed_size, deduplicated_size, file_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (target_id, name) DO UPDATE SET
           original_size = coalesce(excluded.original_size, original_size),
           compressed_size = coalesce(excluded.compressed_size, compressed_size),
           deduplicated_size = coalesce(excluded.deduplicated_size, deduplicated_size),
           file_count = coalesce(excluded.file_count, file_count)`,
        target_id, ...this.names(target_id), archive.name, archive.epoch, archive.original ?? null, archive.compressed ?? null,
        archive.deduplicated ?? null, archive.nfiles ?? null,
      );
    }
  }

  // Only a poll of the repository itself adds a row; a poll that only followed a run leaves the state alone.
  private add_poll(target_id: string, epoch: number, state: RepositoryState, status: MonitorStatus | null): void {
    const stats = state.stats;
    this.run(
      `INSERT OR REPLACE INTO polls (target_id, host, job, repository, epoch, status, original_size, compressed_size, deduplicated_size,
         total_chunks, unique_chunks, archive_count, last_backup_epoch, canary_ok, checks_passed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      target_id, ...this.names(target_id), epoch, status, stats?.original_size ?? null, stats?.compressed_size ?? null,
      stats?.deduplicated_size ?? null, stats?.total_chunks ?? null, stats?.unique_chunks ?? null,
      state.archive_count, state.last_backup_epoch, flag(state.canary?.ok), flag(state.checks?.passed),
    );
  }

  // ── History ──────────────────────────────────────────────────────────────

  polls(target_id: string, since_epoch = 0): PollRow[] {
    return this.all("SELECT * FROM polls WHERE target_id = ? AND epoch >= ? ORDER BY epoch", target_id, since_epoch)
      .map((row) => ({
        epoch: Number(row.epoch),
        status: row.status as MonitorStatus | null,
        original_size: number_or_null(row.original_size),
        compressed_size: number_or_null(row.compressed_size),
        deduplicated_size: number_or_null(row.deduplicated_size),
        total_chunks: number_or_null(row.total_chunks),
        unique_chunks: number_or_null(row.unique_chunks),
        archive_count: number_or_null(row.archive_count),
        last_backup_epoch: number_or_null(row.last_backup_epoch),
        canary_ok: row.canary_ok === null ? null : row.canary_ok === 1,
        checks_passed: row.checks_passed === null ? null : row.checks_passed === 1,
      }));
  }

  // Every archive ever listed, newest first.
  archives(target_id: string): ArchiveRow[] {
    return this.all("SELECT * FROM archives WHERE target_id = ? ORDER BY epoch DESC", target_id).map((row) => ({
      name: String(row.name),
      epoch: Number(row.epoch),
      original_size: number_or_null(row.original_size),
      compressed_size: number_or_null(row.compressed_size),
      deduplicated_size: number_or_null(row.deduplicated_size),
      file_count: number_or_null(row.file_count),
    }));
  }

  // The newest events first, for one target, host, job or repository or all of them, at one level or all.
  events(options: EventFilter = {}): EventRow[] {
    const [where, values] = conditions([
      ...target_conditions(options),
      [in_list("target_id", options.visible?.targets), options.visible?.targets],
      ["level = ?", options.level],
    ]);
    const sql = `SELECT * FROM events ${where} ORDER BY id DESC LIMIT ? OFFSET ?`;
    return this.all(sql, ...values, options.limit ?? 100, options.offset ?? 0).map((row) => ({
      id: Number(row.id),
      ...target_columns(row),
      epoch: Number(row.epoch),
      level: row.level as LogLevel,
      message: String(row.message),
    }));
  }

  // ── Timers ───────────────────────────────────────────────────────────────

  // Replaces what is known of a host's timers with a fresh read, keeping each run it reports and each one it skipped.
  replace_timers(host: string, timers: Timer[], epoch = now_seconds()): void {
    this.transaction(() => {
      const before = new Map(this.timers().filter((timer) => timer.host === host).map((timer) => [timer.unit, timer]));
      this.run("DELETE FROM timers WHERE host = ?", host);
      this.run("DELETE FROM timer_upcoming WHERE host = ?", host);
      this.run("DELETE FROM timer_runs WHERE host = ? AND epoch < ?", host, epoch - timer_run_retention_in_seconds);
      for (const timer of timers) {
        this.run(
          "INSERT INTO timers (host, unit, service, next_epoch, last_epoch, result, exit_status, read_epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          host, timer.unit, timer.service, timer.next_epoch, timer.last_epoch, timer.result, timer.exit_status, epoch,
        );
        // A later read of the same run may carry its final result, so it replaces the earlier one.
        if (timer.last_epoch !== null) {
          this.run(
            "INSERT INTO timer_runs (host, unit, epoch, result, exit_status) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET result = excluded.result, exit_status = excluded.exit_status",
            host, timer.unit, timer.last_epoch, timer.result, timer.exit_status,
          );
        }
        // systemd moved on from the elapse the last read expected, and no run started at or after it.
        const expected = before.get(timer.unit)?.next_epoch ?? null;
        const moved_on = expected !== null && expected < epoch && timer.next_epoch !== expected;
        if (moved_on && (timer.last_epoch ?? 0) < expected - timer_trigger_slack_in_seconds) {
          this.run("INSERT OR IGNORE INTO timer_runs (host, unit, epoch, result) VALUES (?, ?, ?, 'missed')", host, timer.unit, expected);
        }
        for (const elapse of timer.upcoming) this.run("INSERT OR IGNORE INTO timer_upcoming (host, unit, epoch) VALUES (?, ?, ?)", host, timer.unit, elapse);
      }
    });
    this.changed({ kind: "timers", target_id: null });
  }

  // ── Hosts ────────────────────────────────────────────────────────────────

  // Keeps one reading of a host's load, memory and root disk, dropping its readings past retention.
  add_host_sample(host: string, sample: HealthSample, epoch = now_seconds()): void {
    this.transaction(() => {
      this.run("DELETE FROM host_samples WHERE host = ? AND epoch < ?", host, epoch - host_sample_retention_in_seconds);
      this.run(
        "INSERT OR REPLACE INTO host_samples (host, epoch, load1, cpus, memory_total, memory_available, disk_size, disk_available) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        host, epoch, sample.load1, sample.cpus, sample.memory_total, sample.memory_available, sample.disk_size, sample.disk_available,
      );
    });
    this.changed({ kind: "hosts", target_id: null });
  }

  // Every host's readings from `since` on, oldest first.
  // Each host's newest reading.
  latest_host_samples(): HostSampleRow[] {
    return this.all(
      "SELECT * FROM host_samples WHERE (host, epoch) IN (SELECT host, max(epoch) FROM host_samples GROUP BY host) ORDER BY host",
    ).map(host_sample_row);
  }

  host_samples(since: number): HostSampleRow[] {
    return this.all("SELECT * FROM host_samples WHERE epoch >= ? ORDER BY host, epoch", since).map(host_sample_row);
  }

  // Every timer run from `since` on, oldest first, with the missed ones marked by a result of "missed".
  timer_runs(since: number): TimerRunRow[] {
    return this.all("SELECT * FROM timer_runs WHERE epoch >= ? ORDER BY epoch", since).map((row) => ({
      host: String(row.host),
      unit: String(row.unit),
      epoch: Number(row.epoch),
      result: row.result === null ? null : String(row.result),
      exit_status: number_or_null(row.exit_status),
    }));
  }

  timers(): TimerRow[] {
    const upcoming = new Map<string, number[]>();
    for (const row of this.all("SELECT * FROM timer_upcoming ORDER BY epoch")) {
      const key = `${row.host}\n${row.unit}`;
      upcoming.set(key, [...(upcoming.get(key) ?? []), Number(row.epoch)]);
    }
    return this.all("SELECT * FROM timers ORDER BY host, unit").map((row) => ({
      host: String(row.host),
      unit: String(row.unit),
      service: String(row.service),
      next_epoch: number_or_null(row.next_epoch),
      last_epoch: number_or_null(row.last_epoch),
      result: row.result === null ? null : String(row.result),
      exit_status: number_or_null(row.exit_status),
      upcoming: upcoming.get(`${row.host}\n${row.unit}`) ?? [],
      read_epoch: Number(row.read_epoch),
    }));
  }

  // ── Runs ─────────────────────────────────────────────────────────────────

  runs_for(target: TargetKey): RunStore {
    this.targets.set(target.target_id, target);
    return new TargetRuns(this, target.target_id);
  }

  run_row(run_id: number): RunRow | null {
    const row = this.get("SELECT * FROM runs WHERE id = ?", run_id);
    return row ? run_row(row) : null;
  }

  // The newest runs first, narrowed by whatever the filter names.
  runs(options: RunFilter = {}): RunRow[] {
    const visible = options.visible;
    const [where, values] = conditions([
      ...target_conditions(options),
      [
        `(${in_list("target_id", visible?.targets)} OR (${in_list("repository", visible?.repositories)} AND ${repository_run_sql}))`,
        visible === undefined ? undefined : [...visible.targets, ...visible.repositories],
      ],
      ["(kind = ? OR kind LIKE ? || '-%')", options.kind === undefined ? undefined : [options.kind, options.kind]],
      ["state = ?", options.state],
      ["started_epoch >= ?", options.since_epoch],
    ]);
    const sql = `SELECT * FROM runs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`;
    return this.all(sql, ...values, options.limit ?? 100, options.offset ?? 0).map(run_row);
  }

  // The target's newest run of the task, or of an action of one of the kinds started by hand, which counts the same.
  last_task_run(target_id: string, task_id: string, kinds: string[]): RunRow | null {
    const row = this.get(
      `SELECT * FROM runs WHERE target_id = ? AND (task = ? OR (task IS NULL AND ${in_list("kind", kinds)})) ORDER BY id DESC LIMIT 1`,
      target_id, task_id, ...kinds,
    );
    return row ? run_row(row) : null;
  }

  // When the newest run of one of the kinds on any of the targets ended, having succeeded or ended with only warnings.
  last_success_epoch(target_ids: string[], kinds: string[]): number | null {
    const row = this.get(
      `SELECT max(ended_epoch) AS epoch FROM runs WHERE state IN ('succeeded', 'warning') AND ${in_list("target_id", target_ids)} AND ${in_list("kind", kinds)}`,
      ...target_ids, ...kinds,
    );
    return number_or_null(row?.epoch);
  }

  // The run's output lines after the first skipped ones, so a page can fetch only what is new.
  run_output(run_id: number, skip = 0): string[] {
    return this.all("SELECT line FROM run_output WHERE run_id = ? AND line_number >= ? ORDER BY line_number", run_id, skip)
      .map((row) => String(row.line));
  }

  // ── Task overrides ───────────────────────────────────────────────────────

  task_overrides(): Map<string, TaskOverride> {
    return new Map(this.all("SELECT * FROM task_overrides").map((row) => [String(row.task_id), {
      task_id: String(row.task_id), enabled: row.enabled === 1, changed_by: String(row.changed_by), changed_epoch: Number(row.changed_epoch),
    }]));
  }

  // Switches the task on or off over its config, or with null goes back to what the config says.
  set_task_override(task_id: string, enabled: boolean | null, changed_by: string): void {
    if (enabled === null) this.run("DELETE FROM task_overrides WHERE task_id = ?", task_id);
    else this.run("INSERT OR REPLACE INTO task_overrides (task_id, enabled, changed_by, changed_epoch) VALUES (?, ?, ?, ?)", task_id, Number(enabled), changed_by, now_seconds());
    this.changed({ kind: "tasks", target_id: null });
  }

  // ── SQL helpers ──────────────────────────────────────────────────────────

  run(sql: string, ...values: SQLInputValue[]): number {
    return Number(this.database.prepare(sql).run(...values).lastInsertRowid);
  }

  get(sql: string, ...values: SQLInputValue[]): Record<string, unknown> | undefined {
    return this.database.prepare(sql).get(...values) as Record<string, unknown> | undefined;
  }

  all(sql: string, ...values: SQLInputValue[]): Record<string, unknown>[] {
    return this.database.prepare(sql).all(...values) as Record<string, unknown>[];
  }

  transaction(work: () => void): void {
    this.database.exec("BEGIN");
    try {
      work();
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

// ── One target's runs ────────────────────────────────────────────────────────

class TargetRuns implements RunStore {
  private readonly store: Store;
  private readonly target_id: string;

  constructor(store: Store, target_id: string) {
    this.store = store;
    this.target_id = target_id;
  }

  running(): RunRecord | null {
    const row = this.store.get("SELECT * FROM runs WHERE target_id = ? AND state = 'running' ORDER BY id DESC LIMIT 1", this.target_id);
    return row ? run_row(row) : null;
  }

  // A detached action's run is kept under the action's own id as its kind.
  action_run(action_id: string): RunRecord | null {
    const row = this.store.get(
      "SELECT * FROM runs WHERE target_id = ? AND kind = ? AND state = 'running' ORDER BY id DESC LIMIT 1",
      this.target_id, action_id,
    );
    return row ? run_row(row) : null;
  }

  // Its agent run id carries its start time as well as its id, so a database started over never reuses one an agent
  // still holds.
  create(kind: string, command: string, task: string | null = null): number {
    const started_epoch = now_seconds();
    let run_id = 0;
    this.store.transaction(() => {
      run_id = this.store.run(
        `INSERT INTO runs (target_id, host, job, repository, task, kind, command, state, started_epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
        this.target_id, ...this.store.names(this.target_id), task, kind, command, started_epoch,
      );
      this.store.run("UPDATE runs SET agent_run = ? WHERE id = ?", `run-${run_id}-${started_epoch}`, run_id);
    });
    this.changed(run_id);
    return run_id;
  }

  set_progress(run_id: number, summary: string | null): void {
    this.store.run("UPDATE runs SET progress = ? WHERE id = ?", summary, run_id);
    this.changed(run_id);
  }

  append_output(run_id: number, lines: string[]): void {
    this.store.transaction(() => {
      const row = this.store.get("SELECT count(*) AS count FROM run_output WHERE run_id = ?", run_id);
      let line_number = Number(row?.count ?? 0);
      for (const line of lines) {
        this.store.run("INSERT INTO run_output (run_id, line_number, line) VALUES (?, ?, ?)", run_id, line_number++, line);
      }
    });
    this.changed(run_id);
  }

  bump_output_seq(run_id: number, new_seq: number): void {
    this.store.run("UPDATE runs SET output_seq = ? WHERE id = ?", new_seq, run_id);
  }

  finish(run_id: number, state: RunState, details: { exit_code?: number | null; error?: string | null }): void {
    this.store.run(
      "UPDATE runs SET state = ?, exit_code = ?, error = ?, ended_epoch = ? WHERE id = ?",
      state, details.exit_code ?? null, details.error ?? null, now_seconds(), run_id,
    );
    this.changed(run_id);
  }

  private changed(run_id: number): void {
    this.store.changed({ kind: "run", target_id: this.target_id, run_id });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function run_row(row: Record<string, unknown>): RunRow {
  return {
    id: Number(row.id),
    ...target_columns(row),
    task: string_or_null(row.task),
    kind: String(row.kind),
    command: String(row.command),
    agent_run: string_or_null(row.agent_run),
    state: row.state as RunState,
    progress: row.progress === null ? null : String(row.progress),
    output_seq: Number(row.output_seq),
    exit_code: number_or_null(row.exit_code),
    error: row.error === null ? null : String(row.error),
    started_epoch: Number(row.started_epoch),
    ended_epoch: number_or_null(row.ended_epoch),
  };
}

function host_sample_row(row: Record<string, unknown>): HostSampleRow {
  return {
    host: String(row.host),
    epoch: Number(row.epoch),
    load1: Number(row.load1),
    cpus: Number(row.cpus),
    memory_total: Number(row.memory_total),
    memory_available: Number(row.memory_available),
    disk_size: Number(row.disk_size),
    disk_available: Number(row.disk_available),
  };
}

function target_columns(row: Record<string, unknown>): TargetColumns {
  return { target_id: String(row.target_id), host: string_or_null(row.host), job: string_or_null(row.job), repository: string_or_null(row.repository) };
}

// The run kinds access.ts's repository_run counts as the repository's own.
const repository_run_sql = "(kind = 'compact' OR kind = 'check' OR kind LIKE 'check-%')";

// The conditions a filter by target or entity gives.
function target_conditions(filter: RunFilter | EventFilter): [sql: string, value: SQLInputValue | SQLInputValue[] | undefined][] {
  return [
    ["target_id = ?", filter.target_id],
    ["host = ?", filter.host],
    ["job = ?", filter.job],
    ["repository = ?", filter.repository],
  ];
}

// A WHERE clause from the conditions whose value is given, with the values in order; an array fills several marks.
function conditions(parts: [sql: string, value: SQLInputValue | SQLInputValue[] | undefined][]): [string, SQLInputValue[]] {
  const given = parts.filter(([, value]) => value !== undefined && value !== "");
  if (given.length === 0) return ["", []];
  return [`WHERE ${given.map(([sql]) => sql).join(" AND ")}`, given.flatMap(([, value]) => value as SQLInputValue | SQLInputValue[])];
}

// `column IN (?, ?, …)` with a mark per value.
function in_list(column: string, values: string[] | undefined): string {
  return `${column} IN (${(values ?? []).map(() => "?").join(", ")})`;
}

function string_or_null(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function number_or_null(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function flag(value: boolean | undefined): number | null {
  return value === undefined ? null : Number(value);
}

function now_seconds(): number {
  return Math.floor(Date.now() / 1000);
}
