// X-Backups' routes as MCP tools at /api/mcp, so an AI client can read the backups and act on them as the signed-in
// caller.
//
// Each tool runs its route inside the app with the caller's own sign-in and grants, so it sees and may do exactly
// what the page lets them. Downloads, agent tokens and config editing are left to the page.

// ── Imports ──────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";

import type { JsonSchema, ParamSpec } from "@x-tech-laboratories/x-libs/api_spec";
import { register_mcp_route, route_tools, type RouteToolSpec } from "@x-tech-laboratories/x-libs/server/mcp";
import type { FastifyInstance } from "fastify";

import { CHECK_KINDS } from "./borg/checks.ts";
import { entity_kinds } from "./config.ts";

// ── Arguments ────────────────────────────────────────────────────────────────

const text: JsonSchema = { type: "string", minLength: 1 };
const whole: JsonSchema = { type: "integer", minimum: 0 };
const epoch: JsonSchema = { type: "integer", minimum: 0, description: "Unix time in seconds" };

const one_of = (values: readonly string[]): JsonSchema => ({ type: "string", enum: [...values] });
const optional = (name: string, schema: JsonSchema): ParamSpec => ({ name, schema, optional: true });
const repository: ParamSpec = { name: "id", schema: { ...text, description: "The repository target's id, as list_repositories gives it" } };
const run: ParamSpec = { name: "id", schema: { type: "integer", minimum: 1, description: "The run's id, as list_runs gives it" } };
const task: ParamSpec = { name: "id", schema: { ...text, description: "The task's id, as list_tasks gives it" } };

// What narrows list_runs and list_events: one target, or the targets of one host, job or repository.
const list_filters: ParamSpec[] = [
  optional("target", text), optional("host", text), optional("job", text), optional("repository", text),
  optional("limit", { type: "integer", minimum: 1 }), optional("offset", whole),
];

// ── Tools ────────────────────────────────────────────────────────────────────

