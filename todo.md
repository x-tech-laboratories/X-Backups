# X-Backups

A web platform for managing borg backups, taking over the borg functionality now in X-Monitor.
X-Monitor keeps only the job of watching X-Backups itself.

## Goals

## Scope

## Architecture (proposed)

X-Backups does one thing, so it leaves out X-Monitor's general machinery: no plugin loader, monitor
graph, groups, triggers, agent, sync or per-plugin UI contract.

- One Node process. Repositories come from one JSON file the Nix module writes; a restart reloads it.
- `src/server/borg/` builds commands and reads their output, and never runs anything. A runner runs the
  commands, a SQLite store keeps state, a loop polls, Fastify routes expose it, the page shows it.
- Each repository keeps one typed state record (archives, repo info, canary, checks, last poll), not
  X-Monitor's metric and metadata string bags read back through `MetricReader`.
- Each borg call is its own SSH command over one multiplexed connection (`ControlMaster`), not
  several calls framed into one shell command and split apart again.
- Long jobs run as transient systemd units on the target (`systemd-run`): they survive an X-Backups
  restart, `journalctl` gives their output, and `systemctl stop` cancels them. Verify Restore and
  Diff are read-only, so they run as ordinary calls.
- Backups stay scheduled by each host's own timers (borgmatic or NixOS `services.borgbackup`).
  X-Backups watches them and runs actions on demand.
- No notifications of its own: `/api/health` reports each repository's status and X-Monitor alerts
  on it.

## Open questions

- Do all repository hosts have systemd and allow `sudo systemd-run` for the SSH user? If not, keep
  the `setsid` jobs in `src/server/borg/detached.ts` and skip task 4.
- Are there repositories on hosts SSH cannot reach, such as a laptop that sleeps (X-Monitor reaches
  those through its agent today)? Each one needs a plan before cutover.
- Does any host lack its own backup timer? Only then does X-Backups need a scheduler (cron parsing is
  in `../X-Monitor/x_monitor/core/coordination/schedule.py`).

## Tasks

One agent and one branch per task. Earlier tasks change the contracts later ones build on, so take
them in order unless a task says otherwise. `tests/borg/repository.test.ts` stays green throughout,
adapted where a task changes a contract.

### Simplify the ported code

1. [x] **Typed state.** Replace `MetricReader`, `CollectResult`'s metrics and metadata, and the
   JSON-in-metadata fields (`archive_list`, `check_ok_epoch`, `canary_ok`) with one
   `RepositoryState` type that `poll` reads and returns. The X-Monitor UI leftovers are already
   removed. Files: `server/borg/types.ts`, `repository.ts`, `testing.ts`.
2. [x] **One borg call per command.** Remove the framing: `sequence_command`, `split_poll`,
   `frame_line`, the `POLL_*` shell variables, the poll deadline and `CUT_SHORT`. `commands()`
   returns separate calls and `parse()` reads one result per call. Timeouts move to the runner
   (task 8). Files: `server/borg/shell.ts`, `repository.ts`.
3. [x] **Typed actions.** Replace the string switches in `plan_action` and `interpret_action`, and
   the `pending_launch` field, with one command method and one reader method per action, so each
   API route calls its pair directly.
4. [ ] **Jobs as systemd units** (if the first open question allows). Launch with
   `systemd-run --unit=x-backups-<repo>-<time>` and `Nice=`/`IOSchedulingClass=idle` properties in
   place of the `nice`/`ionice` wrappers. Read state with `systemctl show`, output with
   `journalctl -u <unit>`, and cancel with `systemctl stop`. Keep `flock` for `job_lock` and
   `systemd-inhibit` for `inhibit_sleep`. Remove `src/server/borg/detached.ts`. A detached job gets the
   passphrase today by exporting the shell variable `with_passphrase` reads into, which a
   `systemd-run` unit would not inherit: use `passphrase_command` on the target or a systemd
   credential there.
