// Reads the config: hosts, repositories, sources and jobs, their field checks and cross-references, the defaults a
// file may set, and the targets each job expands into, each the repository config the poller watches.

// ── Imports ──────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";

import { parse_duration } from "./borg/durations.ts";
import { BorgRepository, type BorgConfig, type TargetScope } from "./borg/repository.ts";
import { as_list } from "./borg/shell.ts";
import { repo_location } from "./map.ts";
import type { TargetKey } from "./store.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

// Where an entry came from: the file the Nix module writes, or the page.
export type ConfigSource = "declared" | "page";

export type EntityKind = "hosts" | "repositories" | "sources" | "jobs";

export const entity_kinds: EntityKind[] = ["hosts", "repositories", "sources", "jobs"];

// A managed host runs the X-Backups agent; a storage-only host only holds repositories reached through borg serve.
export type HostKind = "managed" | "storage-only";

export interface HostEntity {
  name: string;
  kind: HostKind;
  // The host's network name, shown on the page; a managed host with none is this server, run by its built-in agent.
  address: string | null;
  borg: BorgConfig;
  source: ConfigSource;
  // The flat entry this entity was expanded from, or null for one written as an entity.
  expanded_from: string | null;
}

export interface RepositoryEntity {
  name: string;
  // The host whose disk holds the repository.
  host: string;
  id: string;
  // The managed host that polls the repository when no job writes to it.
  poll_via: string;
  // The URL a client host reaches the repository by, where it differs from repo.
  repo_by_host: Record<string, string>;
  interval_in_seconds: number;
  borg: BorgConfig;
  source: ConfigSource;
  expanded_from: string | null;
  // The targets that poll the repository, and the one that offers its own actions such as compact.
  targets: string[];
  actions_target: string | null;
}

export interface SourceEntity {
  name: string;
  host: string;
  borg: BorgConfig;
  source: ConfigSource;
  expanded_from: string | null;
}

export interface JobEntity {
  name: string;
  sources: string[];
  repositories: string[];
  borg: BorgConfig;
  source: ConfigSource;
  expanded_from: string | null;
}

export interface Entities {
  hosts: HostEntity[];
  repositories: RepositoryEntity[];
  sources: SourceEntity[];
  jobs: JobEntity[];
}

// The entities a target is built from.
export interface TargetEntities {
  job: string | null;
  host: string;
  repository: string;
  sources: string[];
}

// One target: a job's sources on one host to one repository, a repository only watched, or a flat entry.
export interface RepositoryConfig {
  name: string;
  // The host a flat entry names, or a job's host's address; no host means this machine. Commands run on target_key's host.
  host: string | null;
  interval_in_seconds: number;
  borg: BorgConfig;
  source: ConfigSource;
  // Absent on a config built by hand, which counts as a flat entry.
  target?: TargetEntities;
  scope?: TargetScope;
}

export interface Config {
  repositories: RepositoryConfig[];
  entities?: Entities;
}

// What a config file holds before its entries are checked: the entities, and defaults for every repository.
export interface ConfigDocument {
  defaults: Record<string, unknown>;
  hosts: Record<string, unknown>[];
  repositories: Record<string, unknown>[];
  sources: Record<string, unknown>[];
  jobs: Record<string, unknown>[];
}

// An entry with where it came from and its place in that file's list, for naming it in an error.
export interface TaggedEntry {
  entry: unknown;
  source: ConfigSource;
  index: number;
}

export type EntityLists = Record<EntityKind, TaggedEntry[]>;

// A bad config, naming the field at fault when there is one, so the page can show the message beside it.
export class ConfigError extends Error {
  readonly field: string | null;

  constructor(message: string, field: string | null = null) {
    super(message);
    this.name = "ConfigError";
    this.field = field;
  }
}

export type FieldKind = "string" | "number" | "boolean" | "duration" | "number_or_string" | "list" | "durations" | "strings";

