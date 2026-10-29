import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { build_app } from "../src/server/app.ts";
import { hash_password } from "../src/server/auth.ts";
import { cmd_result } from "../src/server/borg/types.ts";
import type { Config } from "../src/server/config.ts";
import { Poller } from "../src/server/poller.ts";
import { Store } from "../src/server/store.ts";
import { code_at } from "../src/server/totp.ts";

const LIST = JSON.stringify({ archives: [{ name: "a1", time: "2026-10-01T10:00:00" }] });

const CONFIG: Config = {
  repositories: ["odin", "thor"].map((name) => ({
    name, host: null, ssh_user: null, interval_in_seconds: 3600, borg: { repo: `/srv/${name}`, collect_stats: false, source_paths: ["/etc"] },
    source: "declared" as const,
  })),
};

let app: FastifyInstance;
let store: Store;
let poller: Poller;

beforeEach(async () => {
  store = new Store(":memory:");
  poller = new Poller(CONFIG, store, async (_target, command) => cmd_result(0, command.includes("list") ? LIST : "4242\n", ""));
  app = await build_app({
    serve_web: false, logger: false, password_hash: hash_password("declared admin pass"), poller, store,
    proxy: { header: "x-remote-user", trusted: new Set(["127.0.0.1"]) },
  });
});

afterEach(async () => {
  poller.stop();
  await app.close();
  store.close();
});

async function login(name: string, password: string, code?: string): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/api/login", payload: { name, password, code } });
  expect(response.statusCode).toBe(204);
  return String(response.headers["set-cookie"]).split(";")[0];
}

function call(method: "GET" | "POST" | "PUT" | "DELETE", url: string, cookie: string, payload?: object) {
  return app.inject({ method, url, payload, headers: { cookie } });
}

async function add_user(admin: string, name: string, role: string, repositories: string[] | null = null): Promise<string> {
  const created = await call("POST", "/api/users", admin, { name, role, repositories, password: `${name} long password` });
  expect(created.statusCode).toBe(201);
  return login(name, `${name} long password`);
}

// ── Roles ────────────────────────────────────────────────────────────────────

describe("roles", () => {
  it("lets a viewer read but not act, read archive contents or manage users", async () => {
    const admin = await login("admin", "declared admin pass");
    const viewer = await add_user(admin, "vera", "viewer");

    expect((await call("GET", "/api/repositories", viewer)).statusCode).toBe(200);
    expect((await call("POST", "/api/repositories/odin/actions/run_backup", viewer)).statusCode).toBe(403);
    expect((await call("GET", "/api/repositories/odin/browse?archive=a1", viewer)).statusCode).toBe(403);
    expect((await call("GET", "/api/users", viewer)).statusCode).toBe(403);
    expect((await call("GET", "/api/me", viewer)).json()).toMatchObject({ name: "vera", role: "viewer" });
  });

  it("lets an operator act and notes who did, but not manage users", async () => {
    const admin = await login("admin", "declared admin pass");
    const operator = await add_user(admin, "otto", "operator");

    expect((await call("POST", "/api/repositories/odin/actions/run_backup", operator)).json().success).toBe(true);
    expect((await call("GET", "/api/users", operator)).statusCode).toBe(403);
    const events = (await call("GET", "/api/events?repository=odin", operator)).json();
    expect(events.some((event: { message: string }) => event.message === "otto asked for run backup")).toBe(true);
  });

  it("ends a user's sessions when an admin changes or removes them", async () => {
    const admin = await login("admin", "declared admin pass");
    const viewer = await add_user(admin, "vera", "viewer");

    await call("PUT", "/api/users/vera", admin, { role: "operator" });
    expect((await call("GET", "/api/me", viewer)).statusCode).toBe(401);
    const again = await login("vera", "vera long password");
    expect((await call("DELETE", "/api/users/vera", admin)).statusCode).toBe(204);
    expect((await call("GET", "/api/me", again)).statusCode).toBe(401);
    expect((await call("DELETE", "/api/users/admin", admin)).statusCode).toBe(403);
  });
});

