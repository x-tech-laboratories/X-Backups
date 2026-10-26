// The shapes a borg repository speaks in: commands it asks to run, their results, what it reports back, and the stores it reads.

// ── Commands and their results ───────────────────────────────────────────────

export interface Command {
  text: string;
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
  command: string;
  timeout: number | null;
  // A detached plan is followed to its end by whoever runs it, so a restart never kills it.
  detached: boolean;

  constructor(command: string, options: { timeout?: number | null; detached?: boolean } = {}) {
    this.command = command;
    this.timeout = options.timeout ?? null;
    this.detached = options.detached ?? false;
  }
}

// ── Reported outcomes ────────────────────────────────────────────────────────

export type LogLevel = "INFO" | "WARNING" | "ERROR";

export type LogEntry = [message: string, level: LogLevel];

export type MonitorStatus = "online" | "info" | "unavailable" | "warning" | "failed";

export interface CollectFields {
  metrics: Record<string, number>;
  metadata: Record<string, string>;
  logs: LogEntry[];
  status: MonitorStatus | null;
  success: boolean;
}

export class CollectResult implements CollectFields {
  metrics: Record<string, number>;
  metadata: Record<string, string>;
  logs: LogEntry[];
  status: MonitorStatus | null;
  // Only read when the result answers an action rather than a poll.
  success: boolean;

  constructor(fields: Partial<CollectFields> = {}) {
    this.metrics = fields.metrics ?? {};
    this.metadata = fields.metadata ?? {};
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

export interface MetricRecord {
  value: number;
  metadata: string | null;
}

export interface MetricReader {
  latest_metric(metric_name: string): MetricRecord | null;
}

export type JobState = "running" | "succeeded" | "failed" | "cancelled";

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
