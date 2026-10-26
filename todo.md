# X-Backups

A web platform for managing borg backups, taking over the borg functionality now in X-Monitor.
X-Monitor keeps only the job of watching X-Backups itself.

## Goals

## Scope

## Moving out of X-Monitor

The borg plugin's logic is ported to `server/borg/` (polling, restore canary, check freshness, browse,
restore, diff and every repository action). Still to do:

- [ ] Remove the borg plugin from X-Monitor once X-Backups runs the same repositories, leaving X-Monitor
      to watch X-Backups itself.
- [ ] Rename the X-Monitor leftovers in `server/borg/` once X-Monitor no longer runs borg: the
      `__XMONITOR_*` and `__x_monitor_*` shell markers, the `/var/cache/x-monitor-borg` cache folder,
      the `$HOME/.cache/x_monitor/jobs` job folder, `--who=X-Monitor` on `systemd-inhibit`, and the
      "X-Monitor" wording in the failure hints.
- [ ] Port Cancel for a running job (X-Monitor's `JobsGateway.cancel`), which was outside the plugin.

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

## Open questions

## Tasks

Making the ported borg code run for real:

- [ ] A command runner that executes a repository's commands on its host over SSH, and locally for a
      repository on this machine.
- [ ] Storage for metrics, statuses, events and jobs, replacing the in-memory stores the tests use.
- [ ] A scheduler that runs each repository's poll on its interval, polls running jobs more often, and
      follows detached actions (Verify Restore, Diff) to their end.
- [ ] Loading repository configs, in the same fields `BorgConfig` takes.
- [ ] API routes for repositories, their actions and their jobs.
- [ ] The web page: status cards, the archives table with its diff, restore and delete actions, the
      archive browser (the NiceGUI page was not ported, only its row building in `browser_rows`), the
      jobs panel and events.
- [ ] A GitHub Actions workflow running the build, tests and lint.
