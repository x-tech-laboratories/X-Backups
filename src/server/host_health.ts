// Reads how loaded a repository's host is: its load against its CPUs, its memory in use, and how full its root filesystem is.

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface HostSample {
  load1: number;
  cpus: number;
  memory_total: number;
  memory_available: number;
  disk_size: number;
  disk_available: number;
}

// ── Command ──────────────────────────────────────────────────────────────────

// One line each: the one-minute load, the CPU count, memory in kB, and the root filesystem in bytes.
export function host_health_command(): string {
  return "cut -d' ' -f1 /proc/loadavg; nproc; " +
    "awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{print t, a}' /proc/meminfo; " +
    "df -B1 --output=size,avail / | tail -n 1";
}

// ── Reading ──────────────────────────────────────────────────────────────────

export function parse_host_health(stdout: string): HostSample | null {
  const lines = stdout.trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number));
  if (lines.length !== 4 || lines.flat().some((value) => !Number.isFinite(value))) return null;
  const [[load1], [cpus], [memory_total_kb, memory_available_kb], [disk_size, disk_available]] = lines;
  if (!cpus || !memory_total_kb || !disk_size) return null;
  return { load1, cpus, memory_total: memory_total_kb * 1024, memory_available: memory_available_kb * 1024, disk_size, disk_available };
}
