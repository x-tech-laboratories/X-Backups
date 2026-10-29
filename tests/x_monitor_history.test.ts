import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { Store } from "../src/server/store.ts";
import { group_polls, import_x_monitor_history } from "../src/server/x_monitor_history.ts";

// X-Monitor's metric table as peewee lays it out, with local timestamps.
function x_monitor(rows: [timestamp: string, metric: string, value: number][]): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE metric (id INTEGER PRIMARY KEY, timestamp TEXT, target TEXT, plugin_id TEXT, metric_name TEXT, value REAL, metadata TEXT)");
  const insert = database.prepare("INSERT INTO metric (timestamp, target, plugin_id, metric_name, value) VALUES (?, 'odin', 'backup-laptop', ?, ?)");
  for (const row of rows) insert.run(...row);
  return database;
}

const epoch = (local: string) => Math.floor(new Date(local).getTime() / 1000);

describe("X-Monitor history", () => {
  it("folds one collect's metrics into one poll and starts the next after a gap", () => {
    const polls = group_polls([
      { timestamp: "2026-10-01 03:00:00.100000", metric_name: "archive_count", value: 4 },
      { timestamp: "2026-10-01 03:00:01.200000", metric_name: "deduplicated_size", value: 1000 },
      { timestamp: "2026-10-01 03:00:01.300000", metric_name: "last_backup_epoch", value: 0 },
      { timestamp: "2026-10-01 04:00:00.000000", metric_name: "archive_count", value: 5 },
    ]);

    expect(polls.map((poll) => [poll.epoch, poll.archive_count, poll.deduplicated_size, poll.last_backup_epoch])).toEqual([
      [epoch("2026-10-01T03:00:00"), 4, 1000, null],
      [epoch("2026-10-01T04:00:00"), 5, null, null],
    ]);
  });

  it("writes only the polls older than the repository's first own poll, and nothing on a dry run", () => {
    const source = x_monitor([
      ["2026-10-01 03:00:00.000000", "archive_count", 4],
      ["2026-10-01 03:00:00.500000", "checks_ok", 1],
      ["2026-10-02 03:00:00.000000", "archive_count", 5],
      ["2026-10-03 03:00:00.000000", "archive_count", 6],
    ]);
    const store = new Store(":memory:");
    const target = (store as unknown as { database: DatabaseSync }).database;
    target.prepare("INSERT INTO polls (target_id, epoch, archive_count) VALUES ('odin', ?, 6)").run(epoch("2026-10-03T03:00:00"));
    const mapping = new Map([["backup-laptop", "odin"]]);

    expect(import_x_monitor_history(source, target, mapping, true)[0]).toMatchObject({ found: 3, written: 2 });
    expect(target.prepare("SELECT COUNT(*) AS count FROM polls").get()).toEqual({ count: 1 });

    import_x_monitor_history(source, target, mapping, false);
    expect(target.prepare("SELECT epoch, archive_count, checks_passed FROM polls ORDER BY epoch").all()).toEqual([
      { epoch: epoch("2026-10-01T03:00:00"), archive_count: 4, checks_passed: 1 },
      { epoch: epoch("2026-10-02T03:00:00"), archive_count: 5, checks_passed: null },
      { epoch: epoch("2026-10-03T03:00:00"), archive_count: 6, checks_passed: null },
    ]);
  });
});
