// Starts each job's and repository's tasks when they fall due, on the agent of the host each target runs on, through
// the poller's action paths so every run is recorded under its task. When a task is next due comes from the store: the
// start of its newest run on each target, or of an action of the same kind started by hand, and for a task run after a
// backup, the end of the newest successful one. A restart so picks up where it left off, and a task never run is due
// at once.
//
// One run goes at a time on a repository, and on a job's targets from one host; the rest queue. A task whose host's
// agent is away waits, and runs once when the agent connects however many times it fell due meanwhile. A task that
// could not start, such as one whose preflight skipped it, tries again after retry_in_seconds.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { AgentStatus } from "./agents/hub.ts";
import { check_run_kind } from "./borg/checks.ts";
import type { BorgRepository } from "./borg/repository.ts";
import { CollectResult, type ActionStart } from "./borg/types.ts";
import { target_key, type Entities, type TaskConfig, type TaskKind } from "./config.ts";
import { host_name, type Poller } from "./poller.ts";
import { describe, next_due, schedule_time_zone } from "./schedule.ts";
import type { Change, RunRow, Store, TaskOverride } from "./store.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export type TaskOwnerKind = "job" | "repository";

// One configured task with the targets it runs on: each of a job's, or the one offering a repository's own actions.
export interface TaskSpec {
  // Stable across restarts and config reloads: "job:<name>:<kind>" or "repository:<name>:<kind>".
  id: string;
  owner_kind: TaskOwnerKind;
  owner: string;
  kind: TaskKind;
  config: TaskConfig;
  targets: string[];
}

export interface LastRun {
  id: number;
  state: string;
  started_epoch: number;
  ended_epoch: number | null;
}

// One task on one target as the scheduler sees it now.
export interface TaskTarget {
  target_id: string;
  host: string;
  repository: string;
  job: string | null;
  next_due: number | null;
  last_run: LastRun | null;
  running: boolean;
  // Why a task that is due has not started: its agent is away, the repository is busy, or its last start was refused.
  waiting: string | null;
}

export interface TaskView {
  id: string;
  owner_kind: TaskOwnerKind;
  owner: string;
  kind: TaskKind;
  schedule: string | number | null;
  after: "backup" | null;
  check: string | null;
  description: string;
  origin: TaskConfig["origin"];
  enabled: boolean;
  enabled_by_config: boolean;
  override: TaskOverride | null;
  // The soonest across its targets, and the newest run across them.
  next_due: number | null;
  last_run: LastRun | null;
  running: boolean;
  waiting: string | null;
  targets: TaskTarget[];
}

export interface SchedulerOptions {
  // The time now in seconds, for tests.
  now?: () => number;
  time_zone?: string;
  // How often due tasks are looked for, besides whenever a run ends or an agent connects.
  tick_in_seconds?: number;
  // Each scheduled start is put off by up to this much, the same for one task and target each time, so tasks due at
  // the same moment spread out.
  jitter_in_seconds?: number;
  retry_in_seconds?: number;
}

// One task on one target, worked out for this moment.
interface Item {
  task: TaskSpec;
  target: TaskTarget;
  key: string;
  due: boolean;
  // Due only because a backup succeeded, which a repository's compact holds back while backups and prunes are due.
  due_after_backup_only: boolean;
  startable: boolean;
}

// The run kinds that count as each task's runs, including ones started by hand.
function run_kinds(task: TaskSpec): string[] {
  switch (task.kind) {
    case "backup":
    case "prune":
    case "compact":
      return [task.kind];
    case "canary":
      return ["verify_restore"];
    case "check":
      return [check_run_kind(task.config.check ?? "all")];
  }
}

const kind_order: Record<TaskKind, number> = { backup: 0, prune: 1, check: 2, canary: 3, compact: 4 };

// ── Task list ────────────────────────────────────────────────────────────────

// Every configured task with its targets; a config built by hand has none.
export function task_specs(entities: Entities | null, target_jobs: Map<string, string | null>): TaskSpec[] {
  if (entities === null) return [];
  const specs: TaskSpec[] = [];
  for (const job of entities.jobs) {
    const targets = [...target_jobs].filter(([, name]) => name === job.name).map(([target]) => target);
    for (const [kind, config] of Object.entries(job.tasks)) {
      specs.push({ id: `job:${job.name}:${kind}`, owner_kind: "job", owner: job.name, kind: kind as TaskKind, config, targets });
    }
  }
  for (const repository of entities.repositories) {
    const targets = repository.actions_target === null ? [] : [repository.actions_target];
    for (const [kind, config] of Object.entries(repository.tasks)) {
      specs.push({ id: `repository:${repository.name}:${kind}`, owner_kind: "repository", owner: repository.name, kind: kind as TaskKind, config, targets });
    }
  }
  return specs;
}

