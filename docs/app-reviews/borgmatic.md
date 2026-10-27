# borgmatic review (from online docs only)

## Summary
borgmatic is a YAML-configuration-driven CLI wrapper around Borg for servers and workstations (GPL-3.0-or-later). It creates, prunes, compacts and checks backups, dumps databases and snapshots filesystems, and pings monitoring services. It is a CLI only, with no UI or daemon, and is run from a systemd timer or cron. It is mature and actively maintained. The GitHub releases page showed 2.1.10 (05 Oct) as latest, preceded by 2.1.9 (25 Sep), 2.1.8 (18 Sep), 2.1.7 (14 Aug) and 2.1.6 (01 Jun). The year was not shown on the page; the fetch tool did not say. It supports Borg 1.x and 2.x.

## Features by group

### Backup / retention
- `create`, `prune`, `compact` (Borg 1.2+), `transfer`, `recreate`, `delete`, `break-lock`, `export-tar`.
- Retention uses keep_daily/weekly/monthly style options. Multiple repositories per config, "make backups redundant" guide.
- 2.1.10 added per-repository settings (top-level options can be set under each repo).
- `repo-create` (formerly `init`), `key export/import/change-passphrase`.
- Intermittent/removable-drive mode (soft-fail exit 75 in a before hook skips the repo).
- Filesystem snapshots (ZFS, Btrfs, LVM) fed to Borg.

### Consistency checks
- Check types: `repository`, `archives`, `extract` (dry-run extract of latest archive), `data` (implies archives), `spot`.
- Default if checks omitted: repository + archives monthly.
- Per-check `frequency` (number + second/minute/hour/day/week/month=30d/year=365d, default `always`) and `only_run_on` (weekday names, `weekday`, `weekend`). Both are best-effort and only apply when `borgmatic check` runs.
- Last-run timestamps are stored in `~/.local/state/borgmatic/checks` (base dir overridable by `user_state_directory`, `XDG_STATE_HOME` or systemd `STATE_DIRECTORY`). Exact file layout is not in the docs I read.
- `--force` ignores frequency; `--only <check>`; `--repair` (interactive, does not record timestamps as of 2.1.8); `check_repositories` limits repos.
- Spot check: compares file count of the source vs the latest archive (`count_tolerance_percentage`), then hashes a random sample of source files (`data_sample_percentage`) with `xxh64sum` and compares to archive contents (`data_tolerance_percentage` of failures allowed). Only the latest archive. Recommended to run on its own schedule, tune thresholds by repeated runs.
- NOT found in the page: `max_duration`, `check_last`, `match_archives`, in-page (the fetch said they are absent). Do not assume.

### Restore / extract / mount
- `extract`, `mount`/`umount` (FUSE), `list`, `diff`, `restore` (database restore from dumps), `export-tar`.
- 2.1.6 added an experimental `browse` action (console UI to explore backups).
- `--archive latest` shortcut.

### Database hooks
- PostgreSQL, MySQL, MariaDB, MongoDB, SQLite, InfluxDB (2.1.8), OpenLDAP (2.1.8). Dumps are streamed directly into Borg.
- PostgreSQL: format plain/custom/directory/tar, `name: all`, compression, custom pg_dump command, container (docker/podman) support, separate `restore_*` credentials. 2.1.9 added glob patterns for database names.
- Exact in-archive dump path not stated on the pages I read.

### Monitoring / notifications (pinged during create/prune/compact/check)
Integrations: Apprise, Cronitor, Healthchecks, Loki, ntfy, PagerDuty, Pushover, Sentry, Uptime Kuma, Watchgoose (2.1.7), Zabbix. Cronhub was removed in 2.1.7. No Prometheus or generic webhook hook was listed on the monitoring page (I did not find them).
- States are start / finish / fail (and `log` for Healthchecks).
- Healthchecks: `ping_url`, `states`, `send_logs` (default false since 2.1.0), `ping_body_limit` (default 100000), `verify_tls`, `create_slug`. Logs sent as ping body. Verbosity of logs via `monitoring_verbosity`, `list`, `statistics`.
- Uptime Kuma: `push_url` (no query string), `states`, `verify_tls`. Query params added by borgmatic are not documented on the page.
- Loki: `url`, `labels` (placeholders `__config`, `__config_path`, `__hostname`), `send_logs`, mTLS. Payload structure not documented.
- Zabbix: API (`server`, itemid or host+key, token or user/pass); writes a text value (default the state name) to a trapper item; default states `fail` only. Zabbix 7.0+.
- ntfy: topic, server, auth, per-state title/message/priority/tags; default fail only.
- Command hooks: `commands:` list with `before`/`after` at `action`, `repository`, `configuration`, `everything`, plus `error`; `when` actions; `states` finish/fail; variables `configuration_filename`, `repository`, `repository_label`, `log_file`, `error`, `output`. Old names (`before_backup`, `on_error`) deprecated.
- Failure alerts from cron/systemd are also recommended since borgmatic cannot report if it never runs. The docs also suggest third-party monitors consuming borgmatic JSON output.

