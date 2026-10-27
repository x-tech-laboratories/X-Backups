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
- Declared repositories stay scheduled by each host's own timers (borgmatic or NixOS
  `services.borgbackup`), which X-Backups watches. Page-managed repositories can be scheduled by
  X-Backups itself (task 49).
- `/api/health` reports each repository's status and X-Monitor alerts on it; X-Backups' own
  notifications (task 50) sit beside that.

## Open questions

- Do all repository hosts have systemd and allow `sudo systemd-run` for the SSH user? If not, keep
  the `setsid` jobs in `src/server/borg/detached.ts` and skip task 4.
- Are there repositories on hosts SSH cannot reach, such as a laptop that sleeps (X-Monitor reaches
  those through its agent today)? Task 56's agent covers them.
- Does any host lack its own backup timer? Task 49's scheduler covers it (cron parsing is in
  `../X-Monitor/x_monitor/core/coordination/schedule.py`).

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
    - [x] Deploy beside X-Monitor against the same repositories (Heimdall, `backups.heimdall.technet`, 2026-10-26).
    - [ ] Compare the two for a few days.
    - Remove X-Monitor's borg plugin: `x_monitor/plugins/borg/`, its tests, its `config.yaml`
      example, `borgPassphraseFile` in `nix/module.nix`, and the borg meter in
      `x_monitor/core/ui/views/fleet.py`.
    - Add an X-Monitor HTTP check on X-Backups' `/api/health`.

### Then

17. [x] **Dashboard.** Grow the web page (task 13) into a dashboard drawing on the apps under
    "Apps to review for features". Configuration stayed declarative in the Nix module, so the page
    shows state and runs actions but never edits repositories, sources or schedules (tasks 35–37
    change that). It covers:
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
18. [x] **Halon theme.** Theme the web page (tasks 13 and 17) with Halon, as X-Monitor does: a
    `halon-tokens.css` holding every color for the light and dark schemes, following
    `prefers-color-scheme`, and a `halon.css` with the component rules, so no other file states a
    color. Charts take their colors from the same tokens. Sources: `tokens.json` and
    `THEME-DESIGN-GUIDE.md` in `../../Coding/Halon`, and X-Monitor's
    `x_monitor/core/ui/static/halon*.css` and `docs/theme.md`.

    Done: `src/web/halon-tokens.css` is X-Monitor's token file verbatim and `src/web/halon.css` holds every rule.

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

Flagged for another session; each wants its source review (tasks 19–25) first. What was once left
out as out of scope (editing config from the page, notifications, schedulers and backup plans,
repository creation, users and roles, OIDC, cloud sync, hooks, database dumps, agents and FUSE
mounts) is now in: tasks 35–37 and 47–56.

26. [ ] **Health levels.** `/api/health` answers `status: "ok"` whatever the repositories say. Give
    it an overall ok, warning or critical with each repository's reasons, so X-Monitor can alert on
    one field (Borg Backup Server, Borg UI).
27. [ ] **Two-level staleness.** One `max_age` decides failed. Add a warning threshold before it, and
    the same pair for the last check and canary ages (Borg UI warns at 14 days, critical at 30).
28. [ ] **Warning job state.** `JobState` has no warning, so a borg exit 1 is `succeeded` with a log
    line. Add a completed-with-warnings state shown apart from success (Borg Backup Server,
    BorgWeb).
29. [x] **Read-only token and metrics.** A scoped token for read-only API access and a
    token-protected Prometheus `/metrics` (Borg UI, Borg Backup Server, BorgWarehouse). Built
    with task 51: admins create tokens on the Users page; a token reads like a viewer of every
    repository and scrapes `/metrics` (`src/server/metrics.ts`).
30. [x] **Job retry and history.** Rerun a failed job with the same action, and filter the job
    history by repository, kind and outcome (Borg Backup Server, Borgitory). Add a 24-hour and
    7-day job activity chart (Borg Backup Server).
31. [ ] **Fuller restore verification.** Verify Restore checks one canary path. Add probe paths
    and a full-archive extract to `/dev/null` as on-demand modes (Borg UI).
