// The fleet at a glance: tiles that open filtered views, what needs attention and why (by target, agent and task), the
// backup flow from folders through jobs to repositories, backup ages and sizes, runs and archives over time, and what
// runs next.

import { failing, overdue, repository_reasons, timer_problem } from "../attention.ts";
import { api, query, repository_path, type History, type HostRow, type HostSample, type Run, type RepositorySummary, type TaskView, type TimerRow } from "../api.ts";
import { donut, line_chart, meters, stacked_bar_chart, timeline, type Meter, type Stack } from "../charts.ts";
import { age, duration, h, now_seconds, size, stamp, until } from "../dom.ts";
import { current_route, link, replace_query } from "../router.ts";
import { attempt, empty, run_badge, load, section, skeleton } from "../ui.ts";
import { agent_away, host_health } from "./hosts.ts";
import { repository_card, status_rank, target_label, touches, type View } from "./shared.ts";
import { map_section } from "./map.ts";
import { task_label } from "./tasks.ts";

const day_in_seconds = 86400;
const stored_span_in_days = 90;
// A backup meter is full at twice its repository's max age, so the max age sits at its middle.
const backup_scale = 2;

export function overview_view(): View {
  const tiles = h("div");
  const attention = h("div");
  const ages = h("div");
  const storage = h("div");
  const activity = h("div");
  const timeline_box = h("div");
  const hosts_box = h("div");
  const running = h("div");
  const upcoming = h("div");
  const stored = h("div");
  const grid = h("div", { class: "grid" });
  const flow = map_section();
  let span = current_route().query.get("span") === "24h" ? "24h" : "7d";
  let runs: Run[] = [];
  let repositories: RepositorySummary[] = [];
  let histories: Map<string, History> | null = null;

  const span_switch = h("div", { class: "segmented", role: "group", "aria-label": "Period" },
    ...(["24h", "7d"] as const).map((value) => h("button", {
      "aria-pressed": String(span === value),
      onclick: (event: Event) => {
        span = value;
        replace_query({ span: value === "7d" ? null : value });
        for (const button of (event.target as HTMLElement).parentElement!.children) button.setAttribute("aria-pressed", String(button.textContent === value));
        void load(activity, async () => run_panels(runs, span), { quiet: true });
        if (histories) void load(timeline_box, async () => activity_timeline(repositories, runs, histories!, span), { quiet: true });
      },
    }, value)));

  const update = async (quiet: boolean, with_history = true): Promise<void> => {
    const answer = await attempt(tiles, quiet, () => Promise.all([
      api<RepositorySummary[]>("/api/repositories"),
      api<Run[]>(`/api/runs${query({ since: Math.floor(now_seconds() - 7 * day_in_seconds), limit: 2000 })}`),
      api<TimerRow[]>("/api/timers"),
      api<HostSample[]>(`/api/hosts/samples${query({ since: Math.floor(now_seconds() - day_in_seconds) })}`),
      api<HostRow[]>("/api/hosts"),
      api<TaskView[]>("/api/tasks").catch((): TaskView[] => []),
    ]), () => void update(false));
    if (answer === null) return;
    const [listed, recent, timers, samples, hosts, tasks] = answer;
    repositories = listed;
    runs = recent;
    await Promise.all([
      load(tiles, async () => overview_tiles(listed, timers, recent, hosts, tasks), { quiet }),
      load(attention, async () => attention_list(listed, timers, hosts, tasks), { quiet }),
      load(ages, async () => backup_ages(listed), { quiet }),
      load(storage, async () => storage_bars(listed), { quiet }),
      load(activity, async () => run_panels(recent, span), { quiet }),
      load(running, async () => running_list(recent), { quiet }),
      load(upcoming, async () => upcoming_list(timers, tasks), { quiet }),
      load(hosts_box, async () => host_health(samples), { quiet }),
      load(grid, async () => [...listed].sort((a, b) => status_rank(a) - status_rank(b) || a.name.localeCompare(b.name)).map(repository_card), { quiet }),
    ]);
    // The stored total and the archives on the timeline need every repository's history, so they load after the rest is on screen, and the history is fetched again only when a poll may have added to it.
    if (with_history || histories === null) histories = await fetch_histories(listed);
    const fetched = histories;
    await Promise.all([
      load(stored, async () => stored_chart(listed, fetched), { quiet }),
      load(timeline_box, async () => activity_timeline(listed, recent, fetched, span), { quiet }),
    ]);
  };

  for (const target of [tiles, attention, ages, storage, activity, timeline_box, hosts_box, running, upcoming, stored, grid]) target.append(skeleton());
  void update(false);

  return {
    title: "Overview",
    root: h("div", { class: "page" },
      h("h1", {}, "Overview"),
      tiles,
      h("div", { class: "columns" },
        section("Needs attention", attention),
        section("Runs", activity, span_switch),
      ),
      flow.root,
      h("div", { class: "columns" },
        section("Time since last backup", ages, h("span", { class: "muted small" }, "ticks at the warning and max age")),
        section("Storage per repository", storage, h("span", { class: "muted small" }, `against its quota or disk; ticks at ${storage_warning_percent}% and ${storage_danger_percent}%`)),
      ),
      section("Activity", timeline_box, h("span", { class: "muted small" }, "runs and archives, by the period above")),
      section("Hosts", hosts_box, h("span", { class: "muted small" }, "last 24 hours, read every five minutes")),
      h("div", { class: "columns" },
        h("div", { class: "stack" },
          section("Running now", running, h("a", { href: link(["runs"], { state: "running" }) }, "All running")),
          section("Next up", upcoming, h("a", { href: link(["schedules"]) }, "All schedules")),
        ),
        section("Stored over time", stored, h("span", { class: "muted small" }, `last ${stored_span_in_days} days`)),
      ),
      section("Targets", grid, h("a", { href: link(["repositories"]) }, "Filter and sort")),
    ),
    update: async (changes) => {
      await Promise.all([
        touches(changes, null, ["repository", "run", "timers", "hosts", "config", "tasks"]) ? update(true, touches(changes, null, ["repository", "config"])) : null,
        flow.update(changes),
      ]);
    },
  };
}

