// One target of a repository: its header and actions, then tabs for its overview (with the jobs writing to the repository,
// its other targets and its own tasks), archives, runs, sources, schedule, events and config.

import { Badge, Chip, Verdict } from "@x-tech-laboratories/x-libs/web/react/badges";
import { SearchBox, Select } from "@x-tech-laboratories/x-libs/web/react/controls";
import { confirm_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { Crumbs, Facts, Section, Tabs, Toolbar, type Fact } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Empty, Loaded, Skeleton, use_resource, type Resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { DataTable, Pager, type Sorting } from "@x-tech-laboratories/x-libs/web/react/table";
import { toast } from "@x-tech-laboratories/x-libs/web/react/toasts";
import { Age } from "@x-tech-laboratories/x-libs/web/react/time";
import { age, duration, now_seconds, size, stamp } from "@x-tech-laboratories/x-libs/web/format";
import { current_route, link, replace_query } from "@x-tech-laboratories/x-libs/web/router";
import { sorting_from } from "@x-tech-laboratories/x-libs/web/tables";
import { Fragment, useEffect, useRef, useState, type FunctionComponent } from "react";
import { action_descriptions, run_action, start_action, type ActionTarget } from "../actions.tsx";
import { overdue, repository_reasons } from "../attention.ts";
import {
  api, ApiError, query, repository_path, send, type Action, type Archive, type ConfigInfo, type DownloadRecord, type EventRow, type History, type Run,
  type RepositoryConfig, type RepositoryDetail, type RepositorySummary, type TaskView, type TimerRow,
} from "../api.ts";
import { BarChart, LineChart, Strip } from "../charts.tsx";
import { can } from "../session.ts";
import { StatusBadge, use_changes } from "../ui.tsx";
import { ConfigForm, ConfigReadOnly, ConfigTools, load_key, type ConfigFormHandle } from "./config_form.tsx";
import { event_levels, EventsList, type Refresh, run_kinds, run_states, RunsTable, target_label, TimersTable, touches } from "./shared.tsx";
import { TasksTable } from "./tasks.tsx";

const history_span_in_seconds = 90 * 86400;
const page_size = 50;

// Actions that start a backup sit in the header; the rest are maintenance, each in a card that says what it does.
const header_actions = new Set(["run_backup", "dry_run_backup"]);

const tab_list: [id: string, label: string][] = [
  ["overview", "Overview"],
  ["archives", "Archives"],
  ["runs", "Runs"],
  ["sources", "Sources"],
  ["schedule", "Schedule"],
  ["events", "Events"],
  ["config", "Config"],
];

// ── Page ─────────────────────────────────────────────────────────────────────

interface TabProps {
  id: string;
  base: string;
  repository: RepositoryDetail;
  target: ActionTarget;
  // Counts the page's refreshes, so a tab loads what it holds again with the header.
  refreshes: number;
  refresh: Refresh;
}

const tab_views: Record<string, FunctionComponent<TabProps>> = {
  overview: OverviewTab, archives: ArchivesTab, runs: RunsTab, sources: SourcesTab, schedule: ScheduleTab, events: EventsTab, config: ConfigTab,
};

export function RepositoryView({ id, tab }: { id: string; tab: string }) {
  const base = repository_path(id);
  const active = tab_list.some(([tab_id]) => tab_id === tab) ? tab : "overview";
  const detail = use_resource(() => api<RepositoryDetail>(base), [base]);
  const [refreshes, set_refreshes] = useState(0);

  const refresh = () => {
    set_refreshes((count) => count + 1);
    return detail.reload(true);
  };
  use_changes((changes) => { if (touches(changes, id, ["repository", "run", "timers", "config", "tasks"])) refresh(); });

  const target: ActionTarget = { target_id: id, repository_name: detail.data?.name ?? id, done: refresh };
  const TabView = tab_views[active];
  return (
    <div className="page">
      <Crumbs items={[["Repositories", link(["repositories"])], [id, null]]} />
      <div>
        <Loaded resource={detail} lines={2}>{(repository) => <RepositoryHeader repository={repository} target={target} />}</Loaded>
      </div>
      <Tabs active={active} items={tab_list.map(([tab_id, label]) => ({ id: tab_id, label, href: link(["repositories", id, ...(tab_id === "overview" ? [] : [tab_id])]) }))} />
      <div className="stack">
        {detail.data === null
          ? <Skeleton lines={6} />
          : <TabView id={id} base={base} repository={detail.data} target={target} refreshes={refreshes} refresh={refresh} />}
      </div>
    </div>
  );
}

// Loads the resource again quietly each time the page refreshes after the tab first showed.
function use_refreshes(resource: Resource<unknown>, refreshes: number): void {
  const first = useRef(refreshes);
  useEffect(() => {
    if (refreshes !== first.current) resource.reload(true);
  }, [refreshes]);
}

// ── Header ───────────────────────────────────────────────────────────────────

function RepositoryHeader({ repository, target }: { repository: RepositoryDetail; target: ActionTarget }) {
  const buttons = repository.actions.filter((action) => header_actions.has(action.action_id) && action.state !== "hidden");
  const reasons = repository_reasons(repository);
  const running = repository.running_run;
  return (
    <header className="page-head">
      <div className="page-title">
        <h1>{repository.name}</h1>
        <StatusBadge status={repository.status} />
        {repository.source === "declared"
          ? <Chip title="Set in the Nix configuration; edit it there">declared</Chip>
          : <Chip title="Added from this page; edit it on its Config tab">added here</Chip>}
        {running && <a className="chip chip-info" href={link(["runs", String(running.id)])}>{`${running.kind} running${running.progress ? ` · ${running.progress}` : ""}`}</a>}
        {repository.downloads.length > 0 && (
          <a className="chip chip-info" href={link(["repositories", repository.id])}>
            {repository.downloads.length === 1 ? "download running" : `${repository.downloads.length} downloads running`}
          </a>
        )}
      </div>
      <p className="muted">{target_label(repository)}{repository.repo ? ` · ${repository.repo}` : ""}{` · polled ${age(repository.last_poll_epoch)}`}</p>
      {can("operator") && (
        <div className="head-actions">
          {buttons.map((action, index) => <ActionButton key={action.action_id} action={action} target={target} class_name={index === 0 ? "accent solid" : ""} />)}
          <button onClick={() => void poll_now(target)}>Poll now</button>
        </div>
      )}
      {reasons.length > 0 && (
        <ul className="attention compact">
          {reasons.map((reason, index) => (
            <li key={index} className={`tone-edge-${reason.tone}`}>
              <Badge tone={reason.tone}>{reason.tone === "bad" ? "problem" : "warning"}</Badge><span>{reason.text}</span>
            </li>
          ))}
        </ul>
      )}
    </header>
  );
}

function ActionButton({ action, target, class_name = "" }: { action: Action; target: ActionTarget; class_name?: string }) {
  const busy = action.state === "accent";
  return (
    <button className={class_name || undefined} disabled={action.state === "disabled" || busy} title={action_descriptions[action.action_id]} onClick={() => start_action(target, action)}>
      {busy ? `${action.name} (running)` : action.name}
    </button>
  );
}

async function poll_now(target: ActionTarget): Promise<void> {
  toast("Polling…");
  try {
    await api(`${repository_path(target.target_id)}/poll`, {});
    toast("Poll finished.", { tone: "good" });
  } catch (error) {
    toast(`Poll failed: ${error instanceof Error ? error.message : String(error)}`, { tone: "bad" });
  }
  await target.done?.();
}

// ── Overview tab ─────────────────────────────────────────────────────────────

function OverviewTab({ id, base, repository, target, refreshes, refresh }: TabProps) {
  const history = use_resource(async () => {
    const since = Math.floor(now_seconds() - history_span_in_seconds);
    const [polls, runs] = await Promise.all([
      api<History>(`${base}/history${query({ since })}`),
      api<Run[]>(`/api/runs${query({ target: id, limit: 60 })}`),
    ]);
    return { history: polls, runs, since };
  }, [base]);
  use_refreshes(history, refreshes);

  return <>
    <DownloadsPanel repository={repository} refresh={refresh} />
    <Section title="Summary"><RepositoryFacts repository={repository} /></Section>
    <Section title={`The repository ${repository.repository}`}><RepositoryShared repository={repository} /></Section>
    <Section title="Repository tasks" tools={<span className="muted small">compact and check run once for the whole repository</span>}>
      <TasksTable tasks={repository.tasks} refresh={refresh} empty_hint="Compact and check show here once the repository has them." />
    </Section>
    <Section title="History" tools={<span className="muted small">last 90 days</span>}>
      <div className="charts">
        <Loaded resource={history} lines={4}>{(answer) => <HistoryCharts repository={repository} {...answer} />}</Loaded>
      </div>
    </Section>
    {can("operator") && <Section title="Maintenance"><div className="maintenance"><MaintenanceCards repository={repository} target={target} /></div></Section>}
  </>;
}

// Downloads in progress hold the repository's lock, so they are listed where a waiting backup would send someone.
function DownloadsPanel({ repository, refresh }: { repository: RepositoryDetail; refresh: Refresh }) {
  if (repository.downloads.length === 0) return null;
  const stop = (download: DownloadRecord) => confirm_dialog({
    title: "Stop this download?",
    message: `${download.who}'s download of ${download.what} stops at once and their browser marks it failed.`,
    confirm_label: "Stop download",
    busy_label: "Stopping…",
    danger: true,
    run: async () => {
      await api(`${repository_path(repository.id)}/downloads/${download.id}/stop`, {}).catch(() => {});
      await refresh();
    },
  });
  return (
    <Section title="Downloads in progress">
      <div className="stack">
        <p className="muted small">Each holds the repository's lock until it ends; a backup that starts meanwhile waits for it.</p>
        <DataTable<DownloadRecord> rows={repository.downloads} row_key={(download) => download.id} caption="Downloads in progress" columns={[
          { label: "What", cell: (download) => download.what },
          { label: "Who", cell: (download) => download.who },
          { label: "Running", cell: (download) => <span title={stamp(download.started_epoch)}>{duration(now_seconds() - download.started_epoch)}</span> },
          {
            label: "", class: "actions-cell",
            cell: (download) => can("operator") && <span className="row-actions"><button className="danger" onClick={() => stop(download)}>Stop</button></span>,
          },
        ]} />
      </div>
    </Section>
  );
}

function RepositoryFacts({ repository }: { repository: RepositoryDetail }) {
  const original = repository.stats?.original_size;
  const stored = repository.stats?.deduplicated_size;
  const late = repository.last_poll_epoch !== null && overdue(repository);
  return (
    <div>
      <Facts rows={[
        ["Last backup", <span title={repository.last_backup_epoch ? stamp(repository.last_backup_epoch) : undefined}>{age(repository.last_backup_epoch)}{late ? " · overdue" : ""}</span>, late ? "tone-bad" : undefined],
        ["Max age", duration(repository.max_age)],
        ["Warning at", repository.warn_age > 0 && repository.warn_age < repository.max_age ? duration(repository.warn_age) : "max age only"],
        ["Archives", repository.archive_count ?? "—"],
        ["Original", size(original)],
        ["Compressed", size(repository.stats?.compressed_size)],
        ["Stored", size(stored)],
        ["Space", repository.quota > 0 ? `${size(repository.quota)} quota`
          : repository.storage ? `${size(repository.storage.available)} free of ${size(repository.storage.size)}` : "—"],
        ["Saved", original && stored ? `${(original / stored).toFixed(1)}× smaller` : "—"],
      ]} />
      <div className="verdicts">
        <Verdict ok={repository.checks_passed} label="checks" />
        <Verdict ok={repository.canary?.ok} label="restore canary" />
        {repository.canary && <span className="muted small">{`canary checked ${age(repository.canary.checked_epoch)}`}</span>}
      </div>
    </div>
  );
}

// Who writes to the repository and its other targets, each with its own archives, newest backup and status.
function RepositoryShared({ repository }: { repository: RepositoryDetail }) {
  const others = repository.repository_targets;
  return (
    <div className="stack">
      <p>
        {repository.writers.length === 0 ? "No job writes here; it is only watched." : <>
          {"Written by "}
          {repository.writers.map((job, index) => <Fragment key={job}>{index > 0 && ", "}<a href={link(["jobs", job])}>{job}</a></Fragment>)}
          {"."}
        </>}
      </p>
      {others.length > 0 && (
        <DataTable<RepositorySummary> rows={others} row_key={(other) => other.id} caption="Other targets on this repository" columns={[
          { label: "Other target", cell: (other) => <a href={link(["repositories", other.id])}>{target_label(other)}</a> },
          { label: "Status", cell: (other) => <StatusBadge status={other.status} /> },
          { label: "Archives", class: "number", cell: (other) => other.archive_count ?? "—" },
          { label: "Last backup", cell: (other) => <Age epoch={other.last_backup_epoch} missing="never" /> },
        ]} />
      )}
    </div>
  );
}

function MaintenanceCards({ repository, target }: { repository: RepositoryDetail; target: ActionTarget }) {
  const actions = repository.actions.filter((action) => !header_actions.has(action.action_id) && action.state !== "hidden");
  if (actions.length === 0) return <Empty title="No maintenance actions for this repository." hint="Prune, delete and purge appear once allow_delete or allow_purge is set in its config." />;
  return <>{actions.map((action) => (
    <div key={action.action_id} className={`maintenance-card${action.confirm ? " risky" : ""}`}>
      <div><strong>{action.name}</strong><p className="muted small">{action_descriptions[action.action_id] ?? ""}</p></div>
      <ActionButton action={action} target={target} class_name={action.confirm ? "danger" : ""} />
    </div>
  ))}</>;
}

const run_colors: Record<Run["state"], string> = {
  succeeded: "var(--status-success)",
  warning: "var(--status-warning)",
  failed: "var(--status-danger)",
  cancelled: "var(--text-tertiary)",
  running: "var(--accent)",
};

function HistoryCharts({ repository, history, runs, since }: { repository: RepositoryDetail; history: History; runs: Run[]; since: number }) {
  const polls = history.polls;
  const archives = history.archives.slice(0, 40).reverse();
  const finished = runs.filter((run) => run.ended_epoch !== null).slice(0, 40).reverse();
  const warns = repository.warn_age > 0 && repository.warn_age < repository.max_age;
  return <>
    <LineChart title="Time since last backup" format={duration} series={[
      { label: "since last archive", color: "var(--series-1)", points: backup_age_points(history, since) },
    ]} limits={[
      ...(warns ? [{ label: "warning age", value: repository.warn_age, color: "var(--status-warning)" }] : []),
      { label: "max age", value: repository.max_age, color: "var(--status-danger)" },
    ]} />
    <LineChart title="Repository size" format={size} series={[
      { label: "original", color: "var(--series-1)", points: polls.map((poll) => [poll.epoch, poll.original_size]) },
      { label: "compressed", color: "var(--series-2)", points: polls.map((poll) => [poll.epoch, poll.compressed_size]) },
      { label: "stored", color: "var(--series-3)", points: polls.map((poll) => [poll.epoch, poll.deduplicated_size]) },
    ]} />
    <LineChart title="Space savings" format={(value) => `${value.toFixed(1)}×`} series={[
      { label: "compression and deduplication", color: "var(--series-3)", points: polls.map((poll) => [poll.epoch, ratio(poll.original_size, poll.deduplicated_size)]) },
      { label: "compression alone", color: "var(--series-2)", points: polls.map((poll) => [poll.epoch, ratio(poll.original_size, poll.compressed_size)]) },
    ]} />
    <LineChart title="Archives" format={(value) => String(Math.round(value))} series={[
      { label: "archives", color: "var(--series-1)", points: polls.map((poll) => [poll.epoch, poll.archive_count]) },
    ]} />
    <BarChart title="New data in each archive" format={size} bars={archives.map((archive) => ({
      label: archive.name, value: archive.deduplicated_size ?? 0, color: "var(--series-3)",
    }))} />
    <BarChart title="Run durations" format={duration} bars={finished.map((run) => ({
      label: `${run.kind} #${run.id} ${run.state}`, value: run.ended_epoch! - run.started_epoch, color: run_colors[run.state],
    }))} />
    <Strip title="Checks" cells={polls.slice(-60).map((poll) => ({ label: stamp(poll.epoch), ok: poll.checks_passed }))} />
    <Strip title="Restore canary" cells={polls.slice(-60).map((poll) => ({ label: stamp(poll.epoch), ok: poll.canary_ok }))} />
  </>;
}

// How many times smaller the stored data is than the original, or null without both sizes.
function ratio(original: number | null, stored: number | null): number | null {
  return original && stored ? original / stored : null;
}

// The age of the newest archive from `since` to now: it climbs until each archive lands, then drops to zero.
function backup_age_points(history: History, since: number): [number, number | null][] {
  const epochs = history.archives.map((archive) => archive.epoch).sort((a, b) => a - b);
  let previous = epochs.filter((epoch) => epoch < since).at(-1) ?? null;
  const points: [number, number | null][] = [[since, previous === null ? null : since - previous]];
  for (const epoch of epochs.filter((epoch) => epoch >= since)) {
    if (previous !== null) points.push([epoch, epoch - previous]);
    points.push([epoch, 0]);
    previous = epoch;
  }
  const now = now_seconds();
  if (previous !== null) points.push([now, now - previous]);
  return points;
}

// ── Archives tab ─────────────────────────────────────────────────────────────

function ArchivesTab({ repository, target }: TabProps) {
  const [text, set_text] = useState(() => current_route().query.get("q") ?? "");
  const [page, set_page] = useState(() => Number(current_route().query.get("page") ?? 1));
  const [sorting, set_sorting] = useState(() => sorting_from(current_route().query, { key: "Created", descending: true }));

  const list = () => {
    if (repository.archives.length === 0) return <Empty title="No archives listed yet." hint="Archives appear after the first poll that finds one." />;
    const needle = text.trim().toLowerCase();
    const shown = repository.archives.filter((archive) => !needle || archive.name.toLowerCase().includes(needle));
    // Sorting happens before paging, so a page always holds the next rows in the chosen order.
    const sorted = sort_archives(shown, sorting);
    const pages = Math.max(1, Math.ceil(sorted.length / page_size));
    const at = Math.min(page, pages);
    return <>
      <p className="muted small" role="status">{`${shown.length} of ${repository.archives.length} archives`}</p>
      <ArchivesTable repository={repository} archives={sorted.slice((at - 1) * page_size, at * page_size)} sorting={sorting} target={target} on_sort={(next) => {
        set_sorting(next);
        replace_query({ sort: next.key, dir: next.descending ? "desc" : null });
      }} />
      <Pager page={at} has_more={at < pages} go={(next) => {
        set_page(next);
        replace_query({ page: next === 1 ? null : next });
      }} />
    </>;
  };

  return (
    <Section title="Archives">
      <div>
        <Toolbar>
          <SearchBox label="Search archives by name" value={text} on_input={(value) => {
            set_text(value);
            set_page(1);
            replace_query({ q: value, page: null });
          }} />
        </Toolbar>
        <div>{list()}</div>
      </div>
    </Section>
  );
}

function sort_archives(archives: Archive[], sorting: Sorting): Archive[] {
  const value = (archive: Archive): number | string => {
    if (sorting.key === "Archive") return archive.name.toLowerCase();
    if (sorting.key === "Original") return archive.original ?? -1;
    if (sorting.key === "New data") return archive.deduplicated ?? -1;
    if (sorting.key === "Files") return archive.nfiles ?? -1;
    return archive.epoch;
  };
  return [...archives].sort((left, right) => {
    const [a, b] = [value(left), value(right)];
    const order = a === b ? 0 : a < b ? -1 : 1;
    return sorting.descending ? -order : order;
  });
}

interface ArchivesTableProps {
  repository: RepositoryDetail;
  archives: Archive[];
  sorting: Sorting;
  on_sort: (sorting: Sorting) => void;
  target: ActionTarget;
}

function ArchivesTable({ repository, archives, sorting, on_sort, target }: ArchivesTableProps) {
  const oldest = repository.archives.at(-1)?.name;
  const archive_link = (archive: Archive, tab: string) => link(["repositories", repository.id, "archives", archive.name], { tab });
  // Sorting is done by the caller across every page, so the table only marks the column.
  return (
    <DataTable<Archive> rows={archives} row_key={(archive) => archive.name} sorting={sorting} on_sort={on_sort} caption="Archives" columns={[
      { label: "Archive", cell: (archive) => <a href={archive_link(archive, "changes")}>{archive.name}</a>, sort: () => 0 },
      { label: "Created", cell: (archive) => <Age epoch={archive.epoch} />, sort: () => 0 },
      { label: "Original", class: "number", cell: (archive) => size(archive.original), sort: () => 0 },
      { label: "New data", class: "number", cell: (archive) => size(archive.deduplicated), sort: () => 0 },
      { label: "Files", class: "number", cell: (archive) => archive.nfiles?.toLocaleString() ?? "—", sort: () => 0 },
      {
        label: "", class: "actions-cell", cell: (archive) => (
          <span className="row-actions">
            {can("operator") && archive.name !== oldest && <a className="button" href={archive_link(archive, "changes")}>Changes</a>}
            {can("operator") && <a className="button" href={archive_link(archive, "files")}>Files</a>}
            {can("operator") && repository.allow_delete && <button className="danger" onClick={() => delete_archive(target, archive.name)}>Delete</button>}
          </span>
        ),
      },
    ]} />
  );
}

export function delete_archive(target: ActionTarget, archive: string, after?: () => void): void {
  confirm_dialog({
    title: `Delete ${archive}?`,
    message: <div>
      <p>{`This deletes the archive ${archive} from ${target.repository_name}. It cannot be undone.`}</p>
      <p className="muted">Data other archives share stays; run Compact afterwards to free what only this archive held.</p>
    </div>,
    confirm_label: "Delete archive",
    busy_label: "Deleting…",
    danger: true,
    run: async () => {
      await run_action(target, "delete_archive", "Delete", { archive });
      after?.();
    },
  });
}

// ── Runs tab ─────────────────────────────────────────────────────────────────

function RunsTab({ id, refreshes, refresh }: TabProps) {
  const [kind, set_kind] = useState(() => current_route().query.get("kind") ?? "");
  const [state, set_state] = useState(() => current_route().query.get("state") ?? "");
  const [page, set_page] = useState(() => Number(current_route().query.get("page") ?? 1));
  const runs = use_resource(() => api<Run[]>(`/api/runs${query({ target: id, kind, state, limit: page_size + 1, offset: (page - 1) * page_size })}`), [id, kind, state, page]);
  use_refreshes(runs, refreshes);

  const refilter = (changes: { kind?: string; state?: string }) => {
    if (changes.kind !== undefined) set_kind(changes.kind);
    if (changes.state !== undefined) set_state(changes.state);
    set_page(1);
    replace_query({ kind: changes.kind ?? kind, state: changes.state ?? state, page: null });
  };

  return (
    <Section title="Runs">
      <div>
        <Toolbar>
          <Select label="Kind" options={run_kinds} value={kind} on_change={(value) => refilter({ kind: value })} />
          <Select label="Outcome" options={run_states} value={state} on_change={(value) => refilter({ state: value })} />
          <a href={link(["runs"], { repository: id })}>Open in all runs</a>
        </Toolbar>
        <div>
          <Loaded resource={runs} lines={5}>
            {(rows) => <>
              <RunsTable runs={rows.slice(0, page_size)} with_repository={false} refresh={refresh} />
              <Pager page={page} has_more={rows.length > page_size} go={(next) => { set_page(next); replace_query({ page: next === 1 ? null : next }); }} />
            </>}
          </Loaded>
        </div>
      </div>
    </Section>
  );
}

// ── Sources tab ──────────────────────────────────────────────────────────────

function SourcesTab({ repository }: TabProps) {
  const retention = Object.entries(repository.retention);
  return <>
    <Section title="Backed up"><PathList items={repository.source_paths} none="Set by the host's own backup job, so X-Backups does not know the paths." /></Section>
    <Section title="Excluded"><PathList items={repository.exclude} none="Nothing is excluded." /></Section>
    <Section title="Kept">
      {retention.length > 0
        ? <Facts layout="rows" rows={retention.map(([key, value]): Fact => [key.replace("keep_", "").replace("_", " "), String(value)])} />
        : <p className="muted">No retention is set, so nothing is pruned.</p>}
    </Section>
    <Section title="Changes between archives">
      <p className="muted">Open an archive's Changes tab to see what changed since the one before it. <a href={link(["repositories", repository.id, "archives"])}>Archives</a></p>
    </Section>
  </>;
}

function PathList({ items, none }: { items: string[]; none: string }) {
  return items.length > 0
    ? <ul className="paths">{items.map((item) => <li key={item}><code>{item}</code></li>)}</ul>
    : <p className="muted">{none}</p>;
}

// ── Schedule tab ─────────────────────────────────────────────────────────────

function ScheduleTab({ repository, refreshes, refresh }: TabProps) {
  const tasks = use_resource(async () => {
    const all = await api<TaskView[]>("/api/tasks");
    return all.filter((task) => task.owner_kind === "job" ? task.owner === repository.job : task.owner === repository.repository);
  }, []);
  const timers = use_resource(() => api<TimerRow[]>("/api/timers"), []);
  use_refreshes(tasks, refreshes);
  use_refreshes(timers, refreshes);

  return <>
    <Section title="Tasks" tools={<a href={link(["schedules"])}>All schedules</a>}>
      <div><Loaded resource={tasks} lines={3}>{(own) => <TasksTable tasks={own} refresh={refresh} with_owner />}</Loaded></div>
    </Section>
    <Section title={`Host timers on ${repository.host}`}>
      <div><Loaded resource={timers} lines={3}>{(all) => <TimersTable timers={all.filter((timer) => timer.host === repository.host)} with_host={false} />}</Loaded></div>
    </Section>
  </>;
}

// ── Events tab ───────────────────────────────────────────────────────────────

function EventsTab({ id, refreshes }: TabProps) {
  const [level, set_level] = useState(() => current_route().query.get("level") ?? "");
  const [page, set_page] = useState(() => Number(current_route().query.get("page") ?? 1));
  const events = use_resource(() => api<EventRow[]>(`/api/events${query({ target: id, level, limit: page_size + 1, offset: (page - 1) * page_size })}`), [id, level, page]);
  use_refreshes(events, refreshes);

  return (
    <Section title="Events">
      <div>
        <Toolbar>
          <Select label="Level" options={event_levels} value={level} on_change={(value) => { set_level(value); set_page(1); replace_query({ level: value, page: null }); }} />
        </Toolbar>
        <div>
          <Loaded resource={events} lines={5}>
            {(rows) => <>
              <EventsList events={rows.slice(0, page_size)} with_repository={false} />
              <Pager page={page} has_more={rows.length > page_size} go={(next) => { set_page(next); replace_query({ page: next === 1 ? null : next }); }} />
            </>}
          </Loaded>
        </div>
      </div>
    </Section>
  );
}

// ── Config tab ───────────────────────────────────────────────────────────────

function ConfigTab({ base, refreshes }: TabProps) {
  const loaded = use_resource(async () => {
    const [config, info] = await Promise.all([api<RepositoryConfig>(`${base}/config`), api<ConfigInfo>("/api/config")]);
    return { config, info };
  }, [base]);
  // A refresh while the form is open would throw away what was typed, so only a save or a reload redraws it.
  const editing = loaded.data?.config.editable ?? false;
  const first = useRef(refreshes);
  useEffect(() => {
    if (refreshes !== first.current && !editing) loaded.reload(true);
  }, [refreshes]);

  return (
    <div className="stack">
      <Loaded resource={loaded} lines={6}>
        {(answer) => answer.config.editable
          ? <ConfigEditor key={load_key(answer)} base={base} config={answer.config} info={answer.info} reload={() => loaded.reload(true)} />
          : <ConfigLocked config={answer.config} />}
      </Loaded>
    </div>
  );
}

function ConfigLocked({ config }: { config: RepositoryConfig }) {
  return <>
    <div className="banner" role="note">
      {config.source === "declared"
        ? <><strong>Declared in the Nix configuration.</strong> Change it there, under services.x-backups.repositories or the job, sources and host it is built from, and switch the system to apply it.</>
        : config.config_mode !== "declarative"
          ? <><strong>Built from a job.</strong> This target is built from its job, sources, host and repository, so change those in <a href={link(["settings"])}>Settings</a>.</>
          : <><strong>Added from this page,</strong> but the config is declarative now, so the page shows it read-only.</>}
    </div>
    <ConfigTools fields={config.fields} />
    <ConfigReadOnly fields={config.fields} />
  </>;
}

function ConfigEditor({ base, config, info, reload }: { base: string; config: RepositoryConfig; info: ConfigInfo; reload: () => void }) {
  const name = String(config.fields.name);
  const form = useRef<ConfigFormHandle>(null);
  const [busy, set_busy] = useState(false);

  async function save(): Promise<void> {
    set_busy(true);
    try {
      await send("PUT", `${base}/config`, form.current!.read());
      toast("Config saved. The repository is polled again with it.", { tone: "good" });
      reload();
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      form.current!.show_error(error.message, error.field);
    } finally {
      set_busy(false);
    }
  }

  function stop_watching(): void {
    confirm_dialog({
      title: `Stop watching ${name}?`,
      message: <div>
        <p>X-Backups stops polling it and takes it off this page. The borg repository and its archives are not touched.</p>
        <p className="muted">Its history stays in X-Backups' state, and adding it again under the same name brings that back.</p>
      </div>,
      confirm_label: "Stop watching",
      busy_label: "Removing…",
      danger: true,
      type_to_confirm: name,
      run: async () => {
        await send("DELETE", base);
        toast(`${name} is no longer watched.`, { tone: "warn" });
        location.hash = link(["repositories"]);
      },
    });
  }

  return <>
    <div className="banner" role="note"><strong>Added from this page.</strong> Saving applies the change at once; nothing restarts.</div>
    <ConfigTools fields={config.fields} />
    <ConfigForm fields={info.fields} values={config.fields} adding={false} handle={form} />
    <div className="form-actions">
      <button className="accent solid" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
      <button onClick={reload}>Discard changes</button>
      <button className="danger" onClick={stop_watching}>Stop watching</button>
    </div>
  </>;
}
