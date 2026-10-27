# Borg UI (karanhudia/borg-ui) - docs review

## Summary
Self-hosted web UI for BorgBackup, AGPL-3.0 (commercial/enterprise option; docs mention a licence activation service at license.borgui.com, with managed agents now a Community feature since 2.4.0). Repo layout implies Python backend (`app/`, alembic, pyproject), JS frontend (`frontend/`), a separate `agent/` (managed agents on remote machines) and `updates-worker/`. Reaches repos locally (container paths), over SSH/SFTP via "Remote Machines", via managed agents, and via rclone (cloud mirrors, Borg 2 rclone repos). Docker-first (amd64/arm64/armv7) plus native Debian/Ubuntu installer. Supports Borg 1.x and 2.0 beta. Maturity: ~1.7k stars, 60 forks, 2,849 commits, 12 open issues; latest release seen 2.4.3 (26 Oct 2026), 2.4.x series within a week, so very active. Default login admin/admin123. borgui.com: fetch returned only the title "Borg UI", so identity unconfirmed from the page itself (docs site links and licence host borgui.com make same project very likely).

## Features
**Dashboard/views/charts**: repository cards with last run and data age, stale flag, schedules, storage at a glance; activity/job views; Grafana example dashboards (overview, jobs) rather than built-in history charts. Index modes per repo (Everything / Archives only / Off).
**Jobs**: backup, restore, restore check, check, prune, compact, package install; live progress and logs; admins can delete job history; pre/post-backup hooks and scripts; per-op timeouts adjustable in UI.
**Scheduling**: per-Backup-Plan cron + timezone, enable/disable; plan can chain prune/compact/check after success; separate schedules for repo checks and restore checks; multi-repo plans.
**Notifications**: Apprise (100+ services, JSON webhook gets machine-readable payload). Events: backup start/success/warning/failure, restore success/failure, check success/failure, schedule failure. Per-service repo scope, Test button. Defaults: failures on.
**Restore/browse**: archive browser, select files/folders, restore to container path (SSHFS for SSH destinations), archive mounting (separate page), server-side restore preview, guided restore. Restore checks: managed canary (default), selected probe paths, full archive; staleness warns at 14d, critical at 30d. Recovery-drill guidance.
**Repo management**: create local/remote repos with encryption, Import Existing (full or observability-only mode), cloud mirrors via rclone (Google Drive/OneDrive OAuth), Borg 2 direct rclone repos, repository wizard, plans linked to repos, SSH key deployment, resync/rebuild index.
**Security/auth**: local users; 3 global roles (viewer/operator/admin); per-repo roles and all-repos role; built-in OIDC; trusted proxy-header auth (with role headers); API tokens (docs say not yet standalone credentials); SECRET_KEY JWT; non-admin path restrictions to LOCAL_MOUNT_POINTS.
**Monitoring/API**: `/metrics` Prometheus (off by default, token via X-Borg-Metrics-Token or Bearer): repo size/archive count/last backup/check/compact timestamps, job totals, last job success/duration/original/dedup size, active jobs; Postman collection in repo; `/api/operations`; BASE_PATH reverse proxy support; Redis or in-memory archive cache.
**Other**: Docker/native install, updates worker, repo-level Redis caching, archive browsing limits, PUID/PGID.

## Features X-Backups lacks
| Feature | Fit | Reason |
|---|---|---|
| Notifications via Apprise (event matrix, per-repo scope, test button) | Out | X-Monitor does alerting; at most expose a webhook/health signal |
| Backup plans + cron scheduler | Out | Declarative NixOS timers already schedule; dashboard already shows them |
| Repo creation / import wizard / SSH key deploy | Out | Repos declared in NixOS module, never edited from UI |
| Observability-only import mode | Fits conceptually | X-Backups is already effectively that |
| Restore-check scheduling with probe paths / full-archive modes | Partial | Canary exists; probe-path or full-extract verify as an on-demand action is a possible small addition |
| Check/restore-check staleness thresholds (14d warn / 30d crit) | Fits | Cheap two-level staleness on existing check freshness |
| Prometheus /metrics (token-protected) | Fits | Read-only, small; complements /api/health for X-Monitor |
| Multi-user roles, per-repo permissions, OIDC, proxy-header auth | Out (maybe proxy-header) | Single-user by design; trusted-header auth is the only cheap one |
| API tokens | Maybe | A read-only token for monitor/scripts is small and fits |
| Mount archive (borg mount) | Maybe | On-demand action; needs FUSE and long-lived process, weigh risk |
| Pre/post hooks, cloud mirrors (rclone), SSHFS restore | Out | Write-side/config features |
| Server-side restore preview, archive browse limits/index cache | Fits | Large-archive browse performance concern for X-Backups too |
| Job history deletion, per-operation timeouts in UI | Maybe | Timeouts as config; history delete low value |
| Grafana example dashboards | Out | Charts already built in |

## Look at in source (later session)
- `app/` (FastAPI-style backend assumed): routers/services for notifications (Apprise payload shape), metrics endpoint, restore-check job + canary verification logic, access control/roles, OIDC and proxy-header auth, archive indexing (index modes, `/api/operations`, history rows), borg command builders and timeouts.
- `agent/` (managed agent protocol), `updates-worker/`.
- `frontend/` for dashboard repo cards, job/progress views, restore wizard.
- `examples/monitoring/` (Prometheus + Grafana dashboards `borg-ui-overview.json`, `borg-ui-jobs.json`) for metric names to copy.
- `Borg_UI_API.postman_collection.json` for API surface; `docs/`, `tests/`, `security/`, `DESIGN.md`, `PRODUCT.md`.

## Sources used
- https://github.com/karanhudia/borg-ui (fetched)
- https://github.com/karanhudia/borg-ui/releases (fetched)
- https://docs.borgui.com/ , /usage-guide , /configuration , /notifications , /METRICS , /access-control , /disaster-recovery (all fetched)
- https://borgui.com/ (fetched but content was only the title; not confirmed)
- Not fetched: /authentication, /security, /cache, /reverse-proxy, mounting page, installation page.
- Star count/release dates come from page extraction; GitHub language breakdown not shown.
