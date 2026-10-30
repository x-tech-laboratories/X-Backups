// The smaller pages: the week of tasks and host timers, the event log, and the settings.

import { timer_problem } from "../attention.ts";
import { api, ApiError, query, send, type ConfigInfo, type EventRow, type RepositorySummary, type Setting, type TaskView, type TimerRow, type TimerRun } from "../api.ts";
import { h, stamp, type Child } from "../dom.ts";
import { current_route, link, replace_query } from "../router.ts";
import { theme_choice, type Theme } from "../theme.ts";
import { empty, facts, load, pager, section, select, skeleton, toast, toolbar } from "../ui.ts";
import { entity_panels } from "./entity_config.ts";
import { event_levels } from "./repository.ts";
import { events_list, timers_table, touches, type View } from "./shared.ts";
import { task_label, tasks_table } from "./tasks.ts";

const page_size = 50;

// ── Schedules ────────────────────────────────────────────────────────────────

export function schedules_view(): View {
  const route_query = current_route().query;
  let host = route_query.get("host") ?? "";
  let state = route_query.get("state") ?? "";
  let week = Number(route_query.get("week") ?? 0) || 0;
  let day = (new Date().getDay() + 6) % 7;
  let timers: TimerRow[] = [];
  let runs: TimerRun[] = [];
  let tasks: TaskView[] = [];
  const host_filter = h("span");
  const list = h("div", {}, skeleton(5));
  const task_list = h("div", {}, skeleton(4));
  const calendar = h("div", {}, skeleton(4));
  const week_label = h("span", { class: "muted small" });

  const render_calendar = () => {
    const start = week_start(week);
    week_label.textContent = `${new Date(start * 1000).toLocaleDateString()} – ${new Date((start + 6 * day_in_seconds) * 1000).toLocaleDateString()}`;
    // A task started only by hand that has never run has nothing to show in the week.
    const shown_tasks = tasks.filter((task) => (task.schedule !== null || task.after !== null || task.last_run !== null) && (!host || task.targets.some((target) => target.host === host)));
    const shown_timers = timers.filter((timer) => !host || timer.host === host);
    const rows = [
      ...shown_tasks.map((task) => task_row(task, host)),
      ...shown_timers.map((timer) => ({ label: timer.unit, detail: `${timer.host} timer`, href: link(["hosts", timer.host]), task: false, entries: calendar_entries(timer, runs) })),
    ];
    calendar.replaceChildren(week_calendar(rows, start, day, (next) => { day = next; render_calendar(); }));
  };
  const load_week = async (quiet: boolean) => {
    await load(calendar, async () => {
      runs = await api<TimerRun[]>(`/api/timers/runs${query({ since: week_start(week) })}`);
      render_calendar();
      return [...calendar.childNodes];
    }, { quiet });
  };
  const week_switch = h("div", { class: "segmented", role: "group", "aria-label": "Week" },
    ...([[-1, "‹ Previous"], [0, "This week"], [1, "Next ›"]] as const).map(([step, text]) => h("button", {
      onclick: () => {
        week = step === 0 ? 0 : week + step;
        replace_query({ week: week === 0 ? null : week });
        void load_week(false);
      },
    }, text)));

  const render = () => {
    const hosts = [...new Set([...timers.map((timer) => timer.host), ...tasks.flatMap((task) => task.targets.map((target) => target.host))])].sort();
    host_filter.replaceChildren(select("Host", [["", "Any host"], ...hosts.map((name): [string, string] => [name, name])], host, (value) => {
      host = value;
      replace_query({ host: value });
      render();
    }));
    render_calendar();
    const shown_tasks = tasks.filter((task) => (!host || task.targets.some((target) => target.host === host)) && (state !== "problem" || task.waiting !== null || task.last_run?.state === "failed"));
    task_list.replaceChildren(shown_tasks.length === 0 && tasks.length > 0 ? empty("No task matches these filters.") : tasks_table(shown_tasks, { refresh: () => void refresh(true), with_owner: true }));
    const shown = timers
      .filter((timer) => (!host || timer.host === host) && (state !== "problem" || timer_problem(timer) !== null))
      .sort((a, b) => (a.next_epoch ?? Infinity) - (b.next_epoch ?? Infinity));
    list.replaceChildren(shown.length === 0 && timers.length > 0 ? empty("No timer matches these filters.") : timers_table(shown, true));
  };
  const refresh = async (quiet: boolean) => {
    await load(list, async () => {
      [timers, runs, tasks] = await Promise.all([
        api<TimerRow[]>("/api/timers"),
        api<TimerRun[]>(`/api/timers/runs${query({ since: week_start(week) })}`),
        api<TaskView[]>("/api/tasks").catch((): TaskView[] => []),
      ]);
      render();
      return [...list.childNodes];
    }, { quiet });
  };
  void refresh(false);

  return {
    title: "Schedules",
    root: h("div", { class: "page" },
      h("h1", {}, "Schedules"),
      h("p", { class: "muted" }, "X-Backups starts each job's and repository's tasks when they fall due. Hosts' own systemd timers are read too, for repositories a host fills itself, and missed and failed runs are flagged."),
      toolbar(host_filter, select("State", [["", "Any state"], ["problem", "Needs attention"]], state, (value) => { state = value; replace_query({ state: value }); render(); })),
      section(h("span", {}, "Week ", week_label), calendar, week_switch),
      section("Tasks", task_list),
      section("Host timers", list),
    ),
    update: async (changes) => {
      if (touches(changes, null, ["timers", "tasks", "run", "config"])) await refresh(true);
    },
  };
}