// ── Fields ───────────────────────────────────────────────────────────────────

// Typed against BorgConfig, so a field added there fails to compile until it is listed here.
export const borg_fields: { [field in keyof Required<BorgConfig>]: FieldKind } = {
  id: "string",
  timeout: "duration",
  repo: "string",
  max_age: "duration",
  warn_age: "duration",
  quota: "number_or_string",
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

// The borg fields each entity holds; max_age and warn_age sit on both a job and a repository only watched.
const host_borg_fields = [
  "ssh_key", "rsh", "require_sudo", "borg_bin", "cache_dir", "job_nice", "job_io_idle", "inhibit_sleep", "skip_when_unreachable",
  "skip_while_active", "job_lock",
] as const;
const repository_borg_fields = [
  "repo", "borg_version", "passphrase", "passphrase_file", "passphrase_command", "quota", "lock_wait", "allow_delete", "allow_purge",
  "purge_match", "check_units", "check_kinds", "check_verify_data", "check_max_age", "check_warn_age", "timeout", "list_archives",
  "collect_stats", "browse_limit", "restore_dir", "max_age", "warn_age",
] as const;
const source_borg_fields = ["source_paths", "exclude", "exclude_from", "exclude_caches", "exclude_if_present", "one_file_system"] as const;
const job_borg_fields = [
  "compression", "archive_prefix", "keep_within", "keep_last", "keep_secondly", "keep_minutely", "keep_hourly", "keep_daily",
  "keep_weekly", "keep_monthly", "keep_yearly", "prune_match", "max_age", "warn_age", "canary_path", "canary_interval",
  "canary_warn_age", "canary_max_age", "backup_lock_wait", "prune_after_backup", "compact_after_backup",
] as const;

type HomedField = (typeof host_borg_fields | typeof repository_borg_fields | typeof source_borg_fields | typeof job_borg_fields)[number];
type UnhomedField = Exclude<keyof BorgConfig, HomedField | "id">;

// Stops compiling, naming the field, while a BorgConfig field other than id has no entity to live on.
export const every_field_homed: [UnhomedField] extends [never] ? true : UnhomedField = true;

const entity_borg_fields: Record<EntityKind, readonly (keyof BorgConfig)[]> = {
  hosts: host_borg_fields,
  repositories: repository_borg_fields,
  sources: source_borg_fields,
  jobs: job_borg_fields,
};

// The fields of each entity that are X-Backups' own rather than borg's.
const entity_own_fields: Record<EntityKind, Record<string, FieldKind>> = {
  hosts: { name: "string", kind: "string", address: "string" },
  repositories: { name: "string", host: "string", id: "string", poll_via: "string", repo_by_host: "strings", interval: "duration" },
  sources: { name: "string", host: "string" },
  jobs: { name: "string", sources: "list", repositories: "list" },
};

// The own fields of a flat entry, which holds every borg field as well.
const own_fields: Record<string, FieldKind> = { name: "string", host: "string", interval: "duration" };

// A flat entry's host and ssh_user once named where X-Backups logged in over SSH; ssh_user is still accepted there, and unused.
const flat_only_fields: Record<string, FieldKind> = { ssh_user: "string" };

// Fields X-Backups no longer reads, with why, so a config still setting them is told rather than silently changed.
const removed_fields: Record<string, string> = {
  ssh_user: "ssh_user is no longer used: X-Backups reaches each managed host through the agent it runs, which replaces SSH.",
};

const entity_labels: Record<EntityKind, string> = { hosts: "Host", repositories: "Repository", sources: "Source", jobs: "Job" };

const host_kinds: HostKind[] = ["managed", "storage-only"];

// A flat entry without a host runs on this machine, which its timers already call local.
export const own_host_name = "local";

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

// Every field a flat entry may hold with its kind, own fields first, for building a form.
export function field_list(): { name: string; kind: FieldKind }[] {
  return [...Object.entries(own_fields), ...Object.entries(borg_fields)].map(([name, kind]) => ({ name, kind }));
}

// Every field an entity of the kind may hold with its kind, own fields first.
export function entity_field_list(kind: EntityKind): { name: string; kind: FieldKind }[] {
  return [
    ...Object.entries(entity_own_fields[kind]).map(([name, field_kind]) => ({ name, kind: field_kind })),
    ...entity_borg_fields[kind].map((name) => ({ name, kind: borg_fields[name] })),
  ];
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
  const lists = Object.fromEntries(entity_kinds.map((kind) => [kind, tag_entries(document[kind], "declared")])) as EntityLists;
  return compile_config(lists, document.defaults);
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
  for (const kind of entity_kinds) {
    if (document[kind] !== undefined && !Array.isArray(document[kind])) throw new Error(`${source}: "${kind}" must be a list.`);
  }
  const defaults = document.defaults ?? {};
  if (!is_plain_object(defaults)) throw new Error(`${source}: "defaults" must be an object.`);
  check_defaults(defaults, source);
  const list = (kind: EntityKind) => (document[kind] ?? []) as Record<string, unknown>[];
  return { defaults, hosts: list("hosts"), repositories: list("repositories"), sources: list("sources"), jobs: list("jobs") };
}

export function tag_entries(entries: unknown[], source: ConfigSource): TaggedEntry[] {
  return entries.map((entry, index) => ({ entry, source, index }));
}

export function check_defaults(defaults: Record<string, unknown>, source: string): void {
  for (const [field, value] of Object.entries(defaults)) {
    const setting = default_settings[field];
    if (setting === undefined) throw new ConfigError(`${source}: unknown default '${field}'; use ${Object.keys(default_settings).join(", ")}.`, field);
    if (!is_field_kind(value, setting.kind)) throw new ConfigError(`${source}: default ${field} must be ${describe_kind(setting.kind)}, not ${JSON.stringify(value)}.`, field);
  }
}

// ── Compiling ────────────────────────────────────────────────────────────────

interface EntityMaps {
  hosts: Map<string, HostEntity>;
  repositories: Map<string, RepositoryEntity>;
  sources: Map<string, SourceEntity>;
  jobs: Map<string, JobEntity>;
}

// Checks every entry and how they refer to each other, then builds the targets the poller watches.
export function compile_config(lists: EntityLists, defaults: Record<string, unknown>): Config {
  const maps: EntityMaps = { hosts: new Map(), repositories: new Map(), sources: new Map(), jobs: new Map() };
  for (const tagged of lists.hosts) add_entity(maps.hosts, parse_host(tagged), "hosts");
  const written_hosts = new Set(maps.hosts.keys());

  const flat_targets = new Map<string, RepositoryConfig>();
  const written_poll_via = new Map<string, string>();
  for (const tagged of lists.repositories) {
    if (is_flat_entry(tagged.entry, written_hosts)) {
      const target = parse_flat_entry(tagged.entry, tagged.index, defaults, tagged.source);
      expand_flat_entry(target, maps);
      flat_targets.set(target.name, target);
      continue;
    }
    const { repository, poll_via } = parse_repository(tagged, defaults);
    add_entity(maps.repositories, repository, "repositories");
    if (poll_via !== null) written_poll_via.set(repository.name, poll_via);
  }
  for (const tagged of lists.sources) add_entity(maps.sources, parse_source(tagged), "sources");
  for (const tagged of lists.jobs) add_entity(maps.jobs, parse_job(tagged), "jobs");

  check_references(maps, written_poll_via);
  const repositories = build_targets(maps, flat_targets, defaults);
  return {
    repositories,
    entities: { hosts: [...maps.hosts.values()], repositories: [...maps.repositories.values()], sources: [...maps.sources.values()], jobs: [...maps.jobs.values()] },
  };
}

function add_entity<Entity extends { name: string }>(map: Map<string, Entity>, entity: Entity, kind: EntityKind): void {
  if (map.has(entity.name)) throw new ConfigError(`${entity_labels[kind]} '${entity.name}' is defined twice.`, "name");
  map.set(entity.name, entity);
}

// An entry of today's shape: its host is an address rather than a host's name, or it holds fields a repository does not.
function is_flat_entry(entry: unknown, written_hosts: Set<string>): boolean {
  if (!is_plain_object(entry)) return true;
  if (entry.poll_via !== undefined || entry.repo_by_host !== undefined) return false;
  if (typeof entry.host !== "string" || !written_hosts.has(entry.host)) return true;
  const own = entity_own_fields.repositories;
  const borg = entity_borg_fields.repositories as readonly string[];
  return Object.keys(entry).some((field) => !Object.hasOwn(own, field) && !borg.includes(field));
}

// ── Entities ─────────────────────────────────────────────────────────────────

type Fail = (problem: string, field?: string | null) => never;

// The entry's name and a way to fail naming it, once it is an object with a plain name.
function named_entry(tagged: TaggedEntry, kind: EntityKind): { entry: Record<string, unknown>; name: string; fail: Fail } {
  const label = entity_labels[kind];
  const entry = tagged.entry;
  if (!is_plain_object(entry)) throw new ConfigError(`${label} ${tagged.index + 1}: must be an object.`);
  const name = entry.name;
  if (typeof name !== "string" || !name_pattern.test(name)) {
    throw new ConfigError(`${label} ${tagged.index + 1}: name must be letters, digits, '.', '_' or '-'.`, "name");
  }
  const fail: Fail = (problem, field = null) => {
    throw new ConfigError(`${label} '${name}': ${problem}`, field);
  };
  return { entry, name, fail };
}

// Checks each field's kind against the entity's own and borg fields, giving the borg ones.
function entity_borg(entry: Record<string, unknown>, kind: EntityKind, fail: Fail): BorgConfig {
  const own = entity_own_fields[kind];
  const homed = entity_borg_fields[kind] as readonly string[];
  const borg: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(entry)) {
    if (Object.hasOwn(removed_fields, field)) fail(removed_fields[field], field);
    const field_kind = Object.hasOwn(own, field) ? own[field] : homed.includes(field) ? borg_fields[field as keyof BorgConfig] : null;
    if (field_kind === null) fail(`unknown field '${field}'.`, field);
    if (!is_field_kind(value, field_kind!)) fail(`${field} must be ${describe_kind(field_kind!)}, not ${JSON.stringify(value)}.`, field);
    if (!Object.hasOwn(own, field)) borg[field] = value;
  }
  return borg as BorgConfig;
}

