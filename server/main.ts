// ── Imports ──────────────────────────────────────────────────────────────────

import { build_app } from "./app.ts";
import { load_config } from "./config.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 7710);
const is_production = process.env.NODE_ENV === "production";
const config = load_config();

// ── Start ────────────────────────────────────────────────────────────────────

const app = await build_app({ serve_web: is_production, logger: true });

app.log.info(`Watching ${config.repositories.length} repositories`);

await app.listen({ host, port });
