import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { build_app } from "../src/server/app.ts";
import { hash_password } from "../src/server/auth.ts";
import { cmd_result } from "../src/server/borg/types.ts";
import type { Config } from "../src/server/config.ts";
import { Poller } from "../src/server/poller.ts";
import type { CommandStream } from "../src/server/runner.ts";
import { ConfigSources } from "../src/server/sources.ts";
import { Store } from "../src/server/store.ts";

const password_hash = hash_password("correct horse");

const LIST = JSON.stringify({ archives: [{ name: "a1", time: "2026-10-01T10:00:00" }, { name: "a0", time: "2026-09-30T10:00:00" }] });

// A job poll's answer while the job is still running and has written nothing.
const RUNNING = "===XBACKUPS_SIZE===\n0\n===XBACKUPS_EXIT===\n\n===XBACKUPS_ALIVE===\n1\n===XBACKUPS_OUT===\n";

const CONFIG: Config = {
  repositories: [{
    name: "odin", host: null, ssh_user: null, interval_in_seconds: 3600,
    borg: { repo: "/srv/repo", collect_stats: false, source_paths: ["/etc"] }, source: "declared",
  }],
};

let app: FastifyInstance;
let store: Store;
let poller: Poller;
let commands: string[];
let cookie: string;
let streamed: { command: string; stdin: string | undefined }[];
let stream_answer: { chunks: string[]; exit_code: number; stderr: string; hold?: boolean };

// Writes the chunks the test set, then ends with its exit code once they have all been read; a held stream runs until stopped.
function fake_stream(_target: unknown, command: string, options: { stdin?: string }): CommandStream {
  streamed.push({ command, stdin: options.stdin });
  const { chunks, exit_code, stderr, hold } = stream_answer;
  const stdout = new PassThrough();
  let finish: () => void = () => {};
  const done = new Promise<{ exit_code: number; stderr: string }>((resolve) => {
    finish = () => resolve({ exit_code: hold ? 143 : exit_code, stderr });
    if (hold) return;
    if (chunks.length === 0) setImmediate(finish);
    else stdout.on("end", finish);
  });
  for (const chunk of chunks) stdout.write(chunk);
  if (!hold) stdout.end();
  return { stdout, done, stop: () => { stdout.end(); finish(); } };
}

