// Who is asking and what they may do: sessions from a password (with a second factor), a single sign-on provider or a
// trusted proxy's header, read-only API tokens, and the role each route needs.
//
// viewer sees the jobs it is granted, as access.ts reads them; operator also runs actions and reads archive contents;
// admin also changes the config, users and tokens. A token is a viewer of everything that can only read.

// ── Imports ──────────────────────────────────────────────────────────────────

import { randomBytes } from "node:crypto";
import fastify_cookie, { type CookieSerializeOptions } from "@fastify/cookie";
import fastify_rate_limit from "@fastify/rate-limit";
import fastify_session, { MemoryStore } from "@fastify/session";
import type { FastifyInstance, FastifyRequest, Session } from "fastify";

import type { Grant } from "./access.ts";
import { AccountError, has_role, type Accounts, type Role, type User } from "./accounts.ts";
import type { OidcClient } from "./oidc.ts";

export { hash_password, load_password_hash, verify_password } from "./passwords.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface Viewer {
  name: string;
  role: Role;
  // The jobs, and repositories no job writes to, the viewer is granted, or null for everything.
  grants: Grant[] | null;
  via: "session" | "token" | "proxy";
}

declare module "fastify" {
  interface FastifyRequest {
    viewer: Viewer | null;
  }

  interface Session {
    // The user the session is logged in as.
    name?: string;
  }
}

export interface ProxyLogin {
  // The header a trusted reverse proxy sets to the logged-in user's name, lowercase.
  header: string;
  // The addresses that proxy connects from; the header is ignored from anywhere else.
  trusted: Set<string>;
}

export interface AuthOptions {
  accounts: Accounts;
  oidc?: OidcClient | null;
  proxy?: ProxyLogin | null;
  // Whether the viewer sees the target; every target unless set.
  sees_target?: (request: FastifyRequest, target_id: string) => boolean;
}

// ── Settings ─────────────────────────────────────────────────────────────────

const cookie_name = "x_backups_session";
const oidc_cookie_name = "x_backups_oidc";
const session_lifetime_ms = 12 * 60 * 60 * 1000;

// One name may be tried from one address this many times in the window, then that pair waits.
const tries_allowed = 5;
const try_window = "5 minutes";

// Reached without a login; an agent proves itself with its own token instead.
const open_routes = new Set(["/api/health", "/api/agent", "/api/login", "/api/auth/info", "/api/auth/oidc/start", "/api/auth/oidc/callback"]);
const any_viewer_routes = new Set(["/api/logout", "/api/me"]);

// Reading what is inside an archive shows backed-up data, so it needs an operator like restoring does.
const archive_contents = /^\/api\/repositories\/[^/]+\/(browse|diff|download)$/;

// Issuing or revoking a host's agent token decides which machine may run commands, so it needs an admin.
const agent_token_route = /^\/api\/hosts\/[^/]+\/token$/;

// ── Route access ─────────────────────────────────────────────────────────────

// What a request needs: nothing, any login, or a role.
export function needed(method: string, path: string): "open" | "any" | Role {
  if (path === "/metrics") return "viewer";
  if (!path.startsWith("/api/") || open_routes.has(path)) return "open";
  if (any_viewer_routes.has(path) || path.startsWith("/api/account/")) return "any";
  if (path.startsWith("/api/users") || path.startsWith("/api/tokens")) return "admin";
  if (method === "POST" && (path === "/api/repositories" || path.startsWith("/api/config/"))) return "admin";
  if (agent_token_route.test(path)) return "admin";
  if (method === "PUT" || method === "DELETE") return "admin";
  if (method === "POST") return "operator";
  if (archive_contents.test(path)) return "operator";
  return "viewer";
}

// ── Cookies ──────────────────────────────────────────────────────────────────

// The login state a single sign-on provider hands back, valid for ten minutes and sent on the provider's redirect.
const oidc_cookie: CookieSerializeOptions = { path: "/", httpOnly: true, sameSite: "lax", secure: "auto", maxAge: 600 };

function as_viewer(user: User, via: Viewer["via"]): Viewer {
  return { name: user.name, role: user.role, grants: user.grants, via };
}

// ── Registration ─────────────────────────────────────────────────────────────