function parse_host(tagged: TaggedEntry): HostEntity {
  const { entry, name, fail } = named_entry(tagged, "hosts");
  const borg = entity_borg(entry, "hosts", fail);
  const kind = (entry.kind ?? "managed") as HostKind;
  if (!host_kinds.includes(kind)) fail(`kind must be ${host_kinds.map((item) => `"${item}"`).join(" or ")}, not ${JSON.stringify(entry.kind)}.`, "kind");
  const address = optional_string(entry, "address", fail);
  return { name, kind, address, borg, source: tagged.source, expanded_from: null };
}

function parse_repository(tagged: TaggedEntry, defaults: Record<string, unknown>): { repository: RepositoryEntity; poll_via: string | null } {
  const { entry, name, fail } = named_entry(tagged, "repositories");
  const borg = entity_borg(entry, "repositories", fail);
  const host = optional_string(entry, "host", fail) ?? fail("host is required.", "host");
  if (typeof borg.repo !== "string" || borg.repo === "") fail("repo is required.", "repo");
  const repo_by_host = (entry.repo_by_host ?? {}) as Record<string, string>;
  for (const [client, url] of Object.entries(repo_by_host)) {
    if (url === "") fail(`repo_by_host.${client} must be a non-empty string.`, "repo_by_host");
  }
  const repository: RepositoryEntity = {
    name, host, id: optional_string(entry, "id", fail) ?? name, poll_via: host, repo_by_host,
    interval_in_seconds: interval_of(entry, defaults, fail), borg, source: tagged.source, expanded_from: null, targets: [], actions_target: null,
  };
  return { repository, poll_via: optional_string(entry, "poll_via", fail) };
}

