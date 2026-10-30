import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Agent } from "../src/server/agents/agent.ts";
import { AgentHub, type AgentStatus } from "../src/server/agents/hub.ts";
import { AgentTokens } from "../src/server/agents/tokens.ts";
import { cmd_result } from "../src/server/borg/types.ts";
import { parse_config, type Config } from "../src/server/config.ts";
import { Poller } from "../src/server/poller.ts";
import { Scheduler, type TaskView } from "../src/server/scheduler.ts";
import { Store, type RunRow } from "../src/server/store.ts";
import { FakeAgent, poll_of } from "./agents/fake_agent.ts";

const LIST = JSON.stringify({ archives: [{ name: "web-odin-2026-10-01T10:00:00", time: "2026-10-01T10:00:00" }], repository: { location: "/srv/disk" } });

// Job web backs up odin to disk and usb, and job base backs up the server itself to disk.
const DOCUMENT = {
  hosts: [{ name: "server" }, { name: "odin", address: "odin.technet" }],
  repositories: [
    { name: "disk", host: "server", repo: "/srv/disk", repo_by_host: { odin: "ssh://borg@server//srv/disk" }, tasks: { compact: { after: "backup" } } },
    { name: "usb", host: "server", repo: "/srv/usb", repo_by_host: { odin: "ssh://borg@server//srv/usb" } },
  ],
  sources: [{ name: "home", host: "odin", source_paths: ["/home"] }, { name: "etc", host: "server", source_paths: ["/etc"] }],
  jobs: [
    { name: "web", sources: ["home"], repositories: ["disk", "usb"], keep_daily: 7, tasks: { backup: { schedule: "daily 02:00" }, prune: { after: "backup" } } },
    { name: "base", sources: ["etc"], repositories: ["disk"], tasks: { backup: "6h" } },
  ],
};

// A hub whose remote agents are fakes the test connects and drops.
class FakeHub extends AgentHub {
  readonly remote = new Map<string, FakeAgent>();

  override agent(host: string): Agent | null {
    return this.remote.get(host) ?? super.agent(host);
  }

  override is_connected(host: string): boolean {
    return this.remote.has(host) || super.is_connected(host);
  }

  connect(host: string): FakeAgent {
    const agent = new FakeAgent();
    this.remote.set(host, agent);
    this.emit("connect", { host } as AgentStatus);
    return agent;
  }

  drop(host: string): void {
    this.remote.delete(host);
  }
}

let store: Store;
let hub: FakeHub;
let server_agent: FakeAgent;
let poller: Poller;
let scheduler: Scheduler;

function build(document: object = DOCUMENT): void {
  const config: Config = parse_config(JSON.stringify(document), "test.json");
  poller = new Poller(config, store, hub, async (host, command) => hub.is_connected(host) ? cmd_result(0, command.includes(" list ") ? LIST : "", "") : cmd_result(-1, "", "away"));
  scheduler = new Scheduler(poller, store, { time_zone: "UTC", jitter_in_seconds: 0, retry_in_seconds: 600 });
}

function at(text: string): void {
  vi.setSystemTime(new Date(`${text}Z`));
}

function epoch(text: string): number {
  return Date.parse(`${text}Z`) / 1000;
}

function runs(filter: { task?: string; state?: string } = {}): RunRow[] {
  return store.runs({ state: filter.state, limit: 1000 }).filter((run) => filter.task === undefined || run.task === filter.task).reverse();
}

function task(id: string): TaskView {
  return scheduler.tasks().find((view) => view.id === id)!;
}

// Ends the run on its agent with the exit code, then polls its target so the poller records the end; the poll the
// scheduler asked for at the start is let finish first.
async function finish(run: RunRow, exit_code = 0): Promise<void> {
  await poller.poll(run.target_id);
  const agent = run.host === "server" ? server_agent : hub.remote.get(run.host!)!;
  agent.polls.set(run.agent_run!, poll_of("exited", exit_code, ""));
  await poller.poll(run.target_id);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at("2026-10-29T01:00:00");
  store = new Store(":memory:");
  server_agent = new FakeAgent();
  hub = new FakeHub(new AgentTokens(store), { local: { host: "local", agent: server_agent } });
  hub.connect("odin");
  build();
  // Seen at 01:00, so web's backup, daily at 02:00 and never run, is due by noon.
  scheduler.tasks();
  at("2026-10-29T12:00:00");
});

