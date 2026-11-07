// The fleet at a glance: tiles that open filtered views, what needs attention and why (by target, agent and task), the
// backup flow from folders through jobs to repositories, backup ages and sizes, runs and archives over time, and what
// runs next.

import { start_of_day } from "@x-tech-laboratories/x-libs/dates";
import { age, duration, now_seconds, size, stamp, until } from "@x-tech-laboratories/x-libs/web/format";
import { Chip } from "@x-tech-laboratories/x-libs/web/react/badges";
import { Segmented } from "@x-tech-laboratories/x-libs/web/react/controls";
import { Section, Tile, Tiles } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Empty, Loaded, Skeleton, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { current_route, link, replace_query } from "@x-tech-laboratories/x-libs/web/router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { failing, overdue, repository_reasons, timer_problem } from "../attention.ts";
import { api, query, repository_path, type History, type HostRow, type HostSample, type Run, type RepositorySummary, type TaskView, type TimerRow } from "../api.ts";
import { Donut, LineChart, Meters, StackedBarChart, Timeline, type Meter, type Stack } from "../charts.tsx";
import { RunBadge, use_changes } from "../ui.tsx";
import { agent_away, HostHealth } from "./hosts.tsx";
import { MapSection } from "./map.tsx";
import { RepositoryCard, status_rank, target_label, touches } from "./shared.tsx";
import { task_label } from "./tasks.tsx";

const day_in_seconds = 86400;
const stored_span_in_days = 90;
// A backup meter is full at twice its repository's max age, so the max age sits at its middle.
const backup_scale = 2;

type Span = "24h" | "7d";

const span_choices: { value: Span; label: string }[] = [{ value: "24h", label: "24h" }, { value: "7d", label: "7d" }];

// ── Overview ─────────────────────────────────────────────────────────────────

export function OverviewView() {
  const [span, set_span] = useState<Span>(current_route().query.get("span") === "24h" ? "24h" : "7d");
  const fleet = use_resource(() => Promise.all([
    api<RepositorySummary[]>("/api/repositories"),
    api<Run[]>(`/api/runs${query({ since: Math.floor(now_seconds() - 7 * day_in_seconds), limit: 2000 })}`),
    api<TimerRow[]>("/api/timers"),
    api<HostSample[]>(`/api/hosts/samples${query({ since: Math.floor(now_seconds() - day_in_seconds) })}`),
    api<HostRow[]>("/api/hosts"),
    api<TaskView[]>("/api/tasks").catch((): TaskView[] => []),
  ]), []);
  const [histories, set_histories] = useState<Map<string, History> | null>(null);
  // The history is fetched again only when a poll or the config may have added to it.
  const history_wanted = useRef(true);

  use_changes((changes) => {
    if (!touches(changes, null, ["repository", "run", "timers", "hosts", "config", "tasks"])) return;
    if (touches(changes, null, ["repository", "config"])) history_wanted.current = true;
    fleet.reload(true);
  });

  // The stored total and the archives on the timeline need every repository's history, so they load after the rest is on screen.
  useEffect(() => {
    if (fleet.data === null || (!history_wanted.current && histories !== null)) return;
    history_wanted.current = false;
    void fetch_histories(fleet.data[0]).then(set_histories);
  }, [fleet.data]);

  const data = fleet.data;
  const [listed, recent, timers, samples, hosts, tasks] = data ?? [];
  // Everything but the tiles waits on a skeleton while the first load runs, and the tiles show why it failed.
  const when = (build: () => ReactNode) => data ? build() : <Skeleton />;
  const with_history = (build: (by_repository: Map<string, History>) => ReactNode) => data && histories ? build(histories) : <Skeleton />;

  return (
    <div className="page">
      <h1>Overview</h1>
      <div>
        <Loaded resource={fleet}>{() => <OverviewTiles repositories={listed!} timers={timers!} runs={recent!} hosts={hosts!} tasks={tasks!} />}</Loaded>
      </div>
      <div className="columns">
        <Section title="Needs attention">
          <div>{when(() => <AttentionList repositories={listed!} timers={timers!} hosts={hosts!} tasks={tasks!} />)}</div>
        </Section>
        <Section title="Runs" tools={<Segmented label="Period" choices={span_choices} value={span} on_change={(value) => { set_span(value); replace_query({ span: value === "7d" ? null : value }); }} />}>
          <div>{when(() => <RunPanels runs={recent!} span={span} />)}</div>
        </Section>
      </div>
      <MapSection />
      <div className="columns">
        <Section title="Time since last backup" tools={<span className="muted small">ticks at the warning and max age</span>}>
          <div>{when(() => <BackupAges repositories={listed!} />)}</div>
        </Section>
        <Section title="Storage per repository" tools={<span className="muted small">{`against its quota or disk; ticks at ${storage_warning_percent}% and ${storage_danger_percent}%`}</span>}>
          <div>{when(() => <StorageBars repositories={listed!} />)}</div>
        </Section>
      </div>
      <Section title="Activity" tools={<span className="muted small">runs and archives, by the period above</span>}>
        <div>{with_history((by_repository) => <ActivityTimeline repositories={listed!} runs={recent!} histories={by_repository} span={span} />)}</div>
      </Section>
      <Section title="Hosts" tools={<span className="muted small">last 24 hours, read every five minutes</span>}>
        <div>{when(() => <HostHealth samples={samples!} />)}</div>
      </Section>
      <div className="columns">
        <div className="stack">
          <Section title="Running now" tools={<a href={link(["runs"], { state: "running" })}>All running</a>}>
            <div>{when(() => <RunningList runs={recent!} />)}</div>
          </Section>
          <Section title="Next up" tools={<a href={link(["schedules"])}>All schedules</a>}>
            <div>{when(() => <UpcomingList timers={timers!} tasks={tasks!} />)}</div>
          </Section>
        </div>
        <Section title="Stored over time" tools={<span className="muted small">{`last ${stored_span_in_days} days`}</span>}>
          <div>{with_history((by_repository) => <StoredChart repositories={listed!} histories={by_repository} />)}</div>
        </Section>
      </div>
      <Section title="Targets" tools={<a href={link(["repositories"])}>Filter and sort</a>}>
        <div className="grid">
          {when(() => [...listed!].sort((first, second) => status_rank(first) - status_rank(second) || first.name.localeCompare(second.name))
            .map((repository) => <RepositoryCard key={repository.id} repository={repository} />))}
        </div>
      </Section>
    </div>
  );
}

