// Reads repository configs: their JSON shape, the field checks, and the defaults a file may set for every repository.

// ── Imports ──────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";

import { parse_duration } from "./borg/durations.ts";
import { BorgRepository, type BorgConfig } from "./borg/repository.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

// Where a repository's config came from: the file the Nix module writes, or the page.
export type ConfigSource = "declared" | "page";

export interface RepositoryConfig {
  name: string;
  // No host means the repository is reached on this machine.
  host: string | null;
  ssh_user: string | null;
  interval_in_seconds: number;
  borg: BorgConfig;
  source: ConfigSource;
}

export interface Config {
  repositories: RepositoryConfig[];
}

// What a config file holds before its entries are checked: the repositories, and defaults for them all.
export interface ConfigDocument {
  defaults: Record<string, unknown>;
  repositories: Record<string, unknown>[];
}

// A bad config, naming the field at fault when there is one, so the page can show the message beside it.
export class ConfigError extends Error {
  readonly field: string | null;

  constructor(message: string, field: string | null = null) {
    super(message);
    this.name = "ConfigError";
    this.field = field;
  }
}

export type FieldKind = "string" | "number" | "boolean" | "duration" | "number_or_string" | "list" | "durations";

// Typed against BorgConfig, so a field added there fails to compile until it is listed here.
export const borg_fields: { [field in keyof Required<BorgConfig>]: FieldKind } = {
  id: "string",
  timeout: "duration",
  repo: "string",
  max_age: "duration",
  warn_age: "duration",
  passphrase: "string",
  passphrase_file: "string",
  passphrase_command: "string",
  borg_version: "number",
  borg_bin: "string",
  lock_wait: "number_or_string",
  require_sudo: "boolean",
  list_archives: "number",
  collect_stats: "boolean",
  ssh_key: "string",
  rsh: "string",
  source_paths: "list",
  exclude: "list",
  exclude_from: "string",
  exclude_caches: "boolean",
  exclude_if_present: "list",
  one_file_system: "boolean",
  compression: "string",
  archive_prefix: "string",
  cache_dir: "string",
  backup_lock_wait: "number_or_string",
  canary_path: "string",
  canary_interval: "duration",
  canary_warn_age: "duration",
  canary_max_age: "duration",
  check_units: "list",
  check_max_age: "duration",
  check_warn_age: "duration",
  restore_dir: "string",
  browse_limit: "number",
  prune_match: "string",
  allow_delete: "boolean",
  check_verify_data: "boolean",
  allow_purge: "boolean",
  purge_match: "string",
  prune_after_backup: "boolean",
  compact_after_backup: "boolean",
  skip_when_unreachable: "boolean",
  skip_while_active: "list",
  job_nice: "number_or_string",
  job_io_idle: "boolean",
  inhibit_sleep: "boolean",
  job_lock: "string",
  check_kinds: "durations",
  keep_within: "number_or_string",
  keep_last: "number_or_string",
  keep_secondly: "number_or_string",
  keep_minutely: "number_or_string",
  keep_hourly: "number_or_string",
  keep_daily: "number_or_string",
  keep_weekly: "number_or_string",
  keep_monthly: "number_or_string",
  keep_yearly: "number_or_string",
};

// The fields of an entry that are X-Backups' own rather than borg's.
const own_fields: Record<string, FieldKind> = { name: "string", host: "string", ssh_user: "string", interval: "duration" };

// The settings a file may give for every repository at once, with the value used when no file gives one.
export const default_settings: Record<string, { kind: FieldKind; fallback: number | string }> = {
  interval: { kind: "duration", fallback: "1h" },
  max_age: { kind: "duration", fallback: "1d" },
  warn_age: { kind: "duration", fallback: 0 },
  check_max_age: { kind: "duration", fallback: "8d" },
  check_warn_age: { kind: "duration", fallback: 0 },
  canary_max_age: { kind: "duration", fallback: 0 },
  canary_warn_age: { kind: "duration", fallback: 0 },
  browse_limit: { kind: "number", fallback: 2000 },
};

// Names end up in archive prefixes and systemd unit names, so they stay plain.
export const name_pattern = /^[A-Za-z0-9_.-]+$/;

// Every field an entry may hold with its kind, own fields first, for building a form.
export function field_list(): { name: string; kind: FieldKind }[] {
  return [...Object.entries(own_fields), ...Object.entries(borg_fields)].map(([name, kind]) => ({ name, kind }));
}

// ── Loading ──────────────────────────────────────────────────────────────────

export function load_config(file_path: string | undefined = process.env.X_BACKUPS_CONFIG): Config {
  if (!file_path) throw new Error("X_BACKUPS_CONFIG is not set; point it at the repositories JSON file.");
  return parse_config(read_text(file_path), file_path);
}

export function read_text(file_path: string): string {
  try {
    return readFileSync(file_path, "utf8");
  } catch (error) {
    throw new Error(`Cannot read the config file ${file_path}: ${(error as Error).message}`);
  }
}

export function parse_config(text: string, source: string): Config {
  const document = parse_document(text, source);
  return { repositories: check_repositories(document.repositories, document.defaults, "declared") };
}

