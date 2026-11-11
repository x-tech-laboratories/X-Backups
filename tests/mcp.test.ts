import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentHub } from "../src/server/agents/hub.ts";
import { AgentTokens } from "../src/server/agents/tokens.ts";
import { build_app } from "../src/server/app.ts";
import { hash_password } from "../src/server/auth.ts";
import { cmd_result } from "../src/server/borg/types.ts";
import type { Config } from "../src/server/config.ts";
import { Poller } from "../src/server/poller.ts";
import { Store } from "../src/server/store.ts";
import { FakeAgent } from "./agents/fake_agent.ts";

const CONFIG: Config = {
  repositories: [{
    name: "odin", host: null, interval_in_seconds: 3600,
    borg: { repo: "/srv/repo", collect_stats: false, source_paths: ["/etc"] }, source: "declared",
  }],
};

const protocol_version = "2025-06-18";

let app: FastifyInstance;
let store: Store;
let poller: Poller;
let admin: string;

async function sign_in(name: string, password: string): Promise<string> {
  const login = await app.inject({ method: "POST", url: "/api/login", payload: { name, password } });
  return String(login.headers["set-cookie"]).split(";")[0]!;
}

// A user with the role and grants given, signed in.
async function user(name: string, role: string, access: unknown): Promise<string> {
  const password = `${name} has a long password`;
  await app.inject({ method: "POST", url: "/api/users", headers: { cookie: admin }, payload: { name, role, access, password } });
  return sign_in(name, password);
}

// Calls one tool with the cookie and gives its result.
async function call(cookie: string, name: string, args: Record<string, unknown> = {}): Promise<{ isError?: boolean; content: { text: string }[] }> {
  const reply = await app.inject({
    method: "POST",
    url: "/api/mcp",
    headers: { cookie, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": protocol_version },
    payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(reply.statusCode).toBe(200);
  const data = reply.headers["content-type"]?.includes("text/event-stream") ? /^data: (.+)$/m.exec(reply.body)![1]! : reply.body;
  return (JSON.parse(data) as { result: { isError?: boolean; content: { text: string }[] } }).result;
}

beforeEach(async () => {
  store = new Store(":memory:");
  const hub = new AgentHub(new AgentTokens(store), { local: { host: "local", agent: new FakeAgent() } });
  poller = new Poller(CONFIG, store, hub, async () => cmd_result(0, "", ""));
  app = await build_app({ serve_web: false, logger: false, password_hash: hash_password("correct horse"), poller, store });
  admin = await sign_in("admin", "correct horse");
});

afterEach(async () => {
  poller.stop();
  await app.close();
  store.close();
});

describe("/api/mcp", () => {
  it("shows each caller only what their grants show on the page", async () => {
    const outsider = await user("vera", "operator", [{ repository: "elsewhere" }]);

    expect(JSON.parse((await call(admin, "list_repositories")).content[0]!.text)).toMatchObject([{ id: "odin" }]);
    expect(JSON.parse((await call(outsider, "list_repositories")).content[0]!.text)).toEqual([]);
    expect(await call(outsider, "run_repository_action", { id: "odin", action: "run_backup" })).toEqual({ isError: true, content: [{ type: "text", text: "No repository 'odin'." }] });
  });

  it("lets a viewer read, and answers an action with the operator role it needs", async () => {
    const viewer = await user("walt", "viewer", null);

    expect((await call(viewer, "get_repository", { id: "odin" })).isError).toBeUndefined();
    const refused = await call(viewer, "run_repository_action", { id: "odin", action: "run_backup" });
    expect(refused).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("operator role") }] });
  });
});
