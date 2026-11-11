import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { backup_naming } from "@x-tech-laboratories/x-libs/backups";
import { json_backup_schedule } from "@x-tech-laboratories/x-libs/server/backup_routes";
import { sqlite_backups, take_staged_restore } from "@x-tech-laboratories/x-libs/server/sqlite_backups";
import type { FastifyInstance } from "fastify";
import { afterEach, expect, it, vi } from "vitest";

import { AgentHub } from "../src/server/agents/hub.ts";
import { AgentTokens } from "../src/server/agents/tokens.ts";
import { build_app } from "../src/server/app.ts";
import { hash_password, needed } from "../src/server/auth.ts";
import { parse_config } from "../src/server/config.ts";
import { Poller } from "../src/server/poller.ts";
import { Store } from "../src/server/store.ts";
import { FakeAgent } from "./agents/fake_agent.ts";

let app: FastifyInstance | null = null;
let poller: Poller | null = null;

afterEach(async () => {
  poller?.stop();
  await app?.close();
  app = null;
  vi.useRealTimers();
});

it("lets every viewer list the backups and only an admin change them", () => {
  expect(needed("GET", "/api/backups")).toEqual({ role: "viewer" });
  expect(needed("POST", "/api/backups")).toEqual({ role: "admin" });
  expect(needed("POST", "/api/backups/x-backups-2026-11-10T09-00-00Z.sqlite/restore")).toEqual({ role: "admin" });
  expect(needed("PUT", "/api/backups/schedule")).toEqual({ role: "admin" });
});

it("backs up the state database from Settings and stages a restore for the next start", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-10T09:00:00Z"), toFake: ["Date"] });
  const folder = mkdtempSync(join(tmpdir(), "x-backups-backups-"));
  const path = join(folder, "x-backups.sqlite");
  const store = new Store(path);
  const after_staging = vi.fn();
  const backups = sqlite_backups({ folder: () => join(folder, "backups"), naming: backup_naming("x-backups", ".sqlite"), database: () => store.sql, database_path: () => path, after_staging });
  poller = new Poller(parse_config(JSON.stringify({ repositories: [] }), "test"), store, new AgentHub(new AgentTokens(store), { local: { host: "local", agent: new FakeAgent() } }));
  app = await build_app({
    serve_web: false, logger: false, password_hash: hash_password("correct horse"), poller, store,
    backups: { backups, schedule: json_backup_schedule(join(folder, "backup-schedule.json")) },
  });
  const login = await app.inject({ method: "POST", url: "/api/login", payload: { name: "admin", password: "correct horse" } });
  const cookie = String(login.headers["set-cookie"]).split(";")[0];

  const taken = (await app.inject({ method: "POST", url: "/api/backups", headers: { cookie } })).json<{ name: string }>();
  vi.setSystemTime(new Date("2026-11-10T10:00:00Z"));
  expect((await app.inject({ method: "POST", url: `/api/backups/${taken.name}/restore`, headers: { cookie } })).statusCode).toBe(204);
  expect(after_staging).toHaveBeenCalled();

  await app.close();
  app = null;
  poller.stop();
  poller = null;
  store.close();
  expect(take_staged_restore(path)).toBe(true);
});