// ── Week calendar ────────────────────────────────────────────────────────────

const day_in_seconds = 86400;
// A timer this far past its next elapse without a run has missed it, as the timers table says.
const missed_grace_in_seconds = 3600;

interface CalendarEntry {
  epoch: number;
  kind: "success" | "failed" | "missed" | "upcoming" | "unknown" | "task";
  title: string;
}

// One row of the calendar: an X-Backups task, or a host's timer.
interface CalendarRow {
  label: string;
  detail: string;
  href: string;
  task: boolean;
  entries: CalendarEntry[];
}

// Midnight starting the Monday of the week `offset` weeks from this one.
function week_start(offset: number): number {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - (date.getDay() + 6) % 7 + offset * 7);
  return date.getTime() / 1000;
}

// A task's row: when it is next due on each of its targets, and its newest run.
function task_row(task: TaskView, host: string): CalendarRow {
  const targets = task.targets.filter((target) => !host || target.host === host);
  const entries: CalendarEntry[] = targets.flatMap((target) => target.next_due === null || !task.enabled ? [] : [{
    epoch: Math.max(target.next_due, Date.now() / 1000), kind: "task" as const, title: `${stamp(target.next_due)}: due on ${target.target_id}${target.waiting ? `; ${target.waiting}` : ""}`,
  }]);
  if (task.last_run !== null) {
    const run = task.last_run;
    const kind = run.state === "succeeded" || run.state === "warning" ? "success" : run.state === "running" ? "unknown" : "failed";
    entries.push({ epoch: run.started_epoch, kind, title: `${stamp(run.started_epoch)}: run #${run.id} ${run.state}` });
  }
  return {
    label: `${task_label(task)} of ${task.owner}`, detail: task.description, task: true,
    href: task.owner_kind === "job" ? link(["jobs", task.owner]) : link(["runs"], { task: task.id }),
    entries: entries.sort((a, b) => a.epoch - b.epoch),
  };
}

// What a timer did and will do: its recorded runs, the elapse it is overdue on, and its coming elapses.
function calendar_entries(timer: TimerRow, runs: TimerRun[]): CalendarEntry[] {
  const now = Date.now() / 1000;
  const entries: CalendarEntry[] = runs.filter((run) => run.host === timer.host && run.unit === timer.unit).map((run) => {
    const kind = run.result === "missed" ? "missed" : run.result === "success" ? "success" : run.result === null ? "unknown" : "failed";
    const outcome = kind === "missed" ? "missed" : kind === "failed" ? `failed: ${run.result}${run.exit_status ? ` (exit ${run.exit_status})` : ""}` : kind === "success" ? "succeeded" : "ran";
    return { epoch: run.epoch, kind, title: `${stamp(run.epoch)}: ${outcome}` };
  });
  const coming = timer.upcoming.length > 0 ? timer.upcoming : timer.next_epoch !== null ? [timer.next_epoch] : [];
  for (const epoch of coming) {
    if (epoch >= now) entries.push({ epoch, kind: "upcoming", title: `${stamp(epoch)}: due` });
    else if (epoch < now - missed_grace_in_seconds && !entries.some((entry) => entry.epoch === epoch)) entries.push({ epoch, kind: "missed", title: `${stamp(epoch)}: missed, not run yet` });
  }
  return entries.sort((a, b) => a.epoch - b.epoch);
}