afterEach(async () => {
  scheduler.stop();
  poller.stop();
  // Polls the scheduler asked for end before the store closes.
  await Promise.all([...poller.repositories.keys()].map((id) => poller.poll(id)));
  store.close();
  vi.useRealTimers();
});

// ── Tasks ────────────────────────────────────────────────────────────────────

describe("tasks", () => {
  it("lists each job's and repository's tasks with stable ids, their schedules in words and their targets", () => {
    const views = scheduler.tasks();

    expect(views.map((view) => view.id)).toEqual([
      "job:web:backup", "job:web:prune", "job:web:check:archives", "job:base:backup", "job:base:check:archives",
      "repository:disk:compact", "repository:disk:check:repository", "repository:usb:compact", "repository:usb:check:repository",
    ]);
    expect(task("job:web:backup")).toMatchObject({ description: "Every day at 02:00", enabled: true, origin: "written" });
    expect(task("job:web:backup").targets.map((target) => target.target_id)).toEqual(["web:odin:disk", "web:odin:usb"]);
    expect(task("job:web:prune")).toMatchObject({ description: "After each successful backup", next_due: null });
    expect(task("job:base:backup")).toMatchObject({ description: "Every 6 hours" });
    expect(task("repository:disk:check:repository")).toMatchObject({ check: "repository", enabled: false, origin: "manual", description: "Only when started by hand" });
    expect(task("repository:disk:compact").targets.map((target) => target.target_id)).toEqual(["base:server:disk"]);
  });
});

// ── Starting and queueing ────────────────────────────────────────────────────

