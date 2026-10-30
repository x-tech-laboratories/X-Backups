// The backup flow: each host's folders, the jobs that back them up and the repositories they write to on the hosts that
// store them, read from the configured hosts and repositories, or from the repo URL for a config built by hand.

// ── Imports ──────────────────────────────────────────────────────────────────

import { as_list } from "./borg/shell.ts";
import { target_key, type Entities, type HostEntity, type RepositoryConfig } from "./config.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface MapEntry {
  id: string;
  // The job that writes the target, or null for a repository that is only watched.
  job: string | null;
  // The repository it writes to.
  repository: string;
  // Where borg runs; null is this server.
  host: string | null;
  // The host holding the repository; null is this server, and absent reads it from the repo URL.
  stored_on?: string | null;
  repo: string | null;
  source_paths: string[];
}

export interface MapHost {
  id: string;
  name: string;
}

export interface MapSource {
  id: string;
  host: string;
  path: string;
}

export interface MapJob {
  id: string;
  // The folders it backs up, across every host it runs on.
  sources: string[];
}

export interface MapRepository {
  id: string;
  // The host whose disk holds the repository.
  stored_on: string;
  // The repository's folder on that host.
  path: string;
}

// One job's folders on one host written to one repository, or a repository only watched.
export interface MapTarget {
  id: string;
  job: string | null;
  repository: string;
  sources: string[];
}

export interface BackupMap {
  hosts: MapHost[];
  sources: MapSource[];
  jobs: MapJob[];
  repositories: MapRepository[];
  targets: MapTarget[];
}

// ── Building ─────────────────────────────────────────────────────────────────

// Hosts are matched by their first name, so odin.technet, Odin and an ssh repo on borg@odin.technet are one host.
export function backup_map(entries: MapEntry[], server_name: string): BackupMap {
  const hosts = new Map<string, MapHost>();
  const sources = new Map<string, MapSource>();
  const jobs = new Map<string, MapJob>();
  const repositories = new Map<string, MapRepository>();
  const add_host = (name: string) => {
    const id = host_id(name);
    if (!hosts.has(id)) hosts.set(id, { id, name: display_name(id) });
    return id;
  };

  const targets = entries.map((entry): MapTarget => {
    const runs_on = add_host(entry.host ?? server_name);
    const location = repo_location(entry.repo ?? "");
    const stored_on = entry.stored_on !== undefined ? add_host(entry.stored_on ?? server_name)
      : location.host === null ? runs_on : add_host(location.host);
    if (!repositories.has(entry.repository)) repositories.set(entry.repository, { id: entry.repository, stored_on, path: location.path });
    const source_ids = entry.source_paths.map((path) => {
      const id = `${runs_on}:${path}`;
      if (!sources.has(id)) sources.set(id, { id, host: runs_on, path });
      return id;
    });
    if (entry.job !== null) {
      const job = jobs.get(entry.job) ?? { id: entry.job, sources: [] };
      for (const id of source_ids) if (!job.sources.includes(id)) job.sources.push(id);
      jobs.set(entry.job, job);
    }
    return { id: entry.id, job: entry.job, repository: entry.repository, sources: source_ids };
  });

  return {
    hosts: [...hosts.values()],
    sources: [...sources.values()].sort((left, right) => left.path.localeCompare(right.path)),
    jobs: [...jobs.values()],
    repositories: [...repositories.values()],
    targets,
  };
}

// Each target as the map takes it, its hosts named by the configured hosts; a managed host with no address is this server.
export function map_entry(target: RepositoryConfig, entities: Entities | null): MapEntry {
  const key = target_key(target);
  const entry = { id: key.target_id, job: key.job, repository: key.repository, host: target.host, repo: target.borg.repo ?? null, source_paths: as_list(target.borg.source_paths) };
  if (entities === null || target.target === undefined) return entry;
  const host_named = (name: string) => {
    const host = entities.hosts.find((item) => item.name === name);
    return host === undefined || (host.kind === "managed" && host.address === null) ? null : host.name;
  };
  const repository = entities.repositories.find((item) => item.name === target.target!.repository);
  return { ...entry, host: host_named(target.target.host), stored_on: repository === undefined ? undefined : host_named(repository.host) };
}

// The configured host, source and job each map host, folder and job stands for, so the page can link them to their own pages.
export function map_links(entities: Entities | null, server_name: string): { hosts: Record<string, string>; sources: Record<string, string>; jobs: string[] } {
  const hosts: Record<string, string> = {};
  const sources: Record<string, string> = {};
  if (entities === null) return { hosts, sources, jobs: [] };
  const id_of = (host: HostEntity) => host_id(host.kind === "managed" && host.address === null ? server_name : host.name);
  for (const host of entities.hosts) hosts[id_of(host)] ??= host.name;
  for (const source of entities.sources) {
    const host = entities.hosts.find((item) => item.name === source.host);
    if (host === undefined) continue;
    for (const path of as_list(source.borg.source_paths)) sources[`${id_of(host)}:${path}`] ??= source.name;
  }
  return { hosts, sources, jobs: entities.jobs.map((job) => job.name) };
}

// The host a repo URL reaches and the folder on it; a plain path has no host, so it is on the machine borg runs on.
export function repo_location(repo: string): { host: string | null; path: string } {
  const url = /^ssh:\/\/(?:[^@/]+@)?(\[[^\]]+\]|[^:/]+)(?::\d+)?(\/.*)?$/.exec(repo);
  if (url) return { host: url[1].replace(/^\[|\]$/g, ""), path: url[2] ?? "/" };
  // borg's scp-like form, user@host:path.
  const scp = /^(?:[^@/:]+@)?([^:/]+):(.*)$/.exec(repo);
  if (scp) return { host: scp[1], path: scp[2] };
  return { host: null, path: repo };
}

// An address is kept whole, since its first part names nothing.
function host_id(name: string): string {
  const address = /^[\d.]+$/.test(name) || name.includes(":");
  return (address ? name : name.split(".")[0]).toLowerCase();
}

function display_name(id: string): string {
  return /^[a-z]/.test(id) ? id.charAt(0).toUpperCase() + id.slice(1) : id;
}
