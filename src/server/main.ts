// ── Imports ──────────────────────────────────────────────────────────────────

import { join } from "node:path";

import { backup_naming, keep_backing_up } from "@x-tech-laboratories/x-libs/backups";
import { LocalAgent } from "@x-tech-laboratories/x-libs/server/agents/local";
import { json_backup_schedule } from "@x-tech-laboratories/x-libs/server/backup_routes";
import { sqlite_backups, take_staged_restore } from "@x-tech-laboratories/x-libs/server/sqlite_backups";
import { read_server_config } from "@x-tech-laboratories/x-libs/server/config";

import { command_runner } from "../agent/agent.ts";
import { read_health } from "../agent/health.ts";
import { AgentHub } from "./agents/hub.ts";
import { AgentTokens } from "./agents/tokens.ts";
import { build_app } from "./app.ts";
import type { ProxySignIn } from "@x-tech-laboratories/x-libs/server/account_sign_in";
import { OidcClient, oidc_from_environment } from "@x-tech-laboratories/x-libs/server/oidc";

import { load_password_hash } from "./auth.ts";
import { own_host } from "./config.ts";
import { Poller } from "./poller.ts";
import { Scheduler } from "./scheduler.ts";
import { ConfigSources } from "./sources.ts";
import { Store } from "./store.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

const listening = read_server_config({
  program: "x-backups-server", summary: "Serves X-Backups as a web app.", env_prefix: "X_BACKUPS", default_port: 7710, secret: false,
  built_in: { host: { variable: "HOST" }, port: { variable: "PORT" } },
});
const is_production = process.env.NODE_ENV === "production";
const sources = ConfigSources.from_environment();
const config = sources.config();
const password_hash = load_password_hash();
const admin_name = (process.env.X_BACKUPS_ADMIN_NAME || "admin").toLowerCase();
const oidc_settings = oidc_from_environment("X_BACKUPS");
const state_directory = process.env.X_BACKUPS_STATE_DIR ?? "state";

// A reverse proxy that has already signed someone in names them in this header, trusted only from its own address.
const proxy_header = process.env.X_BACKUPS_PROXY_USER_HEADER?.toLowerCase();
const proxy: ProxySignIn | null = proxy_header
  ? { header: proxy_header, trusted: new Set((process.env.X_BACKUPS_TRUSTED_PROXIES || "127.0.0.1,::1").split(",").map((address) => address.trim())) }
  : null;

// ── Start ────────────────────────────────────────────────────────────────────

const database_path = Store.path_from_environment();
// A restore picked in Settings waits beside the database and is taken in here, before the database opens.
const restored = take_staged_restore(database_path);
const store = new Store(database_path);
// The state database holds the accounts, task overrides and agent tokens, so it is backed up daily; a restore stops the
// server so systemd starts it again.
const backups = sqlite_backups({
  folder: () => join(state_directory, "backups"), naming: backup_naming("x-backups", ".sqlite"), database: () => store.sql, database_path: () => database_path,
  after_staging: () => {
    app.log.info("Restarting to restore a backup");
    setTimeout(() => process.exit(75), 500);
  },
});
const backup_schedule = json_backup_schedule(join(state_directory, "backup-schedule.json"));
const automatic_backups = keep_backing_up(backups, backup_schedule.get);
// The server's own host is the managed one with no address, whose commands the built-in agent runs here; its long runs
// keep their output under the state folder, so they outlive a restart of the server.
const agents = new AgentHub(new AgentTokens(store), {
  local: { host: own_host(config.entities), agent: new LocalAgent(join(state_directory, "agent"), { runner: command_runner, requests: { health: () => read_health() } }) },
});
const poller = new Poller(config, store, agents);
// Starts every task when it falls due, reading calendar schedules in X_BACKUPS_TIMEZONE or the server's own zone.
const scheduler = new Scheduler(poller, store);
const app = await build_app({
  serve_web: is_production, logger: true, password_hash, admin_name, poller, store, sources, agents, scheduler,
  oidc: oidc_settings === null ? null : new OidcClient(oidc_settings), proxy,
  backups: { backups, schedule: backup_schedule, on_schedule_change: () => void automatic_backups.check() },
});
if (restored) app.log.info("Restored the database from the backup picked in Settings");

app.addHook("onClose", async () => {
  automatic_backups.stop();
  scheduler.stop();
  poller.stop();
  store.close();
});

app.log.info(`Watching ${config.repositories.length} repositories; config is ${sources.mode}`);
for (const name of sources.shadowed()) app.log.warn(`The page's repository '${name}' is hidden by a declared one of the same name`);
if (process.env.X_BACKUPS_SSH_KEY_FILE) app.log.warn("X_BACKUPS_SSH_KEY_FILE is no longer used: each managed host runs the X-Backups agent, which replaces SSH");

await app.listen({ host: listening.host, port: listening.port });
poller.start();
scheduler.start();
