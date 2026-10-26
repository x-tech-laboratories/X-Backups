import { describe, expect, it } from "vitest";

import { parse_timers } from "./timers.ts";

const LISTED = JSON.stringify([
  { next: 1793179642364737, left: 0, last: 1792574147452262, passed: 0, unit: "borgmatic.timer", activates: "borgmatic.service" },
  { next: 1793179642364737, left: 0, last: null, passed: 0, unit: "fstrim.timer", activates: "fstrim.service" },
  { next: 0, left: 0, last: 0, passed: 0, unit: "borgbackup-job-media.timer", activates: "borgbackup-job-media.service" },
]);

const SERVICES = "Id=borgmatic.service\nResult=exit-code\nExecMainStatus=2\n\nId=borgbackup-job-media.service\nResult=success\nExecMainStatus=0";

describe("timers", () => {
  it("keeps only backup timers, with their service's last result", () => {
    const timers = parse_timers(`${LISTED}\n===XBACKUPS_SERVICES===\n${SERVICES}`);

    expect(timers).toEqual([
      { unit: "borgmatic.timer", service: "borgmatic.service", next_epoch: 1793179642, last_epoch: 1792574147, result: "exit-code", exit_status: 2 },
      { unit: "borgbackup-job-media.timer", service: "borgbackup-job-media.service", next_epoch: null, last_epoch: null, result: "success", exit_status: 0 },
    ]);
  });

  it("gives null when systemctl answered no timer list", () => {
    expect(parse_timers("systemctl: command not found")).toBeNull();
  });
});
