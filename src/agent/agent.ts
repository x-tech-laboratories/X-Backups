// The X-Backups agent: X-Libs' agent, which dials out over a WebSocket with its host's key or token and dials again
// whenever it drops, running each command under sh and answering the server's health requests.

// ── Imports ──────────────────────────────────────────────────────────────────

import { start_agent as start_x_libs_agent, type AgentConfig as XLibsAgentConfig, type RunningAgent as XLibsRunningAgent } from "@x-tech-laboratories/x-libs/agent/client";
import { shell_runner } from "@x-tech-laboratories/x-libs/agent/tasks";

import { x_backups_app } from "../shared/agent_protocol.ts";
import { read_health } from "./health.ts";

export { AgentConfigError, check_url } from "@x-tech-laboratories/x-libs/agent/client";

// ── Agent ────────────────────────────────────────────────────────────────────

export type AgentConfig = Omit<XLibsAgentConfig<string>, "app" | "runner" | "requests">;

export type RunningAgent = XLibsRunningAgent<string>;

// Each command runs under sh, and its long runs show as x-backups-run.
export const command_runner = shell_runner("x-backups-run");

export function start_agent(config: AgentConfig): RunningAgent {
  return start_x_libs_agent({ ...config, app: x_backups_app, runner: command_runner, requests: { health: () => read_health() } });
}