export async function register_auth(app: FastifyInstance, options: AuthOptions): Promise<void> {
  const { accounts, oidc = null, proxy = null, sees_target = () => true } = options;
  // Session ids to their sessions, kept in the server so a restart logs everyone out.
  const sessions = new Map<string, Session>();

  await app.register(fastify_cookie);
  await app.register(fastify_session, {
    secret: randomBytes(32).toString("hex"),
    cookieName: cookie_name,
    saveUninitialized: false,
    store: new MemoryStore(sessions),
    cookie: { path: "/", httpOnly: true, sameSite: "strict", secure: "auto", maxAge: session_lifetime_ms },
  });
  await app.register(fastify_rate_limit, {
    global: false,
    errorResponseBuilder: () => ({ statusCode: 429, error: "Too many tries; wait a few minutes." }),
  });

  // Ends every session of a user whose access changed or who was removed, except the one making the change.
  const close_user = (name: string, keep?: string) => {
    for (const [id, session] of sessions) if (session.name === name && id !== keep) sessions.delete(id);
  };

  app.decorateRequest("viewer", null);

  // Works out who is asking, then whether they may.
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0];
    request.viewer = identify(request);
    const need = needed(request.method, path);
    if (need === "open") return;
    const viewer = request.viewer;
    if (viewer === null) return reply.code(401).send({ error: "Log in first." });
    if (viewer.via === "token" && (request.method !== "GET" || need === "any")) {
      return reply.code(403).send({ error: "An API token can only read." });
    }
    if (need !== "any" && !has_role(viewer.role, need)) {
      return reply.code(403).send({ error: `This needs the ${need} role; ${viewer.name} is ${viewer.role === "admin" ? "an" : "a"} ${viewer.role}.` });
    }
    // A target the viewer may not see answers as if it did not exist.
    const repository = /^\/api\/repositories\/([^/]+)/.exec(path)?.[1];
    if (repository !== undefined && !sees_target(request, decodeURIComponent(repository))) {
      return reply.code(404).send({ error: `No repository '${decodeURIComponent(repository)}'.` });
    }
  });

  const identify = (request: FastifyRequest): Viewer | null => {
    const session_user = request.session.name;
    if (session_user !== undefined) {
      const user = accounts.user(session_user);
      if (user !== null) return as_viewer(user, "session");
    }
    const authorization = request.headers.authorization ?? "";
    if (authorization.startsWith("Bearer ")) {
      const token_name = accounts.check_token(authorization.slice("Bearer ".length).trim());
      if (token_name !== null) return { name: `token:${token_name}`, role: "viewer", grants: null, via: "token" };
    }
    if (proxy !== null && proxy.trusted.has(request.ip)) {
      const header = request.headers[proxy.header];
      const user = typeof header === "string" ? accounts.user(header.trim().toLowerCase()) : null;
      if (user !== null) return as_viewer(user, "proxy");
    }
    return null;
  };

  // A fresh session id at login, so one handed out before it cannot ride along.
  const start_session = async (request: FastifyRequest, name: string) => {
    await request.session.regenerate();
    request.session.name = name;
  };

  const login_name = (request: FastifyRequest) => {
    const body = request.body as { name?: unknown } | undefined;
    return typeof body?.name === "string" && body.name.trim() ? body.name.trim().toLowerCase() : accounts.admin_name;
  };

  // ── Login ────────────────────────────────────────────────────────────────

  app.get("/api/auth/info", async () => ({ oidc: oidc === null ? null : { label: oidc.settings.label }, admin_name: accounts.admin_name }));

  // Tries are counted per name and address once the body is read, whether they succeed or not.
  app.post<{ Body: { name?: unknown; password?: unknown; code?: unknown } }>("/api/login", {
    config: { rateLimit: { max: tries_allowed, timeWindow: try_window, hook: "preHandler", keyGenerator: (request) => `${request.ip}\n${login_name(request)}` } },
  }, async (request, reply) => {
    const name = login_name(request);
    const password = request.body?.password;
    const code = typeof request.body?.code === "string" ? request.body.code : undefined;
    const { user, needs_code } = typeof password === "string" ? accounts.authenticate(name, password, code) : { user: null, needs_code: false };
    if (user === null) {
      if (needs_code) return reply.code(401).send({ error: code ? "That code does not match." : "Enter the code from your authenticator app.", totp_required: true });
      return reply.code(401).send({ error: "Wrong name or password." });
    }
    await start_session(request, user.name);
    return reply.code(204).send();
  });

  app.post("/api/logout", async (request, reply) => {
    await request.session.destroy();
    return reply.code(204).send();
  });

  app.get("/api/me", async (request) => {
    const viewer = request.viewer!;
    const user = viewer.via === "token" ? null : accounts.user(viewer.name);
    return { ...viewer, totp_enabled: user?.totp_enabled ?? false, source: user?.source ?? null, has_password: user?.has_password ?? false };
  });

  // ── Single sign-on ───────────────────────────────────────────────────────

  if (oidc !== null) {
    app.get("/api/auth/oidc/start", async (_request, reply) => {
      const url = await oidc.start();
      // The state goes back in a cookie too, so only the browser that started a login can finish it.
      const state = new URL(url).searchParams.get("state")!;
      reply.setCookie(oidc_cookie_name, state, oidc_cookie);
      return reply.redirect(url);
    });

    app.get<{ Querystring: { state?: string; code?: string; error?: string; error_description?: string } }>("/api/auth/oidc/callback", async (request, reply) => {
      const fail = (message: string) => reply.redirect(`/#/?login_error=${encodeURIComponent(message)}`);
      const { state = "", code = "", error, error_description } = request.query;
      if (error) return fail(`The provider refused the login: ${error_description ?? error}`);
      if (!state || state !== request.cookies[oidc_cookie_name]) return fail("That login was started in another browser; start again.");
      try {
        const name = (await oidc.finish(state, code)).toLowerCase();
        const user = accounts.user(name);
        if (user === null) return fail(`There is no X-Backups user named '${name}'; an admin adds one first.`);
        reply.clearCookie(oidc_cookie_name, oidc_cookie);
        await start_session(request, user.name);
        return reply.redirect("/");
      } catch (problem) {
        return fail((problem as Error).message);
      }
    });
  }

  // ── Own account ──────────────────────────────────────────────────────────

  app.put<{ Body: { current?: unknown; next?: unknown } }>("/api/account/password", async (request) => {
    accounts.change_password(request.viewer!.name, request.body?.current, request.body?.next);
    close_user(request.viewer!.name, request.session.sessionId);
    return { ok: true };
  });

  app.post("/api/account/totp/start", async (request) => accounts.start_totp(request.viewer!.name));

  app.post<{ Body: { code?: unknown } }>("/api/account/totp/confirm", async (request) =>
    ({ recovery_codes: accounts.confirm_totp(request.viewer!.name, request.body?.code) }));

  app.post<{ Body: { code?: unknown } }>("/api/account/totp/disable", async (request) => {
    accounts.disable_totp(request.viewer!.name, request.body?.code);
    return { ok: true };
  });

  // ── Users and tokens ─────────────────────────────────────────────────────

  app.get("/api/users", async () => accounts.users());

  app.post<{ Body: Record<string, unknown> }>("/api/users", async (request, reply) => {
    const body = request.body ?? {};
    const user = accounts.create_user({ name: body.name, role: body.role, grants: body.grants, password: body.password });
    request.log.info(`${request.viewer!.name} added the user ${user.name} as ${user.role}`);
    return reply.code(201).send(user);
  });

  app.put<{ Params: { name: string }; Body: Record<string, unknown> }>("/api/users/:name", async (request) => {
    const body = request.body ?? {};
    const user = accounts.update_user(request.params.name, { role: body.role, grants: body.grants, password: body.password });
    close_user(user.name);
    request.log.info(`${request.viewer!.name} changed the user ${user.name}`);
    return user;
  });

  app.delete<{ Params: { name: string } }>("/api/users/:name", async (request, reply) => {
    if (request.params.name === request.viewer!.name) throw new AccountError("You cannot remove yourself.", 403);
    accounts.delete_user(request.params.name);
    close_user(request.params.name);
    request.log.info(`${request.viewer!.name} removed the user ${request.params.name}`);
    return reply.code(204).send();
  });

  app.post<{ Params: { name: string } }>("/api/users/:name/totp/reset", async (request) => {
    if (accounts.user(request.params.name) === null) throw new AccountError(`No user named '${request.params.name}'.`, 404);
    accounts.reset_totp(request.params.name);
    request.log.info(`${request.viewer!.name} reset the second factor of ${request.params.name}`);
    return { ok: true };
  });

  app.get("/api/tokens", async () => accounts.tokens());

  app.post<{ Body: { name?: unknown } }>("/api/tokens", async (request, reply) => {
    const created = accounts.create_token(request.body?.name, request.viewer!.name);
    request.log.info(`${request.viewer!.name} created the API token ${created.id}`);
    return reply.code(201).send(created);
  });

  app.delete<{ Params: { id: string } }>("/api/tokens/:id", async (request, reply) => {
    accounts.delete_token(Number(request.params.id));
    return reply.code(204).send();
  });
}
