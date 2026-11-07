// Every job with its status rolled up from its targets, and one job's page: its sources and repositories, a target per
// host and repository with its freshness, its tasks and its runs.

import { Badge, StateBadge, type Tone } from "@x-tech-laboratories/x-libs/web/preact/badges";
import { Crumbs, Facts, Section, type Fact } from "@x-tech-laboratories/x-libs/web/preact/layout";
import { Empty, Loaded, Skeleton, use_resource } from "@x-tech-laboratories/x-libs/web/preact/states";
import { DataTable } from "@x-tech-laboratories/x-libs/web/preact/table";
import { Age } from "@x-tech-laboratories/x-libs/web/preact/time";
import { age, duration, size, stamp, until } from "@x-tech-laboratories/x-libs/web/format";
import { link } from "@x-tech-laboratories/x-libs/web/router";
import { overdue } from "../attention.ts";
import { api, query, type JobRow, type Level, type RepositorySummary, type Run, type SourceRow } from "../api.ts";
import { can } from "../session.ts";
import { HealthBadge, StatusBadge, use_changes } from "../ui.tsx";
import { RunsTable, touches } from "./shared.tsx";
import { config_link, OriginChip } from "./sources.tsx";
import { TasksTable } from "./tasks.tsx";

const level_rank = { critical: 0, warning: 1, ok: 2 } as const;

// ── Jobs ─────────────────────────────────────────────────────────────────────

export function JobsView() {
  const jobs = use_resource(() => api<JobRow[]>("/api/jobs"), []);
  use_changes((changes) => { if (touches(changes, null, ["repository", "run", "tasks", "config"])) jobs.reload(true); });
  return (
    <div class="page">
      <div class="page-title spread"><h1>Jobs</h1>{can("admin") && <a class="button" href={link(["settings", "new", "jobs"])}>Add job</a>}</div>
      <div>
        <Loaded resource={jobs} lines={5}>
          {(rows) => rows.length === 0
            ? <Empty title="No jobs yet." hint={can("admin") ? <a href={link(["settings", "new", "jobs"])}>Add a job in Settings</a> : "A job backs sources up to repositories; jobs are declared under services.x-backups.jobs."} />
            : <DataTable<JobRow> rows={rows} row_key={(job) => job.name} caption="Jobs" columns={[
              { label: "Job", cell: (job) => <a href={link(["jobs", job.name])}>{job.name}</a>, sort: (job) => job.name },
              { label: "Status", cell: (job) => <HealthBadge level={job.level} />, sort: (job) => job.level === null ? 3 : level_rank[job.level] },
              { label: "Sources", cell: (job) => job.sources.length === 0 ? <span class="muted">none</span> : job.sources.join(", ") },
              { label: "Repositories", cell: (job) => job.repositories.join(", ") },
              { label: "Targets", class: "number", cell: (job) => job.targets.length, sort: (job) => job.targets.length },
              { label: "Last backup", cell: (job) => <NewestBackup targets={job.targets} />, sort: (job) => newest_epoch(job.targets) },
              { label: "Next backup", cell: (job) => <NextBackup job={job} />, sort: (job) => job.tasks.find((task) => task.kind === "backup")?.next_due ?? null },
              { label: "From", cell: (job) => <OriginChip entity={job} /> },
            ]} />}
        </Loaded>
      </div>
    </div>
  );
}

function newest_epoch(targets: RepositorySummary[]): number | null {
  const epochs = targets.map((target) => target.last_backup_epoch).filter((epoch): epoch is number => epoch !== null);
  return epochs.length === 0 ? null : Math.max(...epochs);
}

function NewestBackup({ targets }: { targets: RepositorySummary[] }) {
  const epoch = newest_epoch(targets);
  return epoch === null ? <span class="muted">never</span> : <Age epoch={epoch} />;
}

function NextBackup({ job }: { job: JobRow }) {
  const task = job.tasks.find((item) => item.kind === "backup");
  if (task === undefined) return <span class="muted">—</span>;
  if (task.running) return <Badge tone="info">running</Badge>;
  if (task.waiting) return <Badge tone="warn" title={task.waiting}>waiting</Badge>;
  if (!task.enabled || task.next_due === null) return <span class="muted">{task.enabled ? "by hand" : "switched off"}</span>;
  return <span title={stamp(task.next_due)}>{until(task.next_due)}</span>;
}

// ── One job ──────────────────────────────────────────────────────────────────

export function JobView({ name }: { name: string }) {
  const job = use_resource(() => Promise.all([
    api<JobRow>(`/api/jobs/${encodeURIComponent(name)}`),
    api<SourceRow[]>("/api/sources"),
  ]), [name]);
  const runs = use_resource(() => api<Run[]>(`/api/runs${query({ job: name, limit: 20 })}`), [name]);
  const refresh = () => {
    job.reload(true);
    runs.reload(true);
  };
  use_changes((changes) => { if (touches(changes, null, ["repository", "run", "tasks", "config"])) refresh(); });

  // Every panel waits on the job, and a failure to load it shows once, in the header.
  const loaded = job.data;
  return (
    <div class="page">
      <Crumbs items={[["Jobs", link(["jobs"])], [name, null]]} />
      <div><Loaded resource={job} lines={2}>{([row]) => <JobHeader job={row} />}</Loaded></div>
      <Section title="Sources to repositories">
        <div>{loaded ? <JobFlow job={loaded[0]} sources={loaded[1]} /> : <Skeleton lines={2} />}</div>
      </Section>
      <Section title="Targets" tools={<span class="muted small">one per source host and repository</span>}>
        <div>{loaded ? <TargetsTable targets={loaded[0].targets} /> : <Skeleton lines={3} />}</div>
      </Section>
      <Section title="Tasks" tools={<a href={link(["schedules"])}>All schedules</a>}>
        <div>
          {loaded
            ? <TasksTable tasks={loaded[0].tasks} refresh={refresh} empty_hint="A job with sources has a backup task; prune needs a keep_* policy and the canary a canary_path." />
            : <Skeleton lines={3} />}
        </div>
      </Section>
      <Section title="Settings"><div>{loaded && <SettingsFacts job={loaded[0]} />}</div></Section>
      <Section title="Runs" tools={<a href={link(["runs"], { job: name })}>All runs of this job</a>}>
        <div>
          {loaded
            ? <Loaded resource={runs} lines={3}>{(rows) => <RunsTable runs={rows} with_repository refresh={refresh} />}</Loaded>
            : <Skeleton lines={3} />}
        </div>
      </Section>
    </div>
  );
}

