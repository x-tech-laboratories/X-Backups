import { describe, expect, it } from "vitest";

import { parse_timers } from "../src/server/timers.ts";

const LISTED = JSON.stringify([
  { next: 1793179642364737, left: 0, last: 1792574147452262, passed: 0, unit: "borgmatic.timer", activates: "borgmatic.service" },
  { next: 1793179642364737, left: 0, last: null, passed: 0, unit: "fstrim.timer", activates: "fstrim.service" },
  { next: 0, left: 0, last: 0, passed: 0, unit: "borgbackup-job-media.timer", activates: "borgbackup-job-media.service" },
]);

const SERVICES = "Id=borgmatic.service\nResult=exit-code\nExecMainStatus=2\n\nId=borgbackup-job-media.service\nResult=success\nExecMainStatus=0";

// systemd-analyze on a host in another zone: the local lines are dropped by the command, the UTC ones kept, and one repeats.
const CALENDAR = [
  "@@borgmatic.timer",
  "       (in UTC): Wed 2026-10-28 09:00:00 UTC",
  "       (in UTC): Wed 2026-11-04 09:00:00 UTC",
  "       (in UTC): Wed 2026-11-04 09:00:00 UTC",
  "       (in UTC): Wed 2026-11-11 09:00:00 UTC",
  "@@borgbackup-job-media.timer",
].join("\n");

const now = Date.parse("2026-10-27T12:00:00Z") / 1000;

describe("timers", () => {
  it("keeps only backup timers, with their service's last result", () => {
    const timers = parse_timers(`${LISTED}\n===XBACKUPS_SERVICES===\n${SERVICES}`);

    expect(timers).toEqual([
      { unit: "borgmatic.timer", service: "borgmatic.service", next_epoch: 1793179642, last_epoch: 1792574147, result: "exit-code", exit_status: 2, upcoming: [] },
      { unit: "borgbackup-job-media.timer", service: "borgbackup-job-media.service", next_epoch: null, last_epoch: null, result: "success", exit_status: 0, upcoming: [] },
    ]);
  });

  it("reads each timer's elapses over the coming week, once each", () => {
    const timers = parse_timers(`${LISTED}\n===XBACKUPS_SERVICES===\n${SERVICES}\n===XBACKUPS_CALENDAR===\n${CALENDAR}`, now);

    expect(timers?.map((timer) => timer.upcoming)).toEqual([
      [Date.parse("2026-10-28T09:00:00Z") / 1000, Date.parse("2026-11-04T09:00:00Z") / 1000],
      [],
    ]);
  });

  it("gives null when systemctl answered no timer list", () => {
    expect(parse_timers("systemctl: command not found")).toBeNull();
  });
});
