// Keeps each repository's state, its poll history, archives, events and jobs in one SQLite file under X_BACKUPS_STATE_DIR.

// ── Imports ──────────────────────────────────────────────────────────────────

import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import type { HostSample } from "./host_health.ts";
import type { Timer } from "./timers.ts";
import type { CollectResult, JobRecord, JobState, JobStore, LogLevel, MonitorStatus, RepositoryState } from "./borg/types.ts";

// ── Rows ─────────────────────────────────────────────────────────────────────

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

export interface EventRow {
  id: number;
  repository_id: string;
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

export interface HostSampleRow extends HostSample {
  host: string;
  epoch: number;
}

// A host's readings are kept for a week, the longest span its charts draw.
const host_sample_retention_in_seconds = 7 * 86400;

// A timer run is kept this long, enough for several weeks of the calendar.
const timer_run_retention_in_seconds = 90 * 86400;

// How far before its listed elapse a timer may trigger and still count as that run, for systemd's AccuracySec.
const timer_trigger_slack_in_seconds = 60;

export interface JobRow extends JobRecord {
  repository_id: string;
  started_epoch: number;
  ended_epoch: number | null;
}

// What changed, so a page that listens can fetch only what it shows.
export interface Change {
  kind: "repository" | "job" | "timers" | "hosts" | "config";
  repository_id: string | null;
  job_id?: number;
}

export interface JobFilter {
  repository_id?: string;
  // The repositories a viewer may see; an empty list matches nothing.
  repository_ids?: string[];
  // A kind matches itself and its variants, so "check" also matches "check-data".
  kind?: string;
  state?: string;
  since_epoch?: number;
  limit?: number;
  offset?: number;
}

export interface EventFilter {
  repository_id?: string;
  repository_ids?: string[];
  level?: string;
  limit?: number;
  offset?: number;
}

// ── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS repository_states (
    repository_id TEXT PRIMARY KEY,
    state TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS polls (
    repository_id TEXT NOT NULL,
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
    PRIMARY KEY (repository_id, epoch)
  );
  CREATE TABLE IF NOT EXISTS archives (
    repository_id TEXT NOT NULL,
    name TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    original_size INTEGER,
    compressed_size INTEGER,
    deduplicated_size INTEGER,
    file_count INTEGER,
    PRIMARY KEY (repository_id, name)
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    repository_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    level TEXT NOT NULL,
    message TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY,
    repository_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    command TEXT NOT NULL,
    workdir TEXT,
    pid INTEGER,
    state TEXT NOT NULL,
    progress TEXT,
    output_seq INTEGER NOT NULL DEFAULT 0,
    exit_code INTEGER,
    error TEXT,
    started_epoch INTEGER NOT NULL,
    ended_epoch INTEGER
  );
  CREATE TABLE IF NOT EXISTS job_output (
    job_id INTEGER NOT NULL,
    line_number INTEGER NOT NULL,
    line TEXT NOT NULL,
    PRIMARY KEY (job_id, line_number)
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
  CREATE INDEX IF NOT EXISTS events_by_repository ON events (repository_id, id);
  CREATE INDEX IF NOT EXISTS jobs_by_repository ON jobs (repository_id, id);
  CREATE TABLE IF NOT EXISTS users (
    name TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    repositories TEXT,
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
`;

// ── Store ────────────────────────────────────────────────────────────────────

export class Store {
  private readonly database: DatabaseSync;
  // Emits a "change" with a Change after each write a page might show.
  readonly changes = new EventEmitter();

  // A path of ":memory:" keeps everything in memory, for tests.
  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode = WAL");
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

  // ── Repository state ─────────────────────────────────────────────────────

  load_state(repository_id: string): RepositoryState | null {
    const row = this.get("SELECT state FROM repository_states WHERE repository_id = ?", repository_id);
    return row ? JSON.parse(String(row.state)) as RepositoryState : null;
  }

  // Keeps what a poll or action reports: its new state, its events, and for a poll one history row.
  apply(repository_id: string, result: CollectResult, options: { poll: boolean; epoch?: number }): void {
    const epoch = options.epoch ?? now_seconds();
    this.transaction(() => {
      if (result.state !== null) this.save_state(repository_id, result.state);
      if (options.poll && result.state !== null) this.add_poll(repository_id, epoch, result.state, result.status);
      // A repository poll's routine lines would bury everything else, so only its warnings and errors are kept.
      const routine = options.poll && result.status !== null;
      for (const [message, level] of result.logs) {
        if (routine && level === "INFO") continue;
        this.run("INSERT INTO events (repository_id, epoch, level, message) VALUES (?, ?, ?, ?)", repository_id, epoch, level, message);
      }
    });
    this.changed({ kind: "repository", repository_id });
  }

  private save_state(repository_id: string, state: RepositoryState): void {
    this.run(
      "INSERT INTO repository_states (repository_id, state) VALUES (?, ?) ON CONFLICT (repository_id) DO UPDATE SET state = excluded.state",
      repository_id, JSON.stringify(state),
    );
    for (const archive of state.archives) {
      this.run(
        `INSERT INTO archives (repository_id, name, epoch, original_size, compressed_size, deduplicated_size, file_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (repository_id, name) DO UPDATE SET
           original_size = coalesce(excluded.original_size, original_size),
           compressed_size = coalesce(excluded.compressed_size, compressed_size),
           deduplicated_size = coalesce(excluded.deduplicated_size, deduplicated_size),
           file_count = coalesce(excluded.file_count, file_count)`,
        repository_id, archive.name, archive.epoch, archive.original ?? null, archive.compressed ?? null,
        archive.deduplicated ?? null, archive.nfiles ?? null,
      );
    }
  }

  // Only a poll of the repository itself adds a row; a poll that only followed a job leaves the state alone.
  private add_poll(repository_id: string, epoch: number, state: RepositoryState, status: MonitorStatus | null): void {
    const stats = state.stats;
    this.run(
      `INSERT OR REPLACE INTO polls (repository_id, epoch, status, original_size, compressed_size, deduplicated_size,
         total_chunks, unique_chunks, archive_count, last_backup_epoch, canary_ok, checks_passed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      repository_id, epoch, status, stats?.original_size ?? null, stats?.compressed_size ?? null,
      stats?.deduplicated_size ?? null, stats?.total_chunks ?? null, stats?.unique_chunks ?? null,
      state.archive_count, state.last_backup_epoch, flag(state.canary?.ok), flag(state.checks?.passed),
    );
  }

  // ── History ──────────────────────────────────────────────────────────────

  polls(repository_id: string, since_epoch = 0): PollRow[] {
    return this.all("SELECT * FROM polls WHERE repository_id = ? AND epoch >= ? ORDER BY epoch", repository_id, since_epoch)
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
  archives(repository_id: string): ArchiveRow[] {
    return this.all("SELECT * FROM archives WHERE repository_id = ? ORDER BY epoch DESC", repository_id).map((row) => ({
      name: String(row.name),
      epoch: Number(row.epoch),
      original_size: number_or_null(row.original_size),
      compressed_size: number_or_null(row.compressed_size),
      deduplicated_size: number_or_null(row.deduplicated_size),
      file_count: number_or_null(row.file_count),
    }));
  }

  // The newest events first, for one repository or all of them, at one level or all.
  events(options: EventFilter = {}): EventRow[] {
    if (options.repository_ids?.length === 0) return [];
    const [where, values] = conditions([
      ["repository_id = ?", options.repository_id],
      [in_list("repository_id", options.repository_ids), options.repository_ids],
      ["level = ?", options.level],
    ]);
    const sql = `SELECT * FROM events ${where} ORDER BY id DESC LIMIT ? OFFSET ?`;
    return this.all(sql, ...values, options.limit ?? 100, options.offset ?? 0).map((row) => ({
      id: Number(row.id),
      repository_id: String(row.repository_id),
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
    this.changed({ kind: "timers", repository_id: null });
  }

  // ── Hosts ────────────────────────────────────────────────────────────────

  // Keeps one reading of a host's load, memory and root disk, dropping its readings past retention.
  add_host_sample(host: string, sample: HostSample, epoch = now_seconds()): void {
    this.transaction(() => {
      this.run("DELETE FROM host_samples WHERE host = ? AND epoch < ?", host, epoch - host_sample_retention_in_seconds);
      this.run(
        "INSERT OR REPLACE INTO host_samples (host, epoch, load1, cpus, memory_total, memory_available, disk_size, disk_available) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        host, epoch, sample.load1, sample.cpus, sample.memory_total, sample.memory_available, sample.disk_size, sample.disk_available,
      );
    });
    this.changed({ kind: "hosts", repository_id: null });
  }

  // Every host's readings from `since` on, oldest first.
  host_samples(since: number): HostSampleRow[] {
    return this.all("SELECT * FROM host_samples WHERE epoch >= ? ORDER BY host, epoch", since).map((row) => ({
      host: String(row.host),
      epoch: Number(row.epoch),
      load1: Number(row.load1),
      cpus: Number(row.cpus),
      memory_total: Number(row.memory_total),
      memory_available: Number(row.memory_available),
      disk_size: Number(row.disk_size),
      disk_available: Number(row.disk_available),
    }));
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

  // ── Jobs ─────────────────────────────────────────────────────────────────

  jobs_for(repository_id: string): JobStore {
    return new RepositoryJobs(this, repository_id);
  }

  job(job_id: number): JobRow | null {
    const row = this.get("SELECT * FROM jobs WHERE id = ?", job_id);
    return row ? job_row(row) : null;
  }

  // The newest jobs first, narrowed by whatever the filter names.
  jobs(options: JobFilter = {}): JobRow[] {
    if (options.repository_ids?.length === 0) return [];
    const [where, values] = conditions([
      ["repository_id = ?", options.repository_id],
      [in_list("repository_id", options.repository_ids), options.repository_ids],
      ["(kind = ? OR kind LIKE ? || '-%')", options.kind === undefined ? undefined : [options.kind, options.kind]],
      ["state = ?", options.state],
      ["started_epoch >= ?", options.since_epoch],
    ]);
    const sql = `SELECT * FROM jobs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`;
    return this.all(sql, ...values, options.limit ?? 100, options.offset ?? 0).map(job_row);
  }

  // The job's output lines after the first skipped ones, so a page can fetch only what is new.
  job_output(job_id: number, skip = 0): string[] {
    return this.all("SELECT line FROM job_output WHERE job_id = ? AND line_number >= ? ORDER BY line_number", job_id, skip)
      .map((row) => String(row.line));
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

// ── One repository's jobs ────────────────────────────────────────────────────

class RepositoryJobs implements JobStore {
  private readonly store: Store;
  private readonly repository_id: string;

  constructor(store: Store, repository_id: string) {
    this.store = store;
    this.repository_id = repository_id;
  }

  running(): JobRecord | null {
    const row = this.store.get("SELECT * FROM jobs WHERE repository_id = ? AND state = 'running' ORDER BY id DESC LIMIT 1", this.repository_id);
    return row ? job_row(row) : null;
  }

  // A detached action's job is kept under the action's own id as its kind.
  action_job(action_id: string): JobRecord | null {
    const row = this.store.get(
      "SELECT * FROM jobs WHERE repository_id = ? AND kind = ? AND state = 'running' ORDER BY id DESC LIMIT 1",
      this.repository_id, action_id,
    );
    return row ? job_row(row) : null;
  }

  create(kind: string, command: string, workdir: string | null): number {
    const job_id = this.store.run(
      "INSERT INTO jobs (repository_id, kind, command, workdir, state, started_epoch) VALUES (?, ?, ?, ?, 'running', ?)",
      this.repository_id, kind, command, workdir, now_seconds(),
    );
    this.changed(job_id);
    return job_id;
  }

  set_pid(job_id: number, pid: number): void {
    this.store.run("UPDATE jobs SET pid = ? WHERE id = ?", pid, job_id);
  }

  set_progress(job_id: number, summary: string): void {
    this.store.run("UPDATE jobs SET progress = ? WHERE id = ?", summary, job_id);
    this.changed(job_id);
  }

  append_output(job_id: number, lines: string[]): void {
    this.store.transaction(() => {
      const row = this.store.get("SELECT count(*) AS count FROM job_output WHERE job_id = ?", job_id);
      let line_number = Number(row?.count ?? 0);
      for (const line of lines) {
        this.store.run("INSERT INTO job_output (job_id, line_number, line) VALUES (?, ?, ?)", job_id, line_number++, line);
      }
    });
    this.changed(job_id);
  }

  bump_output_seq(job_id: number, new_seq: number): void {
    this.store.run("UPDATE jobs SET output_seq = ? WHERE id = ?", new_seq, job_id);
  }

  finish(job_id: number, state: JobState, details: { exit_code?: number | null; error?: string | null }): void {
    this.store.run(
      "UPDATE jobs SET state = ?, exit_code = ?, error = ?, ended_epoch = ? WHERE id = ?",
      state, details.exit_code ?? null, details.error ?? null, now_seconds(), job_id,
    );
    this.changed(job_id);
  }

  private changed(job_id: number): void {
    this.store.changed({ kind: "job", repository_id: this.repository_id, job_id });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function job_row(row: Record<string, unknown>): JobRow {
  return {
    id: Number(row.id),
    repository_id: String(row.repository_id),
    kind: String(row.kind),
    command: String(row.command),
    workdir: row.workdir === null ? null : String(row.workdir),
    pid: number_or_null(row.pid),
    state: row.state as JobState,
    progress: row.progress === null ? null : String(row.progress),
    output_seq: Number(row.output_seq),
    exit_code: number_or_null(row.exit_code),
    error: row.error === null ? null : String(row.error),
    started_epoch: Number(row.started_epoch),
    ended_epoch: number_or_null(row.ended_epoch),
  };
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

function number_or_null(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function flag(value: boolean | undefined): number | null {
  return value === undefined ? null : Number(value);
}

function now_seconds(): number {
  return Math.floor(Date.now() / 1000);
}
