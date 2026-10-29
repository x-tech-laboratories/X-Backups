import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CollectResult, empty_state, type RepositoryState } from "../src/server/borg/types.ts";
import { Store, type TargetKey } from "../src/server/store.ts";

let store: Store;

beforeEach(() => {
  store = new Store(":memory:");
});

afterEach(() => {
  store.close();
});

function state_with(fields: Partial<RepositoryState>): RepositoryState {
  return { ...empty_state(), ...fields };
}

const odin: TargetKey = { target_id: "odin", host: "local", job: "odin", repository: "odin" };
const thor: TargetKey = { target_id: "thor", host: "local", job: "thor", repository: "thor" };

// ── State and history ────────────────────────────────────────────────────────

describe("state and history", () => {
  it("keeps the latest state", () => {
    store.apply("odin", new CollectResult({ state: state_with({ archive_count: 3 }) }), { poll: true });
    store.apply("odin", new CollectResult({ state: state_with({ archive_count: 4 }) }), { poll: true });

    expect(store.load_state("odin")!.archive_count).toBe(4);
    expect(store.load_state("thor")).toBeNull();
  });

  it("adds one history row per repository poll and none per run poll or action", () => {
    const stats = { original_size: 300, compressed_size: 200, deduplicated_size: 100, total_chunks: 9, unique_chunks: 5 };
    const state = state_with({ stats, archive_count: 2, canary: { ok: true, checked_epoch: 5, detail: "" } });
    store.apply("odin", new CollectResult({ state, status: "online" }), { poll: true, epoch: 100 });
    store.apply("odin", new CollectResult({ state, status: "warning" }), { poll: true, epoch: 200 });
    store.apply("odin", new CollectResult({ logs: [["Backup running", "INFO"]] }), { poll: true, epoch: 250 });
    store.apply("odin", new CollectResult({ state }), { poll: false, epoch: 300 });

    const polls = store.polls("odin");
    expect(polls.map((poll) => poll.epoch)).toEqual([100, 200]);
    expect(polls[1]).toMatchObject({ status: "warning", deduplicated_size: 100, archive_count: 2, canary_ok: true, checks_passed: null });
    expect(store.polls("odin", 150)).toHaveLength(1);
  });

  it("keeps every archive ever listed", () => {
    const first = state_with({ archives: [{ name: "a1", epoch: 10, deduplicated: 7 }] });
    const second = state_with({ archives: [{ name: "a2", epoch: 20 }, { name: "a1", epoch: 10 }] });
    store.apply("odin", new CollectResult({ state: first }), { poll: true, epoch: 1 });
    store.apply("odin", new CollectResult({ state: second }), { poll: true, epoch: 2 });

    const archives = store.archives("odin");
    expect(archives.map((archive) => archive.name)).toEqual(["a2", "a1"]);
    expect(archives[1].deduplicated_size).toBe(7);
  });

  it("narrows events by level, a page at a time", () => {
    store.apply("odin", new CollectResult({ logs: [["one", "INFO"], ["two", "ERROR"], ["three", "ERROR"]] }), { poll: false });

    expect(store.events({ level: "ERROR" }).map((event) => event.message)).toEqual(["three", "two"]);
    expect(store.events({ level: "ERROR", limit: 1, offset: 1 }).map((event) => event.message)).toEqual(["two"]);
  });

  it("logs events newest first, leaving out a poll's routine lines", () => {
    store.apply("odin", CollectResult.failed("first"), { poll: true, epoch: 1 });
    store.apply("thor", CollectResult.failed("second"), { poll: true, epoch: 2 });
    store.apply("thor", new CollectResult({ logs: [["Listed 3 archives", "INFO"]], status: "online" }), { poll: true, epoch: 3 });

    expect(store.events().map((event) => event.message)).toEqual(["second", "first"]);
    expect(store.events({ target_id: "odin" })).toHaveLength(1);
  });
});

// ── Timers ───────────────────────────────────────────────────────────────────