function parse_source(tagged: TaggedEntry): SourceEntity {
  const { entry, name, fail } = named_entry(tagged, "sources");
  const borg = entity_borg(entry, "sources", fail);
  const host = optional_string(entry, "host", fail) ?? fail("host is required.", "host");
  if (as_list(borg.source_paths).length === 0) fail("source_paths is required.", "source_paths");
  return { name, host, borg, source: tagged.source, expanded_from: null };
}

function parse_job(tagged: TaggedEntry): JobEntity {
  const { entry, name, fail } = named_entry(tagged, "jobs");
  const borg = entity_borg(entry, "jobs", fail);
  const sources = [...new Set(as_list(entry.sources))];
  const repositories = [...new Set(as_list(entry.repositories))];
  if (sources.length === 0) fail("needs at least one source.", "sources");
  if (repositories.length === 0) fail("needs at least one repository.", "repositories");
  return { name, sources, repositories, borg, source: tagged.source, expanded_from: null };
}

function interval_of(entry: Record<string, unknown>, defaults: Record<string, unknown>, fail: Fail): number {
  const interval = entry.interval ?? defaults.interval ?? default_settings.interval.fallback;
  if (!is_field_kind(interval, "duration")) fail(`interval must be a duration such as "1h", not ${JSON.stringify(interval)}.`, "interval");
  const interval_in_seconds = parse_duration(interval as number | string);
  if (interval_in_seconds <= 0) fail("interval must be longer than zero.", "interval");
  return interval_in_seconds;
}

