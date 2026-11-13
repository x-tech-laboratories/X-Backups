---
title: Changelog
nav_order: 5
---

# Changelog

Every change to X-Backups, one line per commit, newest first. Work still to do is in the [roadmap](roadmap.html).
Each commit adds its own line under **Unreleased**, beneath the day it was made; a release renames that heading to its
version.

## Unreleased

### 2026-11-13

- docs: publish a documentation site with a user guide, architecture, roadmap and changelog in place of todo.md

### 2026-11-12

- feat(web): pin the theme, the account and Settings in the sidebar's foot
- fix(borg): default cache_dir to /var/cache/x-backups-borg, now the cutover from X-Monitor is done

### 2026-11-11

- docs(agents): point agents at the X-Tech standards and X-Libs

### 2026-11-10

- feat(backups): back up the state database daily, with a Backups section in Settings for admins
- feat(mcp): offer the API to AI clients as MCP tools at /api/mcp (#3)
- fix(auth): answer that the agent's route is open, as the agent brings its own token
- build(deps): take X-Libs 0.31.0 for the shared accounts
- feat(auth): sign in through the shared X-Libs accounts
- feat(web): give the page its X-Tech hexagon icon, as favicon and beside the brand

### 2026-11-09

- test: name check tasks by their kind, and wait for the slow reader before counting a stream
- refactor(web): draw the charts with X-Libs 0.22.0 and Halon 0.11.0

### 2026-11-08

- fix(deps): take x-libs 0.11.1 to stop tables redrawing forever

## 0.3.0

### 2026-11-08

- feat: run on X-Libs 0.11.0 and Halon 0.5.0 and release 0.3.0

## 0.2.0

### 2026-11-07

- feat: run on X-Libs 0.6.0 and release 0.2.0
- fix(web): give the sparkline its class under React's className
- refactor(web): draw the page with React on X-Libs' React widgets

### 2026-11-06

- refactor(web): draw the page with Preact on the shared X-Libs widgets and Halon
- refactor: run the agents, keys, durations, passwords and logins on x-libs and Fastify's plugins

### 2026-10-31

- fix(web): reload a page left open across a deploy when the stream reconnects

### 2026-10-30

- feat(overview): show the backup map on the Overview instead of its own page
- feat(tasks): schedule several checks per job and repository, and start a calendar task never run at its next time
- feat(map): draw the backup flow from sources through jobs to repositories
- fix(nix): put borg 2 on the agent's PATH only when asked, since its beta has no cached build on every platform

### 2026-10-29

- feat(nix): declare agent keys and run the agent unprivileged
- feat(agents): log agents in with a declared ed25519 key
- fix(config): refuse a folder path from a host other than the repository's own
- docs: describe the pages, and mark task 67 done
- feat(web): put tasks in Schedules and the Overview, and link the new pages
- feat(web): edit hosts, repositories, sources and jobs from Settings
- feat(web): filter runs by host, job and task, and mark waiting and lost runs
- feat(web): add Hosts, Sources and Jobs pages, and each target's repository tasks
- feat(server): serve jobs, sources and entity config for the pages
- fix(server): schedule checks by default only where X-Backups schedules the backups too
- docs: describe scheduling tasks, and mark task 66 done
- feat(server): start each job's and repository's tasks on schedule
- feat(server): read task schedules as durations, presets, times of day and cron lines
- docs: describe access per job, and mark task 68 done
- feat(access)!: grant users jobs rather than repositories
- docs: describe declaring entities in the NixOS module, and mark task 69 done
- feat(nix): declare hosts, repositories, sources and jobs
- docs: describe hosts reached through their agents, and mark task 65 done
- feat(nix)!: keep the built-in agent's runs across a restart, and drop sshKeyFile
- feat(server)!: run every command through the host's agent, and remove SSH
- docs: call executions runs, and mark task 64 done
- feat(store)!: key rows by target beside their entities, and rename jobs to runs
- docs: describe enrolling a host's agent, and record what task 65 has built
- feat(nix): ship the agent as packages.agent with nixosModules.agent
- feat(agent): add the agent, its protocol, and the server's hub for agents
- style(borg): keep the refusal helper's comment beside it
- docs: show the hosts, repositories, sources and jobs config, and mark task 63 done
- feat(config): read hosts, repositories, sources and jobs, and build each job's targets
- docs(todo): plan hosts, repositories, sources and jobs, with agents and a scheduler in place of SSH
- fix(server): stop the browser keeping a stale page after a rebuild, by dropping the Nix store's constant ETag
- feat(web): add a map of what each host backs up to which repository, drawn from the configured repositories

### 2026-10-27

- docs(todo): record the storage half of task 33 and the X-Monitor history import
- feat: sample each host's load, memory and root disk with its timers, and draw them as sparklines
- feat: draw each repository's storage against its quota or its filesystem's free space
- feat: import X-Monitor's borg history into the poll history it predates
- fix(web): show whole days and hours without a decimal, such as 1d for a max_age of a day
- fix(borg): set the poll status to warning past warn_age, check_warn_age or canary_warn_age
- feat(web): add the job outcome donut, storage per repository, space savings, an activity timeline and a weekly timer calendar
- feat(web): chart the time since each repository's last backup against its warning and max age
- feat(jobs): finish a job that borg ends with warnings in its own warning state
- docs(todo): add task 62 for the poll status to honour the warning ages
- feat(health): warn before max_age, and give checks and the canary the same pair of ages
- feat: drive borg 2 repositories beside borg 1 with a per-repository borg_version
- feat(health): report ok, warning or critical with each repository's reasons
- docs(todo): add the remaining open items as tasks 59-61
- docs(todo): add follow-ups for users in Nix and the Halon icon gaps
- docs(reviews): add the seven app reviews behind the todo tasks
- feat: restore into a chosen folder, and show and stop running downloads
- docs(todo): note X-Backups is deployed beside X-Monitor on Heimdall

### 2026-10-26

- feat(web): theme the page with Halon
- feat: download files and folders from an archive, streamed straight from borg
- feat: add users, roles, per-repository access, TOTP, OIDC, proxy login, API tokens and metrics
- feat: edit the config from the page in mixed and page modes, with declared defaults
- feat(web): rebuild the page around a shell, tabs, archive and job pages, and live updates
- feat(server): add job filters and retry, archive diffs, search, config view and a live stream
- docs(todo): bring every parity feature in as tasks 47-56
- docs(todo): review the apps' UI layouts, add config mode and layout tasks
- refactor: move server/ and web/ into src/
- docs(todo): review the apps' docs, add source review and gap tasks
- refactor(tests): move the tests out of server/ into tests/
- feat(nix): add the package and NixOS module
- fix(borg): send the passphrase on stdin instead of the command line
- docs(todo): note the poll ordering and sudo timeout on the poll loop task
- feat(dashboard): add history charts, fleet totals and host backup timers
- feat(web): add the repository page with archives, browser, jobs and events
- feat(api): serve repositories, history, actions, browsing, jobs and events
- feat(poller): poll each repository on its interval and run its actions
- feat(store): keep state, poll history, archives, events and jobs in SQLite
- refactor(borg): give each action its own command and reader methods
- refactor(borg): send each borg call as its own command

### 2026-10-25

- refactor(borg): keep one typed RepositoryState in place of metrics and metadata
- docs(todo): add a task to theme the page with Halon
- docs(todo): add a dashboard task for repositories, jobs, sources and schedules
- refactor(borg): drop the X-Monitor page spec, cards and action styling
- feat(auth): guard the api with a password hash file and a session cookie
- feat(runner): run commands over multiplexed ssh or locally with a timeout
- feat(config): load repositories from the X_BACKUPS_CONFIG file
- ci: move checkout and setup-node to v7 for Node 24
- ci: run build, test and lint on push and pull requests
- refactor: rename X-Monitor leftovers to X-Backups
- fix(borg): keep borg's exit status in purge preview
- docs: plan a simpler architecture and the tasks to get X-Backups online
- docs: list outstanding work in todo
- feat(borg): port X-Monitor's borg plugin to TypeScript
- feat: scaffold TypeScript server and web page
- chore: start X-Backups with its planning notes