describe("starting and queueing", () => {
  it("starts a task once it falls due, recording its run under the task", async () => {
    await scheduler.tick();

    const [run] = runs({ task: "job:web:backup" });
    expect(run).toMatchObject({ target_id: "web:odin:disk", kind: "backup", state: "running" });
    expect(hub.remote.get("odin")!.started).toHaveLength(1);
  });

  it("runs one task at a time per repository and per job on one host", async () => {
    await scheduler.tick();

    // disk is busy with web's backup, so base waits; web's usb target waits for web on odin.
    expect(runs().map((run) => run.target_id)).toEqual(["web:odin:disk"]);
    const targets = new Map(task("job:web:backup").targets.map((target) => [target.target_id, target.waiting]));
    expect(targets.get("web:odin:usb")).toMatch(/^Queued behind backup run #\d+ of web on odin$/);
    expect(task("job:base:backup").waiting).toMatch(/^Queued behind backup run #\d+ on disk$/);

    await finish(runs()[0]);
    await scheduler.tick();

    // The usb backup and base's backup start; web's prune on disk now waits behind base's backup.
    expect(runs({ state: "running" }).map((run) => run.target_id).sort()).toEqual(["base:server:disk", "web:odin:usb"]);
    expect(task("job:web:prune").targets[0].waiting).toMatch(/on disk$/);
  });

  it("prunes a target right after its backup succeeds, then compacts the repository once its backups and prunes are done", async () => {
    await scheduler.tick();
    await finish(runs()[0]);
    await scheduler.tick();
    // base on disk and web on usb are backing up; finish both.
    for (const run of runs({ state: "running" })) await finish(run);
    await scheduler.tick();

    // web's two prunes run on odin one after the other, and disk's compact waits for its prune.
    expect(runs({ task: "job:web:prune" }).map((run) => run.target_id)).toEqual(["web:odin:disk"]);
    expect(runs({ task: "repository:disk:compact" })).toHaveLength(0);
    expect(task("repository:disk:compact").waiting).toMatch(/^Queued behind prune run #\d+ on disk$/);

    for (const run of runs({ state: "running" })) await finish(run);
    await scheduler.tick();
    for (const run of runs({ state: "running" })) await finish(run);
    await scheduler.tick();

    expect(runs({ task: "job:web:prune" })).toHaveLength(2);
    expect(runs({ task: "repository:disk:compact" })).toHaveLength(1);
    // Nothing new succeeded since, so the compact does not run again.
    for (const run of runs({ state: "running" })) await finish(run);
    await scheduler.tick();
    expect(runs({ task: "repository:disk:compact" })).toHaveLength(1);
  });

  it("starts a task on a duration never run at once, and one on a calendar never run at its next time after it was first seen", () => {
    const document = { ...DOCUMENT, jobs: [{ ...DOCUMENT.jobs[1], tasks: { backup: "6h", check: [{ kind: "extract", schedule: "0 4 * * *" }] } }] };
    build(document);

    expect(task("job:base:backup").next_due).toBe(epoch("2026-10-29T12:00:00"));
    expect(task("job:base:check:extract").next_due).toBe(epoch("2026-10-30T04:00:00"));
    // The store keeps when it was first seen, so a restart does not push it back.
    at("2026-10-30T03:00:00");
    scheduler.stop();
    build(document);
    expect(task("job:base:check:extract").next_due).toBe(epoch("2026-10-30T04:00:00"));
  });

  it("counts a calendar schedule from the last run's start, and a duration likewise", async () => {
    await scheduler.tick();
    await finish(runs()[0]);
    await scheduler.tick();

    const by_target = new Map(task("job:web:backup").targets.map((target) => [target.target_id, target.next_due]));
    expect(by_target.get("web:odin:disk")).toBe(epoch("2026-10-30T02:00:00"));
    expect(task("job:base:backup").next_due).toBe(epoch("2026-10-29T18:00:00"));
  });

  it("works out what is due from the store, so a restarted server carries on", async () => {
    await scheduler.tick();
    await finish(runs()[0]);
    await scheduler.tick();
    const before = scheduler.tasks().map((view) => [view.id, view.next_due]);

    scheduler.stop();
    build();

    expect(scheduler.tasks().map((view) => [view.id, view.next_due])).toEqual(before);
  });
});

// ── Agents away ──────────────────────────────────────────────────────────────

describe("agents away", () => {
  it("waits for an agent that is away, and runs a task missed several times once when it connects", async () => {
    hub.drop("odin");
    await scheduler.tick();

    expect(task("job:web:backup").waiting).toBe("Waiting for odin's agent to connect");
    expect(runs({ task: "job:web:backup" })).toHaveLength(0);

    at("2026-11-02T12:00:00");
    hub.connect("odin");
    await scheduler.tick();
    await scheduler.tick();

    expect(runs({ task: "job:web:backup" })).toHaveLength(1);
  });

  it("looks again as soon as an agent connects", async () => {
    vi.useRealTimers();
    hub.drop("odin");
    scheduler.start();
    await vi.waitFor(() => expect(task("job:web:backup").waiting).toBe("Waiting for odin's agent to connect"), { timeout: 3000 });

    hub.connect("odin");

    await vi.waitFor(() => expect(runs({ task: "job:web:backup" })).toHaveLength(1), { timeout: 3000 });
  });
});

// ── Page actions ─────────────────────────────────────────────────────────────

describe("page actions", () => {
  it("keeps a task switched off in the store, and drops the override once it matches the config again", async () => {
    scheduler.set_enabled("job:web:backup", false, "ana");
    await scheduler.tick();

    expect(runs({ task: "job:web:backup" })).toHaveLength(0);
    expect(task("job:web:backup")).toMatchObject({ enabled: false, enabled_by_config: true, override: { changed_by: "ana" }, next_due: null });
    build();
    expect(task("job:web:backup").enabled).toBe(false);

    scheduler.set_enabled("job:web:backup", true, "ana");
    expect(store.task_overrides().size).toBe(0);
  });

  it("runs a task now, whatever its schedule, on the target offering a repository's actions", async () => {
    const started = await scheduler.run_now("repository:usb:check:repository");

    expect(started).toEqual(["web:odin:usb"]);
    expect(runs({ task: "repository:usb:check:repository" })).toMatchObject([{ kind: "check-repository", target_id: "web:odin:usb" }]);
  });

  it("holds a start that was refused, noting why once, and tries again later", async () => {
    build({ ...DOCUMENT, jobs: [{ name: "web", sources: ["home"], repositories: ["usb"], canary_path: "/home/canary" }] });
    scheduler.set_enabled("job:web:backup", false, "ana");
    // No archive has been listed yet, so the canary cannot restore one.
    await scheduler.tick();

    expect(runs({ task: "job:web:canary" })).toHaveLength(0);
    expect(task("job:web:canary").waiting).toMatch(/^Could not start: Cannot verify a restore: no archive has been listed yet/);
    await scheduler.tick();
    expect(store.events({ target_id: "web:odin:usb" }).filter((event) => event.message.includes("could not start"))).toHaveLength(1);

    await poller.poll("web:odin:usb");
    at("2026-10-29T12:11:00");
    await scheduler.tick();

    expect(runs({ task: "job:web:canary" })).toMatchObject([{ kind: "verify_restore", state: "succeeded" }]);
  });
});
