# Borgitory review (docs only)

## Summary
Borgitory (mlapaglia/Borgitory, MIT) is a web UI for BorgBackup with scheduling, monitoring and cloud sync. Python FastAPI backend, HTMX + Alpine.js + Tailwind frontend, SQLite via SQLAlchemy/Alembic, APScheduler for cron. It runs borg and rclone as local subprocesses inside its own container (Docker image bundles borgbackup, rclone, fuse3) or from PyPI (`pip install borgitory`, Python 3.14+). The docs describe local or remote repositories but do not explain how remote ones are reached (SSH mechanics not documented). Maturity: GitHub ~194 stars, 6 forks, 163 commits, 11 open issues. Latest stable seen: v3.0.0 "16 Oct" (year not shown; Apprise notification switch, multi-directory backups), plus v3.1.0-alpha1 same day; earlier v2.8.0 (6 Aug). Several docs pages are stubs ("Coming Soon"), and the Features page mixes shipped and planned items, so treat claims there with caution.

## Features
**Dashboard/views/charts**: repo statistics and health, job history (searchable/filterable, duration metrics, export), live progress (file-by-file, rate, ETA) over Server-Sent Events. No history charts of dedup/size are documented. "Customizable dashboards", PWA support: listed, unverified. "Backup deduplication analysis" and "advanced reporting" are on the planned list.
**Jobs**: manual backup (compression lz4/zlib/lzma/zstd, include/exclude patterns, custom archive names), prune, cloud sync; job manager with queue, concurrent jobs, per-task tracking, cancel, retry, expandable output; job hooks (pre/post commands, "critical" flag, "run even if job failed", 5 min default timeout, env vars with repo id/job type).
**Scheduling**: cron expressions, multiple schedules per repo, enable/disable, timezone aware, conflict detection, per-schedule compression/sources/prune/notifications/hooks.
**Notifications**: Pushover (v2) then Apprise (v3.0.0, breaking migration); triggers on completion/failure/success, per-schedule settings; quiet hours and escalation claimed.
**Restore/browse**: archive browser via FUSE mount (needs SYS_ADMIN + /dev/fuse in Docker, optional), breadcrumb navigation, file metadata, streamed single-file downloads, archive listing/info/delete, diff listed. No in-place restore to a target path documented.
**Repo management**: add repos with encrypted (Fernet) stored passphrase, connection test, auto-discovery, per-repo settings; retention policy simple (keep X days) or advanced (daily/weekly/monthly/yearly), prune dry-run preview with space-savings.
**Security/auth**: username/password, bcrypt, session cookie, CSRF, account lockout, first-run admin setup. Single-user today; RBAC, API keys, OAuth, audit logging, rate limiting all planned.
**Monitoring/API/integrations**: REST API (OpenAPI at /docs, ReDoc /redoc) using the browser session cookie; endpoints for repos, backups/archives, schedules, jobs (cancel/retry/logs/SSE), cloud sync. Health checks and structured JSON logs claimed; Prometheus metrics planned. Monitoring how-to page is an empty stub.
**Other**: rclone cloud sync after backup (S3, GCS, Azure, B2, Wasabi, Spaces, pCloud), bandwidth limiting, retries; in-app package manager for hook tools; Windows via WSL2.

## Features X-Backups lacks
| Feature | Fit | Reason |
|---|---|---|
| Cron scheduler for backups/prune | Out of scope | Systemd timers on hosts already do it; X-Backups only displays them. |
| Notifications (Pushover/Apprise) | Out of scope | X-Monitor does alerting. |
| Pre/post job hooks | Out of scope | Declared on the host (NixOS), not in the UI. |
| Repo creation / editing in UI, stored passphrases | Out of scope | Repos are declarative NixOS config; avoids storing secrets. |
| Cloud sync (rclone) | Out of scope | Not a borg feature; host-side concern. |
| Retention policy editor (daily/weekly/...) | Out of scope | Declared in NixOS; X-Backups has Prune Preview/Prune already. |
| Multi-user / RBAC | Out of scope | Stated non-goal; also unfinished in Borgitory. |
| API keys / token auth | Maybe | Cheap read-only token for X-Monitor beyond /api/health; Borgitory only plans it. |
| Job history search/filter/export | Fits | Events log could gain filtering and CSV/JSON export. |
| Job retry button | Fits | Small addition for on-demand actions. |
| Job queue / conflict detection between schedule and manual job | Fits (partly) | Guarding against concurrent jobs on the same repo is relevant to detached jobs. |
| Download single file from archive | Fits | Read-mostly browse feature; verify X-Backups has it (it has browse/restore). |
| Prometheus metrics endpoint | Fits | Read-only; Borgitory only plans it, but it suits X-Monitor integration. |
| Per-task job timeline (completed/failed/skipped) | Fits | Useful for multi-step jobs like Verify Restore. |

X-Backups already exceeds Borgitory on: history charts, fleet totals, restore canary, check freshness, break lock, compact, purge, diff.

## Source code to look at later
- `src/borgitory/services/` : BorgService (command construction/exec), JobService/JobManager (queue, SSE progress, cancel, retry), SchedulerService (APScheduler), NotificationService, RecoveryService (recovery of interrupted jobs; worth checking), CloudSyncService.
- `src/borgitory/api/` route modules; `src/borgitory/models/`; `src/borgitory/templates/` (HTMX partials for job output and archive browser); `src/borgitory/utils/` (security/validation, Fernet).
- `dependencies.py` (job manager singleton pattern), `cli.py`, `config.py`, `tests/`.
- Specifically: how FUSE-mounted browsing cleans up mounts, how hooks get env and timeouts, how prune preview is parsed.

## Sources used
- https://github.com/mlapaglia/Borgitory (README, file tree, stars)
- https://github.com/mlapaglia/Borgitory/releases
- https://borgitory.com/ , /en/latest/features.html , /architecture.html , /api.html , /how-to/job-hooks-system.html , /how-to/monitoring-backup-health.html (stub)
## Not fetched
- Reddit thread (fetch blocked: "unable to fetch from www.reddit.com"); no announcement/comments reviewed.
- borgitory.com changelog, usage guide, security pages, Pushover how-to: not fetched. No screenshots described in any fetched page. Release year not shown by the fetcher.
