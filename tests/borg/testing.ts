// In-memory stores and a cycle driver, so a repository can be exercised without a host or a database.

import { BorgRepository, type BorgConfig } from "../../src/server/borg/repository.ts";
import { cmd_result, type CmdResult, type Command, type JobRecord, type JobState, type JobStore, type LogEntry, type MonitorStatus } from "../../src/server/borg/types.ts";
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

// ── Job store ────────────────────────────────────────────────────────────────

export class MemoryJobStore implements JobStore {
  private jobs: JobRecord[] = [];
  private outputs = new Map<number, string[]>();

  running(): JobRecord | null {
    return this.jobs.find((job) => job.state === "running") ?? null;
  }

  action_job(_action_id: string): JobRecord | null {
    return null;
  }

  create(kind: string, command: string, workdir: string | null): number {
    const id = this.jobs.length + 1;
    this.jobs.push({ id, kind, command, workdir, pid: null, state: "running", progress: null, output_seq: 0, exit_code: null, error: null });
    this.outputs.set(id, []);
    return id;
  }

  set_pid(job_id: number, pid: number): void {
    this.job(job_id).pid = pid;
  }

  set_progress(job_id: number, summary: string): void {
    this.job(job_id).progress = summary;
  }

  append_output(job_id: number, lines: string[]): void {
    this.outputs.get(job_id)!.push(...lines);
  }

  bump_output_seq(job_id: number, new_seq: number): void {
    this.job(job_id).output_seq = new_seq;
  }

  finish(job_id: number, state: JobState, details: { exit_code?: number | null; error?: string | null }): void {
    Object.assign(this.job(job_id), { state, exit_code: details.exit_code ?? null, error: details.error ?? null });
  }

  recent(): JobRecord[] {
    return [...this.jobs].reverse();
  }

  output(job_id: number): string[] {
    return this.outputs.get(job_id) ?? [];
  }

  private job(job_id: number): JobRecord {
    return this.jobs.find((job) => job.id === job_id)!;
  }
}

// ── Harness ──────────────────────────────────────────────────────────────────

export class Harness {
  readonly repository: BorgRepository;
  readonly outcomes = new MemoryOutcomeLog();
  readonly jobs = new MemoryJobStore();

  constructor(name: string, config: BorgConfig) {
    this.repository = new BorgRepository(name, config);
    this.repository.jobs = this.jobs;
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
