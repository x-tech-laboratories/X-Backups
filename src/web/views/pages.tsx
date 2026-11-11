// The smaller pages: the week of tasks and host timers, the event log, and the settings.

import { add_days, start_of_day } from "@x-tech-laboratories/x-libs/dates";
import { ButtonGroup, Segmented, Select } from "@x-tech-laboratories/x-libs/web/react/controls";
import { Facts, Section, Toolbar } from "@x-tech-laboratories/x-libs/web/react/layout";
import { BackupSettings } from "@x-tech-laboratories/x-libs/web/react/backup_settings";
import { create_api } from "@x-tech-laboratories/x-libs/web/api";
import { backup_client } from "@x-tech-laboratories/x-libs/web/backups";
import { Empty, Loaded, Skeleton, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { Pager } from "@x-tech-laboratories/x-libs/web/react/table";
import { toast } from "@x-tech-laboratories/x-libs/web/react/toasts";
import { now_seconds, stamp } from "@x-tech-laboratories/x-libs/web/format";
import { current_route, link, replace_query } from "@x-tech-laboratories/x-libs/web/router";
import type { Theme } from "@x-tech-laboratories/x-libs/web/theme";
import { useEffect, useRef, useState } from "react";
import { timer_problem } from "../attention.ts";
import { api, ApiError, query, send, type ConfigInfo, type EventRow, type RepositorySummary, type Setting, type TaskView, type TimerRow, type TimerRun } from "../api.ts";
import { theme, use_changes } from "../ui.tsx";
import { EntityPanels } from "./entity_config.tsx";
import { event_levels, EventsList, TimersTable, touches } from "./shared.tsx";
import { task_label, TasksTable } from "./tasks.tsx";

const page_size = 50;

// ── Schedules ────────────────────────────────────────────────────────────────

const week_steps: [step: number, text: string][] = [[-1, "‹ Previous"], [0, "This week"], [1, "Next ›"]];

export function SchedulesView() {
  const [query_given] = useState(() => current_route().query);
  const [host, set_host] = useState(query_given.get("host") ?? "");
  const [state, set_state] = useState(query_given.get("state") ?? "");
  const [week, set_week] = useState(Number(query_given.get("week") ?? 0) || 0);
  const [day, set_day] = useState((new Date().getDay() + 6) % 7);

  const schedule = use_resource(() => Promise.all([
    api<TimerRow[]>("/api/timers"),
    api<TaskView[]>("/api/tasks").catch((): TaskView[] => []),
  ]), []);
  const week_runs = use_resource(() => api<TimerRun[]>(`/api/timers/runs${query({ since: week_start(week) })}`), [week]);
  const refresh = () => Promise.all([schedule.reload(true), week_runs.reload(true)]);
  use_changes((changes) => { if (touches(changes, null, ["timers", "tasks", "run", "config"])) refresh(); });

  const step_week = (step: number) => {
    const next = step === 0 ? 0 : week + step;
    set_week(next);
    replace_query({ week: next === 0 ? null : next });
  };

  const start = week_start(week);
  const week_label = `${new Date(start * 1000).toLocaleDateString()} – ${new Date((start + 6 * day_in_seconds) * 1000).toLocaleDateString()}`;
  const [timers, tasks] = schedule.data ?? [[], []];
  const hosts = [...new Set([...timers.map((timer) => timer.host), ...tasks.flatMap((task) => task.targets.map((target) => target.host))])].sort();

  const calendar = () => {
    // A task started only by hand that has never run has nothing to show in the week.
    const shown_tasks = tasks.filter((task) => (task.schedule !== null || task.after !== null || task.last_run !== null) && (!host || task.targets.some((target) => target.host === host)));
    const shown_timers = timers.filter((timer) => !host || timer.host === host);
    const rows = [
      ...shown_tasks.map((task) => task_row(task, host)),
      ...shown_timers.map((timer) => ({ label: timer.unit, detail: `${timer.host} timer`, href: link(["hosts", timer.host]), task: false, entries: calendar_entries(timer, week_runs.data ?? []) })),
    ];
    return <WeekCalendar rows={rows} start={start} day={day} on_day={set_day} />;
  };

  const shown_tasks = tasks.filter((task) => (!host || task.targets.some((target) => target.host === host)) && (state !== "problem" || task.waiting !== null || task.last_run?.state === "failed"));
  const shown_timers = timers
    .filter((timer) => (!host || timer.host === host) && (state !== "problem" || timer_problem(timer) !== null))
    .sort((first, second) => (first.next_epoch ?? Infinity) - (second.next_epoch ?? Infinity));

  return (
    <div className="page">
      <h1>Schedules</h1>
      <p className="muted">X-Backups starts each job's and repository's tasks when they fall due. Hosts' own systemd timers are read too, for repositories a host fills itself, and missed and failed runs are flagged.</p>
      <Toolbar>
        <span>{schedule.data && <Select label="Host" options={[["", "Any host"], ...hosts.map((name): [string, string] => [name, name])]} value={host} on_change={(value) => { set_host(value); replace_query({ host: value }); }} />}</span>
        <Select label="State" options={[["", "Any state"], ["problem", "Needs attention"]]} value={state} on_change={(value) => { set_state(value); replace_query({ state: value }); }} />
      </Toolbar>
      <Section title={<span>Week <span className="muted small">{schedule.data ? week_label : ""}</span></span>} tools={
        <ButtonGroup label="Week">{week_steps.map(([step, text]) => <button key={step} onClick={() => step_week(step)}>{text}</button>)}</ButtonGroup>
      }>
        <div>{schedule.data && week_runs.data ? calendar() : week_runs.error !== null ? <Loaded resource={week_runs}>{() => null}</Loaded> : <Skeleton lines={4} />}</div>
      </Section>
      <Section title="Tasks">
        <div>
          {schedule.data
            ? shown_tasks.length === 0 && tasks.length > 0 ? <Empty title="No task matches these filters." /> : <TasksTable tasks={shown_tasks} refresh={refresh} with_owner />
            : <Skeleton lines={4} />}
        </div>
      </Section>
      <Section title="Host timers">
        <div>
          <Loaded resource={schedule} lines={5}>
            {() => shown_timers.length === 0 && timers.length > 0 ? <Empty title="No timer matches these filters." /> : <TimersTable timers={shown_timers} with_host />}
          </Loaded>
        </div>
      </Section>
    </div>
  );
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
  const today = start_of_day(new Date());
  return add_days(today, -((today.getDay() + 6) % 7) + offset * 7).getTime() / 1000;
}

// A task's row: when it is next due on each of its targets, and its newest run.
function task_row(task: TaskView, host: string): CalendarRow {
  const targets = task.targets.filter((target) => !host || target.host === host);
  const entries: CalendarEntry[] = targets.flatMap((target) => target.next_due === null || !task.enabled ? [] : [{
    epoch: Math.max(target.next_due, now_seconds()), kind: "task" as const, title: `${stamp(target.next_due)}: due on ${target.target_id}${target.waiting ? `; ${target.waiting}` : ""}`,
  }]);
  if (task.last_run !== null) {
    const run = task.last_run;
    const kind = run.state === "succeeded" || run.state === "warning" ? "success" : run.state === "running" ? "unknown" : "failed";
    entries.push({ epoch: run.started_epoch, kind, title: `${stamp(run.started_epoch)}: run #${run.id} ${run.state}` });
  }
  return {
    label: `${task_label(task)} of ${task.owner}`, detail: task.description, task: true,
    href: task.owner_kind === "job" ? link(["jobs", task.owner]) : link(["runs"], { task: task.id }),
    entries: entries.sort((first, second) => first.epoch - second.epoch),
  };
}

// What a timer did and will do: its recorded runs, the elapse it is overdue on, and its coming elapses.
function calendar_entries(timer: TimerRow, runs: TimerRun[]): CalendarEntry[] {
  const now = now_seconds();
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
  return entries.sort((first, second) => first.epoch - second.epoch);
}

// A row per task and timer and a column per day of the week, each cell holding that day's runs; on phones one day shows at a time.
function WeekCalendar({ rows, start, day, on_day }: { rows: CalendarRow[]; start: number; day: number; on_day: (day: number) => void }) {
  if (rows.length === 0) return <Empty title="Nothing scheduled." hint="Tasks show once a job or repository has one, and timers are read from each host's systemd." />;
  const days = Array.from({ length: 7 }, (_, index) => add_days(new Date(start * 1000), index));
  const today = new Date().toDateString();
  const day_of = (epoch: number) => days.findIndex((date) => date.toDateString() === new Date(epoch * 1000).toDateString());
  const time = (epoch: number) => new Date(epoch * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const name = (date: Date) => date.toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
  const day_class = (date: Date, index: number) => `day-${index}${date.toDateString() === today ? " today" : ""}`;

  return (
    <div className="stack">
      <Segmented label="Day" class_name="day-switch" choices={days.map((date, index) => ({ value: String(index), label: name(date) }))} value={String(day)} on_change={(value) => on_day(Number(value))} />
      <div className="table-wrap">
        <table className="calendar" data-day={day}>
          <thead><tr><th>Task or timer</th>{days.map((date, index) => <th key={index} className={day_class(date, index)}>{name(date)}</th>)}</tr></thead>
          <tbody>
            {rows.map((row, row_index) => (
              <tr key={row_index}>
                <td>
                  <div>{row.task && <span className="chip">task</span>}{row.task ? " " : null}<a href={row.href}>{row.label}</a></div>
                  <div className="muted small">{row.detail}</div>
                </td>
                {days.map((date, index) => (
                  <td key={index} className={day_class(date, index)}>
                    {row.entries.filter((entry) => day_of(entry.epoch) === index).map((entry, entry_index) => (
                      <span key={entry_index} className={`run run-${entry.kind}`} title={entry.title}>
                        {entry.kind === "missed" ? `${time(entry.epoch)} missed` : entry.kind === "task" ? `${time(entry.epoch)} due` : time(entry.epoch)}
                      </span>
                    ))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small calendar-key">
        <span className="run run-task">task due</span><span className="run run-upcoming">timer due</span>
        <span className="run run-success">ran</span><span className="run run-failed">failed</span>
        <span className="run run-missed">missed</span>
        {" A task shows when it is next due and its newest run. Past weeks show the timer runs X-Backups saw; its reads are every five minutes, so a timer that ran twice between two reads shows once."}
      </p>
    </div>
  );
}

// ── Events ───────────────────────────────────────────────────────────────────

export function EventsView() {
  const [query_given] = useState(() => current_route().query);
  const [repository, set_repository] = useState(query_given.get("repository") ?? "");
  const [level, set_level] = useState(query_given.get("level") ?? "");
  const [page, set_page] = useState(Number(query_given.get("page") ?? 1));
  const events = use_resource(() => api<EventRow[]>(`/api/events${query({ target: repository, level, limit: page_size + 1, offset: (page - 1) * page_size })}`), [repository, level, page]);
  const repositories = use_resource(() => api<RepositorySummary[]>("/api/repositories"), []);
  use_changes((changes) => { if (page === 1 && touches(changes, null, ["repository", "run"])) events.reload(true); });

  const refilter = (next_repository: string, next_level: string) => {
    set_repository(next_repository);
    set_level(next_level);
    set_page(1);
    replace_query({ repository: next_repository, level: next_level, page: null });
  };

  return (
    <div className="page">
      <h1>Events</h1>
      <Toolbar>
        <span>{repositories.data && <Select label="Repository" options={[["", "Any repository"], ...repositories.data.map((item): [string, string] => [item.id, item.name])]} value={repository} on_change={(value) => refilter(value, level)} />}</span>
        <Select label="Level" options={event_levels} value={level} on_change={(value) => refilter(repository, value)} />
      </Toolbar>
      <div>
        <Loaded resource={events} lines={8}>
          {(rows) => <>
            <EventsList events={rows.slice(0, page_size)} with_repository />
            <Pager page={page} has_more={rows.length > page_size} go={(next) => { set_page(next); replace_query({ page: next === 1 ? null : next }); }} />
          </>}
        </Loaded>
      </div>
    </div>
  );
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

const theme_options: [value: Theme, text: string][] = [["system", "Follow the system"], ["light", "Light"], ["dark", "Dark"]];

// The state database's backups; changing them needs an admin.
const backups = backup_client(create_api());

export function SettingsView() {
  const [chosen, set_chosen] = useState(theme.get);
  const config = use_resource(() => api<ConfigInfo>("/api/config"), []);
  use_changes((changes) => { if (touches(changes, null, ["config"])) config.reload(true); });
  useEffect(() => theme.on_change(set_chosen), []);

  return (
    <div className="page">
      <h1>Settings</h1>
      <Section title="Appearance">
        <div>
          <Select label="Theme" options={theme_options} value={chosen} on_change={(value) => theme.set(value)} />
          <p className="muted small">Kept in this browser only.</p>
        </div>
      </Section>
      <div className="stack"><Loaded resource={config} lines={4}>{(info) => <ConfigurationPanel info={info} saved={() => config.reload(true)} />}</Loaded></div>
      <div>{config.data ? <EntityPanels /> : <Skeleton lines={3} />}</div>
      <Section title="Backups">
        {/* A restore restarts the server, so the page loads again once it answers. */}
        <BackupSettings device={backups} data_name="accounts, task overrides, agent tokens and history" on_restored={() => setTimeout(() => window.location.reload(), 3000)} />
      </Section>
    </div>
  );
}

function ConfigurationPanel({ info, saved }: { info: ConfigInfo; saved: () => void }) {
  const [title, text] = mode_text[info.mode];
  const values_of = () => Object.fromEntries(info.settings.map((setting) => [setting.name, setting.source === "default" ? "" : String(setting.value)]));
  const [values, set_values] = useState<Record<string, string>>(values_of);
  const [message, set_message] = useState("");
  const [busy, set_busy] = useState(false);
  const inputs = useRef(new Map<string, HTMLInputElement>());

  // A fresh read of the config shows its values again.
  useEffect(() => set_values(values_of()), [info]);

  async function save(): Promise<void> {
    const body: Record<string, unknown> = {};
    for (const setting of info.settings) {
      if (setting.source === "declared") continue;
      const typed = (values[setting.name] ?? "").trim();
      body[setting.name] = typed === "" ? null : /^\d+$/.test(typed) ? Number(typed) : typed;
    }
    set_busy(true);
    set_message("");
    try {
      await send("PUT", "/api/config/defaults", body);
      toast("Defaults saved. Repositories that use them are polled again.", { tone: "good" });
      saved();
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      set_message(error.message);
      if (error.field) inputs.current.get(error.field)?.focus();
    } finally {
      set_busy(false);
    }
  }

  return <>
    <Section title="Configuration">
      <div className="stack">
        <Facts rows={[["Mode", title]]} />
        <p className="muted">{text}</p>
        {info.shadowed.length > 0 && (
          <div className="banner" role="note">
            <strong>Hidden by the Nix configuration: </strong>{info.shadowed.join(", ")}
            . These were added here, but a declared repository of the same name replaces each one; remove them from the page or rename the declared one.
          </div>
        )}
        {info.editable && <p className="muted small">Add an entry of the older shape, a host, repository, source and job in one, with <a href={link(["new-repository"])}>Add a repository</a>.</p>}
      </div>
    </Section>
    <Section title="Defaults for every repository">
      <div className="stack">
        <p className="muted small">A repository's own setting wins over these. An empty field goes back to the built-in value.</p>
        <div className="form-rows">
          {info.settings.map((setting) => {
            const [label, label_title] = source_text[setting.source];
            const locked = !info.editable || setting.source === "declared";
            return (
              <div key={setting.name} className="form-row">
                <label htmlFor={`setting-${setting.name}`}><code>{setting.name}</code></label>
                <div>
                  <div className="setting-value">
                    <input
                      ref={(element) => { if (element) inputs.current.set(setting.name, element); }}
                      id={`setting-${setting.name}`} type="text" readOnly={locked}
                      placeholder={setting.source === "default" ? String(setting.value) : undefined}
                      value={values[setting.name] ?? ""}
                      onChange={(event) => set_values({ ...values, [setting.name]: (event.currentTarget as HTMLInputElement).value })}
                    />
                    <span className={`chip source-${setting.source}`} title={label_title}>{label}</span>
                  </div>
                  <p className="muted small">{setting_hints[setting.name] ?? ""}</p>
                </div>
              </div>
            );
          })}
        </div>
        {info.editable && <div><button className="accent solid" disabled={busy} onClick={() => void save()}>Save defaults</button><p className="tone-bad small" role="alert">{message}</p></div>}
      </div>
    </Section>
  </>;
}