function optional_string(entry: Record<string, unknown>, field: string, fail: Fail): string | null {
  const value = entry[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value === "") fail(`${field} must be a non-empty string.`, field);
  return value as string;
}

// ── Flat entries ─────────────────────────────────────────────────────────────

// An entry of today's shape, every field on one repository, checked as one target.
export function parse_flat_entry(entry: unknown, index: number, defaults: Record<string, unknown> = {}, source: ConfigSource = "declared"): RepositoryConfig {
  if (!is_plain_object(entry)) throw new ConfigError(`Repository ${index + 1}: must be an object.`);

  const name = entry.name;
  if (typeof name !== "string" || !name_pattern.test(name)) {
    throw new ConfigError(`Repository ${index + 1}: name must be letters, digits, '.', '_' or '-'.`, "name");
  }

  const fail = (problem: string, field: string | null = null): never => {
    throw new ConfigError(`Repository '${name}': ${problem}`, field);
  };

  const host = optional_string(entry, "host", fail);
  optional_string(entry, "ssh_user", fail);
  const interval_in_seconds = interval_of(entry, defaults, fail);

  const borg: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(entry)) {
    if (Object.hasOwn(own_fields, field) || Object.hasOwn(flat_only_fields, field)) continue;
    if (!Object.hasOwn(borg_fields, field)) fail(`unknown field '${field}'.`, field);

    const kind = borg_fields[field as keyof BorgConfig];
    if (!is_field_kind(value, kind)) fail(`${field} must be ${describe_kind(kind)}, not ${JSON.stringify(value)}.`, field);
    borg[field] = value;
  }
  if (typeof borg.repo !== "string" || borg.repo === "") fail("repo is required.", "repo");
  fill_defaults(borg, defaults);
  check_buildable(name, borg, fail);

  return { name, host, interval_in_seconds, borg: borg as BorgConfig, source };
}

