---
title: X-Backups
description: A web platform for managing borg backups across many hosts.
template: splash
hero:
  tagline: A web platform for managing borg backups across many hosts.
  image: ../resources/icon.svg
  actions:
    - text: Read the user guide
      link: /user/
    - text: See how it is built
      link: /architecture/
      variant: secondary
---

X-Backups watches and runs [borg](https://www.borgbackup.org/) backups for a whole network from one web page. You
describe your machines, the folders to back up, the repositories they go to and when each job runs; X-Backups starts
every backup, prune, check and compact itself on a small agent on each machine, and shows you how fresh, how large and
how healthy every backup is.

---

## What it does

- **One place for every backup.** Hosts, repositories, sources and jobs are declared in the NixOS module or a JSON
  file, or added from the page, and the page shows them all with their health.
- **Runs the backups itself.** Each job's backup, prune, checks and restore canary run on schedules you write as
  `daily 02:00`, `weekly sun 04:00`, `6h` or a cron line, with no systemd timers to keep in step.
- **An agent instead of SSH.** Each managed host runs the X-Backups agent, which dials out to the server, so no host
  needs an open port and a laptop that sleeps catches up when it wakes.
- **History, not just status.** Size, compression and deduplication over time, new data per archive, and check and
  canary results, charted per repository.
- **Restore from the page.** Browse any archive, compare it with the one before, and restore or download files and
  folders.
- **Shared safely.** Viewers, operators and admins, each granted the jobs they may see, with a second factor, single
  sign-on, API tokens, Prometheus metrics and MCP tools for AI clients.
- **Watched from outside.** `/api/health` answers ok, warning or critical, so X-Monitor or any HTTP check alerts when a
  backup goes stale or fails.

## The documentation

| Page                                  | For                                                            |
| :------------------------------------ | :------------------------------------------------------------- |
| [User guide](/user/)                   | Installing X-Backups, describing your backups and using the page |
| [Architecture](/architecture/)     | How X-Backups is built today                                   |
| [Roadmap](/roadmap/)               | What is planned and not built yet                              |
| [Changelog](/changelog/)           | Every change, commit by commit                                 |
| [App reviews](/app-reviews/)           | The other borg tools X-Backups was compared with               |
