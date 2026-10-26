// Reads the repositories X-Backups watches from the JSON file named by X_BACKUPS_CONFIG, and stops on the first bad entry.

// ── Imports ──────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";

import { parse_duration } from "./borg/durations.ts";
import type { BorgConfig } from "./borg/repository.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface RepositoryConfig {
  name: string;
  // No host means the repository is reached on this machine.
  host: string | null;
  ssh_user: string | null;
  interval_in_seconds: number;
  borg: BorgConfig;
}

export interface Config {
  repositories: RepositoryConfig[];
}

type FieldKind = "string" | "number" | "boolean" | "duration" | "number_or_string" | "list" | "durations";

// Typed against BorgConfig, so a field added there fails to compile until it is listed here.
const borg_fields: { [field in keyof Required<BorgConfig>]: FieldKind } = {
  id: "string",
  timeout: "duration",
  repo: "string",
  max_age: "duration",
  passphrase: "string",
  passphrase_file: "string",
  passphrase_command: "string",
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
  check_units: "list",
  check_max_age: "duration",
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

const own_fields = ["name", "host", "ssh_user", "interval"];

const default_interval = "1h";

// Names end up in archive prefixes and systemd unit names, so they stay plain.
const name_pattern = /^[A-Za-z0-9_.-]+$/;

// ── Loading ──────────────────────────────────────────────────────────────────

export function load_config(file_path: string | undefined = process.env.X_BACKUPS_CONFIG): Config {
  if (!file_path) throw new Error("X_BACKUPS_CONFIG is not set; point it at the repositories JSON file.");

  let text: string;
  try {
    text = readFileSync(file_path, "utf8");
  } catch (error) {
    throw new Error(`Cannot read the config file ${file_path}: ${(error as Error).message}`);
  }

  return parse_config(text, file_path);
}

export function parse_config(text: string, source: string): Config {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source} is not valid JSON: ${(error as Error).message}`);
  }

  if (!is_plain_object(document) || !Array.isArray(document.repositories)) {
    throw new Error(`${source} must hold an object with a "repositories" list.`);
  }

  const repositories = document.repositories.map((entry, index) => parse_repository(entry, index));

  const seen_ids = new Set<string>();
  for (const repository of repositories) {
    const id = repository.borg.id ?? repository.name;
    if (seen_ids.has(id)) throw new Error(`Repository '${repository.name}': id '${id}' is used twice.`);
    seen_ids.add(id);
  }

  return { repositories };
}

// ── One repository ───────────────────────────────────────────────────────────

function parse_repository(entry: unknown, index: number): RepositoryConfig {
  if (!is_plain_object(entry)) throw new Error(`Repository ${index + 1}: must be an object.`);

  const name = entry.name;
  if (typeof name !== "string" || !name_pattern.test(name)) {
    throw new Error(`Repository ${index + 1}: name must be letters, digits, '.', '_' or '-'.`);
  }

  const fail = (problem: string): never => {
    throw new Error(`Repository '${name}': ${problem}`);
  };

  const host = optional_string(entry, "host", fail);
  const ssh_user = optional_string(entry, "ssh_user", fail);
  if (ssh_user !== null && host === null) fail("ssh_user is set without a host.");

  const interval = entry.interval ?? default_interval;
  if (!is_field_kind(interval, "duration")) fail(`interval must be a duration such as "1h", not ${JSON.stringify(interval)}.`);
  const interval_in_seconds = parse_duration(interval as number | string);
  if (interval_in_seconds <= 0) fail("interval must be longer than zero.");

  const borg: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(entry)) {
    if (own_fields.includes(field)) continue;
    if (!Object.hasOwn(borg_fields, field)) fail(`unknown field '${field}'.`);

    const kind = borg_fields[field as keyof BorgConfig];
    if (!is_field_kind(value, kind)) fail(`${field} must be ${describe_kind(kind)}, not ${JSON.stringify(value)}.`);
    borg[field] = value;
  }
  if (typeof borg.repo !== "string" || borg.repo === "") fail("repo is required.");

  return { name, host, ssh_user, interval_in_seconds, borg: borg as BorgConfig };
}

function optional_string(entry: Record<string, unknown>, field: string, fail: (problem: string) => never): string | null {
  const value = entry[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value === "") fail(`${field} must be a non-empty string.`);
  return value as string;
}

// ── Field checks ─────────────────────────────────────────────────────────────

function is_field_kind(value: unknown, kind: FieldKind): boolean {
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

function is_plain_object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
