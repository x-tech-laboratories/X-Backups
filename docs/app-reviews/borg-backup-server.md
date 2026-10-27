# Borg Backup Server, BBS (marcpope/borgbackupserver) - docs review

## Summary
Self-hosted, MIT-licensed server for managing BorgBackup across many Linux/macOS/Windows endpoints ("a GUI manager for multiple Borg endpoints"). Architecture is agent-based: a stdlib-only Python 3 agent on each endpoint polls the server over HTTPS for tasks and reports progress (no inbound connections to endpoints), while backup data flows over SSH to the server which runs `borg serve` into append-only repos (agents cannot delete/prune; pruning runs server-side). Server is PHP 8.1+ (no framework), MySQL 8, ClickHouse (file catalog), Bootstrap 5 + Chart.js; Apache/certbot installer, Docker, Unraid template. Maturity: 387 stars, 38 forks, 1,954 commits; latest release v2.99.7 (26 Oct 2026), frequent releases (v2.99.1 to .7 in ~10 days); site claims 750+ active servers, 1,500+ endpoints (opt-in telemetry). Optional paid iOS app (BBS Manager, $3.99/mo). Very different model from X-Backups: BBS is the backup *originator/host*, not a read-mostly viewer.

## Features
**Dashboard/views/charts**: stat cards (clients, online/offline agents, active plans/schedules, total repo storage, outdated agents); Jobs (24h) stacked hourly bars; Storage by Client pie; 7-day backup activity chart; Recent Activity (last 10 jobs with status/duration); Next Scheduled Backups (next 5); 30s auto-refresh; light/dark; schedule timeline (weekly, day view); agent/Borg version table with update badges; per-client permission matrix.
**Jobs**: queue with concurrency limits, cancel and retry, live progress (rate, files processed) and output; dry-run results; "completed with warnings" state; maintenance: check, compact, repair, hard unlock, re-catalog.
**Scheduling**: backup plans per client (multiple), hourly/daily/weekly/monthly, weekly days/monthly dates, timezone; templates for server roles; retention per plan (hourly..yearly prune); pause/resume; manual trigger; missed-schedule detection. Scheduler is `scheduler.php`.
**Notifications**: 12 event types (backup completed/failed, restore completed/failed, client offline/online, check failed, compact done, storage low at 90% default, S3 sync failed/done, missed schedule). Channels: in-app bell + page, Apprise push (per-service event subscription, test button), email to admins (SMTP), nightly email reports. Failure/warning dedup (alert on first occurrence, count increments); resolved ones purged after 30d. ntfy HTTPS/token option.
**Restore/browse**: ClickHouse catalog gives fast file-tree browse and cross-recovery-point filename search without locking the repo; restore to source machine, download as tar.gz; DB restore as copy or replacement; recovery points can be locked against prune; read-only copy repos from offsite sync.
**Repo management**: create local or remote-SSH repos, rename/delete, storage locations with capacity reporting, wizards for BorgBase/Hetzner/rsync.net; S3 offsite sync via rclone (attach/run/restore); passphrases encrypted at rest AES-256-GCM.
**Security/auth**: local accounts, TOTP 2FA + recovery codes, SSO, admin/read-only roles, per-client per-action permissions; append-only repos; admin API tokens with "Display Secrets" capability; secrets withheld from API by default.
**Monitoring/API**: REST `/api/v1` (clients, repos, plans, jobs/queue, plugins, storage, catalog, users, settings, summary); `GET /health` unauthenticated liveness; `/api/v1/health` per-component checks (db, scheduler, storage, catalog, clients, backups, maintenance; 503 only on critical); `/api/v1/metrics` JSON and `/metrics` Prometheus (off by default; CIDR allow-list, read-only monitoring tokens, rate limits, trusted proxies); alert examples for overdue backups (`last_success_ts`), failures, offsite lag, scheduler/queue problems; server-stats endpoint.
**Other**: DB plugins (MySQL/MariaDB/PostgreSQL/MongoDB pre-dumps, optional streaming into archive) and shell hooks; client profiles; one-click server/agent/Borg upgrades; server self-backup; native Windows borg.exe; iOS push app; CLI (`bbs-token`, CLI reference page).

## Features X-Backups lacks
| Feature | Fit | Reason |
|---|---|---|
| Agent architecture / append-only server repos | Out | X-Backups polls existing repos over SSH; different model |
| Backup plans, scheduler, retention editor, queue with concurrency | Out | Declarative NixOS timers and policy |
| Repo/client creation, storage wizards, SSH host mgmt | Out | Declared in NixOS module |
| DB plugins, hooks, S3/rclone offsite sync | Out | Write-side features |
| Notifications (Apprise, email, in-app bell, dedup, 12 events) | Out | X-Monitor alerts; dashboard could feed it via /api/health |
| Per-component `/api/v1/health` with ok/warning/critical | Fits | Extend /api/health with typed checks (poller, per-repo staleness, canary, check freshness) |
| Prometheus `/metrics` with token/CIDR/rate limits | Fits | Small read-only addition; useful for X-Monitor |
| JSON summary endpoint (all clients, plans, last result) | Fits | One read-only endpoint |
| Jobs (24h) hourly chart, 7-day activity, next scheduled backups | Fits | Next scheduled already via list-timers; 24h/7d job activity from events log is cheap |
| Storage-by-client pie, stat cards | Fits partly | Fleet totals exist; per-repo breakdown chart is cheap |
| Missed-schedule detection | Fits | Compare timers with last archive; staleness rule already close |
| Storage-low alert | Maybe | Needs repo host capacity; belongs to X-Monitor |
| Archive catalog (ClickHouse) with cross-archive filename search | Out (heavy) | Needs indexing DB; could do on-demand search via `borg list` instead |
| Lock recovery point against prune | Maybe | Needs borg tag/protect (Borg 2) or external bookkeeping; mutating |
| Download archive as tar.gz | Maybe | Via `borg export-tar` streamed; on-demand fits, large-transfer caveat |
| Multi-user, SSO, 2FA, per-client permissions | Out | Single password by design (2FA maybe) |
| Monitoring tokens / CIDR allow-list on metrics | Fits | If /metrics added |
| Job warning state ("completed with warnings") | Fits | Borg exit code 1 handling in job results |
| Self-backup, upgrades, iOS app | Out | Unrelated |

## Look at in source (later session)
- `src/` (PHP app: controllers, services, API v1 routes) - find health check implementation, metrics export (JSON + Prometheus), notification dedup logic, Apprise integration.
- `scheduler.php` - scheduler/queue loop, missed-schedule detection.
- `schema.sql`, `schema-clickhouse.sql`, `migrations/` - data model for jobs, repos, stats, notifications, catalog.
- `agent/` - Python agent (task protocol, borg invocation, progress parsing from `--log-json`).
- `public/` (frontend assets, dashboard Chart.js widgets), `config/`, `bin/` (`bbs-token`), `docker/agent/`, `unraid/`.
- `CLAUDE.md` and `CONTRIBUTING.md` for architecture notes.

## Sources used
- https://github.com/marcpope/borgbackupserver (fetched)
- https://github.com/marcpope/borgbackupserver/releases (fetched)
- https://www.borgbackupserver.com/ (fetched)
- https://github.com/marcpope/borgbackupserver/wiki (index), /wiki/Notifications, /wiki/API (first 100k of 131k chars read), /wiki/Dashboard (all fetched)
- Not fetched: wiki pages on Backup Plans, Restoring Files, Security, Queue and Jobs, Settings; API page tail (characters beyond 100000). GitHub language breakdown not shown on the page.