32. [x] **Archive download.** Download a file or folder from the browser as a tar stream via
    `borg export-tar`, and an extract dialog with a target folder (Borg UI, Borgitory, Vorta).
    Built as `GET /api/repositories/:id/download`, streaming a file through `extract --stdout` or
    folders and picks as a gzipped `export-tar`, linked from each row and "Download picked" on the
    Files tab. A download holds borg's lock, so it is refused while a job runs, listed on the
    repository's Overview tab with who started it, and can be stopped there. Restores go to a
    folder chosen in the restore dialog (restore_dir by default): a new dated folder inside it, or
    the folder itself only when it is empty or missing, so a restore never overwrites files.
33. [ ] **Paused repositories and storage.** A declared paused flag that keeps a repository listed
    but silences staleness, an append-only badge, and free space and quota on the storage host
    (BorgWarehouse).
34. [ ] **borgmatic awareness.** On borgmatic hosts, show each check type's last run from
    borgmatic's state directory, recognise `borgmatic.timer`, and warn when an archive's file
    count drifts far from the previous one, a cheap form of the spot check (task 21 settles the
    file layout). Optionally accept borgmatic's start/finish pings to show a backup running
    between polls.

### UI layout review

Each app's frontend was read in source on 2026-10-26 (shallow clones, not the docs), for how it lays
its pages out. The goal is a page with at least every capability the other apps have.

#### How each app is laid out

- **Borg UI** (React, MUI):
  - Shell: an app bar and a 240 px sidebar of about 20 entries in groups (Main, Infrastructure,
    Storage, Backups, and Settings with collapsible subgroups). On phones the sidebar becomes a
    drawer and tables become card lists.
  - Dashboard, polled every 30 s: a health banner, a success donut, per-repository health,
    upcoming backups, space savings and an activity timeline. Skeletons while loading, and an
    alert with Retry on error.
  - Repositories: cards grouped Local/Remote or Full/Observe-only. Each carries 15+ fields and
    chips (sync issue, borg version, paused), plus Check, Compact and Prune buttons that open
    explanatory dialogs.
  - Activity: runs grouped by repository, with follow-up jobs nested under their parent and
    filters in the URL.
  - Archive page: stat tiles with deltas against the previous archive, and Changes, Files and
    Info tabs kept in `?tab=`.
  - Wizards: restore takes three steps (Files, Destination, Review), and the repository wizard
    previews the exact borg command it will run.
  - Prune preview ranks the archives that would go.
  - Live updates: one shared SSE stream for jobs, refetched after a reconnect.
  - Settings: each one is tagged Customized, From environment or Default.
  - Theme and i18n: light/dark/system toggle in the avatar menu, four languages.
- **Borg Backup Server** (PHP, Bootstrap):
  - Shell: a dark top bar (page title, notification bell, user menu with theme toggle) and a
    sidebar that becomes an offcanvas drawer.
  - Dashboard:
    - four clickable KPI tiles; the errors tile turns red and opens the log filtered to errors
    - a 24 h stacked jobs-by-type chart and a backup summary grid
    - server health sparklines
    - active jobs beside upcoming schedules
    - recent jobs, flagged when one finished with warnings
  - Repository page: one card per maintenance action, each saying what it does and when to use
    it.
  - Archive page: breadcrumbs, a prev/next stepper, a changes-against-previous table and a
    searchable file catalog.
  - Queue: progress bars, a duration bar against the typical run, and cancel and retry per row.
    The job page adds a green, yellow or red result bar.
  - Schedules: a weekly calendar.
  - Archive lock: a locked archive's delete button is disabled, with the reason in a tooltip.
  - Settings: rows with the label and help on the left and the control on the right.
  - Confirms: a `data-confirm` modal for ordinary actions, and a stronger modal with scope
    checkboxes ("keep data on disk", "also delete offsite") for deleting a repository.
