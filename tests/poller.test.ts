import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ActionPlan, CollectResult, cmd_result, type CmdResult } from "../src/server/borg/types.ts";
import { parse_config, type Config } from "../src/server/config.ts";
import { host_health_command } from "../src/server/host_health.ts";
import { Poller, type Run } from "../src/server/poller.ts";
import { Store } from "../src/server/store.ts";

const LIST = JSON.stringify({ archives: [{ name: "a1", time: "2026-10-01T10:00:00" }], repository: { location: "/srv/repo" } });

const CONFIG: Config = {
  repositories: [{ name: "odin", host: null, ssh_user: null, interval_in_seconds: 3600, borg: { repo: "/srv/repo", collect_stats: false }, source: "declared" }],
};

let store: Store;
let poller: Poller;
let commands: string[];

// Reads of the host and the repository's filesystem rather than borg calls: the timers, the host's load, and df.
function host_read(command: string): boolean {
  return command.startsWith("systemctl") || command === host_health_command() || command.startsWith("df ");
}

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

// ── Config changes ───────────────────────────────────────────────────────────

describe("config changes", () => {
  it("adds, replaces and drops repositories without a restart", async () => {
    poller = make();
    poller.start();
    await poller.poll("odin");

    const thor = { name: "thor", host: null, ssh_user: null, interval_in_seconds: 60, borg: { repo: "/srv/thor", collect_stats: false }, source: "page" as const };
    poller.apply_config({ repositories: [CONFIG.repositories[0], thor] });
    const odin = poller.repositories.get("odin");
    await poller.poll("thor");

    expect([...poller.repositories.keys()]).toEqual(["odin", "thor"]);
    expect(poller.repositories.get("thor")!.repository.state.archive_count).toBe(1);

    poller.apply_config({ repositories: [{ ...CONFIG.repositories[0], borg: { ...CONFIG.repositories[0].borg, max_age: "3d" } }] });

    expect([...poller.repositories.keys()]).toEqual(["odin"]);
    expect(poller.repositories.get("odin")).not.toBe(odin);
    expect(poller.repositories.get("odin")!.repository.max_age).toBe(3 * 86400);
    // The replacement starts from the stored state rather than empty.
    expect(poller.repositories.get("odin")!.repository.state.archive_count).toBe(1);
  });
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
    expect(commands.filter((command) => !host_read(command))).toHaveLength(1);
  });

  it("hands the passphrase to the runner as stdin", async () => {
    const stdins: (string | undefined)[] = [];
    const config: Config = { repositories: [{ ...CONFIG.repositories[0], borg: { ...CONFIG.repositories[0].borg, passphrase: "s3cret" } }] };
    poller = new Poller(config, store, async (_target, command, options) => {
      if (!host_read(command)) stdins.push(options.stdin);
      return cmd_result(0, LIST, "");
    });

    await poller.poll("odin");

    expect(stdins).toEqual(["s3cret\n"]);
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

describe("timers", () => {
  it("reads the host's backup timers once however often it polls", async () => {
    const timers = '[{"next": 2000000000, "last": 1000000000, "unit": "borgbackup-job-home.timer", "activates": "borgbackup-job-home.service"}]' +
      "\n===XBACKUPS_SERVICES===\nId=borgbackup-job-home.service\nResult=success\nExecMainStatus=0\n";
    poller = make((command) => cmd_result(0, command.startsWith("systemctl") ? timers : LIST, ""));

    await poller.poll("odin");
    await poller.poll("odin");

    expect(store.timers()).toMatchObject([{ host: "local", unit: "borgbackup-job-home.timer", next_epoch: 2000, last_epoch: 1000, result: "success" }]);
    expect(commands.filter((command) => command.startsWith("systemctl"))).toHaveLength(1);
  });
});

describe("runs", () => {
  it("polls the repository again at once when a run ends", async () => {
    const ended = "===XBACKUPS_SIZE===\n0\n===XBACKUPS_EXIT===\n0\n===XBACKUPS_ALIVE===\n0\n===XBACKUPS_OUT===\n";
    poller = make((command) => cmd_result(0, command.includes("kill -0") ? ended : LIST, ""));
    const runs = store.runs_for({ target_id: "odin", host: "local", job: "odin", repository: "odin" });
    const run_id = runs.create("backup", "borg create", "/tmp/w");
    runs.set_pid(run_id, 42);

    await poller.poll("odin");
    await poller.poll("odin");

    expect(store.run_row(run_id)!.state).toBe("succeeded");
    expect(commands.filter((command) => command.includes("kill -0"))).toHaveLength(1);
    expect(store.polls("odin")).toHaveLength(1);
  });
});

// ── Targets ──────────────────────────────────────────────────────────────────

describe("targets", () => {
  it("keeps each target's rows beside its entities, and its host's timers under the host's name", async () => {
    const config = parse_config(JSON.stringify({
      hosts: [{ name: "odin", address: "odin.technet" }],
      repositories: [{ name: "disk", host: "odin", repo: "/srv/borg" }],
      sources: [{ name: "home", host: "odin", source_paths: ["/home"] }],
      jobs: [{ name: "nightly", sources: ["home"], repositories: ["disk"] }],
    }), "test.json");
    const timers = '[{"next": 2000000000, "last": 1000000000, "unit": "borgbackup-job-home.timer", "activates": "borgbackup-job-home.service"}]' +
      "\n===XBACKUPS_SERVICES===\nId=borgbackup-job-home.service\nResult=success\nExecMainStatus=0\n";
    // The listing fails, so the poll keeps an event to find.
    poller = new Poller(config, store, async (_target, command) =>
      command.startsWith("systemctl") ? cmd_result(0, timers, "") : cmd_result(2, "", "Connection refused"));

    await poller.poll("nightly:odin:disk");

    expect(store.events({ job: "nightly" }).length).toBeGreaterThan(0);
    expect(store.events({ repository: "disk" }).every((event) => event.target_id === "nightly:odin:disk" && event.host === "odin")).toBe(true);
    expect(store.timers().map((timer) => timer.host)).toEqual(["odin"]);
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
