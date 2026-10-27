// ── Imports ──────────────────────────────────────────────────────────────────

import { build_app } from "./app.ts";
import { load_password_hash, type ProxyLogin } from "./auth.ts";
import { OidcClient, oidc_from_environment } from "./oidc.ts";
import { Poller } from "./poller.ts";
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

// A reverse proxy that has already logged someone in names them in this header, trusted only from its own address.
const proxy_header = process.env.X_BACKUPS_PROXY_USER_HEADER?.toLowerCase();
const proxy: ProxyLogin | null = proxy_header
  ? { header: proxy_header, trusted: new Set((process.env.X_BACKUPS_TRUSTED_PROXIES || "127.0.0.1,::1").split(",").map((address) => address.trim())) }
  : null;

// ── Start ────────────────────────────────────────────────────────────────────

const store = Store.open_from_environment();
const poller = new Poller(config, store);
const app = await build_app({
  serve_web: is_production, logger: true, password_hash, admin_name, poller, store, sources,
  oidc: oidc_settings === null ? null : new OidcClient(oidc_settings), proxy,
});

app.addHook("onClose", async () => {
  poller.stop();
  store.close();
});

app.log.info(`Watching ${config.repositories.length} repositories; config is ${sources.mode}`);
for (const name of sources.shadowed()) app.log.warn(`The page's repository '${name}' is hidden by a declared one of the same name`);

await app.listen({ host, port });
poller.start();
