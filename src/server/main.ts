// ── Imports ──────────────────────────────────────────────────────────────────

import { build_app } from "./app.ts";
import { load_password_hash } from "./auth.ts";
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

// ── Start ────────────────────────────────────────────────────────────────────

const store = Store.open_from_environment();
const poller = new Poller(config, store);
const app = await build_app({ serve_web: is_production, logger: true, password_hash, poller, store, sources });

app.addHook("onClose", async () => {
  poller.stop();
  store.close();
});

app.log.info(`Watching ${config.repositories.length} repositories; config is ${sources.mode}`);
for (const name of sources.shadowed()) app.log.warn(`The page's repository '${name}' is hidden by a declared one of the same name`);

await app.listen({ host, port });
poller.start();
