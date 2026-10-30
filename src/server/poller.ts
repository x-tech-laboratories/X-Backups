// Polls each target at startup, then on its interval, or every ten seconds while one of its runs is going, and runs its
// actions, each on the agent of the target's host. A host's targets are polled again as soon as its agent connects, so
// a run left going while the server or the agent was down is followed again from where its output was read to.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { LongRunPoll } from "../shared/agent_protocol.ts";
import type { AgentRunOptions, AgentStreamOptions, CommandStream } from "./agents/agent.ts";
import type { AgentHub, AgentStatus } from "./agents/hub.ts";
import { BorgRepository } from "./borg/repository.ts";
import { redact } from "./borg/shell.ts";
import { CollectResult, LongRunPlan, type ActionPlan, type CmdResult, type MonitorStatus, type RunRecord } from "./borg/types.ts";
import { own_host, target_id, target_key, type Config, type Entities, type RepositoryConfig } from "./config.ts";
import type { Store } from "./store.ts";
import { parse_timers, timers_command } from "./timers.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

// Runs a command on the named host's agent.
export type Run = (host: string, command: string, options: AgentRunOptions) => Promise<CmdResult>;

export type Stream = (host: string, command: string, options: AgentStreamOptions) => CommandStream;

// A download in progress, which holds the repository's lock for as long as it runs, so the page shows it and can stop it.
export interface DownloadRecord {
  id: number;
  target_id: string;
  who: string;
  what: string;
  started_epoch: number;
}

export interface Watched {
  config: RepositoryConfig;
  repository: BorgRepository;
  // The status the latest poll reported, kept until a poll reports another.
  status: MonitorStatus | null;
}

// The task a run is started for: its id, and the kind its run is recorded as when it has no long run of its own.
export interface TaskRun {
  id: string;
  kind: string;
}

const run_poll_interval_in_seconds = 10;

// A host's timers are read again at most this often, however many of its repositories poll.
const timer_read_interval_in_seconds = 300;

// A plan with no timeout of its own, such as a diff, is still stopped after this long.
const longest_action_in_seconds = 6 * 60 * 60;

// A run's preflight only probes a port and asks systemd about units.
const preflight_timeout_in_seconds = 60;

// One poll of a run reads at most this many pieces of its output, so a run that writes fast still lets others poll.
const most_run_reads_per_poll = 16;

// ── Poller ───────────────────────────────────────────────────────────────────

export class Poller {
  readonly repositories = new Map<string, Watched>();
  // The hosts, repositories, sources and jobs the targets come from; none for a config built by hand.
  entities: Entities | null;
  private readonly store: Store;
  // The agents every command runs through, by host name.
  readonly agents: AgentHub;
  private readonly run: Run;
  private readonly stream_run: Stream;
  // Each repository's work runs one piece at a time, since a poll and an action both read and replace its state.
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly pending_polls = new Map<string, Promise<CollectResult>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly timers_read = new Map<string, number>();
  private readonly running_downloads = new Map<number, { record: DownloadRecord; stop: () => void }>();
  private readonly on_connect = (status: AgentStatus) => this.poll_host(status.host);
  private next_download_id = 1;
  private stopped = true;

  constructor(config: Config, store: Store, agents: AgentHub, run?: Run, stream_run?: Stream) {
    this.store = store;
    this.agents = agents;
    this.run = run ?? ((host, command, options) => agents.run(host, command, options));
    this.stream_run = stream_run ?? ((host, command, options) => agents.stream(host, command, options));
    this.entities = config.entities ?? null;
    this.adopt(config);
    for (const repository_config of config.repositories) this.watch(repository_config);
  }

  // Tells the store the targets and hosts, so their rows carry the entity names and older rows gain them, and tells
  // the hub which host its built-in agent answers for.
  private adopt(config: Config): void {
    this.store.adopt_targets(config.repositories.map(target_key), config.entities?.hosts ?? []);
    this.agents.set_local_host(own_host(config.entities));
  }

  private watch(repository_config: RepositoryConfig): Watched {
    const repository = new BorgRepository(repository_config.name, repository_config.borg, repository_config.scope);
    repository.state = this.store.load_state(repository.id) ?? repository.state;
    repository.runs = this.store.runs_for(target_key(repository_config));
    const status = this.store.polls(repository.id).at(-1)?.status ?? null;
    const watched = { config: repository_config, repository, status };
    this.repositories.set(repository.id, watched);
    return watched;
  }

  // Takes a changed config without a restart: new repositories are polled at once, changed ones start over from
  // their stored state, and removed ones stop being polled while their history stays in the store.
  apply_config(config: Config): void {
    this.entities = config.entities ?? null;
    this.adopt(config);
    const next = new Map(config.repositories.map((repository_config) => [target_id(repository_config), repository_config]));
    for (const id of this.repositories.keys()) {
      if (next.has(id)) continue;
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
      this.repositories.delete(id);
    }
    for (const [id, repository_config] of next) {
      const current = this.repositories.get(id);
      if (current !== undefined && JSON.stringify(current.config) === JSON.stringify(repository_config)) continue;
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
      this.watch(repository_config);
      if (!this.stopped) void this.poll(id);
    }
  }