5. [ ] **Rename X-Monitor leftovers.** Done except the `cache_dir` default, which waits for task 16. The `__XMONITOR_*` and `__x_monitor_*` shell markers, the
   `cache_dir` default `/var/cache/x-monitor-borg` and `restore_dir` default
   `/var/tmp/x-monitor-restore` in `repository.ts`, `$HOME/.cache/x_monitor/jobs`,
   `--who=X-Monitor`, and "X-Monitor" in `failure_hint`. A new `cache_dir` rebuilds each
   repository's chunks cache once, so land that default with the cutover (task 16).
6. [x] **Passphrase off the command line.** The passphrase travels on the command's stdin: the
   shell reads it into a variable once, and each borg call gets it piped in by the `printf`
   builtin with `BORG_PASSPHRASE_FD=0`, so no process list shows it, under sudo too.

### Run it

7. [x] **Config loading.** `server/config.ts` reads the JSON file named by `X_BACKUPS_CONFIG`:
   `{ "repositories": [BorgConfig plus host, ssh_user and interval] }`. It validates on load and
   stops with the repository's name on a bad entry. Add an example file with placeholder hosts.
8. [x] **Runner.** `server/runner.ts` runs a command on a host with
   `ssh -o BatchMode=yes -o ControlMaster=auto -o ControlPath=… -o ControlPersist=…`, or locally with
   `sh -c` when the repository has no host. It enforces a timeout by killing the process, takes
   optional stdin (task 6), and returns a `CmdResult`. It uses the system's `known_hosts`. Reference:
   `../X-Monitor/x_monitor/core/connectors/ssh_connector.py`.
9. [x] **Storage.** `server/store.ts` on `node:sqlite` (built into Node 24) keeps repository state,
   events, and jobs (unit name, kind, state, exit code, journal cursor), with the database in
   `X_BACKUPS_STATE_DIR`. It implements whatever store interfaces tasks 1 and 4 leave.
10. [x] **Poll loop.** `server/poller.ts` polls each repository at startup and then on its
    `interval` (default 1h), and every 10 s while one of its jobs runs. It runs at most one poll per
    repository at a time. The startup poll also picks up jobs left running before a restart.
    Reference: `../X-Monitor/x_monitor/core/coordination/engine.py` and `action_jobs.py`.
    Run a repository's poll commands one after another, never in parallel (they share borg's cache lock). The
    runner's timeout only kills the local `ssh`, so under `require_sudo` a hung borg may keep running on the
    host: prefix each poll call with `timeout -k 5 <n>` after `sudo` and the environment, or settle it with task 4.
11. [x] **API routes.**
    - `GET /api/repositories`: the list, each with its status.
    - `GET /api/repositories/:id`: state, archives, and actions with whether each is enabled.
    - `POST /api/repositories/:id/actions/:action`
    - `GET /api/repositories/:id/browse?archive=&path=`
    - `GET /api/jobs/:id` with its output, and `POST /api/jobs/:id/cancel`
    - `GET /api/events`
    - `/api/health` adds each repository's status, for X-Monitor.

    Test them with `app.inject` as `tests/app.test.ts` does.
12. [x] **Authentication.** Required before going online, since the API can delete, prune, purge
    and break locks. Smallest fit: one password hash from a secret file and a session cookie, with
    X-Monitor's TOTP login as a reference if a second factor is wanted.
13. [x] **Web page.** Plain TypeScript, adding a framework only if the page needs one:
    - the repository list with statuses
    - the archives table with diff, restore and delete
    - the archive browser (`browser_rows` in `server/borg/parsing.ts` builds its rows)
    - the jobs panel with live output and cancel
    - events

### Ship it

14. [x] **Nix package and module.** `packages.default` via `buildNpmPackage`, shipping `server/` and
    the built `dist/`. `nixosModules.default` adds:
    - a systemd service with `DynamicUser` and a state directory
    - `openssh` and `borgbackup` on the service's PATH
    - options for the repositories (Nix attributes written out as the JSON config), the SSH key
      file, the passphrase files, and the listen host and port

    Commit `flake.lock`. Reference: `../X-Monitor/nix/module.nix`.
