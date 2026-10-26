// ── Imports ──────────────────────────────────────────────────────────────────

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fastify, { type FastifyInstance } from "fastify";
import fastify_static from "@fastify/static";

// ── Settings ─────────────────────────────────────────────────────────────────

export interface app_options {
  serve_web: boolean;
  logger: boolean;
}

const web_build_directory = fileURLToPath(new URL("../dist", import.meta.url));

// ── App ──────────────────────────────────────────────────────────────────────

export async function build_app(options: app_options): Promise<FastifyInstance> {
  const app = fastify({ logger: options.logger });

  app.get("/api/health", async () => ({ status: "ok" }));

  // In production the server also hands out the built web page.
  if (options.serve_web && existsSync(web_build_directory)) {
    await app.register(fastify_static, { root: web_build_directory });
  }

  return app;
}
