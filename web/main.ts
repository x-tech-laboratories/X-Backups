// The page: a login, the repository grid, and each repository's archives, browser, jobs and events.

import {
  api, LoginNeeded, type Action, type EventRow, type History, type Job, type Listing, type Outcome, type RepositoryDetail,
  type RepositorySummary, type TimerRow,
} from "./api.ts";
import { bar_chart, line_chart, strip } from "./charts.ts";
import { age, duration, h, size, stamp } from "./dom.ts";
import "./style.css";

const main = document.querySelector<HTMLElement>("main")!;
const refresh_interval_in_milliseconds = 15_000;
const job_follow_interval_in_milliseconds = 2_000;
const history_span_in_seconds = 90 * 86400;
// A timer whose next run is this far in the past has missed it.
const missed_grace_in_seconds = 3600;

let refresh_timer: number | undefined;

// ── Routing ──────────────────────────────────────────────────────────────────

async function show(): Promise<void> {
  clearTimeout(refresh_timer);
  const repository_id = /^#\/repositories\/(.+)$/.exec(location.hash)?.[1];
  try {
    if (repository_id) await show_repository(decodeURIComponent(repository_id));
    else await show_overview();
  } catch (error) {
    if (error instanceof LoginNeeded) return show_login();
    main.replaceChildren(h("p", { class: "error" }, String(error)));
  }
}

window.addEventListener("hashchange", () => void show());

// Refreshes the parts of a view that change, leaving open panels as they are.
function keep_refreshing(update: () => Promise<void>): void {
  refresh_timer = window.setTimeout(async () => {
    try {
      await update();
    } catch (error) {
      if (error instanceof LoginNeeded) return show_login();
    }
    keep_refreshing(update);
  }, refresh_interval_in_milliseconds);
}

// ── Login ────────────────────────────────────────────────────────────────────

function show_login(): void {
  const password = h("input", { type: "password", name: "password", autocomplete: "current-password", required: true });
  const message = h("p", { class: "error" });
  const form = h("form", { class: "login", onsubmit: async (event: Event) => {
    event.preventDefault();
    try {
      await api("/api/login", { password: password.value });
      void show();
    } catch {
      message.textContent = "Wrong password.";
    }
  } }, h("h2", {}, "Log in"), password, h("button", { type: "submit" }, "Log in"), message);
  main.replaceChildren(form);
  password.focus();
}

document.querySelector("#logout")?.addEventListener("click", async () => {
  await api("/api/logout", {}).catch(() => {});
  show_login();
});

// ── Overview ─────────────────────────────────────────────────────────────────

async function show_overview(): Promise<void> {
  const totals = h("div");
  const grid = h("div", { class: "grid" });
  const schedules = h("div");
  const jobs = h("div");
  const events = h("div");
  const update = async () => {
    const [repositories, recent_jobs, recent_events, timers] = await Promise.all([
      api<RepositorySummary[]>("/api/repositories"),
      api<Job[]>("/api/jobs?limit=15"),
      api<EventRow[]>("/api/events?limit=30"),
      api<TimerRow[]>("/api/timers"),
    ]);
    totals.replaceChildren(totals_row(repositories, timers));
    grid.replaceChildren(...repositories.map(repository_card));
    schedules.replaceChildren(timers_table(timers, true));
    jobs.replaceChildren(jobs_table(recent_jobs, true));
    events.replaceChildren(events_list(recent_events, true));
  };
  await update();
  main.replaceChildren(
    totals,
    h("h2", {}, "Repositories"), grid,
    h("section", {}, h("h2", {}, "Schedules"), schedules),
    h("section", {}, h("h2", {}, "Recent jobs"), jobs),
    h("section", {}, h("h2", {}, "Events"), events),
  );
  keep_refreshing(update);
}

