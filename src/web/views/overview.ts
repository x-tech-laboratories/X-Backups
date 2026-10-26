// The fleet at a glance: tiles that open filtered views, what needs attention and why, jobs over time, and what runs next.

import { failing, overdue, repository_reasons, timer_problem } from "../attention.ts";
import { api, query, repository_path, type History, type Job, type RepositorySummary, type TimerRow } from "../api.ts";
import { line_chart, stacked_bar_chart, type Stack } from "../charts.ts";
import { age, h, now_seconds, size, stamp, until } from "../dom.ts";
import { current_route, link, replace_query } from "../router.ts";
import { attempt, empty, job_badge, load, section, skeleton } from "../ui.ts";
import { repository_card, status_rank, touches, type View } from "./shared.ts";

const day_in_seconds = 86400;
const stored_span_in_days = 90;

export function overview_view(): View {
  const tiles = h("div");
  const attention = h("div");
  const activity = h("div");
  const running = h("div");
  const upcoming = h("div");
  const stored = h("div");
  const grid = h("div", { class: "grid" });
  let span = current_route().query.get("span") === "24h" ? "24h" : "7d";
  let jobs: Job[] = [];

  const span_switch = h("div", { class: "segmented", role: "group", "aria-label": "Period" },
    ...(["24h", "7d"] as const).map((value) => h("button", {
      "aria-pressed": String(span === value),
      onclick: (event: Event) => {
        span = value;
        replace_query({ span: value === "7d" ? null : value });
        for (const button of (event.target as HTMLElement).parentElement!.children) button.setAttribute("aria-pressed", String(button.textContent === value));
        void load(activity, async () => jobs_chart(jobs, span), { quiet: true });
      },
    }, value)));

  const update = async (quiet: boolean, with_history = true): Promise<void> => {
    const answer = await attempt(tiles, quiet, () => Promise.all([
      api<RepositorySummary[]>("/api/repositories"),
      api<Job[]>(`/api/jobs${query({ since: Math.floor(now_seconds() - 7 * day_in_seconds), limit: 2000 })}`),
      api<TimerRow[]>("/api/timers"),
    ]), () => void update(false));
    if (answer === null) return;
    const [repositories, recent, timers] = answer;
    jobs = recent;
    await Promise.all([
      load(tiles, async () => overview_tiles(repositories, timers, recent), { quiet }),
      load(attention, async () => attention_list(repositories, timers), { quiet }),
      load(activity, async () => jobs_chart(recent, span), { quiet }),
      load(running, async () => running_list(recent), { quiet }),
      load(upcoming, async () => upcoming_list(timers), { quiet }),
      load(grid, async () => [...repositories].sort((a, b) => status_rank(a) - status_rank(b) || a.name.localeCompare(b.name)).map(repository_card), { quiet }),
    ]);
    // The stored total needs every repository's history, so it loads after the rest is on screen, and only when a poll may have added to it.
    if (with_history) void load(stored, async () => stored_chart(repositories), { quiet });
  };

  for (const target of [tiles, attention, activity, running, upcoming, stored, grid]) target.append(skeleton());
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

const outcome_parts: [state: Job["state"], label: string, color: string][] = [
  ["succeeded", "succeeded", "var(--good)"],
  ["failed", "failed", "var(--bad)"],
  ["cancelled", "cancelled", "var(--warn)"],
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

// Sums every repository's stored size per day, carrying each one's last reading forward over days it was not polled.
async function stored_chart(repositories: RepositorySummary[]): Promise<HTMLElement> {
  const since = Math.floor(now_seconds() - stored_span_in_days * day_in_seconds);
  const histories = await Promise.all(repositories.map((repository) =>
    api<History>(`${repository_path(repository.id)}/history${query({ since })}`).catch(() => ({ polls: [], archives: [] }))));
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
    { label: "original", color: "var(--chart-1)", points: sums("original_size") },
    { label: "stored", color: "var(--chart-3)", points: sums("deduplicated_size") },
  ], size);
}