function overview_tiles(repositories: RepositorySummary[], timers: TimerRow[], runs: Run[], hosts: HostRow[], tasks: TaskView[]): HTMLElement {
  const bad = repositories.filter(failing).length;
  const away = hosts.filter(agent_away).length;
  const waiting = tasks.filter((task) => task.waiting !== null).length;
  const late = repositories.filter((repository) => repository.last_poll_epoch !== null && overdue(repository)).length;
  const timer_trouble = timers.filter((timer) => timer_problem(timer) !== null).length;
  const running = runs.filter((run) => run.state === "running").length;
  const failed_today = runs.filter((run) => run.state === "failed" && run.started_epoch > now_seconds() - day_in_seconds).length;
  const total = repositories.reduce((sum, repository) => sum + (repository.stats?.deduplicated_size ?? 0), 0);
  const tile = (label: string, value: string | number, href: string | null, tone: "bad" | "info" | "" = "") => {
    const body = [h("span", { class: "tile-value" }, value), h("span", { class: "tile-label" }, label)];
    return href ? h("a", { class: `tile ${tone ? `tile-${tone}` : ""}`, href }, ...body) : h("div", { class: "tile" }, ...body);
  };
  return h("div", { class: "tiles" },
    tile("targets", repositories.length, link(["repositories"])),
    tile("failing", bad, link(["repositories"], { status: "failing" }), bad > 0 ? "bad" : ""),
    tile("overdue", late, link(["repositories"], { status: "overdue" }), late > 0 ? "bad" : ""),
    tile("agents away", away, link(["hosts"], { state: "away" }), away > 0 ? "bad" : ""),
    tile("tasks waiting", waiting, link(["schedules"], { state: "problem" }), waiting > 0 ? "info" : ""),
    tile("timer problems", timer_trouble, link(["schedules"], { state: "problem" }), timer_trouble > 0 ? "bad" : ""),
    tile("runs in progress", running, link(["runs"], { state: "running" }), running > 0 ? "info" : ""),
    tile("failed runs, 24 h", failed_today, link(["runs"], { state: "failed" }), failed_today > 0 ? "bad" : ""),
    tile("stored", size(total), null),
  );
}

