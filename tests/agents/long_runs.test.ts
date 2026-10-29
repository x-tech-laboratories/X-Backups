import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LongRuns } from "../../src/agent/long_runs.ts";
import { AgentHub } from "../../src/server/agents/hub.ts";
import { LocalAgent } from "../../src/server/agents/local.ts";
import { AgentTokens } from "../../src/server/agents/tokens.ts";
import { Store } from "../../src/server/store.ts";

let state: string;
let runs: LongRuns;

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "x-backups-runs-"));
  runs = new LongRuns(state, { kill_grace_in_milliseconds: 300, tail_interval_in_milliseconds: 20 });
});

afterEach(async () => {
  for (const run of runs.list()) if (run.state === "running") await runs.stop(run.run_id);
});

async function ended(run_id: string) {
  for (;;) {
    const run = runs.get(run_id);
    if (run.state !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("long runs", () => {
  it("keeps a run's output and exit code, and feeds it stdin without writing it down", async () => {
    runs.start("one", "cat; echo err >&2; exit 3", "secret\n");
    expect((await ended("one")).exit_code).toBe(3);

    const poll = await runs.poll("one", 0);
    expect(poll).toMatchObject({ state: "exited", exit_code: 3, alive: false, new_output: "secret\nerr\n", next_offset: 11, size: 11 });
    expect((await runs.poll("one", 7)).new_output).toBe("err\n");
  });

  it("returns a large output in whole lines, carrying on from where the last poll stopped", async () => {
    runs.start("big", "yes 'a line' | head -n 200000", null);
    await ended("big");
    const first = await runs.poll("big", 0);
    expect(first.next_offset).toBeLessThan(first.size);
    expect(first.new_output.endsWith("\n")).toBe(true);
    let offset = first.next_offset;
    let text = first.new_output;
    while (offset < first.size) {
      const next = await runs.poll("big", offset);
      text += next.new_output;
      offset = next.next_offset;
    }
    expect(text).toBe("a line\n".repeat(200000));
  });

  it("refuses a run id that is taken or unsafe", () => {
    runs.start("taken", "true", null);
    expect(() => runs.start("taken", "true", null)).toThrow(/already exists/);
    expect(() => runs.start("../escape", "true", null)).toThrow(/not a valid run id/);
  });

  it("stops a run's whole process group", async () => {
    runs.start("long", "sleep 30 & wait", null);
    const stopped = await runs.stop("long");
    expect(stopped.state).toBe("stopped");
    expect((await runs.poll("long", 0)).alive).toBe(false);
  });

  it("follows a run's output until it ends", async () => {
    runs.start("ticks", "for i in 1 2 3; do echo $i; sleep 0.05; done", null);
    const stream = runs.tail("ticks", 0);
    const chunks: Buffer[] = [];
    stream.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    expect(await stream.done).toEqual({ exit_code: 0, stderr: "" });
    expect(Buffer.concat(chunks).toString()).toBe("1\n2\n3\n");
  });

  it("reports a run whose process vanished without an exit code as lost, and forgets ended runs", async () => {
    const folder = join(state, "runs", "vanished");
    mkdirSync(folder);
    writeFileSync(join(folder, "out"), "partial");
    writeFileSync(join(folder, "run.json"), JSON.stringify({ run_id: "vanished", pid: 2 ** 22 + 1, start_ticks: 1, started_epoch: 1 }));
    expect(runs.get("vanished")).toMatchObject({ state: "lost", exit_code: null });

    runs.prune(0);
    expect(runs.list()).toEqual([]);
  });

  it("is found by a new instance reading the same folder", async () => {
    runs.start("adopted", "sleep 0.3; echo done", null);
    const later = new LongRuns(state);
    expect(later.list()).toMatchObject([{ run_id: "adopted", state: "running" }]);
    while (later.get("adopted").state === "running") await new Promise((resolve) => setTimeout(resolve, 20));
    expect(later.get("adopted")).toMatchObject({ state: "exited", exit_code: 0 });
  });
});

describe("local agent", () => {
  it("answers through the hub as the server's own host, with no socket", async () => {
    const hub = new AgentHub(new AgentTokens(new Store(":memory:")), { local: { host: "server", agent: new LocalAgent(state) } });
    expect(hub.is_connected("server")).toBe(true);
    expect(await hub.run("server", "cat", { timeout_in_seconds: 5, stdin: "secret\n" })).toEqual({ exit_code: 0, stdout: "secret", stderr: "" });
    expect((await hub.health("server")).cpus).toBeGreaterThan(0);

    await hub.start("server", "local-run", "echo hi", {});
    const stream = hub.attach("server", "local-run", 0);
    const chunks: Buffer[] = [];
    stream.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    expect((await stream.done).exit_code).toBe(0);
    expect(Buffer.concat(chunks).toString()).toBe("hi\n");
    expect((await hub.attach("server", "missing", 0).done).stderr).toMatch(/No run named/);
  });
});