// The fleet at a glance: how many repositories are healthy, failing or overdue, and what they store.
function totals_row(repositories: RepositorySummary[], timers: TimerRow[]): HTMLElement {
  const failing = repositories.filter((repository) => repository.status === "failed" || repository.status === "unavailable").length;
  const late = repositories.filter(overdue).length;
  const stored = repositories.reduce((sum, repository) => sum + (repository.stats?.deduplicated_size ?? 0), 0);
  const running = repositories.filter((repository) => repository.running_job).length;
  const missed = timers.filter((timer) => timer_problem(timer) !== null).length;
  const tile = (label: string, value: string | number, bad = false) =>
    h("div", { class: bad ? "tile tile-bad" : "tile" }, h("div", { class: "tile-value" }, value), h("div", { class: "muted" }, label));
  return h("div", { class: "tiles" },
    tile("repositories", repositories.length),
    tile("failing", failing, failing > 0),
    tile("overdue", late, late > 0),
    tile("timer problems", missed, missed > 0),
    tile("jobs running", running),
    tile("stored", size(stored)),
  );
}

// Why a timer needs attention: it missed its run, its last run failed, or it never ran; null when it is fine.
function timer_problem(timer: TimerRow): string | null {
  const now = Date.now() / 1000;
  if (timer.next_epoch !== null && timer.next_epoch < now - missed_grace_in_seconds) return "missed";
  if (timer.result !== null && timer.result !== "success") return `last run: ${timer.result}${timer.exit_status ? ` (exit ${timer.exit_status})` : ""}`;
  if (timer.last_epoch === null) return "never ran";
  return null;
}

function until(epoch: number | null): string {
  if (epoch === null) return "—";
  const seconds = epoch - Date.now() / 1000;
  return seconds < 0 ? age(epoch) : `in ${duration(seconds)}`;
}

function timers_table(timers: TimerRow[], with_host: boolean): HTMLElement {
  if (timers.length === 0) return h("p", { class: "muted" }, "No backup timers found on the hosts.");
  return h("table", {},
    h("thead", {}, h("tr", {}, with_host && h("th", {}, "Host"), h("th", {}, "Timer"), h("th", {}, "Last run"), h("th", {}, "Next run"), h("th", {}, "State"))),
    h("tbody", {}, ...timers.map((timer) => {
      const problem = timer_problem(timer);
      return h("tr", {},
        with_host && h("td", {}, timer.host),
        h("td", { title: timer.service }, timer.unit),
        h("td", { title: timer.last_epoch ? stamp(timer.last_epoch) : "" }, age(timer.last_epoch)),
        h("td", { title: timer.next_epoch ? stamp(timer.next_epoch) : "" }, until(timer.next_epoch)),
        h("td", {}, h("span", { class: `badge ${problem ? "status-failed" : "status-online"}` }, problem ?? "ok")),
      );
    })),
  );
}

function overdue(repository: RepositorySummary): boolean {
  return !repository.last_backup_epoch || Date.now() / 1000 - repository.last_backup_epoch > repository.max_age;
}

function status_badge(status: string | null): HTMLElement {
  return h("span", { class: `badge status-${status ?? "unknown"}` }, status ?? "not polled");
}

function verdict(ok: boolean | null | undefined, label: string): HTMLElement {
  const text = ok === null || ok === undefined ? "—" : ok ? "pass" : "fail";
  return h("span", { class: `verdict verdict-${text === "—" ? "none" : text}`, title: label }, `${label}: ${text}`);
}

