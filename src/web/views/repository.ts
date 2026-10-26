// One repository: its header and actions, then tabs for its overview, archives, jobs, sources, schedule, events and config.

import { action_descriptions, run_action, start_action, type ActionTarget } from "../actions.ts";
import { overdue, repository_reasons } from "../attention.ts";
import {
  api, query, repository_path, type Action, type Archive, type EventRow, type History, type Job, type RepositoryConfig, type RepositoryDetail,
  type TimerRow,
} from "../api.ts";
import { bar_chart, line_chart, strip } from "../charts.ts";
import { age, duration, h, nodes, now_seconds, size, stamp, type Child } from "../dom.ts";
import { current_route, link, replace_query } from "../router.ts";
import {
  attempt, chip, confirm_dialog, crumbs, data_table, empty, facts, load, pager, search_box, section, select, skeleton, sorting_from,
  status_badge, tabs, text_dialog, toast, toolbar, verdict, type Sorting,
} from "../ui.ts";
import { events_list, jobs_table, timers_table, touches, type View } from "./shared.ts";

const history_span_in_seconds = 90 * 86400;
const page_size = 50;

// Actions that start a backup sit in the header; the rest are maintenance, each in a card that says what it does.
const header_actions = new Set(["run_backup", "dry_run_backup"]);

const tab_list: [id: string, label: string][] = [
  ["overview", "Overview"],
  ["archives", "Archives"],
  ["jobs", "Jobs"],
  ["sources", "Sources"],
  ["schedule", "Schedule"],
  ["events", "Events"],
  ["config", "Config"],
];

