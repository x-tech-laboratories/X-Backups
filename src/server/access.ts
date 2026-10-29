// What a user sees, from the jobs they are granted.
//
// A grant names a job, or a repository no job writes to. A job's grant shows its targets with their runs, events and
// archives, the sources and repositories it uses, and the hosts those are on. A repository's own runs, compact and
// check, show to whoever sees the repository. Acting on the whole repository (compact, check, break lock, deleting or
// purging archives) needs an admin, or a user who sees every job writing there. No grants at all means everything.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { Entities } from "./config.ts";
import type { TargetKey } from "./store.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export type Grant = { job: string } | { repository: string };

// A target as access reads it: the entities it is built from, and the sources it backs up.
export interface AccessTarget extends TargetKey {
  sources: string[];
}

// The configured targets and entities a scope is worked out from.
export interface World {
  targets: AccessTarget[];
  entities: Entities | null;
}

// Everything one user sees, by kind; null in its place means everything.
export interface Scope {
  targets: Set<string>;
  jobs: Set<string>;
  repositories: Set<string>;
  sources: Set<string>;
  hosts: Set<string>;
}

// One thing a user may or may not see; a run carries its target and repository, since a repository's own runs are
// seen with the repository.
export type Seen =
  | { kind: "target" | "event" | "archive"; target_id: string }
  | { kind: "run"; target_id: string; repository: string | null; run_kind: string }
  | { kind: "job" | "repository" | "source" | "host"; name: string };

// The actions that act on the whole repository rather than one job's archives.
export const repository_actions = new Set(["compact_repo", "check_repo", "break_lock", "delete_archive", "purge_preview", "purge_excluded"]);

// ── Scope ────────────────────────────────────────────────────────────────────

export function scope_of(grants: Grant[] | null, world: World): Scope | null {
  if (grants === null) return null;
  const granted_jobs = new Set(grants.flatMap((grant) => "job" in grant ? [grant.job] : []));
  const granted_repositories = new Set(grants.flatMap((grant) => "repository" in grant ? [grant.repository] : []));
  const scope: Scope = { targets: new Set(), jobs: new Set(), repositories: new Set(), sources: new Set(), hosts: new Set() };

  for (const target of world.targets) {
    const shown = target.job === null ? granted_repositories.has(target.repository) : granted_jobs.has(target.job);
    if (!shown) continue;
    scope.targets.add(target.target_id);
    if (target.job !== null) scope.jobs.add(target.job);
    scope.repositories.add(target.repository);
    scope.hosts.add(target.host);
    for (const source of target.sources) scope.sources.add(source);
  }
  // A granted repository stays seen once jobs write there, though their targets do not.
  for (const repository of granted_repositories) {
    if (world.targets.some((target) => target.repository === repository)) scope.repositories.add(repository);
  }

  const entities = world.entities;
  if (entities !== null) {
    for (const job of entities.jobs) {
      if (!granted_jobs.has(job.name)) continue;
      scope.jobs.add(job.name);
      for (const source of job.sources) scope.sources.add(source);
      for (const repository of job.repositories) scope.repositories.add(repository);
    }
    for (const source of entities.sources) if (scope.sources.has(source.name)) scope.hosts.add(source.host);
    for (const repository of entities.repositories) if (scope.repositories.has(repository.name)) scope.hosts.add(repository.host);
  }
  return scope;
}

// Whether a user with this scope sees the thing.
export function sees(scope: Scope | null, item: Seen): boolean {
  if (scope === null) return true;
  switch (item.kind) {
    case "target":
    case "event":
    case "archive":
      return scope.targets.has(item.target_id);
    case "run":
      return scope.targets.has(item.target_id)
        || (item.repository !== null && repository_run(item.run_kind) && scope.repositories.has(item.repository));
    case "job":
      return scope.jobs.has(item.name);
    case "repository":
      return scope.repositories.has(item.name);
    case "source":
      return scope.sources.has(item.name);
    case "host":
      return scope.hosts.has(item.name);
  }
}

// ── Repository rule ──────────────────────────────────────────────────────────

// A run of the repository's own tasks, run once for the whole repository; store.ts matches the same kinds in SQL.
export function repository_run(kind: string): boolean {
  return kind === "compact" || kind === "check" || kind.startsWith("check-");
}

// A run of one of repository_actions, which cancelling or running again needs the same access for.
export function acts_on_whole_repository(kind: string): boolean {
  return repository_run(kind) || kind === "delete" || kind === "purge" || kind === "purge-preview";
}

// The jobs that write to the repository.
export function writers(repository: string, world: World): string[] {
  const jobs = world.targets.flatMap((target) => target.repository === repository && target.job !== null ? [target.job] : []);
  for (const job of world.entities?.jobs ?? []) if (job.repositories.includes(repository)) jobs.push(job.name);
  return [...new Set(jobs)];
}

// Whether the scope may act on the whole repository: it sees the repository and every job writing there.
export function sees_whole_repository(scope: Scope | null, repository: string, world: World): boolean {
  if (scope === null) return true;
  return scope.repositories.has(repository) && writers(repository, world).every((job) => scope.jobs.has(job));
}

// ── Grants ───────────────────────────────────────────────────────────────────

// The grants an older grant on a target id or repository name becomes: the jobs writing to what it named, or the
// repository itself where no job writes there.
export function grants_from_repository(name: string, targets: TargetKey[]): Grant[] {
  const matched = targets.filter((target) => target.target_id === name || target.repository === name);
  if (matched.length === 0) return [{ repository: name }];
  return matched.map((target) => target.job === null ? { repository: target.repository } : { job: target.job });
}

// The same grants with duplicates dropped, in their first order.
export function distinct_grants(grants: Grant[]): Grant[] {
  const seen = new Set<string>();
  return grants.filter((grant) => {
    const key = "job" in grant ? `job\n${grant.job}` : `repository\n${grant.repository}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