function repository_card(repository: RepositorySummary): HTMLElement {
  return h("a", { class: "card", href: `#/repositories/${encodeURIComponent(repository.id)}` },
    h("div", { class: "card-head" }, h("strong", {}, repository.name), status_badge(repository.status)),
    h("div", { class: "muted" }, repository.host),
    h("dl", {},
      h("dt", {}, "Last backup"),
      h("dd", { class: overdue(repository) ? "overdue" : "" }, age(repository.last_backup_epoch), overdue(repository) ? " · overdue" : ""),
      h("dt", {}, "Archives"), h("dd", {}, repository.archive_count ?? "—"),
      h("dt", {}, "Stored"), h("dd", {}, size(repository.stats?.deduplicated_size)),
      h("dt", {}, "Original"), h("dd", {}, size(repository.stats?.original_size)),
    ),
    h("div", { class: "verdicts" }, verdict(repository.checks_passed, "checks"), verdict(repository.canary?.ok, "canary")),
    repository.running_job && h("div", { class: "running" }, `${repository.running_job.kind} running`, repository.running_job.progress ? ` · ${repository.running_job.progress}` : ""),
  );
}

// ── Repository ───────────────────────────────────────────────────────────────

async function show_repository(id: string): Promise<void> {
  const base = `/api/repositories/${encodeURIComponent(id)}`;
  const header = h("div");
  const actions = h("div", { class: "actions" });
  const output = h("div", { class: "output-panel" });
  const history = h("div", { class: "charts" });
  const sources = h("div");
  const schedules = h("div");
  const archives = h("div");
  const browser = h("div");
  const jobs = h("div");
  const events = h("div");

  const run = async (action_id: string, body: object = {}) => {
    output.replaceChildren(h("p", { class: "muted" }, "Running…"));
    const outcome = await api<Outcome>(`${base}/actions/${action_id}`, body);
    output.replaceChildren(outcome_panel(outcome, () => output.replaceChildren()));
    await update();
  };

  const update = async () => {
    const since = Math.floor(Date.now() / 1000) - history_span_in_seconds;
    const [repository, repository_jobs, repository_events, repository_history, timers] = await Promise.all([
      api<RepositoryDetail>(base),
      api<Job[]>(`/api/jobs?repository=${encodeURIComponent(id)}&limit=50`),
      api<EventRow[]>(`/api/events?repository=${encodeURIComponent(id)}&limit=50`),
      api<History>(`${base}/history?since=${since}`),
      api<TimerRow[]>("/api/timers"),
    ]);
    history.replaceChildren(...history_charts(repository_history, repository_jobs));
    sources.replaceChildren(sources_list(repository));
    schedules.replaceChildren(timers_table(timers.filter((timer) => timer.host === repository.host), false));
    header.replaceChildren(repository_header(repository));
    actions.replaceChildren(...repository.actions.filter((action) => action.state !== "hidden").map((action) => action_button(action, run)));
    archives.replaceChildren(archives_table(repository, run, (archive) => void open_browser(browser, base, archive, "", run)));
    jobs.replaceChildren(jobs_table(repository_jobs, false));
    events.replaceChildren(events_list(repository_events, false));
  };

  await update();
  main.replaceChildren(
    h("p", {}, h("a", { href: "#/" }, "← All repositories")),
    header, actions, output,
    h("section", {}, h("h2", {}, "History"), history),
    h("section", {}, h("h2", {}, "Archives"), archives),
    browser,
    h("section", {}, h("h2", {}, "Jobs"), jobs),
    h("section", {}, h("h2", {}, "Sources"), sources),
    h("section", {}, h("h2", {}, "Schedules on this host"), schedules),
    h("section", {}, h("h2", {}, "Events"), events),
  );
  keep_refreshing(update);
}

const job_colors: Record<Job["state"], string> = {
  succeeded: "var(--good)",
  failed: "var(--bad)",
  cancelled: "var(--warn)",
  running: "var(--accent)",
};