- **Borgitory** (FastAPI, HTMX):
  - Shell: a top bar and an 11-item flat sidebar mixing operations, config and debug pages. The
    tabs are pushed into the URL.
  - No overview: it opens on the repository config page, whose cards show no health or size.
  - Layout: forms on the left, lists on the right.
  - Job history: expandable cards listing each task, with live output per task over SSE that
    swaps to a static view when the task ends.
  - Prune: dry run is on by default, under a warning banner.
  - Archive browser: breadcrumbs and per-file download.
  - Limits: lists capped at 10 archives and 20 jobs, with no paging.
  - Confirms: native `confirm()` everywhere.
- **BorgWarehouse** (Next.js):
  - Shell: a dark header with a theme toggle and an avatar menu, and a three-icon rail that
    disappears on phones with nothing in its place.
  - Repository list: search, sort and an archived filter, all kept in localStorage. Cards are
    collapsible, with a status dot, chips (append-only, alerts off) and a storage bar coloured at
    75 % and 90 %.
  - Monitoring: four KPI cards, a storage-per-repository chart, and a "Needs attention" list with a
    reason per repository and an "Everything looks healthy" empty state.
  - Confirms: one dialog with danger and warning variants. It names the target, says whether the
    action can be undone and shows a busy label.
  - Archived repositories are dimmed, with a disabled form and a banner.
  - Settings: tabs (General, Notifications, Storage, Integrations). An environment-set value is
    shown read-only, naming the variable.
- **Vorta** (PyQt):
  - Shell: a profile list on the left; tabs Repository, Sources, Schedule and Archives on the
    right; a two-line status and Start/Cancel at the bottom.
  - Archives: repository actions (Check, Prune, Compact, Mount) are kept apart from archive actions
    (Diff, Extract, Rename, Delete).
  - Extract and Diff dialogs share a Tree / Simplified / Flat switch. Diff colours added, modified
    and removed entries and sums a net size per folder.
  - The Schedule tab puts prune, check and compact beside the backup timing and shows the next run.
- **BorgWeb**: a log list beside a paged viewer and one Start Backup button. Each log is coloured by
  borg's exit code.
- **borgmatic**: no UI. Its YAML or `services.borgmatic` config is the source of truth, and the rest
  is read through `--json`, its check state files and its monitoring hooks. X-Backups follows this
  model.

#### What they share

1. A shell that stays put: a header with the user menu and theme toggle, and a sidebar that becomes
   a drawer on phones.
2. An overview built from KPI tiles, a needs-attention list, a jobs chart and upcoming runs.
3. Repository cards with a status colour, the last backup's age, the size, and chips for special
   states (append-only, observe-only, paused, archived).
4. A jobs or queue page with filters, progress, cancel and retry.
5. An archive page with changes against the previous archive, and a file tree that restores to a
   chosen destination.
6. Destructive actions confirmed in a dialog that names the target and the consequence. The
   strongest add a typed name (Borg UI) or scope checkboxes (Borg Backup Server).
7. Prune previewed as a dry run first.
8. Live job output, pushed over SSE (Borg UI, Borgitory) or polled.
9. Light, dark and system themes, switched from the header and remembered.
10. Settings as sections of label, help and control.
11. Weak spots shared by nearly all of them:
    - native `confirm()` mixed with custom dialogs
    - status shown by colour alone
    - icon-only buttons
    - modals with no focus trap
    - no `aria-live` on polled tables
    - lists cut off at a fixed count
    - polling that swallows its errors
    - no global search

#### Where X-Backups stands

Ahead of the others:
- history charts: size, compression and dedup over time, unique data per archive, and check and
  canary strips (no other app charts history)
- the host timer view with missed runs
- Purge Excluded
- polling over SSH, with no agent

Behind, in layout:
- Each repository is one long page, with history, archives, browser, jobs, sources, timers and
  events stacked in turn.
- There is no navigation beyond a back link.
- There are no cross-repository jobs, archives or events pages, and no page per archive.
- Confirms use native `confirm()`.
- An action's outcome lands in a panel at the top that may be scrolled out of view.
- Archives and jobs cannot be searched, sorted, filtered or paged.
- There is no theme toggle, and no skeletons or Retry on error.
- The page polls every 15 s whether anything is running or not.