export const job_kinds: [value: string, text: string][] = [
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

export const job_states: [value: string, text: string][] = [
  ["", "Any outcome"],
  ["running", "Running"],
  ["succeeded", "Succeeded"],
  ["failed", "Failed"],
  ["cancelled", "Cancelled"],
];

export function repository_view(id: string, tab: string): View {
  const base = repository_path(id);
  const active = tab_list.some(([tab_id]) => tab_id === tab) ? tab : "overview";
  const header = h("div", {}, skeleton(2));
  const body = h("div", { class: "stack" }, skeleton(6));
  let detail: RepositoryDetail | null = null;
  let refresh_tab: (quiet: boolean) => Promise<void> = async () => {};

  const target = (): ActionTarget => ({ repository_id: id, repository_name: detail?.name ?? id, done: () => void update(true) });

  const update = async (quiet: boolean): Promise<void> => {
    const answer = await attempt(header, quiet, () => api<RepositoryDetail>(base), () => void update(false));
    if (answer === null) return;
    detail = answer;
    header.replaceChildren(repository_header(answer, target()));
    await refresh_tab(quiet);
  };

  const tab_context: TabContext = { id, base, body, detail: () => detail!, target, refresh: () => void update(true) };
  const builders: Record<string, (context: TabContext) => (quiet: boolean) => Promise<void>> = {
    overview: overview_tab, archives: archives_tab, jobs: jobs_tab, sources: sources_tab, schedule: schedule_tab, events: events_tab, config: config_tab,
  };

  void (async () => {
    await update(false);
    if (detail === null) return;
    refresh_tab = builders[active](tab_context);
    await refresh_tab(false);
  })();

  return {
    title: id,
    root: h("div", { class: "page" },
      crumbs([["Repositories", link(["repositories"])], [id, null]]),
      header,
      tabs(tab_list.map(([tab_id, label]) => ({ id: tab_id, label, href: link(["repositories", id, ...(tab_id === "overview" ? [] : [tab_id])]) })), active),
      body,
    ),
    update: async (changes) => {
      if (touches(changes, id, ["repository", "job", "timers"])) await update(true);
    },
  };
}

interface TabContext {
  id: string;
  base: string;
  body: HTMLElement;
  detail: () => RepositoryDetail;
  target: () => ActionTarget;
  refresh: () => void;
}

// ── Header ───────────────────────────────────────────────────────────────────

function repository_header(repository: RepositoryDetail, target: ActionTarget): HTMLElement {
  const buttons = repository.actions.filter((action) => header_actions.has(action.action_id) && action.state !== "hidden");
  const reasons = repository_reasons(repository);
  return h("header", { class: "page-head" },
    h("div", { class: "page-title" },
      h("h1", {}, repository.name),
      status_badge(repository.status),
      repository.source === "declared" && chip("declared", "Set in the Nix configuration; edit it there"),
      repository.running_job && h("a", { class: "chip chip-info", href: link(["jobs", String(repository.running_job.id)]) },
        `${repository.running_job.kind} running${repository.running_job.progress ? ` · ${repository.running_job.progress}` : ""}`),
    ),
    h("p", { class: "muted" }, repository.repo ?? "", ` on ${repository.host}`, ` · polled ${age(repository.last_poll_epoch)}`),
    h("div", { class: "head-actions" },
      ...buttons.map((action, index) => action_button(action, target, index === 0 ? "accent solid" : "")),
      h("button", { onclick: () => void poll_now(target) }, "Poll now"),
    ),
    reasons.length > 0 && h("ul", { class: "attention compact" }, ...reasons.map((reason) => h("li", { class: `tone-edge-${reason.tone}` },
      h("span", { class: `badge tone-${reason.tone}` }, reason.tone === "bad" ? "problem" : "warning"), h("span", {}, reason.text)))),
  );
}

function action_button(action: Action, target: ActionTarget, class_name = ""): HTMLElement {
  const busy = action.state === "accent";
  return h("button", {
    class: class_name || null,
    disabled: action.state === "disabled" || busy,
    title: action_descriptions[action.action_id] ?? null,
    onclick: () => start_action(target, action),
  }, busy ? `${action.name} (running)` : action.name);
}

async function poll_now(target: ActionTarget): Promise<void> {
  toast("Polling…");
  try {
    await api(`${repository_path(target.repository_id)}/poll`, {});
    toast("Poll finished.", { tone: "good" });
  } catch (error) {
    toast(`Poll failed: ${error instanceof Error ? error.message : String(error)}`, { tone: "bad" });
  }
  target.done?.();
}

// ── Overview tab ─────────────────────────────────────────────────────────────

function overview_tab(context: TabContext): (quiet: boolean) => Promise<void> {
  const summary = h("div");
  const charts = h("div", { class: "charts" }, skeleton(4));
  const maintenance = h("div", { class: "maintenance" });
  context.body.replaceChildren(
    section("Summary", summary),
    section("History", charts, h("span", { class: "muted small" }, "last 90 days")),
    section("Maintenance", maintenance),
  );
  return async (quiet) => {
    const repository = context.detail();
    summary.replaceChildren(repository_facts(repository));
    maintenance.replaceChildren(...maintenance_cards(repository, context.target()));
    const since = Math.floor(now_seconds() - history_span_in_seconds);
    await load(charts, async () => {
      const [history, jobs] = await Promise.all([
        api<History>(`${context.base}/history${query({ since })}`),
        api<Job[]>(`/api/jobs${query({ repository: context.id, limit: 60 })}`),
      ]);
      return history_charts(history, jobs);
    }, { quiet });
  };
}

function repository_facts(repository: RepositoryDetail): HTMLElement {
  const original = repository.stats?.original_size;
  const stored = repository.stats?.deduplicated_size;
  const late = repository.last_poll_epoch !== null && overdue(repository);
  return h("div", {},
    facts([
      ["Last backup", h("span", { title: repository.last_backup_epoch ? stamp(repository.last_backup_epoch) : null }, age(repository.last_backup_epoch), late ? " · overdue" : ""), late ? "tone-bad" : undefined],
      ["Archives", repository.archive_count ?? "—"],
      ["Original", size(original)],
      ["Compressed", size(repository.stats?.compressed_size)],
      ["Stored", size(stored)],
      ["Saved", original && stored ? `${(original / stored).toFixed(1)}× smaller` : "—"],
    ]),
    h("div", { class: "verdicts" },
      verdict(repository.checks_passed, "checks"),
      verdict(repository.canary?.ok, "restore canary"),
      repository.canary && h("span", { class: "muted small" }, `canary checked ${age(repository.canary.checked_epoch)}`),
    ),
  );
}

function maintenance_cards(repository: RepositoryDetail, target: ActionTarget): HTMLElement[] {
  const actions = repository.actions.filter((action) => !header_actions.has(action.action_id) && action.state !== "hidden");
  if (actions.length === 0) return [empty("No maintenance actions for this repository.", "Prune, delete and purge appear once allow_delete or allow_purge is set in its config.")];
  return actions.map((action) => h("div", { class: `maintenance-card${action.confirm ? " risky" : ""}` },
    h("div", {}, h("strong", {}, action.name), h("p", { class: "muted small" }, action_descriptions[action.action_id] ?? "")),
    action_button(action, target, action.confirm ? "danger" : ""),
  ));
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
    bar_chart("New data in each archive", archives.map((archive) => ({
      label: archive.name, value: archive.deduplicated_size ?? 0, color: "var(--chart-3)",
    })), size),
    bar_chart("Job durations", finished.map((job) => ({
      label: `${job.kind} #${job.id} ${job.state}`, value: job.ended_epoch! - job.started_epoch, color: job_colors[job.state],
    })), duration),
    strip("Checks", polls.slice(-60).map((poll) => ({ label: stamp(poll.epoch), ok: poll.checks_passed }))),
    strip("Restore canary", polls.slice(-60).map((poll) => ({ label: stamp(poll.epoch), ok: poll.canary_ok }))),
  ];
}