beforeEach(async () => {
  commands = [];
  streamed = [];
  stream_answer = { chunks: [], exit_code: 0, stderr: "" };
  store = new Store(":memory:");
  poller = new Poller(CONFIG, store, async (_target, command) => {
    commands.push(command);
    if (command.includes("kill -0")) return cmd_result(0, RUNNING, "");
    return command.includes("borg") && command.includes("list") ? cmd_result(0, LIST, "") : cmd_result(0, "4242\n", "");
  }, fake_stream);
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

// ── Downloads ────────────────────────────────────────────────────────────────

describe("downloads", () => {
  it("streams a file with its name and type", async () => {
    await poller.poll("odin");
    stream_answer = { chunks: ["first ", "second"], exit_code: 0, stderr: "" };

    const response = await get("/api/repositories/odin/download?archive=a1&kind=file&path=etc/r%C3%A9sum%C3%A9.txt");

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("first second");
    expect(response.headers["content-type"]).toBe("application/octet-stream");
    expect(response.headers["content-disposition"]).toBe(`attachment; filename="r_sum_.txt"; filename*=UTF-8''r%C3%A9sum%C3%A9.txt`);
    expect(streamed[0].command).toContain("extract --stdout");
  });

  it("streams folders as one tar and notes who asked", async () => {
    await poller.poll("odin");
    stream_answer = { chunks: ["tar bytes"], exit_code: 0, stderr: "" };

    const response = await get("/api/repositories/odin/download?archive=a1&kind=tar&path=etc&path=home");

    expect(response.headers["content-disposition"]).toContain(`filename="a1.tar.gz"`);
    expect(streamed[0].command).toContain("export-tar --tar-filter=gzip");
    expect(streamed[0].command).toContain("::a1 - etc home");
    expect(store.events({ repository_id: "odin" }).some((event) => event.message.includes("downloaded etc, home from a1"))).toBe(true);
  });

  it("lists a running download with who started it, and stops it", async () => {
    await poller.poll("odin");
    stream_answer = { chunks: ["partial"], exit_code: 0, stderr: "", hold: true };

    const download = app.inject({ method: "GET", url: "/api/repositories/odin/download?archive=a1&kind=tar&path=etc", headers: { cookie } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [running] = (await get("/api/repositories/odin")).json().downloads;
    expect(running).toMatchObject({ who: "admin", what: "etc from a1" });

    expect((await post(`/api/repositories/odin/downloads/${running.id}/stop`)).json()).toEqual({ ok: true });
    // A stopped download cuts the connection, so the browser marks it failed rather than complete.
    await expect(download).rejects.toThrow();
    expect((await get("/api/repositories/odin")).json().downloads).toEqual([]);
    expect((await post(`/api/repositories/odin/downloads/${running.id}/stop`)).statusCode).toBe(404);
  });

  it("answers borg's error when it fails before sending anything", async () => {
    await poller.poll("odin");
    stream_answer = { chunks: [], exit_code: 2, stderr: "Archive a1 does not exist" };

    const response = await get("/api/repositories/odin/download?archive=a1&kind=file&path=etc/hosts");

    expect(response.statusCode).toBe(502);
    expect(response.json().error).toContain("borg failed (exit 2): Archive a1 does not exist");
  });

  it("refuses an archive it has not listed without running borg", async () => {
    await poller.poll("odin");

    const response = await get("/api/repositories/odin/download?archive=nope&kind=tar&path=etc");

    expect(response.statusCode).toBe(400);
    expect(streamed).toEqual([]);
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

// ── Config from the page ─────────────────────────────────────────────────────

describe("config from the page", () => {
  let editable_app: FastifyInstance;
  let editable_poller: Poller;
  let editable_store: Store;
  let session: string;

  beforeEach(async () => {
    const directory = mkdtempSync(join(tmpdir(), "x-backups-app-"));
    const declared = join(directory, "declared.json");
    writeFileSync(declared, JSON.stringify({ repositories: [{ name: "odin", repo: "/srv/repo", collect_stats: false }] }));
    const sources = new ConfigSources({ mode: "mixed", declared_path: declared, state_dir: directory });
    editable_store = new Store(":memory:");
    editable_poller = new Poller(sources.config(), editable_store, async () => cmd_result(0, LIST, ""));
    editable_app = await build_app({ serve_web: false, logger: false, password_hash, poller: editable_poller, store: editable_store, sources });
    const login = await editable_app.inject({ method: "POST", url: "/api/login", payload: { password: "correct horse" } });
    session = String(login.headers["set-cookie"]).split(";")[0];
  });

  afterEach(async () => {
    editable_poller.stop();
    await editable_app.close();
    editable_store.close();
  });

  const send = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) =>
    editable_app.inject({ method, url, payload, headers: { cookie: session } });

  it("says how the config is kept", async () => {
    const config = (await send("GET", "/api/config")).json();

    expect(config).toMatchObject({ mode: "mixed", editable: true, shadowed: [] });
    expect(config.fields.find((field: { name: string }) => field.name === "repo")).toEqual({ name: "repo", kind: "string" });
  });

  it("adds, edits and removes a page repository, and leaves a declared one alone", async () => {
    const created = await send("POST", "/api/repositories", { name: "thor", repo: "/srv/thor", collect_stats: false });
    expect(created.statusCode).toBe(201);
    expect(editable_poller.repositories.has("thor")).toBe(true);
    expect((await send("GET", "/api/repositories/thor/config")).json()).toMatchObject({ source: "page", editable: true });
    expect((await send("GET", "/api/repositories/odin/config")).json()).toMatchObject({ source: "declared", editable: false });

    const edited = await send("PUT", "/api/repositories/thor/config", { name: "thor", repo: "/srv/thor", collect_stats: false, max_age: "3d" });
    expect(edited.statusCode).toBe(200);
    expect(editable_poller.repositories.get("thor")!.repository.max_age).toBe(3 * 86400);

    expect((await send("PUT", "/api/repositories/odin/config", { name: "odin", repo: "/x" })).statusCode).toBe(400);
    expect((await send("DELETE", "/api/repositories/thor")).statusCode).toBe(204);
    expect(editable_poller.repositories.has("thor")).toBe(false);
  });

  it("answers a bad entry with its message and field", async () => {
    const refused = await send("POST", "/api/repositories", { name: "thor", repo: "/srv/thor", max_age: "soon" });

    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ field: "max_age" });
  });

  it("saves a default the declared file leaves open", async () => {
    const saved = (await send("PUT", "/api/config/defaults", { browse_limit: 50 })).json();

    expect(saved.settings.find((setting: { name: string }) => setting.name === "browse_limit")).toEqual({ name: "browse_limit", value: 50, source: "saved" });
    expect(editable_poller.repositories.get("odin")!.repository.browse_limit).toBe(50);
  });

  it("refuses edits when the app has no editable sources", async () => {
    expect((await post("/api/repositories", { name: "thor", repo: "/srv/thor" })).statusCode).toBe(403);
  });
});
