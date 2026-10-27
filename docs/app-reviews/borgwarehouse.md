# BorgWarehouse review (docs only)

## Summary
BorgWarehouse (Ravinou/borgwarehouse, AGPL-3.0, author Benjamin "Raven" Sourisse) is a web UI for running a central Borg repository SERVER: it provisions repos, SSH keys (restricted to borg serve), quotas and storage for clients that push to it. It does not run, start or see client backups and never handles passphrases; it only sees the last-modified time and size of repos, so it cannot tell success from failure. TypeScript/Next.js (pages router) app, pnpm, Vitest, SQLite (better-auth), shipped as one Docker image or a Debian install; a cron job calls its API to refresh status/storage. Maturity: ~681 stars, 38 forks, 1054 commits; latest release 3.7.0 (20 Sep, year not shown), v3.6.0 added compact/break-lock/archive; actively developed with versioned releases.

## Features
**Dashboard/views/charts**: repo list with status (healthy/down), Monitoring menu with usage statistics (docs page is a stub with a screenshot only; contents not described), search/sort/filter, custom repo icons, light/dark, responsive, mobile page.
**Jobs**: none for backups (explicitly cannot start them). Server-side maintenance only: compact (concurrent-safe, 409 if running), break-lock, archive/unarchive (revoke SSH, pause alerts, read-only); none need the passphrase.
**Scheduling**: none internal; external cron/Supercronic hits `/api/v1/cron/status` and `/cron/storage` (protected by CRONJOB_KEY); example in `crontab.example`.
**Notifications/alerts**: "no recent backup" alert per repo with configurable max interval and per-repo disable; email via SMTP, Apprise (100+ services), webhooks with optional secret header.
**Restore/browse**: none server-side (client-side setup wizard has ready commands; Vorta and Pika client guides).
**Repo management**: add/edit/delete via UI or API; alias, client SSH public key (unique), storage quota in GB, comment, LAN vs WAN command variants, append-only mode, deletion protection (`DISABLE_DELETE_REPO`), per-repo storage target (SSHFS/NFS/SMB/disk/rclone via `STORAGE_TARGETS`, live reachability test), import of old repos, onboarding setup wizard.
**Security/auth**: local accounts, OAuth/OIDC (GitHub, Google, Microsoft, GitLab, generic), SSO-only mode, account linking, first-run /setup (no default creds), configurable session lifetime, session-revocation script, admin password reset.
**Monitoring/API/integrations**: versioned idempotent REST API v1 (repos CRUD, compact, break-lock, archive, version, cron endpoints), Bearer tokens made in Account > Integrations with create/read/update/delete permissions, `DISABLE_INTEGRATIONS` switch.
**Other**: Docker PUID/PGID, one-line install script, docs for FAQ, Docker/Debian install, env vars, security hardening.

## Features X-Backups lacks
| Feature | Fit | Reason |
|---|---|---|
| Email/Apprise/webhook notifications | Out of scope | X-Monitor does alerting. |
| "No recent backup" alert threshold per repo | Already covered | X-Backups has max_age staleness; surface a per-repo override only if declared in Nix. |
| Repo creation, SSH key, quota provisioning | Out of scope | Declarative NixOS; a different job (server side provisioning). |
| Append-only mode | Out of scope to set; Fits to display | Show as a read-only badge if declared. |
| Archive (freeze) repo / pause monitoring | Fits, maybe | A declared "retired/paused" flag that silences staleness would suit; note it is declarative. |
| OIDC/SSO, multiple users, session revoke | Out of scope (OIDC maybe later) | Single password is a stated choice. |
| API tokens with scoped permissions | Fits (read-only token) | Lets X-Monitor or scripts read status beyond /api/health. |
| Storage-target reachability test | Fits | Read-only health signal akin to unavailable status. |
| Storage quota / usage per repo | Fits | Display-only; quota would come from config. |
| Per-client setup wizard / copy-paste commands | Maybe | Read-only generated borg command snippets per repo; low priority. |
| Cron endpoints for external schedulers | Out of scope | X-Backups already polls itself. |
| Comment/notes and icon per repo | Fits (minor) | Free metadata from the Nix declaration. |

X-Backups is a different category: BorgWarehouse is the server-provisioning side, X-Backups the client/ops-side. Its compact/break-lock/archive are the only overlap.

## Source code to look at later (repo tree only, not read)
- `pages/api/v1/` and `pages/api/` route handlers (repositories, cron/status, cron/storage, compact, break-lock, archive); `services/` (business logic: status check, alert logic); `helpers/` and `lib/` (borg/SSH, storage, authorized_keys writing); `scripts/` and `docker/` (entrypoint, sshd config, install.sh); `config/`; `Components/` and `Containers/` (repo list, monitoring view); `contexts/`, `hooks/`; `tests/`; `instrumentation.ts`; `.env.sample`; `crontab.example`.
- Specific: how the alert threshold and "status" are computed from repo mtime, how storage usage is aggregated for the Monitoring page, how the API token permission model is implemented, how archive mode revokes access.

## Sources used
- https://github.com/Ravinou/borgwarehouse (README, tree, stars)
- https://github.com/Ravinou/borgwarehouse/releases (3.7.0 and prior dates)
- https://borgwarehouse.com/
- https://borgwarehouse.com/docs/prologue/introduction/
- https://borgwarehouse.com/docs/admin-manual/release-notes/
- https://borgwarehouse.com/docs/user-manual/repositories/
- https://borgwarehouse.com/docs/user-manual/monitoring/ (stub)
- https://borgwarehouse.com/docs/developer-manual/api/
## Not fetched
- Account, security, env-vars, external-storage, SMTP, Apprise, OAuth, FAQ pages. No screenshots seen beyond names. Release years not shown. The architecture details (Next.js, SQLite) are inferred from the file tree and release notes, not stated in docs.