describe("timers", () => {
  const timer = { unit: "borgmatic.timer", service: "borgmatic.service", result: "success", exit_status: 0, upcoming: [] as number[] };

  it("keeps each run once, with the result of its latest read", () => {
    store.replace_timers("odin", [{ ...timer, last_epoch: 1000, next_epoch: 90_000, result: null }], 1000);
    store.replace_timers("odin", [{ ...timer, last_epoch: 1000, next_epoch: 90_000, result: "exit-code", exit_status: 2 }], 1300);

    expect(store.timer_runs(0)).toEqual([{ host: "odin", unit: "borgmatic.timer", epoch: 1000, result: "exit-code", exit_status: 2 }]);
  });

  it("marks the elapse a read expected as missed when systemd moved past it without a run", () => {
    store.replace_timers("odin", [{ ...timer, last_epoch: 1000, next_epoch: 5000 }], 1000);
    store.replace_timers("odin", [{ ...timer, last_epoch: 1000, next_epoch: 90_000 }], 5300);

    expect(store.timer_runs(2000)).toEqual([{ host: "odin", unit: "borgmatic.timer", epoch: 5000, result: "missed", exit_status: null }]);
  });

  it("does not mark an elapse missed when the timer ran at it or is still waiting on it", () => {
    store.replace_timers("odin", [{ ...timer, last_epoch: 1000, next_epoch: 5000 }], 1000);
    store.replace_timers("odin", [{ ...timer, last_epoch: 1000, next_epoch: 5000 }], 5300);
    store.replace_timers("odin", [{ ...timer, last_epoch: 5010, next_epoch: 90_000 }], 5600);

    expect(store.timer_runs(2000).map((run) => run.result)).toEqual(["success"]);
  });

  it("returns each timer's upcoming elapses from its latest read", () => {
    store.replace_timers("odin", [{ ...timer, last_epoch: null, next_epoch: 5000, upcoming: [5000, 9000] }], 1000);
    store.replace_timers("odin", [{ ...timer, last_epoch: null, next_epoch: 9000, upcoming: [9000] }], 6000);

    expect(store.timers().map((row) => row.upcoming)).toEqual([[9000]]);
  });
});

// ── Runs ─────────────────────────────────────────────────────────────────────

describe("runs", () => {
  it("follows a run from start to finish, keeping its target's entities beside it", () => {
    const runs = store.runs_for({ target_id: "web:odin:vault", host: "odin", job: "web", repository: "vault" });
    const run_id = runs.create("backup", "borg create");
    runs.append_output(run_id, ["one", "two"]);
    runs.append_output(run_id, ["three"]);

    expect(runs.running()!.agent_run).toMatch(new RegExp(`^run-${run_id}-\\d+$`));
    expect(store.runs_for(thor).running()).toBeNull();
    expect(store.run_output(run_id, 1)).toEqual(["two", "three"]);

    runs.finish(run_id, "succeeded", { exit_code: 0 });

    expect(runs.running()).toBeNull();
    expect(store.run_row(run_id)).toMatchObject({
      state: "succeeded", exit_code: 0, target_id: "web:odin:vault", host: "odin", job: "web", repository: "vault", task: null,
    });
    expect(store.run_row(run_id)!.ended_epoch).not.toBeNull();
  });

  it("narrows the run list by target, entity, kind, state and start, a page at a time", () => {
    const runs = store.runs_for(odin);
    const check = runs.create("check-data", "borg check");
    runs.finish(check, "failed", { exit_code: 2 });
    runs.create("backup", "borg create");
    store.runs_for({ ...thor, repository: "vault" }).create("check", "borg check");

    expect(store.runs({ kind: "check" }).map((run) => run.kind)).toEqual(["check", "check-data"]);
    expect(store.runs({ target_id: "odin", state: "failed" }).map((run) => run.id)).toEqual([check]);
    expect(store.runs({ repository: "vault" }).map((run) => run.target_id)).toEqual(["thor"]);
    expect(store.runs({ limit: 1, offset: 1 }).map((run) => run.kind)).toEqual(["backup"]);
    expect(store.runs({ since_epoch: Date.now() / 1000 + 60 })).toEqual([]);
  });

  it("matches a grant on a target's id or its repository's name", () => {
    store.runs_for(odin).create("backup", "borg create");
    store.runs_for({ target_id: "web:thor:vault", host: "thor", job: "web", repository: "vault" }).create("backup", "borg create");

    expect(store.runs({ granted: ["vault"] }).map((run) => run.target_id)).toEqual(["web:thor:vault"]);
    expect(store.runs({ granted: ["odin"] }).map((run) => run.target_id)).toEqual(["odin"]);
    expect(store.runs({ granted: [] })).toEqual([]);
  });

  it("tells listeners what changed", () => {
    const changes: unknown[] = [];
    store.changes.on("change", (change) => changes.push(change));
    const run_id = store.runs_for(odin).create("backup", "borg create");
    store.apply("odin", new CollectResult({ logs: [["Backup started", "INFO"]] }), { poll: false });
    store.replace_timers("odin.example.org", []);

    expect(changes).toEqual([
      { kind: "run", target_id: "odin", run_id },
      { kind: "repository", target_id: "odin" },
      { kind: "timers", target_id: null },
    ]);
  });

  it("finds a detached action's run by its id", () => {
    const runs = store.runs_for(odin);
    runs.create("diff_archive", "borg diff");

    expect(runs.action_run("diff_archive")).not.toBeNull();
    expect(runs.action_run("verify_restore")).toBeNull();
  });
});

// ── Migration ────────────────────────────────────────────────────────────────

