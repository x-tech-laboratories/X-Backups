// The shapes the server answers with, and one fetch helper that notices when a login is needed.

// ── Shapes ───────────────────────────────────────────────────────────────────

export type Status = "online" | "info" | "unavailable" | "warning" | "failed";

export interface Job {
  id: number;
  repository_id: string;
  kind: string;
  state: "running" | "succeeded" | "failed" | "cancelled";
  progress: string | null;
  exit_code: number | null;
  error: string | null;
  started_epoch: number;
  ended_epoch: number | null;
  output?: string[];
}

export interface Stats {
  original_size?: number;
  compressed_size?: number;
  deduplicated_size?: number;
  dedup_ratio?: number;
}

export interface RepositorySummary {
  id: string;
  name: string;
  host: string | null;
  status: Status | null;
  max_age: number;
  last_poll_epoch: number | null;
  last_backup_epoch: number | null;
  archive_count: number | null;
  stats: Stats | null;
  canary: { ok: boolean; checked_epoch: number; detail: string } | null;
  checks_passed: boolean | null;
  running_job: Job | null;
}

export interface Archive {
  name: string;
  epoch: number;
  original?: number;
  compressed?: number;
  deduplicated?: number;
  nfiles?: number;
}

export interface Action {
  name: string;
  action_id: string;
  confirm?: string;
  state: "normal" | "accent" | "disabled" | "hidden";
}

export interface RepositoryDetail extends RepositorySummary {
  repo: string | null;
  archives: Archive[];
  source_paths: string[];
  exclude: string[];
  retention: Record<string, number | string>;
  allow_delete: boolean;
  actions: Action[];
}

export interface Outcome {
  success: boolean;
  content: string | null;
  logs: [message: string, level: string][];
}

export interface BrowserRow {
  name: string;
  path: string;
  dir: boolean;
  size: string;
  mtime: string;
}

export interface Listing {
  success: boolean;
  content: string | null;
  rows: BrowserRow[];
  more: boolean;
}

export interface EventRow {
  id: number;
  repository_id: string;
  epoch: number;
  level: "INFO" | "WARNING" | "ERROR";
  message: string;
}

export interface PollRow {
  epoch: number;
  status: Status | null;
  original_size: number | null;
  compressed_size: number | null;
  deduplicated_size: number | null;
  archive_count: number | null;
  canary_ok: boolean | null;
  checks_passed: boolean | null;
}

export interface ArchiveRow {
  name: string;
  epoch: number;
  original_size: number | null;
  deduplicated_size: number | null;
  file_count: number | null;
}

export interface History {
  polls: PollRow[];
  archives: ArchiveRow[];
}

export interface TimerRow {
  host: string;
  unit: string;
  service: string;
  next_epoch: number | null;
  last_epoch: number | null;
  result: string | null;
  exit_status: number | null;
  read_epoch: number;
}

// ── Requests ─────────────────────────────────────────────────────────────────

export class LoginNeeded extends Error {}

export async function api<Answer>(path: string, body?: object): Promise<Answer> {
  const response = await fetch(path, body === undefined ? {} : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status === 401) throw new LoginNeeded();
  if (response.status === 204) return undefined as Answer;
  const answer = await response.json();
  if (!response.ok) throw new Error(answer.error ?? `${response.status} ${response.statusText}`);
  return answer as Answer;
}