#### Configuration from the page

None of the apps both reads declarative config and lets the page edit it. These come closest:
- Borg UI tags each setting with where its value came from (saved, environment or default), and a
  saved value wins.
- BorgWarehouse shows a setting set by the environment as read-only and names the variable.
- Borg UI's observe-only repositories disable what does not apply and say why, rather than hiding
  it.

Outside borg, Grafana's provisioning and Home Assistant's YAML entities set the pattern. A
provisioned Grafana dashboard cannot be saved from the page unless `allowUiUpdates` is set, and a
Home Assistant entity defined in YAML "cannot be managed from the UI".

#### Recommended layout

- **Shell:**
  - The header holds the brand, a search over repositories and archives by name, a running-jobs
    indicator, a light/dark/system toggle (with task 18) and Log out.
  - The sidebar holds Overview, Repositories, Jobs, Schedules and Events, plus Settings when the
    config is not wholly declared. It becomes a drawer under 768 px. Routes stay hash-based.
- **Overview:**
  - Tiles that open filtered views (the failing tile opens the repositories filtered to failing).
  - A needs-attention list with one reason per line, such as "last backup 3 d ago, limit 1 d",
    "check failed" or "timer missed".
  - A 24 h and 7 d chart of jobs by outcome.
  - Running jobs beside the timers' upcoming runs.
  - Total stored over time.
- **Repositories:**
  - A grid or table, with search, sort (status, name, last backup, size) and filters (status,
    host, declared or page-managed). All of it is kept in the URL.
  - Cards keep today's fields and add chips for append-only, paused, declared and running.
- **Repository page:**
  - Tabs kept in the URL: Overview (facts, needs-attention lines, charts), Archives, Jobs, Sources
    and retention, Schedule, Events and Config.
  - Actions in two groups, as Vorta does. Repository actions sit in the header: Backup, Check,
    Compact, Prune preview, Break lock. Archive actions sit on each row: Browse, Diff, Restore,
    Download, Delete.
  - Maintenance actions each carry a sentence saying what they do, as Borg Backup Server's do.
- **Archive page:**
  - Breadcrumbs and a prev/next stepper.
  - Deltas against the previous archive (files, original, unique).
  - A Changes tab: the diff, coloured by added, modified and removed, with net size per folder and
    a Tree/Flat switch.
  - A Files tab: a tree with checkboxes and search, and Restore and Download for the selection.
- **Jobs page:**
  - Every job across repositories, filtered by repository, kind, outcome and period, with the
    filters in the URL, and paged.
  - A duration bar against the median for that kind, live output, cancel and retry.
  - A job page with a result bar and the output.
- **Dialogs:**
  - One confirm component in place of `confirm()`. It names the target, says what is lost and
    whether that can be undone, and shows a busy label.
  - A typed name for Purge Excluded, and for Break Lock while a job may be running.
  - Outcomes arrive as toasts that link to the job, and errors also stay inline.
- **Live updates:** one SSE stream of job and poll events, refetched after a reconnect. The page
  falls back to polling only while a job runs, and pauses while the tab is hidden.
- **States:** skeletons while loading, an inline error with Retry, and empty states that say what
  to do next.
- **Accessibility:**
  - status as text as well as colour
  - labelled icon buttons
  - dialogs with a focus trap and Escape
  - `aria-live` on job state
  - tables that sort by value, not by the displayed text

#### Feature parity

Decided on 2026-10-26: everything on the old out-of-scope list comes in, so X-Backups does at least
what each of the other apps does. These are tasks 47–56, to be built after the UI (tasks 38–46).

#### Tasks

