# X-Backups

A web platform for managing borg backups, taking over the borg functionality now in X-Monitor.
X-Monitor keeps only the job of watching X-Backups itself.

## Goals

## Scope

## Architecture (proposed)

X-Backups does one thing, so it leaves out X-Monitor's general machinery: no plugin loader, monitor
graph, groups, triggers, agent, sync or per-plugin UI contract.

- One Node process. Repositories come from one JSON file the Nix module writes; a restart reloads it.
- `server/borg/` builds commands and reads their output, and never runs anything. A runner runs the
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
  the `setsid` jobs in `server/borg/detached.ts` and skip task 4.
- Are there repositories on hosts SSH cannot reach, such as a laptop that sleeps (X-Monitor reaches
  those through its agent today)? Each one needs a plan before cutover.
- Does any host lack its own backup timer? Only then does X-Backups need a scheduler (cron parsing is
  in `../X-Monitor/x_monitor/core/coordination/schedule.py`).

## Tasks

One agent and one branch per task. Earlier tasks change the contracts later ones build on, so take
them in order unless a task says otherwise. `server/borg/repository.test.ts` stays green throughout,
adapted where a task changes a contract.

### Simplify the ported code

1. [ ] **Typed state.** Replace `MetricReader`, `CollectResult`'s metrics and metadata, and the
   JSON-in-metadata fields (`archive_list`, `check_ok_epoch`, `canary_ok`) with one
   `RepositoryState` type that `poll` reads and returns. Remove X-Monitor UI leftovers:
   `DEFAULT_LAYOUT`, `CardPair` and the `*_pair()` methods, and action `icon`, `variant` and `more`.
   Files: `server/borg/types.ts`, `repository.ts`, `testing.ts`.
2. [ ] **One borg call per command.** Remove the framing: `sequence_command`, `split_poll`,
   `frame_line`, the `POLL_*` shell variables, the poll deadline and `CUT_SHORT`. `commands()`
   returns separate calls and `parse()` reads one result per call. Timeouts move to the runner
   (task 8). Files: `server/borg/shell.ts`, `repository.ts`.
3. [ ] **Typed actions.** Replace the string switches in `plan_action` and `interpret_action`, and
   the `pending_launch` field, with one command method and one reader method per action, so each
   API route calls its pair directly.
4. [ ] **Jobs as systemd units** (if the first open question allows). Launch with
   `systemd-run --unit=x-backups-<repo>-<time>` and `Nice=`/`IOSchedulingClass=idle` properties in
   place of the `nice`/`ionice` wrappers. Read state with `systemctl show`, output with
   `journalctl -u <unit>`, and cancel with `systemctl stop`. Keep `flock` for `job_lock` and
   `systemd-inhibit` for `inhibit_sleep`. Remove `server/borg/detached.ts`.
5. [ ] **Rename X-Monitor leftovers.** Done except the `cache_dir` default, which waits for task 16. The `__XMONITOR_*` and `__x_monitor_*` shell markers, the
   `cache_dir` default `/var/cache/x-monitor-borg` and `restore_dir` default
   `/var/tmp/x-monitor-restore` in `repository.ts`, `$HOME/.cache/x_monitor/jobs`,
   `--who=X-Monitor`, and "X-Monitor" in `failure_hint`. A new `cache_dir` rebuilds each
   repository's chunks cache once, so land that default with the cutover (task 16).
6. [ ] **Passphrase off the command line.** `env_prefix` reads `passphrase_file` and writes
   `BORG_PASSPHRASE=<secret>` into the command, where the target's process list shows it. Send it
   on the SSH command's stdin with `BORG_PASSPHRASE_FD=0` instead. For systemd jobs, use
   `passphrase_command` on the target or a systemd credential.

### Run it

7. [ ] **Config loading.** `server/config.ts` reads the JSON file named by `X_BACKUPS_CONFIG`:
   `{ "repositories": [BorgConfig plus host, ssh_user and interval] }`. It validates on load and
   stops with the repository's name on a bad entry. Add an example file with placeholder hosts.
8. [ ] **Runner.** `server/runner.ts` runs a command on a host with
   `ssh -o BatchMode=yes -o ControlMaster=auto -o ControlPath=… -o ControlPersist=…`, or locally with
   `sh -c` when the repository has no host. It enforces a timeout by killing the process, takes
   optional stdin (task 6), and returns a `CmdResult`. It uses the system's `known_hosts`. Reference:
   `../X-Monitor/x_monitor/core/connectors/ssh_connector.py`.
