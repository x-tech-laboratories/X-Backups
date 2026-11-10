// Who is asking and what they may do, on the X-Libs accounts: the role each route needs, the jobs each user is
// granted, and the users and tokens kept from before the accounts moved there.
//
// viewer sees the jobs it is granted, as access.ts reads them; operator also runs actions and reads archive contents;
// admin also changes the config, users and tokens. A read-only token can only make GET requests.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { DatabaseSync } from "node:sqlite";

import { register_accounts, type Need, type ProxySignIn } from "@x-tech-laboratories/x-libs/server/account_sign_in";
import { AccountError, type AccountStore } from "@x-tech-laboratories/x-libs/server/account_store";
import type { OidcClient } from "@x-tech-laboratories/x-libs/server/oidc";
import { path_of } from "@x-tech-laboratories/x-libs/server/sign_in";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { distinct_grants, type Grant } from "./access.ts";

export { hash_password, load_password_hash, verify_password } from "./passwords.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

// Each role can do what the ones before it can.
export const roles = ["viewer", "operator", "admin"] as const;
export type Role = (typeof roles)[number];

export interface AuthOptions {
  accounts: AccountStore;
  oidc?: OidcClient | null;
  proxy?: ProxySignIn | null;
  // Whether the viewer sees the target; every target unless set.
  sees_target?: (request: FastifyRequest, target_id: string) => boolean;
}

// ── Route access ─────────────────────────────────────────────────────────────

// Reached without signing in; an agent proves itself with its own token instead.
const open_routes = ["/api/health", "/api/agent"];

// Reading what is inside an archive shows backed-up data, so it needs an operator like restoring does.
const archive_contents = /^\/api\/repositories\/[^/]+\/(browse|diff|download)$/;

// Issuing or revoking a host's agent token decides which machine may run commands, so it needs an admin.
const agent_token_route = /^\/api\/hosts\/[^/]+\/token$/;

// What one of X-Backups' own routes needs; the account routes are X-Libs' to decide.
export function needed(method: string, path: string): Need {
  if (open_routes.includes(path)) return "open";
  if (path === "/metrics") return { role: "viewer" };
  if (method === "POST" && (path === "/api/repositories" || path.startsWith("/api/config/"))) return { role: "admin" };
  if (agent_token_route.test(path)) return { role: "admin" };
  if (method === "PUT" || method === "DELETE") return { role: "admin" };
  if (method === "POST") return { role: "operator" };
  if (archive_contents.test(path)) return { role: "operator" };
  return { role: "viewer" };
}

// Whether the role is at least the one needed.
export function has_role(role: string, needed_role: Role): boolean {
  return roles.indexOf(role as Role) >= roles.indexOf(needed_role);
}

// The jobs the request's viewer is granted, or null for everything.
export function grants_of(request: FastifyRequest): Grant[] | null {
  return (request.viewer?.access ?? null) as Grant[] | null;
}

// A list of { job } and { repository } grants, or null for everything.
export function check_grants(value: unknown): Grant[] | null {
  if (value === null || value === undefined) return null;
  const is_grant = (item: unknown): item is Grant => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
    const keys = Object.keys(item);
    const [key] = keys;
    return keys.length === 1 && (key === "job" || key === "repository") && typeof (item as Record<string, unknown>)[key!] === "string";
  };
  if (!Array.isArray(value) || !value.every(is_grant)) {
    throw new AccountError('Grants must be a list of { "job": name } and { "repository": name }, or null for everything.');
  }
  return distinct_grants(value);
}

// ── Registration ─────────────────────────────────────────────────────────────

export async function register_auth(app: FastifyInstance, options: AuthOptions): Promise<void> {
  const { accounts, oidc = null, proxy = null, sees_target = () => true } = options;

  await register_accounts(app, {
    accounts, oidc, proxy, needed, cookie_name: "x_backups_session", open_paths: open_routes, guarded_paths: ["/metrics"],
  });

  // A repository the viewer may not see answers as if it did not exist.
  app.addHook("onRequest", async (request, reply) => {
    if (request.viewer === null) return;
    const repository = /^\/api\/repositories\/([^/]+)/.exec(path_of(request))?.[1];
    if (repository !== undefined && !sees_target(request, decodeURIComponent(repository))) {
      return reply.code(404).send({ error: `No repository '${decodeURIComponent(repository)}'.` });
    }
  });
}

// ── Older accounts ───────────────────────────────────────────────────────────

// Moves the users and tokens X-Backups kept itself into the X-Libs tables, once; a token keeps acting read-only, as its maker.
export function adopt_old_accounts(database: DatabaseSync): void {
  const has_table = (name: string) => database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
  if (has_table("users")) {
    database.exec(`
      INSERT OR IGNORE INTO account_users (name, role, access, password_hash, totp_secret, totp_pending, totp_last_step, recovery_codes, created_epoch)
        SELECT name, role, jobs, password_hash, totp_secret, totp_pending, totp_last_step, recovery_codes, created_epoch FROM users;
      DROP TABLE users;
    `);
  }
  if (has_table("tokens")) {
    database.exec(`
      INSERT OR IGNORE INTO account_tokens (name, hash, owner, read_only, created_epoch, last_used_epoch)
        SELECT name, hash, created_by, 1, created_epoch, last_used_epoch FROM tokens;
      DROP TABLE tokens;
    `);
  }
}