35. [x] **Config sources and read-only mode.** Read two sources:
    - the declared file, `X_BACKUPS_CONFIG`, which the Nix module writes
    - a page-managed `config.json` in `X_BACKUPS_STATE_DIR` (`src/server/sources.ts`)

    A `config_mode` setting picks how they combine:
    - `declarative`: the page edits nothing. This is today's behaviour and the Nix module's
      default.
    - `mixed`: declared repositories are locked, and new ones can be added from the page.
    - `page`: the declared file is optional; whatever it declares is still locked.

    The Nix module sets the mode (`services.x-backups.configMode`, env `X_BACKUPS_CONFIG_MODE`). A
    declared repository shadows a page-managed one of the same name, and Settings lists the
    shadowed copies. Each repository in the API carries `source: "declared" | "page"` and its
    config `editable`.
36. [x] **Config editor.**
    - Build the form from `borg_fields` in `src/server/config.ts`, so a new field appears without
      page changes. Group it into Connection, Sources, Retention, Checks and Jobs.
    - Check posted entries with the same `parse_repository`, and show its message inline beside
      the field.
    - A declared repository shows the same form read-only, under a "Declared in the Nix
      configuration" banner, with no Edit or Delete.
    - A passphrase never travels back to the page. The form takes a file path or a command, or a
      passphrase written once into the state directory (mode 0600) and never read back.
    - A save applies without a restart: the poller adds, replaces or drops the repository.
    - Each save is logged as an event.
    - Each page-managed repository has "Show as Nix" and "Show as JSON", so it can be moved into
      the declared file. Once declared it shadows the page copy, which can then be deleted.

    Built at `#/new-repository` and on the Config tab. A name cannot change once saved, since it
    names archives, units and the stored history. Removing a repository keeps its history.
37. [x] **Settings and their provenance.** Global settings get the same rule: poll interval,
    staleness thresholds (task 27), browse limit and theme. Each setting is tagged Declared, Saved
    or Default, as Borg UI does, and a declared setting is read-only.

    Built as a file's top-level `defaults` (the module's `defaults`) for `interval`, `max_age`,
    `check_max_age` and `browse_limit`, edited on the Settings page. Task 27's warning thresholds
    join the list when they exist. The theme stays a per-browser choice rather than a server
    setting.
38. [x] **App shell and routing.**
    - The header and sidebar from "Recommended layout", with a drawer on phones.
    - Routes for overview, repositories, repository tabs, archive, jobs, job, schedules, events
      and settings.
    - The theme toggle comes with task 18. Done ahead of it over the existing tokens (system,
      light, dark, kept in localStorage); Halon still replaces the token blocks.
39. [x] **Overview.** Clickable tiles, the needs-attention list (reasons from task 26), the jobs
    chart (task 30), running jobs beside upcoming timer runs, and total stored over time.
    The reasons are worked out in the page (`src/web/attention.ts`) until task 26 gives them from
    the server.
40. [x] **Repository page.**
    - Split the long page into tabs kept in the URL.
    - Group the actions into repository actions and archive actions.
    - Give each maintenance action a one-line description.
    - Show the outcome as a toast linking to the job, not a panel at the top.
41. [x] **Archive page.**
    - Breadcrumbs, the prev/next stepper and deltas against the previous archive.
    - A Changes tab built from `borg diff --json-lines`: colour by change type, net size per
      folder, and a Tree/Flat switch.
    - A Files tab with search, restore and download (task 32).
42. [x] **Jobs page.** Jobs across all repositories with filters and paging in the URL, a duration
    bar against the median for each kind, retry (task 30), and a job page with a result bar and
    its output.
43. [x] **Confirm dialog and toasts.**
    - One dialog component in place of every `confirm()`, naming the target and saying whether the
      action can be undone.
    - A typed name for Purge Excluded and for a forced Break Lock.
    - Toasts for outcomes, with errors also kept inline.
44. [x] **Live updates over SSE.**
    - `GET /api/stream` (kept apart from `/api/events`, which lists events) for job state and
      output, poll results and config changes. Config changes join it with task 36.
    - The page refetches after a reconnect, and polls only while the stream is down and the tab
      is visible.
    - Show an error with Retry in place of silent failures.
45. [x] **Lists.** Search, sort, filter and paging, kept in the URL, for repositories, archives, jobs
    and events. The header search goes across repositories and archives.
