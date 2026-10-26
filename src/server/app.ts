// ── Imports ──────────────────────────────────────────────────────────────────

import { existsSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import fastify_static from "@fastify/static";
import { register_auth } from "./auth.ts";
import { browser_rows } from "./borg/parsing.ts";
import type { BorgRepository } from "./borg/repository.ts";
import { CollectResult, type ActionStart } from "./borg/types.ts";
import { host_name, type Poller, type Watched } from "./poller.ts";
import type { Change, JobRow, Store } from "./store.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

export interface app_options {
  serve_web: boolean;
  logger: boolean;
  password_hash: string;
  poller: Poller;
  store: Store;
}

interface ActionBody {
  archive?: string;
  path?: string;
  paths?: string[];
  kind?: string;
}

interface ListQuery {
  repository?: string;
  kind?: string;
  state?: string;
  level?: string;
  since?: string;
  limit?: string;
  offset?: string;
}

const web_build_directory = fileURLToPath(new URL("../../dist", import.meta.url));

// A stream sends a comment this often, so proxies keep an idle connection open.
const stream_keepalive_in_milliseconds = 25_000;

// Fields that may hold a secret, shown only as set or not.
const secret_fields = new Set(["passphrase", "passphrase_command"]);

// ── Actions ──────────────────────────────────────────────────────────────────

// Each action the page may ask for, calling the repository's method for it.
const actions: Record<string, (repository: BorgRepository, body: ActionBody) => ActionStart> = {
  run_backup: (repository) => repository.run_backup(),
  dry_run_backup: (repository) => repository.dry_run_backup(),
  prune_preview: (repository) => repository.prune_preview(),
  verify_restore: (repository) => repository.verify_restore(),
  restore_archive: (repository, body) => repository.restore_archive(body.archive ?? null, [...(body.path ? [body.path] : []), ...(body.paths ?? [])]),
  check_repo: (repository, body) => repository.check_repo(body.kind),
  compact_repo: (repository) => repository.compact_repo(),
  prune_repo: (repository) => repository.prune_repo(),
  delete_archive: (repository, body) => repository.delete_archive(body.archive ?? null),
  break_lock: (repository) => repository.break_lock(),
  purge_preview: (repository) => repository.purge_preview(),
  purge_excluded: (repository) => repository.purge_excluded(),
  diff_archive: (repository, body) => repository.diff_archive(body.archive ?? null),
};

// The action a finished job reruns with, or null for one that needs a choice the job did not keep (restore, delete).
export function retry_action(kind: string): [action_id: string, body: ActionBody] | null {
  if (kind === "check") return ["check_repo", { kind: "all" }];
  if (kind.startsWith("check-")) return ["check_repo", { kind: kind.slice("check-".length) }];
  const by_kind: Record<string, string> = {
    backup: "run_backup",
    "dry-run": "dry_run_backup",
    compact: "compact_repo",
    prune: "prune_repo",
    purge: "purge_excluded",
    "purge-preview": "purge_preview",
    verify_restore: "verify_restore",
  };
  return Object.hasOwn(by_kind, kind) ? [by_kind[kind], {}] : null;
}

// ── App ──────────────────────────────────────────────────────────────────────

export async function build_app(options: app_options): Promise<FastifyInstance> {
  const app = fastify({ logger: options.logger });
  const { poller, store } = options;

  register_auth(app, options.password_hash);

  const find = (id: string, reply: FastifyReply): Watched | null => {
    const watched = poller.repositories.get(id) ?? null;
    if (watched === null) void reply.code(404).send({ error: `No repository '${id}'.` });
    return watched;
  };

  // Runs what an action asked for, or hands back its answer when it needs no command.
  const settle = async (id: string, start: ActionStart): Promise<CollectResult> =>
    start instanceof CollectResult ? start : poller.run_action(id, start);

  // Polls at once after an action that started a job, so its output shows without waiting.
  const outcome = (id: string, result: CollectResult) => {
    if (poller.repositories.get(id)!.repository.jobs?.running()) void poller.poll(id);
    return { success: result.success, content: result.content, logs: result.logs };
  };

  app.get("/api/health", async () => ({
    status: "ok",
    repositories: [...poller.repositories.values()].map((watched) => ({ id: watched.repository.id, status: watched.status })),
  }));

  // ── Repositories ─────────────────────────────────────────────────────────

  app.get("/api/repositories", async () => [...poller.repositories.values()].map(summary));

  app.get<{ Params: { id: string } }>("/api/repositories/:id", async (request, reply) => {
    const watched = find(request.params.id, reply);
    if (watched === null) return reply;
    const repository = watched.repository;
    return {
      ...summary(watched),
      repo: repository.repo,
      archives: repository.state.archives,
      info: repository.state.repository,
      checks: repository.state.checks,
      source_paths: repository.source_paths,
      exclude: repository.exclude,
      retention: repository.retention,
      allow_delete: repository.allow_delete,
      actions: repository.get_actions().map((action) => ({ ...action, state: repository.action_state(action) })),
    };
  });

  app.get<{ Params: { id: string }; Querystring: { since?: string } }>("/api/repositories/:id/history", async (request, reply) => {
    const watched = find(request.params.id, reply);
    if (watched === null) return reply;
    const id = watched.repository.id;
    return { polls: store.polls(id, Number(request.query.since ?? 0)), archives: store.archives(id) };
  });

  app.post<{ Params: { id: string; action: string }; Body: ActionBody | undefined }>(
    "/api/repositories/:id/actions/:action",
    async (request, reply) => {
      const watched = find(request.params.id, reply);
      if (watched === null) return reply;
      const start_action = actions[request.params.action];
      if (start_action === undefined) return reply.code(404).send({ error: `No action '${request.params.action}'.` });
      const id = watched.repository.id;
      return outcome(id, await settle(id, start_action(watched.repository, request.body ?? {})));
    },
  );

  app.post<{ Params: { id: string } }>("/api/repositories/:id/poll", async (request, reply) => {
    const watched = find(request.params.id, reply);
    if (watched === null) return reply;
    await poller.poll(watched.repository.id);
    return summary(watched);
  });

  app.get<{ Params: { id: string }; Querystring: { archive?: string; path?: string } }>(
    "/api/repositories/:id/browse",
    async (request, reply) => {
      const watched = find(request.params.id, reply);
      if (watched === null) return reply;
      const { archive = "", path = "" } = request.query;
      const result = await settle(watched.repository.id, watched.repository.browse_archive(archive || null, path));
      const entries = watched.repository.listing(archive, path) ?? [];
      return { success: result.success, content: result.content, rows: browser_rows(entries, watched.repository.browse_limit), more: entries.length > watched.repository.browse_limit };
    },
  );

  // The archive's changes against the one before it, diffing it first when that has not been done yet.
  app.get<{ Params: { id: string }; Querystring: { archive?: string } }>("/api/repositories/:id/diff", async (request, reply) => {
    const watched = find(request.params.id, reply);
    if (watched === null) return reply;
    const archive = request.query.archive ?? "";
    const cached = watched.repository.diff(archive);
    if (cached !== null) return { success: true, content: null, ...cached };
    const result = await settle(watched.repository.id, watched.repository.diff_archive(archive || null));
    return { success: result.success, content: result.content, ...(watched.repository.diff(archive) ?? { changes: [], more: false }) };
  });

  // The repository's settings as declared, with secrets shown only as set.
  app.get<{ Params: { id: string } }>("/api/repositories/:id/config", async (request, reply) => {
    const watched = find(request.params.id, reply);
    if (watched === null) return reply;
    const { name, host, ssh_user, interval_in_seconds, borg } = watched.config;
    const fields = Object.fromEntries(Object.entries(borg).map(([field, value]) => [field, secret_fields.has(field) ? "(set)" : value]));
    return {
      source: "declared", editable: false, config_mode: "declarative",
      fields: { name, host, ssh_user, interval: interval_in_seconds, ...fields },
    };
  });

  // Repositories and archives whose names hold the text, for the header's search.
  app.get<{ Querystring: { q?: string } }>("/api/search", async (request) => {
    const text = (request.query.q ?? "").trim().toLowerCase();
    if (!text) return { repositories: [], archives: [] };
    const watched = [...poller.repositories.values()].map(({ repository }) => repository);
    return {
      repositories: watched
        .filter((repository) => repository.name.toLowerCase().includes(text) || repository.id.toLowerCase().includes(text))
        .slice(0, 10)
        .map((repository) => ({ id: repository.id, name: repository.name })),
      archives: watched
        .flatMap((repository) => repository.state.archives.map((archive) => ({ repository_id: repository.id, name: archive.name, epoch: archive.epoch })))
        .filter((archive) => archive.name.toLowerCase().includes(text))
        .sort((left, right) => right.epoch - left.epoch)
        .slice(0, 20),
    };
  });

  // ── Jobs and events ──────────────────────────────────────────────────────

  app.get<{ Querystring: ListQuery }>("/api/jobs", async (request) => {
    const query = request.query;
    return store.jobs({
      repository_id: query.repository, kind: query.kind, state: query.state, since_epoch: number_or_undefined(query.since),
      limit: Number(query.limit ?? 100), offset: Number(query.offset ?? 0),
    }).map(with_retry);
  });

  app.get<{ Params: { id: string }; Querystring: { skip?: string } }>("/api/jobs/:id", async (request, reply) => {
    const job = store.job(Number(request.params.id));
    if (job === null) return reply.code(404).send({ error: "No such job." });
    return { ...with_retry(job), output: store.job_output(job.id, Number(request.query.skip ?? 0)) };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/cancel", async (request, reply) => {
    const job = store.job(Number(request.params.id));
    const watched = job ? poller.repositories.get(job.repository_id) : undefined;
    if (!job || !watched) return reply.code(404).send({ error: "No such job." });
    if (watched.repository.jobs?.running()?.id !== job.id) return reply.code(409).send({ error: "That job is not running." });
    return outcome(job.repository_id, await settle(job.repository_id, watched.repository.cancel_job()));
  });

  // Runs a finished job's action again, as if its button had been pressed.
  app.post<{ Params: { id: string } }>("/api/jobs/:id/retry", async (request, reply) => {
    const job = store.job(Number(request.params.id));
    const watched = job ? poller.repositories.get(job.repository_id) : undefined;
    if (!job || !watched) return reply.code(404).send({ error: "No such job." });
    if (job.state === "running") return reply.code(409).send({ error: "That job is still running." });
    const retry = retry_action(job.kind);
    if (retry === null) return reply.code(409).send({ error: `A ${job.kind} is started again from its archive.` });
    const [action_id, body] = retry;
    return outcome(job.repository_id, await settle(job.repository_id, actions[action_id](watched.repository, body)));
  });

  app.get("/api/timers", async () => store.timers());

  app.get<{ Querystring: ListQuery }>("/api/events", async (request) => {
    const query = request.query;
    return store.events({ repository_id: query.repository, level: query.level, limit: Number(query.limit ?? 100), offset: Number(query.offset ?? 0) });
  });

  // ── Live changes ─────────────────────────────────────────────────────────

  // Server-sent events naming what changed, so an open page fetches it at once instead of polling.
  const streams = new Set<ServerResponse>();
  app.get("/api/stream", (request, reply) => {
    reply.hijack();
    const stream = reply.raw;
    stream.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    stream.write("retry: 5000\n\n");
    const send = (change: Change) => stream.write(`data: ${JSON.stringify(change)}\n\n`);
    const keepalive = setInterval(() => stream.write(": keepalive\n\n"), stream_keepalive_in_milliseconds);
    store.changes.on("change", send);
    streams.add(stream);
    request.raw.on("close", () => {
      clearInterval(keepalive);
      store.changes.off("change", send);
      streams.delete(stream);
    });
  });
  // An open stream never ends by itself, so closing the app ends each one.
  app.addHook("onClose", async () => {
    for (const stream of streams) stream.end();
  });

  // In production the server also hands out the built web page.
  if (options.serve_web && existsSync(web_build_directory)) {
    await app.register(fastify_static, { root: web_build_directory });
  }

  return app;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// A job as the page shows it, with whether it can be run again.
function with_retry(job: JobRow) {
  return { ...job, retry: job.state !== "running" && retry_action(job.kind) !== null };
}

function number_or_undefined(value: string | undefined): number | undefined {
  return value === undefined || value === "" ? undefined : Number(value);
}

// What the repository list shows for one repository.
function summary(watched: Watched) {
  const repository = watched.repository;
  const state = repository.state;
  return {
    id: repository.id,
    name: repository.name,
    host: host_name(watched),
    status: watched.status,
    max_age: repository.max_age,
    last_poll_epoch: state.last_poll_epoch,
    last_backup_epoch: state.last_backup_epoch,
    archive_count: state.archive_count,
    stats: state.stats,
    canary: state.canary,
    checks_passed: state.checks?.passed ?? null,
    running_job: repository.jobs?.running() ?? null,
    // Every repository comes from the declared file until the page can add its own.
    source: "declared",
  };
}