function history_charts(history: History, jobs: Job[]): HTMLElement[] {
  const polls = history.polls;
  const archives = history.archives.slice(0, 40).reverse();
  const finished = jobs.filter((job) => job.ended_epoch !== null).slice(0, 40).reverse();
  return [
    line_chart("Repository size", [
      { label: "original", color: "var(--chart-1)", points: polls.map((poll) => [poll.epoch, poll.original_size]) },
      { label: "compressed", color: "var(--chart-2)", points: polls.map((poll) => [poll.epoch, poll.compressed_size]) },
      { label: "stored", color: "var(--chart-3)", points: polls.map((poll) => [poll.epoch, poll.deduplicated_size]) },
    ], size),
    line_chart("Archives", [
      { label: "archives", color: "var(--chart-1)", points: polls.map((poll) => [poll.epoch, poll.archive_count]) },
    ], (value) => String(Math.round(value))),
    bar_chart("Data unique to each archive", archives.map((archive) => ({
      label: archive.name, value: archive.deduplicated_size ?? 0, color: "var(--chart-3)",
    })), size),
    bar_chart("Job durations", finished.map((job) => ({
      label: `${job.kind} #${job.id} ${job.state}`, value: job.ended_epoch! - job.started_epoch, color: job_colors[job.state],
    })), duration),
    strip("Checks", polls.slice(-60).map((poll) => ({ label: stamp(poll.epoch), ok: poll.checks_passed }))),
    strip("Restore canary", polls.slice(-60).map((poll) => ({ label: stamp(poll.epoch), ok: poll.canary_ok }))),
  ];
}

function sources_list(repository: RepositoryDetail): HTMLElement {
  const retention = Object.entries(repository.retention).map(([key, value]) => `${key.replace("keep_", "")} ${value}`).join(", ");
  return h("dl", { class: "facts sources" },
    h("dt", {}, "Backs up"), h("dd", {}, repository.source_paths.length > 0 ? repository.source_paths.join(", ") : "set by the host's own backup job"),
    h("dt", {}, "Excludes"), h("dd", {}, repository.exclude.length > 0 ? repository.exclude.join(", ") : "none"),
    h("dt", {}, "Keeps"), h("dd", {}, retention || "no retention set"),
    h("dt", {}, "Changes"), h("dd", { class: "muted" }, "use Diff on an archive to see what changed since the one before"),
  );
}

function repository_header(repository: RepositoryDetail): HTMLElement {
  return h("div", { class: "repository-header" },
    h("h2", {}, repository.name, " ", status_badge(repository.status)),
    h("div", { class: "muted" }, repository.repo ?? "", repository.host ? ` on ${repository.host}` : ""),
    h("dl", { class: "facts" },
      h("dt", {}, "Last backup"), h("dd", { class: overdue(repository) ? "overdue" : "" }, age(repository.last_backup_epoch)),
      h("dt", {}, "Last poll"), h("dd", {}, age(repository.last_poll_epoch)),
      h("dt", {}, "Archives"), h("dd", {}, repository.archive_count ?? "—"),
      h("dt", {}, "Stored"), h("dd", {}, size(repository.stats?.deduplicated_size)),
      h("dt", {}, "Compressed"), h("dd", {}, size(repository.stats?.compressed_size)),
      h("dt", {}, "Original"), h("dd", {}, size(repository.stats?.original_size)),
      h("dt", {}, "Saved"), h("dd", {}, savings(repository)),
    ),
    h("div", { class: "verdicts" },
      verdict(repository.checks_passed, "checks"),
      verdict(repository.canary?.ok, "canary"),
      repository.canary && h("span", { class: "muted" }, ` canary checked ${age(repository.canary.checked_epoch)}`),
    ),
  );
}

// How many times smaller the stored data is than the original, after deduplication and compression.
function savings(repository: RepositoryDetail): string {
  const original = repository.stats?.original_size;
  const stored = repository.stats?.deduplicated_size;
  return original && stored ? `${(original / stored).toFixed(1)}×` : "—";
}

function action_button(action: Action, run: (action_id: string) => Promise<void>): HTMLElement {
  return h("button", {
    class: action.state === "accent" ? "accent" : "",
    disabled: action.state === "disabled",
    onclick: () => {
      if (action.confirm && !confirm(action.confirm)) return;
      void run(action.action_id);
    },
  }, action.name);
}

