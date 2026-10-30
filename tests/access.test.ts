import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentHub } from "../src/server/agents/hub.ts";
import { AgentTokens } from "../src/server/agents/tokens.ts";
import { build_app } from "../src/server/app.ts";
import type { Grant } from "../src/server/access.ts";
import { hash_password } from "../src/server/auth.ts";
import { cmd_result } from "../src/server/borg/types.ts";
import { parse_config, type Config } from "../src/server/config.ts";
import { Poller } from "../src/server/poller.ts";
import { Scheduler } from "../src/server/scheduler.ts";
import { Store } from "../src/server/store.ts";
import { code_at } from "../src/server/totp.ts";
import { FakeAgent } from "./agents/fake_agent.ts";

const LIST = JSON.stringify({ archives: [{ name: "a1", time: "2026-10-01T10:00:00" }] });

const CONFIG: Config = {
  repositories: ["odin", "thor"].map((name) => ({
    name, host: null, interval_in_seconds: 3600, borg: { repo: `/srv/${name}`, collect_stats: false, source_paths: ["/etc"] },
    source: "declared" as const,
  })),
};

// The agents of a store, with a fake built into the server for its own host.
function agent_hub(store: Store): AgentHub {
  return new AgentHub(new AgentTokens(store), { local: { host: "local", agent: new FakeAgent() } });
}

let app: FastifyInstance;
let store: Store;
let poller: Poller;

