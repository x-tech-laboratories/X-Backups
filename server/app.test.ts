import { describe, expect, it } from "vitest";
import { build_app } from "./app.ts";
import { hash_password } from "./auth.ts";

const password_hash = hash_password("correct horse");

describe("health check", () => {
  it("reports the server as up", async () => {
    const app = await build_app({ serve_web: false, logger: false, password_hash });
    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });

    await app.close();
  });
});