export function mcp_routes(action_ids: string[]): Record<string, RouteToolSpec> {
  return {
    list_repositories: {
      route: "GET /api/repositories",
      description: "Lists every repository target: a borg repository on one host a job backs up to, with its health, last backup and archive count.",
      params: [],
    },
    get_repository: {
      route: "GET /api/repositories/:id",
      description: "Shows one repository target with its archives, checks, settings, running downloads and the actions it offers.",
      params: [repository],
    },
    get_repository_history: {
      route: "GET /api/repositories/:id/history",
      description: "Gives one repository target's polls over time and every archive it has held.",
      params: [repository, optional("since", epoch)],
    },
    get_repository_config: { route: "GET /api/repositories/:id/config", description: "Shows one repository target's settings as written, with secrets masked.", params: [repository] },
    poll_repository: { route: "POST /api/repositories/:id/poll", description: "Reads a repository target's state from borg again now, and answers with it.", params: [repository] },
    run_repository_action: {
      route: "POST /api/repositories/:id/actions/:action",
      description:
        "Runs an action on a repository target, as its button on the page does, and answers once it has started. " +
        "restore_archive takes archive, path or paths, target and fresh; delete_archive and diff_archive take archive; check_repo takes kind.",
      params: [
        repository,
        { name: "action", schema: one_of(action_ids) },
        optional("archive", text),
        optional("path", text),
        optional("paths", { type: "array", items: { type: "string" } }),
        optional("kind", one_of(Object.keys(CHECK_KINDS))),
        optional("target", { ...text, description: "The folder a restore goes into" }),
        optional("fresh", { type: "boolean", description: "Whether a restore goes into a new dated folder inside the target; true unless false" }),
      ],
    },
    browse_archive: {
      route: "GET /api/repositories/:id/browse",
      description: "Lists the files and folders at a path inside an archive; the newest archive and its top level unless named.",
      params: [repository, optional("archive", text), optional("path", { type: "string" })],
    },
    diff_archive: {
      route: "GET /api/repositories/:id/diff",
      description: "Lists what changed in an archive against the one before it.",
      params: [repository, optional("archive", text)],
    },
    stop_download: {
      route: "POST /api/repositories/:id/downloads/:download/stop",
      description: "Stops a running download of a repository target, by the id get_repository lists.",
      params: [repository, { name: "download", schema: { type: "integer", minimum: 1 } }],
    },
    search: { route: "GET /api/search", description: "Finds repositories and archives whose names hold the text.", params: [{ name: "q", schema: text }] },
    get_map: { route: "GET /api/map", description: "Shows which folders each job backs up and the repositories it writes them to, with each target's health.", params: [] },
    get_config: { route: "GET /api/config", description: "Shows how the config is kept, the fields a repository takes and the defaults with where each came from.", params: [] },
    list_config: {
      route: "GET /api/config/:kind",
      description: "Lists the config entries of one kind as written, with where each came from.",
      params: [{ name: "kind", schema: one_of(entity_kinds) }],
    },

    list_runs: {
      route: "GET /api/runs",
      description: "Lists runs, newest first: backups, checks, prunes, restores and every other borg command, with how each ended.",
      params: [...list_filters, optional("task", text), optional("kind", text), optional("state", one_of(["running", "succeeded", "warning", "failed", "cancelled"])), optional("since", epoch)],
    },
    get_run: { route: "GET /api/runs/:id", description: "Shows one run with its output.", params: [run, optional("skip", whole)] },
    cancel_run: { route: "POST /api/runs/:id/cancel", description: "Cancels a run that is still going.", params: [run] },
    retry_run: { route: "POST /api/runs/:id/retry", description: "Runs a finished run's action again.", params: [run] },
    list_events: {
      route: "GET /api/events",
      description: "Lists the event log, newest first: what happened to each target and who asked for it.",
      params: [...list_filters, optional("level", one_of(["INFO", "WARNING", "ERROR"]))],
    },

    list_tasks: { route: "GET /api/tasks", description: "Lists the scheduled tasks with their schedule, when each is next due, its last run and why it waits.", params: [] },
    run_task: { route: "POST /api/tasks/:id/run", description: "Runs a scheduled task now on every target it covers.", params: [task] },
    enable_task: { route: "POST /api/tasks/:id/enable", description: "Turns a scheduled task back on.", params: [task] },
    disable_task: { route: "POST /api/tasks/:id/disable", description: "Stops a scheduled task from running until it is turned back on.", params: [task] },
    describe_schedule: {
      route: "GET /api/schedule",
      description: "Puts a schedule into words with its next few times, such as \"daily 03:00\" or a number of seconds.",
      params: [{ name: "text", schema: text }],
    },
    list_timers: { route: "GET /api/timers", description: "Lists the systemd timers on each host that run backups, with when each is next due.", params: [] },
    list_timer_runs: { route: "GET /api/timers/runs", description: "Lists the timers' runs since a time.", params: [optional("since", epoch)] },

    list_hosts: { route: "GET /api/hosts", description: "Lists the hosts with their agent's connection and newest health reading.", params: [] },
    list_host_samples: { route: "GET /api/hosts/samples", description: "Lists the hosts' health readings since a time.", params: [optional("since", epoch)] },
    list_jobs: { route: "GET /api/jobs", description: "Lists the jobs, each backing sources up to repositories, with their targets' status and tasks.", params: [] },
    get_job: { route: "GET /api/jobs/:name", description: "Shows one job with its targets' status and tasks.", params: [{ name: "name", schema: text }] },
    list_sources: { route: "GET /api/sources", description: "Lists the sources, each a set of paths on one host, with the jobs that back them up.", params: [] },
    get_source: { route: "GET /api/sources/:name", description: "Shows one source with its paths, excludes and the jobs that back it up.", params: [{ name: "name", schema: text }] },
  };
}

const instructions =
  "X-Backups watches borg backups. A job backs sources (paths on a host) up to repositories; each pair of job and repository " +
  "is a target, which the tools call a repository and name by id. Look things up with the list_ and get_ tools first. " +
  "Actions start runs and answer at once; follow one with get_run. Times are Unix seconds.";

const version = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

// ── Route ────────────────────────────────────────────────────────────────────

export async function register_mcp(app: FastifyInstance, action_ids: string[]): Promise<void> {
  const tools = route_tools(app, mcp_routes(action_ids));
  await app.register(async (scope) => register_mcp_route(scope, { name: "x-backups", version, instructions, ...tools }), { prefix: "/api" });
}
