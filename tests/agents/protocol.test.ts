import { describe, expect, it } from "vitest";
import { check_url } from "../../src/agent/agent.ts";
import { needed } from "../../src/server/auth.ts";

describe("agent URL", () => {
  it("takes wss:// anywhere and ws:// only to this machine", () => {
    expect(check_url("wss://backups.example.org/api/agent").host).toBe("backups.example.org");
    for (const local of ["ws://localhost:7710/api/agent", "ws://127.0.0.1:7710/api/agent", "ws://[::1]:7710/api/agent"]) {
      expect(check_url(local).protocol).toBe("ws:");
    }
    expect(() => check_url("ws://backups.example.org/api/agent")).toThrow(/only allowed to this machine/);
    expect(() => check_url("https://backups.example.org/api/agent")).toThrow(/must start with wss/);
    expect(() => check_url("backups")).toThrow(/not a URL/);
  });

  it("is reached without a login, since the agent brings its own token", () => {
    expect(needed("GET", "/api/agent")).toBe("open");
  });
});
