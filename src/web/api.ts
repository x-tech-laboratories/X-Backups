// The shapes the server answers with, and one fetch helper that notices when a login is needed.

// ── Shapes ───────────────────────────────────────────────────────────────────

// The target a row belongs to and the host, job and repository it is built from; null on an older row of a target since removed.
export interface TargetColumns {
  target_id: string;
  host: string | null;
  job: string | null;
  repository: string | null;
}

export type Status = "online" | "info" | "unavailable" | "warning" | "failed";

export type RunState = "running" | "succeeded" | "warning" | "failed" | "cancelled";

export interface Run extends TargetColumns {
  id: number;
  // The task the run belongs to, or null for an action started by hand.
  task: string | null;
  kind: string;
  command: string;
  state: RunState;
  progress: string | null;
  exit_code: number | null;
  error: string | null;
  started_epoch: number;
  ended_epoch: number | null;
  // Whether the run's action can be run again from its row.
  retry: boolean;
  // A running run waiting for its host's agent to come back, or a run whose agent no longer knew it.
  condition: "waiting_for_agent" | "lost" | null;
  output?: string[];
}

export interface Stats {
  original_size?: number;
  compressed_size?: number;
  deduplicated_size?: number;
  dedup_ratio?: number;
}

// One target, with the host, job and repository it is built from; a repository only watched has no job.
export interface RepositorySummary {
  id: string;
  name: string;
  target_id: string;
  host: string;
  job: string | null;
  repository: string;
  status: Status | null;
  // How healthy the server judges the repository, and why.
  level: "ok" | "warning" | "critical";
  reasons: { level: "warning" | "critical"; text: string }[];
  max_age: number;
  // 0 when the repository warns only at max_age.
  warn_age: number;
  // The bytes it may store, or 0 when no quota is set.
  quota: number;
  // The filesystem holding a repository on a local path; null over SSH or before a poll reads it.
  storage: { size: number; available: number; read_epoch: number } | null;
  last_poll_epoch: number | null;
  last_backup_epoch: number | null;
  archive_count: number | null;
  stats: Stats | null;
  canary: { ok: boolean; checked_epoch: number; detail: string } | null;
  checks_passed: boolean | null;
  running_run: Run | null;
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
  // The jobs writing to its repository, the repository's other targets, and the repository's own tasks.
  writers: string[];
  repository_targets: RepositorySummary[];
  tasks: TaskView[];
}

export type Level = "ok" | "warning" | "critical";

// ── Entities ─────────────────────────────────────────────────────────────────

export type ConfigSource = "declared" | "page";

export interface HostRow {
  name: string;
  kind: "managed" | "storage-only";
  address: string | null;
  // This server's own host, run by the agent built into it.
  own: boolean;
  sources: string[];
  repositories: string[];
  connected: boolean;
  built_in: boolean;
  agent_version: string | null;
  reported_host: string | null;
  connected_epoch: number | null;
  enrolled: boolean;
  last_seen_epoch: number | null;
  health: Omit<HostSample, "host"> | null;
}

export interface SourceRow {
  name: string;
  host: string;
  source: ConfigSource;
  // The flat entry it was expanded from, or null for one written as a source.
  expanded_from: string | null;
  paths: string[];
  exclude: string[];
  settings: Record<string, unknown>;
  jobs: string[];
}

export interface JobRow {
  name: string;
  source: ConfigSource;
  expanded_from: string | null;
  sources: string[];
  repositories: string[];
  settings: Record<string, unknown>;
  // The worst of its targets, or null when it has none the viewer sees.
  level: Level | null;
  targets: RepositorySummary[];
  tasks: TaskView[];
}

export interface LastRun {
  id: number;
  state: RunState;
  started_epoch: number;
  ended_epoch: number | null;
}

export interface TaskTarget {
  target_id: string;
  host: string;
  repository: string;
  job: string | null;
  next_due: number | null;
  last_run: LastRun | null;
  running: boolean;
  waiting: string | null;
}

export interface TaskView {
  id: string;
  owner_kind: "job" | "repository";
  owner: string;
  kind: string;
  schedule: string | number | null;
  after: "backup" | null;
  check: string | null;
  description: string;
  origin: "written" | "translated" | "default" | "manual";
  enabled: boolean;
  enabled_by_config: boolean;
  override: { enabled: boolean; changed_by: string; changed_epoch: number } | null;
  next_due: number | null;
  last_run: LastRun | null;
  running: boolean;
  waiting: string | null;
  targets: TaskTarget[];
}

export type EntityKind = "hosts" | "repositories" | "sources" | "jobs";

export interface EntityEntry {
  name: string;
  source: ConfigSource;
  // A page entry a declared one of the same name hides.
  shadowed: boolean;
  // A repository entry of the older shape, edited on its target's Config tab.
  flat: boolean;
  fields: Record<string, unknown>;
}

export interface EntityConfig {
  kind: EntityKind;
  mode: "declarative" | "mixed" | "page";
  editable: boolean;
  fields: FieldSpec[];
  tasks: { kinds: string[]; check_kinds: string[] };
  entries: EntityEntry[];
}

export interface SchedulePreview {
  description: string;
  time_zone: string;
  next: number[];
}

// Which host's folders each repository backs up and which host stores it, as the repositories' config says.
export interface BackupMap {
  hosts: { id: string; name: string }[];
  sources: { id: string; host: string; path: string }[];
  repositories: MapRepository[];
  // The configured host and source each map host and folder stands for.
  links: { hosts: Record<string, string>; sources: Record<string, string> };
}

export interface MapRepository extends RepositorySummary {
  // The host whose disk holds the repository, and its folder there.
  stored_on: string;
  path: string;
  // The source ids it backs up; none for a repository that is only watched.
  sources: string[];
  retention: Record<string, number | string>;
}

// A download in progress, which holds the repository's lock while it runs.
export interface DownloadRecord {
  id: number;
  target_id: string;
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

export type EventLevel = "INFO" | "WARNING" | "ERROR";

export interface EventRow extends TargetColumns {
  id: number;
  epoch: number;
  level: EventLevel;
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
  // When its OnCalendar fires over the coming week; empty for a timer that counts from its last run.
  upcoming: number[];
  read_epoch: number;
}

// One reading of a host's load, memory and root disk.
export interface HostSample {
  host: string;
  epoch: number;
  load1: number;
  cpus: number;
  memory_total: number;
  memory_available: number;
  disk_size: number;
  disk_available: number;
}

// A run a timer made, or one it should have made, with a result of "missed".
export interface TimerRun {
  host: string;
  unit: string;
  epoch: number;
  result: string | null;
  exit_status: number | null;
}

export interface RepositoryConfig {
  source: "declared" | "page";
  editable: boolean;
  config_mode: "declarative" | "mixed" | "page";
  fields: Record<string, unknown>;
}

export type FieldKind = "string" | "number" | "boolean" | "duration" | "number_or_string" | "list" | "durations" | "strings";

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
  archives: { target_id: string; name: string; epoch: number }[];
}

// What the server's stream says changed; null stands for "anything may have changed".
export interface Change {
  kind: "repository" | "run" | "timers" | "hosts" | "config" | "tasks";
  target_id: string | null;
  run_id?: number;
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