// ── Repository access ────────────────────────────────────────────────────────

describe("repository access", () => {
  it("shows a limited user only their repositories, jobs and events", async () => {
    const admin = await login("admin", "declared admin pass");
    await call("POST", "/api/repositories/thor/actions/run_backup", admin);
    const limited = await add_user(admin, "lena", "operator", ["odin"]);

    expect((await call("GET", "/api/repositories", limited)).json().map((repository: { id: string }) => repository.id)).toEqual(["odin"]);
    expect((await call("GET", "/api/map", limited)).json().repositories.map((repository: { id: string }) => repository.id)).toEqual(["odin"]);
    expect((await call("GET", "/api/repositories/thor", limited)).statusCode).toBe(404);
    expect((await call("POST", "/api/repositories/thor/actions/run_backup", limited)).statusCode).toBe(404);
    expect((await call("GET", "/api/jobs", limited)).json()).toEqual([]);
    expect((await call("GET", "/api/events", limited)).json().every((event: { repository_id: string }) => event.repository_id === "odin")).toBe(true);
    const [job] = (await call("GET", "/api/jobs", admin)).json();
    expect((await call("GET", `/api/jobs/${job.id}`, limited)).statusCode).toBe(404);
  });
});

// ── Login ────────────────────────────────────────────────────────────────────

describe("login", () => {
  it("asks for the second factor once it is set up", async () => {
    const admin = await login("admin", "declared admin pass");
    const { secret } = (await call("POST", "/api/account/totp/start", admin)).json();
    const now = Date.now() / 1000;
    const confirmed = await call("POST", "/api/account/totp/confirm", admin, { code: code_at(secret, now) });
    expect(confirmed.json().recovery_codes).toHaveLength(8);

    const without = await app.inject({ method: "POST", url: "/api/login", payload: { name: "admin", password: "declared admin pass" } });
    expect(without.statusCode).toBe(401);
    expect(without.json().totp_required).toBe(true);
    await login("admin", "declared admin pass", code_at(secret, now + 30));
  });

  it("locks a name out from an address after five wrong passwords", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await app.inject({ method: "POST", url: "/api/login", payload: { name: "admin", password: "wrong" } })).statusCode).toBe(401);
    }
    const locked = await app.inject({ method: "POST", url: "/api/login", payload: { name: "admin", password: "declared admin pass" } });
    expect(locked.statusCode).toBe(429);
  });

  it("trusts a proxy's user header only from the proxy's address", async () => {
    const admin = await login("admin", "declared admin pass");
    await add_user(admin, "vera", "viewer");

    const from_proxy = await app.inject({ method: "GET", url: "/api/me", headers: { "x-remote-user": "vera" }, remoteAddress: "127.0.0.1" });
    const from_elsewhere = await app.inject({ method: "GET", url: "/api/me", headers: { "x-remote-user": "vera" }, remoteAddress: "10.0.0.9" });

    expect(from_proxy.json()).toMatchObject({ name: "vera", via: "proxy" });
    expect(from_elsewhere.statusCode).toBe(401);
  });
});

// ── Tokens and metrics ───────────────────────────────────────────────────────

describe("tokens and metrics", () => {
  it("lets a token read and scrape metrics but change nothing", async () => {
    const admin = await login("admin", "declared admin pass");
    await poller.poll("odin");
    const { token } = (await call("POST", "/api/tokens", admin, { name: "prometheus" })).json();
    const bearer = { authorization: `Bearer ${token}` };

    expect((await app.inject({ method: "GET", url: "/api/repositories", headers: bearer })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/repositories/odin/poll", headers: bearer })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/me", headers: bearer })).statusCode).toBe(403);
    const metrics = await app.inject({ method: "GET", url: "/metrics", headers: bearer });
    expect(metrics.body).toContain('x_backups_archives{repository="odin",host="local"} 1');
    expect((await app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(401);
  });
});