// Adds the host it runs on and the one its repo URL reaches, a repository, a source when it has paths, and a job, all
// named after the entry; its target keeps the entry's own fields, since two entries on one host may set them apart.
function expand_flat_entry(target: RepositoryConfig, maps: EntityMaps): void {
  const { name, borg, source } = target;
  // An entry with no host runs on this server, which a written host with no address names.
  const written_own = [...maps.hosts.values()].find((host) => host.expanded_from === null && is_own_host(host));
  const runs_on = target.host ?? written_own?.name ?? own_host_name;
  ensure_host(maps.hosts, {
    name: runs_on, kind: "managed", address: target.host, borg: pick(borg, host_borg_fields), source, expanded_from: name,
  });
  const stored = repo_location(borg.repo!).host;
  if (stored !== null) ensure_host(maps.hosts, { name: stored, kind: "storage-only", address: stored, borg: {}, source, expanded_from: name });

  add_entity(maps.repositories, {
    name, host: stored ?? runs_on, id: borg.id ?? name, poll_via: runs_on, repo_by_host: {}, interval_in_seconds: target.interval_in_seconds,
    borg: pick(borg, repository_borg_fields), source, expanded_from: name, targets: [], actions_target: null,
  }, "repositories");
  const sources = as_list(borg.source_paths).length > 0 ? [name] : [];
  if (sources.length > 0) add_entity(maps.sources, { name, host: runs_on, borg: pick(borg, source_borg_fields), source, expanded_from: name }, "sources");
  add_entity(maps.jobs, { name, sources, repositories: [name], borg: pick(borg, job_borg_fields), source, expanded_from: name }, "jobs");
  target.target = { job: name, host: runs_on, repository: name, sources };
}

// Flat entries on one host share it; a written host of that name wins, and a managed one over a storage host.
function ensure_host(hosts: Map<string, HostEntity>, host: HostEntity): void {
  const current = hosts.get(host.name);
  if (current === undefined || (current.expanded_from !== null && current.kind === "storage-only" && host.kind === "managed")) hosts.set(host.name, host);
}

function pick(borg: BorgConfig, fields: readonly (keyof BorgConfig)[]): BorgConfig {
  return Object.fromEntries(fields.filter((field) => borg[field] !== undefined).map((field) => [field, borg[field]])) as BorgConfig;
}

// ── References ───────────────────────────────────────────────────────────────

// Checks each name an entity gives for another, and settles which host polls each repository.
function check_references(maps: EntityMaps, written_poll_via: Map<string, string>): void {
  const host_named = (name: string, owner: string, field: string): HostEntity => {
    const host = maps.hosts.get(name);
    if (host === undefined) throw new ConfigError(`${owner}: no host named '${name}'.`, field);
    return host;
  };

  const own_hosts = [...maps.hosts.values()].filter(is_own_host);
  if (own_hosts.length > 1) {
    const [first, second] = own_hosts;
    throw new ConfigError(
      `Hosts '${first.name}' and '${second.name}' both leave out address, but only this server's own host may; give the other its address.`,
      "address",
    );
  }

  for (const source of maps.sources.values()) {
    const host = host_named(source.host, `Source '${source.name}'`, "host");
    if (host.kind !== "managed") throw new ConfigError(`Source '${source.name}': host '${host.name}' is storage-only, so it has no folders to back up.`, "host");
  }
  for (const job of maps.jobs.values()) {
    if (job.expanded_from !== null) continue;
    for (const name of job.sources) {
      if (!maps.sources.has(name)) throw new ConfigError(`Job '${job.name}': no source named '${name}'.`, "sources");
    }
    for (const name of job.repositories) {
      if (!maps.repositories.has(name)) throw new ConfigError(`Job '${job.name}': no repository named '${name}'.`, "repositories");
    }
  }

  const seen_ids = new Set<string>();
  for (const repository of maps.repositories.values()) {
    const owner = `Repository '${repository.name}'`;
    if (seen_ids.has(repository.id)) throw new ConfigError(`${owner}: id '${repository.id}' is used twice.`, "id");
    seen_ids.add(repository.id);
    if (repository.expanded_from !== null) continue;

    const host = host_named(repository.host, owner, "host");
    for (const client of Object.keys(repository.repo_by_host)) host_named(client, owner, "repo_by_host");
    const written = written_poll_via.get(repository.name);
    if (written !== undefined) {
      if (host_named(written, owner, "poll_via").kind !== "managed") throw new ConfigError(`${owner}: poll_via '${written}' is storage-only; it must name a managed host.`, "poll_via");
      repository.poll_via = written;
      continue;
    }
    if (host.kind === "managed") continue;
    const writer = [...maps.jobs.values()].find((job) => job.expanded_from === null && job.repositories.includes(repository.name));
    if (writer === undefined) {
      throw new ConfigError(`${owner}: its host '${host.name}' is storage-only and no job writes to it, so poll_via must name the managed host that polls it.`, "poll_via");
    }
    repository.poll_via = maps.sources.get(writer.sources[0])!.host;
  }
}

