// Every job with its status rolled up from its targets, and one job's page: its sources and repositories, a target per
// host and repository with its freshness, its tasks and its runs.

import { overdue } from "../attention.ts";
import { api, query, type JobRow, type RepositorySummary, type Run, type SourceRow } from "../api.ts";
import { age, duration, h, size, stamp, until, type Child } from "../dom.ts";
import { link } from "../router.ts";
import { can } from "../session.ts";
import { attempt, crumbs, data_table, empty, facts, health_badge, load, section, skeleton, status_badge } from "../ui.ts";
import { runs_table, touches, type View } from "./shared.ts";
import { config_link, origin_chip } from "./sources.ts";
import { tasks_table } from "./tasks.ts";

const level_rank = { critical: 0, warning: 1, ok: 2 } as const;

// ── Jobs ─────────────────────────────────────────────────────────────────────

export function jobs_view(): View {
  const body = h("div", {}, skeleton(5));
  const update = async (quiet: boolean) => {
    const jobs = await attempt(body, quiet, () => api<JobRow[]>("/api/jobs"), () => void update(false));
    if (jobs === null) return;
    body.replaceChildren(jobs.length === 0
      ? empty("No jobs yet.", can("admin") ? h("a", { href: link(["settings", "new", "jobs"]) }, "Add a job in Settings") : "A job backs sources up to repositories; jobs are declared under services.x-backups.jobs.")
      : data_table<JobRow>([
        { label: "Job", cell: (job) => h("a", { href: link(["jobs", job.name]) }, job.name), sort: (job) => job.name },
        { label: "Status", cell: (job) => health_badge(job.level), sort: (job) => job.level === null ? 3 : level_rank[job.level] },
        { label: "Sources", cell: (job) => job.sources.length === 0 ? h("span", { class: "muted" }, "none") : job.sources.join(", ") },
        { label: "Repositories", cell: (job) => job.repositories.join(", ") },
        { label: "Targets", class: "number", cell: (job) => job.targets.length, sort: (job) => job.targets.length },
        { label: "Last backup", cell: (job) => newest_backup(job.targets), sort: (job) => newest_epoch(job.targets) },
        { label: "Next backup", cell: (job) => next_backup(job), sort: (job) => job.tasks.find((task) => task.kind === "backup")?.next_due ?? null },
        { label: "From", cell: (job) => origin_chip(job) },
      ], jobs, { caption: "Jobs" }));
  };
  void update(false);
  return {
    title: "Jobs",
    root: h("div", { class: "page" },
      h("div", { class: "page-title spread" }, h("h1", {}, "Jobs"), can("admin") && h("a", { class: "button", href: link(["settings", "new", "jobs"]) }, "Add job")),
      body),
    update: async (changes) => {
      if (touches(changes, null, ["repository", "run", "tasks", "config"])) await update(true);
    },
  };
}

function newest_epoch(targets: RepositorySummary[]): number | null {
  const epochs = targets.map((target) => target.last_backup_epoch).filter((epoch): epoch is number => epoch !== null);
  return epochs.length === 0 ? null : Math.max(...epochs);
}

function newest_backup(targets: RepositorySummary[]): Child {
  const epoch = newest_epoch(targets);
  return epoch === null ? h("span", { class: "muted" }, "never") : h("span", { title: stamp(epoch) }, age(epoch));
}

function next_backup(job: JobRow): Child {
  const task = job.tasks.find((item) => item.kind === "backup");
  if (task === undefined) return h("span", { class: "muted" }, "—");
  if (task.running) return h("span", { class: "badge tone-info" }, "running");
  if (task.waiting) return h("span", { class: "badge tone-warn", title: task.waiting }, "waiting");
  if (!task.enabled || task.next_due === null) return h("span", { class: "muted" }, task.enabled ? "by hand" : "switched off");
  return h("span", { title: stamp(task.next_due) }, until(task.next_due));
}

// ── One job ──────────────────────────────────────────────────────────────────

export function job_view(name: string): View {
  const header = h("div", {}, skeleton(2));
  const flow = h("div", {}, skeleton(2));
  const targets = h("div", {}, skeleton(3));
  const tasks = h("div", {}, skeleton(3));
  const settings = h("div");
  const runs = h("div", {}, skeleton(3));

  const update = async (quiet: boolean) => {
    const answer = await attempt(header, quiet, () => Promise.all([
      api<JobRow>(`/api/jobs/${encodeURIComponent(name)}`),
      api<SourceRow[]>("/api/sources"),
    ]), () => void update(false));
    if (answer === null) return;
    const [job, sources] = answer;
    header.replaceChildren(job_header(job));
    flow.replaceChildren(job_flow(job, sources));
    targets.replaceChildren(targets_table(job.targets));
    tasks.replaceChildren(tasks_table(job.tasks, { refresh: () => void update(true), empty_hint: "A job with sources has a backup task; prune needs a keep_* policy and the canary a canary_path." }));
    settings.replaceChildren(settings_facts(job));
    await load(runs, async () => runs_table(await api<Run[]>(`/api/runs${query({ job: name, limit: 20 })}`), { with_repository: true, refresh: () => void update(true) }), { quiet });
  };
  void update(false);

  return {
    title: name,
    root: h("div", { class: "page" },
      crumbs([["Jobs", link(["jobs"])], [name, null]]),
      header,
      section("Sources to repositories", flow),
      section("Targets", targets, h("span", { class: "muted small" }, "one per source host and repository")),
      section("Tasks", tasks, h("a", { href: link(["schedules"]) }, "All schedules")),
      section("Settings", settings),
      section("Runs", runs, h("a", { href: link(["runs"], { job: name }) }, "All runs of this job")),
    ),
    update: async (changes) => {
      if (touches(changes, null, ["repository", "run", "tasks", "config"])) await update(true);
    },
  };
}

