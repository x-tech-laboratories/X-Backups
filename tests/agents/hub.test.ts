import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { start_agent, type RunningAgent } from "../../src/agent/agent.ts";
import { encode_message, protocol_version } from "../../src/shared/agent_protocol.ts";
import { AgentHub, close_codes } from "../../src/server/agents/hub.ts";
import { LocalAgent } from "../../src/server/agents/local.ts";
import { register_agent_route } from "../../src/server/agents/route.ts";
import { AgentTokens } from "../../src/server/agents/tokens.ts";
import { Store } from "../../src/server/store.ts";

const agent_main = join(import.meta.dirname, "../../src/agent/main.ts");

let app: FastifyInstance;
let hub: AgentHub;
let url: string;
let folder: string;
let token_file: string;
let state_directory: string;
let agent: RunningAgent | null;
let processes: ChildProcess[];

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function connected(host = "odin") {
  return new Promise<void>((resolve) => {
    if (hub.is_connected(host)) resolve();
    const listener = (status: { host: string }) => {
      if (status.host !== host) return;
      hub.off("connect", listener);
      resolve();
    };
    hub.on("connect", listener);
  });
}

function start_test_agent(): RunningAgent {
  agent = start_agent({
    url, token_file, state_directory, host: "odin-box", agent_version: "test",
    backoff_initial_in_milliseconds: 50, backoff_longest_in_milliseconds: 200,
    long_runs: { kill_grace_in_milliseconds: 300, tail_interval_in_milliseconds: 20 },
    log: () => {},
  });
  return agent;
}

// Starts the agent as its own process, as it runs on a host.
function start_agent_process(): ChildProcess {
  const child = spawn(process.execPath, [agent_main], {
    env: { ...process.env, X_BACKUPS_AGENT_URL: url, X_BACKUPS_AGENT_TOKEN_FILE: token_file, X_BACKUPS_AGENT_STATE_DIR: state_directory },
    stdio: "ignore",
  });
  processes.push(child);
  return child;
}

async function ended(run_id: string) {
  for (;;) {
    const poll = await hub.poll("odin", run_id, 0);
    if (!poll.alive) return poll;
    await sleep(25);
  }
}

beforeEach(async () => {
  folder = mkdtempSync(join(tmpdir(), "x-backups-hub-"));
  token_file = join(folder, "token");
  state_directory = join(folder, "agent");
  processes = [];
  agent = null;
  hub = new AgentHub(new AgentTokens(new Store(":memory:")), { connection: { window_in_bytes: 64 * 1024 } });
  app = fastify();
  await register_agent_route(app, hub);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  url = `ws://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}/api/agent`;
  writeFileSync(token_file, `${hub.issue_token("odin")}\n`);
});

afterEach(async () => {
  await agent?.stop();
  for (const child of processes) child.kill("SIGKILL");
  await app.close();
});

