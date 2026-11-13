---
title: Roadmap
nav_order: 4
---

# Roadmap

What X-Backups does not do yet. What it does today is in the [architecture](architecture.html), and what changed when
is in the [changelog](changelog.html). When an item ships, its commit moves it out of this page and into the
architecture.

The goal, decided on 2026-10-26, is that X-Backups does at least everything each of the other borg tools does (see
the [app reviews](app-reviews/)), including what was once out of scope: repository creation, notifications, mounts,
cloud sync, hooks and database dumps. Each item names the tools that already have it. The task numbers in brackets
are the ones commits and older notes refer to.

## Features

### Repository creation [47]

Run `borg init` from the page when `X_BACKUPS_CONFIG_MODE` is `mixed` or `page`, with the encryption mode, the
passphrase handled as the config editor handles it (a file, a command, or written once into the state folder and never
read back), and a preview of the exact command that will run. Also import an existing repository by opening it with
its passphrase before it is saved. (Borg UI, Borgitory)

### Notifications [50]

Apprise URLs, an SMTP sender and a webhook with a secret, each with a Test button. Events: backup failed, completed
with warnings, missed schedule, stale, check or canary failed, and recovered. A failure alert is sent once until the
state changes. This sits beside X-Monitor's alert on `/api/health`. (Borg Backup Server, Borg UI, BorgWarehouse,
Borgitory)

### Fuller restore verification [31]

Verify Restore compares one canary file. Add probe paths and a full-archive extract to `/dev/null` as on-demand
modes. (Borg UI)

### Paused repositories and append-only badge [33]

A declared `paused` flag that keeps a repository listed but silences its staleness, and an append-only badge on its
card. Storage bars against `quota` or free space are already built. (BorgWarehouse)

### borgmatic awareness [34]

On hosts whose own borgmatic fills a repository: show each check type's last run from borgmatic's state folder,
recognise `borgmatic.timer`, and warn when an archive's file count drifts far from the previous one, a cheap form of
borgmatic's spot check. Optionally accept borgmatic's start and finish pings to show a backup running between polls.
Needs the borgmatic source review below to settle where its check files live.

### FUSE mount [52]

Mount an archive or a whole repository on its host with `borg mount`, show the mount point with an Unmount button, and
unmount when the run ends or X-Backups starts. (Borg UI, Borgitory, Vorta)

### Cloud sync [53]

Mirror a repository to an rclone remote after each backup or on a schedule, with a Test button and the last sync's
state on the repository's card. (Borg UI, Borgitory)

### Hooks [54]

Commands run on the host before and after a backup, in order, each with a timeout and a choice to stop the run when it
fails. (Borgitory, Vorta)

### Database dumps [55]

Dump PostgreSQL, MySQL, MariaDB, MongoDB or SQLite into the archive, as borgmatic's data sources do, and restore one
database from an archive. (borgmatic, Borg Backup Server)

### Users in the NixOS configuration [57]

Users, roles and job grants live in the state database and are managed on the Users page. Let
`services.x-backups.users.<name>` declare them too (role, jobs, an optional password hash file), shown as declared and
locked on the page, so a NixOS setup can be wholly declarative.

### Downloads and host-timer backups [61]

A download holds borg's lock for as long as it runs. X-Backups refuses one while its own run is going and lists
running downloads with a Stop button, but a backup started by a host's own timer still waits on a long download and
fails past its lock wait. Options: warn when the host's next timer run falls inside the likely download time (the
timers are already read), cap a download's length, or stop downloads when the timer's service starts.

### History that keeps its size

Poll history grows without bound. Thin out rows older than 90 days, and count the source changes between archives per
archive rather than only through Diff. [17]

## Verification

### Run the service on NixOS [59]

The NixOS modules have been evaluated but no VM test runs them. Add a NixOS VM test in the flake's `checks` that
starts the server and an agent with a local borg repository, signs in, polls and runs a backup, so `nix flake check`
covers the packages and modules together.

### OIDC against a real provider [60]

Single sign-on is tested only against a simulated provider with real signatures. Sign in once through a real one
(Authelia, Keycloak or Kanidm) to confirm discovery, the PKCE code exchange and the user name claim, and fix what
differs.

### Select arrow [58]

Selects keep the browser's own dropdown arrow, since Halon's tokens have none. The styled arrow belongs in Halon, for
every X-app at once.

## Research

Each app's online docs were reviewed on 2026-10-26 (see [app reviews](app-reviews/)). These read the source to
confirm what the docs claim and to settle how the features above should be built: one read-only pass per app, ordered
by value to X-Backups.

1. **Borg UI** [19]. `app/` (restore-check modes and canary, staleness thresholds, metrics endpoint, borg command
   builders and timeouts, archive indexing), `frontend/` (repository cards, job and progress views, restore wizard),
   `examples/monitoring/` (Prometheus metric names, Grafana dashboards). Confirm authentication, mounting and
   reverse-proxy handling from source, since the docs skip them.
2. **Borg Backup Server** [20]. `src/` (health checks per component, JSON and Prometheus metrics, `/api/v1/summary`,
   failure-alert deduplication), `scheduler.php` (missed-schedule detection), `schema.sql` and `migrations/` (job,
   stats and notification tables), `public/` (dashboard charts), `agent/` (progress from `--log-json`).
3. **borgmatic** [21]. `borgmatic/actions/check.py` and `borgmatic/borg/` (where check time files go and how
   `frequency` is compared; the spot check), `hooks/monitoring/` (exact payloads), `hooks/data_source/` (where database
   dumps sit in an archive), the config schema and the shipped systemd units.
4. **Borgitory** [22]. `src/borgitory/services/` (job queue, cancel and retry, recovery of interrupted jobs, prune
   preview parsing, FUSE mount cleanup), `templates/` (job output and archive browser). Its docs mix shipped and
   planned features, so check each claim.
5. **BorgWarehouse** [23]. `pages/api/v1/` and `services/` (status and "no recent backup" alert from repository
   mtime, scoped API tokens, archive mode), `Components/` and `Containers/` (repository list, monitoring charts).
6. **Vorta** [24]. `src/vorta/views/` (archive tab, extract dialog, diff result), `src/vorta/borg/` (diff and extract
   jobs, JSON parsing), `src/vorta/scheduler/` (next-run and missed-run logic).
7. **BorgWeb** [25]. `borgweb/views/` and `js/` only. Low priority: X-Backups already does everything it does.

## Superseded

These were planned and then replaced by the agents and the scheduler, decided on 2026-10-29:

- Running jobs as transient systemd units on each host [4]: the agent keeps long runs going itself.
- Backup plans written as host systemd timers [49]: X-Backups schedules every task itself.
- A separate HTTPS agent for hosts SSH cannot reach [56]: every managed host now runs the WebSocket agent.
