// Reads how loaded this machine is: its load against its CPUs, its memory in use, and how full its root filesystem is.

// ── Imports ──────────────────────────────────────────────────────────────────

import { readFile, statfs } from "node:fs/promises";
import { availableParallelism, freemem, loadavg, totalmem } from "node:os";

import type { HealthSample } from "../shared/agent_protocol.ts";

// ── Reading ──────────────────────────────────────────────────────────────────

// Memory from /proc/meminfo, whose MemAvailable counts reclaimable cache; elsewhere what Node reports as free.
async function read_memory(): Promise<{ total: number; available: number }> {
  try {
    const text = await readFile("/proc/meminfo", "utf8");
    const field = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)\\s+kB`, "m").exec(text)?.[1] ?? Number.NaN) * 1024;
    const total = field("MemTotal");
    const available = field("MemAvailable");
    if (Number.isFinite(total) && Number.isFinite(available)) return { total, available };
  } catch {
    // Not Linux; fall back to Node's own figures.
  }
  return { total: totalmem(), available: freemem() };
}

export async function read_health(): Promise<HealthSample> {
  const [memory, disk] = await Promise.all([read_memory(), statfs("/")]);
  return {
    load1: loadavg()[0],
    cpus: availableParallelism(),
    memory_total: memory.total,
    memory_available: memory.available,
    disk_size: disk.blocks * disk.bsize,
    disk_available: disk.bavail * disk.bsize,
  };
}
