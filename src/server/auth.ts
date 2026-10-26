// Guards the API with one password, read as a scrypt hash from a secret file, and a session cookie.

// ── Imports ──────────────────────────────────────────────────────────────────

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

// ── Settings ─────────────────────────────────────────────────────────────────

const cookie_name = "x_backups_session";
const session_lifetime_ms = 12 * 60 * 60 * 1000;
const key_length = 64;

// X-Monitor polls health without logging in.
const open_routes = new Set(["/api/health", "/api/login"]);

// ── Password hashes ──────────────────────────────────────────────────────────

// Stored as `scrypt$<salt hex>$<hash hex>`.
export function hash_password(password: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${scryptSync(password, salt, key_length).toString("hex")}`;
}

export function verify_password(password: string, stored: string): boolean {
  const [scheme, salt_hex, hash_hex] = stored.trim().split("$");
  if (scheme !== "scrypt" || !salt_hex || !hash_hex) return false;
  const expected = Buffer.from(hash_hex, "hex");
  const actual = scryptSync(password, Buffer.from(salt_hex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

export function load_password_hash(file_path: string | undefined = process.env.X_BACKUPS_PASSWORD_HASH_FILE): string {
  if (!file_path) {
    throw new Error("X_BACKUPS_PASSWORD_HASH_FILE is not set; create one with `npm run hash-password -- <file>`.");
  }
  const stored = readFileSync(file_path, "utf8").trim();
  if (!stored.startsWith("scrypt$")) throw new Error(`${file_path} does not hold a hash from \`npm run hash-password\`.`);
  return stored;
}

// ── Sessions ─────────────────────────────────────────────────────────────────

function read_cookie(request: FastifyRequest): string | undefined {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === cookie_name) return value.join("=");
  }
  return undefined;
}

function set_cookie(request: FastifyRequest, reply: FastifyReply, token: string, max_age_seconds: number): void {
  const secure = request.protocol === "https" ? "; Secure" : "";
  reply.header("set-cookie", `${cookie_name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${max_age_seconds}${secure}`);
}

export function register_auth(app: FastifyInstance, password_hash: string): void {
  // Token to expiry time; a restart logs everyone out.
  const sessions = new Map<string, number>();

  const session_of = (request: FastifyRequest): string | undefined => {
    const token = read_cookie(request);
    if (token === undefined) return undefined;
    const expires = sessions.get(token);
    if (expires === undefined) return undefined;
    if (expires < Date.now()) {
      sessions.delete(token);
      return undefined;
    }
    return token;
  };

  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0];
    if (!path.startsWith("/api/") || open_routes.has(path)) return;
    if (session_of(request) === undefined) return reply.code(401).send({ error: "Log in first." });
  });

  app.post<{ Body: { password?: unknown } }>("/api/login", async (request, reply) => {
    const password = request.body?.password;
    if (typeof password !== "string" || !verify_password(password, password_hash)) {
      return reply.code(401).send({ error: "Wrong password." });
    }
    const token = randomBytes(32).toString("hex");
    sessions.set(token, Date.now() + session_lifetime_ms);
    set_cookie(request, reply, token, session_lifetime_ms / 1000);
    return reply.code(204).send();
  });

  app.post("/api/logout", async (request, reply) => {
    const token = session_of(request);
    if (token !== undefined) sessions.delete(token);
    set_cookie(request, reply, "", 0);
    return reply.code(204).send();
  });
}
