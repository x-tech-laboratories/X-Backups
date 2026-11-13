---
title: App reviews
nav_order: 6
has_children: true
permalink: /app-reviews/
---

# App reviews

The other borg tools X-Backups was compared with, to decide what to build and how to lay out the page. Each was
reviewed from its online docs on 2026-10-26, one page per app below; their frontends were then read in source for
layout. Reading the rest of their source is on the [roadmap](../roadmap.html#research). Release dates lack a year on
the release pages, so 2026 is assumed.

| App                | Source                                              | Docs / site                                   |
| :----------------- | :-------------------------------------------------- | :-------------------------------------------- |
| Borg UI            | <https://github.com/karanhudia/borg-ui>             | <https://docs.borgui.com/>                    |
| Borg Backup Server | <https://github.com/marcpope/borgbackupserver>      | <https://www.borgbackupserver.com/>           |
| borgmatic          | <https://github.com/borgmatic-collective/borgmatic> | <https://torsion.org/borgmatic/>              |
| Borgitory          | <https://github.com/mlapaglia/Borgitory>            | <https://borgitory.com/en/latest/>            |
| BorgWarehouse      | <https://github.com/Ravinou/borgwarehouse>          | <https://borgwarehouse.com/>                  |
| Vorta              | <https://github.com/borgbase/vorta>                 | <https://vorta.borgbase.com/>                 |
| BorgWeb            | <https://github.com/borgbackup/borgweb>             | <https://borgweb.readthedocs.io/en/stable/>   |

## In short

- **Borg UI** (Python backend and JS frontend, AGPL-3.0, about 1.7k stars, 2.4.3 on 26 Oct). Reaches repositories
  locally, over SSH, through its own agents and rclone. Cron backup plans chaining prune, compact and check; Apprise
  notifications; restore checks by canary, probe paths or full archive; staleness warning at 14 days and critical at
  30; Prometheus `/metrics` behind a token; roles, OIDC and proxy-header login; an observe-only import of existing
  repositories. No history charts of its own, only example Grafana dashboards.
- **Borg Backup Server** (PHP with MySQL and ClickHouse, Python agents polling over HTTPS, MIT, 387 stars, v2.99.7 on
  26 Oct). Clients push into append-only `borg serve` repositories. Stat cards, a 24-hour jobs chart, a 7-day activity
  chart, storage per client and upcoming backups; a queue with cancel and retry; a completed-with-warnings job state; 12
  notification events with deduplicated failure alerts and missed-schedule detection; health per component, JSON and
  Prometheus metrics, a summary endpoint; TOTP and SSO.
- **borgmatic** (Python CLI, GPL-3.0-or-later, 2.1.10 on 5 Oct). Not a UI. Check types `repository`, `archives`,
  `extract`, `data` and `spot`, each with its own `frequency`, with the last run of each kept under
  `~/.local/state/borgmatic/checks`. The spot check compares source file counts and hashes a sample against the latest
  archive. Monitoring hooks for Healthchecks, Uptime Kuma, ntfy, Loki, Zabbix and others. Ships `borgmatic.service` and
  `borgmatic.timer`.
- **Borgitory** (FastAPI with HTMX, SQLite, APScheduler, MIT, about 194 stars, v3.0.0 on 16 Oct). Runs borg in its own
  container. Cron schedules, retention with prune preview, Apprise, hooks, rclone sync, an archive browser with
  downloads over FUSE, job history with cancel and retry, one login. Its docs mix planned features in.
- **BorgWarehouse** (Next.js, AGPL-3.0, about 681 stars, 3.7.0 on 20 Sep). Manages the storage server clients push to:
  repositories, restricted SSH keys, quotas. Sees only each repository's size and last change, so cannot tell a good
  backup from a failed one. A "no recent backup" alert, SMTP, Apprise and webhooks, OIDC, and a REST API with scoped
  tokens.
- **Vorta** (PyQt desktop app, 0.11.6 on 7 Sep). Repository, Sources, Archives and Schedule tabs; extract by a
  full-path file tree into a chosen folder; mount; prune by hand or after each backup.
- **BorgWeb** (Flask, 0.3.0, apparently stagnant). Lists backup logs and starts a backup; no login.

None of them has X-Backups' size and deduplication history, check freshness, Purge Excluded or host timer views.

## How each app lays out its page

- **Borg UI** (React, MUI): an app bar and a sidebar of about 20 entries in groups, a drawer on phones where tables
  become card lists. A dashboard polled every 30 s with a health banner, a success donut, per-repository health,
  upcoming backups and an activity timeline. Repository cards with 15+ fields and chips. Archive pages with stat tiles
  and deltas against the previous archive. A three-step restore wizard, and a repository wizard that previews the exact
  borg command. One shared SSE stream for jobs. Each setting tagged Customized, From environment or Default.
- **Borg Backup Server** (PHP, Bootstrap): clickable KPI tiles (the errors tile opens the log filtered to errors), a
  24 h stacked jobs-by-type chart, active jobs beside upcoming schedules. One card per maintenance action, saying what
  it does and when to use it. Archive pages with breadcrumbs, a prev/next stepper and a changes table. A queue with
  progress bars and a duration bar against the typical run. A weekly schedule calendar. A stronger confirm with scope
  checkboxes for deleting a repository.
- **Borgitory** (FastAPI, HTMX): a flat 11-item sidebar, no overview, forms on the left and lists on the right. Job
  history as expandable cards with live output per task over SSE. Prune dry run on by default. Lists capped at 10
  archives and 20 jobs, with no paging.
- **BorgWarehouse** (Next.js): repository list with search, sort and an archived filter, collapsible cards with a
  status dot, chips and a storage bar coloured at 75 % and 90 %. A monitoring page with KPI cards, storage per
  repository and a "Needs attention" list. One confirm dialog that names the target and says whether the action can be
  undone. An environment-set setting shown read-only, naming the variable.
- **Vorta** (PyQt): repository actions (Check, Prune, Compact, Mount) kept apart from archive actions (Diff, Extract,
  Rename, Delete). Extract and Diff dialogs with a Tree / Simplified / Flat switch; Diff colours added, modified and
  removed entries and sums a net size per folder.
- **BorgWeb**: a log list beside a paged viewer and one Start Backup button.
- **borgmatic**: no UI. Its config is the source of truth, read through `--json`, its check state files and its
  monitoring hooks. X-Backups follows this model for declared config.

## What they share

1. A shell that stays put: a header with the user menu and theme toggle, and a sidebar that becomes a drawer on
   phones.
2. An overview built from KPI tiles, a needs-attention list, a jobs chart and upcoming runs.
3. Repository cards with a status colour, the last backup's age, the size, and chips for special states.
4. A jobs or queue page with filters, progress, cancel and retry.
5. An archive page with changes against the previous archive, and a file tree that restores to a chosen destination.
6. Destructive actions confirmed in a dialog that names the target and the consequence.
7. Prune previewed as a dry run first.
8. Live job output, pushed over SSE or polled.
9. Light, dark and system themes.
10. Settings as sections of label, help and control.

Weak spots nearly all of them share, which X-Backups avoids: native `confirm()` mixed with custom dialogs, status shown
by colour alone, icon-only buttons, modals with no focus trap, no `aria-live` on polled tables, lists cut off at a
fixed count, polling that swallows its errors, and no global search.

## Configuration from the page

None of the apps both reads declarative config and lets the page edit it. Borg UI tags each setting with where its
value came from, and BorgWarehouse shows an environment-set value read-only. Outside borg, Grafana's provisioned
dashboards and Home Assistant's YAML entities set the pattern X-Backups follows: what is declared is locked on the
page, and the page may add the rest.
