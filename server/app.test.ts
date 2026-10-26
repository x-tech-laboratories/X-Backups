import { describe, expect, it } from "vitest";
import { build_app } from "./app.ts";

describe("health check", () => {
  it("reports the server as up", async () => {
    const app = await build_app({ serve_web: false, logger: false });
    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });

    await app.close();
  });
});
