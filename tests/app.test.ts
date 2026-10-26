import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { build_app } from "../src/server/app.ts";
import { hash_password } from "../src/server/auth.ts";
import { cmd_result } from "../src/server/borg/types.ts";
import type { Config } from "../src/server/config.ts";
import { Poller } from "../src/server/poller.ts";
import { Store } from "../src/server/store.ts";

const password_hash = hash_password("correct horse");

const LIST = JSON.stringify({ archives: [{ name: "a1", time: "2026-10-01T10:00:00" }, { name: "a0", time: "2026-09-30T10:00:00" }] });

// A job poll's answer while the job is still running and has written nothing.
const RUNNING = "===XBACKUPS_SIZE===\n0\n===XBACKUPS_EXIT===\n\n===XBACKUPS_ALIVE===\n1\n===XBACKUPS_OUT===\n";

const CONFIG: Config = {
  repositories: [{
    name: "odin", host: null, ssh_user: null, interval_in_seconds: 3600,
    borg: { repo: "/srv/repo", collect_stats: false, source_paths: ["/etc"] },
  }],
};

let app: FastifyInstance;
let store: Store;
let poller: Poller;
let commands: string[];
let cookie: string;

beforeEach(async () => {
  commands = [];
  store = new Store(":memory:");
  poller = new Poller(CONFIG, store, async (_target, command) => {
    commands.push(command);
    if (command.includes("kill -0")) return cmd_result(0, RUNNING, "");
    return command.includes("borg") && command.includes("list") ? cmd_result(0, LIST, "") : cmd_result(0, "4242\n", "");
  });
  app = await build_app({ serve_web: false, logger: false, password_hash, poller, store });
  const login = await app.inject({ method: "POST", url: "/api/login", payload: { password: "correct horse" } });
  cookie = String(login.headers["set-cookie"]).split(";")[0];
});

afterEach(async () => {
  poller.stop();
  await app.close();
  store.close();
});

function get(url: string) {
  return app.inject({ method: "GET", url, headers: { cookie } });
}

function post(url: string, payload: object = {}) {
  return app.inject({ method: "POST", url, payload, headers: { cookie } });
}

// ── Health ───────────────────────────────────────────────────────────────────

describe("health check", () => {
  it("reports the server and each repository's status without a login", async () => {
    await poller.poll("odin");

    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", repositories: [{ id: "odin", status: "failed" }] });
  });
});

// ── Repositories ─────────────────────────────────────────────────────────────

describe("repositories", () => {
  it("needs a login", async () => {
    expect((await app.inject({ method: "GET", url: "/api/repositories" })).statusCode).toBe(401);
  });

  it("lists each repository with its status", async () => {
    await poller.poll("odin");

    const [odin] = (await get("/api/repositories")).json();

    expect(odin).toMatchObject({ id: "odin", archive_count: 2, running_job: null });
  });

  it("shows one repository with its archives and actions", async () => {
    await poller.poll("odin");

    const odin = (await get("/api/repositories/odin")).json();

    expect(odin.archives.map((archive: { name: string }) => archive.name)).toEqual(["a1", "a0"]);
    expect(odin.actions.find((action: { action_id: string }) => action.action_id === "run_backup").state).toBe("normal");
    expect((await get("/api/repositories/thor")).statusCode).toBe(404);
  });

  it("serves the poll history", async () => {
    await poller.poll("odin");

    const history = (await get("/api/repositories/odin/history")).json();

    expect(history.polls).toHaveLength(1);
    expect(history.archives).toHaveLength(2);
  });
});

describe("archives, config and search", () => {
  it("diffs an archive once and serves its changes after", async () => {
    await poller.poll("odin");
    const diffs_before = commands.filter((command) => command.includes(" diff ")).length;

    const first = (await get("/api/repositories/odin/diff?archive=a1")).json();
    await get("/api/repositories/odin/diff?archive=a1");

    expect(first.success).toBe(true);
    expect(commands.filter((command) => command.includes(" diff ")).length).toBe(diffs_before + 1);
  });

  it("shows the declared config without its secrets", async () => {
    const config = (await get("/api/repositories/odin/config")).json();

    expect(config).toMatchObject({ source: "declared", editable: false, fields: { name: "odin", repo: "/srv/repo", interval: 3600 } });
  });

  it("finds repositories and archives by name", async () => {
    await poller.poll("odin");

    const found = (await get("/api/search?q=A1")).json();

    expect(found.archives).toEqual([{ repository_id: "odin", name: "a1", epoch: expect.any(Number) }]);
    expect((await get("/api/search?q=odi")).json().repositories).toEqual([{ id: "odin", name: "odin" }]);
  });
});

// ── Actions and jobs ─────────────────────────────────────────────────────────

describe("actions and jobs", () => {
  it("starts a backup job, shows it and cancels it", async () => {
    const started = (await post("/api/repositories/odin/actions/run_backup")).json();
    expect(started.success).toBe(true);

    const [job] = (await get("/api/jobs?repository=odin")).json();
    expect(job).toMatchObject({ kind: "backup", state: "running", pid: 4242 });
    expect((await get(`/api/jobs/${job.id}`)).json().output).toEqual([]);

    const cancelled = (await post(`/api/jobs/${job.id}/cancel`)).json();
    expect(cancelled.success).toBe(true);
    expect(commands.at(-1)).toBe("kill -TERM -- -4242");
    expect((await get(`/api/jobs/${job.id}`)).json().state).toBe("cancelled");
    expect((await post(`/api/jobs/${job.id}/cancel`)).statusCode).toBe(409);
  });

  it("answers a refusal without running anything", async () => {
    const refused = (await post("/api/repositories/odin/actions/delete_archive", { archive: "a1" })).json();

    expect(refused.success).toBe(false);
    expect(commands).toEqual([]);
  });

  it("rejects an unknown action", async () => {
    expect((await post("/api/repositories/odin/actions/format_disk")).statusCode).toBe(404);
  });

  it("runs a finished job's action again", async () => {
    await post("/api/repositories/odin/actions/run_backup");
    const [job] = (await get("/api/jobs")).json();
    expect(job.retry).toBe(false);
    expect((await post(`/api/jobs/${job.id}/retry`)).statusCode).toBe(409);
    await post(`/api/jobs/${job.id}/cancel`);
    expect((await get(`/api/jobs/${job.id}`)).json().retry).toBe(true);

    const retried = (await post(`/api/jobs/${job.id}/retry`)).json();

    expect(retried.success).toBe(true);
    expect((await get("/api/jobs?kind=backup")).json()).toHaveLength(2);
  });

  it("logs events", async () => {
    await post("/api/repositories/odin/actions/run_backup");

    const events = (await get("/api/events?repository=odin")).json();

    expect(events.some((event: { message: string }) => event.message.startsWith("Backup started"))).toBe(true);
  });
});