function outcome_panel(outcome: Outcome, close: () => void): HTMLElement {
  return h("div", { class: outcome.success ? "outcome" : "outcome outcome-failed" },
    h("button", { class: "close", onclick: close, title: "Close" }, "×"),
    h("pre", {}, outcome.content ?? outcome.logs.map(([message]) => message).join("\n")),
  );
}

// ── Archives ─────────────────────────────────────────────────────────────────

function archives_table(repository: RepositoryDetail, run: (action_id: string, body?: object) => Promise<void>, browse: (archive: string) => void): HTMLElement {
  if (repository.archives.length === 0) return h("p", { class: "muted" }, "No archives listed yet.");
  return h("table", {},
    h("thead", {}, h("tr", {}, h("th", {}, "Archive"), h("th", {}, "Created"), h("th", { class: "number" }, "Original"), h("th", { class: "number", title: "Data no other archive shares" }, "Unique"), h("th", { class: "number" }, "Files"), h("th", {}))),
    h("tbody", {}, ...repository.archives.map((archive, index) => h("tr", {},
      h("td", {}, archive.name),
      h("td", { title: stamp(archive.epoch) }, age(archive.epoch)),
      h("td", { class: "number" }, size(archive.original)),
      h("td", { class: "number" }, size(archive.deduplicated)),
      h("td", { class: "number" }, archive.nfiles ?? "—"),
      h("td", { class: "row-actions" },
        h("button", { onclick: () => browse(archive.name) }, "Browse"),
        index + 1 < repository.archives.length && h("button", { onclick: () => void run("diff_archive", { archive: archive.name }) }, "Diff"),
        repository.allow_delete && h("button", { class: "danger", onclick: () => {
          if (confirm(`Delete ${archive.name}? It is gone for good.`)) void run("delete_archive", { archive: archive.name });
        } }, "Delete"),
      ),
    ))),
  );
}

// Shows one folder of an archive, with checkboxes to restore what is picked.
async function open_browser(panel: HTMLElement, base: string, archive: string, path: string, run: (action_id: string, body?: object) => Promise<void>): Promise<void> {
  panel.replaceChildren(h("section", {}, h("h2", {}, `Browse ${archive}`), h("p", { class: "muted" }, "Listing…")));
  const listing = await api<Listing>(`${base}/browse?archive=${encodeURIComponent(archive)}&path=${encodeURIComponent(path)}`);
  const open = (next: string) => void open_browser(panel, base, archive, next, run);
  const picked = new Set<string>();

  const parts = path.split("/").filter(Boolean);
  const crumbs = h("div", { class: "crumbs" },
    h("button", { class: "link", onclick: () => open("") }, archive),
    ...parts.map((part, index) => [" / ", h("button", { class: "link", onclick: () => open(parts.slice(0, index + 1).join("/")) }, part)]).flat(),
  );
  const restore = h("button", { disabled: true, onclick: () => {
    if (confirm(`Restore ${picked.size} item(s) from ${archive} into a new folder on the host?`)) void run("restore_archive", { archive, paths: [...picked] });
  } }, "Restore picked");

  const rows = listing.rows.map((row) => h("tr", {},
    h("td", {}, h("input", { type: "checkbox", onchange: (event: Event) => {
      if ((event.target as HTMLInputElement).checked) picked.add(row.path);
      else picked.delete(row.path);
      restore.disabled = picked.size === 0;
    } })),
    h("td", {}, row.dir ? h("button", { class: "link", onclick: () => open(row.path) }, `${row.name}/`) : row.name),
    h("td", { class: "number" }, row.size),
    h("td", {}, row.mtime),
  ));

  panel.replaceChildren(h("section", {},
    h("h2", {}, `Browse ${archive}`, " ", h("button", { class: "close", onclick: () => panel.replaceChildren(), title: "Close" }, "×")),
    crumbs,
    listing.success ? null : h("pre", { class: "error" }, listing.content ?? ""),
    h("table", {}, h("tbody", {}, ...rows)),
    listing.more ? h("p", { class: "muted" }, "Only the first entries are shown; raise browse_limit for more.") : null,
    restore,
  ));
}