// A row per task and timer and a column per day of the week, each cell holding that day's runs; on phones one day shows at a time.
function week_calendar(rows: CalendarRow[], start: number, day: number, on_day: (day: number) => void): HTMLElement {
  if (rows.length === 0) return empty("Nothing scheduled.", "Tasks show once a job or repository has one, and timers are read from each host's systemd.");
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start * 1000);
    date.setDate(date.getDate() + index);
    return date;
  });
  const today = new Date().toDateString();
  const day_of = (epoch: number) => days.findIndex((date) => date.toDateString() === new Date(epoch * 1000).toDateString());
  const time = (epoch: number) => new Date(epoch * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const name = (date: Date) => date.toLocaleDateString(undefined, { weekday: "short", day: "numeric" });

  return h("div", { class: "stack" },
    h("div", { class: "segmented day-switch", role: "group", "aria-label": "Day" }, ...days.map((date, index) => h("button", {
      "aria-pressed": String(index === day), onclick: () => on_day(index),
    }, name(date)))),
    h("div", { class: "table-wrap" }, h("table", { class: "calendar", "data-day": day },
      h("thead", {}, h("tr", {}, h("th", {}, "Task or timer"), ...days.map((date, index) => h("th", { class: `day-${index}${date.toDateString() === today ? " today" : ""}` }, name(date))))),
      h("tbody", {}, ...rows.map((row) => h("tr", {},
        h("td", {}, h("div", {}, row.task && h("span", { class: "chip" }, "task"), row.task ? " " : null, h("a", { href: row.href }, row.label)), h("div", { class: "muted small" }, row.detail)),
        ...days.map((date, index) => h("td", { class: `day-${index}${date.toDateString() === today ? " today" : ""}` },
          ...row.entries.filter((entry) => day_of(entry.epoch) === index).map((entry) => h("span", { class: `run run-${entry.kind}`, title: entry.title },
            entry.kind === "missed" ? `${time(entry.epoch)} missed` : entry.kind === "task" ? `${time(entry.epoch)} due` : time(entry.epoch))))),
      ))),
    )),
    h("p", { class: "muted small calendar-key" },
      h("span", { class: "run run-task" }, "task due"), h("span", { class: "run run-upcoming" }, "timer due"),
      h("span", { class: "run run-success" }, "ran"), h("span", { class: "run run-failed" }, "failed"),
      h("span", { class: "run run-missed" }, "missed"),
      " A task shows when it is next due and its newest run. Past weeks show the timer runs X-Backups saw; its reads are every five minutes, so a timer that ran twice between two reads shows once."),
  );
}

// ── Events ───────────────────────────────────────────────────────────────────

export function events_view(): View {
  const route_query = current_route().query;
  let repository = route_query.get("repository") ?? "";
  let level = route_query.get("level") ?? "";
  let page = Number(route_query.get("page") ?? 1);
  const repository_filter = h("span");
  const list = h("div", {}, skeleton(8));

  const refresh = async (quiet: boolean) => {
    await load(list, async () => {
      const events = await api<EventRow[]>(`/api/events${query({ target: repository, level, limit: page_size + 1, offset: (page - 1) * page_size })}`);
      return [
        events_list(events.slice(0, page_size), true),
        pager(page, events.length > page_size, (next) => { page = next; replace_query({ page: next === 1 ? null : next }); void refresh(false); }),
      ];
    }, { quiet });
  };
  const refilter = () => {
    page = 1;
    replace_query({ repository, level, page: null });
    void refresh(false);
  };

  void api<RepositorySummary[]>("/api/repositories").then((repositories) => {
    repository_filter.replaceChildren(select("Repository", [["", "Any repository"], ...repositories.map((item): [string, string] => [item.id, item.name])], repository,
      (value) => { repository = value; refilter(); }));
  }).catch(() => {});
  void refresh(false);

  return {
    title: "Events",
    root: h("div", { class: "page" },
      h("h1", {}, "Events"),
      toolbar(repository_filter, select("Level", event_levels, level, (value) => { level = value; refilter(); })),
      list,
    ),
    update: async (changes) => {
      if (page === 1 && touches(changes, null, ["repository", "run"])) await refresh(true);
    },
  };
}

// ── Settings ─────────────────────────────────────────────────────────────────

const mode_text: Record<ConfigInfo["mode"], [title: string, text: string]> = {
  declarative: ["Declarative", "Everything comes from the Nix configuration and the page shows it read-only. Set services.x-backups.configMode to mixed to add hosts, repositories, sources, jobs and defaults here too."],
  mixed: ["Mixed", "What the Nix configuration declares is locked. The page may add hosts, repositories, sources and jobs and set the defaults it leaves open; a declared entry of the same kind and name replaces a page one."],
  page: ["Page", "The page manages hosts, repositories, sources, jobs and defaults; anything the Nix configuration declares is still locked."],
};