9. [ ] **Storage.** `server/store.ts` on `node:sqlite` (built into Node 24) keeps repository state,
   events, and jobs (unit name, kind, state, exit code, journal cursor), with the database in
   `X_BACKUPS_STATE_DIR`. It implements whatever store interfaces tasks 1 and 4 leave.
10. [ ] **Poll loop.** `server/poller.ts` polls each repository at startup and then on its
    `interval` (default 1h), and every 10 s while one of its jobs runs. It runs at most one poll per
    repository at a time. The startup poll also picks up jobs left running before a restart.
    Reference: `../X-Monitor/x_monitor/core/coordination/engine.py` and `action_jobs.py`.
11. [ ] **API routes.**
    - `GET /api/repositories`: the list, each with its status.
    - `GET /api/repositories/:id`: state, archives, and actions with whether each is enabled.
    - `POST /api/repositories/:id/actions/:action`
    - `GET /api/repositories/:id/browse?archive=&path=`
    - `GET /api/jobs/:id` with its output, and `POST /api/jobs/:id/cancel`
    - `GET /api/events`
    - `/api/health` adds each repository's status, for X-Monitor.

    Test them with `app.inject` as `server/app.test.ts` does.
12. [ ] **Authentication.** Required before going online, since the API can delete, prune, purge
    and break locks. Smallest fit: one password hash from a secret file and a session cookie, with
    X-Monitor's TOTP login as a reference if a second factor is wanted.
13. [ ] **Web page.** Plain TypeScript, adding a framework only if the page needs one:
    - the repository list with statuses
    - the archives table with diff, restore and delete
    - the archive browser (`browser_rows` in `server/borg/parsing.ts` builds its rows)
    - the jobs panel with live output and cancel
    - events

### Ship it

14. [ ] **Nix package and module.** `packages.default` via `buildNpmPackage`, shipping `server/` and
    the built `dist/`. `nixosModules.default` adds:
    - a systemd service with `DynamicUser` and a state directory
    - `openssh` and `borgbackup` on the service's PATH
    - options for the repositories (Nix attributes written out as the JSON config), the SSH key
      file, the passphrase files, and the listen host and port

    Commit `flake.lock`. Reference: `../X-Monitor/nix/module.nix`.
15. [ ] **CI.** `.github/workflows/ci.yml` runs `npm ci`, build, test and lint. Pushing a workflow
    file needs a GitHub token with the `workflow` scope.
16. [ ] **Cutover.**
    - Deploy beside X-Monitor against the same repositories and compare the two for a few days.
    - Remove X-Monitor's borg plugin: `x_monitor/plugins/borg/`, its tests, its `config.yaml`
      example, `borgPassphraseFile` in `nix/module.nix`, and the borg meter in
      `x_monitor/core/ui/views/fleet.py`.
    - Add an X-Monitor HTTP check on X-Backups' `/api/health`.

## Apps to review for features

Not reviewed yet.

| App | Source | Docs / site |
| --- | --- | --- |
| Vorta | https://github.com/borgbase/vorta | https://vorta.borgbase.com/ |
| borgmatic | https://github.com/borgmatic-collective/borgmatic | https://torsion.org/borgmatic/ |
| Borgitory | https://github.com/mlapaglia/Borgitory | https://www.reddit.com/r/BorgBackup/comments/1nedz9v/borgitory_a_web_ui_for_managing_borg_repositories/ |
| Borg UI | https://github.com/karanhudia/borg-ui | https://docs.borgui.com/ |
| BorgWeb | https://github.com/borgbackup/borgweb | https://borgweb.readthedocs.io/en/stable/ |
| BorgWarehouse | https://github.com/Ravinou/borgwarehouse | https://borgwarehouse.com/ |
| Borg Backup Server | https://github.com/marcpope/borgbackupserver | https://www.borgbackupserver.com/ |

The BorgBase docs, community-scripts and alexjenkins.tech links were all third-party pages about Borg UI, so they were dropped.
https://borgui.com/ is probably Borg UI's site too, but the page names no repo, so that is unconfirmed.
