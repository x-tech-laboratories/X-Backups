import { afterEach, describe, expect, it } from "vitest";

import { describe as describe_schedule, is_schedule, next_due, parse_schedule, schedule_time_zone, wall_to_epoch } from "../src/server/schedule.ts";

const UTC = "UTC";
const BERLIN = "Europe/Berlin";
const NEW_YORK = "America/New_York";

// An epoch from a UTC time written out, for readable expectations.
function utc(text: string): number {
  return Date.parse(`${text}Z`) / 1000;
}

afterEach(() => {
  delete process.env.X_BACKUPS_TIMEZONE;
});

// ── Parsing ──────────────────────────────────────────────────────────────────

describe("parsing", () => {
  it("reads durations and seconds as intervals", () => {
    expect(parse_schedule("30m")).toEqual({ kind: "interval", seconds: 1800 });
    expect(parse_schedule("6h")).toEqual({ kind: "interval", seconds: 21600 });
    expect(parse_schedule("1d")).toEqual({ kind: "interval", seconds: 86400 });
    expect(parse_schedule("1h30m")).toEqual({ kind: "interval", seconds: 5400 });
    expect(parse_schedule(3600)).toEqual({ kind: "interval", seconds: 3600 });
  });

  it("refuses an interval shorter than a minute", () => {
    expect(() => parse_schedule("30s")).toThrow("too often");
    expect(() => parse_schedule(0)).toThrow("too often");
  });

  it("reads presets, a time of day and a weekday as calendar schedules", () => {
    expect(parse_schedule("daily")).toMatchObject({ kind: "calendar", minutes: [0], hours: [0] });
    expect(parse_schedule("daily 02:30")).toMatchObject({ minutes: [30], hours: [2], any_day: true, any_weekday: true });
    expect(parse_schedule("weekly sun 03:00")).toMatchObject({ minutes: [0], hours: [3], weekdays: [0], any_weekday: false });
    expect(parse_schedule("Weekly Friday 9:05")).toMatchObject({ minutes: [5], hours: [9], weekdays: [5] });
    expect(parse_schedule("monthly")).toMatchObject({ days: [1], any_day: false });
  });

  it("reads cron lines with lists, ranges, steps and names", () => {
    expect(parse_schedule("*/15 1-3 * jan,jul mon-fri")).toMatchObject({
      minutes: [0, 15, 30, 45], hours: [1, 2, 3], months: [1, 7], weekdays: [1, 2, 3, 4, 5],
    });
    expect(parse_schedule("5/20 0 1,15 * 7")).toMatchObject({ minutes: [5, 25, 45], days: [1, 15], weekdays: [0] });
  });

  it("says what is wrong with a bad expression", () => {
    expect(() => parse_schedule("daily 25:00")).toThrow("not a time of day");
    expect(() => parse_schedule("weekly someday 03:00")).toThrow("not a weekday");
    expect(() => parse_schedule("61 * * * *")).toThrow("not a valid minute");
    expect(() => parse_schedule("* * * *")).toThrow("Unrecognised schedule");
    expect(() => parse_schedule("whenever")).toThrow("Unrecognised schedule");
    expect(is_schedule("daily 02:00")).toBe(true);
    expect(is_schedule("nope")).toBe(false);
    expect(is_schedule(true)).toBe(false);
  });
});

// ── Next due ─────────────────────────────────────────────────────────────────

describe("next due", () => {
  it("counts an interval from the given start", () => {
    expect(next_due("6h", utc("2026-10-29T10:00:00"), UTC)).toBe(utc("2026-10-29T16:00:00"));
  });

  it("finds the next time of day, later the same day or the next", () => {
    expect(next_due("daily 02:00", utc("2026-10-29T01:00:00"), UTC)).toBe(utc("2026-10-29T02:00:00"));
    expect(next_due("daily 02:00", utc("2026-10-29T02:00:00"), UTC)).toBe(utc("2026-10-30T02:00:00"));
    expect(next_due("hourly", utc("2026-10-29T10:59:59"), UTC)).toBe(utc("2026-10-29T11:00:00"));
  });

  it("finds the next weekday and the next month", () => {
    // 2026-10-29 is a Thursday.
    expect(next_due("weekly sun 03:00", utc("2026-10-29T12:00:00"), UTC)).toBe(utc("2026-11-01T03:00:00"));
    expect(next_due("weekly", utc("2026-10-29T12:00:00"), UTC)).toBe(utc("2026-11-02T00:00:00"));
    expect(next_due("monthly", utc("2026-10-29T12:00:00"), UTC)).toBe(utc("2026-11-01T00:00:00"));
    expect(next_due("0 0 31 * *", utc("2026-10-31T12:00:00"), UTC)).toBe(utc("2026-12-31T00:00:00"));
  });

  it("matches either day field when both are restricted, as cron does", () => {
    // The 1st, or any Friday: Friday 30 October comes first.
    expect(next_due("0 12 1 * fri", utc("2026-10-29T13:00:00"), UTC)).toBe(utc("2026-10-30T12:00:00"));
  });

  it("reaches a leap day years away", () => {
    expect(next_due("0 0 29 2 *", utc("2026-10-29T00:00:00"), UTC)).toBe(utc("2028-02-29T00:00:00"));
  });

  it("reads wall times in the zone given", () => {
    // Berlin is UTC+1 in winter and UTC+2 in summer.
    expect(next_due("daily 02:00", utc("2026-12-01T00:00:00"), BERLIN)).toBe(utc("2026-12-01T01:00:00"));
    expect(next_due("daily 02:00", utc("2026-06-30T12:00:00"), BERLIN)).toBe(utc("2026-07-01T00:00:00"));
  });

  it("uses X_BACKUPS_TIMEZONE when no zone is given", () => {
    process.env.X_BACKUPS_TIMEZONE = NEW_YORK;
    expect(schedule_time_zone()).toBe(NEW_YORK);
    expect(next_due("daily 02:00", utc("2026-12-01T00:00:00"))).toBe(utc("2026-12-01T07:00:00"));
    process.env.X_BACKUPS_TIMEZONE = "Mars/Olympus";
    expect(() => schedule_time_zone()).toThrow("Unknown time zone");
  });
});