describe("agent hub", () => {
  it("runs a command on a connected agent", async () => {
    start_test_agent();
    await connected();

    expect(hub.status("odin")).toMatchObject({ host: "odin", reported_host: "odin-box", agent_version: "test", built_in: false });
    expect(await hub.run("odin", "echo hello; echo warn >&2; exit 2", { timeout_in_seconds: 5 })).toEqual({ exit_code: 2, stdout: "hello", stderr: "warn" });
  });

  it("feeds stdin to the command", async () => {
    start_test_agent();
    await connected();

    expect((await hub.run("odin", "cat", { timeout_in_seconds: 5, stdin: "passphrase\n" })).stdout).toBe("passphrase");
  });

  it("stops a command that runs past its timeout", async () => {
    start_test_agent();
    await connected();

    expect(await hub.run("odin", "sleep 30", { timeout_in_seconds: 0.3 })).toEqual({ exit_code: -1, stdout: "", stderr: "Timed out after 0.3s" });
  });

  it("streams a large output whole, within the credit the reader allows", async () => {
    start_test_agent();
    await connected();

    const size = 8 * 1024 * 1024;
    const stream = hub.stream("odin", `head -c ${size} /dev/zero | tr '\\0' x`);
    let received = 0;
    let wrong = false;
    // A slow reader, so the agent has to wait for credit.
    const reader = new Writable({
      highWaterMark: 16 * 1024,
      write(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (chunk.some((byte) => byte !== 0x78)) wrong = true;
        setImmediate(callback);
      },
    });
    stream.stdout.pipe(reader);

    expect(await stream.done).toEqual({ exit_code: 0, stderr: "" });
    expect(received).toBe(size);
    expect(wrong).toBe(false);
  });

  it("stops a stream whose reader stopped reading", async () => {
    start_test_agent();
    await connected();

    const stream = hub.stream("odin", "yes x-backups");
    stream.stdout.pipe(new Writable({ highWaterMark: 16, write: () => {} }));
    await sleep(100);
    stream.stop();

    expect((await stream.done).exit_code).not.toBe(0);
    // The connection is still good for more.
    expect((await hub.run("odin", "echo still here", { timeout_in_seconds: 5 })).stdout).toBe("still here");
  });

  it("samples the host's health", async () => {
    start_test_agent();
    await connected();

    const sample = await hub.health("odin");
    expect(sample.cpus).toBeGreaterThan(0);
    expect(sample.memory_total).toBeGreaterThan(sample.memory_available);
    expect(sample.disk_size).toBeGreaterThan(0);
  });

  it("keeps a long run going across a dropped connection and reports it on reconnect", async () => {
    start_test_agent();
    await connected();
    await hub.start("odin", "survivor", "echo begin; sleep 0.5; echo end", {});

    const reconnected = new Promise<{ runs: unknown[] }>((resolve) => hub.once("connect", resolve));
    hub.disconnect("odin");
    const status = await reconnected;

    expect(status.runs).toMatchObject([{ run_id: "survivor", state: "running" }]);
    const poll = await ended("survivor");
    expect(poll).toMatchObject({ state: "exited", exit_code: 0, new_output: "begin\nend\n" });
  });

  it("follows a long run's output to its end", async () => {
    start_test_agent();
    await connected();
    await hub.start("odin", "ticks", "for i in 1 2 3; do echo $i; sleep 0.05; done", {});

    const stream = hub.attach("odin", "ticks", 0);
    const chunks: Buffer[] = [];
    stream.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

    expect(await stream.done).toEqual({ exit_code: 0, stderr: "" });
    expect(Buffer.concat(chunks).toString()).toBe("1\n2\n3\n");
  });

  it("stops a long run", async () => {
    start_test_agent();
    await connected();
    await hub.start("odin", "endless", "sleep 30", {});

    expect(await hub.stop("odin", "endless")).toMatchObject({ run_id: "endless", state: "stopped" });
    expect(await hub.runs("odin")).toMatchObject([{ run_id: "endless", state: "stopped" }]);
    await hub.forget("odin", "endless");
    expect(await hub.runs("odin")).toEqual([]);
    await expect(hub.poll("odin", "endless", 0)).rejects.toThrow(/No run named/);
  });

  it("re-adopts a long run after the agent itself restarts", async () => {
    const first = start_agent_process();
    await connected();
    await hub.start("odin", "outlives", "echo one; sleep 1; echo two", {});

    const gone = once(hub, "disconnect");
    first.kill("SIGKILL");
    await gone;
    expect(hub.is_connected("odin")).toBe(false);

    const reconnected = new Promise<{ runs: unknown[] }>((resolve) => hub.once("connect", resolve));
    start_agent_process();
    const status = await reconnected;

    expect(status.runs).toMatchObject([{ run_id: "outlives", state: "running" }]);
    expect(await ended("outlives")).toMatchObject({ state: "exited", exit_code: 0, new_output: "one\ntwo\n" });
  });

  it("refuses a token nobody was issued, and hangs up on a revoked one", async () => {
    const socket = new WebSocket(url, { headers: { authorization: "Bearer xba_wrong" } });
    let opened = false;
    socket.addEventListener("open", () => (opened = true));
    socket.addEventListener("error", () => {});
    await once(socket, "close");
    expect(opened).toBe(false);

    start_test_agent();
    await connected();
    hub.revoke("odin");
    await sleep(300);
    expect(hub.is_connected("odin")).toBe(false);
    expect(agent!.connected()).toBe(false);
  });

  it("hangs up on an agent speaking another protocol version", async () => {
    const token = hub.issue_token("thor");
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    socket.addEventListener("open", () => {
      socket.send(encode_message({ type: "hello", protocol: protocol_version + 1, host: "thor", agent_version: "9", runs: [] }));
    });
    const [event] = await once(socket, "close") as [CloseEvent];
    expect(event.code).toBe(close_codes.protocol);
    expect(hub.is_connected("thor")).toBe(false);
  });

  it("answers for a host with no agent without running anything", async () => {
    expect(await hub.run("nobody", "true", { timeout_in_seconds: 1 })).toMatchObject({ exit_code: -1, stderr: "No agent is connected for nobody." });
    expect((await hub.stream("nobody", "true").done).exit_code).toBe(-1);
    await expect(hub.health("nobody")).rejects.toThrow(/No agent/);
  });

  it("notes when an enrolled agent was last in touch, as it hangs up", async () => {
    start_test_agent();
    await connected();
    const enrolment = () => hub.enrolments().find((item) => item.host === "odin")!;
    expect(enrolment().last_seen_epoch).not.toBeNull();

    const gone = new Promise((resolve) => hub.once("disconnect", resolve));
    await agent!.stop();
    agent = null;
    await gone;

    expect(hub.is_connected("odin")).toBe(false);
    expect(enrolment().last_seen_epoch).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) - 1);
  });

  it("moves its built-in agent to the host the config names as the server's own", async () => {
    const local = new AgentHub(new AgentTokens(new Store(":memory:")), { local: { host: "local", agent: new LocalAgent(state_directory) } });

    local.set_local_host("heimdall");

    expect(local.is_connected("heimdall")).toBe(true);
    expect(local.is_connected("local")).toBe(false);
    expect(local.status("heimdall")).toMatchObject({ host: "heimdall", built_in: true });
  });
});
