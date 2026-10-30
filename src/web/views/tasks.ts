// The tasks of a job or a repository: their schedules in words, when each is next due, its last run and why it waits,
// with Run now and a switch for an operator.

import { api, type TaskView } from "../api.ts";
import { age, h, stamp, until } from "../dom.ts";
import { link } from "../router.ts";
import { can } from "../session.ts";
import { chip, data_table, empty, run_badge, toast } from "../ui.ts";

const kind_labels: Record<string, string> = { backup: "Backup", prune: "Prune", check: "Check", canary: "Restore canary", compact: "Compact" };

const origin_text: Record<TaskView["origin"], string> = {
  written: "",
  translated: "from prune_after_backup or compact_after_backup",
  default: "defaulted from its limits",
  manual: "",
};

// The task's kind in words, with what a check checks.
export function task_label(task: Pick<TaskView, "kind" | "check">): string {
  const label = kind_labels[task.kind] ?? task.kind;
  return task.kind === "check" && task.check ? `${label} (${task.check})` : label;
}

// Where the task belongs: its job's or its repository's page.
export function task_owner_link(task: Pick<TaskView, "owner_kind" | "owner">): HTMLElement {
  return task.owner_kind === "job"
    ? h("a", { href: link(["jobs", task.owner]) }, task.owner)
    : h("span", {}, `repository ${task.owner}`);
}

export function tasks_table(tasks: TaskView[], options: { refresh: () => void; with_owner?: boolean; empty_hint?: string }): HTMLElement {
  if (tasks.length === 0) return empty("No tasks.", options.empty_hint ?? "A job's backup, prune, check and canary, and a repository's compact and check, show here once configured.");
  return h("div", { "aria-live": "polite" }, data_table<TaskView>([
    ...(options.with_owner ? [{ label: "Of", cell: (task: TaskView) => task_owner_link(task), sort: (task: TaskView) => task.owner }] : []),
    { label: "Task", cell: (task) => h("strong", {}, task_label(task)) },
    {
      label: "Schedule", cell: (task) => [
        h("span", {}, task.description),
        origin_text[task.origin] && h("div", { class: "muted small" }, origin_text[task.origin]),
      ],
    },
    { label: "Next due", cell: (task) => next_due_cell(task), sort: (task) => task.next_due },
    {
      label: "Last run", cell: (task) => task.last_run === null ? h("span", { class: "muted" }, "never") : h("span", {},
        run_badge(task.last_run.state), " ",
        h("a", { href: link(["runs", String(task.last_run.id)]), title: stamp(task.last_run.started_epoch) }, age(task.last_run.started_epoch))),
      sort: (task) => task.last_run?.started_epoch ?? null,
    },
    { label: "Enabled", cell: (task) => enabled_cell(task, options.refresh) },
    { label: "", class: "actions-cell", cell: (task) => can("operator") && h("span", { class: "row-actions" }, run_now_button(task, options.refresh)) },
  ], tasks, { caption: "Tasks" }));
}

// When the task is next due, or that it runs now or waits, and why.
function next_due_cell(task: TaskView): HTMLElement {
  if (task.running) return h("span", { class: "badge tone-info" }, "running");
  if (task.waiting) return h("span", {}, h("span", { class: "badge tone-warn" }, "waiting"), h("div", { class: "muted small" }, task.waiting));
  if (!task.enabled) return h("span", { class: "muted" }, "switched off");
  if (task.next_due === null) return h("span", { class: "muted" }, task.after ? "after the next backup" : "only by hand");
  return h("span", { title: stamp(task.next_due) }, task.next_due <= Date.now() / 1000 ? "due now" : until(task.next_due));
}

// A switch an operator turns, saying when it differs from the config; a viewer sees the state as text.
function enabled_cell(task: TaskView, refresh: () => void): HTMLElement {
  const note = task.override
    ? h("div", { class: "muted small" }, `${task.override.enabled ? "On" : "Off"} here by ${task.override.changed_by}; the config says ${task.enabled_by_config ? "on" : "off"}`)
    : null;
  const schedulable = task.schedule !== null || task.after !== null;
  if (!can("operator") || (!schedulable && !task.enabled)) {
    return h("span", {}, h("span", { class: `badge tone-${task.enabled ? "good" : "none"}` }, task.enabled ? "on" : "off"), note);
  }
  const box = h("input", { type: "checkbox", role: "switch", checked: task.enabled, "aria-label": `${task_label(task)} of ${task.owner} enabled` });
  box.addEventListener("change", async () => {
    box.disabled = true;
    try {
      await api(`/api/tasks/${encodeURIComponent(task.id)}/${box.checked ? "enable" : "disable"}`, {});
      toast(`${task_label(task)} of ${task.owner} switched ${box.checked ? "on" : "off"}.`, { tone: "good" });
    } catch (error) {
      box.checked = !box.checked;
      toast(`Could not switch it: ${error instanceof Error ? error.message : String(error)}`, { tone: "bad" });
    }
    box.disabled = false;
    refresh();
  });
  return h("span", {}, h("label", { class: "check" }, box, task.enabled ? " on" : " off"), task.override && chip("changed here"), note);
}

function run_now_button(task: TaskView, refresh: () => void): HTMLElement {
  const button = h("button", { "aria-label": `Run ${task_label(task)} of ${task.owner} now`, disabled: task.running }, "Run now");
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const answer = await api<{ targets: string[] }>(`/api/tasks/${encodeURIComponent(task.id)}/run`, {});
      toast(answer.targets.length === 0 ? "No target to run it on." : `${task_label(task)} asked for on ${answer.targets.length === 1 ? answer.targets[0] : `${answer.targets.length} targets`}.`, {
        tone: answer.targets.length === 0 ? "warn" : "good",
        link: { href: link(["runs"], { task: task.id }), text: "Its runs" },
      });
    } catch (error) {
      toast(`Could not run it: ${error instanceof Error ? error.message : String(error)}`, { tone: "bad" });
    }
    refresh();
  });
  return button;
}