### Config
- YAML, default `/etc/borgmatic/config.yaml` or `~/.config/borgmatic/config.yaml`; `--config` flag. Multiple files / includes / constants (`{name}` substitution) / env var interpolation / overrides pages exist. (`config.d` was not confirmed on the pages I read.)
- Credential sources: `{credential ...}` syntax with systemd, container secrets, file, KeePassXC, 1Password.
- `borgmatic config generate`, `config validate` (exit 0 when valid, use `--config`), `config show` (JSON, added 2.1.3), `config bootstrap`. Schema is JSON-schema based (page says sample config documents every option); schema file location not confirmed from docs.

### CLI JSON output
- `--json` works with `create`, `diff`, `repo-list`, `repo-info`, `info` (per monitor page); `list` is not named. JSON output goes to console only, not syslog. Structure is Borg's own JSON (docs point to Borg docs). `diff --json` gives one JSON object per changed path.
- `--log-json` (2.1.0) emits borgmatic and Borg logs as JSON, to console and log files.
- `repo-list`/`repo-info` are the names for Borg 2 repo-level listing; for Borg 1.x, `list`/`info` are used (the docs say repo-* is for Borg 2.x).

### Logging
- Verbosity -2..2; separate syslog, console and log-file verbosity; `--log-file`, `--log-file-format`; structured journald fields (MESSAGE, PRIORITY, SYSLOG_IDENTIFIER, SYSLOG_PID) when journal present.

### systemd
- Ships sample `borgmatic.service` and `borgmatic.timer` (copy to /etc/systemd/system). Service includes hardening (e.g. ProtectSystem=strict needs ReadWritePaths for local repos) and disables journal rate limit. Timer schedule not stated on the pages I read. Sample cron in /etc/cron.d/borgmatic.

## Relevance to X-Backups

