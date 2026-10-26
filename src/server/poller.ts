// Polls each repository at startup, then on its interval, or every ten seconds while one of its jobs runs, and runs its actions.

// ── Imports ──────────────────────────────────────────────────────────────────

import { BorgRepository } from "./borg/repository.ts";
import { CollectResult, type ActionPlan, type CmdResult, type MonitorStatus } from "./borg/types.ts";
import type { Config, RepositoryConfig } from "./config.ts";
import { run_command, type RunOptions, type RunTarget } from "./runner.ts";
import type { Store } from "./store.ts";
import { parse_timers, timers_command } from "./timers.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export type Run = (target: RunTarget, command: string, options: RunOptions) => Promise<CmdResult>;

export interface Watched {
  config: RepositoryConfig;
  repository: BorgRepository;
  // The status the latest poll reported, kept until a poll reports another.
  status: MonitorStatus | null;
}

const job_poll_interval_in_seconds = 10;

// A host's timers are read again at most this often, however many of its repositories poll.
const timer_read_interval_in_seconds = 300;

// A plan with no timeout of its own, such as a diff, is still stopped after this long.
const longest_action_in_seconds = 6 * 60 * 60;

// ── Poller ───────────────────────────────────────────────────────────────────

export class Poller {
  readonly repositories = new Map<string, Watched>();
  private readonly store: Store;
  private readonly run: Run;
  // Each repository's work runs one piece at a time, since a poll and an action both read and replace its state.
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly pending_polls = new Map<string, Promise<CollectResult>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly timers_read = new Map<string, number>();
  private stopped = true;

  constructor(config: Config, store: Store, run: Run = run_command) {
    this.store = store;
    this.run = run;
    for (const repository_config of config.repositories) {
      const repository = new BorgRepository(repository_config.name, repository_config.borg);
      repository.state = store.load_state(repository.id) ?? repository.state;
      repository.jobs = store.jobs_for(repository.id);
      const status = store.polls(repository.id).at(-1)?.status ?? null;
      this.repositories.set(repository.id, { config: repository_config, repository, status });
    }
  }

  // Polls every repository now, which also picks up jobs left running before a restart, then keeps polling.
  start(): void {
    this.stopped = false;
    for (const id of this.repositories.keys()) void this.poll(id);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  // Polls the repository, sharing a poll already waiting or running rather than starting a second.
  poll(id: string): Promise<CollectResult> {
    const pending = this.pending_polls.get(id);
    if (pending) return pending;
    const jobs = this.watched(id).repository.jobs;
    const poll = this.queued(id, async () => {
      const followed_job = jobs?.running() != null;
      const result = await this.poll_now(id);
      return { result, job_ended: followed_job && jobs?.running() == null };
    }).then(({ result, job_ended }) => {
      this.pending_polls.delete(id);
      // A finished job changed the repository, so it is polled again at once rather than after its interval.
      if (job_ended) void this.poll(id);
      else this.schedule(id);
      return result;
    });
    this.pending_polls.set(id, poll);
    return poll;
  }

  // Runs an action's commands one after another and keeps what its reader reports.
  run_action(id: string, plan: ActionPlan): Promise<CollectResult> {
    return this.queued(id, async () => {
      const watched = this.watched(id);
      const results: CmdResult[] = [];
      for (const command of plan.commands) {
        const options = { timeout_in_seconds: plan.timeout ?? longest_action_in_seconds, stdin: plan.stdin ?? undefined };
        results.push(await this.run(watched.config, command, options));
      }
      const result = plan.read(results);
      this.keep(watched, result, false);
      return result;
    }).finally(() => this.schedule(id));
  }

  private async poll_now(id: string): Promise<CollectResult> {
    const watched = this.watched(id);
    let result: CollectResult;
    try {
      const results: CmdResult[] = [];
      for (const command of watched.repository.commands()) {
        const options = { timeout_in_seconds: command.timeout ?? longest_action_in_seconds, stdin: command.stdin ?? undefined };
        results.push(await this.run(watched.config, command.text, options));
      }
      result = watched.repository.parse(results);
    } catch (error) {
      result = failed_result(error);
    }
    this.keep(watched, result, true);
    await this.read_timers(watched);
    return result;
  }

  // Reads the backup timers on the repository's host, keeping the last good read when one fails.
  private async read_timers(watched: Watched): Promise<void> {
    const host = host_name(watched);
    const now = Date.now() / 1000;
    if (now - (this.timers_read.get(host) ?? 0) < timer_read_interval_in_seconds) return;
    this.timers_read.set(host, now);
    try {
      const result = await this.run(watched.config, timers_command(), { timeout_in_seconds: 30 });
      const timers = parse_timers(result.stdout);
      if (timers !== null) this.store.replace_timers(host, timers);
    } catch {
      // A host without systemd simply shows no timers.
    }
  }

  private keep(watched: Watched, result: CollectResult, poll: boolean): void {
    if (result.state !== null) watched.repository.state = result.state;
    if (poll && result.status !== null) watched.status = result.status;
    this.store.apply(watched.repository.id, result, { poll });
  }

  private queued<Result>(id: string, work: () => Promise<Result>): Promise<Result> {
    const next = (this.queues.get(id) ?? Promise.resolve()).catch(() => {}).then(work);
    this.queues.set(id, next);
    return next;
  }

  // Sets the next poll: soon while a job runs, else after the repository's interval.
  private schedule(id: string): void {
    if (this.stopped) return;
    clearTimeout(this.timers.get(id));
    const watched = this.watched(id);
    const job_running = watched.repository.jobs?.running() != null;
    const delay = job_running ? job_poll_interval_in_seconds : watched.config.interval_in_seconds;
    this.timers.set(id, setTimeout(() => void this.poll(id), delay * 1000));
  }

  private watched(id: string): Watched {
    const watched = this.repositories.get(id);
    if (!watched) throw new Error(`No repository '${id}'`);
    return watched;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// The host a repository's commands run on, with this machine called local.
export function host_name(watched: Watched): string {
  return watched.config.host ?? "local";
}

// Answers a failed run as the repository's own failure, so one broken host never stops the others.
function failed_result(error: unknown): CollectResult {
  return CollectResult.failed(`Poll failed: ${error instanceof Error ? error.message : String(error)}`);
}