// ── Archives tab ─────────────────────────────────────────────────────────────

function archives_tab(context: TabContext): (quiet: boolean) => Promise<void> {
  const route_query = current_route().query;
  let text = route_query.get("q") ?? "";
  let page = Number(route_query.get("page") ?? 1);
  let sorting = sorting_from(route_query, { key: "Created", descending: true });
  const list = h("div");

  const render = () => {
    const repository = context.detail();
    const needle = text.trim().toLowerCase();
    const shown = repository.archives.filter((archive) => !needle || archive.name.toLowerCase().includes(needle));
    if (repository.archives.length === 0) {
      list.replaceChildren(empty("No archives listed yet.", "Archives appear after the first poll that finds one."));
      return;
    }
    // Sorting happens before paging, so a page always holds the next rows in the chosen order.
    const sorted = sort_archives(shown, sorting);
    const pages = Math.max(1, Math.ceil(sorted.length / page_size));
    page = Math.min(page, pages);
    const on_sort = (next: Sorting) => {
      sorting = next;
      replace_query({ sort: next.key, dir: next.descending ? "desc" : null });
      render();
    };
    list.replaceChildren(...nodes([
      h("p", { class: "muted small", role: "status" }, `${shown.length} of ${repository.archives.length} archives`),
      archives_table(repository, sorted.slice((page - 1) * page_size, page * page_size), sorting, on_sort, context.target()),
      pager(page, page < pages, (next) => { page = next; replace_query({ page: next === 1 ? null : next }); render(); }),
    ]));
  };

  context.body.replaceChildren(section("Archives",
    h("div", {}, toolbar(search_box("Search archives by name", text, (value) => { text = value; page = 1; replace_query({ q: value, page: null }); render(); })), list)));
  return async () => render();
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

function archives_table(repository: RepositoryDetail, archives: Archive[], sorting: Sorting, on_sort: (sorting: Sorting) => void, target: ActionTarget): HTMLElement {
  const oldest = repository.archives.at(-1)?.name;
  const archive_link = (archive: Archive, tab: string) => link(["repositories", repository.id, "archives", archive.name], { tab });
  // Sorting is done by the caller across every page, so the table only marks the column.
  return data_table<Archive>([
    { label: "Archive", cell: (archive) => h("a", { href: archive_link(archive, "changes") }, archive.name), sort: () => 0 },
    { label: "Created", cell: (archive) => h("span", { title: stamp(archive.epoch) }, age(archive.epoch)), sort: () => 0 },
    { label: "Original", class: "number", cell: (archive) => size(archive.original), sort: () => 0 },
    { label: "New data", class: "number", cell: (archive) => size(archive.deduplicated), sort: () => 0 },
    { label: "Files", class: "number", cell: (archive) => archive.nfiles?.toLocaleString() ?? "—", sort: () => 0 },
    {
      label: "", class: "actions-cell", cell: (archive) => h("span", { class: "row-actions" },
        archive.name !== oldest && h("a", { class: "button", href: archive_link(archive, "changes") }, "Changes"),
        h("a", { class: "button", href: archive_link(archive, "files") }, "Files"),
        repository.allow_delete && h("button", { class: "danger", onclick: () => delete_archive(target, archive.name) }, "Delete"),
      ),
    },
  ], archives, { sorting, on_sort, caption: "Archives" });
}

export function delete_archive(target: ActionTarget, archive: string, after?: () => void): void {
  confirm_dialog({
    title: `Delete ${archive}?`,
    message: h("div", {},
      h("p", {}, `This deletes the archive ${archive} from ${target.repository_name}. It cannot be undone.`),
      h("p", { class: "muted" }, "Data other archives share stays; run Compact afterwards to free what only this archive held.")),
    confirm_label: "Delete archive",
    busy_label: "Deleting…",
    danger: true,
    run: async () => {
      await run_action(target, "delete_archive", "Delete", { archive });
      after?.();
    },
  });
}

// ── Jobs tab ─────────────────────────────────────────────────────────────────

function jobs_tab(context: TabContext): (quiet: boolean) => Promise<void> {
  const route_query = current_route().query;
  let kind = route_query.get("kind") ?? "";
  let state = route_query.get("state") ?? "";
  let page = Number(route_query.get("page") ?? 1);
  const list = h("div", {}, skeleton(5));

  const refresh = async (quiet: boolean) => {
    await load(list, async () => {
      const jobs = await api<Job[]>(`/api/jobs${query({ repository: context.id, kind, state, limit: page_size + 1, offset: (page - 1) * page_size })}`);
      return [
        jobs_table(jobs.slice(0, page_size), { with_repository: false, refresh: context.refresh }),
        pager(page, jobs.length > page_size, (next) => { page = next; replace_query({ page: next === 1 ? null : next }); void refresh(false); }),
      ];
    }, { quiet });
  };
  const refilter = () => { page = 1; replace_query({ kind, state, page: null }); void refresh(false); };

  context.body.replaceChildren(section("Jobs", h("div", {},
    toolbar(
      select("Kind", job_kinds, kind, (value) => { kind = value; refilter(); }),
      select("Outcome", job_states, state, (value) => { state = value; refilter(); }),
      h("a", { href: link(["jobs"], { repository: context.id }) }, "Open in all jobs"),
    ),
    list)));
  return refresh;
}

// ── Sources tab ──────────────────────────────────────────────────────────────

function sources_tab(context: TabContext): (quiet: boolean) => Promise<void> {
  return async () => {
    const repository = context.detail();
    const paths = (items: string[], none: string) => items.length > 0 ? h("ul", { class: "paths" }, ...items.map((item) => h("li", {}, h("code", {}, item)))) : h("p", { class: "muted" }, none);
    const retention = Object.entries(repository.retention);
    context.body.replaceChildren(
      section("Backed up", paths(repository.source_paths, "Set by the host's own backup job, so X-Backups does not know the paths.")),
      section("Excluded", paths(repository.exclude, "Nothing is excluded.")),
      section("Kept", retention.length > 0
        ? facts(retention.map(([key, value]): [string, Child] => [key.replace("keep_", "").replace("_", " "), String(value)]), "rows")
        : h("p", { class: "muted" }, "No retention is set, so nothing is pruned.")),
      section("Changes between archives", h("p", { class: "muted" }, "Open an archive's Changes tab to see what changed since the one before it.",
        " ", h("a", { href: link(["repositories", repository.id, "archives"]) }, "Archives"))),
    );
  };
}

// ── Schedule tab ─────────────────────────────────────────────────────────────

function schedule_tab(context: TabContext): (quiet: boolean) => Promise<void> {
  const list = h("div", {}, skeleton(3));
  context.body.replaceChildren(section(`Backup timers on ${context.detail().host}`, list, h("a", { href: link(["schedules"]) }, "All hosts")));
  return async (quiet) => {
    await load(list, async () => {
      const timers = await api<TimerRow[]>("/api/timers");
      return timers_table(timers.filter((timer) => timer.host === context.detail().host), false);
    }, { quiet });
  };
}

// ── Events tab ───────────────────────────────────────────────────────────────

export const event_levels: [value: string, text: string][] = [["", "Any level"], ["ERROR", "Errors"], ["WARNING", "Warnings"], ["INFO", "Info"]];

function events_tab(context: TabContext): (quiet: boolean) => Promise<void> {
  const route_query = current_route().query;
  let level = route_query.get("level") ?? "";
  let page = Number(route_query.get("page") ?? 1);
  const list = h("div", {}, skeleton(5));
  const refresh = async (quiet: boolean) => {
    await load(list, async () => {
      const events = await api<EventRow[]>(`/api/events${query({ repository: context.id, level, limit: page_size + 1, offset: (page - 1) * page_size })}`);
      return [
        events_list(events.slice(0, page_size), false),
        pager(page, events.length > page_size, (next) => { page = next; replace_query({ page: next === 1 ? null : next }); void refresh(false); }),
      ];
    }, { quiet });
  };
  context.body.replaceChildren(section("Events", h("div", {},
    toolbar(select("Level", event_levels, level, (value) => { level = value; page = 1; replace_query({ level: value, page: null }); void refresh(false); })),
    list)));
  return refresh;
}

// ── Config tab ───────────────────────────────────────────────────────────────

// The config's fields in groups, in the order a reader looks for them; anything unlisted lands in Other.
const field_groups: [title: string, fields: string[]][] = [
  ["Connection", ["name", "id", "host", "ssh_user", "repo", "rsh", "ssh_key", "borg_bin", "require_sudo", "passphrase", "passphrase_file", "passphrase_command", "lock_wait", "timeout", "interval", "skip_when_unreachable"]],
  ["Sources", ["source_paths", "exclude", "exclude_from", "exclude_caches", "exclude_if_present", "one_file_system", "compression", "archive_prefix"]],
  ["Retention", ["keep_within", "keep_last", "keep_secondly", "keep_minutely", "keep_hourly", "keep_daily", "keep_weekly", "keep_monthly", "keep_yearly", "prune_match", "prune_after_backup", "compact_after_backup"]],
  ["Checks", ["max_age", "check_units", "check_max_age", "check_kinds", "check_verify_data", "canary_path", "canary_interval"]],
  ["Jobs", ["job_nice", "job_io_idle", "inhibit_sleep", "job_lock", "skip_while_active", "backup_lock_wait", "cache_dir", "restore_dir", "browse_limit", "list_archives", "collect_stats"]],
  ["Safety", ["allow_delete", "allow_purge", "purge_match"]],
];

function config_tab(context: TabContext): (quiet: boolean) => Promise<void> {
  const holder = h("div", { class: "stack" }, skeleton(6));
  context.body.replaceChildren(holder);
  return async (quiet) => {
    await load(holder, async () => config_view(await api<RepositoryConfig>(`${context.base}/config`)), { quiet });
  };
}

function config_view(config: RepositoryConfig): HTMLElement[] {
  const fields = config.fields;
  const listed = new Set(field_groups.flatMap(([, names]) => names));
  const other = Object.keys(fields).filter((name) => !listed.has(name));
  const groups = [...field_groups, ["Other", other] as [string, string[]]]
    .map(([title, names]) => [title, names.filter((name) => fields[name] !== undefined && fields[name] !== null)] as [string, string[]])
    .filter(([, names]) => names.length > 0);
  return [
    h("div", { class: "banner", role: "note" },
      h("strong", {}, config.source === "declared" ? "Declared in the Nix configuration." : "Managed from this page."),
      " ",
      config.editable ? "" : "This page shows it read-only; change it under services.x-backups.repositories and switch the system to apply it.",
    ),
    toolbar(
      h("button", { onclick: () => text_dialog("Config as JSON", JSON.stringify(fields, null, 2)) }, "Show as JSON"),
      h("button", { onclick: () => text_dialog("Config as Nix", as_nix(fields)) }, "Show as Nix"),
    ),
    ...groups.map(([title, names]) => section(title, facts(names.map((name): [string, Child] => [name, config_value(fields[name])]), "rows"))),
  ];
}

function config_value(value: unknown): Child {
  if (Array.isArray(value)) return value.length === 0 ? "none" : h("ul", { class: "paths" }, ...value.map((item) => h("li", {}, h("code", {}, String(item)))));
  if (typeof value === "object" && value !== null) return h("code", {}, JSON.stringify(value));
  if (typeof value === "boolean") return value ? "yes" : "no";
  return h("code", {}, String(value));
}

// The repository as a Nix attribute set for services.x-backups.repositories, with secrets left as a comment.
function as_nix(fields: Record<string, unknown>): string {
  const { name, ...rest } = fields;
  const value = (item: unknown, indent: string): string => {
    if (typeof item === "string") return JSON.stringify(item);
    if (typeof item === "number" || typeof item === "boolean") return String(item);
    if (Array.isArray(item)) return `[ ${item.map((entry) => value(entry, indent)).join(" ")} ]`;
    if (typeof item === "object" && item !== null) {
      const inner = Object.entries(item).map(([key, entry]) => `${indent}  ${nix_key(key)} = ${value(entry, `${indent}  `)};`);
      return `{\n${inner.join("\n")}\n${indent}}`;
    }
    return "null";
  };
  const lines = Object.entries(rest)
    .filter(([, item]) => item !== null && item !== undefined)
    .map(([key, item]) => item === "(set)" ? `  # ${key} is set; keep it in a secret file, never in the Nix store.` : `  ${nix_key(key)} = ${value(item, "  ")};`);
  return `services.x-backups.repositories.${nix_key(String(name))} = {\n${lines.join("\n")}\n};\n`;
}

function nix_key(key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_'-]*$/.test(key) ? key : JSON.stringify(key);
}
