// The shapes a borg repository speaks in: commands it asks to run, their results, what it reports back, and the stores it reads.

import type { CheckState } from "./checks.ts";
import type { ArchiveEntry, RepositoryInfo } from "./parsing.ts";

// ── Commands and their results ───────────────────────────────────────────────

// One call, which the runner stops once it has run for timeout seconds.
export interface Command {
  text: string;
  timeout: number | null;
  // Fed to the call, carrying the passphrase when its borg calls need one.
  stdin: string | null;
}

export interface CmdResult {
  exit_code: number;
  stdout: string;
  stderr: string;
}

export function cmd_result(exit_code: number, stdout: string, stderr: string): CmdResult {
  return { exit_code, stdout, stderr };
}

export class ActionPlan {
  // Run one after another, each answered by one result in the same order.
  commands: string[];
  // Reads the commands' results into what the action reports.
  read: (results: CmdResult[]) => CollectResult;
  timeout: number | null;
  // Fed to each command, carrying the passphrase when its borg calls need one.
  stdin: string | null;
  // A detached plan is followed to its end by whoever runs it, so a restart never kills it.
  detached: boolean;

  constructor(
    commands: string[], read: (results: CmdResult[]) => CollectResult,
    options: { timeout?: number | null; stdin?: string | null; detached?: boolean } = {},
  ) {
    this.commands = commands;
    this.read = read;
    this.timeout = options.timeout ?? null;
    this.stdin = options.stdin ?? null;
    this.detached = options.detached ?? false;
  }
}

// What an action asks for: commands to run, or its answer straight away, such as a refusal.
export type ActionStart = ActionPlan | CollectResult;

// A borg call whose stdout is the file a download saves, and the name and type it is saved with.
export interface DownloadPlan {
  command: string;
  // Fed to the command, carrying the passphrase when its borg call needs one.
  stdin: string | null;
  filename: string;
  content_type: string;
}

// ── Repository state ─────────────────────────────────────────────────────────

export interface RepositoryStats {
  original_size?: number;
  compressed_size?: number;
  deduplicated_size?: number;
  total_chunks?: number;
  unique_chunks?: number;
  dedup_ratio?: number;
}

export interface CanaryRecord {
  ok: boolean;
  checked_epoch: number;
  detail: string;
}

export interface ChecksRecord {
  // Each tracked check by its unit or kind name.
  checks: Record<string, CheckState>;
  passed: boolean;
  // The oldest success among the checks held to an age, or 0 when none has one.
  oldest_ok_epoch: number;
}

// Everything a repository remembers between polls, kept by its owner and handed back before the next one.
export interface RepositoryState {
  archives: ArchiveEntry[];
  repository: RepositoryInfo;
  archive_count: number | null;
  last_backup_epoch: number | null;
  stats: RepositoryStats | null;
  canary: CanaryRecord | null;
  checks: ChecksRecord | null;
  last_poll_epoch: number | null;
}

export function empty_state(): RepositoryState {
  return {
    archives: [], repository: {}, archive_count: null, last_backup_epoch: null,
    stats: null, canary: null, checks: null, last_poll_epoch: null,
  };
}

// ── Reported outcomes ────────────────────────────────────────────────────────

export type LogLevel = "INFO" | "WARNING" | "ERROR";

export type LogEntry = [message: string, level: LogLevel];

export type MonitorStatus = "online" | "info" | "unavailable" | "warning" | "failed";

export interface CollectFields {
  state: RepositoryState | null;
  content: string | null;
  logs: LogEntry[];
  status: MonitorStatus | null;
  success: boolean;
}

export class CollectResult implements CollectFields {
  // The repository's whole state after this result, or null when it left the state as it was.
  state: RepositoryState | null;
  // The text an action shows its user.
  content: string | null;
  logs: LogEntry[];
  status: MonitorStatus | null;
  // Only read when the result answers an action rather than a poll.
  success: boolean;

  constructor(fields: Partial<CollectFields> = {}) {
    this.state = fields.state ?? null;
    this.content = fields.content ?? null;
    this.logs = fields.logs ?? [];
    this.status = fields.status ?? null;
    this.success = fields.success ?? false;
  }

  static failed(message: string, level: LogLevel = "ERROR", status: MonitorStatus | null = "failed"): CollectResult {
    return new CollectResult({ logs: [[message, level]], status });
  }

  static unavailable(message: string, level: LogLevel = "WARNING"): CollectResult {
    return new CollectResult({ logs: [[message, level]], status: "unavailable" });
  }
}

// ── Stores the repository reads ──────────────────────────────────────────────

export type JobState = "running" | "succeeded" | "warning" | "failed" | "cancelled";

export interface JobRecord {
  id: number;
  kind: string;
  command: string;
  workdir: string | null;
  pid: number | null;
  state: JobState;
  progress: string | null;
  output_seq: number;
  exit_code: number | null;
  error: string | null;
}

export interface JobStore {
  running(): JobRecord | null;
  action_job(action_id: string): JobRecord | null;
  create(kind: string, command: string, workdir: string | null): number;
  set_pid(job_id: number, pid: number): void;
  set_progress(job_id: number, summary: string): void;
  append_output(job_id: number, lines: string[]): void;
  bump_output_seq(job_id: number, new_seq: number): void;
  finish(job_id: number, state: JobState, details: { exit_code?: number | null; error?: string | null }): void;
}
