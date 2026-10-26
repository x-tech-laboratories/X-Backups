import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ActionPlan, CollectResult, cmd_result, type CmdResult } from "./borg/types.ts";
import type { Config } from "./config.ts";
import { Poller, type Run } from "./poller.ts";
import { Store } from "./store.ts";

const LIST = JSON.stringify({ archives: [{ name: "a1", time: "2026-10-01T10:00:00" }], repository: { location: "/srv/repo" } });

const CONFIG: Config = {
  repositories: [{ name: "odin", host: null, ssh_user: null, interval_in_seconds: 3600, borg: { repo: "/srv/repo", collect_stats: false } }],
};

let store: Store;
let poller: Poller;
let commands: string[];

function make(answer: (command: string) => CmdResult = () => cmd_result(0, LIST, "")): Poller {
  const run: Run = async (_target, command) => {
    commands.push(command);
    return answer(command);
  };
  return new Poller(CONFIG, store, run);
}

beforeEach(() => {
  store = new Store(":memory:");
  commands = [];
});

afterEach(() => {
  poller.stop();
  store.close();
});

// ── Polling ──────────────────────────────────────────────────────────────────

describe("polling", () => {
  it("keeps the poll's state in the repository and the store", async () => {
    poller = make();

    await poller.poll("odin");

    expect(poller.repositories.get("odin")!.repository.state.archives.map((archive) => archive.name)).toEqual(["a1"]);
    expect(store.load_state("odin")!.archive_count).toBe(1);
    expect(store.polls("odin")).toHaveLength(1);
  });

  it("shares a poll already waiting rather than starting a second", async () => {
    poller = make();

    const [first, second] = [poller.poll("odin"), poller.poll("odin")];

    expect(first).toBe(second);
    await first;
    expect(commands).toHaveLength(1);
  });

  it("reports a failing run as a failed poll", async () => {
    poller = make(() => {
      throw new Error("no ssh");
    });

    const result = await poller.poll("odin");

    expect(result.logs[0][0]).toContain("no ssh");
    expect(poller.repositories.get("odin")!.status).toBe("failed");
  });

  it("picks up the state kept before a restart", async () => {
    poller = make();
    const first = await poller.poll("odin");

    const restarted = make();

    expect(restarted.repositories.get("odin")!.repository.state.archive_count).toBe(1);
    expect(restarted.repositories.get("odin")!.status).toBe(first.status);
  });
});

// ── Actions ──────────────────────────────────────────────────────────────────

describe("actions", () => {
  it("runs the plan's commands and keeps what its reader reports", async () => {
    poller = make(() => cmd_result(0, "done", ""));
    const plan = new ActionPlan(["one", "two"], (results) => new CollectResult({ content: results.map((result) => result.stdout).join(), success: true }));

    const result = await poller.run_action("odin", plan);

    expect(commands).toEqual(["one", "two"]);
    expect(result.content).toBe("done,done");
    expect(store.polls("odin")).toHaveLength(0);
  });
});