// Reads a config file's JSON without checking its entries yet.
export function parse_document(text: string, source: string): ConfigDocument {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source} is not valid JSON: ${(error as Error).message}`);
  }

  if (!is_plain_object(document) || !Array.isArray(document.repositories)) {
    throw new Error(`${source} must hold an object with a "repositories" list.`);
  }
  const defaults = document.defaults ?? {};
  if (!is_plain_object(defaults)) throw new Error(`${source}: "defaults" must be an object.`);
  check_defaults(defaults, source);
  return { defaults, repositories: document.repositories as Record<string, unknown>[] };
}

// Checks every entry and that no two share an id, with each entry's unset fields taken from the defaults.
export function check_repositories(entries: unknown[], defaults: Record<string, unknown>, source: ConfigSource): RepositoryConfig[] {
  const repositories = entries.map((entry, index) => parse_repository(entry, index, defaults, source));
  const seen_ids = new Set<string>();
  for (const repository of repositories) {
    const id = repository.borg.id ?? repository.name;
    if (seen_ids.has(id)) throw new ConfigError(`Repository '${repository.name}': id '${id}' is used twice.`, "id");
    seen_ids.add(id);
  }
  return repositories;
}

export function check_defaults(defaults: Record<string, unknown>, source: string): void {
  for (const [field, value] of Object.entries(defaults)) {
    const setting = default_settings[field];
    if (setting === undefined) throw new ConfigError(`${source}: unknown default '${field}'; use ${Object.keys(default_settings).join(", ")}.`, field);
    if (!is_field_kind(value, setting.kind)) throw new ConfigError(`${source}: default ${field} must be ${describe_kind(setting.kind)}, not ${JSON.stringify(value)}.`, field);
  }
}

// ── One repository ───────────────────────────────────────────────────────────

export function parse_repository(entry: unknown, index: number, defaults: Record<string, unknown> = {}, source: ConfigSource = "declared"): RepositoryConfig {
  if (!is_plain_object(entry)) throw new ConfigError(`Repository ${index + 1}: must be an object.`);

  const name = entry.name;
  if (typeof name !== "string" || !name_pattern.test(name)) {
    throw new ConfigError(`Repository ${index + 1}: name must be letters, digits, '.', '_' or '-'.`, "name");
  }

  const fail = (problem: string, field: string | null = null): never => {
    throw new ConfigError(`Repository '${name}': ${problem}`, field);
  };

  const host = optional_string(entry, "host", fail);
  const ssh_user = optional_string(entry, "ssh_user", fail);
  if (ssh_user !== null && host === null) fail("ssh_user is set without a host.", "ssh_user");

  const interval = entry.interval ?? defaults.interval ?? default_settings.interval.fallback;
  if (!is_field_kind(interval, "duration")) fail(`interval must be a duration such as "1h", not ${JSON.stringify(interval)}.`, "interval");
  const interval_in_seconds = parse_duration(interval as number | string);
  if (interval_in_seconds <= 0) fail("interval must be longer than zero.", "interval");

  const borg: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(entry)) {
    if (Object.hasOwn(own_fields, field)) continue;
    if (!Object.hasOwn(borg_fields, field)) fail(`unknown field '${field}'.`, field);

    const kind = borg_fields[field as keyof BorgConfig];
    if (!is_field_kind(value, kind)) fail(`${field} must be ${describe_kind(kind)}, not ${JSON.stringify(value)}.`, field);
    borg[field] = value;
  }
  if (typeof borg.repo !== "string" || borg.repo === "") fail("repo is required.", "repo");
  for (const [field, value] of Object.entries(defaults)) {
    if (field !== "interval" && borg[field] === undefined) borg[field] = value;
  }

  // The repository checks how its fields fit together, such as pruning after a backup with no retention.
  try {
    new BorgRepository(name, borg as BorgConfig);
  } catch (error) {
    fail(`${(error as Error).message}.`);
  }

  return { name, host, ssh_user, interval_in_seconds, borg: borg as BorgConfig, source };
}

function optional_string(entry: Record<string, unknown>, field: string, fail: (problem: string, field: string) => never): string | null {
  const value = entry[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value === "") fail(`${field} must be a non-empty string.`, field);
  return value as string;
}

// ── Field checks ─────────────────────────────────────────────────────────────

export function is_field_kind(value: unknown, kind: FieldKind): boolean {
  switch (kind) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "number_or_string":
      return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
    case "duration":
      return is_duration(value);
    case "list":
      return typeof value === "string" || (Array.isArray(value) && value.every((item) => typeof item === "string"));
    case "durations":
      return is_plain_object(value) && Object.values(value).every(is_duration);
  }
}

function is_duration(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0;
  if (typeof value !== "string") return false;
  try {
    parse_duration(value);
    return true;
  } catch {
    return false;
  }
}

function describe_kind(kind: FieldKind): string {
  switch (kind) {
    case "string":
      return "a string";
    case "number":
      return "a number";
    case "boolean":
      return "true or false";
    case "number_or_string":
      return "a number or a string";
    case "duration":
      return 'a duration such as "1d" or a number of seconds';
    case "list":
      return "a string or a list of strings";
    case "durations":
      return "an object of durations";
  }
}

export function is_plain_object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
