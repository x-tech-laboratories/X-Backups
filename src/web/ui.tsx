// X-Backups' own badges on the shared ones, the theme choice, and the hook a view listens to the server's changes with.

import { Badge, StateBadge, type Tone } from "@x-tech-laboratories/x-libs/web/preact/badges";
import { theme_choice } from "@x-tech-laboratories/x-libs/web/theme";
import { useEffect, useRef } from "preact/hooks";
import type { Change, EventLevel, Level, Run, RunState, Status } from "./api.ts";
import { on_changes } from "./live.ts";

// ── Theme ────────────────────────────────────────────────────────────────────

// The light, dark or system theme this browser keeps for X-Backups.
export const theme = theme_choice("x-backups-theme");

// ── Badges ───────────────────────────────────────────────────────────────────

const status_labels: Record<Status, string> = {
  online: "OK",
  info: "OK",
  warning: "Warning",
  unavailable: "Unreachable",
  failed: "Failed",
};

export function status_tone(status: Status | null): "good" | "warn" | "bad" | "none" {
  if (status === "online" || status === "info") return "good";
  if (status === "warning" || status === "unavailable") return "warn";
  if (status === "failed") return "bad";
  return "none";
}

export function StatusBadge({ status }: { status: Status | null }) {
  return <Badge tone={status_tone(status)}>{status === null ? "Not polled" : status_labels[status]}</Badge>;
}

const run_labels: Record<RunState, [text: string, tone: Tone]> = {
  running: ["running", "info"],
  succeeded: ["succeeded", "good"],
  warning: ["warning", "warn"],
  failed: ["failed", "bad"],
  cancelled: ["cancelled", "none"],
};

export function RunBadge({ state }: { state: RunState }) {
  return <StateBadge labels={run_labels} state={state} />;
}

// A run's state, or what keeps it from going: waiting for its host's agent, or lost when the agent no longer knew it.
export function RunStateBadge({ run }: { run: Pick<Run, "state" | "condition"> }) {
  if (run.condition === "waiting_for_agent") return <Badge tone="warn" title="Its host's agent is away; the run carries on there and is followed again when it connects">waiting for agent</Badge>;
  if (run.condition === "lost") return <Badge tone="bad" title="The agent no longer knew this run, so its outcome is unknown">lost</Badge>;
  return <RunBadge state={run.state} />;
}

const health_labels: Record<Level, [text: string, tone: Tone]> = { ok: ["OK", "good"], warning: ["Warning", "warn"], critical: ["Failing", "bad"] };

// How healthy a job or a target is, as the server judges it.
export function HealthBadge({ level }: { level: Level | null }) {
  if (level === null) return <Badge tone="none">No targets</Badge>;
  return <StateBadge labels={health_labels} state={level} />;
}

const level_labels: Record<EventLevel, [text: string, tone: Tone]> = { INFO: ["info", "none"], WARNING: ["warning", "warn"], ERROR: ["error", "bad"] };

export function LevelBadge({ level }: { level: EventLevel }) {
  return <StateBadge labels={level_labels} state={level} />;
}

// ── Changes ──────────────────────────────────────────────────────────────────

// Calls the latest listener with each batch of changes from the server's stream while the component is shown.
export function use_changes(listener: (changes: Change[] | null) => void): void {
  const latest = useRef(listener);
  latest.current = listener;
  useEffect(() => on_changes((changes) => latest.current(changes)), []);
}