  // Polls every repository now, which also picks up runs left going before a restart, then keeps polling.
  start(): void {
    this.stopped = false;
    this.agents.on("connect", this.on_connect);
    for (const id of this.repositories.keys()) void this.poll(id);
  }

  stop(): void {
    this.stopped = true;
    this.agents.off("connect", this.on_connect);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  // Polls the repository, sharing a poll already waiting or running rather than starting a second.
  poll(id: string): Promise<CollectResult> {
    const pending = this.pending_polls.get(id);
    if (pending) return pending;
    const runs = this.watched(id).repository.runs;
    const poll = this.queued(id, async () => {
      const followed_run = runs?.running() != null;
      const result = await this.poll_now(id);
      return { result, run_ended: followed_run && runs?.running() == null };
    }).then(({ result, run_ended }) => {
      this.pending_polls.delete(id);
      // A finished run changed the repository, so it is polled again at once rather than after its interval.
      if (run_ended) void this.poll(id);
      else this.schedule(id);
      return result;
    });
    this.pending_polls.set(id, poll);
    return poll;
  }

  // Polls every target whose commands run on the host, as when its agent has just connected.
  private poll_host(host: string): void {
    if (this.stopped) return;
    for (const watched of this.repositories.values()) {
      if (host_name(watched) === host) void this.poll(watched.repository.id);
    }
  }

  // Runs an action's commands one after another and keeps what its reader reports, or starts its long run. A task's
  // long run is recorded under the task, and its plain commands, such as the canary's, as a run of the task's kind.
  run_action(id: string, plan: ActionPlan | LongRunPlan, task: TaskRun | null = null): Promise<CollectResult> {
    return this.queued(id, async () => {
      const watched = this.watched(id);
      let result: CollectResult;
      if (plan instanceof LongRunPlan) result = await this.start_run(watched, plan, task?.id ?? null);
      else result = task === null ? await this.run_plan(watched, plan) : await this.run_recorded(watched, plan, task);
      this.keep(watched, result, false);
      return result;
    }).finally(() => this.schedule(id));
  }

  // Runs a task's plain commands as a run of their own, so the task's history shows them like any other run.
  private async run_recorded(watched: Watched, plan: ActionPlan, task: TaskRun): Promise<CollectResult> {
    const runs = watched.repository.runs!;
    const run_id = runs.create(task.kind, redact(plan.commands.join("\n")), task.id);
    let result: CollectResult;
    try {
      result = await this.run_plan(watched, plan);
    } catch (error) {
      result = failed_result(error);
    }
    const message = result.content ?? result.logs.at(-1)?.[0] ?? null;
    if (message !== null) runs.append_output(run_id, message.split("\n"));
    runs.finish(run_id, result.success ? "succeeded" : "failed", { exit_code: result.success ? 0 : 1, error: result.success ? null : message });
    return result;
  }

  private async run_plan(watched: Watched, plan: ActionPlan): Promise<CollectResult> {
    const results: CmdResult[] = [];
    for (const command of plan.commands) {
      const options = { timeout_in_seconds: plan.timeout ?? longest_action_in_seconds, stdin: plan.stdin };
      results.push(await this.run(host_name(watched), command, options));
    }
    return plan.read(results);
  }

  // Runs the plan's preflight, then records the run and has the host's agent start it under the record's agent run id.
  private async start_run(watched: Watched, plan: LongRunPlan, task: string | null): Promise<CollectResult> {
    const host = host_name(watched);
    if (plan.preflight !== null) {
      const skipped = plan.read_preflight(await this.run(host, plan.preflight, { timeout_in_seconds: preflight_timeout_in_seconds }));
      if (skipped !== null) return skipped;
    }
    const run_id = plan.record(task);
    const agent_run = this.store.run_row(run_id)!.agent_run!;
    try {
      await this.agents.start(host, agent_run, plan.command, { stdin: plan.stdin });
    } catch (error) {
      return plan.read_start(run_id, message_of(error));
    }
    return plan.read_start(run_id, null);
  }

  // Stops the target's run on its agent, then reads it to its end, which records it as cancelled.
  cancel_run(id: string): Promise<CollectResult> {
    return this.queued(id, async () => {
      const watched = this.watched(id);
      const run = watched.repository.active_run();
      if (run === null) return BorgRepository.refused("Nothing is running for this repository");
      try {
        await this.agents.stop(host_name(watched), run.agent_run!);
      } catch (error) {
        return watched.repository.read_cancel_failed(run, message_of(error));
      }
      const result = await this.follow_run(watched, run);
      this.keep(watched, result, false);
      return result;
    }).finally(() => this.schedule(id));
  }

  // Streams a command outside the queue, since a download can run for hours and borg's lock wait already keeps it apart.
  // It is listed until it ends, with who started it, so whoever sees a backup waiting on it can stop it.
  stream(id: string, command: string, stdin: string | null, details: { who: string; what: string }): CommandStream {
    const stream = this.stream_run(host_name(this.watched(id)), command, { stdin });
    const record = { id: this.next_download_id++, target_id: id, ...details, started_epoch: Math.floor(Date.now() / 1000) };
    this.running_downloads.set(record.id, { record, stop: stream.stop });
    this.store.changed({ kind: "repository", target_id: id });
    void stream.done.then(() => {
      this.running_downloads.delete(record.id);
      this.store.changed({ kind: "repository", target_id: id });
    });
    return stream;
  }

  downloads(id: string): DownloadRecord[] {
    return [...this.running_downloads.values()].map(({ record }) => record).filter((record) => record.target_id === id);
  }

  // Stops the repository's download with that id, saying whether there was one.
  stop_download(id: string, download_id: number): boolean {
    const download = this.running_downloads.get(download_id);
    if (download === undefined || download.record.target_id !== id) return false;
    download.stop();
    return true;
  }

  // Follows a run while one is going, otherwise lists the repository.
  private async poll_now(id: string): Promise<CollectResult> {
    const watched = this.watched(id);
    const run = watched.repository.active_run();
    let result: CollectResult;
    try {
      result = run === null ? await this.poll_repository(watched) : await this.follow_run(watched, run);
    } catch (error) {
      result = failed_result(error);
    }
    this.keep(watched, result, true);
    await this.read_host(watched);
    return result;
  }

  private async poll_repository(watched: Watched): Promise<CollectResult> {
    const results: CmdResult[] = [];
    for (const command of watched.repository.commands()) {
      const options = { timeout_in_seconds: command.timeout ?? longest_action_in_seconds, stdin: command.stdin };
      results.push(await this.run(host_name(watched), command.text, options));
    }
    return watched.repository.parse(results);
  }

  // Reads what the run has written since the last read, until it has caught up, and forgets the run on its agent once
  // it is recorded as ended. An agent that cannot be asked leaves it waiting, and one that no longer knows it loses it.
  private async follow_run(watched: Watched, run: RunRecord): Promise<CollectResult> {
    const host = host_name(watched);
    const agent_run = run.agent_run!;
    let current = run;
    for (let read = 0; read < most_run_reads_per_poll; read++) {
      let poll: LongRunPoll;
      try {
        poll = await this.agents.poll(host, agent_run, current.output_seq);
      } catch (error) {
        if (await this.agent_lost(host, agent_run)) return watched.repository.read_run_lost(current, host);
        return watched.repository.read_run_unreachable(current, message_of(error));
      }
      const result = watched.repository.read_run_poll(current, poll);
      const next = this.store.run_row(current.id)!;
      if (next.state !== "running") {
        await this.agents.forget(host, agent_run).catch(() => {});
        return result;
      }
      // Caught up, or a partial line that needs more output before it can be read.
      if (poll.next_offset >= poll.size || next.output_seq === current.output_seq) return result;
      current = next;
    }
    return new CollectResult();
  }

  // Whether the host's agent is connected and lists no run of that id.
  private async agent_lost(host: string, agent_run: string): Promise<boolean> {
    if (!this.agents.is_connected(host)) return false;
    try {
      return !(await this.agents.runs(host)).some((listed) => listed.run_id === agent_run);
    } catch {
      return false;
    }
  }

  // Reads the backup timers and the load of the target's host, keeping the last good read when one fails.
  private async read_host(watched: Watched): Promise<void> {
    const host = host_name(watched);
    const now = Date.now() / 1000;
    if (now - (this.timers_read.get(host) ?? 0) < timer_read_interval_in_seconds) return;
    try {
      // A host without systemd answers with nothing, and so shows no timers; one whose agent is away is asked again next poll.
      const result = await this.run(host, timers_command(), { timeout_in_seconds: 30 });
      if (result.exit_code === -1) return;
      this.timers_read.set(host, now);
      const timers = parse_timers(result.stdout);
      if (timers !== null) this.store.replace_timers(host, timers);
    } catch {
      // A failed read keeps the timers last read.
    }
    // The host's load is sampled at the same pace, so its charts have a point per timer read.
    try {
      this.store.add_host_sample(host, await this.agents.health(host));
    } catch {
      // A host that cannot be read simply leaves a gap in its charts.
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

  // Sets the next poll: soon while a run is going, else after the repository's interval.
  private schedule(id: string): void {
    // A repository removed while its poll ran is not polled again.
    if (this.stopped || !this.repositories.has(id)) return;
    clearTimeout(this.timers.get(id));
    const watched = this.watched(id);
    const run_going = watched.repository.runs?.running() != null;
    const delay = run_going ? run_poll_interval_in_seconds : watched.config.interval_in_seconds;
    this.timers.set(id, setTimeout(() => void this.poll(id), delay * 1000));
  }

  private watched(id: string): Watched {
    const watched = this.repositories.get(id);
    if (!watched) throw new Error(`No repository '${id}'`);
    return watched;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// The name of the host a target's commands run on, which keys its timers and readings: a job's source host, or the
// host that polls a repository only watched.
export function host_name(watched: Watched): string {
  return target_key(watched.config).host;
}

function message_of(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Answers a failed run as the repository's own failure, so one broken host never stops the others.
function failed_result(error: unknown): CollectResult {
  return CollectResult.failed(`Poll failed: ${message_of(error)}`);
}