// The task's schedule in words, with whether it also runs after a backup.
export function describe_task(config: TaskConfig): string {
  const scheduled = config.schedule === null ? null : describe(config.schedule);
  if (config.after === "backup") return scheduled === null ? "After each successful backup" : `${scheduled}, and after each successful backup`;
  return scheduled ?? "Only when started by hand";
}

// ── Scheduler ────────────────────────────────────────────────────────────────

export class Scheduler {
  private readonly poller: Poller;
  private readonly store: Store;
  private readonly now: () => number;
  private readonly time_zone: string;
  private readonly tick_in_seconds: number;
  private readonly jitter_in_seconds: number;
  private readonly retry_in_seconds: number;
  // Run now asked for these, by task and target, until they start.
  private readonly requested = new Set<string>();
  // Starts handed to the poller and not yet answered.
  private readonly starting = new Set<string>();
  // Starts refused or skipped, held until they may try again.
  private readonly held = new Map<string, { reason: string; until: number }>();
  private interval: NodeJS.Timeout | null = null;
  private soon: NodeJS.Timeout | null = null;
  private readonly on_connect = (_status: AgentStatus) => this.tick_soon();
  private readonly on_change = (change: Change) => {
    if (change.kind === "run" || change.kind === "config") this.tick_soon();
  };

  constructor(poller: Poller, store: Store, options: SchedulerOptions = {}) {
    this.poller = poller;
    this.store = store;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.time_zone = options.time_zone ?? schedule_time_zone();
    this.tick_in_seconds = options.tick_in_seconds ?? 30;
    this.jitter_in_seconds = options.jitter_in_seconds ?? 60;
    this.retry_in_seconds = options.retry_in_seconds ?? 600;
  }

  start(): void {
    this.poller.agents.on("connect", this.on_connect);
    this.store.changes.on("change", this.on_change);
    this.interval = setInterval(() => void this.tick(), this.tick_in_seconds * 1000);
    this.tick_soon();
  }

  stop(): void {
    this.poller.agents.off("connect", this.on_connect);
    this.store.changes.off("change", this.on_change);
    if (this.interval !== null) clearInterval(this.interval);
    if (this.soon !== null) clearTimeout(this.soon);
    this.interval = null;
    this.soon = null;
  }

  // Looks again shortly, once however many runs end or agents connect meanwhile.
  private tick_soon(): void {
    if (this.interval === null || this.soon !== null) return;
    this.soon = setTimeout(() => {
      this.soon = null;
      void this.tick();
    }, 1000);
  }

  // ── Starting ─────────────────────────────────────────────────────────────

  // Starts every task due now whose host's agent is here and whose repository and job are free, answering once each
  // start has been answered.
  async tick(): Promise<void> {
    const starts = this.evaluate().filter((item) => item.startable).map((item) => this.begin(item));
    await Promise.all(starts);
  }

  private async begin(item: Item): Promise<void> {
    const { task, target, key } = item;
    const watched = this.poller.repositories.get(target.target_id);
    if (watched === undefined) return;
    this.starting.add(key);
    this.requested.delete(key);
    this.held.delete(key);
    const before = this.store.last_task_run(target.target_id, task.id, [])?.id ?? 0;
    try {
      const start = task_start(task, watched.repository);
      const result = start instanceof CollectResult ? start : await this.poller.run_action(target.target_id, start, { id: task.id, kind: run_kinds(task)[0] });
      const recorded = (this.store.last_task_run(target.target_id, task.id, [])?.id ?? 0) > before;
      if (!recorded) this.hold(item, result, start instanceof CollectResult);
      else void this.poller.poll(target.target_id);
    } catch (error) {
      this.hold(item, CollectResult.failed(error instanceof Error ? error.message : String(error)), true);
    } finally {
      this.starting.delete(key);
    }
  }

  // Holds a start that recorded no run, noting why on the target once, so it tries again later rather than every tick.
  private hold(item: Item, result: CollectResult, note: boolean): void {
    const reason = result.content ?? result.logs.at(-1)?.[0] ?? "it could not start";
    const until = this.now() + this.retry_in_seconds;
    this.held.set(item.key, { reason, until });
    // A start through the poller already kept its own logs.
    if (note) {
      const message = `Task ${item.task.id} could not start: ${reason}`;
      this.store.apply(item.target.target_id, new CollectResult({ logs: [[message, "WARNING"]] }), { poll: false });
    }
    this.store.changed({ kind: "tasks", target_id: item.target.target_id });
  }