| Feature | Fit | Reason |
|---|---|---|
| Show check freshness per check type (repository/archives/data/spot) | Fits, if readable | Read-only status; X-Backups already reads freshness from systemd units. Could additionally read `~/.local/state/borgmatic/checks` on the host over SSH (mtime per check) for borgmatic hosts. Verify file layout in source first. |
| Spot check as an on-demand action | Fits | Fits "Verify Restore" family; but needs source files on the host, so it must run as the borgmatic host's own config (`borgmatic check --only spot`), not via borg list alone. Needs execution on host, not just the repo. |
| Spot-check-like server-side check: file count of latest archive vs previous | Fits | Cheap using data X-Backups already has (archive stats); a "count drift" warning copies the count_tolerance idea. |
| Per-check frequency (`frequency` / `only_run_on`) | Partly | A staleness threshold per check type fits (like max_age for backups). The scheduling itself is out of scope (no scheduler; the host's timer does it). |
| Read borgmatic YAML config to auto-discover repositories | Partly | Would reduce NixOS module duplication, but X-Backups config is declarative from Nix; reading hosts' configs adds a second source of truth. Optional import tool at most. |
| `borgmatic config validate` | Out of scope | Validates the host's config; NixOS build already covers it. |
| `borgmatic repo-list/repo-info/list/info --json` | Fits but redundant | X-Backups already uses borg list/info directly; borgmatic adds nothing except Borg-2 naming and config-driven repo lookup. |
| Healthchecks/Uptime Kuma/ntfy/Zabbix/Loki/PagerDuty etc. pings | Out of scope | Alerting is X-Monitor's job. Possible small in-scope variant: X-Backups could be a ping receiver (accept Healthchecks-style `/start`, `/fail`, `/<uuid>` pings or Uptime Kuma push URL) so hosts report run starts/ends; this would give live "backup running" and fail info that polling cannot see. This is a design choice, not a must. |
| Healthchecks-style outgoing ping from X-Backups | Fits narrowly | X-Backups could push its own poll result to an Uptime Kuma push URL, but /api/health already serves the external monitor. Low value. |
| Loki / journald structured logs | Partly | Reading the host's journal for the borgmatic service (SYSLOG_IDENTIFIER=borgmatic) would show last run output and exit status; reading is in scope. Hosts using NixOS services.borgbackup have different unit names. |
| Command hooks before/after | Out of scope | Run on the host by borgmatic; X-Backups does not manage host config. |
| Database dump hooks | Out of scope | Host-side config. In scope only as display: archives containing database dumps (borgmatic stores dumps in the archive; path to be confirmed in source) could be flagged in archive browse. |
| Database `restore` action | Out of scope (for now) | Needs host database access and credentials; X-Backups restore is file-level. |
| `mount` / `browse` | Out of scope | X-Backups has its own archive browse; FUSE mounts on the dashboard host are a poor fit. |
| `--repair` | Out of scope | Dangerous and interactive. |
| `soft failure exit 75` (intermittent repos) | Fits as concept | Map to the "unavailable" status: a host that is off is not "failed". X-Backups already has unavailable. |
| Prune/compact/break-lock/delete | Already present | -- |
| `borgmatic transfer`, `recreate`, `export-tar`, `key export` | Mostly out of scope | Rare operations; `export-tar` could be a download feature but is low priority. |
| Monitoring verbosity, `--log-json` for run output | Fits | If X-Backups runs borg actions detached, parsing `--log-json`-style borg output for progress (borg's own `--log-json`) is a good reuse; this is Borg's feature, borgmatic merely passes it through. |

## Things to look at in the source (later session)
Repo tree (GitHub, `borgmatic/` package) showed: `actions/` (check.py, create.py, prune.py, compact.py, info.py, repo_info.py, repo_list.py, list.py, json.py, restore.py, diff.py, config/), `borg/`, `commands/`, `config/`, `hooks/` (command.py, dispatch.py, `credential/`, `data_source/`, `monitoring/`), `execute.py`, `logger.py`, `signals.py`, `verbosity.py`. Likely candidates:
1. Check timestamps: `borgmatic/borg/check.py` (not confirmed to exist; only the tree top levels were viewed) and `actions/check.py`. Look for the functions that make check time files under the state dir `~/.local/state/borgmatic/checks/<repo-hash>/<check-name>` (assumed layout, verify) and how `frequency` is compared with mtime. Goal: decide if X-Backups can stat these over SSH to show per-check last-run.
2. Spot check: in `actions/check.py` (look for "spot", xxh64sum) to see how the file sample and count comparison are done, and what it logs on pass/fail.
3. `hooks/monitoring/*.py` for exact payloads (Uptime Kuma query params, Loki payload, Zabbix JSON-RPC, healthchecks body) if X-Backups ever acts as a ping receiver or sender.
4. `hooks/data_source/*.py` and `actions/restore.py`, `actions/dump.py` for the in-archive dump path convention (to detect database dumps in archives).
5. `config/schema.yaml` (JSON schema; location assumed, verify) for the YAML option names if reading configs.
6. `actions/json.py` for the combined JSON output shape of multi-repo runs.
7. `logger.py` for journald fields/log-json format.
8. Repo's `sample/systemd/borgmatic.service` and `.timer` (path assumed) for the shipped unit names and schedule, so the "host backup timers" view recognises borgmatic units (`borgmatic.timer`).

## Pages that could not be fully fetched / gaps
- Configuration reference (`reference/configuration/`) was truncated at 100000 chars (last 11654 not read); config.d, schema location and env interpolation unconfirmed.
- `how-to/monitor-your-backups/` and the actions page did not list per-action JSON support beyond what is stated above.
- Healthchecks/Uptime Kuma/Loki payload bodies are not documented on the doc pages (only config keys and states); do not rely on my description of the wire format.
- I did not fetch individual action reference pages (e.g. `reference/command-line/actions/check/`), Cronitor, PagerDuty, Pushover, Sentry, Apprise, Watchgoose, or the other database pages.
- Release year was not shown by the releases page (fetched via a summarising tool, so dates may be unreliable; today is 2026-10-26, consistent with a 2026 Oct release).
- The prompt mentioned Prometheus: no borgmatic Prometheus hook was found on the pages read.

## Sources used
- https://torsion.org/borgmatic/
- https://torsion.org/borgmatic/docs/how-to/deal-with-very-large-backups/
- https://torsion.org/borgmatic/docs/how-to/monitor-your-backups/
- https://torsion.org/borgmatic/how-to/set-up-backups/
- https://torsion.org/borgmatic/how-to/inspect-your-backups/
- https://torsion.org/borgmatic/reference/configuration/
- https://torsion.org/borgmatic/reference/configuration/consistency-checks/
- https://torsion.org/borgmatic/reference/configuration/monitoring/
- https://torsion.org/borgmatic/reference/configuration/monitoring/healthchecks/
- https://torsion.org/borgmatic/reference/configuration/monitoring/uptime-kuma/
- https://torsion.org/borgmatic/reference/configuration/monitoring/loki/
- https://torsion.org/borgmatic/reference/configuration/monitoring/zabbix/
- https://torsion.org/borgmatic/reference/configuration/monitoring/ntfy/
- https://torsion.org/borgmatic/reference/configuration/command-hooks/
- https://torsion.org/borgmatic/reference/configuration/data-sources/
- https://torsion.org/borgmatic/reference/configuration/data-sources/postgresql/
- https://torsion.org/borgmatic/reference/command-line/actions/
- https://torsion.org/borgmatic/reference/command-line/logging/
- https://github.com/borgmatic-collective/borgmatic/releases
- https://github.com/borgmatic-collective/borgmatic/tree/main/borgmatic (and /hooks, /actions)
