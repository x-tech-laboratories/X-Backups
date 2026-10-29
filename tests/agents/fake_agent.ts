// An agent for tests whose long runs answer polls as the test sets them, so the server's side is exercised without a host.

import { AgentError, ended_stream, type Agent } from "../../src/server/agents/agent.ts";
import { cmd_result, type CmdResult } from "../../src/server/borg/types.ts";
import type { HealthSample, LongRun, LongRunPoll } from "../../src/shared/agent_protocol.ts";

export const SAMPLE: HealthSample = { load1: 0.5, cpus: 4, memory_total: 8, memory_available: 2, disk_size: 100, disk_available: 25 };

// An agent whose long runs answer polls as the test sets them, and which forgets a run it is told to.
export class FakeAgent implements Agent {
  started: { run_id: string; command: string; stdin: string | null }[] = [];
  forgotten: string[] = [];
  readonly polls = new Map<string, LongRunPoll>();

  async run(): Promise<CmdResult> {
    return cmd_result(0, "", "");
  }

  stream() {
    return ended_stream("");
  }

  async start(run_id: string, command: string, options: { stdin?: string | null } = {}): Promise<LongRun> {
    this.started.push({ run_id, command, stdin: options.stdin ?? null });
    this.polls.set(run_id, poll_of("running", null, ""));
    return { run_id, pid: 1, started_epoch: 0, state: "running", exit_code: null };
  }

  async poll(run_id: string): Promise<LongRunPoll> {
    const poll = this.polls.get(run_id);
    if (poll === undefined) throw new AgentError(`No run named '${run_id}'.`);
    return poll;
  }

  attach() {
    return ended_stream("");
  }

  async stop(run_id: string): Promise<LongRun> {
    this.polls.set(run_id, poll_of("stopped", 143, ""));
    return { run_id, pid: 1, started_epoch: 0, state: "stopped", exit_code: 143 };
  }

  async forget(run_id: string): Promise<void> {
    this.forgotten.push(run_id);
    this.polls.delete(run_id);
  }

  async runs(): Promise<LongRun[]> {
    return [...this.polls.keys()].map((run_id) => ({ run_id, pid: 1, started_epoch: 0, state: "running", exit_code: null }));
  }

  async health(): Promise<HealthSample> {
    return SAMPLE;
  }
}

export function poll_of(state: LongRunPoll["state"], exit_code: number | null, output: string): LongRunPoll {
  const size = Buffer.byteLength(output);
  return { state, exit_code, alive: state === "running", size, new_output: output, next_offset: size };
}
