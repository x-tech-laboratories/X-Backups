// The WebSocket agents dial in on. The token in the upgrade's Authorization header names the host, so a bad one is
// refused before any socket opens.

// ── Imports ──────────────────────────────────────────────────────────────────

import fastify_websocket from "@fastify/websocket";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { ServerSocket } from "./connection.ts";
import type { AgentHub } from "./hub.ts";

// A run's output can be large, so one message may be up to this size.
const largest_message_in_bytes = 64 * 1024 * 1024;

// ── Route ────────────────────────────────────────────────────────────────────

export async function register_agent_route(app: FastifyInstance, hub: AgentHub): Promise<void> {
  await app.register(fastify_websocket, { options: { maxPayload: largest_message_in_bytes } });
  const hosts = new WeakMap<FastifyRequest, string>();

  app.get("/api/agent", {
    websocket: true,
    preValidation: async (request, reply) => {
      const host = hub.authenticate(request.headers.authorization);
      if (host === null) return reply.code(401).send({ error: "This agent token is not enrolled." });
      hosts.set(request, host);
    },
  }, (socket, request) => hub.accept(socket as unknown as ServerSocket, hosts.get(request)!));

  app.addHook("onClose", async () => hub.close());
}