// ── Tiles ────────────────────────────────────────────────────────────────────

interface TilesProps {
  repositories: RepositorySummary[];
  timers: TimerRow[];
  runs: Run[];
  hosts: HostRow[];
  tasks: TaskView[];
}

function OverviewTiles({ repositories, timers, runs, hosts, tasks }: TilesProps) {
  const bad = repositories.filter(failing).length;
  const away = hosts.filter(agent_away).length;
  const waiting = tasks.filter((task) => task.waiting !== null).length;
  const late = repositories.filter((repository) => repository.last_poll_epoch !== null && overdue(repository)).length;
  const timer_trouble = timers.filter((timer) => timer_problem(timer) !== null).length;
  const running = runs.filter((run) => run.state === "running").length;
  const failed_today = runs.filter((run) => run.state === "failed" && run.started_epoch > now_seconds() - day_in_seconds).length;
  const total = repositories.reduce((sum, repository) => sum + (repository.stats?.deduplicated_size ?? 0), 0);
  return (
    <Tiles>
      <Tile label="targets" value={repositories.length} href={link(["repositories"])} value_first />
      <Tile label="failing" value={bad} href={link(["repositories"], { status: "failing" })} tone={bad > 0 ? "bad" : "none"} value_first />
      <Tile label="overdue" value={late} href={link(["repositories"], { status: "overdue" })} tone={late > 0 ? "bad" : "none"} value_first />
      <Tile label="agents away" value={away} href={link(["hosts"], { state: "away" })} tone={away > 0 ? "bad" : "none"} value_first />
      <Tile label="tasks waiting" value={waiting} href={link(["schedules"], { state: "problem" })} tone={waiting > 0 ? "info" : "none"} value_first />
      <Tile label="timer problems" value={timer_trouble} href={link(["schedules"], { state: "problem" })} tone={timer_trouble > 0 ? "bad" : "none"} value_first />
      <Tile label="runs in progress" value={running} href={link(["runs"], { state: "running" })} tone={running > 0 ? "info" : "none"} value_first />
      <Tile label="failed runs, 24 h" value={failed_today} href={link(["runs"], { state: "failed" })} tone={failed_today > 0 ? "bad" : "none"} value_first />
      <Tile label="stored" value={size(total)} value_first />
    </Tiles>
  );
}

// ── Attention ────────────────────────────────────────────────────────────────

