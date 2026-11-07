// The tasks of a job or a repository: their schedules in words, when each is next due, its last run and why it waits,
// with Run now and a switch for an operator.

import { Badge, Chip } from "@x-tech-laboratories/x-libs/web/react/badges";
import { Switch } from "@x-tech-laboratories/x-libs/web/react/controls";
import { Empty } from "@x-tech-laboratories/x-libs/web/react/states";
import { DataTable, type TableColumn } from "@x-tech-laboratories/x-libs/web/react/table";
import { toast } from "@x-tech-laboratories/x-libs/web/react/toasts";
import { age, now_seconds, stamp, until } from "@x-tech-laboratories/x-libs/web/format";
import { link } from "@x-tech-laboratories/x-libs/web/router";
import { useState } from "react";
import { api, type TaskView } from "../api.ts";
import { can } from "../session.ts";
import { RunBadge } from "../ui.tsx";
import type { Refresh } from "./shared.tsx";

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
export function TaskOwnerLink({ task }: { task: Pick<TaskView, "owner_kind" | "owner"> }) {
  return task.owner_kind === "job" ? <a href={link(["jobs", task.owner])}>{task.owner}</a> : <span>{`repository ${task.owner}`}</span>;
}

// ── Table ────────────────────────────────────────────────────────────────────

interface TasksTableProps {
  tasks: TaskView[];
  refresh: Refresh;
  with_owner?: boolean;
  empty_hint?: string;
}

export function TasksTable({ tasks, refresh, with_owner = false, empty_hint }: TasksTableProps) {
  if (tasks.length === 0) return <Empty title="No tasks." hint={empty_hint ?? "A job's backup, prune, check and canary, and a repository's compact and check, show here once configured."} />;
  const columns: TableColumn<TaskView>[] = [
    ...(with_owner ? [{ label: "Of", cell: (task: TaskView) => <TaskOwnerLink task={task} />, sort: (task: TaskView) => task.owner }] : []),
    { label: "Task", cell: (task) => <strong>{task_label(task)}</strong> },
    {
      label: "Schedule", cell: (task) => <>
        <span>{task.description}</span>
        {origin_text[task.origin] && <div className="muted small">{origin_text[task.origin]}</div>}
      </>,
    },
    { label: "Next due", cell: (task) => <NextDue task={task} />, sort: (task) => task.next_due },
    {
      label: "Last run", cell: (task) => task.last_run === null ? <span className="muted">never</span> : (
        <span>
          <RunBadge state={task.last_run.state} />{" "}
          <a href={link(["runs", String(task.last_run.id)])} title={stamp(task.last_run.started_epoch)}>{age(task.last_run.started_epoch)}</a>
        </span>
      ),
      sort: (task) => task.last_run?.started_epoch ?? null,
    },
    { label: "Enabled", cell: (task) => <Enabled task={task} refresh={refresh} /> },
    { label: "", class: "actions-cell", cell: (task) => can("operator") && <span className="row-actions"><RunNow task={task} refresh={refresh} /></span> },
  ];
  return <div aria-live="polite"><DataTable columns={columns} rows={tasks} row_key={(task) => task.id} caption="Tasks" /></div>;
}

// When the task is next due, or that it runs now or waits, and why.
function NextDue({ task }: { task: TaskView }) {
  if (task.running) return <Badge tone="info">running</Badge>;
  if (task.waiting) return <span><Badge tone="warn">waiting</Badge><div className="muted small">{task.waiting}</div></span>;
  if (!task.enabled) return <span className="muted">switched off</span>;
  if (task.next_due === null) return <span className="muted">{task.after ? "after the next backup" : "only by hand"}</span>;
  return <span title={stamp(task.next_due)}>{task.next_due <= now_seconds() ? "due now" : until(task.next_due)}</span>;
}

// A switch an operator turns, saying when it differs from the config; a viewer sees the state as text.
function Enabled({ task, refresh }: { task: TaskView; refresh: Refresh }) {
  const note = task.override && (
    <div className="muted small">{`${task.override.enabled ? "On" : "Off"} here by ${task.override.changed_by}; the config says ${task.enabled_by_config ? "on" : "off"}`}</div>
  );
  const schedulable = task.schedule !== null || task.after !== null;
  if (!can("operator") || (!schedulable && !task.enabled)) {
    return <span><Badge tone={task.enabled ? "good" : "none"}>{task.enabled ? "on" : "off"}</Badge>{note}</span>;
  }

  async function change(next: boolean): Promise<boolean> {
    try {
      await api(`/api/tasks/${encodeURIComponent(task.id)}/${next ? "enable" : "disable"}`, {});
      toast(`${task_label(task)} of ${task.owner} switched ${next ? "on" : "off"}.`, { tone: "good" });
      return true;
    } catch (error) {
      toast(`Could not switch it: ${error instanceof Error ? error.message : String(error)}`, { tone: "bad" });
      return false;
    } finally {
      void refresh();
    }
  }

  return (
    <span>
      <label className="check"><Switch label={`${task_label(task)} of ${task.owner} enabled`} checked={task.enabled} on_change={change} />{task.enabled ? " on" : " off"}</label>
      {task.override && <Chip>changed here</Chip>}
      {note}
    </span>
  );
}

function RunNow({ task, refresh }: { task: TaskView; refresh: Refresh }) {
  const [busy, set_busy] = useState(false);

  async function run(): Promise<void> {
    set_busy(true);
    try {
      const answer = await api<{ targets: string[] }>(`/api/tasks/${encodeURIComponent(task.id)}/run`, {});
      toast(answer.targets.length === 0 ? "No target to run it on." : `${task_label(task)} asked for on ${answer.targets.length === 1 ? answer.targets[0] : `${answer.targets.length} targets`}.`, {
        tone: answer.targets.length === 0 ? "warn" : "good",
        link: { href: link(["runs"], { task: task.id }), text: "Its runs" },
      });
    } catch (error) {
      toast(`Could not run it: ${error instanceof Error ? error.message : String(error)}`, { tone: "bad" });
    }
    set_busy(false);
    void refresh();
  }

  return <button aria-label={`Run ${task_label(task)} of ${task.owner} now`} disabled={task.running || busy} onClick={run}>Run now</button>;
}
