// What several pages show the same way: repository cards, the runs table, the events list and the timers table.

import { show_outcome } from "../actions.ts";
import { overdue, timer_problem } from "../attention.ts";
import { api, type Change, type EventRow, type Run, type Outcome, type RepositorySummary, type TimerRow } from "../api.ts";
import { age, duration, h, now_seconds, size, stamp, until } from "../dom.ts";
import { link } from "../router.ts";
import { can } from "../session.ts";
import { chip, confirm_dialog, data_table, empty, run_badge, level_badge, status_badge, toast, verdict, type Sorting } from "../ui.ts";

// ── Views ────────────────────────────────────────────────────────────────────

export interface View {
  root: HTMLElement;
  title: string;
  // Refetches what the changes touch; null means anything may have changed.
  update?: (changes: Change[] | null) => Promise<void>;
  dispose?: () => void;
}

// Whether any change concerns the repository (or any repository when none is named), of one of the kinds.
export function touches(changes: Change[] | null, target_id: string | null, kinds: Change["kind"][]): boolean {
  if (changes === null) return true;
  return changes.some((change) => kinds.includes(change.kind) && (target_id === null || change.target_id === null || change.target_id === target_id));
}

// ── Repositories ─────────────────────────────────────────────────────────────

export function repository_card(repository: RepositorySummary): HTMLElement {
  const late = repository.last_poll_epoch !== null && overdue(repository);
  return h("a", { class: `card tone-edge-${level_tone[repository.level]}`, href: link(["repositories", repository.id]) },
    h("div", { class: "card-head" }, h("strong", {}, repository.name), status_badge(repository.status)),
    h("div", { class: "muted card-host" }, repository.host),
    h("dl", {},
      h("dt", {}, "Last backup"),
      h("dd", { class: late ? "tone-bad" : "" }, age(repository.last_backup_epoch), late ? " · overdue" : ""),
      h("dt", {}, "Archives"), h("dd", {}, repository.archive_count ?? "—"),
      h("dt", {}, "Stored"), h("dd", {}, size(repository.stats?.deduplicated_size)),
      h("dt", {}, "Original"), h("dd", {}, size(repository.stats?.original_size)),
    ),
    h("div", { class: "verdicts" }, verdict(repository.checks_passed, "checks"), verdict(repository.canary?.ok, "canary")),
    h("div", { class: "chips" },
      repository.source === "declared" ? chip("declared", "Set in the Nix configuration; edit it there") : chip("added here", "Added from this page; edit it on its Config tab"),
      repository.running_run && chip(`${repository.running_run.kind} running${repository.running_run.progress ? ` · ${repository.running_run.progress}` : ""}`),
    ),
  );
}

export function repositories_table(repositories: RepositorySummary[], sorting: Sorting, on_sort: (sorting: Sorting) => void): HTMLElement {
  return data_table<RepositorySummary>([
    { label: "Name", cell: (row) => h("a", { href: link(["repositories", row.id]) }, row.name), sort: (row) => row.name.toLowerCase() },
    { label: "Status", cell: (row) => status_badge(row.status), sort: (row) => status_rank(row) },
    { label: "Host", cell: (row) => row.host, sort: (row) => row.host },
    {
      label: "Last backup", sort: (row) => row.last_backup_epoch ?? 0,
      cell: (row) => h("span", { class: row.last_poll_epoch !== null && overdue(row) ? "tone-bad" : "", title: row.last_backup_epoch ? stamp(row.last_backup_epoch) : null }, age(row.last_backup_epoch)),
    },
    { label: "Archives", class: "number", cell: (row) => row.archive_count ?? "—", sort: (row) => row.archive_count },
    { label: "Stored", class: "number", cell: (row) => size(row.stats?.deduplicated_size), sort: (row) => row.stats?.deduplicated_size ?? null },
    { label: "Checks", cell: (row) => verdict(row.checks_passed, "checks") },
    { label: "Canary", cell: (row) => verdict(row.canary?.ok, "canary") },
  ], repositories, { sorting, on_sort, caption: "Repositories" });
}

// Worst first: failing, then needing attention, then fine.
export function status_rank(repository: RepositorySummary): number {
  return { critical: 0, warning: 1, ok: 2 }[repository.level];
}

const level_tone = { critical: "bad", warning: "warn", ok: "good" } as const;

// ── Runs ─────────────────────────────────────────────────────────────────────

// The middle duration of each kind's finished runs, which a run's duration bar is drawn against.
export function medians(runs: Run[]): Map<string, number> {
  const by_kind = new Map<string, number[]>();
  for (const run of runs) {
    if (run.ended_epoch === null || run.state !== "succeeded" && run.state !== "warning") continue;
    const list = by_kind.get(run.kind) ?? [];
    list.push(run.ended_epoch - run.started_epoch);
    by_kind.set(run.kind, list);
  }
  return new Map([...by_kind].map(([kind, list]) => {
    list.sort((a, b) => a - b);
    return [kind, list[Math.floor(list.length / 2)]];
  }));
}

