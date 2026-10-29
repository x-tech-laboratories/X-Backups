// Which host's folders each repository backs up and which host stores it, read from the repositories' own config.

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface MapEntry {
  id: string;
  name: string;
  // Where borg runs; null is this server.
  host: string | null;
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

export interface MapRepository {
  id: string;
  // The host whose disk holds the repository.
  stored_on: string;
  // The repository's folder on that host.
  path: string;
  // The sources it backs up; none for a repository that is only watched.
  sources: string[];
}

export interface BackupMap {
  hosts: MapHost[];
  sources: MapSource[];
  repositories: MapRepository[];
}

// ── Building ─────────────────────────────────────────────────────────────────

// Hosts are matched by their first name, so odin.technet, Odin and an ssh repo on borg@odin.technet are one host.
export function backup_map(entries: MapEntry[], server_name: string): BackupMap {
  const hosts = new Map<string, MapHost>();
  const sources = new Map<string, MapSource>();
  const add_host = (name: string) => {
    const id = host_id(name);
    if (!hosts.has(id)) hosts.set(id, { id, name: display_name(id) });
    return id;
  };

  const repositories = entries.map((entry): MapRepository => {
    const runs_on = add_host(entry.host ?? server_name);
    const location = repo_location(entry.repo ?? "");
    const stored_on = location.host === null ? runs_on : add_host(location.host);
    const source_ids = entry.source_paths.map((path) => {
      const id = `${runs_on}:${path}`;
      if (!sources.has(id)) sources.set(id, { id, host: runs_on, path });
      return id;
    });
    return { id: entry.id, stored_on, path: location.path, sources: source_ids };
  });

  return {
    hosts: [...hosts.values()],
    sources: [...sources.values()].sort((left, right) => left.path.localeCompare(right.path)),
    repositories,
  };
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