// ── Daylight saving ──────────────────────────────────────────────────────────

describe("daylight saving", () => {
  // Berlin springs forward on 29 March 2026 at 02:00 to 03:00, and falls back on 25 October 2026 at 03:00 to 02:00.

  it("runs a skipped time as far past the jump as it was into the gap", () => {
    expect(wall_to_epoch(2026, 3, 29, 2, 30, BERLIN)).toBe(utc("2026-03-29T01:30:00"));
    expect(next_due("daily 02:30", utc("2026-03-28T12:00:00"), BERLIN)).toBe(utc("2026-03-29T01:30:00"));
    // The day after, 02:30 exists again, in summer time.
    expect(next_due("daily 02:30", utc("2026-03-29T01:30:00"), BERLIN)).toBe(utc("2026-03-30T00:30:00"));
  });

  it("runs a repeated time once, at its first occurrence", () => {
    const first = utc("2026-10-25T00:30:00");
    expect(wall_to_epoch(2026, 10, 25, 2, 30, BERLIN)).toBe(first);
    expect(next_due("daily 02:30", utc("2026-10-24T12:00:00"), BERLIN)).toBe(first);
    // Between the two 02:30s, the next run is the following day's.
    expect(next_due("daily 02:30", first, BERLIN)).toBe(utc("2026-10-26T01:30:00"));
  });

  it("keeps hourly runs going through both changes", () => {
    const spring: number[] = [];
    let at = utc("2026-03-29T00:30:00");
    for (let index = 0; index < 3; index++) spring.push(at = next_due("hourly", at, BERLIN));
    // 02:00 does not exist, so its run lands with 03:00's, at 01:00 UTC; then 04:00 and 05:00 summer time.
    expect(spring).toEqual([utc("2026-03-29T01:00:00"), utc("2026-03-29T02:00:00"), utc("2026-03-29T03:00:00")]);

    const autumn: number[] = [];
    at = utc("2026-10-24T23:30:00");
    for (let index = 0; index < 3; index++) autumn.push(at = next_due("hourly", at, BERLIN));
    // 02:00 summer time at 00:00 UTC, then 03:00 winter time at 02:00 UTC: the repeated hour runs once.
    expect(autumn).toEqual([utc("2026-10-25T00:00:00"), utc("2026-10-25T02:00:00"), utc("2026-10-25T03:00:00")]);
  });

  it("counts an interval in real time across a change", () => {
    expect(next_due("1d", utc("2026-03-28T12:00:00"), BERLIN)).toBe(utc("2026-03-29T12:00:00"));
  });

  it("handles a zone west of UTC", () => {
    // New York falls back on 1 November 2026 at 02:00 to 01:00.
    expect(next_due("daily 01:30", utc("2026-11-01T00:00:00"), NEW_YORK)).toBe(utc("2026-11-01T05:30:00"));
    expect(next_due("daily 01:30", utc("2026-11-01T05:30:00"), NEW_YORK)).toBe(utc("2026-11-02T06:30:00"));
  });
});

// ── Describing ───────────────────────────────────────────────────────────────

describe("describing", () => {
  it.each([
    ["6h", "Every 6 hours"],
    ["1d", "Every day"],
    ["30m", "Every 30 minutes"],
    ["1d12h", "Every 1 day 12 hours"],
    ["2w", "Every 2 weeks"],
    ["hourly", "Every hour"],
    ["daily", "Every day at 00:00"],
    ["daily 02:00", "Every day at 02:00"],
    ["weekly", "Every Monday at 00:00"],
    ["weekly sun 03:00", "Every Sunday at 03:00"],
    ["monthly", "On the 1st of every month at 00:00"],
    ["*/15 * * * *", "Every 15 minutes"],
    ["30 * * * 1,5", "Every hour at minute 30 on Monday and Friday"],
    ["0 4 * * mon-fri", "Every Monday, Tuesday, Wednesday, Thursday and Friday at 04:00"],
    ["0 3 2 jan,jul *", "On the 2nd in January and July at 03:00"],
    ["0 1-5 * * *", 'On the cron schedule "0 1-5 * * *"'],
  ])("describes %s as %s", (expression, words) => {
    expect(describe_schedule(expression)).toBe(words);
  });
});
