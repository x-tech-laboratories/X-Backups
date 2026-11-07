// What X-Backups' server and agents agree on over the agent's WebSocket, on top of X-Libs' agent protocol: each task is a
// shell command line, and the agent also answers `health` with a sample of how loaded its host is.

// ── Imports ──────────────────────────────────────────────────────────────────

import { key_host_header as header_for, shell_app } from "@x-tech-laboratories/x-libs/agent/protocol";

export type { LongRun, LongRunPoll, LongRunState, RunResult } from "@x-tech-laboratories/x-libs/agent/protocol";

// ── App ──────────────────────────────────────────────────────────────────────

export const x_backups_app = shell_app("x-backups");

// The upgrade header an agent logging in with its key names its host in.
export const key_host_header = header_for(x_backups_app.name);

// ── Health ───────────────────────────────────────────────────────────────────

// How loaded a host is, in the shape the server keeps host samples in.
export interface HealthSample {
  load1: number;
  cpus: number;
  memory_total: number;
  memory_available: number;
  disk_size: number;
  disk_available: number;
}
