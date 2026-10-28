import { describe, expect, it } from "vitest";

import { parse_host_health } from "../src/server/host_health.ts";
import { Store } from "../src/server/store.ts";

describe("host health", () => {
  it("reads the load, CPUs, memory in kB and the root filesystem in bytes", () => {
    expect(parse_host_health("0.52\n4\n8000000 2000000\n100000000000 25000000000\n")).toEqual({
      load1: 0.52, cpus: 4, memory_total: 8_192_000_000, memory_available: 2_048_000_000, disk_size: 100_000_000_000, disk_available: 25_000_000_000,
    });
  });

  it("gives null for output it cannot read", () => {
    expect(parse_host_health("nproc: command not found")).toBeNull();
    expect(parse_host_health("0.5\n0\n8000000 2000000\n100 25\n")).toBeNull();
  });

  it("keeps a week of a host's readings", () => {
    const store = new Store(":memory:");
    const sample = { load1: 1, cpus: 2, memory_total: 10, memory_available: 5, disk_size: 10, disk_available: 5 };
    store.add_host_sample("odin", sample, 1000);
    store.add_host_sample("odin", { ...sample, load1: 2 }, 1000 + 8 * 86400);

    expect(store.host_samples(0).map((row) => row.load1)).toEqual([2]);
    store.close();
  });
});