// ── Targets ──────────────────────────────────────────────────────────────────

// Flat entries and repositories only watched in their file's order, then each job's targets, one per source host and repository.
function build_targets(maps: EntityMaps, flat_targets: Map<string, RepositoryConfig>, defaults: Record<string, unknown>): RepositoryConfig[] {
  const job_targets: RepositoryConfig[] = [];
  for (const job of maps.jobs.values()) {
    if (job.expanded_from !== null) continue;
    const by_host = new Map<string, SourceEntity[]>();
    for (const name of job.sources) {
      const source = maps.sources.get(name)!;
      by_host.set(source.host, [...(by_host.get(source.host) ?? []), source]);
    }
    for (const [host, sources] of by_host) {
      for (const repository of job.repositories) {
        job_targets.push(job_target(job, maps.hosts.get(host)!, sources, maps.repositories.get(repository)!, defaults));
      }
    }
  }

  const targets: RepositoryConfig[] = [];
  for (const repository of maps.repositories.values()) {
    if (repository.expanded_from !== null) targets.push(flat_targets.get(repository.name)!);
    else if (!job_targets.some((target) => target.target!.repository === repository.name)) {
      targets.push(watch_target(repository, maps.hosts.get(repository.poll_via)!, defaults));
    }
  }
  targets.push(...job_targets);

  // Compact and the repository check act on the whole repository, so only the target polling from poll_via offers them.
  for (const repository of maps.repositories.values()) {
    const own = targets.filter((target) => target.target!.repository === repository.name);
    const chosen = own.find((target) => target.target!.host === repository.poll_via) ?? own[0];
    repository.targets = own.map(target_id);
    repository.actions_target = target_id(chosen);
    for (const target of own) {
      if (target !== chosen) target.scope = { ...target.scope, repository_actions_on: target_id(chosen) };
    }
  }
  return targets;
}

// The managed host with no address, which is this server and is run by the agent built into it.
export function is_own_host(host: HostEntity): boolean {
  return host.kind === "managed" && host.address === null;
}

// The name of this server's own host, whose commands its built-in agent runs.
export function own_host(entities: Entities | null | undefined): string {
  return entities?.hosts.find(is_own_host)?.name ?? own_host_name;
}

export function target_id(target: RepositoryConfig): string {
  return target.borg.id ?? target.name;
}

// The target's id with the host, job and repository it is built from; a config built by hand counts as a flat entry.
export function target_key(target: RepositoryConfig): TargetKey {
  const entities = target.target;
  if (entities !== undefined) return { target_id: target_id(target), host: entities.host, job: entities.job, repository: entities.repository };
  return { target_id: target_id(target), host: target.host ?? own_host_name, job: target.name, repository: target.name };
}

