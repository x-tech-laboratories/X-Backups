// The fleet at a glance: tiles that open filtered views, what needs attention and why, backup ages and sizes, jobs and archives over time, and what runs next.

import { failing, overdue, repository_reasons, timer_problem } from "../attention.ts";
import { api, query, repository_path, type History, type Job, type RepositorySummary, type TimerRow } from "../api.ts";
import { donut, line_chart, meters, stacked_bar_chart, timeline, type Meter, type Stack } from "../charts.ts";
import { age, duration, h, now_seconds, size, stamp, until } from "../dom.ts";
import { current_route, link, replace_query } from "../router.ts";
import { attempt, empty, job_badge, load, section, skeleton } from "../ui.ts";
import { repository_card, status_rank, touches, type View } from "./shared.ts";

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
  const running = h("div");
  const upcoming = h("div");
  const stored = h("div");
  const grid = h("div", { class: "grid" });
  let span = current_route().query.get("span") === "24h" ? "24h" : "7d";
  let jobs: Job[] = [];
  let repositories: RepositorySummary[] = [];
  let histories: Map<string, History> | null = null;

  const span_switch = h("div", { class: "segmented", role: "group", "aria-label": "Period" },
    ...(["24h", "7d"] as const).map((value) => h("button", {
      "aria-pressed": String(span === value),
      onclick: (event: Event) => {
        span = value;
        replace_query({ span: value === "7d" ? null : value });
        for (const button of (event.target as HTMLElement).parentElement!.children) button.setAttribute("aria-pressed", String(button.textContent === value));
        void load(activity, async () => job_panels(jobs, span), { quiet: true });
        if (histories) void load(timeline_box, async () => activity_timeline(repositories, jobs, histories!, span), { quiet: true });
      },
    }, value)));

  const update = async (quiet: boolean, with_history = true): Promise<void> => {
    const answer = await attempt(tiles, quiet, () => Promise.all([
      api<RepositorySummary[]>("/api/repositories"),
      api<Job[]>(`/api/jobs${query({ since: Math.floor(now_seconds() - 7 * day_in_seconds), limit: 2000 })}`),
      api<TimerRow[]>("/api/timers"),
    ]), () => void update(false));
    if (answer === null) return;
    const [listed, recent, timers] = answer;
    repositories = listed;
    jobs = recent;
    await Promise.all([
      load(tiles, async () => overview_tiles(listed, timers, recent), { quiet }),
      load(attention, async () => attention_list(listed, timers), { quiet }),
      load(ages, async () => backup_ages(listed), { quiet }),
      load(storage, async () => storage_bars(listed), { quiet }),
      load(activity, async () => job_panels(recent, span), { quiet }),
      load(running, async () => running_list(recent), { quiet }),
      load(upcoming, async () => upcoming_list(timers), { quiet }),
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

  for (const target of [tiles, attention, ages, storage, activity, timeline_box, running, upcoming, stored, grid]) target.append(skeleton());
  void update(false);

  return {
    title: "Overview",
    root: h("div", { class: "page" },
      h("h1", {}, "Overview"),
      tiles,
      h("div", { class: "columns" },
        section("Needs attention", attention),
        section("Jobs", activity, span_switch),
      ),
      h("div", { class: "columns" },
        section("Time since last backup", ages, h("span", { class: "muted small" }, "ticks at the warning and max age")),
        section("Storage per repository", storage, h("span", { class: "muted small" }, "stored, over the original")),
      ),
      section("Activity", timeline_box, h("span", { class: "muted small" }, "jobs and archives, by the period above")),
      h("div", { class: "columns" },
        h("div", { class: "stack" },
          section("Running now", running, h("a", { href: link(["jobs"], { state: "running" }) }, "All running")),
          section("Next timer runs", upcoming, h("a", { href: link(["schedules"]) }, "All schedules")),
        ),
        section("Stored over time", stored, h("span", { class: "muted small" }, `last ${stored_span_in_days} days`)),
      ),
      section("Repositories", grid, h("a", { href: link(["repositories"]) }, "Filter and sort")),
    ),
    update: async (changes) => {
      if (touches(changes, null, ["repository", "job", "timers", "config"])) await update(true, touches(changes, null, ["repository", "config"]));
    },
  };
}

function overview_tiles(repositories: RepositorySummary[], timers: TimerRow[], jobs: Job[]): HTMLElement {
  const bad = repositories.filter(failing).length;
  const late = repositories.filter((repository) => repository.last_poll_epoch !== null && overdue(repository)).length;
  const timer_trouble = timers.filter((timer) => timer_problem(timer) !== null).length;
  const running = jobs.filter((job) => job.state === "running").length;
  const failed_today = jobs.filter((job) => job.state === "failed" && job.started_epoch > now_seconds() - day_in_seconds).length;
  const total = repositories.reduce((sum, repository) => sum + (repository.stats?.deduplicated_size ?? 0), 0);
  const tile = (label: string, value: string | number, href: string | null, tone: "bad" | "info" | "" = "") => {
    const body = [h("span", { class: "tile-value" }, value), h("span", { class: "tile-label" }, label)];
    return href ? h("a", { class: `tile ${tone ? `tile-${tone}` : ""}`, href }, ...body) : h("div", { class: "tile" }, ...body);
  };
  return h("div", { class: "tiles" },
    tile("repositories", repositories.length, link(["repositories"])),
    tile("failing", bad, link(["repositories"], { status: "failing" }), bad > 0 ? "bad" : ""),
    tile("overdue", late, link(["repositories"], { status: "overdue" }), late > 0 ? "bad" : ""),
    tile("timer problems", timer_trouble, link(["schedules"], { state: "problem" }), timer_trouble > 0 ? "bad" : ""),
    tile("jobs running", running, link(["jobs"], { state: "running" }), running > 0 ? "info" : ""),
    tile("failed jobs, 24 h", failed_today, link(["jobs"], { state: "failed" }), failed_today > 0 ? "bad" : ""),
    tile("stored", size(total), null),
  );
}

function attention_list(repositories: RepositorySummary[], timers: TimerRow[]): HTMLElement {
  const items = [
    ...repositories.flatMap((repository) => repository_reasons(repository).map((reason) => ({
      tone: reason.tone, href: link(["repositories", repository.id]), name: repository.name, text: reason.text,
    }))),
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
      label: `${repository.name} · ${repository.host}`,
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

// One bar per repository of what it stores, against the largest, with its original size drawn faintly beneath.
function storage_bars(repositories: RepositorySummary[]): HTMLElement {
  const sized = repositories.filter((repository) => repository.stats?.deduplicated_size != null);
  const largest = Math.max(1, ...sized.map((repository) => Math.max(repository.stats!.deduplicated_size ?? 0, repository.stats!.original_size ?? 0)));
  const rows = sized.sort((a, b) => (b.stats!.deduplicated_size ?? 0) - (a.stats!.deduplicated_size ?? 0)).map((repository): Meter => {
    const { original_size: original, deduplicated_size: stored } = repository.stats!;
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

// The outcome donut beside the jobs per period.
function job_panels(jobs: Job[], span: string): HTMLElement {
  return h("div", { class: "stack" }, outcome_donut(jobs, span), jobs_chart(jobs, span));
}

// How the finished jobs of the period ended, with the share that succeeded in the middle.
function outcome_donut(jobs: Job[], span: string): HTMLElement {
  const since = now_seconds() - (span === "24h" ? day_in_seconds : 7 * day_in_seconds);
  const inside = jobs.filter((job) => job.started_epoch >= since && job.state !== "running");
  const parts = outcome_parts.filter(([state]) => state !== "running").map(([state, label, color]) => ({ label, color, value: inside.filter((job) => job.state === state).length }));
  const succeeded = parts[0].value;
  return donut(span === "24h" ? "Outcomes, last 24 hours" : "Outcomes, last 7 days", parts,
    inside.length ? `${Math.round(succeeded / inside.length * 100)}%` : "—", "succeeded", "No job finished in this period.");
}

// One lane per repository over the period: each job as a span in its outcome's color, and each archive as a tick when it was made.
function activity_timeline(repositories: RepositorySummary[], jobs: Job[], histories: Map<string, History>, span: string): HTMLElement {
  const now = now_seconds();
  const from = now - (span === "24h" ? day_in_seconds : 7 * day_in_seconds);
  const rows = [...repositories].sort((a, b) => a.name.localeCompare(b.name)).map((repository) => ({
    label: repository.name,
    href: link(["repositories", repository.id]),
    marks: [
      ...jobs.filter((job) => job.repository_id === repository.id && (job.ended_epoch ?? now) >= from).map((job) => ({
        start: job.started_epoch, end: job.ended_epoch ?? now, color: job_color(job.state),
        title: `${job.kind} #${job.id} ${job.state}, ${stamp(job.started_epoch)}, took ${duration((job.ended_epoch ?? now) - job.started_epoch)}`,
      })),
      ...(histories.get(repository.id)?.archives ?? []).filter((archive) => archive.epoch >= from).map((archive) => ({
        start: archive.epoch, end: null, color: "var(--text-heading)", title: `archive ${archive.name}, ${stamp(archive.epoch)}`,
      })),
    ],
  }));
  return timeline(span === "24h" ? "Last 24 hours" : "Last 7 days", rows, from, now,
    [...outcome_parts.map(([, label, color]): [string, string] => [label, color]), ["archive", "var(--text-heading)"]],
    "No jobs or archives in this period.");
}

function job_color(state: Job["state"]): string {
  return outcome_parts.find(([candidate]) => candidate === state)![2];
}

const outcome_parts: [state: Job["state"], label: string, color: string][] = [
  ["succeeded", "succeeded", "var(--status-success)"],
  ["warning", "with warnings", "var(--status-warning)"],
  ["failed", "failed", "var(--status-danger)"],
  ["cancelled", "cancelled", "var(--text-tertiary)"],
  ["running", "running", "var(--accent)"],
];

// Jobs per hour over the last day, or per day over the last week, stacked by outcome.
function jobs_chart(jobs: Job[], span: string): HTMLElement {
  const hours = span === "24h";
  const bucket = hours ? 3600 : day_in_seconds;
  const count = hours ? 24 : 7;
  const now = now_seconds();
  const start = hours ? Math.floor(now / bucket) * bucket - (count - 1) * bucket : start_of_day(now) - (count - 1) * day_in_seconds;
  const stacks: Stack[] = Array.from({ length: count }, (_, index) => {
    const from = start + index * bucket;
    const inside = jobs.filter((job) => job.started_epoch >= from && job.started_epoch < from + bucket);
    const when = new Date(from * 1000);
    return {
      label: hours ? `${String(when.getHours()).padStart(2, "0")}:00` : when.toLocaleDateString(undefined, { weekday: "short" }),
      parts: outcome_parts.map(([state, label, color]) => ({ label, color, value: inside.filter((job) => job.state === state).length })),
    };
  });
  return stacked_bar_chart(hours ? "Jobs per hour, last 24 hours" : "Jobs per day, last 7 days", stacks,
    outcome_parts.map(([, label, color]) => [label, color]), (value) => String(Math.round(value)));
}

function start_of_day(epoch: number): number {
  const date = new Date(epoch * 1000);
  date.setHours(0, 0, 0, 0);
  return date.getTime() / 1000;
}

function running_list(jobs: Job[]): HTMLElement {
  const running = jobs.filter((job) => job.state === "running");
  if (running.length === 0) return empty("Nothing is running.");
  return h("ul", { class: "plain-list" }, ...running.map((job) => h("li", {},
    job_badge(job.state), " ",
    h("a", { href: link(["jobs", String(job.id)]) }, `${job.kind} #${job.id}`),
    h("span", { class: "muted" }, ` on ${job.repository_id}, started ${age(job.started_epoch)}`),
    job.progress && h("div", { class: "muted small" }, job.progress),
  )));
}

function upcoming_list(timers: TimerRow[]): HTMLElement {
  const next = timers.filter((timer) => timer.next_epoch !== null).sort((a, b) => a.next_epoch! - b.next_epoch!).slice(0, 8);
  if (next.length === 0) return empty("No upcoming timer runs.", "Timers are read from each host's systemd.");
  return h("ul", { class: "plain-list" }, ...next.map((timer) => h("li", {},
    h("strong", { title: stamp(timer.next_epoch!) }, until(timer.next_epoch)), " ",
    h("span", {}, timer.unit), h("span", { class: "muted" }, ` on ${timer.host}`),
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