  // ── Page actions ─────────────────────────────────────────────────────────

  spec(task_id: string): TaskSpec | null {
    return this.specs().find((task) => task.id === task_id) ?? null;
  }

  // Starts the task on each of its targets, or the ones given, as soon as their agents and repositories allow,
  // whatever its schedule and whether it is enabled; answers the targets asked for.
  async run_now(task_id: string, target_ids: string[] | null = null): Promise<string[]> {
    const task = this.spec(task_id);
    if (task === null) return [];
    const targets = task.targets.filter((target) => target_ids === null || target_ids.includes(target));
    for (const target of targets) {
      const key = item_key(task.id, target);
      this.requested.add(key);
      this.held.delete(key);
    }
    this.store.changed({ kind: "tasks", target_id: null });
    await this.tick();
    return targets;
  }

  // Switches the task on or off, keeping the choice only where it differs from the config.
  set_enabled(task_id: string, enabled: boolean, by: string): boolean {
    const task = this.spec(task_id);
    if (task === null) return false;
    this.store.set_task_override(task_id, enabled === task.config.enabled ? null : enabled, by);
    this.tick_soon();
    return true;
  }

  // ── Views ────────────────────────────────────────────────────────────────

  // Every task as it stands now.
  tasks(): TaskView[] {
    const overrides = this.store.task_overrides();
    const items = this.evaluate();
    return this.specs().map((task) => {
      const targets = items.filter((item) => item.task.id === task.id).map((item) => item.target);
      const override = overrides.get(task.id) ?? null;
      const due = targets.map((target) => target.next_due).filter((epoch): epoch is number => epoch !== null);
      const last = targets.map((target) => target.last_run).filter((run): run is LastRun => run !== null).sort((left, right) => right.id - left.id)[0] ?? null;
      return {
        id: task.id, owner_kind: task.owner_kind, owner: task.owner, kind: task.kind,
        schedule: task.config.schedule, after: task.config.after, check: task.config.check, description: describe_task(task.config),
        origin: task.config.origin, enabled: override?.enabled ?? task.config.enabled, enabled_by_config: task.config.enabled, override,
        next_due: due.length === 0 ? null : Math.min(...due), last_run: last,
        running: targets.some((target) => target.running), waiting: targets.find((target) => target.waiting !== null)?.waiting ?? null,
        targets,
      };
    });
  }

  private specs(): TaskSpec[] {
    const target_jobs = new Map([...this.poller.repositories.values()].map(({ config }) => [target_key(config).target_id, target_key(config).job]));
    return task_specs(this.poller.entities, target_jobs);
  }

  // ── Working out what is due ──────────────────────────────────────────────

  // Each task on each target: when it is next due, whether it is due now, and whether it may start or why it waits.
  private evaluate(): Item[] {
    const now = this.now();
    const overrides = this.store.task_overrides();
    const running = this.store.runs({ state: "running", limit: 10_000 });
    const items: Item[] = [];
    for (const task of this.specs()) {
      const enabled = overrides.get(task.id)?.enabled ?? task.config.enabled;
      for (const target_id of task.targets) {
        const watched = this.poller.repositories.get(target_id);
        if (watched === undefined) continue;
        const key = item_key(task.id, target_id);
        const entities = target_key(watched.config);
        const last = this.store.last_task_run(target_id, task.id, run_kinds(task));
        const going = last?.state === "running" || this.starting.has(key);
        const requested = this.requested.has(key);
        const scheduled = enabled ? this.scheduled_due(task, key, last) : null;
        const after_backup = enabled ? this.after_backup_due(task, target_id, entities.repository, last) : null;
        const next = requested ? now : min_of(scheduled, after_backup);
        items.push({
          task, key,
          target: {
            target_id, host: host_name(watched), repository: entities.repository, job: entities.job,
            next_due: next, last_run: last === null ? null : last_run(last), running: last?.state === "running", waiting: null,
          },
          due: !going && next !== null && next <= now,
          due_after_backup_only: !requested && after_backup !== null && after_backup <= now && (scheduled === null || scheduled > now),
          startable: false,
        });
      }
    }
    this.place(items, running, now);
    return items;
  }