function AttentionList({ repositories, timers, hosts, tasks }: Omit<TilesProps, "runs">) {
  const items = [
    ...repositories.flatMap((repository) => repository_reasons(repository).map((reason) => ({
      tone: reason.tone, href: link(["repositories", repository.id]), name: target_label(repository), text: reason.text,
    }))),
    ...hosts.filter(agent_away).map((host) => ({
      tone: "bad" as const, href: link(["hosts", host.name]), name: host.name,
      text: host.enrolled || host.agent_key !== null ? `agent offline${host.last_seen_epoch ? `, last seen ${age(host.last_seen_epoch)}` : ""}` : "agent never enrolled",
    })),
    ...tasks.filter((task) => task.waiting !== null).map((task) => ({
      tone: "warn" as const, href: task.owner_kind === "job" ? link(["jobs", task.owner]) : link(["schedules"]), name: `${task_label(task)} of ${task.owner}`, text: task.waiting!,
    })),
    ...timers.flatMap((timer) => {
      const problem = timer_problem(timer);
      return problem ? [{ tone: "warn" as const, href: link(["schedules"]), name: `${timer.unit} on ${timer.host}`, text: problem }] : [];
    }),
  ].sort((first, second) => (first.tone === "bad" ? 0 : 1) - (second.tone === "bad" ? 0 : 1));
  if (items.length === 0) return <div className="all-good"><span aria-hidden="true">✓ </span>Everything looks healthy.</div>;
  return (
    <ul className="attention">
      {items.map((item, index) => (
        <li key={index} className={`tone-edge-${item.tone}`}>
          <span className={`badge tone-${item.tone}`}>{item.tone === "bad" ? "problem" : "warning"}</span>
          <a href={item.href}>{item.name}</a>
          <span>{item.text}</span>
        </li>
      ))}
    </ul>
  );
}

// ── Backups and storage ──────────────────────────────────────────────────────

// One meter per repository of the time since its newest archive, the stalest against its max age first.
function BackupAges({ repositories }: { repositories: RepositorySummary[] }) {
  const now = now_seconds();
  const stale = (repository: RepositorySummary) => repository.last_backup_epoch ? (now - repository.last_backup_epoch) / repository.max_age : Infinity;
  const rows = [...repositories].sort((first, second) => stale(second) - stale(first) || first.name.localeCompare(second.name)).map((repository): Meter => {
    const scale = repository.max_age * backup_scale;
    const since = repository.last_backup_epoch ? Math.max(0, now - repository.last_backup_epoch) : null;
    const warns = repository.warn_age > 0 && repository.warn_age < repository.max_age;
    const color = since === null || since > repository.max_age ? "var(--status-danger)"
      : warns && since > repository.warn_age ? "var(--status-warning)" : "var(--accent)";
    return {
      label: target_label(repository),
      href: link(["repositories", repository.id]),
      value_text: since === null ? "no archive yet" : age(repository.last_backup_epoch),
      percent: since === null ? 100 : Math.min(100, since / scale * 100),
      color,
      marks: [...(warns ? [repository.warn_age / scale * 100] : []), 100 / backup_scale],
      title: `Max age ${duration(repository.max_age)}${warns ? `, warning at ${duration(repository.warn_age)}` : ""}${repository.last_backup_epoch ? `; newest archive ${stamp(repository.last_backup_epoch)}` : ""}`,
    };
  });
  return <Meters rows={rows} message="No repositories yet." />;
}

// A storage bar turns amber at the first share of its limit and red at the second, as BorgWarehouse colours its quota bars.
const storage_warning_percent = 75;
const storage_danger_percent = 90;

// One bar per repository: what it stores against its quota, or how full its filesystem is, or failing both what it stores
// against the largest, with its original size drawn faintly beneath.
function StorageBars({ repositories }: { repositories: RepositorySummary[] }) {
  const sized = repositories.filter((repository) => repository.stats?.deduplicated_size != null || repository.storage !== null);
  const largest = Math.max(1, ...sized.map((repository) => Math.max(repository.stats?.deduplicated_size ?? 0, repository.stats?.original_size ?? 0)));
  const rows = sized.sort((first, second) => (second.stats?.deduplicated_size ?? 0) - (first.stats?.deduplicated_size ?? 0)).map((repository): Meter => {
    const { original_size: original, deduplicated_size: stored } = repository.stats ?? { original_size: null, deduplicated_size: null };
    const limited = (percent: number, value_text: string, title: string): Meter => ({
      label: repository.name,
      href: link(["repositories", repository.id]),
      value_text,
      percent: Math.min(100, percent),
      color: percent >= storage_danger_percent ? "var(--status-danger)" : percent >= storage_warning_percent ? "var(--status-warning)" : "var(--series-3)",
      marks: [storage_warning_percent, storage_danger_percent],
      title,
    });
    if (repository.quota > 0) {
      const percent = (stored ?? 0) / repository.quota * 100;
      return limited(percent, `${size(stored)} of ${size(repository.quota)} quota · ${Math.round(percent)}%`, "Stored against the quota set for this repository");
    }
    if (repository.storage !== null) {
      const used = repository.storage.size - repository.storage.available;
      const percent = used / repository.storage.size * 100;
      return limited(percent, `${size(repository.storage.available)} free of ${size(repository.storage.size)} · ${Math.round(percent)}% full`,
        `The filesystem holding the repository, read ${age(repository.storage.read_epoch)}; it stores ${size(stored)}`);
    }
    return {
      label: repository.name,
      href: link(["repositories", repository.id]),
      value_text: `${size(stored)} of ${size(original)}`,
      percent: (stored ?? 0) / largest * 100,
      color: "var(--series-3)",
      marks: [],
      title: original && stored ? `${(original / stored).toFixed(1)}× smaller than the original` : null,
      behind: { percent: (original ?? 0) / largest * 100, color: "var(--series-1)" },
    };
  });
  return <Meters rows={rows} message="No sizes yet; they appear after a poll reads each repository's stats." />;
}

