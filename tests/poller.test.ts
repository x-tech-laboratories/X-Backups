import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentError } from "../src/server/agents/agent.ts";
import { AgentHub, type AgentStatus } from "../src/server/agents/hub.ts";
import { AgentTokens } from "../src/server/agents/tokens.ts";
import { WAITING_FOR_AGENT } from "../src/server/borg/repository.ts";
import { ActionPlan, CollectResult, LongRunPlan, cmd_result, type CmdResult } from "../src/server/borg/types.ts";
import { parse_config, type Config } from "../src/server/config.ts";
import { Poller, type Run } from "../src/server/poller.ts";
import { Store } from "../src/server/store.ts";
import { timers_command } from "../src/server/timers.ts";
import { FakeAgent, SAMPLE, poll_of } from "./agents/fake_agent.ts";

const LIST = JSON.stringify({ archives: [{ name: "a1", time: "2026-10-01T10:00:00" }], repository: { location: "/srv/repo" } });

const CONFIG: Config = {
  repositories: [{ name: "odin", host: null, interval_in_seconds: 3600, borg: { repo: "/srv/repo", collect_stats: false, source_paths: ["/etc"] }, source: "declared" }],
};

let store: Store;
let hub: AgentHub;
let agent: FakeAgent;
let poller: Poller;
let commands: string[];

function make(answer: (command: string) => CmdResult = () => cmd_result(0, LIST, ""), config: Config = CONFIG): Poller {
  const run: Run = async (_host, command) => {
    commands.push(command);
    return answer(command);
  };
  return new Poller(config, store, hub, run);
}

// Reads of the host and the repository's filesystem rather than borg calls: the timers and df.
function host_read(command: string): boolean {
  return command === timers_command() || command.startsWith("df ");
}