describe("migration", () => {
  let folder: string;

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "x-backups-store-"));
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  // A database as it was kept before targets and runs, with a row in each table keyed by repository.
  function old_database(path: string): void {
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE repository_states (repository_id TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE polls (repository_id TEXT NOT NULL, epoch INTEGER NOT NULL, status TEXT, original_size INTEGER, compressed_size INTEGER,
        deduplicated_size INTEGER, total_chunks INTEGER, unique_chunks INTEGER, archive_count INTEGER, last_backup_epoch INTEGER,
        canary_ok INTEGER, checks_passed INTEGER, PRIMARY KEY (repository_id, epoch));
      CREATE TABLE archives (repository_id TEXT NOT NULL, name TEXT NOT NULL, epoch INTEGER NOT NULL, original_size INTEGER,
        compressed_size INTEGER, deduplicated_size INTEGER, file_count INTEGER, PRIMARY KEY (repository_id, name));
      CREATE TABLE events (id INTEGER PRIMARY KEY, repository_id TEXT NOT NULL, epoch INTEGER NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL);
      CREATE TABLE jobs (id INTEGER PRIMARY KEY, repository_id TEXT NOT NULL, kind TEXT NOT NULL, command TEXT NOT NULL, workdir TEXT, pid INTEGER,
        state TEXT NOT NULL, progress TEXT, output_seq INTEGER NOT NULL DEFAULT 0, exit_code INTEGER, error TEXT, started_epoch INTEGER NOT NULL,
        ended_epoch INTEGER);
      CREATE TABLE job_output (job_id INTEGER NOT NULL, line_number INTEGER NOT NULL, line TEXT NOT NULL, PRIMARY KEY (job_id, line_number));
      CREATE TABLE timers (host TEXT NOT NULL, unit TEXT NOT NULL, service TEXT NOT NULL, next_epoch INTEGER, last_epoch INTEGER, result TEXT,
        exit_status INTEGER, read_epoch INTEGER NOT NULL, PRIMARY KEY (host, unit));
      CREATE INDEX events_by_repository ON events (repository_id, id);
      CREATE INDEX jobs_by_repository ON jobs (repository_id, id);
      INSERT INTO polls (repository_id, epoch, status, archive_count) VALUES ('odin', 100, 'online', 3);
      INSERT INTO archives (repository_id, name, epoch) VALUES ('odin', 'odin-2026-10-01T03:00:00', 90);
      INSERT INTO events (repository_id, epoch, level, message) VALUES ('odin', 100, 'INFO', 'Backup started');
      INSERT INTO jobs (repository_id, kind, command, state, started_epoch) VALUES ('odin', 'backup', 'borg create', 'succeeded', 100);
      INSERT INTO jobs (repository_id, kind, command, workdir, pid, state, started_epoch) VALUES ('odin', 'prune', 'borg prune', '/w', 7, 'running', 200);
      INSERT INTO job_output VALUES (1, 0, 'done');
      INSERT INTO timers VALUES ('odin.lan', 'borgmatic.timer', 'borgmatic.service', NULL, 50, 'success', 0, 60);
      INSERT INTO timers VALUES ('local', 'borgmatic.timer', 'borgmatic.service', NULL, 50, 'success', 0, 60);
    `);
    database.prepare("INSERT INTO repository_states VALUES ('odin', ?)").run(JSON.stringify(state_with({ archive_count: 3 })));
    database.close();
  }

  it("keeps every row, moving it to the target its flat entry expands into, and changes nothing when run again", () => {
    const path = join(folder, "x-backups.sqlite");
    old_database(path);
    const hosts = [{ name: "odin", kind: "managed", address: "odin.lan" }, { name: "server", kind: "managed", address: null }];

    for (let opening = 0; opening < 2; opening++) {
      const reopened = new Store(path);
      reopened.adopt_targets([{ target_id: "odin", host: "odin", job: "odin", repository: "odin" }], hosts);

      expect(reopened.load_state("odin")!.archive_count).toBe(3);
      expect(reopened.polls("odin").map((poll) => poll.archive_count)).toEqual([3]);
      expect(reopened.archives("odin").map((archive) => archive.name)).toEqual(["odin-2026-10-01T03:00:00"]);
      expect(reopened.events({ repository: "odin" })).toMatchObject([{ target_id: "odin", host: "odin", job: "odin", message: "Backup started" }]);
      expect(reopened.runs({ job: "odin" })).toMatchObject([
        { id: 2, kind: "prune", state: "failed", agent_run: null, error: expect.stringMatching(/^Lost: it was started over SSH/) },
        { id: 1, target_id: "odin", repository: "odin", task: null, kind: "backup", state: "succeeded" },
      ]);
      expect(reopened.runs({ job: "odin" })[0]).not.toHaveProperty("pid");
      expect(reopened.run_output(1)).toEqual(["done"]);
      expect(reopened.timers().map((timer) => timer.host)).toEqual(["odin", "server"]);
      reopened.close();
    }
  });

  it("names new rows after the adopted target, leaving an unknown target's names empty", () => {
    store.adopt_targets([{ target_id: "web:odin:vault", host: "odin", job: "web", repository: "vault" }]);
    store.apply("web:odin:vault", CollectResult.failed("unreachable"), { poll: true });
    store.apply("gone", CollectResult.failed("unreachable"), { poll: true });

    expect(store.events().map((event) => [event.target_id, event.repository])).toEqual([["gone", null], ["web:odin:vault", "vault"]]);
  });
});
