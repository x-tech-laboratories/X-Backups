// ── Imports ──────────────────────────────────────────────────────────────────

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import fastify_static from "@fastify/static";
import { register_auth } from "./auth.ts";
import type { BorgRepository } from "./borg/repository.ts";
import { CollectResult, type ActionStart } from "./borg/types.ts";
import type { Poller, Watched } from "./poller.ts";
import type { Store } from "./store.ts";

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

const web_build_directory = fileURLToPath(new URL("../dist", import.meta.url));

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
      return { success: result.success, content: result.content, entries: watched.repository.listing(archive, path) ?? [] };
    },
  );

  // ── Jobs and events ──────────────────────────────────────────────────────

  app.get<{ Querystring: { repository?: string; limit?: string } }>("/api/jobs", async (request) =>
    store.jobs({ repository_id: request.query.repository, limit: Number(request.query.limit ?? 100) }));

  app.get<{ Params: { id: string }; Querystring: { skip?: string } }>("/api/jobs/:id", async (request, reply) => {
    const job = store.job(Number(request.params.id));
    if (job === null) return reply.code(404).send({ error: "No such job." });
    return { ...job, output: store.job_output(job.id, Number(request.query.skip ?? 0)) };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/cancel", async (request, reply) => {
    const job = store.job(Number(request.params.id));
    const watched = job ? poller.repositories.get(job.repository_id) : undefined;
    if (!job || !watched) return reply.code(404).send({ error: "No such job." });
    if (watched.repository.jobs?.running()?.id !== job.id) return reply.code(409).send({ error: "That job is not running." });
    return outcome(job.repository_id, await settle(job.repository_id, watched.repository.cancel_job()));
  });

  app.get<{ Querystring: { repository?: string; limit?: string } }>("/api/events", async (request) =>
    store.events({ repository_id: request.query.repository, limit: Number(request.query.limit ?? 100) }));

  // In production the server also hands out the built web page.
  if (options.serve_web && existsSync(web_build_directory)) {
    await app.register(fastify_static, { root: web_build_directory });
  }

  return app;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// What the repository list shows for one repository.
function summary(watched: Watched) {
  const repository = watched.repository;
  const state = repository.state;
  return {
    id: repository.id,
    name: repository.name,
    host: watched.config.host,
    status: watched.status,
    max_age: repository.max_age,
    last_poll_epoch: state.last_poll_epoch,
    last_backup_epoch: state.last_backup_epoch,
    archive_count: state.archive_count,
    stats: state.stats,
    canary: state.canary,
    checks_passed: state.checks?.passed ?? null,
    running_job: repository.jobs?.running() ?? null,
  };
}
