// Why a repository or a timer needs a look, one reason per line.

import type { RepositorySummary, TimerRow } from "./api.ts";
import { now_seconds } from "./dom.ts";

export interface Reason {
  tone: "bad" | "warn";
  text: string;
}

// A timer whose next run is this far in the past has missed it.
const missed_grace_in_seconds = 3600;

export function overdue(repository: RepositorySummary): boolean {
  return !repository.last_backup_epoch || now_seconds() - repository.last_backup_epoch > repository.max_age;
}

// The server's reasons, in the page's tones.
export function repository_reasons(repository: RepositorySummary): Reason[] {
  return repository.reasons.map((reason) => ({ tone: reason.level === "critical" ? "bad" : "warn", text: reason.text }));
}

// Why a timer needs attention: it missed its run, its last run failed, or it never ran; null when it is fine.
export function timer_problem(timer: TimerRow): string | null {
  if (timer.next_epoch !== null && timer.next_epoch < now_seconds() - missed_grace_in_seconds) return "missed its run";
  if (timer.result !== null && timer.result !== "success") return `last run: ${timer.result}${timer.exit_status ? ` (exit ${timer.exit_status})` : ""}`;
  if (timer.last_epoch === null) return "never ran";
  return null;
}

export function failing(repository: RepositorySummary): boolean {
  return repository.level === "critical";
}