const setting_hints: Record<string, string> = {
  interval: "How often each repository is polled, such as 1h.",
  max_age: "The newest archive older than this fails a repository, such as 1d.",
  warn_age: "The newest archive older than this gives a warning, such as 20h. 0 leaves it off.",
  check_max_age: "A check older than this fails a repository, such as 8d.",
  check_warn_age: "The oldest passing check older than this gives a warning, such as 14d. 0 leaves it off.",
  canary_max_age: "A restore canary that last ran longer ago than this fails a repository, such as 3d. 0 leaves it off.",
  canary_warn_age: "A restore canary that last ran longer ago than this gives a warning, such as 2d. 0 leaves it off.",
  browse_limit: "How many entries a folder, diff or listing shows at most.",
};

const source_text: Record<Setting["source"], [label: string, title: string]> = {
  declared: ["declared", "Set in the Nix configuration; change it there"],
  saved: ["saved", "Saved from this page"],
  default: ["default", "Built in; nothing sets it"],
};

export function settings_view(): View {
  const configuration = h("div", {}, skeleton(4));
  const entities = h("div", {}, skeleton(3));

  const refresh = async (quiet: boolean) => {
    await load(configuration, async () => configuration_panel(await api<ConfigInfo>("/api/config"), () => void refresh(true)), { quiet });
    await load(entities, async () => entity_panels(), { quiet });
  };
  void refresh(false);

  return {
    title: "Settings",
    root: h("div", { class: "page" },
      h("h1", {}, "Settings"),
      section("Appearance", h("div", {},
        select("Theme", [["system", "Follow the system"], ["light", "Light"], ["dark", "Dark"]], theme_choice.get(), (value) => theme_choice.set(value as Theme)),
        h("p", { class: "muted small" }, "Kept in this browser only."),
      )),
      configuration,
      entities,
    ),
    update: async (changes) => {
      if (touches(changes, null, ["config"])) await refresh(true);
    },
  };
}

function configuration_panel(info: ConfigInfo, saved: () => void): Child[] {
  const [title, text] = mode_text[info.mode];
  const inputs = new Map<string, HTMLInputElement>();
  const message = h("p", { class: "tone-bad small", role: "alert" });
  const rows = info.settings.map((setting) => {
    const [label, label_title] = source_text[setting.source];
    const locked = !info.editable || setting.source === "declared";
    const input = h("input", { id: `setting-${setting.name}`, type: "text", readonly: locked, placeholder: setting.source === "default" ? String(setting.value) : null });
    if (setting.source !== "default") input.value = String(setting.value);
    inputs.set(setting.name, input);
    return h("div", { class: "form-row" },
      h("label", { for: `setting-${setting.name}` }, h("code", {}, setting.name)),
      h("div", {}, h("div", { class: "setting-value" }, input, h("span", { class: `chip source-${setting.source}`, title: label_title }, label)),
        h("p", { class: "muted small" }, setting_hints[setting.name] ?? "")),
    );
  });

  const save = h("button", { class: "accent solid" }, "Save defaults");
  save.addEventListener("click", async () => {
    const values: Record<string, unknown> = {};
    for (const setting of info.settings) {
      if (setting.source === "declared") continue;
      const text = inputs.get(setting.name)!.value.trim();
      values[setting.name] = text === "" ? null : /^\d+$/.test(text) ? Number(text) : text;
    }
    save.disabled = true;
    message.textContent = "";
    try {
      await send("PUT", "/api/config/defaults", values);
      toast("Defaults saved. Repositories that use them are polled again.", { tone: "good" });
      saved();
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      message.textContent = error.message;
      if (error.field) inputs.get(error.field)?.focus();
    } finally {
      save.disabled = false;
    }
  });

  return [
    section("Configuration", h("div", { class: "stack" },
      facts([["Mode", title]]),
      h("p", { class: "muted" }, text),
      info.shadowed.length > 0 && h("div", { class: "banner", role: "note" },
        h("strong", {}, "Hidden by the Nix configuration: "), info.shadowed.join(", "),
        ". These were added here, but a declared repository of the same name replaces each one; remove them from the page or rename the declared one."),
      info.editable && h("p", { class: "muted small" }, "Add an entry of the older shape, a host, repository, source and job in one, with ",
        h("a", { href: link(["new-repository"]) }, "Add a repository"), "."),
    )),
    section("Defaults for every repository", h("div", { class: "stack" },
      h("p", { class: "muted small" }, "A repository's own setting wins over these. An empty field goes back to the built-in value."),
      h("div", { class: "form-rows" }, ...rows),
      info.editable && h("div", {}, save, message),
    )),
  ];
}
