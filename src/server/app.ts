// ── Imports ──────────────────────────────────────────────────────────────────

import { existsSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastify_static from "@fastify/static";
import { AccountError, Accounts, has_role } from "./accounts.ts";
import { register_auth, visible, type ProxyLogin } from "./auth.ts";
import { health, repository_health } from "./health.ts";
import { metrics_text } from "./metrics.ts";
import type { OidcClient } from "./oidc.ts";
import { browser_rows } from "./borg/parsing.ts";
import type { BorgRepository } from "./borg/repository.ts";
import { CollectResult, type ActionStart } from "./borg/types.ts";
import { host_name, type Poller, type Watched } from "./poller.ts";
import { ConfigError, default_settings, field_list, type Config } from "./config.ts";
import { mask, type ConfigSources } from "./sources.ts";
import type { Change, JobRow, Store } from "./store.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

export interface app_options {
  serve_web: boolean;
  logger: boolean;
  password_hash: string;
  // The name the password hash logs in as; "admin" unless X_BACKUPS_ADMIN_NAME says otherwise.
  admin_name?: string;
  oidc?: OidcClient | null;
  proxy?: ProxyLogin | null;
  poller: Poller;
  store: Store;
  // Where the config comes from; without it the config is the poller's own and read-only.
  sources?: ConfigSources;
}

interface ActionBody {
  archive?: string;
  path?: string;
  paths?: string[];
  kind?: string;
  // Where a restore goes, and whether into a new dated folder inside it.
  target?: string;
  fresh?: boolean;
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


// ── Actions ──────────────────────────────────────────────────────────────────

// Each action the page may ask for, calling the repository's method for it.
const actions: Record<string, (repository: BorgRepository, body: ActionBody) => ActionStart> = {
  run_backup: (repository) => repository.run_backup(),
  dry_run_backup: (repository) => repository.dry_run_backup(),
  prune_preview: (repository) => repository.prune_preview(),
  verify_restore: (repository) => repository.verify_restore(),
  restore_archive: (repository, body) => repository.restore_archive(
    body.archive ?? null, [...(body.path ? [body.path] : []), ...(body.paths ?? [])], body.target ?? null, body.fresh !== false,
  ),
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
  const { poller, store, sources } = options;

  const accounts = new Accounts(store, { name: options.admin_name ?? "admin", password_hash: options.password_hash });
  register_auth(app, { accounts, oidc: options.oidc, proxy: options.proxy });

  // The repositories this viewer sees.
  const watched_by = (request: FastifyRequest): Watched[] =>
    [...poller.repositories.values()].filter((watched) => visible(request, watched.repository.id));

  // The repository ids a list is narrowed to, or undefined when the viewer sees them all.
  const allowed_ids = (request: FastifyRequest): string[] | undefined => request.viewer?.repositories ?? undefined;

  const visible_job = (request: FastifyRequest, id: string) => {
    const job = store.job(Number(id));
    return job !== null && visible(request, job.repository_id) ? job : null;
  };

  // Keeps who ran an action beside what it did, so the events say who pruned or purged.
  const note_actor = (request: FastifyRequest, repository_id: string, what: string) => {
    store.apply(repository_id, new CollectResult({ logs: [[`${request.viewer?.name ?? "someone"} ${what}`, "INFO"]] }), { poll: false });
  };

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

  // Answers 503 when any repository is critical, so a plain HTTP check alerts without reading the body.
  app.get("/api/health", async (_request, reply) => {
    const report = health([...poller.repositories.values()]);
    return reply.code(report.status === "critical" ? 503 : 200).send(report);
  });

  // ── Repositories ─────────────────────────────────────────────────────────

  app.get("/api/repositories", async (request) => watched_by(request).map(summary));

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
      restore_dir: repository.restore_dir,
      downloads: poller.downloads(repository.id),
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
      note_actor(request, id, `asked for ${request.params.action.replaceAll("_", " ")}${request.body?.archive ? ` on ${request.body.archive}` : ""}`);
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

  // Streams one file, or folders and several paths as a gzipped tar, straight from borg to the browser with no timeout.
  app.get<{ Params: { id: string }; Querystring: { archive?: string; path?: string | string[]; kind?: string } }>(
    "/api/repositories/:id/download",
    async (request, reply) => {
      const watched = find(request.params.id, reply);
      if (watched === null) return reply;
      const { archive = "", path = [], kind = "tar" } = request.query;
      const paths = [path].flat();
      const download = watched.repository.download(archive || null, paths, kind);
      if (download instanceof CollectResult) return reply.code(400).send({ error: download.content });

      const what = `${paths.length > 0 ? paths.join(", ") : "everything"} from ${archive}`;
      const stream = poller.stream(watched.repository.id, download.command, download.stdin, { who: request.viewer?.name ?? "someone", what });
      // A browser that goes away stops borg, rather than leaving it reading the archive for nobody.
      reply.raw.on("close", stream.stop);
      // The answer waits for borg's first bytes, so a borg that fails at once answers with its error instead of an empty file.
      const first = await new Promise<Buffer | null>((resolve) => {
        stream.stdout.once("data", (chunk: Buffer) => {
          stream.stdout.pause();
          resolve(chunk);
        });
        void stream.done.then(() => resolve(null));
      });
      if (first === null) {
        const { exit_code, stderr } = await stream.done;
        if (exit_code !== 0) return reply.code(502).send({ error: watched.repository.download_failure(exit_code, stderr) });
      }

      // Characters a quoted header value cannot hold are swapped in the plain name and kept in the RFC 6266 one.
      const plain_name = download.filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
      const encoded_name = encodeURIComponent(download.filename).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
      note_actor(request, watched.repository.id, `downloaded ${what}`);
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": download.content_type,
        "content-disposition": `attachment; filename="${plain_name}"; filename*=UTF-8''${encoded_name}`,
        "cache-control": "no-store",
      });
      if (first !== null) reply.raw.write(first);
      stream.stdout.pipe(reply.raw, { end: false });
      // A borg that fails midway cuts the connection, so the browser marks the download failed instead of keeping a short file.
      void stream.done.then(({ exit_code }) => {
        if (exit_code > 1) reply.raw.destroy();
        else reply.raw.end();
      });
      return reply;
    },
  );

  // Stops a running download, such as one a backup is waiting on.
  app.post<{ Params: { id: string; download: string } }>("/api/repositories/:id/downloads/:download/stop", async (request, reply) => {
    const watched = find(request.params.id, reply);
    if (watched === null) return reply;
    if (!poller.stop_download(watched.repository.id, Number(request.params.download))) return reply.code(404).send({ error: "That download has ended." });
    note_actor(request, watched.repository.id, `stopped download ${request.params.download}`);
    return { ok: true };
  });

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
  // The repository's entry as written, with secrets masked, and whether the page may change it.
  app.get<{ Params: { id: string } }>("/api/repositories/:id/config", async (request, reply) => {
    const watched = find(request.params.id, reply);
    if (watched === null) return reply;
    const { name, host, ssh_user, interval_in_seconds, borg, source } = watched.config;
    const fields = sources?.entry(name) ?? mask({ name, host, ssh_user, interval: interval_in_seconds, ...borg });
    const may_edit = Boolean(sources?.editable) && has_role(request.viewer!.role, "admin");
    return { source, editable: may_edit && source === "page", config_mode: sources?.mode ?? "declarative", fields };
  });

  // ── Config ───────────────────────────────────────────────────────────────

  // How the config is kept, the fields a repository takes, and the defaults with where each came from.
  app.get("/api/config", async (request) => ({
    mode: sources?.mode ?? "declarative",
    editable: Boolean(sources?.editable) && has_role(request.viewer!.role, "admin"),
    fields: field_list(),
    settings: sources?.settings() ?? Object.entries(default_settings).map(([name, { fallback }]) => ({ name, value: fallback, source: "default" })),
    shadowed: sources?.shadowed() ?? [],
  }));

  // Applies a config the sources accepted, logging what changed on the repository it concerns.
  const applied = (config: Config, repository_id: string | null, message: string) => {
    poller.apply_config(config);
    if (repository_id !== null) store.apply(repository_id, new CollectResult({ logs: [[message, "INFO"]] }), { poll: false });
    store.changed({ kind: "config", repository_id });
  };

  const editing = (reply: FastifyReply): ConfigSources | null => {
    if (sources?.editable) return sources;
    void reply.code(403).send({ error: "The config is declarative here: change it in the Nix configuration." });
    return null;
  };

  app.post<{ Body: Record<string, unknown> }>("/api/repositories", async (request, reply) => {
    const editable = editing(reply);
    if (editable === null) return reply;
    const name = String(request.body?.name ?? "");
    applied(editable.save_repository(request.body ?? {}, null), name, "Repository added from the page");
    return reply.code(201).send({ id: name });
  });

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/repositories/:id/config", async (request, reply) => {
    const watched = find(request.params.id, reply);
    if (watched === null) return reply;
    const editable = editing(reply);
    if (editable === null) return reply;
    applied(editable.save_repository(request.body ?? {}, watched.config.name), watched.repository.id, "Config saved from the page");
    return { id: watched.repository.id };
  });

  app.delete<{ Params: { id: string } }>("/api/repositories/:id", async (request, reply) => {
    const watched = find(request.params.id, reply);
    if (watched === null) return reply;
    const editable = editing(reply);
    if (editable === null) return reply;
    const id = watched.repository.id;
    applied(editable.delete_repository(watched.config.name), null, "");
    store.apply(id, new CollectResult({ logs: [["Repository removed from the page; its history is kept", "WARNING"]] }), { poll: false });
    return reply.code(204).send();
  });

  app.put<{ Body: Record<string, unknown> }>("/api/config/defaults", async (request, reply) => {
    const editable = editing(reply);
    if (editable === null) return reply;
    applied(editable.save_defaults(request.body ?? {}), null, "");
    return { settings: editable.settings() };
  });

  // A config the checks refused answers with the message and the field it names, for the page to show beside it.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ConfigError) return reply.code(400).send({ error: error.message, field: error.field });
    if (error instanceof AccountError) return reply.code(error.status).send({ error: error.message });
    reply.log.error(error);
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    return reply.code(status).send({ error: (error as Error).message });
  });

  // Repositories and archives whose names hold the text, for the header's search.
  app.get<{ Querystring: { q?: string } }>("/api/search", async (request) => {
    const text = (request.query.q ?? "").trim().toLowerCase();
    if (!text) return { repositories: [], archives: [] };
    const watched = watched_by(request).map(({ repository }) => repository);
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
      repository_id: query.repository, repository_ids: allowed_ids(request), kind: query.kind, state: query.state,
      since_epoch: number_or_undefined(query.since),
      limit: Number(query.limit ?? 100), offset: Number(query.offset ?? 0),
    }).map(with_retry);
  });

  app.get<{ Params: { id: string }; Querystring: { skip?: string } }>("/api/jobs/:id", async (request, reply) => {
    const job = visible_job(request, request.params.id);
    if (job === null) return reply.code(404).send({ error: "No such job." });
    return { ...with_retry(job), output: store.job_output(job.id, Number(request.query.skip ?? 0)) };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/cancel", async (request, reply) => {
    const job = visible_job(request, request.params.id);
    const watched = job ? poller.repositories.get(job.repository_id) : undefined;
    if (!job || !watched) return reply.code(404).send({ error: "No such job." });
    if (watched.repository.jobs?.running()?.id !== job.id) return reply.code(409).send({ error: "That job is not running." });
    note_actor(request, job.repository_id, `cancelled ${job.kind} #${job.id}`);
    return outcome(job.repository_id, await settle(job.repository_id, watched.repository.cancel_job()));
  });

  // Runs a finished job's action again, as if its button had been pressed.
  app.post<{ Params: { id: string } }>("/api/jobs/:id/retry", async (request, reply) => {
    const job = visible_job(request, request.params.id);
    const watched = job ? poller.repositories.get(job.repository_id) : undefined;
    if (!job || !watched) return reply.code(404).send({ error: "No such job." });
    if (job.state === "running") return reply.code(409).send({ error: "That job is still running." });
    const retry = retry_action(job.kind);
    if (retry === null) return reply.code(409).send({ error: `A ${job.kind} is started again from its archive.` });
    const [action_id, body] = retry;
    note_actor(request, job.repository_id, `ran ${job.kind} #${job.id} again`);
    return outcome(job.repository_id, await settle(job.repository_id, actions[action_id](watched.repository, body)));
  });

  // A host's timers show to whoever sees one of its repositories.
  app.get("/api/timers", async (request) => {
    const hosts = new Set(watched_by(request).map(host_name));
    return store.timers().filter((timer) => hosts.has(timer.host));
  });

  app.get<{ Querystring: ListQuery }>("/api/events", async (request) => {
    const query = request.query;
    return store.events({
      repository_id: query.repository, repository_ids: allowed_ids(request), level: query.level,
      limit: Number(query.limit ?? 100), offset: Number(query.offset ?? 0),
    });
  });

  // ── Live changes ─────────────────────────────────────────────────────────

  // Server-sent events naming what changed, so an open page fetches it at once instead of polling.
  const streams = new Set<ServerResponse>();
  app.get("/api/stream", (request, reply) => {
    reply.hijack();
    const stream = reply.raw;
    stream.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    stream.write("retry: 5000\n\n");
    const send = (change: Change) => {
      if (change.repository_id === null || visible(request, change.repository_id)) stream.write(`data: ${JSON.stringify(change)}\n\n`);
    };
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

  // ── Metrics ──────────────────────────────────────────────────────────────

  app.get("/metrics", async (request, reply) => reply.type("text/plain; version=0.0.4").send(metrics_text(watched_by(request))));

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
    ...repository_health(watched),
    max_age: repository.max_age,
    warn_age: repository.warn_age,
    last_poll_epoch: state.last_poll_epoch,
    last_backup_epoch: state.last_backup_epoch,
    archive_count: state.archive_count,
    stats: state.stats,
    canary: state.canary,
    checks_passed: state.checks?.passed ?? null,
    running_job: repository.jobs?.running() ?? null,
    source: watched.config.source,
  };
}
