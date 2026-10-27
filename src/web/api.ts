// The shapes the server answers with, and one fetch helper that notices when a login is needed.

// ── Shapes ───────────────────────────────────────────────────────────────────

export type Status = "online" | "info" | "unavailable" | "warning" | "failed";

export type JobState = "running" | "succeeded" | "failed" | "cancelled";

export interface Job {
  id: number;
  repository_id: string;
  kind: string;
  command: string;
  state: JobState;
  progress: string | null;
  exit_code: number | null;
  error: string | null;
  started_epoch: number;
  ended_epoch: number | null;
  // Whether the job's action can be run again from its row.
  retry: boolean;
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
  host: string;
  status: Status | null;
  max_age: number;
  last_poll_epoch: number | null;
  last_backup_epoch: number | null;
  archive_count: number | null;
  stats: Stats | null;
  canary: { ok: boolean; checked_epoch: number; detail: string } | null;
  checks_passed: boolean | null;
  running_job: Job | null;
  source: "declared" | "page";
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
  restore_dir: string;
  downloads: DownloadRecord[];
  actions: Action[];
}

// A download in progress, which holds the repository's lock while it runs.
export interface DownloadRecord {
  id: number;
  repository_id: string;
  who: string;
  what: string;
  started_epoch: number;
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
  size_bytes: number | null;
  mtime: string;
}

export interface Listing {
  success: boolean;
  content: string | null;
  rows: BrowserRow[];
  more: boolean;
}

export interface DiffChange {
  path: string;
  kind: "added" | "removed" | "modified" | "metadata" | "other";
  added_bytes: number;
  removed_bytes: number;
  details: string[];
}

export interface Diff {
  success: boolean;
  content: string | null;
  changes: DiffChange[];
  more: boolean;
}

export type Level = "INFO" | "WARNING" | "ERROR";

export interface EventRow {
  id: number;
  repository_id: string;
  epoch: number;
  level: Level;
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

export interface RepositoryConfig {
  source: "declared" | "page";
  editable: boolean;
  config_mode: "declarative" | "mixed" | "page";
  fields: Record<string, unknown>;
}

export type FieldKind = "string" | "number" | "boolean" | "duration" | "number_or_string" | "list" | "durations";

export interface FieldSpec {
  name: string;
  kind: FieldKind;
}

export interface Setting {
  name: string;
  value: number | string;
  source: "declared" | "saved" | "default";
}

export interface ConfigInfo {
  mode: "declarative" | "mixed" | "page";
  editable: boolean;
  fields: FieldSpec[];
  settings: Setting[];
  shadowed: string[];
}

// Shown in place of a secret; sent back unchanged, it keeps the secret as it was.
export const SECRET_MASK = "(set)";

export interface SearchResults {
  repositories: { id: string; name: string }[];
  archives: { repository_id: string; name: string; epoch: number }[];
}

// What the server's stream says changed; null stands for "anything may have changed".
export interface Change {
  kind: "repository" | "job" | "timers" | "config";
  repository_id: string | null;
  job_id?: number;
}

// ── Requests ─────────────────────────────────────────────────────────────────

export class LoginNeeded extends Error {}

// A refused request, naming the config field at fault when the server gave one.
export class ApiError extends Error {
  readonly field: string | null;

  constructor(message: string, field: string | null) {
    super(message);
    this.field = field;
  }
}

export async function api<Answer>(path: string, body?: object): Promise<Answer> {
  const response = await fetch(path, body === undefined ? {} : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return answer_of<Answer>(response);
}

// The same for a request that changes or removes something, which the server takes as PUT or DELETE.
export async function send<Answer>(method: "PUT" | "DELETE", path: string, body?: object): Promise<Answer> {
  const response = await fetch(path, body === undefined ? { method } : {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return answer_of<Answer>(response);
}

async function answer_of<Answer>(response: Response): Promise<Answer> {
  if (response.status === 401) throw new LoginNeeded();
  if (response.status === 204) return undefined as Answer;
  const answer = await response.json();
  if (!response.ok) throw new ApiError(answer.error ?? `${response.status} ${response.statusText}`, answer.field ?? null);
  return answer as Answer;
}

// A query string from the values that are set, so empty filters leave no trace in the URL.
export function query(values: Record<string, string | number | null | undefined>): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (value !== null && value !== undefined && value !== "") params.set(name, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

export function repository_path(id: string): string {
  return `/api/repositories/${encodeURIComponent(id)}`;
}