function job_header(job: JobRow): HTMLElement {
  return h("header", { class: "page-head" },
    h("div", { class: "page-title" }, h("h1", {}, job.name), health_badge(job.level), origin_chip(job)),
    h("p", { class: "muted", role: "status", "aria-live": "polite" },
      `${job.targets.length} ${job.targets.length === 1 ? "target" : "targets"}`,
      job.targets.some((target) => target.running_run) ? " · a run is going" : ""),
    can("admin") && h("div", { class: "head-actions" }, h("a", { class: "button", href: config_link(job, "jobs") }, "Config")),
  );
}

// The job's sources, grouped by host, beside the repositories they go to.
function job_flow(job: JobRow, sources: SourceRow[]): HTMLElement {
  const source_items = job.sources.map((name) => {
    const source = sources.find((item) => item.name === name);
    return h("li", {}, h("a", { href: link(["sources", name]) }, name),
      source && h("span", { class: "muted" }, " on ", h("a", { href: link(["hosts", source.host]) }, source.host), ` · ${source.paths.join(", ")}`));
  });
  const repository_items = job.repositories.map((name) => {
    const target = job.targets.find((item) => item.repository === name);
    return h("li", {}, target ? h("a", { href: link(["repositories", target.id]) }, name) : name);
  });
  return h("div", { class: "columns" },
    h("div", {}, h("h3", {}, "Backs up"), source_items.length > 0 ? h("ul", { class: "plain-list" }, ...source_items) : h("p", { class: "muted" }, "No sources: it only prunes or checks.")),
    h("div", {}, h("h3", {}, h("span", { "aria-hidden": "true" }, "→ "), "Into"), h("ul", { class: "plain-list" }, ...repository_items)),
  );
}

function targets_table(targets: RepositorySummary[]): HTMLElement {
  if (targets.length === 0) return empty("No targets.", "A target appears for each host the job's sources are on and each repository it writes to.");
  return data_table<RepositorySummary>([
    { label: "Host", cell: (target) => h("a", { href: link(["hosts", target.host]) }, target.host), sort: (target) => target.host },
    { label: "Repository", cell: (target) => h("a", { href: link(["repositories", target.id]) }, target.repository), sort: (target) => target.repository },
    { label: "Status", cell: (target) => target_status(target), sort: (target) => level_rank[target.level] },
    { label: "Newest archive", cell: (target) => freshness(target), sort: (target) => target.last_backup_epoch },
    { label: "Archives", class: "number", cell: (target) => target.archive_count ?? "—", sort: (target) => target.archive_count },
    { label: "Stored", class: "number", cell: (target) => size(target.stats?.deduplicated_size), sort: (target) => target.stats?.deduplicated_size ?? null },
    { label: "Last backup", cell: (target) => target.running_run ? h("a", { class: "chip chip-info", href: link(["runs", String(target.running_run.id)]) }, `${target.running_run.kind} running`) : h("span", { class: "muted" }, target.last_backup_epoch ? stamp(target.last_backup_epoch) : "never") },
  ], targets, { caption: "Targets" });
}

// The target's health, with the first reason it is not OK beneath and every reason on hover; one not polled yet says so.
function target_status(target: RepositorySummary): Child {
  if (target.last_poll_epoch === null) return status_badge(null);
  const badge = health_badge(target.level);
  badge.title = target.reasons.map((reason) => reason.text).join("\n");
  return [badge, ...target.reasons.slice(0, 1).map((reason) => h("div", { class: "muted small" }, reason.text))];
}

// How old the newest archive is against its max age, in red once past it.
function freshness(target: RepositorySummary): HTMLElement {
  const late = target.last_poll_epoch !== null && overdue(target);
  return h("span", { class: late ? "tone-bad" : null, title: target.last_backup_epoch ? stamp(target.last_backup_epoch) : null },
    target.last_backup_epoch ? age(target.last_backup_epoch) : "none yet", ` · limit ${duration(target.max_age)}`, late ? " · overdue" : "");
}

function settings_facts(job: JobRow): HTMLElement {
  const entries = Object.entries(job.settings);
  if (entries.length === 0) return h("p", { class: "muted" }, "Nothing set; each repository's own settings and the defaults apply.");
  return facts(entries.map(([field, value]): [string, Child] => [field, h("code", {}, typeof value === "string" ? value : JSON.stringify(value))]), "rows");
}
