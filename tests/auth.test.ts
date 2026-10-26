import { describe, expect, it } from "vitest";
import { build_app } from "../src/server/app.ts";
import { hash_password, verify_password } from "../src/server/auth.ts";
import { Poller } from "../src/server/poller.ts";
import { Store } from "../src/server/store.ts";

const password_hash = hash_password("correct horse");

// An app watching no repositories, so only its login is exercised.
function make_app() {
  const store = new Store(":memory:");
  return build_app({ serve_web: false, logger: false, password_hash, poller: new Poller({ repositories: [] }, store), store });
}

async function login(app: Awaited<ReturnType<typeof build_app>>, password: string) {
  return app.inject({ method: "POST", url: "/api/login", payload: { password } });
}

describe("password hashes", () => {
  it("accept the password they were made from and nothing else", () => {
    expect(verify_password("correct horse", password_hash)).toBe(true);
    expect(verify_password("wrong", password_hash)).toBe(false);
    expect(verify_password("correct horse", "not-a-hash")).toBe(false);
  });
});

describe("api guard", () => {
  it("leaves health open and turns away other api calls without a session", async () => {
    const app = await make_app();

    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/logout" })).statusCode).toBe(401);

    await app.close();
  });

  it("refuses a wrong password", async () => {
    const app = await make_app();

    const response = await login(app, "wrong");
    expect(response.statusCode).toBe(401);
    expect(response.headers["set-cookie"]).toBeUndefined();

    await app.close();
  });

  it("lets a session in until it logs out", async () => {
    const app = await make_app();

    const response = await login(app, "correct horse");
    expect(response.statusCode).toBe(204);
    const cookie = String(response.headers["set-cookie"]).split(";")[0];
    expect(String(response.headers["set-cookie"])).toContain("HttpOnly");

    expect((await app.inject({ method: "POST", url: "/api/logout", headers: { cookie } })).statusCode).toBe(204);
    expect((await app.inject({ method: "POST", url: "/api/logout", headers: { cookie } })).statusCode).toBe(401);

    await app.close();
  });
});