// A bar where the kind's usual duration sits at the middle mark, turning warm when a run took twice as long.
function duration_bar(run: Run, median: number | undefined): HTMLElement {
  const took = (run.ended_epoch ?? now_seconds()) - run.started_epoch;
  const text = duration(took);
  if (!median) return h("span", {}, text);
  const share = Math.min(100, took / median * 50);
  const tone = took > median * 2 ? "warn" : "info";
  return h("span", { class: "duration", title: `Usually ${duration(median)}` },
    h("span", { class: "duration-text" }, text),
    h("span", { class: "duration-track", "aria-hidden": "true" }, h("span", { class: `duration-fill tone-fill-${tone}`, style: `width: ${share.toFixed(0)}%` })));
}

export function runs_table(runs: Run[], options: { with_repository: boolean; refresh: () => void; usual?: Map<string, number> }): HTMLElement {
  if (runs.length === 0) return empty("No runs here.", "Runs appear when an action runs, such as a backup, check or prune.");
  const usual = options.usual ?? medians(runs);
  return data_table<Run>([
    ...(options.with_repository ? [{ label: "Repository", cell: (run: Run) => h("a", { href: link(["repositories", run.target_id]) }, run.target_id) }] : []),
    { label: "Run", cell: (run) => h("a", { href: link(["runs", String(run.id)]) }, `${run.kind} #${run.id}`) },
    { label: "State", cell: (run) => [run_badge(run.state), run.progress && run.state === "running" ? h("span", { class: "muted" }, ` ${run.progress}`) : null] },
    { label: "Started", cell: (run) => h("span", { title: stamp(run.started_epoch) }, age(run.started_epoch)) },
    { label: "Took", cell: (run) => duration_bar(run, usual.get(run.kind)) },
    { label: "", class: "actions-cell", cell: (run) => run_buttons(run, options.refresh) },
  ], runs, { caption: "Runs" });
}

export function run_buttons(run: Run, refresh: () => void): HTMLElement | null {
  if (!can("operator")) return null;
  return h("span", { class: "row-actions" },
    run.state === "running" && h("button", { class: "danger", onclick: () => cancel_run(run, refresh) }, "Cancel"),
    run.retry && h("button", { onclick: () => retry_run(run, refresh) }, "Retry"),
  );
}

export function cancel_run(run: Run, refresh: () => void): void {
  confirm_dialog({
    title: `Cancel ${run.kind} #${run.id}?`,
    message: `This stops the ${run.kind} on ${run.target_id}. Borg keeps what was finished before it stopped, and the run can be run again.`,
    confirm_label: "Cancel run",
    busy_label: "Cancelling…",
    danger: true,
    run: async () => {
      const outcome = await api<Outcome>(`/api/runs/${run.id}/cancel`, {}).catch((error: Error) => ({ success: false, content: error.message, logs: [] }));
      toast(outcome.content ?? "Cancelled.", { tone: outcome.success ? "warn" : "bad" });
      refresh();
    },
  });
}

export function retry_run(run: Run, refresh: () => void): void {
  confirm_dialog({
    title: `Run ${run.kind} again?`,
    message: `This starts the same ${run.kind} on ${run.target_id} that run #${run.id} ran.`,
    confirm_label: "Run again",
    busy_label: "Starting…",
    run: async () => {
      try {
        await show_outcome(run.target_id, run.kind, await api<Outcome>(`/api/runs/${run.id}/retry`, {}));
      } catch (error) {
        toast(`Could not run it again: ${error instanceof Error ? error.message : String(error)}`, { tone: "bad" });
      }
      refresh();
    },
  });
}

// ── Events ───────────────────────────────────────────────────────────────────

export function events_list(events: EventRow[], with_repository: boolean): HTMLElement {
  if (events.length === 0) return empty("Nothing logged here.", "Warnings, errors and actions show up here as they happen.");
  return h("ul", { class: "events" }, ...events.map((event) => h("li", { class: `level-${event.level.toLowerCase()}` },
    h("span", { class: "muted event-time", title: stamp(event.epoch) }, age(event.epoch)),
    level_badge(event.level),
    with_repository && h("a", { href: link(["repositories", event.target_id]) }, event.target_id),
    h("span", { class: "event-message" }, event.message),
  )));
}

// ── Timers ───────────────────────────────────────────────────────────────────

export function timers_table(timers: TimerRow[], with_host: boolean): HTMLElement {
  if (timers.length === 0) return empty("No backup timers found.", "X-Backups reads systemd timers named for borg, borgmatic or backups on each host.");
  return data_table<TimerRow>([
    ...(with_host ? [{ label: "Host", cell: (timer: TimerRow) => timer.host }] : []),
    { label: "Timer", cell: (timer) => h("span", { title: timer.service }, timer.unit) },
    { label: "Last run", cell: (timer) => h("span", { title: timer.last_epoch ? stamp(timer.last_epoch) : null }, age(timer.last_epoch)) },
    { label: "Next run", cell: (timer) => h("span", { title: timer.next_epoch ? stamp(timer.next_epoch) : null }, until(timer.next_epoch)) },
    {
      label: "State", cell: (timer) => {
        const problem = timer_problem(timer);
        return h("span", { class: `badge tone-${problem ? "bad" : "good"}` }, problem ?? "ok");
      },
    },
  ], timers, { caption: "Backup timers" });
}
