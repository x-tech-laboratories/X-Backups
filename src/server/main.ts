// ── Imports ──────────────────────────────────────────────────────────────────

import { join } from "node:path";

import { AgentHub } from "./agents/hub.ts";
import { LocalAgent } from "./agents/local.ts";
import { AgentTokens } from "./agents/tokens.ts";
import { build_app } from "./app.ts";
import { load_password_hash, type ProxyLogin } from "./auth.ts";
import { own_host } from "./config.ts";
import { OidcClient, oidc_from_environment } from "./oidc.ts";
import { Poller } from "./poller.ts";
import { Scheduler } from "./scheduler.ts";
import { ConfigSources } from "./sources.ts";
import { Store } from "./store.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 7710);
const is_production = process.env.NODE_ENV === "production";
const sources = ConfigSources.from_environment();
const config = sources.config();
const password_hash = load_password_hash();
const admin_name = (process.env.X_BACKUPS_ADMIN_NAME || "admin").toLowerCase();
const oidc_settings = oidc_from_environment();
const state_directory = process.env.X_BACKUPS_STATE_DIR ?? "state";

// A reverse proxy that has already logged someone in names them in this header, trusted only from its own address.
const proxy_header = process.env.X_BACKUPS_PROXY_USER_HEADER?.toLowerCase();
const proxy: ProxyLogin | null = proxy_header
  ? { header: proxy_header, trusted: new Set((process.env.X_BACKUPS_TRUSTED_PROXIES || "127.0.0.1,::1").split(",").map((address) => address.trim())) }
  : null;

// ── Start ────────────────────────────────────────────────────────────────────

const store = Store.open_from_environment();
// The server's own host is the managed one with no address, whose commands the built-in agent runs here; its long runs
// keep their output under the state folder, so they outlive a restart of the server.
const agents = new AgentHub(new AgentTokens(store), {
  local: { host: own_host(config.entities), agent: new LocalAgent(join(state_directory, "agent")) },
});
const poller = new Poller(config, store, agents);
// Starts every task when it falls due, reading calendar schedules in X_BACKUPS_TIMEZONE or the server's own zone.
const scheduler = new Scheduler(poller, store);
const app = await build_app({
  serve_web: is_production, logger: true, password_hash, admin_name, poller, store, sources, agents, scheduler,
  oidc: oidc_settings === null ? null : new OidcClient(oidc_settings), proxy,
});

app.addHook("onClose", async () => {
  scheduler.stop();
  poller.stop();
  store.close();
});

app.log.info(`Watching ${config.repositories.length} repositories; config is ${sources.mode}`);
for (const name of sources.shadowed()) app.log.warn(`The page's repository '${name}' is hidden by a declared one of the same name`);
if (process.env.X_BACKUPS_SSH_KEY_FILE) app.log.warn("X_BACKUPS_SSH_KEY_FILE is no longer used: each managed host runs the X-Backups agent, which replaces SSH");

await app.listen({ host, port });
poller.start();
scheduler.start();
