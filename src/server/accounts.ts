// Who may log in and what each may do: users with a role and the repositories they see, their second factor, and
// read-only API tokens.
//
// The admin whose password hash comes from X_BACKUPS_PASSWORD_HASH_FILE is declared: the page cannot change its role or
// password, only its second factor. Every other user and token lives in the store and is managed from the page.

// ── Imports ──────────────────────────────────────────────────────────────────

import { createHash, randomBytes } from "node:crypto";

import { hash_password, verify_password } from "./passwords.ts";
import type { Store } from "./store.ts";
import { matching_step, new_secret, otpauth_uri } from "./totp.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

// Each role can do what the ones before it can.
export const roles = ["viewer", "operator", "admin"] as const;
export type Role = (typeof roles)[number];

export interface User {
  name: string;
  role: Role;
  // The repository ids the user sees, or null for all of them.
  repositories: string[] | null;
  totp_enabled: boolean;
  has_password: boolean;
  source: "declared" | "page";
  created_epoch: number;
}

export interface Token {
  id: number;
  name: string;
  created_by: string;
  created_epoch: number;
  last_used_epoch: number | null;
}

export class AccountError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "AccountError";
    this.status = status;
  }
}

const name_pattern = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const shortest_password = 12;
const recovery_code_count = 8;

export function has_role(role: Role, needed: Role): boolean {
  return roles.indexOf(role) >= roles.indexOf(needed);
}

// ── Accounts ─────────────────────────────────────────────────────────────────

export class Accounts {
  private readonly store: Store;
  readonly admin_name: string;
  private readonly admin_hash: string;

  constructor(store: Store, admin: { name: string; password_hash: string }) {
    this.store = store;
    this.admin_name = admin.name;
    this.admin_hash = admin.password_hash;
  }

  // ── Users ────────────────────────────────────────────────────────────────

  user(name: string): User | null {
    const row = this.store.get("SELECT * FROM users WHERE name = ?", name);
    if (name === this.admin_name) {
      return {
        name, role: "admin", repositories: null, has_password: true, source: "declared",
        totp_enabled: Boolean(row?.totp_secret), created_epoch: Number(row?.created_epoch ?? 0),
      };
    }
    return row ? user_row(row) : null;
  }

  users(): User[] {
    const page = this.store.all("SELECT * FROM users WHERE name != ? ORDER BY name", this.admin_name).map(user_row);
    return [this.user(this.admin_name)!, ...page];
  }

  // Checks the password and, when the user has one, the second factor; a recovery code stands in for a code once.
  authenticate(name: string, password: string, code: string | undefined): { user: User | null; needs_code: boolean } {
    const user = this.user(name);
    const stored = name === this.admin_name ? this.admin_hash : this.password_hash(name);
    // A missing user still costs a hash, so timing does not tell which names exist.
    const password_ok = verify_password(password, stored ?? hash_password("not a real password"));
    if (user === null || stored === null || !password_ok) return { user: null, needs_code: false };
    if (!user.totp_enabled) return { user, needs_code: false };
    if (!code) return { user: null, needs_code: true };
    return { user: this.second_factor(name, code) ? user : null, needs_code: true };
  }

  create_user(fields: { name: unknown; role: unknown; repositories: unknown; password: unknown }): User {
    const name = String(fields.name ?? "").trim();
    if (!name_pattern.test(name)) throw new AccountError("A user name is lowercase letters, digits, '.', '_' or '-', starting with a letter or digit.");
    if (name === this.admin_name || this.store.get("SELECT name FROM users WHERE name = ?", name)) {
      throw new AccountError(`A user named '${name}' already exists.`, 409);
    }
    const role = check_role(fields.role);
    const repositories = check_repositories(fields.repositories);
    const password = fields.password === undefined || fields.password === "" ? null : check_password(fields.password);
    this.store.run(
      "INSERT INTO users (name, role, repositories, password_hash, created_epoch) VALUES (?, ?, ?, ?, ?)",
      name, role, repositories === null ? null : JSON.stringify(repositories), password === null ? null : hash_password(password), now_seconds(),
    );
    return this.user(name)!;
  }

  update_user(name: string, fields: { role?: unknown; repositories?: unknown; password?: unknown }): User {
    this.refuse_declared(name, "its role, repositories and password are set where X-Backups is deployed");
    if (this.user(name) === null) throw new AccountError(`No user named '${name}'.`, 404);
    if (fields.role !== undefined) this.store.run("UPDATE users SET role = ? WHERE name = ?", check_role(fields.role), name);
    if (fields.repositories !== undefined) {
      const repositories = check_repositories(fields.repositories);
      this.store.run("UPDATE users SET repositories = ? WHERE name = ?", repositories === null ? null : JSON.stringify(repositories), name);
    }
    if (fields.password !== undefined && fields.password !== "") {
      this.store.run("UPDATE users SET password_hash = ? WHERE name = ?", hash_password(check_password(fields.password)), name);
    }
    return this.user(name)!;
  }

  delete_user(name: string): void {
    this.refuse_declared(name, "it is the login X-Backups is deployed with");
    if (this.user(name) === null) throw new AccountError(`No user named '${name}'.`, 404);
    this.store.run("DELETE FROM users WHERE name = ?", name);
  }

  change_password(name: string, current: unknown, next: unknown): void {
    this.refuse_declared(name, "its password is the hash file X-Backups is deployed with");
    const stored = this.password_hash(name);
    if (stored === null || typeof current !== "string" || !verify_password(current, stored)) {
      throw new AccountError("The current password is wrong.", 403);
    }
    this.store.run("UPDATE users SET password_hash = ? WHERE name = ?", hash_password(check_password(next)), name);
  }

  // ── Second factor ────────────────────────────────────────────────────────