// ── Runs ─────────────────────────────────────────────────────────────────────

// The outcome donut beside the runs per period.
function RunPanels({ runs, span }: { runs: Run[]; span: Span }) {
  return <div className="stack"><OutcomeDonut runs={runs} span={span} /><RunsChart runs={runs} span={span} /></div>;
}

// How the finished runs of the period ended, with the share that succeeded in the middle.
function OutcomeDonut({ runs, span }: { runs: Run[]; span: Span }) {
  const since = now_seconds() - (span === "24h" ? day_in_seconds : 7 * day_in_seconds);
  const inside = runs.filter((run) => run.started_epoch >= since && run.state !== "running");
  const parts = outcome_parts.filter(([state]) => state !== "running").map(([state, label, color]) => ({ label, color, value: inside.filter((run) => run.state === state).length }));
  const succeeded = parts[0].value;
  return (
    <Donut title={span === "24h" ? "Outcomes, last 24 hours" : "Outcomes, last 7 days"} parts={parts}
      center={inside.length ? `${Math.round(succeeded / inside.length * 100)}%` : "—"} center_label="succeeded" message="No run finished in this period." />
  );
}

// One lane per repository over the period: each run as a span in its outcome's color, and each archive as a tick when it was made.
function ActivityTimeline({ repositories, runs, histories, span }: { repositories: RepositorySummary[]; runs: Run[]; histories: Map<string, History>; span: Span }) {
  const now = now_seconds();
  const from = now - (span === "24h" ? day_in_seconds : 7 * day_in_seconds);
  const rows = [...repositories].sort((first, second) => first.name.localeCompare(second.name)).map((repository) => ({
    label: repository.name,
    href: link(["repositories", repository.id]),
    marks: [
      ...runs.filter((run) => run.target_id === repository.id && (run.ended_epoch ?? now) >= from).map((run) => ({
        start: run.started_epoch, end: run.ended_epoch ?? now, color: run_color(run.state),
        title: `${run.kind} #${run.id} ${run.state}, ${stamp(run.started_epoch)}, took ${duration((run.ended_epoch ?? now) - run.started_epoch)}`,
      })),
      ...(histories.get(repository.id)?.archives ?? []).filter((archive) => archive.epoch >= from).map((archive) => ({
        start: archive.epoch, end: null, color: "var(--text-heading)", title: `archive ${archive.name}, ${stamp(archive.epoch)}`,
      })),
    ],
  }));
  return (
    <Timeline title={span === "24h" ? "Last 24 hours" : "Last 7 days"} rows={rows} from={from} to={now}
      legend={[...outcome_parts.map(([, label, color]): [string, string] => [label, color]), ["archive", "var(--text-heading)"]]}
      message="No runs or archives in this period." />
  );
}

function run_color(state: Run["state"]): string {
  return outcome_parts.find(([candidate]) => candidate === state)![2];
}

const outcome_parts: [state: Run["state"], label: string, color: string][] = [
  ["succeeded", "succeeded", "var(--status-success)"],
  ["warning", "with warnings", "var(--status-warning)"],
  ["failed", "failed", "var(--status-danger)"],
  ["cancelled", "cancelled", "var(--text-tertiary)"],
  ["running", "running", "var(--accent)"],
];

