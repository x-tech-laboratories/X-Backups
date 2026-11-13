---
title: Architecture
nav_order: 3
---

# Architecture

How X-Backups is built today. What is planned and not built yet is in the [roadmap](roadmap.html); how to use it is
in the [user guide](user/).

X-Backups follows the X-Tech [Application Standard](https://x-tech-laboratories.github.io/standards/application/):
TypeScript run directly by Node 24, Fastify on the server, React on the page, SQLite through `node:sqlite`, shared
widgets and server pieces from [X-Libs](https://github.com/x-tech-laboratories/X-Libs) and styling from Halon.

## The shape of it

```
             browser page  ── /api, /api/stream (SSE) ──┐
   AI client (MCP)         ── /api/mcp ─────────────────┤
   X-Monitor, Prometheus   ── /api/health, /metrics ────┤
                                                        ▼
  ┌──────────────────────────────── X-Backups server (one Node process) ───────────────────────────────┐
  │  config + sources ─► targets ─► poller ◄── scheduler        store (SQLite)       access + auth       │
  │                                   │                                                                  │
  │                                   ▼                                                                  │
  │                               agent hub ── built-in agent (the server's own machine)                 │
  └───────────────────────────────────┼──────────────────────────────────────────────────────────────────┘
                                      │  WebSocket /api/agent, dialled out by each agent
                     ┌────────────────┼────────────────┐
                     ▼                ▼                ▼
               agent on host A  agent on host B   agent on host C ── borg ── ssh:// ──► storage-only host
```

One Node process is the single place backups are defined, started and watched. It never runs borg itself: it builds
shell command lines and sends them to the agent on the host each command belongs to, then reads their output.

- `src/server/borg/` builds borg commands and reads their output, and runs nothing.
- The **agents** run the commands. Each managed host runs one; the server's own machine has one built in.
- The **store** keeps state and history in SQLite.
- The **poller** reads each target's state and runs its actions; the **scheduler** starts tasks when they fall due.
- **Fastify routes** expose all of it, and the **page** shows it.

## Entity model

The config describes four kinds of entity, and X-Backups derives two more:

- **Host:** one machine. A *managed* host runs an agent; a *storage-only* host only holds repositories reached through
  `borg serve` or a hosted service.
- **Repository:** a borg repository on a host, with its URL, passphrase, quota and borg version, and its own tasks:
  compact and repository check.
- **Source:** paths and excludes on one managed host.
- **Job:** any number of sources to any number of repositories, with retention, compression, archive naming and
  freshness limits, and its tasks: backup, prune, archive check and restore canary.
- **Target** (derived): one per job, source host and repository, named `job:host:repository`. It holds status and
  freshness, and is what the poller watches. A repository no job writes to is a target of its own, still watched.
- **Task** and **run:** a task is a step of a job or a repository with its own schedule; a run is one execution of a
  task, or of an action started by hand.

Sources on one host go into one archive named `{prefix}-{host}-{time}`, and prune and freshness read only archives of
that name, so targets sharing a repository stay apart. Compact and the repository check act on the whole repository,
so only the target polling from the repository's `poll_via` host offers them.

An older flat entry, holding every field at once, still loads: it expands into one host, repository, source and job of
its name and keeps its name as its target and archive prefix.

## Source layout

```
src/
  server/            the Fastify server
    main.ts          wires everything together from the environment and starts listening
    app.ts           the API routes
    config.ts        reads and checks entities, expands jobs into targets, defines every config field
    sources.ts       combines the declared file with the page's config.json by config mode
    store.ts         the SQLite store and its migrations
    poller.ts        polls targets and runs their actions on agents
    scheduler.ts     starts each task when it falls due
    schedule.ts      parses and describes schedules: durations, presets, times of day, cron
    access.ts        what each user sees, from the jobs they are granted
    auth.ts          roles per route, on the X-Libs accounts
    health.ts        ok, warning or critical per repository, with reasons
    metrics.ts       Prometheus text for /metrics
    map.ts           the backup flow drawn on the Overview
    mcp.ts           the API as MCP tools at /api/mcp
    timers.ts        reads a host's systemd backup timers
    borg/            one borg repository: commands, output readers, actions, checks
    agents/          the agent hub, per-host tokens
  agent/             the agent each managed host runs
  shared/            the agent protocol shared by server and agent
  web/               the React page, built by Vite into dist/
    views/           one file per page
tests/               one *.test.ts per behaviour, mirroring src/
nix/                 package.nix, agent-package.nix, borg2.nix, module.nix, agent-module.nix
```

## Config

`config.ts` reads `hosts`, `repositories`, `sources` and `jobs`, checks every field against `borg_fields` (the one
list of config fields, which the page's config form is also built from), cross-references them, applies the file's
top-level `defaults`, and compiles each job into its targets. Each target becomes the `BorgRepository` the poller
drives.

`sources.ts` reads two files: the declared one named by `X_BACKUPS_CONFIG`, which the NixOS module writes, and a
page-managed `config.json` in `X_BACKUPS_STATE_DIR`. `X_BACKUPS_CONFIG_MODE` decides how they combine:

- `declarative`: only the declared file counts and the page edits nothing.
- `mixed`: the declared entities are locked, and the page may add its own.
- `page`: the declared file is optional.

A declared entity shadows a page one of the same kind and name. Saving from the page applies at once: the poller adds,
replaces or drops targets without a restart. Passphrases typed on the page are written once into
`passphrases/<name>` (mode 0600) and never sent back.

## Agents

The agent is X-Libs' agent with X-Backups' protocol on top (`src/shared/agent_protocol.ts`): each task is a shell
command line, and the agent also answers `health` with its host's load, memory and root filesystem use.

- The agent dials the server's `/api/agent` WebSocket, so a host needs no open port, and dials again whenever the
  connection drops.
- It logs in with its host's ed25519 key: it names its host in the `X-Backups-Agent-Host` header, the server sends a
  nonce, and the agent's hello carries its signature of `x-backups-agent-v1|<host>|<nonce>`, checked against the
  host's declared `agent_public_key`. A host with no declared key logs in with a token issued on the page, of which
  only a digest is kept. A host with a key refuses tokens.
- A long run (backup, prune, check, compact, restore, delete, purge) keeps going on the agent across a dropped
  connection or a restart of either side. The agent keeps its output in its state folder, and the server follows it
  from the last sequence number it read. While the agent is away the run shows as waiting; a run the agent no longer
  knows is marked lost.
- The URL must be `wss://`, since passphrases travel over it; `ws://` is accepted only to the agent's own machine.
- The server's own machine is the managed host with no `address`, run by an X-Libs `LocalAgent` inside the server
  whose long runs keep their output under the state folder.

`hub.ts` holds the agents by host name, adds the token store and health samples, and is what the poller sends
commands through.

## Borg

`src/server/borg/repository.ts` is one repository watched and driven on its host's agent, with borg 1 or borg 2 as
`borg_version` says.

- **A poll** lists archives as JSON, plus `borg info --json` when `collect_stats` is on, as separate commands run one
  after another so they never fight over borg's cache lock. It also reads check freshness, the restore canary, free
  space by `df` for a local repository, and the host's timers. A borg error, an empty repository or a newest archive
  past `max_age` is failed; an unreachable host, missing borg, an unreadable repository, a lock borg gave up on or
  unreadable output is unavailable.
- **Actions** each have one method that builds the command and one that reads the result: Run Backup, Dry Run, Verify
  Restore, Check, Compact, Prune Preview, Prune, Purge Preview, Purge Excluded and Break Lock, plus browsing,
  diffing, restoring, downloading and deleting archives. The long ones are `LongRunPlan`s the agent keeps going.
- **The passphrase** never appears on a command line: the shell reads it once from stdin into a variable, and each
  borg call gets it piped in with `BORG_PASSPHRASE_FD=0`, so no process list shows it, under sudo too.
- **Preflight** checks such as `skip_while_active`, a job lock and `systemd-inhibit` while a backup runs are wrapped
  around each run in `shell.ts`.
- **Downloads** stream a file through `extract --stdout`, or folders and picks as a gzipped `export-tar`.
  A download holds borg's lock, so it is refused while a run is going.

`parsing.ts` holds the pure readers for borg's JSON and text output, `checks.ts` reads check freshness and the
canary verdict, and `types.ts` the shapes all of them share, from `Command` to `RepositoryState`.

## Polling and scheduling

`poller.ts` polls each target at startup, then on its `interval` (an hour by default), and every ten seconds while one
of its runs is going, with at most one poll per target at a time. A host's targets are polled again as soon as its
agent connects.

`scheduler.ts` starts tasks when they fall due, through the poller's action paths, so every run is recorded under its
task id (`job:<name>:<kind>` or `repository:<name>:<kind>`, with a check's kind after it).

- When a task is next due comes from the store: the start of its newest run on each target, or of an action of the
  same kind started by hand; for a task `after: "backup"`, the end of the newest successful backup. A restart picks up
  where it left off.
- A task never run on a duration is due at once; one never run on a calendar schedule waits for its next time, so
  checks taken over from another tool keep their days.
- One run goes at a time on a repository, and on one job's targets from one host; the rest queue. A task whose agent
  is away waits and runs once when it connects. A start that is refused or skipped tries again after ten minutes.
- Enable, disable and Run now from the page are kept in `task_overrides`, over the declared config.

`schedule.ts` reads durations (`30m`, `1h30m`), presets, `daily HH:MM`, `weekly <day> HH:MM` and five-field cron
lines, in `X_BACKUPS_TIMEZONE` or the server's zone, and describes each in words with its next times.

## Store

`store.ts` keeps one SQLite file under `X_BACKUPS_STATE_DIR`. Each row sits beside the host, job and repository its
target is built from.

| Table                                   | Holds                                                         |
| :-------------------------------------- | :------------------------------------------------------------ |
| `repository_states`                     | each target's latest typed state                              |
| `polls`                                 | poll history: sizes, archive counts, check and canary results |
| `archives`                              | archives seen per target                                      |
| `runs`, `run_output`                    | every run and its output                                      |
| `events`                                | the event log                                                 |
| `timers`, `timer_runs`, `timer_upcoming` | host systemd timers, their runs and missed runs, the coming week |
| `host_samples`                          | agent health samples                                          |
| `agent_tokens`                          | digests of hosts' agent tokens                                |
| `task_overrides`, `task_first_seen`     | the page's enable and disable, and when each calendar task first appeared |

The same file holds the X-Libs accounts: users, sessions, second factors and API tokens. The database is backed up
once a day into `<X_BACKUPS_STATE_DIR>/backups` by X-Libs' SQLite backups, keeping 14; a restore picked in Settings is
staged beside the database and taken in before the store opens on the next start.

## Access and sign-in

Signing in, the Account page, the Users page, second factors, sessions, API tokens, OIDC and reverse-proxy sign-in are
the shared X-Libs accounts. The declared admin signs in with the hash in `X_BACKUPS_PASSWORD_HASH_FILE`.

`auth.ts` gives each route the role it needs: `viewer` reads, `operator` also runs actions and reads archive contents,
`admin` also changes the config, users and tokens. A read-only token makes only GET requests. `/api/health` and
`/api/agent` are open; `/metrics` takes a token or a session.

`access.ts` decides what each user sees from the jobs they are granted. A job's grant shows its targets with their
runs, events and archives, the sources and repositories it uses and the hosts those are on. A repository no job writes
to is granted by itself. Acting on a whole repository needs an admin, or a user granted every job writing there. No
grants means everything.

## Health, metrics and MCP

- `health.ts` turns each repository's state into ok, warning or critical with its reasons, from `max_age`,
  `warn_age` and the check and canary ages. `/api/health` reports the worst and answers 503 when critical.
- `metrics.ts` writes the repositories' state in Prometheus' text format at `/metrics`.
- `mcp.ts` offers the API as MCP tools at `/api/mcp`. Each tool runs its route inside the app as the caller, so it
  sees and may do exactly what the page lets them. Downloads, agent tokens and config editing stay on the page.

## The page

`src/web/main.tsx` draws the sign-in, the X-Libs shell (header, sidebar, search, runs in progress, theme) and routes
between views by the URL's hash. Each view in `src/web/views/` is one page: Overview (tiles, needs-attention list, the
backup map), Hosts, Repositories with tabs, an archive page with Changes and Files tabs, Sources, Jobs, Runs,
Schedules, Events, Settings and Users.

Pages draw with X-Libs' React widgets (tables, dialogs, toasts, charts, layout, states) and Halon's tokens and styles;
`app.css` holds layout only. One server-sent event stream, `/api/stream`, carries run state and output, poll results
and config changes; the page refetches after a reconnect and polls only while the stream is down and the tab is
visible.

## Packaging

The flake exposes:

- `packages.default`: the server and the built page, via `buildNpmPackage`. After changing `package-lock.json`,
  update `npmDepsHash` in `nix/package.nix`.
- `packages.agent`: the agent alone.
- `packages.borg2`: the borg 2 beta, as `borg2`, to sit beside borg 1.
- `nixosModules.default`: the server as a systemd service with `DynamicUser`, a state folder, passphrase files loaded
  as credentials, and hosts, repositories, sources and jobs declared as Nix attributes and written out as the JSON
  config. With `configMode` declarative, a job naming an undeclared source or repository fails evaluation.
  `KillMode=process` keeps the built-in agent's runs going when the server restarts.
- `nixosModules.agent`: the agent as the system user `x-backups-agent`, with sudo allowed, its state in
  `/var/lib/x-backups-agent` and the system CA bundle trusted through `NODE_EXTRA_CA_CERTS`.

## Tests

`tests/` holds one `*.test.ts` per behaviour, run by Vitest. `tests/borg/testing.ts` gives a repository in-memory
stores and a cycle driver, so it is exercised without a host or a database; `tests/agents/` has a fake agent for the
server's side and runs the real agent against the hub;
`tests/app.test.ts` drives the routes with Fastify's `inject`. CI runs build, tests and lint on every push and pull
request.

## Settled decisions

- **2026-10-26:** X-Backups aims to do at least what each other borg tool does, including what was once out of scope.
- **2026-10-29:** agents replace SSH, written in TypeScript in this repository; access is granted per job; the NixOS
  module declares hosts, repositories, sources and jobs; X-Backups starts every backup itself.
- X-Backups keeps no version history of its items, which the Application Standard asks of apps whose users edit items:
  its entities come from the config, and the rest is polls, runs and events, which are a log.