  // Starts setting up a second factor: the secret waits until a code from it proves the app has it.
  start_totp(name: string): { secret: string; uri: string } {
    this.ensure_row(name);
    const secret = new_secret();
    this.store.run("UPDATE users SET totp_pending = ? WHERE name = ?", secret, name);
    return { secret, uri: otpauth_uri(secret, name) };
  }

  confirm_totp(name: string, code: unknown): string[] {
    const row = this.store.get("SELECT totp_pending FROM users WHERE name = ?", name);
    const pending = row?.totp_pending ? String(row.totp_pending) : null;
    if (pending === null) throw new AccountError("Start setting up the second factor first.");
    const step = matching_step(pending, String(code ?? ""));
    if (step === null) throw new AccountError("That code does not match; check the phone's clock and try the next one.");
    const codes = Array.from({ length: recovery_code_count }, () => randomBytes(5).toString("hex"));
    this.store.run(
      "UPDATE users SET totp_secret = ?, totp_pending = NULL, totp_last_step = ?, recovery_codes = ? WHERE name = ?",
      pending, step, JSON.stringify(codes.map(digest)), name,
    );
    return codes;
  }

  disable_totp(name: string, code: unknown): void {
    if (!this.second_factor(name, String(code ?? ""))) throw new AccountError("That code does not match.", 403);
    this.reset_totp(name);
  }

  // For an admin helping someone who lost their phone.
  reset_totp(name: string): void {
    this.store.run("UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_last_step = NULL, recovery_codes = NULL WHERE name = ?", name);
  }

  // A code from the app, each used once, or one of the recovery codes, each used once.
  private second_factor(name: string, code: string): boolean {
    const row = this.store.get("SELECT totp_secret, totp_last_step, recovery_codes FROM users WHERE name = ?", name);
    if (!row?.totp_secret) return false;
    const step = matching_step(String(row.totp_secret), code);
    if (step !== null) {
      if (row.totp_last_step !== null && step <= Number(row.totp_last_step)) return false;
      this.store.run("UPDATE users SET totp_last_step = ? WHERE name = ?", step, name);
      return true;
    }
    const recovery = JSON.parse(String(row.recovery_codes ?? "[]")) as string[];
    const index = recovery.indexOf(digest(code.trim().toLowerCase()));
    if (index === -1) return false;
    recovery.splice(index, 1);
    this.store.run("UPDATE users SET recovery_codes = ? WHERE name = ?", JSON.stringify(recovery), name);
    return true;
  }

  // ── Tokens ───────────────────────────────────────────────────────────────

  // A read-only token, shown once; only its digest is kept.
  create_token(name: unknown, created_by: string): { token: string; id: number } {
    const label = String(name ?? "").trim();
    if (!label || label.length > 64) throw new AccountError("Give the token a name of up to 64 characters, such as what will use it.");
    const token = `xb_${randomBytes(32).toString("base64url")}`;
    const id = this.store.run(
      "INSERT INTO tokens (name, hash, created_by, created_epoch) VALUES (?, ?, ?, ?)", label, digest(token), created_by, now_seconds(),
    );
    return { token, id };
  }

  tokens(): Token[] {
    return this.store.all("SELECT id, name, created_by, created_epoch, last_used_epoch FROM tokens ORDER BY id").map((row) => ({
      id: Number(row.id),
      name: String(row.name),
      created_by: String(row.created_by),
      created_epoch: Number(row.created_epoch),
      last_used_epoch: row.last_used_epoch === null ? null : Number(row.last_used_epoch),
    }));
  }

  delete_token(id: number): void {
    this.store.run("DELETE FROM tokens WHERE id = ?", id);
  }

  // The token's name when it is valid, noting when it was last used.
  check_token(token: string): string | null {
    const row = this.store.get("SELECT id, name FROM tokens WHERE hash = ?", digest(token));
    if (!row) return null;
    this.store.run("UPDATE tokens SET last_used_epoch = ? WHERE id = ?", now_seconds(), Number(row.id));
    return String(row.name);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private password_hash(name: string): string | null {
    const row = this.store.get("SELECT password_hash FROM users WHERE name = ?", name);
    return row?.password_hash ? String(row.password_hash) : null;
  }

  private refuse_declared(name: string, why: string): void {
    if (name === this.admin_name) throw new AccountError(`'${name}' cannot be changed here: ${why}.`, 403);
  }

  // The declared admin has no row until its second factor needs one.
  private ensure_row(name: string): void {
    if (this.store.get("SELECT name FROM users WHERE name = ?", name)) return;
    if (name !== this.admin_name) throw new AccountError(`No user named '${name}'.`, 404);
    this.store.run("INSERT INTO users (name, role, created_epoch) VALUES (?, 'admin', ?)", name, now_seconds());
  }
}

// ── Checks ───────────────────────────────────────────────────────────────────

function check_role(value: unknown): Role {
  if (!roles.includes(value as Role)) throw new AccountError(`The role must be ${roles.join(", ")}.`);
  return value as Role;
}

function check_repositories(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new AccountError("Repositories must be a list of repository ids, or null for all of them.");
  }
  return [...new Set(value as string[])];
}

function check_password(value: unknown): string {
  if (typeof value !== "string" || value.length < shortest_password) {
    throw new AccountError(`A password needs at least ${shortest_password} characters.`);
  }
  return value;
}

function user_row(row: Record<string, unknown>): User {
  return {
    name: String(row.name),
    role: row.role as Role,
    repositories: row.repositories === null ? null : JSON.parse(String(row.repositories)) as string[],
    totp_enabled: Boolean(row.totp_secret),
    has_password: Boolean(row.password_hash),
    source: "page",
    created_epoch: Number(row.created_epoch),
  };
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function now_seconds(): number {
  return Math.floor(Date.now() / 1000);
}