// Runs per hour over the last day, or per day over the last week, stacked by outcome.
function RunsChart({ runs, span }: { runs: Run[]; span: Span }) {
  const hours = span === "24h";
  const bucket = hours ? 3600 : day_in_seconds;
  const count = hours ? 24 : 7;
  const now = now_seconds();
  const start = hours ? Math.floor(now / bucket) * bucket - (count - 1) * bucket : day_start(now) - (count - 1) * day_in_seconds;
  const stacks: Stack[] = Array.from({ length: count }, (_, index) => {
    const from = start + index * bucket;
    const inside = runs.filter((run) => run.started_epoch >= from && run.started_epoch < from + bucket);
    const when = new Date(from * 1000);
    return {
      label: hours ? `${String(when.getHours()).padStart(2, "0")}:00` : when.toLocaleDateString(undefined, { weekday: "short" }),
      parts: outcome_parts.map(([state, label, color]) => ({ label, color, value: inside.filter((run) => run.state === state).length })),
    };
  });
  return (
    <StackedBarChart title={hours ? "Runs per hour, last 24 hours" : "Runs per day, last 7 days"} stacks={stacks}
      legend={outcome_parts.map(([, label, color]): [string, string] => [label, color])} format={(value) => String(Math.round(value))} />
  );
}

function day_start(epoch: number): number {
  return start_of_day(new Date(epoch * 1000)).getTime() / 1000;
}

// ── Next ─────────────────────────────────────────────────────────────────────

function RunningList({ runs }: { runs: Run[] }) {
  const running = runs.filter((run) => run.state === "running");
  if (running.length === 0) return <Empty title="Nothing is running." />;
  return (
    <ul className="plain-list">
      {running.map((run) => (
        <li key={run.id}>
          <RunBadge state={run.state} />{" "}
          <a href={link(["runs", String(run.id)])}>{`${run.kind} #${run.id}`}</a>
          <span className="muted">{` on ${run.target_id}, started ${age(run.started_epoch)}`}</span>
          {run.progress && <div className="muted small">{run.progress}</div>}
        </li>
      ))}
    </ul>
  );
}

// The soonest task and timer runs together, a task marked as one.
function UpcomingList({ timers, tasks }: { timers: TimerRow[]; tasks: TaskView[] }) {
  const next = [
    ...tasks.filter((task) => task.enabled && task.next_due !== null).map((task) => ({
      epoch: task.next_due!, task: true, name: `${task_label(task)} of ${task.owner}`, where: task.description,
    })),
    ...timers.filter((timer) => timer.next_epoch !== null).map((timer) => ({ epoch: timer.next_epoch!, task: false, name: timer.unit, where: `on ${timer.host}` })),
  ].sort((first, second) => first.epoch - second.epoch).slice(0, 8);
  if (next.length === 0) return <Empty title="Nothing scheduled." hint="Tasks show once a job has a schedule, and timers are read from each host's systemd." />;
  return (
    <ul className="plain-list">
      {next.map((item, index) => (
        <li key={index}>
          <strong title={stamp(item.epoch)}>{item.epoch <= now_seconds() ? "due now" : until(item.epoch)}</strong>{" "}
          {item.task && <Chip>task</Chip>}{item.task ? " " : null}
          <span>{item.name}</span><span className="muted">{` · ${item.where}`}</span>
        </li>
      ))}
    </ul>
  );
}

// ── Stored ───────────────────────────────────────────────────────────────────

// Every repository's history over the stored span, an empty one for any that fails to load.
async function fetch_histories(repositories: RepositorySummary[]): Promise<Map<string, History>> {
  const since = Math.floor(now_seconds() - stored_span_in_days * day_in_seconds);
  const histories = await Promise.all(repositories.map((repository) =>
    api<History>(`${repository_path(repository.id)}/history${query({ since })}`).catch((): History => ({ polls: [], archives: [] }))));
  return new Map(repositories.map((repository, index) => [repository.id, histories[index]]));
}

// Sums every repository's stored size per day, carrying each one's last reading forward over days it was not polled.
function StoredChart({ repositories, histories: by_repository }: { repositories: RepositorySummary[]; histories: Map<string, History> }) {
  const histories = repositories.map((repository) => by_repository.get(repository.id) ?? { polls: [], archives: [] });
  const days = new Set<number>();
  for (const history of histories) for (const poll of history.polls) days.add(day_start(poll.epoch));
  const ordered = [...days].sort((first, second) => first - second);
  const sums = (field: "deduplicated_size" | "original_size") => ordered.map((day): [number, number | null] => {
    let total = 0;
    for (const history of histories) {
      const last = history.polls.filter((poll) => poll.epoch < day + day_in_seconds && poll[field] !== null).at(-1);
      total += last?.[field] ?? 0;
    }
    return [day, total];
  });
  return (
    <LineChart title="All repositories" format={size} series={[
      { label: "original", color: "var(--series-1)", points: sums("original_size") },
      { label: "stored", color: "var(--series-3)", points: sums("deduplicated_size") },
    ]} />
  );
}