function JobHeader({ job }: { job: JobRow }) {
  return (
    <header class="page-head">
      <div class="page-title"><h1>{job.name}</h1><HealthBadge level={job.level} /><OriginChip entity={job} /></div>
      <p class="muted" role="status" aria-live="polite">
        {`${job.targets.length} ${job.targets.length === 1 ? "target" : "targets"}`}
        {job.targets.some((target) => target.running_run) ? " · a run is going" : ""}
      </p>
      {can("admin") && <div class="head-actions"><a class="button" href={config_link(job, "jobs")}>Config</a></div>}
    </header>
  );
}

// The job's sources, grouped by host, beside the repositories they go to.
function JobFlow({ job, sources }: { job: JobRow; sources: SourceRow[] }) {
  return (
    <div class="columns">
      <div>
        <h3>Backs up</h3>
        {job.sources.length > 0
          ? (
            <ul class="plain-list">
              {job.sources.map((name) => {
                const source = sources.find((item) => item.name === name);
                return (
                  <li key={name}>
                    <a href={link(["sources", name])}>{name}</a>
                    {source && <span class="muted"> on <a href={link(["hosts", source.host])}>{source.host}</a>{` · ${source.paths.join(", ")}`}</span>}
                  </li>
                );
              })}
            </ul>
          )
          : <p class="muted">No sources: it only prunes or checks.</p>}
      </div>
      <div>
        <h3><span aria-hidden="true">→ </span>Into</h3>
        <ul class="plain-list">
          {job.repositories.map((name) => {
            const target = job.targets.find((item) => item.repository === name);
            return <li key={name}>{target ? <a href={link(["repositories", target.id])}>{name}</a> : name}</li>;
          })}
        </ul>
      </div>
    </div>
  );
}

function TargetsTable({ targets }: { targets: RepositorySummary[] }) {
  if (targets.length === 0) return <Empty title="No targets." hint="A target appears for each host the job's sources are on and each repository it writes to." />;
  return (
    <DataTable<RepositorySummary> rows={targets} row_key={(target) => target.id} caption="Targets" columns={[
      { label: "Host", cell: (target) => <a href={link(["hosts", target.host])}>{target.host}</a>, sort: (target) => target.host },
      { label: "Repository", cell: (target) => <a href={link(["repositories", target.id])}>{target.repository}</a>, sort: (target) => target.repository },
      { label: "Status", cell: (target) => <TargetStatus target={target} />, sort: (target) => level_rank[target.level] },
      { label: "Newest archive", cell: (target) => <Freshness target={target} />, sort: (target) => target.last_backup_epoch },
      { label: "Archives", class: "number", cell: (target) => target.archive_count ?? "—", sort: (target) => target.archive_count },
      { label: "Stored", class: "number", cell: (target) => size(target.stats?.deduplicated_size), sort: (target) => target.stats?.deduplicated_size ?? null },
      {
        label: "Last backup", cell: (target) => target.running_run
          ? <a class="chip chip-info" href={link(["runs", String(target.running_run.id)])}>{`${target.running_run.kind} running`}</a>
          : <span class="muted">{target.last_backup_epoch ? stamp(target.last_backup_epoch) : "never"}</span>,
      },
    ]} />
  );
}

const health_labels: Record<Level, [text: string, tone: Tone]> = { ok: ["OK", "good"], warning: ["Warning", "warn"], critical: ["Failing", "bad"] };

// The target's health, with the first reason it is not OK beneath and every reason on hover; one not polled yet says so.
function TargetStatus({ target }: { target: RepositorySummary }) {
  if (target.last_poll_epoch === null) return <StatusBadge status={null} />;
  return <>
    <StateBadge labels={health_labels} state={target.level} title={target.reasons.map((reason) => reason.text).join("\n")} />
    {target.reasons.slice(0, 1).map((reason) => <div key={reason.text} class="muted small">{reason.text}</div>)}
  </>;
}

// How old the newest archive is against its max age, in red once past it.
function Freshness({ target }: { target: RepositorySummary }) {
  const late = target.last_poll_epoch !== null && overdue(target);
  return (
    <span class={late ? "tone-bad" : undefined} title={target.last_backup_epoch ? stamp(target.last_backup_epoch) : undefined}>
      {target.last_backup_epoch ? age(target.last_backup_epoch) : "none yet"}{` · limit ${duration(target.max_age)}`}{late ? " · overdue" : ""}
    </span>
  );
}

function SettingsFacts({ job }: { job: JobRow }) {
  const entries = Object.entries(job.settings);
  if (entries.length === 0) return <p class="muted">Nothing set; each repository's own settings and the defaults apply.</p>;
  return <Facts layout="rows" rows={entries.map(([field, value]): Fact => [field, <code>{typeof value === "string" ? value : JSON.stringify(value)}</code>])} />;
}