function attention_list(repositories: RepositorySummary[], timers: TimerRow[], hosts: HostRow[], tasks: TaskView[]): HTMLElement {
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
  ].sort((a, b) => (a.tone === "bad" ? 0 : 1) - (b.tone === "bad" ? 0 : 1));
  if (items.length === 0) return h("div", { class: "all-good" }, h("span", { "aria-hidden": "true" }, "✓ "), "Everything looks healthy.");
  return h("ul", { class: "attention" }, ...items.map((item) => h("li", { class: `tone-edge-${item.tone}` },
    h("span", { class: `badge tone-${item.tone}` }, item.tone === "bad" ? "problem" : "warning"),
    h("a", { href: item.href }, item.name),
    h("span", {}, item.text),
  )));
}

// One meter per repository of the time since its newest archive, the stalest against its max age first.
function backup_ages(repositories: RepositorySummary[]): HTMLElement {
  const now = now_seconds();
  const stale = (repository: RepositorySummary) => repository.last_backup_epoch ? (now - repository.last_backup_epoch) / repository.max_age : Infinity;
  const rows = [...repositories].sort((a, b) => stale(b) - stale(a) || a.name.localeCompare(b.name)).map((repository): Meter => {
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
  return meters(rows, "No repositories yet.");
}

// A storage bar turns amber at the first share of its limit and red at the second, as BorgWarehouse colours its quota bars.
const storage_warning_percent = 75;
const storage_danger_percent = 90;

// One bar per repository: what it stores against its quota, or how full its filesystem is, or failing both what it stores
// against the largest, with its original size drawn faintly beneath.
function storage_bars(repositories: RepositorySummary[]): HTMLElement {
  const sized = repositories.filter((repository) => repository.stats?.deduplicated_size != null || repository.storage !== null);
  const largest = Math.max(1, ...sized.map((repository) => Math.max(repository.stats?.deduplicated_size ?? 0, repository.stats?.original_size ?? 0)));
  const rows = sized.sort((a, b) => (b.stats?.deduplicated_size ?? 0) - (a.stats?.deduplicated_size ?? 0)).map((repository): Meter => {
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
  return meters(rows, "No sizes yet; they appear after a poll reads each repository's stats.");
}

// The outcome donut beside the runs per period.
function run_panels(runs: Run[], span: string): HTMLElement {
  return h("div", { class: "stack" }, outcome_donut(runs, span), runs_chart(runs, span));
}

// How the finished runs of the period ended, with the share that succeeded in the middle.
function outcome_donut(runs: Run[], span: string): HTMLElement {
  const since = now_seconds() - (span === "24h" ? day_in_seconds : 7 * day_in_seconds);
  const inside = runs.filter((run) => run.started_epoch >= since && run.state !== "running");
  const parts = outcome_parts.filter(([state]) => state !== "running").map(([state, label, color]) => ({ label, color, value: inside.filter((run) => run.state === state).length }));
  const succeeded = parts[0].value;
  return donut(span === "24h" ? "Outcomes, last 24 hours" : "Outcomes, last 7 days", parts,
    inside.length ? `${Math.round(succeeded / inside.length * 100)}%` : "—", "succeeded", "No run finished in this period.");
}

// One lane per repository over the period: each run as a span in its outcome's color, and each archive as a tick when it was made.
function activity_timeline(repositories: RepositorySummary[], runs: Run[], histories: Map<string, History>, span: string): HTMLElement {
  const now = now_seconds();
  const from = now - (span === "24h" ? day_in_seconds : 7 * day_in_seconds);
  const rows = [...repositories].sort((a, b) => a.name.localeCompare(b.name)).map((repository) => ({
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
  return timeline(span === "24h" ? "Last 24 hours" : "Last 7 days", rows, from, now,
    [...outcome_parts.map(([, label, color]): [string, string] => [label, color]), ["archive", "var(--text-heading)"]],
    "No runs or archives in this period.");
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
function runs_chart(runs: Run[], span: string): HTMLElement {
  const hours = span === "24h";
  const bucket = hours ? 3600 : day_in_seconds;
  const count = hours ? 24 : 7;
  const now = now_seconds();
  const start = hours ? Math.floor(now / bucket) * bucket - (count - 1) * bucket : start_of_day(now) - (count - 1) * day_in_seconds;
  const stacks: Stack[] = Array.from({ length: count }, (_, index) => {
    const from = start + index * bucket;
    const inside = runs.filter((run) => run.started_epoch >= from && run.started_epoch < from + bucket);
    const when = new Date(from * 1000);
    return {
      label: hours ? `${String(when.getHours()).padStart(2, "0")}:00` : when.toLocaleDateString(undefined, { weekday: "short" }),
      parts: outcome_parts.map(([state, label, color]) => ({ label, color, value: inside.filter((run) => run.state === state).length })),
    };
  });
  return stacked_bar_chart(hours ? "Runs per hour, last 24 hours" : "Runs per day, last 7 days", stacks,
    outcome_parts.map(([, label, color]) => [label, color]), (value) => String(Math.round(value)));
}

function start_of_day(epoch: number): number {
  const date = new Date(epoch * 1000);
  date.setHours(0, 0, 0, 0);
  return date.getTime() / 1000;
}

function running_list(runs: Run[]): HTMLElement {
  const running = runs.filter((run) => run.state === "running");
  if (running.length === 0) return empty("Nothing is running.");
  return h("ul", { class: "plain-list" }, ...running.map((run) => h("li", {},
    run_badge(run.state), " ",
    h("a", { href: link(["runs", String(run.id)]) }, `${run.kind} #${run.id}`),
    h("span", { class: "muted" }, ` on ${run.target_id}, started ${age(run.started_epoch)}`),
    run.progress && h("div", { class: "muted small" }, run.progress),
  )));
}

// The soonest task and timer runs together, a task marked as one.
function upcoming_list(timers: TimerRow[], tasks: TaskView[]): HTMLElement {
  const next = [
    ...tasks.filter((task) => task.enabled && task.next_due !== null).map((task) => ({
      epoch: task.next_due!, task: true, name: `${task_label(task)} of ${task.owner}`, where: task.description,
    })),
    ...timers.filter((timer) => timer.next_epoch !== null).map((timer) => ({ epoch: timer.next_epoch!, task: false, name: timer.unit, where: `on ${timer.host}` })),
  ].sort((a, b) => a.epoch - b.epoch).slice(0, 8);
  if (next.length === 0) return empty("Nothing scheduled.", "Tasks show once a job has a schedule, and timers are read from each host's systemd.");
  return h("ul", { class: "plain-list" }, ...next.map((item) => h("li", {},
    h("strong", { title: stamp(item.epoch) }, item.epoch <= now_seconds() ? "due now" : until(item.epoch)), " ",
    item.task && h("span", { class: "chip" }, "task"), item.task ? " " : null,
    h("span", {}, item.name), h("span", { class: "muted" }, ` · ${item.where}`),
  )));
}

// Every repository's history over the stored span, an empty one for any that fails to load.
async function fetch_histories(repositories: RepositorySummary[]): Promise<Map<string, History>> {
  const since = Math.floor(now_seconds() - stored_span_in_days * day_in_seconds);
  const histories = await Promise.all(repositories.map((repository) =>
    api<History>(`${repository_path(repository.id)}/history${query({ since })}`).catch((): History => ({ polls: [], archives: [] }))));
  return new Map(repositories.map((repository, index) => [repository.id, histories[index]]));
}

// Sums every repository's stored size per day, carrying each one's last reading forward over days it was not polled.
function stored_chart(repositories: RepositorySummary[], by_repository: Map<string, History>): HTMLElement {
  const histories = repositories.map((repository) => by_repository.get(repository.id) ?? { polls: [], archives: [] });
  const days = new Set<number>();
  for (const history of histories) for (const poll of history.polls) days.add(start_of_day(poll.epoch));
  const ordered = [...days].sort((a, b) => a - b);
  const sums = (field: "deduplicated_size" | "original_size") => ordered.map((day): [number, number | null] => {
    let total = 0;
    for (const history of histories) {
      const last = history.polls.filter((poll) => poll.epoch < day + day_in_seconds && poll[field] !== null).at(-1);
      total += last?.[field] ?? 0;
    }
    return [day, total];
  });
  return line_chart("All repositories", [
    { label: "original", color: "var(--series-1)", points: sums("original_size") },
    { label: "stored", color: "var(--series-3)", points: sums("deduplicated_size") },
  ], size);
}
