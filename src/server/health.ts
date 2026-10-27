// How healthy each repository is and why, rolled up into one level for X-Monitor and the page.

import { format_age, format_duration } from "./borg/durations.ts";
import type { Watched } from "./poller.ts";

// ── Levels ───────────────────────────────────────────────────────────────────

export type Level = "ok" | "warning" | "critical";

export interface Reason {
  level: "warning" | "critical";
  text: string;
}

const level_rank: Record<Level, number> = { ok: 0, warning: 1, critical: 2 };

// The worst level among the reasons, or ok when there are none.
export function worst_level(levels: Level[]): Level {
  return levels.reduce<Level>((worst, level) => level_rank[level] > level_rank[worst] ? level : worst, "ok");
}

// ── Reasons ──────────────────────────────────────────────────────────────────

export function overdue(watched: Watched, now = now_seconds()): boolean {
  const epoch = watched.repository.state.last_backup_epoch;
  return !epoch || now - epoch > watched.repository.max_age;
}

export function repository_reasons(watched: Watched, now = now_seconds()): Reason[] {
  const repository = watched.repository;
  const state = repository.state;
  const reasons: Reason[] = [];
  if (watched.status === "unavailable") reasons.push({ level: "warning", text: "the repository could not be reached" });
  if (watched.status === null) reasons.push({ level: "warning", text: "not polled yet" });
  if (state.last_poll_epoch !== null && overdue(watched, now)) {
    reasons.push({
      level: "critical",
      text: state.last_backup_epoch
        ? `last backup ${format_age(now - Math.trunc(state.last_backup_epoch))}, limit ${format_duration(repository.max_age)}`
        : "no backup yet",
    });
  } else if (state.last_backup_epoch && aged(now - state.last_backup_epoch, repository.warn_age)) {
    reasons.push({ level: "warning", text: `last backup ${format_age(now - Math.trunc(state.last_backup_epoch))}, warning at ${format_duration(repository.warn_age)}` });
  }
  if (state.checks?.passed === false) {
    reasons.push({ level: "critical", text: "a check failed or is overdue" });
  } else if (state.checks?.oldest_ok_epoch && aged(now - state.checks.oldest_ok_epoch, repository.check_warn_age)) {
    reasons.push({ level: "warning", text: `oldest check passed ${format_age(now - Math.trunc(state.checks.oldest_ok_epoch))}, warning at ${format_duration(repository.check_warn_age)}` });
  }
  if (state.canary?.ok === false) {
    reasons.push({ level: "critical", text: "the restore canary failed" });
  } else if (repository.canary_path && state.canary) {
    const since = now - Math.trunc(state.canary.checked_epoch);
    if (aged(since, repository.canary_max_age)) {
      reasons.push({ level: "critical", text: `restore canary last ran ${format_age(since)}, limit ${format_duration(repository.canary_max_age)}` });
    } else if (aged(since, repository.canary_warn_age)) {
      reasons.push({ level: "warning", text: `restore canary last ran ${format_age(since)}, warning at ${format_duration(repository.canary_warn_age)}` });
    }
  }
  // A failed poll the reasons above do not explain is named on its own, pointing at the events that say why.
  if (watched.status === "failed" && !reasons.some((reason) => reason.level === "critical")) {
    reasons.push({ level: "critical", text: "the last poll failed; its events say why" });
  }
  return reasons;
}

// Whether an age is past a limit that is set; a limit of zero is off.
function aged(age: number, limit: number): boolean {
  return limit > 0 && age > limit;
}

// ── Roll-up ──────────────────────────────────────────────────────────────────

export function repository_health(watched: Watched, now = now_seconds()) {
  const reasons = repository_reasons(watched, now);
  return { level: worst_level(reasons.map((reason) => reason.level)), reasons };
}

// The overall level and each repository's, so X-Monitor can alert on the one top field.
export function health(repositories: Watched[], now = now_seconds()) {
  const rows = repositories.map((watched) => ({ id: watched.repository.id, poll: watched.status, ...repository_health(watched, now) }));
  return { status: worst_level(rows.map((row) => row.level)), repositories: rows };
}

function now_seconds(): number {
  return Math.floor(Date.now() / 1000);
}
