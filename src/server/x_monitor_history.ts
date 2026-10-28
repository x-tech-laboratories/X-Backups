// Copies the borg history X-Monitor kept into X-Backups' polls, so the history charts reach back before X-Backups ran.

import type { DatabaseSync } from "node:sqlite";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface ImportReport {
  monitor: string;
  repository_id: string;
  // Polls found in X-Monitor, and how many of them predate X-Backups' own first poll and were written.
  found: number;
  written: number;
  first_epoch: number | null;
  last_epoch: number | null;
}

type Poll = Record<(typeof columns)[number], number | null> & { epoch: number };

// X-Monitor's borg metric for each polls column X-Backups keeps.
const metric_columns: Record<string, (typeof columns)[number]> = {
  original_size: "original_size",
  compressed_size: "compressed_size",
  deduplicated_size: "deduplicated_size",
  total_chunks: "total_chunks",
  unique_chunks: "unique_chunks",
  archive_count: "archive_count",
  last_backup_epoch: "last_backup_epoch",
  canary_ok: "canary_ok",
  checks_ok: "checks_passed",
};

const columns = [
  "original_size", "compressed_size", "deduplicated_size", "total_chunks", "unique_chunks", "archive_count", "last_backup_epoch", "canary_ok", "checks_passed",
] as const;

// Metrics of one X-Monitor collect are written within moments of each other; a longer gap starts the next poll.
const same_poll_gap_in_seconds = 10;

// ── Import ───────────────────────────────────────────────────────────────────

// Writes each monitor's polls into its repository, only those older than the repository's first X-Backups poll; a dry run writes nothing.
export function import_x_monitor_history(source: DatabaseSync, target: DatabaseSync, mapping: Map<string, string>, dry_run: boolean): ImportReport[] {
  const read = source.prepare(`SELECT timestamp, metric_name, value FROM metric WHERE plugin_id = ? AND metric_name IN (${Object.keys(metric_columns).map(() => "?").join(", ")}) ORDER BY timestamp`);
  const first_own = target.prepare("SELECT MIN(epoch) AS epoch FROM polls WHERE repository_id = ?");
  const insert = target.prepare(
    `INSERT OR IGNORE INTO polls (repository_id, epoch, status, ${columns.join(", ")}) VALUES (?, ?, NULL, ${columns.map(() => "?").join(", ")})`,
  );

  const reports: ImportReport[] = [];
  for (const [monitor, repository_id] of mapping) {
    const rows = read.all(monitor, ...Object.keys(metric_columns)) as { timestamp: string; metric_name: string; value: number }[];
    const polls = group_polls(rows);
    const own = (first_own.get(repository_id) as { epoch: number | null }).epoch;
    const older = polls.filter((poll) => own === null || poll.epoch < own);
    if (!dry_run) {
      target.exec("BEGIN");
      try {
        for (const poll of older) insert.run(repository_id, poll.epoch, ...columns.map((column) => poll[column]));
        target.exec("COMMIT");
      } catch (error) {
        target.exec("ROLLBACK");
        throw error;
      }
    }
    reports.push({
      monitor, repository_id, found: polls.length, written: older.length,
      first_epoch: older[0]?.epoch ?? null, last_epoch: older.at(-1)?.epoch ?? null,
    });
  }
  return reports;
}

// Folds metric rows into polls: a row joins the current poll unless it comes too long after it or repeats a metric the poll already has.
export function group_polls(rows: { timestamp: string; metric_name: string; value: number }[]): Poll[] {
  const polls: Poll[] = [];
  let current: Poll | null = null;
  for (const row of rows) {
    const epoch = local_timestamp_to_epoch(row.timestamp);
    const column = metric_columns[row.metric_name];
    if (column === undefined || Number.isNaN(epoch)) continue;
    if (current === null || epoch - current.epoch > same_poll_gap_in_seconds || current[column] !== null) {
      current = { epoch, ...Object.fromEntries(columns.map((name) => [name, null])) } as Poll;
      polls.push(current);
    }
    // X-Monitor records a repository that has no archive yet as a newest archive at epoch 0.
    current[column] = column === "last_backup_epoch" && row.value === 0 ? null : Math.round(row.value);
  }
  return polls;
}

// X-Monitor writes local time without a zone, such as "2026-09-27 21:48:49.659353", so it is read in this machine's zone.
function local_timestamp_to_epoch(timestamp: string): number {
  return Math.floor(new Date(timestamp.replace(" ", "T").slice(0, 23)).getTime() / 1000);
}