46. [x] **States and accessibility.**
    - Skeletons while loading, and empty states that say what to do next.
    - Status as text as well as colour, and labelled buttons.
    - Dialogs with a focus trap and Escape, and `aria-live` on job state.
    - Mobile layouts for the tables, as card lists or with columns dropped.

#### Parity tasks

47. [ ] **Repository creation.** `borg init` from the page in `mixed` and `page` modes (task 35),
    with the encryption mode, the passphrase handled as in task 36, and a preview of the command
    that will run (Borg UI, Borgitory). Also import an existing repository by opening it with its
    passphrase before saving.
48. [ ] **Schedule calendar.** A weekly calendar of every host timer and its runs, with missed and
    failed runs marked and a day switcher on phones (Borg Backup Server).
49. [ ] **Scheduler and backup plans.** For page-managed repositories, X-Backups owns the schedule:
    a cron or `OnCalendar` expression with presets and a readable description, written as a
    systemd timer on the host or run by X-Backups itself, with "Run now", enable and disable. A
    plan chains backup, prune, compact and check, each with its own frequency, as borgmatic's
    `checks` do (Borg UI, Borgitory, Vorta). Declared repositories keep their host timers.
50. [ ] **Notifications.** Apprise URLs, an SMTP sender and a webhook with a secret, each with a
    Test button. Events: backup failed, completed with warnings, missed schedule, stale, check or
    canary failed, recovered. Failure alerts are deduplicated until the state changes (Borg Backup
    Server, Borg UI, BorgWarehouse, Borgitory). This sits alongside X-Monitor's alert on
    `/api/health`.
51. [x] **Users, roles and login.** Several users with roles (admin, operator, viewer) and
    per-repository access, TOTP with recovery codes (X-Monitor's login as the reference), OIDC,
    and login from a reverse proxy's header. Builds on task 29's tokens (Borg UI, Borg Backup
    Server, BorgWarehouse).

    Built in `src/server/accounts.ts`, `auth.ts`, `totp.ts` and `oidc.ts`, with the Users and
    Account pages. The password hash file stays the declared admin, whose role and password the
    page cannot change. OIDC and the proxy header only log in users an admin has added. Users
    live in the state database, not in the Nix configuration; declaring them there is left for
    later if wanted.
52. [ ] **FUSE mount.** Mount an archive or the whole repository on its host with `borg mount`,
    show the mount point and Unmount, and unmount when the job ends or X-Backups starts (Borg UI,
    Borgitory, Vorta).
53. [ ] **Cloud sync.** Mirror a repository to an rclone remote after each backup or on a schedule,
    with a Test button and the last sync's state on the card (Borg UI, Borgitory).
54. [ ] **Hooks.** Commands before and after a backup or plan run on the host, ordered, each with a
    timeout and with a choice to stop the run if it fails (Borgitory, Vorta).
55. [ ] **Database dumps.** Dump PostgreSQL, MySQL, MariaDB, MongoDB or SQLite into the archive as
    borgmatic's data sources do, and restore one database from an archive (borgmatic, Borg Backup
    Server).
56. [ ] **Agents.** A small agent for hosts SSH cannot reach, such as a sleeping laptop: it calls
    in over HTTPS with a token, picks up queued actions, and reports results and progress (Borg
    Backup Server, Borg UI). This settles the second open question.

#### Follow-ups from the first build

57. [ ] **Users in the Nix configuration.** Users, roles and per-repository access live in the state
    database and are managed from the Users page. Let `services.x-backups.users.<name>` declare
    them too (role, repositories, an optional password hash file), shown as declared and locked
    on the page like declared repositories, so a NixOS setup can be fully declarative. The
    module's options were evaluated with `nixpkgs.lib.nixosSystem` on 2026-10-27 and come out
    right; no VM test has run the service yet.
58. [ ] **Halon gaps.** Draw the menu, theme and close icons as SVG on a 24 px artboard with a 2 px
    stroke, sized by `--icon-size-small` as Halon's §4.5 asks, and style the select's dropdown
    arrow (the tokens file has none, so selects keep the browser's arrow today).

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