15. [x] **CI.** `.github/workflows/ci.yml` runs `npm ci`, build, test and lint. Pushing a workflow
    file needs a GitHub token with the `workflow` scope.
16. [ ] **Cutover.**
    - Deploy beside X-Monitor against the same repositories and compare the two for a few days.
    - Remove X-Monitor's borg plugin: `x_monitor/plugins/borg/`, its tests, its `config.yaml`
      example, `borgPassphraseFile` in `nix/module.nix`, and the borg meter in
      `x_monitor/core/ui/views/fleet.py`.
    - Add an X-Monitor HTTP check on X-Backups' `/api/health`.

### Then

17. [x] **Dashboard.** Grow the web page (task 13) into a dashboard drawing on the apps under
    "Apps to review for features". Configuration stays declarative in the Nix module, so the page
    shows state and runs actions but never edits repositories, sources or schedules. It covers:
    - destination repositories: size, deduplication and compression over time, archive counts,
      last check and canary results
    - backup jobs: history, durations, outcomes and logs
    - source locations: which paths each repository backs up and how they change between archives
    - schedules: each host's backup timers, their next and last runs, and missed runs

    Needs the store (task 9) to keep history, not only the latest state, and the poller (task 10)
    to read each host's timers (`systemctl list-timers` or borgmatic's config). Review the apps
    first to pick the graphs and views worth copying.

    Left for later: poll history grows without bound (downsample rows older than 90 days), and
    source changes between archives are shown only through Diff, not counted per archive.
18. [ ] **Halon theme.** Theme the web page (tasks 13 and 17) with Halon, as X-Monitor does: a
    `halon-tokens.css` holding every color for the light and dark schemes, following
    `prefers-color-scheme`, and a `halon.css` with the component rules, so no other file states a
    color. Charts take their colors from the same tokens. Sources: `tokens.json` and
    `THEME-DESIGN-GUIDE.md` in `../../Coding/Halon`, and X-Monitor's
    `x_monitor/core/ui/static/halon*.css` and `docs/theme.md`.

### Review the apps' source

Each app's online docs were reviewed on 2026-10-26 (see "Apps to review for features"). These read
the source to confirm what the docs claim and to settle how the features below should be built. One
agent per app, read-only, notes into this file. Ordered by value to X-Backups.

19. [ ] **Borg UI.** `app/` (restore-check modes and canary, staleness thresholds, metrics endpoint,
    borg command builders and timeouts, archive indexing), `frontend/` (repository cards, job and
    progress views, restore wizard), `examples/monitoring/` (Prometheus metric names, Grafana
    dashboards). The docs skip authentication, mounting and reverse-proxy pages, so confirm those
    from source.
20. [ ] **Borg Backup Server.** `src/` (health checks per component, JSON and Prometheus metrics,
    `/api/v1/summary`, failure-alert deduplication), `scheduler.php` (missed-schedule detection),
    `schema.sql` and `migrations/` (job, stats and notification tables), `public/` (dashboard
    charts), `agent/` (progress from `--log-json`). Its API wiki page was cut off and the Backup
    Plans, Restoring Files, Queue and Jobs pages were not read.
21. [ ] **borgmatic.** `borgmatic/actions/check.py` and `borgmatic/borg/` (where check time files go
    under the state directory and how `frequency` is compared; the spot check), `hooks/monitoring/`
    (exact payloads), `hooks/data_source/` (where database dumps sit in an archive), the config
    schema, and the shipped systemd units. The docs leave the check file layout undocumented.
22. [ ] **Borgitory.** `src/borgitory/services/` (JobManager queue, cancel and retry,
    RecoveryService for interrupted jobs, prune preview parsing, FUSE mount cleanup), `templates/`
    (HTMX job output and archive browser). Its docs mix shipped and planned features, so check
    each claim. The Reddit announcement could not be fetched.
