// Who may sign in, on the X-Libs account pages: what each role may do, and which jobs a user is granted.

import { AccountView as SharedAccountView, UsersView as SharedUsersView, type AccessWords } from "@x-tech-laboratories/x-libs/web/react/accounts";
import { use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { type ChangeEvent } from "react";
import { api, type RepositorySummary } from "../api.ts";
import { accounts, load_me, me, type Grant } from "../session.ts";

const words: AccessWords = {
  role_text: {
    viewer: "Sees the jobs it is granted; changes nothing.",
    operator: "Also runs actions, restores and downloads, and reads archive contents.",
    admin: "Also changes the config, users and tokens.",
  },
  access_text: (access) => grants_text(access as Grant[] | null),
};

// ── Pages ────────────────────────────────────────────────────────────────────

export function UsersView() {
  return <SharedUsersView client={accounts} me={me()!} access_editor={GrantsEditor} {...words} />;
}

export function AccountView() {
  return <SharedAccountView client={accounts} on_change={() => void load_me()} {...words} />;
}

// ── Grants ───────────────────────────────────────────────────────────────────

// What a user can be granted: each job with the repositories it writes to, and each repository no job writes to.
interface Grantable {
  jobs: { name: string; repositories: string[] }[];
  repositories: string[];
}

// The jobs and the repositories no job writes to, from the targets an admin sees.
function grantable_of(targets: RepositorySummary[]): Grantable {
  const jobs = new Map<string, Set<string>>();
  const repositories = new Set<string>();
  for (const target of targets) {
    if (target.job === null) repositories.add(target.repository);
    else jobs.set(target.job, (jobs.get(target.job) ?? new Set()).add(target.repository));
  }
  return {
    jobs: [...jobs].map(([name, written]) => ({ name, repositories: [...written].sort() })).sort((left, right) => left.name.localeCompare(right.name)),
    repositories: [...repositories].sort(),
  };
}

// What the grants show, in words.
function grants_text(grants: Grant[] | null): string {
  if (grants === null) return "everything";
  if (grants.length === 0) return "nothing";
  const jobs = grants.flatMap((grant) => "job" in grant ? [grant.job] : []);
  const repositories = grants.flatMap((grant) => "repository" in grant ? [grant.repository] : []);
  return [jobs.length > 0 && `jobs ${jobs.join(", ")}`, repositories.length > 0 && `repositories ${repositories.join(", ")}`].filter(Boolean).join("; ");
}

// Picks everything, or the jobs and repositories a user sees.
function GrantsEditor({ value, on_change }: { value: unknown; on_change: (value: unknown) => void }) {
  const grantable = use_resource(async () => grantable_of(await api<RepositorySummary[]>("/api/repositories").catch(() => [])), []);
  const choices = grantable.data ?? { jobs: [], repositories: [] };
  const held = (value ?? []) as Grant[];
  const held_jobs = held.flatMap((grant) => "job" in grant ? [grant.job] : []);
  const held_repositories = held.flatMap((grant) => "repository" in grant ? [grant.repository] : []);

  // A grant on something no longer configured stays listed, so saving keeps it unless it is unticked.
  const jobs = [
    ...choices.jobs,
    ...held_jobs.filter((job_name) => !choices.jobs.some((job) => job.name === job_name)).map((job_name) => ({ name: job_name, repositories: [] })),
  ];
  const repositories = [...choices.repositories, ...held_repositories.filter((repository) => !choices.repositories.includes(repository))];

  const toggle = (grant: Grant, on: boolean) => {
    const same = (other: Grant) => JSON.stringify(other) === JSON.stringify(grant);
    on_change(on ? [...held.filter((other) => !same(other)), grant] : held.filter((other) => !same(other)));
  };
  const checked = (event: ChangeEvent<HTMLInputElement>) => event.currentTarget.checked;

  return (
    <div>
      <label className="check"><input type="checkbox" checked={value === null} onChange={(event) => on_change(checked(event) ? null : [])} /> Everything, including jobs added later</label>
      <p className="muted small">A job shows its targets, runs and archives, and the sources, repositories and hosts it uses. Compacting, checking or deleting from a repository needs every job writing there.</p>
      <div className="check-list" hidden={value === null}>
        <fieldset className="check-group">
          <legend>Jobs</legend>
          {jobs.length === 0 ? <p className="muted small">No jobs are configured.</p> : jobs.map((job) => (
            <label key={job.name} className="check">
              <input type="checkbox" value={job.name} checked={held_jobs.includes(job.name)} onChange={(event) => toggle({ job: job.name }, checked(event))} />
              {` ${job.name}`}
              {job.repositories.length > 0 && <span className="muted small">{` to ${job.repositories.join(", ")}`}</span>}
            </label>
          ))}
        </fieldset>
        {repositories.length > 0 && (
          <fieldset className="check-group">
            <legend>Repositories no job writes to</legend>
            {repositories.map((repository) => (
              <label key={repository} className="check">
                <input type="checkbox" value={repository} checked={held_repositories.includes(repository)} onChange={(event) => toggle({ repository }, checked(event))} />
                {` ${repository}`}
              </label>
            ))}
          </fieldset>
        )}
      </div>
    </div>
  );
}
