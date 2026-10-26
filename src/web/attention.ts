// Why a repository or a timer needs a look, one reason per line, worked out from what the page already fetched.

import type { RepositorySummary, TimerRow } from "./api.ts";
import { age, duration, now_seconds } from "./dom.ts";

export interface Reason {
  tone: "bad" | "warn";
  text: string;
}

// A timer whose next run is this far in the past has missed it.
const missed_grace_in_seconds = 3600;

export function overdue(repository: RepositorySummary): boolean {
  return !repository.last_backup_epoch || now_seconds() - repository.last_backup_epoch > repository.max_age;
}

export function repository_reasons(repository: RepositorySummary): Reason[] {
  const reasons: Reason[] = [];
  if (repository.status === "unavailable") reasons.push({ tone: "warn", text: "the repository could not be reached" });
  if (repository.status === null) reasons.push({ tone: "warn", text: "not polled yet" });
  if (repository.last_poll_epoch !== null && overdue(repository)) {
    reasons.push({
      tone: "bad",
      text: repository.last_backup_epoch
        ? `last backup ${age(repository.last_backup_epoch)}, limit ${duration(repository.max_age)}`
        : "no backup yet",
    });
  }
  if (repository.checks_passed === false) reasons.push({ tone: "bad", text: "a check failed or is overdue" });
  if (repository.canary?.ok === false) reasons.push({ tone: "bad", text: "the restore canary failed" });
  // A failed poll the reasons above do not explain is named on its own, pointing at the events that say why.
  if (repository.status === "failed" && !reasons.some((reason) => reason.tone === "bad")) {
    reasons.push({ tone: "bad", text: "the last poll failed; its events say why" });
  }
  return reasons;
}

// Why a timer needs attention: it missed its run, its last run failed, or it never ran; null when it is fine.
export function timer_problem(timer: TimerRow): string | null {
  if (timer.next_epoch !== null && timer.next_epoch < now_seconds() - missed_grace_in_seconds) return "missed its run";
  if (timer.result !== null && timer.result !== "success") return `last run: ${timer.result}${timer.exit_status ? ` (exit ${timer.exit_status})` : ""}`;
  if (timer.last_epoch === null) return "never ran";
  return null;
}

export function failing(repository: RepositorySummary): boolean {
  return repository_reasons(repository).some((reason) => reason.tone === "bad");
}
