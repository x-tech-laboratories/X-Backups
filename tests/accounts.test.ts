import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Accounts, has_role } from "../src/server/accounts.ts";
import { hash_password } from "../src/server/passwords.ts";
import { Store } from "../src/server/store.ts";
import { code_at } from "../src/server/totp.ts";

let store: Store;
let accounts: Accounts;

beforeEach(() => {
  store = new Store(":memory:");
  accounts = new Accounts(store, { name: "admin", password_hash: hash_password("declared admin pass") });
});

afterEach(() => store.close());

describe("users", () => {
  it("logs the declared admin in with the hash file's password", () => {
    expect(accounts.authenticate("admin", "declared admin pass", undefined).user).toMatchObject({ name: "admin", role: "admin", source: "declared" });
    expect(accounts.authenticate("admin", "wrong", undefined).user).toBeNull();
  });

  it("adds a user with a role and grants, and refuses bad ones", () => {
    accounts.create_user({ name: "alice", role: "operator", grants: [{ job: "odin" }], password: "a long enough pass" });

    expect(accounts.authenticate("alice", "a long enough pass", undefined).user).toMatchObject({ role: "operator", grants: [{ job: "odin" }] });
    expect(() => accounts.create_user({ name: "alice", role: "viewer", grants: null, password: "a long enough pass" })).toThrow("already exists");
    expect(() => accounts.create_user({ name: "Bob Smith", role: "viewer", grants: null, password: "a long enough pass" })).toThrow("lowercase");
    expect(() => accounts.create_user({ name: "bob", role: "root", grants: null, password: "a long enough pass" })).toThrow("role must be");
    expect(() => accounts.create_user({ name: "bob", role: "viewer", grants: null, password: "short" })).toThrow("at least 12");
    expect(() => accounts.create_user({ name: "bob", role: "viewer", grants: ["odin"], password: "a long enough pass" })).toThrow("Grants must be");
    expect(() => accounts.create_user({ name: "bob", role: "viewer", grants: [{ job: "odin", repository: "odin" }], password: "a long enough pass" })).toThrow("Grants must be");
  });

  it("keeps each grant once", () => {
    const grants = [{ job: "web" }, { repository: "media" }, { job: "web" }];
    expect(accounts.create_user({ name: "bob", role: "viewer", grants, password: "a long enough pass" }).grants).toEqual([{ job: "web" }, { repository: "media" }]);
    expect(accounts.update_user("bob", { grants: [] }).grants).toEqual([]);
    expect(accounts.update_user("bob", { grants: null }).grants).toBeNull();
  });

  it("leaves the declared admin's role and password alone", () => {
    expect(() => accounts.update_user("admin", { role: "viewer" })).toThrow("cannot be changed here");
    expect(() => accounts.delete_user("admin")).toThrow("cannot be changed here");
  });

  it("changes a password only with the current one", () => {
    accounts.create_user({ name: "alice", role: "viewer", grants: null, password: "a long enough pass" });

    expect(() => accounts.change_password("alice", "wrong", "another long pass")).toThrow("current password is wrong");
    accounts.change_password("alice", "a long enough pass", "another long pass");
    expect(accounts.authenticate("alice", "another long pass", undefined).user).not.toBeNull();
  });

  it("orders the roles", () => {
    expect(has_role("admin", "operator")).toBe(true);
    expect(has_role("viewer", "operator")).toBe(false);
  });
});

describe("second factor", () => {
  it("asks for a code once set up, takes each code once, and takes a recovery code once", () => {
    const { secret } = accounts.start_totp("admin");
    const now = Date.now() / 1000;
    const recovery = accounts.confirm_totp("admin", code_at(secret, now));

    expect(accounts.authenticate("admin", "declared admin pass", undefined)).toEqual({ user: null, needs_code: true });
    // The code that confirmed the setup was used, so the next login needs the next one.
    expect(accounts.authenticate("admin", "declared admin pass", code_at(secret, now)).user).toBeNull();
    expect(accounts.authenticate("admin", "declared admin pass", code_at(secret, now + 30)).user).not.toBeNull();
    expect(accounts.authenticate("admin", "declared admin pass", recovery[0]).user).not.toBeNull();
    expect(accounts.authenticate("admin", "declared admin pass", recovery[0]).user).toBeNull();
  });

  it("refuses a wrong confirmation code and can be reset", () => {
    accounts.start_totp("admin");
    expect(() => accounts.confirm_totp("admin", "000000")).toThrow("does not match");

    const { secret } = accounts.start_totp("admin");
    accounts.confirm_totp("admin", code_at(secret, Date.now() / 1000));
    accounts.reset_totp("admin");
    expect(accounts.authenticate("admin", "declared admin pass", undefined).user).not.toBeNull();
  });
});

describe("tokens", () => {
  it("keeps only a digest, checks a token, and forgets a revoked one", () => {
    const { token, id } = accounts.create_token("prometheus", "admin");

    expect(JSON.stringify(store.all("SELECT * FROM tokens"))).not.toContain(token);
    expect(accounts.check_token(token)).toBe("prometheus");
    expect(accounts.tokens()[0].last_used_epoch).not.toBeNull();
    accounts.delete_token(id);
    expect(accounts.check_token(token)).toBeNull();
  });
});