// ── Jobs and events ──────────────────────────────────────────────────────────

function jobs_table(jobs: Job[], with_repository: boolean): HTMLElement {
  if (jobs.length === 0) return h("p", { class: "muted" }, "No jobs yet.");
  const follow = h("div");
  const table = h("table", {},
    h("thead", {}, h("tr", {}, with_repository && h("th", {}, "Repository"), h("th", {}, "Job"), h("th", {}, "State"), h("th", {}, "Started"), h("th", { class: "number" }, "Took"), h("th", {}))),
    h("tbody", {}, ...jobs.map((job) => h("tr", {},
      with_repository && h("td", {}, job.repository_id),
      h("td", {}, job.kind),
      h("td", {}, h("span", { class: `badge job-${job.state}` }, job.state), job.progress ? h("span", { class: "muted" }, ` ${job.progress}`) : null),
      h("td", { title: stamp(job.started_epoch) }, age(job.started_epoch)),
      h("td", { class: "number" }, duration((job.ended_epoch ?? Date.now() / 1000) - job.started_epoch)),
      h("td", {}, h("button", { onclick: () => void follow_job(follow, job.id) }, "Output")),
    ))),
  );
  return h("div", {}, table, follow);
}

// Shows a job's output, fetching only new lines every two seconds while it runs.
async function follow_job(panel: HTMLElement, job_id: number): Promise<void> {
  const text = h("pre", { class: "job-output" });
  const title = h("strong");
  const cancel = h("button", { class: "danger", onclick: async () => {
    if (!confirm("Cancel this job?")) return;
    const outcome = await api<Outcome>(`/api/jobs/${job_id}/cancel`, {});
    text.textContent += `\n${outcome.content ?? ""}`;
  } }, "Cancel");
  const close = h("button", { class: "close", title: "Close", onclick: () => panel.replaceChildren() }, "×");
  panel.replaceChildren(h("div", { class: "outcome" }, close, title, " ", cancel, text));

  let lines = 0;
  while (panel.contains(text)) {
    const job = await api<Job>(`/api/jobs/${job_id}?skip=${lines}`);
    const output = (job.output ?? []).map(readable_line).filter((line) => line !== null);
    lines += job.output?.length ?? 0;
    if (output.length > 0) {
      text.textContent += (text.textContent ? "\n" : "") + output.join("\n");
      text.scrollTop = text.scrollHeight;
    }
    title.textContent = `${job.kind} #${job.id}: ${job.state}${job.error ? ` (${job.error})` : ""}`;
    cancel.hidden = job.state !== "running";
    if (job.state !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, job_follow_interval_in_milliseconds));
  }
}

// Shows a borg JSON log line as its message, leaves other lines as they are, and drops progress lines.
function readable_line(line: string): string | null {
  if (!line.startsWith("{")) return line;
  try {
    const entry = JSON.parse(line);
    if (entry.type === "log_message") return entry.message;
    if (entry.type === "file_status") return `${entry.status} ${entry.path}`;
    return null;
  } catch {
    return line;
  }
}

function events_list(events: EventRow[], with_repository: boolean): HTMLElement {
  if (events.length === 0) return h("p", { class: "muted" }, "Nothing yet.");
  return h("ul", { class: "events" }, ...events.map((event) => h("li", { class: `level-${event.level.toLowerCase()}` },
    h("span", { class: "muted", title: stamp(event.epoch) }, age(event.epoch)),
    with_repository && h("a", { href: `#/repositories/${encodeURIComponent(event.repository_id)}` }, event.repository_id),
    h("span", {}, event.message),
  )));
}

void show();
