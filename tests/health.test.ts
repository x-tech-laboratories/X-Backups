import { describe, expect, it } from "vitest";
import { BorgRepository, type BorgConfig } from "../src/server/borg/repository.ts";
import type { RepositoryState } from "../src/server/borg/types.ts";
import { health, repository_health } from "../src/server/health.ts";
import type { Watched } from "../src/server/poller.ts";

const now = 1_800_000_000;
const hour = 3600;
const day = 24 * hour;

// A polled repository whose newest archive, oldest passing check and canary are the given ages.
function watched(config: BorgConfig, ages: { backup: number; check?: number; canary?: number }): Watched {
  const repository = new BorgRepository("odin", { repo: "/srv/repo", ...config });
  const state: Partial<RepositoryState> = { last_poll_epoch: now, last_backup_epoch: now - ages.backup };
  if (ages.check !== undefined) state.checks = { checks: {}, passed: true, oldest_ok_epoch: now - ages.check };
  if (ages.canary !== undefined) state.canary = { ok: true, checked_epoch: now - ages.canary, detail: "" };
  repository.state = { ...repository.state, ...state };
  return { config: {} as Watched["config"], repository, status: "online" };
}

// ── Backup age ───────────────────────────────────────────────────────────────

describe("backup age", () => {
  it("stays ok with no warning age set", () => {
    expect(repository_health(watched({ max_age: "1d" }, { backup: 23 * hour }), now)).toEqual({ level: "ok", reasons: [] });
  });

  it("warns past warn_age and turns critical past max_age", () => {
    const config = { max_age: "1d", warn_age: "12h" };

    expect(repository_health(watched(config, { backup: 13 * hour }), now)).toEqual({
      level: "warning", reasons: [{ level: "warning", text: "last backup 13 Hours ago, warning at 12 Hours" }],
    });
    expect(repository_health(watched(config, { backup: 25 * hour }), now).reasons).toEqual([
      { level: "critical", text: "last backup 1 Day 1 Hour ago, limit 1 Day" },
    ]);
  });

  it("refuses a warning age that is not shorter than the maximum", () => {
    expect(() => watched({ max_age: "1d", warn_age: "1d" }, { backup: 0 })).toThrow("warn_age must be shorter than max_age");
  });
});

// ── Check and canary ages ────────────────────────────────────────────────────

describe("check and canary ages", () => {
  it("warns when the oldest passing check is past check_warn_age", () => {
    const result = repository_health(watched({ check_units: ["borg-check.service"], check_max_age: "30d", check_warn_age: "14d" }, { backup: hour, check: 15 * day }), now);

    expect(result).toEqual({ level: "warning", reasons: [{ level: "warning", text: "oldest check passed 2 Weeks 1 Day ago, warning at 2 Weeks" }] });
  });

  it("warns, then turns critical, as the canary goes without running", () => {
    const config = { canary_path: "/etc/hostname", canary_warn_age: "2d", canary_max_age: "3d" };

    expect(repository_health(watched(config, { backup: hour, canary: day }), now).level).toBe("ok");
    expect(repository_health(watched(config, { backup: hour, canary: 2 * day + hour }), now).level).toBe("warning");
    expect(repository_health(watched(config, { backup: hour, canary: 3 * day + hour }), now).reasons).toEqual([
      { level: "critical", text: "restore canary last ran 3 Days 1 Hour ago, limit 3 Days" },
    ]);
  });
});

// ── Roll-up ──────────────────────────────────────────────────────────────────

describe("roll-up", () => {
  it("takes the worst level across repositories", () => {
    const fine = watched({ max_age: "1d" }, { backup: hour });
    const late = watched({ max_age: "1d", warn_age: "12h" }, { backup: 13 * hour });

    expect(health([fine, late], now).status).toBe("warning");
    expect(health([fine], now).status).toBe("ok");
  });
});