beforeEach(() => {
  store = new Store(":memory:");
  agent = new FakeAgent();
  hub = new AgentHub(new AgentTokens(store), { local: { host: "local", agent } });
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

    const thor = { name: "thor", host: null, interval_in_seconds: 60, borg: { repo: "/srv/thor", collect_stats: false }, source: "page" as const };
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

  it("has the built-in agent answer for the host with no address", () => {
    const config = parse_config(JSON.stringify({
      hosts: [{ name: "server" }, { name: "odin", address: "odin.technet" }],
      repositories: [{ name: "disk", host: "server", repo: "/srv/borg" }],
    }), "test.json");
    poller = make(undefined, config);

    expect(hub.is_connected("server")).toBe(true);
    expect(hub.is_connected("local")).toBe(false);
    expect(hub.is_connected("odin")).toBe(false);
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

  it("runs the target's commands on its host, handing the passphrase over as stdin", async () => {
    const calls: { host: string; stdin: string | null | undefined }[] = [];
    const config: Config = { repositories: [{ ...CONFIG.repositories[0], borg: { ...CONFIG.repositories[0].borg, passphrase: "s3cret" } }] };
    poller = new Poller(config, store, hub, async (host, command, options) => {
      if (!host_read(command)) calls.push({ host, stdin: options.stdin });
      return cmd_result(0, LIST, "");
    });

    await poller.poll("odin");

    expect(calls).toEqual([{ host: "local", stdin: "s3cret\n" }]);
  });

  it("reports a failing run as a failed poll", async () => {
    poller = make(() => {
      throw new Error("no agent");
    });

    const result = await poller.poll("odin");

    expect(result.logs[0][0]).toContain("no agent");
    expect(poller.repositories.get("odin")!.status).toBe("failed");
  });

  it("picks up the state kept before a restart", async () => {
    poller = make();
    const first = await poller.poll("odin");

    const restarted = make();

    expect(restarted.repositories.get("odin")!.repository.state.archive_count).toBe(1);
    expect(restarted.repositories.get("odin")!.status).toBe(first.status);
  });

  it("keeps a reading of the host's health from its agent", async () => {
    poller = make();

    await poller.poll("odin");

    expect(store.host_samples(0)).toMatchObject([{ host: "local", ...SAMPLE }]);
  });
});

describe("timers", () => {
  it("reads the host's backup timers once however often it polls", async () => {
    const timers = '[{"next": 2000000000, "last": 1000000000, "unit": "borgbackup-job-home.timer", "activates": "borgbackup-job-home.service"}]' +
      "\n===XBACKUPS_SERVICES===\nId=borgbackup-job-home.service\nResult=success\nExecMainStatus=0\n";
    poller = make((command) => cmd_result(0, command === timers_command() ? timers : LIST, ""));

    await poller.poll("odin");
    await poller.poll("odin");

    expect(store.timers()).toMatchObject([{ host: "local", unit: "borgbackup-job-home.timer", next_epoch: 2000, last_epoch: 1000, result: "success" }]);
    expect(commands.filter((command) => command === timers_command())).toHaveLength(1);
  });

  it("asks again next poll when the host's agent was away", async () => {
    let away = true;
    poller = make((command) => command === timers_command() && away ? cmd_result(-1, "", "No agent is connected for local.") : cmd_result(0, LIST, ""));

    await poller.poll("odin");
    away = false;
    await poller.poll("odin");

    expect(commands.filter((command) => command === timers_command())).toHaveLength(2);
  });
});

// ── Long runs ────────────────────────────────────────────────────────────────

describe("long runs", () => {
  function backup(): LongRunPlan {
    const plan = poller.repositories.get("odin")!.repository.run_backup();
    expect(plan).toBeInstanceOf(LongRunPlan);
    return plan as LongRunPlan;
  }

  function keyed_runs(host = "local") {
    return store.runs_for({ target_id: "odin", host, job: "odin", repository: "odin" });
  }

  it("starts a run on the host's agent under its record's id, follows it to its end, then forgets it", async () => {
    poller = make();

    const started = await poller.run_action("odin", backup());
    const run = store.runs({ target_id: "odin" })[0];
    expect(started.success).toBe(true);
    expect(agent.started).toMatchObject([{ run_id: run.agent_run }]);
    expect(agent.started[0].command).toContain("borg create");

    agent.polls.set(run.agent_run!, poll_of("exited", 0, "line one\nline two"));
    await poller.poll("odin");

    expect(store.run_row(run.id)).toMatchObject({ state: "succeeded", exit_code: 0 });
    expect(store.run_output(run.id)).toEqual(["line one", "line two"]);
    expect(agent.forgotten).toEqual([run.agent_run]);
  });

  it("polls the repository again at once when a run ends", async () => {
    poller = make();
    await poller.run_action("odin", backup());
    const run = store.runs({ target_id: "odin" })[0];
    agent.polls.set(run.agent_run!, poll_of("exited", 0, ""));

    await poller.poll("odin");
    await poller.poll("odin");

    expect(store.run_row(run.id)!.state).toBe("succeeded");
    expect(store.polls("odin")).toHaveLength(1);
  });

  it("records the run as failed when its agent cannot start it", async () => {
    poller = make();
    agent.start = async () => {
      throw new AgentError("The agent on local disconnected.");
    };

    const result = await poller.run_action("odin", backup());

    expect(result.success).toBe(false);
    expect(store.runs({ target_id: "odin" })[0]).toMatchObject({ state: "failed", error: "Could not start: The agent on local disconnected." });
  });

  it("stops a run on its agent and records it as cancelled", async () => {
    poller = make();
    await poller.run_action("odin", backup());
    const run = store.runs({ target_id: "odin" })[0];

    const result = await poller.cancel_run("odin");

    expect(result.success).toBe(true);
    expect(store.run_row(run.id)!.state).toBe("cancelled");
    expect(agent.forgotten).toEqual([run.agent_run]);
  });

  it("leaves a run waiting while its host's agent is away, and follows it again once the agent connects", async () => {
    const config = parse_config(JSON.stringify({
      hosts: [{ name: "odin", address: "odin.technet" }],
      repositories: [{ name: "odin", host: "odin", repo: "/srv/repo", source_paths: ["/etc"] }],
    }), "test.json");
    poller = make(undefined, config);
    poller.start();
    const run_id = keyed_runs("odin").create("backup", "borg create");
    const agent_run = store.run_row(run_id)!.agent_run!;

    await poller.poll("odin");

    expect(store.run_row(run_id)).toMatchObject({ state: "running", progress: WAITING_FOR_AGENT });

    // The agent comes back, still holding the run, which ended while the server could not ask.
    agent.polls.set(agent_run, poll_of("exited", 1, "warning\n"));
    hub.set_local_host("odin");
    hub.emit("connect", { host: "odin" } as AgentStatus);
    await poller.poll("odin");

    expect(store.run_row(run_id)).toMatchObject({ state: "warning", progress: null });
    expect(store.run_output(run_id)).toEqual(["warning"]);
  });

  it("marks a run lost when its connected agent no longer knows it", async () => {
    poller = make();
    const run_id = keyed_runs().create("backup", "borg create");

    const result = await poller.poll("odin");

    expect(store.run_row(run_id)).toMatchObject({ state: "failed" });
    expect(store.run_row(run_id)!.error).toMatch(/^Lost: the agent on local no longer knows this run/);
    expect(result.status).toBe("failed");
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
    const hosts: string[] = [];
    // The listing fails, so the poll keeps an event to find.
    poller = new Poller(config, store, hub, async (host, command) => {
      hosts.push(host);
      return command === timers_command() ? cmd_result(0, timers, "") : cmd_result(2, "", "Connection refused");
    });

    await poller.poll("nightly:odin:disk");

    expect(new Set(hosts)).toEqual(new Set(["odin"]));
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
