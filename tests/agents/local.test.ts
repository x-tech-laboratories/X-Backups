import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAgent } from "@x-tech-laboratories/x-libs/server/agents/local";
import { describe, expect, it } from "vitest";
import { command_runner } from "../../src/agent/agent.ts";
import { read_health } from "../../src/agent/health.ts";
import { AgentHub } from "../../src/server/agents/hub.ts";
import { AgentTokens } from "../../src/server/agents/tokens.ts";
import { Store } from "../../src/server/store.ts";

describe("local agent", () => {
  it("answers through the hub as the server's own host, with no socket", async () => {
    const state = mkdtempSync(join(tmpdir(), "x-backups-local-"));
    const local = new LocalAgent(state, { runner: command_runner, requests: { health: () => read_health() } });
    const hub = new AgentHub(new AgentTokens(new Store(":memory:")), { local: { host: "server", agent: local } });
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