23. [ ] **BorgWarehouse.** `pages/api/v1/` and `services/` (status and "no recent backup" alert
    computed from repository mtime, scoped API tokens, archive mode), `Components/` and
    `Containers/` (repository list, monitoring page, whose charts the docs do not show).
24. [ ] **Vorta.** `src/vorta/views/` (archive tab, extract dialog, diff result), `src/vorta/borg/`
    (diff and extract jobs, JSON parsing), `src/vorta/scheduler/` (next-run and missed-run logic).
    The docs have no schedule or diff pages, so both are unverified.
25. [ ] **BorgWeb.** `borgweb/views/` and `js/` only. Low priority: X-Backups already does
    everything it does.

### Features the review found missing

Flagged for another session; each wants its source review (tasks 19–25) first. Left out as out of
scope: notifications (X-Monitor alerts), schedulers and backup plans, repository creation, editing
config from the page, users and roles, OIDC, cloud sync, hooks, database dumps, agents, and FUSE
mounts.

26. [ ] **Health levels.** `/api/health` answers `status: "ok"` whatever the repositories say. Give
    it an overall ok, warning or critical with each repository's reasons, so X-Monitor can alert on
    one field (Borg Backup Server, Borg UI).
27. [ ] **Two-level staleness.** One `max_age` decides failed. Add a warning threshold before it, and
    the same pair for the last check and canary ages (Borg UI warns at 14 days, critical at 30).
28. [ ] **Warning job state.** `JobState` has no warning, so a borg exit 1 is `succeeded` with a log
    line. Add a completed-with-warnings state shown apart from success (Borg Backup Server,
    BorgWeb).
29. [ ] **Read-only token and metrics.** A scoped token for read-only API access and a
    token-protected Prometheus `/metrics` (Borg UI, Borg Backup Server, BorgWarehouse). Today the
    API takes only the login session.
30. [ ] **Job retry and history.** Rerun a failed job with the same action, and filter the job
    history by repository, kind and outcome (Borg Backup Server, Borgitory). Add a 24-hour and
    7-day job activity chart (Borg Backup Server).
31. [ ] **Fuller restore verification.** Verify Restore checks one canary path. Add probe paths
    and a full-archive extract to `/dev/null` as on-demand modes (Borg UI).
32. [ ] **Archive download.** Download a file or folder from the browser as a tar stream via
    `borg export-tar`, and an extract dialog with a target folder (Borg UI, Borgitory, Vorta).
33. [ ] **Paused repositories and storage.** A declared paused flag that keeps a repository listed
    but silences staleness, an append-only badge, and free space and quota on the storage host
    (BorgWarehouse).
34. [ ] **borgmatic awareness.** On borgmatic hosts, show each check type's last run from
    borgmatic's state directory, recognise `borgmatic.timer`, and warn when an archive's file
    count drifts far from the previous one, a cheap form of the spot check (task 21 settles the
    file layout). Optionally accept borgmatic's start/finish pings to show a backup running
    between polls.

## Apps to review for features

Reviewed from their online docs on 2026-10-26; source review is tasks 19–25 and the gaps found are
tasks 26–34. Release dates below lack a year on the release pages, so 2026 is assumed.

- **Borg UI** (Python backend and JS frontend, AGPL-3.0, about 1.7k stars, 2.4.3 on 26 Oct). Reaches
  repositories locally, over SSH, through its own agents and rclone. Cron backup plans chaining
  prune, compact and check; Apprise notifications; restore checks by canary, probe paths or full
  archive; staleness warning at 14 days and critical at 30; Prometheus `/metrics` behind a token;
  roles, OIDC and proxy-header login; an observe-only import of existing repositories. No history
  charts of its own, only example Grafana dashboards.