// One job's sources on one host to one repository, its archives named for both so prune and freshness tell targets apart.
function job_target(job: JobEntity, host: HostEntity, sources: SourceEntity[], repository: RepositoryEntity, defaults: Record<string, unknown>): RepositoryConfig {
  const id = `${job.name}:${host.name}:${repository.name}`;
  const archive_prefix = `${job.borg.archive_prefix ?? job.name}-${host.name}`;
  // A job judges freshness by its own ages, so a watched repository's ages stay out.
  const repository_borg = pick(repository.borg, repository_borg_fields.filter((field) => field !== "max_age" && field !== "warn_age"));
  const borg: Record<string, unknown> = {
    ...host.borg,
    ...repository_borg,
    repo: repository.repo_by_host[host.name] ?? repository.borg.repo,
    ...merged_sources(job, host, sources),
    ...job.borg,
    id,
    archive_prefix,
  };
  // The stamp's shape keeps job web on host odin from matching the archives of host odin-2.
  borg.prune_match ??= `${archive_prefix}-????-??-??T*`;
  fill_defaults(borg, defaults);
  check_buildable(id, borg, (problem) => {
    throw new ConfigError(`Job '${job.name}' from '${host.name}' to '${repository.name}': ${problem}`);
  });
  return {
    name: id, host: host.address, interval_in_seconds: repository.interval_in_seconds, borg: borg as BorgConfig,
    source: job.source, target: { job: job.name, host: host.name, repository: repository.name, sources: sources.map((source) => source.name) },
    scope: { list_match: borg.prune_match as string },
  };
}

// A repository no job writes to, polled from poll_via for its archives, checks and freshness.
function watch_target(repository: RepositoryEntity, host: HostEntity, defaults: Record<string, unknown>): RepositoryConfig {
  const borg: Record<string, unknown> = { ...host.borg, ...repository.borg, repo: repository.repo_by_host[host.name] ?? repository.borg.repo, id: repository.id };
  fill_defaults(borg, defaults);
  check_buildable(repository.name, borg, (problem) => {
    throw new ConfigError(`Repository '${repository.name}': ${problem}`);
  });
  return {
    name: repository.name, host: host.address, interval_in_seconds: repository.interval_in_seconds, borg: borg as BorgConfig,
    source: repository.source, target: { job: null, host: host.name, repository: repository.name, sources: [] },
  };
}

// The paths and excludes of a job's sources on one host, which go into one archive, so their single settings must agree.
function merged_sources(job: JobEntity, host: HostEntity, sources: SourceEntity[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const field of ["source_paths", "exclude", "exclude_if_present"] as const) {
    const union = [...new Set(sources.flatMap((source) => as_list(source.borg[field])))];
    if (union.length > 0) merged[field] = union;
  }
  for (const field of ["exclude_from", "exclude_caches", "one_file_system"] as const) {
    const given = sources.filter((source) => source.borg[field] !== undefined);
    if (given.length === 0) continue;
    const differing = given.find((source) => source.borg[field] !== given[0].borg[field]);
    if (differing !== undefined) {
      throw new ConfigError(`Job '${job.name}': sources '${given[0].name}' and '${differing.name}' on host '${host.name}' give different ${field}, so they cannot share an archive.`, "sources");
    }
    merged[field] = given[0].borg[field];
  }
  return merged;
}

// Unset fields take the file's defaults; interval is the repository's own.
function fill_defaults(borg: Record<string, unknown>, defaults: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(defaults)) {
    if (field !== "interval" && borg[field] === undefined) borg[field] = value;
  }
}

// The repository checks how its fields fit together, such as pruning after a backup with no retention.
function check_buildable(name: string, borg: Record<string, unknown>, fail: (problem: string) => never): void {
  try {
    new BorgRepository(name, borg as BorgConfig);
  } catch (error) {
    fail(`${(error as Error).message}.`);
  }
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
    case "strings":
      return is_plain_object(value) && Object.values(value).every((item) => typeof item === "string");
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
    case "strings":
      return "an object of strings";
  }
}

export function is_plain_object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
