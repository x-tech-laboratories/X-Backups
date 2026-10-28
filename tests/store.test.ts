import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CollectResult, empty_state, type RepositoryState } from "../src/server/borg/types.ts";
import { Store } from "../src/server/store.ts";

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

// ── State and history ────────────────────────────────────────────────────────

describe("state and history", () => {
  it("keeps the latest state", () => {
    store.apply("odin", new CollectResult({ state: state_with({ archive_count: 3 }) }), { poll: true });
    store.apply("odin", new CollectResult({ state: state_with({ archive_count: 4 }) }), { poll: true });

    expect(store.load_state("odin")!.archive_count).toBe(4);
    expect(store.load_state("thor")).toBeNull();
  });

  it("adds one history row per repository poll and none per job poll or action", () => {
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
    expect(store.events({ repository_id: "odin" })).toHaveLength(1);
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

// ── Jobs ─────────────────────────────────────────────────────────────────────

describe("jobs", () => {
  it("follows a job from start to finish", () => {
    const jobs = store.jobs_for("odin");
    const job_id = jobs.create("backup", "borg create", "/tmp/w");
    jobs.set_pid(job_id, 42);
    jobs.append_output(job_id, ["one", "two"]);
    jobs.append_output(job_id, ["three"]);

    expect(jobs.running()!.pid).toBe(42);
    expect(store.jobs_for("thor").running()).toBeNull();
    expect(store.job_output(job_id, 1)).toEqual(["two", "three"]);

    jobs.finish(job_id, "succeeded", { exit_code: 0 });

    expect(jobs.running()).toBeNull();
    expect(store.job(job_id)).toMatchObject({ state: "succeeded", exit_code: 0, repository_id: "odin" });
    expect(store.job(job_id)!.ended_epoch).not.toBeNull();
  });

  it("narrows the job list by repository, kind, state and start, a page at a time", () => {
    const odin = store.jobs_for("odin");
    const check = odin.create("check-data", "borg check", null);
    odin.finish(check, "failed", { exit_code: 2 });
    odin.create("backup", "borg create", null);
    store.jobs_for("thor").create("check", "borg check", null);

    expect(store.jobs({ kind: "check" }).map((job) => job.kind)).toEqual(["check", "check-data"]);
    expect(store.jobs({ repository_id: "odin", state: "failed" }).map((job) => job.id)).toEqual([check]);
    expect(store.jobs({ limit: 1, offset: 1 }).map((job) => job.kind)).toEqual(["backup"]);
    expect(store.jobs({ since_epoch: Date.now() / 1000 + 60 })).toEqual([]);
  });

  it("tells listeners what changed", () => {
    const changes: unknown[] = [];
    store.changes.on("change", (change) => changes.push(change));
    const job_id = store.jobs_for("odin").create("backup", "borg create", null);
    store.apply("odin", new CollectResult({ logs: [["Backup started", "INFO"]] }), { poll: false });
    store.replace_timers("odin.example.org", []);

    expect(changes).toEqual([
      { kind: "job", repository_id: "odin", job_id },
      { kind: "repository", repository_id: "odin" },
      { kind: "timers", repository_id: null },
    ]);
  });

  it("finds a detached action's job by its id", () => {
    const jobs = store.jobs_for("odin");
    jobs.create("diff_archive", "borg diff", null);

    expect(jobs.action_job("diff_archive")).not.toBeNull();
    expect(jobs.action_job("verify_restore")).toBeNull();
  });
});