- **Borg Backup Server** (PHP with MySQL and ClickHouse, Python agents polling over HTTPS, MIT, 387
  stars, v2.99.7 on 26 Oct). A different shape: clients push into append-only `borg serve`
  repositories. Stat cards, a 24-hour jobs chart, a 7-day activity chart, storage per client and
  upcoming backups; a queue with cancel and retry; a completed-with-warnings job state; 12
  notification events with deduplicated failure alerts and missed-schedule detection; health per
  component (ok, warning, critical), JSON and Prometheus metrics, a summary endpoint; TOTP and SSO.
- **borgmatic** (Python CLI, GPL-3.0-or-later, 2.1.10 on 5 Oct). Not a UI. Check types
  `repository`, `archives`, `extract`, `data` and `spot`, each with its own `frequency`, with the
  last run of each kept under `~/.local/state/borgmatic/checks`. The spot check compares source
  file counts and hashes a sample against the latest archive. Monitoring hooks for Healthchecks,
  Uptime Kuma, ntfy, Loki, Zabbix and others send start, finish and fail. Ships
  `borgmatic.service` and `borgmatic.timer`, and logs structured fields to the journal.
- **Borgitory** (FastAPI with HTMX, SQLite, APScheduler, MIT, about 194 stars, v3.0.0 on 16 Oct).
  Runs borg in its own container. Cron schedules, retention with prune preview, Apprise, hooks,
  rclone sync, an archive browser with downloads over FUSE, job history with cancel and retry, one
  login. API keys, roles and metrics are only planned; its docs mix planned features in.
- **BorgWarehouse** (Next.js, AGPL-3.0, about 681 stars, 3.7.0 on 20 Sep). Manages the storage
  server clients push to: repositories, restricted SSH keys, quotas. Sees only each repository's
  size and last change, so cannot tell a good backup from a failed one. A "no recent backup" alert
  per repository, SMTP, Apprise and webhooks, OIDC, and a REST API with scoped tokens.
- **Vorta** (PyQt desktop app, 0.11.6 on 7 Sep). Repository, Sources, Archives and Schedule tabs;
  extract by a full-path file tree into a chosen folder; mount; prune by hand or after each backup.
  Its scheduler, WiFi rules and keyring are desktop concerns.
- **BorgWeb** (Flask, 0.3.0, apparently stagnant). Lists backup logs and starts a backup; no login.
  X-Backups already covers it.

None of them has X-Backups' size and deduplication history, check freshness read from systemd
units, Purge Excluded or host timer views. The views to copy, in order, mostly done by task 17:

1. Repository grid: status, last archive age against `max_age`, size, archive count, last check.
2. Overdue and missed-run flags per repository and per timer.
3. Job history: kind, outcome, duration, start, with expandable and live output.
4. Size over time: original, compressed and deduplicated, plus the dedup ratio.
5. Archive count over time, and per-archive deduplicated size (new data) bars.
6. Check and canary pass/fail strip.
7. Sources: paths per repository, and diff counts between two archives.
8. Schedules: timer, last trigger, next elapse, last result, missed.

| App | Source | Docs / site |
| --- | --- | --- |
| Vorta | https://github.com/borgbase/vorta | https://vorta.borgbase.com/ |
| borgmatic | https://github.com/borgmatic-collective/borgmatic | https://torsion.org/borgmatic/ |
| Borgitory | https://github.com/mlapaglia/Borgitory | https://borgitory.com/en/latest/ |
| Borg UI | https://github.com/karanhudia/borg-ui | https://docs.borgui.com/ |
| BorgWeb | https://github.com/borgbackup/borgweb | https://borgweb.readthedocs.io/en/stable/ |
| BorgWarehouse | https://github.com/Ravinou/borgwarehouse | https://borgwarehouse.com/ |
| Borg Backup Server | https://github.com/marcpope/borgbackupserver | https://www.borgbackupserver.com/ |

The BorgBase docs, community-scripts and alexjenkins.tech links were all third-party pages about Borg UI, so they were dropped.
https://borgui.com/ shows only the title "Borg UI"; its docs use license.borgui.com, so it is very likely the same project.
Borgitory's Reddit announcement (https://www.reddit.com/r/BorgBackup/comments/1nedz9v/) could not be fetched.
