import { AccountStore, digest } from "@x-tech-laboratories/x-libs/server/account_store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { adopt_old_accounts, check_grants, has_role, roles } from "../src/server/auth.ts";
import { hash_password } from "../src/server/passwords.ts";
import { Store } from "../src/server/store.ts";

let store: Store;

beforeEach(() => {
  store = new Store(":memory:");
});

afterEach(() => store.close());

function account_store(): AccountStore {
  return new AccountStore({
    database: store.sql, app_name: "X-Backups", roles, check_access: check_grants, token_prefix: "xb",
    declared: new Map([["admin", hash_password("declared admin pass")]]),
  });
}

describe("grants", () => {
  it("keeps each grant once and refuses anything but job and repository grants", () => {
    expect(check_grants([{ job: "web" }, { repository: "media" }, { job: "web" }])).toEqual([{ job: "web" }, { repository: "media" }]);
    expect(check_grants(null)).toBeNull();
    expect(() => check_grants(["odin"])).toThrow("Grants must be");
    expect(() => check_grants([{ job: "odin", repository: "odin" }])).toThrow("Grants must be");
  });

  it("orders the roles", () => {
    expect(has_role("admin", "operator")).toBe(true);
    expect(has_role("viewer", "operator")).toBe(false);
  });
});

describe("older accounts", () => {
  it("moves users with their grants, and tokens as read-only ones of their maker", () => {
    store.run(`CREATE TABLE users (name TEXT PRIMARY KEY, role TEXT NOT NULL, jobs TEXT, password_hash TEXT, totp_secret TEXT,
      totp_pending TEXT, totp_last_step INTEGER, recovery_codes TEXT, created_epoch INTEGER NOT NULL)`);
    store.run(`CREATE TABLE tokens (id INTEGER PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL,
      created_epoch INTEGER NOT NULL, last_used_epoch INTEGER)`);
    store.run("INSERT INTO users (name, role, jobs, password_hash, created_epoch) VALUES ('alice', 'operator', ?, ?, 0)",
      JSON.stringify([{ job: "odin" }]), hash_password("a long enough pass"));
    store.run("INSERT INTO tokens (name, hash, created_by, created_epoch) VALUES ('prometheus', ?, 'admin', 0)", digest("xb_old"));
    const accounts = account_store();

    adopt_old_accounts(store.sql);

    expect(accounts.authenticate("alice", "a long enough pass", undefined).user).toMatchObject({ role: "operator", access: [{ job: "odin" }] });
    expect(accounts.check_token("xb_old")).toMatchObject({ name: "prometheus", owner: "admin", read_only: true });
    expect(store.all("SELECT name FROM sqlite_master WHERE name IN ('users', 'tokens')")).toEqual([]);
  });
});
