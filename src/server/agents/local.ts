// The agent built into the server for its own machine. It runs commands itself with no socket between, through the
// same code a remote agent uses, so a command behaves the same on every host.

// ── Imports ──────────────────────────────────────────────────────────────────

import { run_command, stream_command } from "../../agent/commands.ts";
import { read_health } from "../../agent/health.ts";
import { LongRuns, type LongRunOptions } from "../../agent/long_runs.ts";
import type { HealthSample } from "../../shared/agent_protocol.ts";
import type { CmdResult } from "../borg/types.ts";
import { ended_stream, type Agent, type AgentRunOptions, type AgentStreamOptions, type CommandStream, type LongRun, type LongRunPoll } from "./agent.ts";

// ── Local agent ──────────────────────────────────────────────────────────────

export class LocalAgent implements Agent {
  readonly long_runs: LongRuns;

  // Long runs keep their output under the state directory, as a remote agent's do under its own.
  constructor(state_directory: string, options: LongRunOptions = {}) {
    this.long_runs = new LongRuns(state_directory, options);
  }

  run(command: string, options: AgentRunOptions): Promise<CmdResult> {
    return run_command(command, options);
  }

  stream(command: string, options: AgentStreamOptions = {}): CommandStream {
    return stream_command(command, options);
  }

  async start(run_id: string, command: string, options: AgentStreamOptions = {}): Promise<LongRun> {
    return this.long_runs.start(run_id, command, options.stdin ?? null);
  }

  poll(run_id: string, offset: number): Promise<LongRunPoll> {
    return this.long_runs.poll(run_id, offset);
  }

  attach(run_id: string, offset: number): CommandStream {
    try {
      return this.long_runs.tail(run_id, offset);
    } catch (error) {
      return ended_stream((error as Error).message);
    }
  }

  stop(run_id: string): Promise<LongRun> {
    return this.long_runs.stop(run_id);
  }

  async forget(run_id: string): Promise<void> {
    this.long_runs.forget(run_id);
  }

  async runs(): Promise<LongRun[]> {
    return this.long_runs.list();
  }

  health(): Promise<HealthSample> {
    return read_health();
  }
}
