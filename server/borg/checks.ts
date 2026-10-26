// The restore canary verdict and the check units' journal, read and folded into one record per unit.

import { list_unavailable, shell_quote, split_lines_of } from "./shell.ts";
import type { CmdResult } from "./types.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface CheckState {
  ok?: number | null;
  end?: number | null;
  failed?: boolean;
  error?: string | null;
  // When a kind that has never run was first expected.
  since?: number;
}

export interface UnitFields {
  err: string[];
  values: Record<string, string>;
}

// ── Check kinds ──────────────────────────────────────────────────────────────

// systemd's own lines for a unit run; borgmatic also logs lines starting "Finished", so these are read from PID 1 only.
const unit_finished = "Finished ";
const unit_failed = "Failed with result";

// How far before a failure to look for its run when the run's start has left the journal.
const check_run_window = 86400;

// The checks this monitor runs itself, which check_kinds can hold to a maximum age.
export const TRACKED_CHECKS = ["repository", "archives", "data", "extract"] as const;

// Each Check kind, the `borg check` options it adds, and the tracked checks a success of it renews.
export const CHECK_KINDS: Record<string, { options: string[]; renews: string[] }> = {
  all: { options: [], renews: ["repository", "archives"] },
  repository: { options: ["--repository-only"], renews: ["repository"] },
  archives: { options: ["--archives-only"], renews: ["archives"] },
  data: { options: ["--verify-data"], renews: ["repository", "archives", "data"] },
  extract: { options: [], renews: ["extract"] },
};

// The job name a Check of this kind runs under, which is how its end knows what it covered.
export function check_job_kind(kind: string): string {
  return kind === "all" ? "check" : `check-${kind}`;
}

// The tracked checks a finished job renews, or none when it was not a Check.
export function covered_by_check_job(job_kind: string): string[] {
  if (job_kind === "check") return CHECK_KINDS.all.renews;
  const kind = job_kind.startsWith("check-") ? job_kind.slice("check-".length) : null;
  if (kind !== null && Object.hasOwn(CHECK_KINDS, kind)) return CHECK_KINDS[kind].renews;
  return [];
}

// ── Journal lines ────────────────────────────────────────────────────────────

// Reads the epoch off a journalctl `-o short-unix` line.
export function journal_epoch(line: string | null | undefined): number | null {
  const stamp = line ? line.split(" ", 1)[0] : "";
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(stamp.trim())) return null;
  return Math.trunc(Number(stamp));
}

// Strips the timestamp, host and process prefix off a journalctl line.
export function journal_message(line: string): string {
  const at = line.indexOf(": ");
  const message = at === -1 ? "" : line.slice(at + 2);
  return (message || line).trim().slice(0, 300);
}

// ── Restore canary ───────────────────────────────────────────────────────────

// True or false with a detail once the restore check reached a verdict, null with a reason when it could not run.
export function canary_verdict(extracted: CmdResult, live: CmdResult): [verdict: boolean | null, detail: string] {
  const detail = (extracted.stderr || extracted.stdout || "").trim();
  if (extracted.exit_code !== 0) {
    if (detail.includes("never matched")) {
      return [false, "the canary is not in the newest archive — is it inside the backup set?"];
    }
    if (list_unavailable(extracted.exit_code, detail)) {
      return [null, `could not extract the canary: ${detail.slice(0, 200)}`];
    }
    return [false, `extracting the canary failed (exit ${extracted.exit_code}): ${detail.slice(0, 200)}`];
  }
  if (live.exit_code !== 0) {
    return [false, `the live canary is unreadable: ${(live.stderr || live.stdout).trim().slice(0, 200)}`];
  }
  if (extracted.stdout.trim() !== live.stdout.trim()) return [false, "the restored canary differs from the live file"];
  return [true, "the restored canary matches the live file"];
}

// ── Check units ──────────────────────────────────────────────────────────────

// One brace group printing, per unit, its last success, last outcome, last start and any borgmatic command failures.
export function check_unit_script(units: string[]): string {
  const journal = "journalctl -o short-unix --no-pager -q";
  const parts: string[] = [];
  for (const unit of units) {
    const quoted = shell_quote(unit);
    parts.push(
      `echo "unit=${unit}"`,
      `echo "ok=$(${journal} -u ${quoted} _PID=1 -g '^${unit_finished}' -n 1 2>/dev/null | grep -v '^-- ' | tail -1)"`,
      `echo "end=$(${journal} -u ${quoted} _PID=1 -g '^${unit_finished}|${unit_failed}' -n 1 2>/dev/null | grep -v '^-- ' | tail -1)"`,
      `echo "start=$(${journal} -u ${quoted} _PID=1 -g '^Starting ' -n 1 2>/dev/null | grep -v '^-- ' | tail -1)"`,
      `${journal} -u ${quoted} -g 'returned non-zero exit status' -n 20 2>/dev/null | grep -v '^-- ' | sed 's/^/err=/'`,
    );
  }
  return "{ " + parts.join("; ") + "; }";
}

// Groups the check script's key=value lines by unit.
export function parse_check_units(stdout: string): Record<string, UnitFields> {
  const units: Record<string, UnitFields> = {};
  let current: UnitFields | null = null;
  for (const line of split_lines_of(stdout)) {
    const at = line.indexOf("=");
    if (at === -1) continue;
    const key = line.slice(0, at);
    const value = line.slice(at + 1).trim();
    if (key === "unit") {
      units[value] ??= { err: [], values: {} };
      current = units[value];
    } else if (current !== null && key === "err") {
      current.err.push(value);
    } else if (current !== null) {
      current.values[key] = value;
    }
  }
  return units;
}

// One unit's last success and outcome, where a failed run naming only other repositories counts as a success here.
export function observed_unit(fields: UnitFields, repo: string): CheckState {
  const ok = journal_epoch(fields.values.ok ?? "");
  const end_line = fields.values.end ?? "";
  const end = journal_epoch(end_line);
  const start = journal_epoch(fields.values.start ?? "");
  const state: CheckState = { ok, end, failed: false, error: null };
  if (end === null || !end_line.includes(unit_failed)) return state;

  const since = start !== null && start <= end ? start : end - check_run_window;
  const run_errors = fields.err.filter((line) => {
    const epoch = journal_epoch(line) || -1;
    return since <= epoch && epoch <= end;
  });
  const names_repo = new RegExp(String.raw`\s` + escape_regex(repo) + String.raw`(?:::\S*)?'`);
  const ours = run_errors.filter((line) => names_repo.test(line));
  if (run_errors.length > 0 && ours.length === 0) {
    state.ok = Math.max(ok || 0, end);
    return state;
  }
  state.failed = true;
  state.error = ours.length > 0 ? journal_message(ours[ours.length - 1]) : journal_message(end_line);
  return state;
}

// Folds this poll's reading into the stored one, so a rotated journal forgets nothing already seen.
export function merge_unit(stored: CheckState, seen: CheckState): CheckState {
  const merged: CheckState = { ...stored };
  const oks = [stored.ok, seen.ok].filter((value): value is number => Boolean(value));
  merged.ok = oks.length > 0 ? Math.max(...oks) : null;
  if ((seen.end || 0) >= (stored.end || 0)) {
    merged.end = seen.end ?? null;
    merged.failed = seen.failed ?? false;
    merged.error = seen.error ?? null;
  }
  return merged;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function escape_regex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}
