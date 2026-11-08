// What several pages show the same way: repository cards, the runs table, the events list, the timers table and the run filters.

import { describe_error } from "@x-tech-laboratories/x-libs/web/errors";
import { Chip, Chips, Verdict } from "@x-tech-laboratories/x-libs/web/react/badges";
import { confirm_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { Empty } from "@x-tech-laboratories/x-libs/web/react/states";
import { DataTable, type Sorting, type TableColumn } from "@x-tech-laboratories/x-libs/web/react/table";
import { toast } from "@x-tech-laboratories/x-libs/web/react/toasts";
import { Age } from "@x-tech-laboratories/x-libs/web/react/time";
import { age, duration, now_seconds, size, stamp, until } from "@x-tech-laboratories/x-libs/web/format";
import { link } from "@x-tech-laboratories/x-libs/web/router";
import { show_outcome } from "../actions.tsx";
import { overdue, timer_problem } from "../attention.ts";
import { api, type Change, type EventRow, type Run, type Outcome, type RepositorySummary, type TimerRow } from "../api.ts";
import { can } from "../session.ts";
import { LevelBadge, RunStateBadge, StatusBadge } from "../ui.tsx";

// ── Changes ──────────────────────────────────────────────────────────────────

// Loads a view's data again, resolving once it has, so a dialog can stay open until the page shows the result.
export type Refresh = () => Promise<unknown> | void;

// Whether any change concerns the repository (or any repository when none is named), of one of the kinds.
export function touches(changes: Change[] | null, target_id: string | null, kinds: Change["kind"][]): boolean {
  if (changes === null) return true;
  return changes.some((change) => kinds.includes(change.kind) && (target_id === null || change.target_id === null || change.target_id === target_id));
}

// ── Filters ──────────────────────────────────────────────────────────────────

export const run_kinds: [value: string, text: string][] = [
  ["", "Any kind"],
  ["backup", "Backup"],
  ["dry-run", "Dry run"],
  ["check", "Check"],
  ["compact", "Compact"],
  ["prune", "Prune"],
  ["delete", "Delete"],
  ["restore", "Restore"],
  ["purge", "Purge"],
  ["purge-preview", "Purge preview"],
];

export const run_states: [value: string, text: string][] = [
  ["", "Any outcome"],
  ["running", "Running"],
  ["succeeded", "Succeeded"],
  ["warning", "Finished with warnings"],
  ["failed", "Failed"],
  ["cancelled", "Cancelled"],
];

export const event_levels: [value: string, text: string][] = [["", "Any level"], ["ERROR", "Errors"], ["WARNING", "Warnings"], ["INFO", "Info"]];

// ── Repositories ─────────────────────────────────────────────────────────────

// A target in words: its job's sources on one host to one repository, or a repository only watched from a host.
export function target_label(target: Pick<RepositorySummary, "job" | "repository" | "host">): string {
  return target.job === null ? `${target.repository}, watched from ${target.host}` : `${target.job} from ${target.host} to ${target.repository}`;
}

const level_tone = { critical: "bad", warning: "warn", ok: "good" } as const;

export function RepositoryCard({ repository }: { repository: RepositorySummary }) {
  const late = repository.last_poll_epoch !== null && overdue(repository);
  const running = repository.running_run;
  return (
    <a className={`card tone-edge-${level_tone[repository.level]}`} href={link(["repositories", repository.id])}>
      <div className="card-head"><strong>{repository.repository}</strong><StatusBadge status={repository.status} /></div>
      <div className="muted card-host">{repository.job === null ? `watched from ${repository.host}` : `${repository.job} from ${repository.host}`}</div>
      <dl>
        <dt>Last backup</dt>
        <dd className={late ? "tone-bad" : ""}>{age(repository.last_backup_epoch)}{late ? " · overdue" : ""}</dd>
        <dt>Archives</dt><dd>{repository.archive_count ?? "—"}</dd>
        <dt>Stored</dt><dd>{size(repository.stats?.deduplicated_size)}</dd>
        <dt>Original</dt><dd>{size(repository.stats?.original_size)}</dd>
      </dl>
      <div className="verdicts"><Verdict ok={repository.checks_passed} label="checks" /><Verdict ok={repository.canary?.ok} label="canary" /></div>
      <Chips>
        {repository.source === "declared"
          ? <Chip title="Set in the Nix configuration; edit it there">declared</Chip>
          : <Chip title="Added from this page; edit it on its Config tab">added here</Chip>}
        {running && <Chip>{`${running.kind} running${running.progress ? ` · ${running.progress}` : ""}`}</Chip>}
      </Chips>
    </a>
  );
}

interface RepositoriesTableProps {
  repositories: RepositorySummary[];
  sorting: Sorting;
  on_sort: (sorting: Sorting) => void;
}

export function RepositoriesTable({ repositories, sorting, on_sort }: RepositoriesTableProps) {
  const columns: TableColumn<RepositorySummary>[] = [
    { label: "Name", cell: (row) => <a href={link(["repositories", row.id])}>{row.repository}</a>, sort: (row) => row.name.toLowerCase() },
    { label: "Status", cell: (row) => <StatusBadge status={row.status} />, sort: (row) => status_rank(row) },
    { label: "Job", cell: (row) => row.job === null ? <span className="muted">watched only</span> : <a href={link(["jobs", row.job])}>{row.job}</a>, sort: (row) => row.job ?? "" },
    { label: "Host", cell: (row) => <a href={link(["hosts", row.host])}>{row.host}</a>, sort: (row) => row.host },
    {
      label: "Last backup", sort: (row) => row.last_backup_epoch ?? 0,
      cell: (row) => <span className={row.last_poll_epoch !== null && overdue(row) ? "tone-bad" : ""} title={row.last_backup_epoch ? stamp(row.last_backup_epoch) : undefined}>{age(row.last_backup_epoch)}</span>,
    },
    { label: "Archives", class: "number", cell: (row) => row.archive_count ?? "—", sort: (row) => row.archive_count },
    { label: "Stored", class: "number", cell: (row) => size(row.stats?.deduplicated_size), sort: (row) => row.stats?.deduplicated_size ?? null },
    { label: "Checks", cell: (row) => <Verdict ok={row.checks_passed} label="checks" /> },
    { label: "Canary", cell: (row) => <Verdict ok={row.canary?.ok} label="canary" /> },
  ];
  return <DataTable columns={columns} rows={repositories} row_key={(row) => row.id} sorting={sorting} on_sort={on_sort} caption="Repositories" />;
}

// Worst first: failing, then needing attention, then fine.
export function status_rank(repository: RepositorySummary): number {
  return { critical: 0, warning: 1, ok: 2 }[repository.level];
}

// ── Runs ─────────────────────────────────────────────────────────────────────

// The middle duration of each kind's finished runs, which a run's duration bar is drawn against.
export function medians(runs: Run[]): Map<string, number> {
  const by_kind = new Map<string, number[]>();
  for (const run of runs) {
    if (run.ended_epoch === null || run.state !== "succeeded" && run.state !== "warning") continue;
    const list = by_kind.get(run.kind) ?? [];
    list.push(run.ended_epoch - run.started_epoch);
    by_kind.set(run.kind, list);
  }
  return new Map([...by_kind].map(([kind, list]) => {
    list.sort((first, second) => first - second);
    return [kind, list[Math.floor(list.length / 2)]];
  }));
}

// A bar where the kind's usual duration sits at the middle mark, turning warm when a run took twice as long.
function DurationBar({ run, median }: { run: Run; median: number | undefined }) {
  const took = (run.ended_epoch ?? now_seconds()) - run.started_epoch;
  const text = duration(took);
  if (!median) return <span>{text}</span>;
  const share = Math.min(100, took / median * 50);
  const tone = took > median * 2 ? "warn" : "info";
  return (
    <span className="duration" title={`Usually ${duration(median)}`}>
      <span className="duration-text">{text}</span>
      <span className="duration-track" aria-hidden="true"><span className={`duration-fill tone-fill-${tone}`} style={{ width: `${share.toFixed(0)}%` }} /></span>
    </span>
  );
}

interface RunsTableProps {
  runs: Run[];
  with_repository: boolean;
  refresh: Refresh;
  usual?: Map<string, number>;
}

export function RunsTable({ runs, with_repository, refresh, usual }: RunsTableProps) {
  if (runs.length === 0) return <Empty title="No runs here." hint="Runs appear when a task or an action runs, such as a backup, check or prune." />;
  const durations = usual ?? medians(runs);
  const columns: TableColumn<Run>[] = [
    ...(with_repository ? [{ label: "Target", cell: (run: Run) => <a href={link(["repositories", run.target_id])}>{run.target_id}</a> }] : []),
    { label: "Run", cell: (run) => <a href={link(["runs", String(run.id)])}>{`${run.kind} #${run.id}`}</a> },
    { label: "Task", cell: (run) => run.task === null ? <span className="muted">by hand</span> : <a href={link(["runs"], { task: run.task })}>{run.task}</a> },
    {
      label: "State", cell: (run) => <>
        <RunStateBadge run={run} />
        {run.progress && run.state === "running" && run.condition === null && <span className="muted">{` ${run.progress}`}</span>}
      </>,
    },
    { label: "Started", cell: (run) => <Age epoch={run.started_epoch} /> },
    { label: "Took", cell: (run) => <DurationBar run={run} median={durations.get(run.kind)} /> },
    { id: "actions", label: "", class: "actions-cell", cell: (run) => <RunButtons run={run} refresh={refresh} /> },
  ];
  return <DataTable columns={columns} rows={runs} row_key={(run) => run.id} caption="Runs" />;
}

export function RunButtons({ run, refresh }: { run: Run; refresh: Refresh }) {
  if (!can("operator")) return null;
  return (
    <span className="row-actions">
      {run.state === "running" && <button className="danger" onClick={() => cancel_run(run, refresh)}>Cancel</button>}
      {run.retry && <button onClick={() => retry_run(run, refresh)}>Retry</button>}
    </span>
  );
}

export function cancel_run(run: Run, refresh: Refresh): void {
  confirm_dialog({
    title: `Cancel ${run.kind} #${run.id}?`,
    message: `This stops the ${run.kind} on ${run.target_id}. Borg keeps what was finished before it stopped, and the run can be run again.`,
    confirm_label: "Cancel run",
    busy_label: "Cancelling…",
    danger: true,
    run: async () => {
      const outcome = await api<Outcome>(`/api/runs/${run.id}/cancel`, {}).catch((error: Error) => ({ success: false, content: error.message, logs: [] }));
      toast(outcome.content ?? "Cancelled.", { tone: outcome.success ? "warn" : "bad" });
      await refresh();
    },
  });
}

export function retry_run(run: Run, refresh: Refresh): void {
  confirm_dialog({
    title: `Run ${run.kind} again?`,
    message: `This starts the same ${run.kind} on ${run.target_id} that run #${run.id} ran.`,
    confirm_label: "Run again",
    busy_label: "Starting…",
    run: async () => {
      try {
        await show_outcome(run.target_id, run.kind, await api<Outcome>(`/api/runs/${run.id}/retry`, {}));
      } catch (error) {
        toast(`Could not run it again: ${describe_error(error)}`, { tone: "bad" });
      }
      await refresh();
    },
  });
}

// ── Events ───────────────────────────────────────────────────────────────────

export function EventsList({ events, with_repository }: { events: EventRow[]; with_repository: boolean }) {
  if (events.length === 0) return <Empty title="Nothing logged here." hint="Warnings, errors and actions show up here as they happen." />;
  return (
    <ul className="events">
      {events.map((event) => (
        <li key={event.id} className={`level-${event.level.toLowerCase()}`}>
          <span className="muted event-time" title={stamp(event.epoch)}>{age(event.epoch)}</span>
          <LevelBadge level={event.level} />
          {with_repository && <a href={link(["repositories", event.target_id])}>{event.target_id}</a>}
          <span className="event-message">{event.message}</span>
        </li>
      ))}
    </ul>
  );
}

// ── Timers ───────────────────────────────────────────────────────────────────

export function TimersTable({ timers, with_host }: { timers: TimerRow[]; with_host: boolean }) {
  if (timers.length === 0) return <Empty title="No backup timers found." hint="X-Backups reads systemd timers named for borg, borgmatic or backups on each host." />;
  const columns: TableColumn<TimerRow>[] = [
    ...(with_host ? [{ label: "Host", cell: (timer: TimerRow) => timer.host }] : []),
    { label: "Timer", cell: (timer) => <span title={timer.service}>{timer.unit}</span> },
    { label: "Last run", cell: (timer) => <Age epoch={timer.last_epoch} missing="never" /> },
    { label: "Next run", cell: (timer) => <span title={timer.next_epoch ? stamp(timer.next_epoch) : undefined}>{until(timer.next_epoch)}</span> },
    {
      label: "State", cell: (timer) => {
        const problem = timer_problem(timer);
        return <span className={`badge tone-${problem ? "bad" : "good"}`}>{problem ?? "ok"}</span>;
      },
    },
  ];
  return <DataTable columns={columns} rows={timers} row_key={(timer) => `${timer.host}/${timer.unit}`} caption="Backup timers" />;
}