  private scheduled_due(task: TaskSpec, key: string, last: RunRow | null): number | null {
    if (task.config.schedule === null) return null;
    if (last === null) return this.now();
    const anchor = last.started_epoch;
    return next_due(task.config.schedule, anchor, this.time_zone) + jitter(`${key}\n${anchor}`, this.jitter_in_seconds);
  }

  // When a successful backup, newer than the task's last run, makes it due: a prune's own target's backup, or for a
  // repository's compact any backup or prune of the repository.
  private after_backup_due(task: TaskSpec, target_id: string, repository: string, last: RunRow | null): number | null {
    if (task.config.after !== "backup") return null;
    const targets = task.owner_kind === "job" ? [target_id] : this.targets_of(repository);
    const kinds = task.owner_kind === "job" ? ["backup"] : ["backup", "prune"];
    const ended = this.store.last_success_epoch(targets, kinds);
    if (ended === null || (last !== null && ended <= last.started_epoch)) return null;
    return ended;
  }

  private targets_of(repository: string): string[] {
    return [...this.poller.repositories.values()].map(({ config }) => target_key(config)).filter((key) => key.repository === repository).map((key) => key.target_id);
  }

  // Lets the due items start, soonest first, while their agents are here and their repositories and job hosts are free.
  private place(items: Item[], running: RunRow[], now: number): void {
    const busy_repositories = new Map<string, string>();
    const busy_job_hosts = new Map<string, string>();
    for (const run of running) {
      const label = `${run.kind} run #${run.id}`;
      if (run.repository !== null) busy_repositories.set(run.repository, label);
      if (run.job !== null && run.host !== null) busy_job_hosts.set(`${run.job}\n${run.host}`, label);
    }
    const due = items.filter((item) => item.due).sort((left, right) =>
      left.target.next_due! - right.target.next_due! || kind_order[left.task.kind] - kind_order[right.task.kind]);
    // Backups and prunes due on a repository whose agents are here hold its compact after a backup back.
    const writing = new Set(due.filter((item) => (item.task.kind === "backup" || item.task.kind === "prune")
      && this.poller.agents.is_connected(item.target.host)).map((item) => item.target.repository));

    for (const item of due) {
      const { target } = item;
      const held = this.held.get(item.key);
      const job_host = target.job === null ? null : `${target.job}\n${target.host}`;
      if (held !== undefined && held.until > now) {
        target.waiting = `Could not start: ${held.reason}; tries again at ${new Date(held.until * 1000).toISOString()}`;
      } else if (!this.poller.agents.is_connected(target.host)) {
        target.waiting = `Waiting for ${target.host}'s agent to connect`;
      } else if (item.task.kind === "compact" && item.due_after_backup_only && writing.has(target.repository)) {
        target.waiting = `Waiting for the backups and prunes due on ${target.repository} to finish`;
      } else if (busy_repositories.has(target.repository)) {
        target.waiting = `Queued behind ${busy_repositories.get(target.repository)} on ${target.repository}`;
      } else if (item.task.owner_kind === "job" && job_host !== null && busy_job_hosts.has(job_host)) {
        target.waiting = `Queued behind ${busy_job_hosts.get(job_host)} of ${target.job} on ${target.host}`;
      } else {
        item.startable = true;
        busy_repositories.set(target.repository, `${item.task.id}`);
        if (job_host !== null) busy_job_hosts.set(job_host, `${item.task.id}`);
      }
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// The action that starts the task's run on one target.
function task_start(task: TaskSpec, repository: BorgRepository): ActionStart {
  switch (task.kind) {
    case "backup":
      return repository.run_backup();
    case "prune":
      return repository.prune_repo(true);
    case "compact":
      return repository.compact_repo();
    case "canary":
      return repository.verify_restore();
    case "check":
      return task.owner_kind === "job"
        ? repository.check_own_archives(task.config.check === "extract" ? "extract" : "archives")
        : repository.check_repo(task.config.check ?? "all");
  }
}

function item_key(task_id: string, target_id: string): string {
  return `${task_id}\n${target_id}`;
}

function last_run(run: RunRow): LastRun {
  return { id: run.id, state: run.state, started_epoch: run.started_epoch, ended_epoch: run.ended_epoch };
}

function min_of(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.min(left, right);
}

// A delay from 0 to most seconds, the same each time for the same text.
function jitter(text: string, most: number): number {
  if (most <= 0) return 0;
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return (hash >>> 0) % (most + 1);
}
