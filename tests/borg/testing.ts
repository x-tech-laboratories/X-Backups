// In-memory stores and a cycle driver, so a repository can be exercised without a host or a database.

import { BorgRepository, type BorgConfig } from "../../src/server/borg/repository.ts";
import { cmd_result, type CmdResult, type Command, type RunRecord, type RunState, type RunStore, type LogEntry, type MonitorStatus } from "../../src/server/borg/types.ts";
import { CollectResult } from "../../src/server/borg/types.ts";

// ── Outcome log ──────────────────────────────────────────────────────────────

export class MemoryOutcomeLog {
  statuses: MonitorStatus[] = [];
  events: LogEntry[] = [];

  // Records what a result reports: its status if it has one, and its logs.
  apply(result: CollectResult): void {
    if (result.status !== null) this.statuses.push(result.status);
    this.events.push(...result.logs);
  }

  latest_status(): MonitorStatus | null {
    return this.statuses.length > 0 ? this.statuses[this.statuses.length - 1] : null;
  }
}

// ── Run store ────────────────────────────────────────────────────────────────

export class MemoryRunStore implements RunStore {
  private runs: RunRecord[] = [];
  private outputs = new Map<number, string[]>();

  running(): RunRecord | null {
    return this.runs.find((run) => run.state === "running") ?? null;
  }

  action_run(_action_id: string): RunRecord | null {
    return null;
  }

  create(kind: string, command: string, workdir: string | null): number {
    const id = this.runs.length + 1;
    this.runs.push({ id, kind, command, workdir, pid: null, state: "running", progress: null, output_seq: 0, exit_code: null, error: null });
    this.outputs.set(id, []);
    return id;
  }

  set_pid(run_id: number, pid: number): void {
    this.run(run_id).pid = pid;
  }

  set_progress(run_id: number, summary: string): void {
    this.run(run_id).progress = summary;
  }

  append_output(run_id: number, lines: string[]): void {
    this.outputs.get(run_id)!.push(...lines);
  }

  bump_output_seq(run_id: number, new_seq: number): void {
    this.run(run_id).output_seq = new_seq;
  }

  finish(run_id: number, state: RunState, details: { exit_code?: number | null; error?: string | null }): void {
    Object.assign(this.run(run_id), { state, exit_code: details.exit_code ?? null, error: details.error ?? null });
  }

  recent(): RunRecord[] {
    return [...this.runs].reverse();
  }

  output(run_id: number): string[] {
    return this.outputs.get(run_id) ?? [];
  }

  private run(run_id: number): RunRecord {
    return this.runs.find((run) => run.id === run_id)!;
  }
}

// ── Harness ──────────────────────────────────────────────────────────────────

export class Harness {
  readonly repository: BorgRepository;
  readonly outcomes = new MemoryOutcomeLog();
  readonly runs = new MemoryRunStore();

  constructor(name: string, config: BorgConfig) {
    this.repository = new BorgRepository(name, config);
    this.repository.runs = this.runs;
  }

  // Keeps the state a result hands back, the way the store does between polls.
  apply(result: CollectResult): void {
    if (result.state !== null) this.repository.state = result.state;
    this.outcomes.apply(result);
  }

  // Runs one cycle, answering each command with the fake runner, and records what it reports.
  run_cycle(fake_run?: (command: Command, index: number) => CmdResult): CollectResult {
    const commands = this.repository.commands();
    const results = commands.map((command, index) => fake_run ? fake_run(command, index) : cmd_result(0, "", ""));
    const result = this.repository.parse(results);
    this.apply(result);
    return result;
  }
}
