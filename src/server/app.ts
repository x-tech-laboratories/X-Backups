// ── Imports ──────────────────────────────────────────────────────────────────

import { existsSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastify_static from "@fastify/static";
import { acts_on_whole_repository, repository_actions, scope_of, sees, sees_whole_repository, writers, type Scope, type World } from "./access.ts";
import { AccountError, Accounts, has_role } from "./accounts.ts";
import type { AgentHub } from "./agents/hub.ts";
import { register_agent_route } from "./agents/route.ts";
import { register_auth, type ProxyLogin } from "./auth.ts";
import { health, repository_health } from "./health.ts";
import { backup_map, map_entry, map_links } from "./map.ts";
import { metrics_text } from "./metrics.ts";
import type { OidcClient } from "./oidc.ts";
import { browser_rows } from "./borg/parsing.ts";
import { WAITING_FOR_AGENT, type BorgRepository } from "./borg/repository.ts";
import { as_list } from "./borg/shell.ts";
import { CollectResult, type ActionStart } from "./borg/types.ts";
import { host_name, type Poller, type Watched } from "./poller.ts";
import type { Scheduler, TaskSpec, TaskView } from "./scheduler.ts";
import {
  ConfigError, default_settings, entity_field_list, entity_kinds, entity_tasks, field_list, is_own_host, target_key, type Config, type EntityKind,
  type HostKind, type JobEntity,
} from "./config.ts";
import { describe, next_due, parse_schedule, schedule_time_zone } from "./schedule.ts";
import { mask, type ConfigSources } from "./sources.ts";
import type { Change, RunRow, Store, VisibleRows } from "./store.ts";

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
  // What the map calls this machine, where repositories without a host are; the system's hostname unless set.
  server_name?: string;
  // The agents commands run through, reached on /api/agent; the poller's own unless given.
  agents?: AgentHub;
  // Starts the tasks; without it /api/tasks is not served.
  scheduler?: Scheduler;
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

// A list narrowed to one target, or to the targets of one host, job or repository.
interface ListQuery {
  target?: string;
  host?: string;
  job?: string;
  repository?: string;
  task?: string;
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

// How many coming times a schedule's preview lists.
const preview_count = 3;

// What access.ts calls one entity of each kind.
const seen_kind: Record<EntityKind, "host" | "repository" | "source" | "job"> = { hosts: "host", repositories: "repository", sources: "source", jobs: "job" };


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

// The action a finished run reruns with, or null for one that needs a choice the run did not keep (restore, delete).
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
  const agents = options.agents ?? poller.agents;

  const accounts = new Accounts(store, { name: options.admin_name ?? "admin", password_hash: options.password_hash });

  // ── Access ───────────────────────────────────────────────────────────────

  // The configured targets and entities access.ts works out what each viewer sees from.
  const world = (): World => ({
    targets: [...poller.repositories.values()].map(({ config }) => ({ ...target_key(config), sources: config.target?.sources ?? [] })),
    entities: poller.entities,
  });

  // What the viewer sees, or null for everything.
  const scope = (request: FastifyRequest): Scope | null => scope_of(request.viewer?.grants ?? null, world());

  register_auth(app, {
    accounts, oidc: options.oidc, proxy: options.proxy,
    sees_target: (request, target_id) => sees(scope(request), { kind: "target", target_id }),
  });
  await register_agent_route(app, agents);

  // The targets this viewer sees.
  const watched_by = (request: FastifyRequest): Watched[] => {
    const shown = scope(request);
    return [...poller.repositories.values()].filter((watched) => sees(shown, { kind: "target", target_id: watched.repository.id }));
  };

  // The rows a list of runs or events is narrowed to, or undefined when the viewer sees everything.
  const visible_rows = (request: FastifyRequest): VisibleRows | undefined => {
    const shown = scope(request);
    return shown === null ? undefined : { targets: [...shown.targets], repositories: [...shown.repositories] };
  };

  const run_seen = (shown: Scope | null, run: RunRow | null): RunRow | null =>
    run !== null && sees(shown, { kind: "run", target_id: run.target_id, repository: run.repository, run_kind: run.kind }) ? run : null;

  const visible_run = (request: FastifyRequest, id: string) => run_seen(scope(request), store.run_row(Number(id)));

  // Acting on the whole repository needs an admin, or a viewer who sees every job writing there.
  const whole_repository = (request: FastifyRequest, watched: Watched): boolean =>
    has_role(request.viewer!.role, "admin") || sees_whole_repository(scope(request), target_key(watched.config).repository, world());

  const refuse_whole_repository = (reply: FastifyReply, watched: Watched, what: string) =>
    reply.code(403).send({
      error: `${what} acts on the whole repository '${target_key(watched.config).repository}', so it needs an admin or access to every job writing there.`,
    });

  // Keeps who ran an action beside what it did, so the events say who pruned or purged.
  const note_actor = (request: FastifyRequest, target_id: string, what: string) => {
    store.apply(target_id, new CollectResult({ logs: [[`${request.viewer?.name ?? "someone"} ${what}`, "INFO"]] }), { poll: false });
  };

  const find = (id: string, reply: FastifyReply): Watched | null => {
    const watched = poller.repositories.get(id) ?? null;
    if (watched === null) void reply.code(404).send({ error: `No repository '${id}'.` });
    return watched;
  };

  // Runs what an action asked for, or starts its long run, or hands back its answer when it needs no command.
  const settle = async (id: string, start: ActionStart): Promise<CollectResult> =>
    start instanceof CollectResult ? start : poller.run_action(id, start);

  // Polls at once after an action that started a run, so its output shows without waiting.
  const outcome = (id: string, result: CollectResult) => {
    if (poller.repositories.get(id)!.repository.runs?.running()) void poller.poll(id);
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
      actions: repository.get_actions()
        .filter((action) => !repository_actions.has(action.action_id) || whole_repository(request, watched))
        .map((action) => ({ ...action, state: repository.action_state(action) })),
      ...repository_extras(request, watched),
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
      if (repository_actions.has(request.params.action) && !whole_repository(request, watched)) {
        return refuse_whole_repository(reply, watched, request.params.action.replaceAll("_", " "));
      }
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

  // Which host's folders each repository backs up and where it is stored, with each repository's health.
  app.get("/api/map", async (request) => {
    const shown = watched_by(request);
    const server_name = options.server_name ?? hostname();
    const map = backup_map(shown.map(({ config }) => map_entry(config, poller.entities)), server_name);
    return {
      ...map,
      links: map_links(poller.entities, server_name),
      repositories: map.repositories.map((placed, index) => ({ ...summary(shown[index]), ...placed, retention: shown[index].repository.retention })),
    };
  });

  // The repository's settings as declared, with secrets shown only as set.
  // The repository's entry as written, with secrets masked, and whether the page may change it.
  app.get<{ Params: { id: string } }>("/api/repositories/:id/config", async (request, reply) => {
    const watched = find(request.params.id, reply);
    if (watched === null) return reply;
    const { name, host, interval_in_seconds, borg, source } = watched.config;
    // A job's target has no entry of its own, so it shows its built fields and is changed through its entities.
    const written = sources?.entry(name) ?? null;
    const fields = written ?? mask({ name, host, interval: interval_in_seconds, ...borg });
    const may_edit = Boolean(sources?.editable) && has_role(request.viewer!.role, "admin");
    return { source, editable: may_edit && source === "page" && written !== null, config_mode: sources?.mode ?? "declarative", fields };
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
  const applied = (config: Config, target_id: string | null, message: string) => {
    poller.apply_config(config);
    if (target_id !== null) store.apply(target_id, new CollectResult({ logs: [[message, "INFO"]] }), { poll: false });
    store.changed({ kind: "config", target_id });
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
        .flatMap((repository) => repository.state.archives.map((archive) => ({ target_id: repository.id, name: archive.name, epoch: archive.epoch })))
        .filter((archive) => archive.name.toLowerCase().includes(text))
        .sort((left, right) => right.epoch - left.epoch)
        .slice(0, 20),
    };
  });

  // ── Runs and events ──────────────────────────────────────────────────

  app.get<{ Querystring: ListQuery }>("/api/runs", async (request) => {
    const query = request.query;
    return store.runs({
      ...target_filter(query), visible: visible_rows(request), task: query.task, kind: query.kind, state: query.state,
      since_epoch: number_or_undefined(query.since),
      limit: Number(query.limit ?? 100), offset: Number(query.offset ?? 0),
    }).map(with_retry);
  });

  app.get<{ Params: { id: string }; Querystring: { skip?: string } }>("/api/runs/:id", async (request, reply) => {
    const run = visible_run(request, request.params.id);
    if (run === null) return reply.code(404).send({ error: "No such run." });
    return { ...with_retry(run), output: store.run_output(run.id, Number(request.query.skip ?? 0)) };
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/cancel", async (request, reply) => {
    const run = visible_run(request, request.params.id);
    const watched = run ? poller.repositories.get(run.target_id) : undefined;
    if (!run || !watched) return reply.code(404).send({ error: "No such run." });
    if (acts_on_whole_repository(run.kind) && !whole_repository(request, watched)) return refuse_whole_repository(reply, watched, `Cancelling a ${run.kind}`);
    if (watched.repository.runs?.running()?.id !== run.id) return reply.code(409).send({ error: "That run is not going." });
    note_actor(request, run.target_id, `cancelled ${run.kind} #${run.id}`);
    return outcome(run.target_id, await poller.cancel_run(run.target_id));
  });

  // Runs a finished run's action again, as if its button had been pressed.
  app.post<{ Params: { id: string } }>("/api/runs/:id/retry", async (request, reply) => {
    const run = visible_run(request, request.params.id);
    const watched = run ? poller.repositories.get(run.target_id) : undefined;
    if (!run || !watched) return reply.code(404).send({ error: "No such run." });
    if (acts_on_whole_repository(run.kind) && !whole_repository(request, watched)) return refuse_whole_repository(reply, watched, `Running a ${run.kind} again`);
    if (run.state === "running") return reply.code(409).send({ error: "That run is still going." });
    const retry = retry_action(run.kind);
    if (retry === null) return reply.code(409).send({ error: `A ${run.kind} is started again from its archive.` });
    const [action_id, body] = retry;
    note_actor(request, run.target_id, `ran ${run.kind} #${run.id} again`);
    return outcome(run.target_id, await settle(run.target_id, actions[action_id](watched.repository, body)));
  });

  // A host's timers show to whoever sees the host.
  app.get("/api/timers", async (request) => {
    const shown = scope(request);
    return store.timers().filter((timer) => sees(shown, { kind: "host", name: timer.host }));
  });

  // ── Tasks ────────────────────────────────────────────────────────────────

  // A job's task shows to whoever sees the job, and a repository's to whoever sees the repository.
  const task_seen = (shown: Scope | null, task: TaskSpec | TaskView): boolean =>
    sees(shown, task.owner_kind === "job" ? { kind: "job", name: task.owner } : { kind: "repository", name: task.owner });

  // Each task the viewer sees, with its schedule, when it is next due, its last run and why it waits; a job's task
  // lists only the targets the viewer sees.
  const visible_tasks = (request: FastifyRequest): TaskView[] => {
    if (options.scheduler === undefined) return [];
    const shown = scope(request);
    return options.scheduler.tasks().filter((task) => task_seen(shown, task)).map((task) => task.owner_kind === "repository" ? task : {
      ...task, targets: task.targets.filter((target) => sees(shown, { kind: "target", target_id: target.target_id })),
    });
  };

  // A schedule in words with its next few times from now, for the config form to show as it is typed.
  app.get<{ Querystring: { text?: string } }>("/api/schedule", async (request, reply) => {
    const text = (request.query.text ?? "").trim();
    const expression = /^\d+$/.test(text) ? Number(text) : text;
    try {
      parse_schedule(expression);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message, field: "schedule" });
    }
    const zone = schedule_time_zone();
    const next: number[] = [];
    let after = Math.floor(Date.now() / 1000);
    for (let index = 0; index < preview_count; index++) {
      after = next_due(expression, after, zone);
      next.push(after);
    }
    return { description: describe(expression), time_zone: zone, next };
  });

  if (options.scheduler !== undefined) {
    const scheduler = options.scheduler;

    // The task the viewer may act on: one they see, and for a repository's task, one whose whole repository they may act on.
    const acting_on = (request: FastifyRequest, reply: FastifyReply, task_id: string): TaskSpec | null => {
      const task = scheduler.spec(task_id);
      if (task === null || !task_seen(scope(request), task)) {
        void reply.code(404).send({ error: `No task '${task_id}'.` });
        return null;
      }
      const watched = task.owner_kind === "repository" ? poller.repositories.get(task.targets[0] ?? "") : undefined;
      if (watched !== undefined && !whole_repository(request, watched)) {
        void refuse_whole_repository(reply, watched, `The ${task.kind} task`);
        return null;
      }
      return task;
    };

    app.get("/api/tasks", async (request) => visible_tasks(request));

    app.post<{ Params: { id: string } }>("/api/tasks/:id/run", async (request, reply) => {
      const task = acting_on(request, reply, request.params.id);
      if (task === null) return reply;
      const shown = scope(request);
      const targets = task.owner_kind === "job" ? task.targets.filter((target_id) => sees(shown, { kind: "target", target_id })) : task.targets;
      for (const target_id of targets) note_actor(request, target_id, `ran the task ${task.id} now`);
      return reply.code(202).send({ id: task.id, targets: await scheduler.run_now(task.id, targets) });
    });

    for (const [action, enabled] of [["enable", true], ["disable", false]] as const) {
      app.post<{ Params: { id: string } }>(`/api/tasks/:id/${action}`, async (request, reply) => {
        const task = acting_on(request, reply, request.params.id);
        if (task === null) return reply;
        scheduler.set_enabled(task.id, enabled, request.viewer!.name);
        for (const target_id of task.targets) note_actor(request, target_id, `${action}d the task ${task.id}`);
        return scheduler.tasks().find((view) => view.id === task.id);
      });
    }
  }

  // ── Hosts ────────────────────────────────────────────────────────────────

  // Each configured host the viewer sees, with its agent's connection, its enrolment and its newest health reading.
  app.get("/api/hosts", async (request) => {
    const shown = scope(request);
    const enrolments = new Map(agents.enrolments().map((enrolment) => [enrolment.host, enrolment]));
    const samples = new Map(store.latest_host_samples().map(({ host, ...sample }) => [host, sample]));
    const entities = poller.entities;
    return configured_hosts(poller).filter((host) => sees(shown, { kind: "host", name: host.name })).map((host) => {
      const status = agents.status(host.name);
      const enrolment = enrolments.get(host.name);
      const remote = status !== null && !status.built_in;
      return {
        name: host.name,
        kind: host.kind,
        address: host.address,
        own: host.own,
        sources: (entities?.sources ?? []).filter((source) => source.host === host.name && sees(shown, { kind: "source", name: source.name })).map((source) => source.name),
        repositories: (entities?.repositories ?? [])
          .filter((repository) => repository.host === host.name && sees(shown, { kind: "repository", name: repository.name })).map((repository) => repository.name),
        connected: status !== null,
        built_in: status?.built_in ?? false,
        agent_version: status?.agent_version ?? null,
        reported_host: status?.reported_host ?? null,
        connected_epoch: remote ? status.connected_epoch : null,
        enrolled: enrolment !== undefined,
        last_seen_epoch: remote ? Math.floor(Date.now() / 1000) : enrolment?.last_seen_epoch ?? null,
        health: samples.get(host.name) ?? null,
      };
    });
  });

  // Issues the host's agent a new token, shown this once; an agent still using the old one is hung up on.
  app.post<{ Params: { name: string } }>("/api/hosts/:name/token", async (request, reply) => {
    const host = configured_hosts(poller).find((item) => item.name === request.params.name);
    if (host === undefined) return reply.code(404).send({ error: `No host '${request.params.name}'.` });
    if (host.kind !== "managed") return reply.code(409).send({ error: `Host '${host.name}' is storage-only, so it runs no agent.` });
    if (host.own) return reply.code(409).send({ error: `Host '${host.name}' is this server, whose agent is built in.` });
    return reply.code(201).send({ host: host.name, token: agents.issue_token(host.name) });
  });

  app.delete<{ Params: { name: string } }>("/api/hosts/:name/token", async (request, reply) => {
    if (!agents.enrolments().some((enrolment) => enrolment.host === request.params.name)) {
      return reply.code(404).send({ error: `Host '${request.params.name}' has no token.` });
    }
    agents.revoke(request.params.name);
    return reply.code(204).send();
  });

  app.get<{ Querystring: { since?: string } }>("/api/hosts/samples", async (request) => {
    const shown = scope(request);
    return store.host_samples(Number(request.query.since ?? 0)).filter((sample) => sees(shown, { kind: "host", name: sample.host }));
  });

  app.get<{ Querystring: { since?: string } }>("/api/timers/runs", async (request) => {
    const shown = scope(request);
    return store.timer_runs(Number(request.query.since ?? 0)).filter((run) => sees(shown, { kind: "host", name: run.host }));
  });

  // ── Jobs and sources ─────────────────────────────────────────────────────

  // Each job the viewer sees with its targets, their status rolled up, and its tasks.
  const jobs_seen = (request: FastifyRequest) => {
    const shown = scope(request);
    const targets = watched_by(request);
    const tasks = visible_tasks(request);
    return configured_jobs(poller).filter((job) => sees(shown, { kind: "job", name: job.name })).map((job) => {
      const own = targets.filter((watched) => target_key(watched.config).job === job.name).map(summary);
      return {
        name: job.name, source: job.source, expanded_from: job.expanded_from, sources: job.sources, repositories: job.repositories, settings: job.borg,
        level: worst_level(own.map((target) => target.level)), targets: own,
        tasks: tasks.filter((task) => task.owner_kind === "job" && task.owner === job.name),
      };
    });
  };

  app.get("/api/jobs", async (request) => jobs_seen(request));

  app.get<{ Params: { name: string } }>("/api/jobs/:name", async (request, reply) => {
    const job = jobs_seen(request).find((item) => item.name === request.params.name);
    return job ?? reply.code(404).send({ error: `No job '${request.params.name}'.` });
  });

  // Each source the viewer sees with its paths and excludes, and the jobs that back it up.
  const sources_seen = (request: FastifyRequest) => {
    const shown = scope(request);
    const jobs = configured_jobs(poller).filter((job) => sees(shown, { kind: "job", name: job.name }));
    return (poller.entities?.sources ?? []).filter((source) => sees(shown, { kind: "source", name: source.name })).map((source) => ({
      name: source.name, host: source.host, source: source.source, expanded_from: source.expanded_from,
      paths: as_list(source.borg.source_paths), exclude: as_list(source.borg.exclude), settings: source.borg,
      jobs: jobs.filter((job) => job.sources.includes(source.name)).map((job) => job.name),
    }));
  };

  app.get("/api/sources", async (request) => sources_seen(request));

  app.get<{ Params: { name: string } }>("/api/sources/:name", async (request, reply) => {
    const source = sources_seen(request).find((item) => item.name === request.params.name);
    return source ?? reply.code(404).send({ error: `No source '${request.params.name}'.` });
  });

  // The jobs writing to a target's repository, its other targets and its own tasks, as far as the viewer sees them.
  const repository_extras = (request: FastifyRequest, watched: Watched) => {
    const shown = scope(request);
    const repository = target_key(watched.config).repository;
    return {
      writers: writers(repository, world()).filter((job) => sees(shown, { kind: "job", name: job })),
      repository_targets: watched_by(request).filter((other) => other !== watched && target_key(other.config).repository === repository).map(summary),
      tasks: visible_tasks(request).filter((task) => task.owner_kind === "repository" && task.owner === repository),
    };
  };

  // ── Entity config ────────────────────────────────────────────────────────

  const entity_kind = (kind: string, reply: FastifyReply): EntityKind | null => {
    if ((entity_kinds as string[]).includes(kind)) return kind as EntityKind;
    void reply.code(404).send({ error: `No kind '${kind}'; use ${entity_kinds.join(", ")}.` });
    return null;
  };

  // Each entry of the kind the viewer sees as written, with where it came from, the fields and tasks the kind takes,
  // and whether the page may change it; a flat repository entry is changed on its target's Config tab.
  app.get<{ Params: { kind: string } }>("/api/config/:kind", async (request, reply) => {
    const kind = entity_kind(request.params.kind, reply);
    if (kind === null) return reply;
    const shown = scope(request);
    const flat = new Set((poller.entities?.repositories ?? []).filter((repository) => repository.expanded_from !== null).map((repository) => repository.name));
    return {
      kind,
      mode: sources?.mode ?? "declarative",
      editable: Boolean(sources?.editable) && has_role(request.viewer!.role, "admin"),
      fields: entity_field_list(kind),
      tasks: entity_tasks(kind),
      entries: (sources?.entries(kind) ?? [])
        .filter((entry) => sees(shown, { kind: seen_kind[kind], name: entry.name }))
        .map((entry) => ({ ...entry, flat: kind === "repositories" && flat.has(entry.name) })),
    };
  });

  app.post<{ Params: { kind: string }; Body: Record<string, unknown> }>("/api/config/:kind", async (request, reply) => {
    const kind = entity_kind(request.params.kind, reply);
    if (kind === null) return reply;
    const editable = editing(reply);
    if (editable === null) return reply;
    applied(editable.save_entity(kind, request.body ?? {}, null), null, "");
    return reply.code(201).send({ name: String(request.body?.name ?? "") });
  });

  app.put<{ Params: { kind: string; name: string }; Body: Record<string, unknown> }>("/api/config/:kind/:name", async (request, reply) => {
    const kind = entity_kind(request.params.kind, reply);
    if (kind === null) return reply;
    const editable = editing(reply);
    if (editable === null) return reply;
    applied(editable.save_entity(kind, request.body ?? {}, request.params.name), null, "");
    return { name: request.params.name };
  });

  app.delete<{ Params: { kind: string; name: string } }>("/api/config/:kind/:name", async (request, reply) => {
    const kind = entity_kind(request.params.kind, reply);
    if (kind === null) return reply;
    const editable = editing(reply);
    if (editable === null) return reply;
    applied(editable.delete_entity(kind, request.params.name), null, "");
    return reply.code(204).send();
  });

  app.get<{ Querystring: ListQuery }>("/api/events", async (request) => {
    const query = request.query;
    return store.events({
      ...target_filter(query), visible: visible_rows(request), level: query.level,
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
    // A change of a target the viewer does not see is left out, unless it is a repository's own run they see.
    const send = (change: Change) => {
      const shown = scope(request);
      const seen = change.target_id === null || sees(shown, { kind: "target", target_id: change.target_id })
        || (change.run_id !== undefined && run_seen(shown, store.run_row(change.run_id)) !== null);
      if (seen) stream.write(`data: ${JSON.stringify(change)}\n\n`);
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
    // The Nix store dates every file to 1970, and a rebuilt index.html keeps its size, so the default
    // size-and-mtime ETag never changes and a browser keeps the old page naming bundles now gone.
    // The page is fetched whole each time; the bundles carry a content hash, so they never change.
    await app.register(fastify_static, {
      root: web_build_directory,
      etag: false,
      lastModified: false,
      cacheControl: false,
      setHeaders: (reply, path) => {
        const immutable = path.includes("/assets/");
        void reply.header("cache-control", immutable ? "public, max-age=31536000, immutable" : "no-cache, no-store");
      },
    });
  }

  return app;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// The hosts the config names, or for a config built by hand the hosts its targets run on; own is this server's.
function configured_hosts(poller: Poller): { name: string; kind: HostKind; address: string | null; own: boolean }[] {
  if (poller.entities !== null) {
    return poller.entities.hosts.map((host) => ({ name: host.name, kind: host.kind, address: host.address, own: is_own_host(host) }));
  }
  const names = [...new Set([...poller.repositories.values()].map(host_name))];
  return names.map((name) => ({ name, kind: "managed" as const, address: null, own: poller.agents.status(name)?.built_in ?? false }));
}

// The jobs the config names, or for a config built by hand one per target, named after it.
function configured_jobs(poller: Poller): Pick<JobEntity, "name" | "source" | "expanded_from" | "sources" | "repositories" | "borg">[] {
  if (poller.entities !== null) return poller.entities.jobs;
  return [...poller.repositories.values()].map(({ config }) => {
    const key = target_key(config);
    return { name: key.job ?? key.target_id, source: config.source, expanded_from: config.name, sources: [], repositories: [key.repository], borg: {} };
  });
}

// The worst of the levels, or null with none.
function worst_level(levels: ("ok" | "warning" | "critical")[]): "ok" | "warning" | "critical" | null {
  if (levels.length === 0) return null;
  if (levels.includes("critical")) return "critical";
  return levels.includes("warning") ? "warning" : "ok";
}

// A run as the page shows it, with whether it can be run again, and whether it waits for its host's agent or was lost.
function with_retry(run: RunRow) {
  const condition = run.state === "running" && run.progress === WAITING_FOR_AGENT ? "waiting_for_agent"
    : run.state === "failed" && run.error?.startsWith("Lost:") ? "lost" : null;
  return { ...run, retry: run.state !== "running" && retry_action(run.kind) !== null, condition };
}

function target_filter(query: ListQuery) {
  return { target_id: query.target, host: query.host, job: query.job, repository: query.repository };
}

function number_or_undefined(value: string | undefined): number | undefined {
  return value === undefined || value === "" ? undefined : Number(value);
}

// What the repository list shows for one target, with the host, job and repository it is built from.
function summary(watched: Watched) {
  const repository = watched.repository;
  const state = repository.state;
  const key = target_key(watched.config);
  return {
    id: repository.id,
    name: repository.name,
    target_id: key.target_id,
    host: key.host,
    job: key.job,
    repository: key.repository,
    status: watched.status,
    ...repository_health(watched),
    max_age: repository.max_age,
    warn_age: repository.warn_age,
    quota: repository.quota,
    storage: state.storage ?? null,
    last_poll_epoch: state.last_poll_epoch,
    last_backup_epoch: state.last_backup_epoch,
    archive_count: state.archive_count,
    stats: state.stats,
    canary: state.canary,
    checks_passed: state.checks?.passed ?? null,
    running_run: repository.runs?.running() ?? null,
    source: watched.config.source,
  };
}
