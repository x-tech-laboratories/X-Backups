import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CollectResult, empty_state, type RepositoryState } from "./borg/types.ts";
import { Store } from "./store.ts";

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

  it("logs events newest first", () => {
    store.apply("odin", CollectResult.failed("first"), { poll: true, epoch: 1 });
    store.apply("thor", CollectResult.failed("second"), { poll: true, epoch: 2 });

    expect(store.events().map((event) => event.message)).toEqual(["second", "first"]);
    expect(store.events({ repository_id: "odin" })).toHaveLength(1);
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

  it("finds a detached action's job by its id", () => {
    const jobs = store.jobs_for("odin");
    jobs.create("diff_archive", "borg diff", null);

    expect(jobs.action_job("diff_archive")).not.toBeNull();
    expect(jobs.action_job("verify_restore")).toBeNull();
  });
});