beforeEach(async () => {
  store = new Store(":memory:");
  poller = new Poller(CONFIG, store, agent_hub(store), async (_host, command) => cmd_result(0, command.includes("list") ? LIST : "", ""));
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

async function add_user(admin: string, name: string, role: string, grants: Grant[] | null = null): Promise<string> {
  const created = await call("POST", "/api/users", admin, { name, role, grants, password: `${name} long password` });
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
    expect((await call("GET", "/api/hosts", operator)).statusCode).toBe(200);
    expect((await call("POST", "/api/hosts/local/token", operator)).statusCode).toBe(403);
    expect((await call("DELETE", "/api/hosts/local/token", operator)).statusCode).toBe(403);
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

// ── Job access ───────────────────────────────────────────────────────────────

// Two jobs share the repository vault, polled from thor, this server; media on thor has no job and is only watched.
const SHARED = JSON.stringify({
  hosts: [{ name: "odin", address: "odin.lan" }, { name: "thor" }, { name: "nas", kind: "storage-only", address: "nas.lan" }],
  repositories: [
    { name: "vault", host: "nas", repo: "ssh://borg@nas.lan/srv/vault", poll_via: "thor" },
    { name: "media", host: "thor", repo: "/srv/media" },
  ],
  sources: [{ name: "home", host: "odin", source_paths: ["/home"] }, { name: "maildir", host: "thor", source_paths: ["/var/mail"] }],
  jobs: [{ name: "nightly", sources: ["home"], repositories: ["vault"] }, { name: "mail", sources: ["maildir"], repositories: ["vault"] }],
});

async function rebuild(config: Config, with_scheduler = false): Promise<void> {
  poller.stop();
  await app.close();
  poller = new Poller(config, store, agent_hub(store), async (_host, command) => cmd_result(0, command.includes("list") ? LIST : "", ""));
  const scheduler = with_scheduler ? new Scheduler(poller, store, { time_zone: "UTC", jitter_in_seconds: 0 }) : undefined;
  app = await build_app({ serve_web: false, logger: false, password_hash: hash_password("declared admin pass"), poller, store, scheduler });
}

const ids = (response: { json: () => unknown }) => (response.json() as { id?: string; name?: string }[]).map((item) => item.id ?? item.name);

describe("job access", () => {
  it("shows a user granted a flat entry's job only its target, runs and events", async () => {
    const admin = await login("admin", "declared admin pass");
    await call("POST", "/api/repositories/thor/actions/run_backup", admin);
    const limited = await add_user(admin, "lena", "operator", [{ job: "odin" }]);

    expect(ids(await call("GET", "/api/repositories", limited))).toEqual(["odin"]);
    expect((await call("GET", "/api/map", limited)).json().repositories.map((repository: { id: string }) => repository.id)).toEqual(["odin"]);
    expect((await call("GET", "/api/repositories/thor", limited)).statusCode).toBe(404);
    expect((await call("POST", "/api/repositories/thor/actions/run_backup", limited)).statusCode).toBe(404);
    expect((await call("GET", "/api/runs", limited)).json()).toEqual([]);
    expect((await call("GET", "/api/events", limited)).json().every((event: { target_id: string }) => event.target_id === "odin")).toBe(true);
    const [run] = (await call("GET", "/api/runs", admin)).json();
    expect((await call("GET", `/api/runs/${run.id}`, limited)).statusCode).toBe(404);
  });

  it("shows a job's targets, its repository's own runs and the hosts it uses, but not a sharing job's targets", async () => {
    await rebuild(parse_config(SHARED, "test.json"));
    const admin = await login("admin", "declared admin pass");
    const mail_runs = store.runs_for({ target_id: "mail:thor:vault", host: "thor", job: "mail", repository: "vault" });
    mail_runs.finish(mail_runs.create("backup", "borg create"), "succeeded", { exit_code: 0 });
    expect((await call("POST", "/api/repositories/mail:thor:vault/actions/compact_repo", admin)).json().success).toBe(true);
    const vic = await add_user(admin, "vic", "operator", [{ job: "nightly" }]);

    const shown = (await call("GET", "/api/repositories", vic)).json();
    expect(shown.map((target: { id: string }) => target.id)).toEqual(["nightly:odin:vault"]);
    expect(shown[0]).toMatchObject({ host: "odin", job: "nightly", repository: "vault" });
    expect((await call("GET", "/api/repositories/mail:thor:vault", vic)).statusCode).toBe(404);
    expect(ids(await call("GET", "/api/hosts", vic))).toEqual(["odin", "nas"]);
    const runs = (await call("GET", "/api/runs", vic)).json();
    expect(runs.map((run: { kind: string }) => run.kind)).toEqual(["compact"]);
    expect((await call("GET", `/api/runs/${runs[0].id}`, vic)).statusCode).toBe(200);
    expect((await call("GET", "/api/events", vic)).json().every((event: { target_id: string }) => event.target_id === "nightly:odin:vault")).toBe(true);
  });

  it("lets only an admin or a user seeing every job writing there act on the whole repository", async () => {
    await rebuild(parse_config(SHARED, "test.json"));
    const admin = await login("admin", "declared admin pass");
    const vic = await add_user(admin, "vic", "operator", [{ job: "nightly" }]);
    const bea = await add_user(admin, "bea", "operator", [{ job: "nightly" }, { job: "mail" }]);

    const refused = await call("POST", "/api/repositories/nightly:odin:vault/actions/compact_repo", vic);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toContain("every job writing there");
    expect((await call("POST", "/api/repositories/nightly:odin:vault/actions/break_lock", vic)).statusCode).toBe(403);
    expect((await call("POST", "/api/repositories/nightly:odin:vault/actions/delete_archive", vic, { archive: "a1" })).statusCode).toBe(403);
    expect((await call("POST", "/api/repositories/nightly:odin:vault/actions/prune_preview", vic)).statusCode).toBe(200);

    expect((await call("POST", "/api/repositories/mail:thor:vault/actions/compact_repo", bea)).json().success).toBe(true);
    expect((await call("GET", "/api/repositories/mail:thor:vault", bea)).json().actions.map((action: { action_id: string }) => action.action_id)).toContain("compact_repo");
    const [compact] = (await call("GET", "/api/runs", vic)).json();
    expect((await call("POST", `/api/runs/${compact.id}/cancel`, vic)).statusCode).toBe(403);
    expect((await call("POST", `/api/runs/${compact.id}/cancel`, bea)).statusCode).toBe(200);
  });

  it("shows the tasks of the jobs and repositories a user sees, and holds repository tasks to the whole-repository rule", async () => {
    await rebuild(parse_config(SHARED, "test.json"), true);
    const admin = await login("admin", "declared admin pass");
    const vic = await add_user(admin, "vic", "operator", [{ job: "nightly" }]);
    const bea = await add_user(admin, "bea", "operator", [{ job: "nightly" }, { job: "mail" }]);
    const vera = await add_user(admin, "vera", "viewer", [{ job: "nightly" }]);

    expect(ids(await call("GET", "/api/tasks", vic))).toEqual(["job:nightly:backup", "job:nightly:check", "repository:vault:compact", "repository:vault:check"]);
    expect((await call("GET", "/api/tasks", admin)).json().find((task: { id: string }) => task.id === "job:mail:backup").targets).toHaveLength(1);
    expect((await call("POST", "/api/tasks/job:mail:backup/run", vic)).statusCode).toBe(404);
    expect((await call("POST", "/api/tasks/job:nightly:backup/disable", vera)).statusCode).toBe(403);

    expect((await call("POST", "/api/tasks/repository:vault:check/run", vic)).statusCode).toBe(403);
    expect((await call("POST", "/api/tasks/repository:vault:compact/disable", vic)).statusCode).toBe(403);
    const disabled = await call("POST", "/api/tasks/repository:vault:check/disable", bea);
    expect(disabled.json()).toMatchObject({ id: "repository:vault:check", enabled: false });
    const ran = await call("POST", "/api/tasks/job:nightly:check/run", vic);
    expect(ran.statusCode).toBe(202);
    expect(ran.json()).toEqual({ id: "job:nightly:check", targets: ["nightly:odin:vault"] });
  });

  it("shows a repository no job writes to through its own grant", async () => {
    await rebuild(parse_config(SHARED, "test.json"));
    const admin = await login("admin", "declared admin pass");
    const wes = await add_user(admin, "wes", "operator", [{ repository: "media" }]);

    expect(ids(await call("GET", "/api/repositories", wes))).toEqual(["media"]);
    expect(ids(await call("GET", "/api/hosts", wes))).toEqual(["thor"]);
    expect((await call("GET", "/api/repositories/media", wes)).json().actions.map((action: { action_id: string }) => action.action_id)).toContain("compact_repo");
    expect((await call("POST", "/api/repositories/media/actions/compact_repo", wes)).json().success).toBe(true);
  });

  it("carries a user's older grant on a repository over to the jobs writing there", async () => {
    await rebuild(parse_config(SHARED, "test.json"));
    const admin = await login("admin", "declared admin pass");
    await add_user(admin, "old", "viewer", []);
    store.run("ALTER TABLE users ADD COLUMN repositories TEXT");
    store.run("UPDATE users SET repositories = ? WHERE name = 'old'", JSON.stringify(["vault"]));
    await rebuild(parse_config(SHARED, "test.json"));
    const old = await login("old", "old long password");

    expect((await call("GET", "/api/users", await login("admin", "declared admin pass"))).json().find((user: { name: string }) => user.name === "old").grants)
      .toEqual([{ job: "nightly" }, { job: "mail" }]);
    expect(ids(await call("GET", "/api/repositories", old))).toEqual(["nightly:odin:vault", "mail:thor:vault"]);
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
