---
title: Monitoring and integrations
parent: User guide
nav_order: 9
---

# Monitoring and integrations

## Health check

`/api/health` needs no sign-in, so X-Monitor or any HTTP check can poll it. Its `status` is `ok`, `warning` or
`critical`, the worst of the repositories', each listed with its reasons. It answers 503 when critical, so a plain
HTTP check alerts on that without reading the body.

## Prometheus

`/metrics` serves the repositories' state in Prometheus' text format to a token or a signed-in user. Make a read-only
token on the Account page and give it to the scraper as a bearer token.

## AI clients (MCP)

`/api/mcp` offers the API to AI clients as MCP tools over streamable HTTP: repositories, archives and their contents,
runs, events, tasks, timers, hosts, jobs and sources, and the actions the page has. Each tool runs as the caller, so it
sees only what their grants show and may do only what their role allows. Downloads, agent tokens and config editing
stay on the page. A client sends a token as a bearer header; a read-only token runs only the tools that read:

```sh
claude mcp add --transport http x-backups https://backups.example/api/mcp --header "Authorization: Bearer <token>"
```

## The API

Everything the page does goes through the JSON API under `/api`, which a token can call too. The routes most useful
to scripts:

| Route                                          | Does                                                      |
| :--------------------------------------------- | :-------------------------------------------------------- |
| `GET /api/repositories`                        | every target with its status                              |
| `GET /api/repositories/:id`                    | one target's state, archives and actions                  |
| `POST /api/repositories/:id/actions/:action`   | start an action, such as `run_backup` or `check_repo`     |
| `GET /api/runs`, `GET /api/runs/:id`           | runs, filtered by `target`, `host`, `job`, `task`, kind and outcome, and one run's output |
| `POST /api/runs/:id/cancel`, `/retry`          | stop or rerun a run                                       |
| `GET /api/tasks`                               | every task with its schedule in words, next due time, last run and why it waits |
| `POST /api/tasks/:id/run`, `/enable`, `/disable` | run a task now, or switch it on or off                  |
| `GET /api/schedule?text=`                      | a schedule described in words with its next three times   |
| `GET /api/hosts`                               | each host with its agent's state and newest health reading |
| `POST`, `DELETE /api/hosts/:name/token`        | issue or revoke a host's agent token (admin)              |
| `GET /api/events`                              | the event log                                             |
| `GET /api/stream`                              | server-sent events for run state and output, polls and config changes |

## Backing up X-Backups itself

X-Backups' own database holds the users, task overrides and agent tokens beside the poll and run history. It is
backed up once a day into `<X_BACKUPS_STATE_DIR>/backups`, keeping the last 14 daily copies.

An admin changes that schedule, backs up by hand, restores or deletes a backup in the Backups section of Settings. A
restore first backs up the current data, then stops the server, which systemd starts again with the backup in place of
the database.

## Bringing over X-Monitor's history

X-Monitor's borg history can be copied into X-Backups once, so the charts reach back before X-Backups ran:

```sh
npm run import-x-monitor -- <x-monitor.db> <x-backups.sqlite> <monitor>=<target>... --dry-run
```

Drop `--dry-run` to write. It fills only the polls older than each target's first own one.
