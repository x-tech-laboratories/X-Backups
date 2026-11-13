---
title: Using the page
parent: User guide
nav_order: 6
---

# Using the page

The sidebar holds Overview, Hosts, Repositories, Sources, Jobs, Runs, Schedules, Events and Users, with your account,
the theme and Settings at its foot. Each entity's page links to the others it names. The header searches repositories
and archives by name and shows the runs in progress. The page updates live; when the live connection drops it says
so and refreshes every 15 seconds until it is back.

## Overview

- Tiles that open filtered views, such as the failing targets.
- A needs-attention list, one reason per line, such as "last backup 3 d ago, limit 1 d", with hosts whose agent is
  away and tasks that wait.
- Runs by outcome over the last 24 hours and 7 days, the runs going now, and the next task and timer runs.
- Total stored over time, and each repository's storage bar.
- **The map** draws the backup flow in three columns: each host's folders, the jobs backing them up, and the
  repositories they write to under the hosts storing them. Lines take their target's health, and hovering a box
  follows its folders through to their repositories.

## Hosts

Each host's kind, agent state (built in, connected, offline or never enrolled), version, last seen, health and
counts. A host's page shows its health over time, its sources, the repositories stored there, the targets running
there, its runs and timers. An admin enrols or revokes its agent there; see [Agents](agents.html).

## Repositories

Each target: a job's backups from one host to one repository, or a repository only watched. The list searches, sorts
and filters, and keeps those choices in the URL. A target's page has tabs:

| Tab      | Shows                                                                        |
| :------- | :--------------------------------------------------------------------------- |
| Overview | facts, needs-attention lines, size, compression and deduplication over time, new data per archive, check and canary results |
| Archives | every archive, with Browse, Diff, Restore, Download and Delete               |
| Runs     | this target's runs                                                           |
| Sources  | the paths backed up and the retention policy                                 |
| Schedule | its tasks, with Run now and their switches                                   |
| Events   | its event log                                                                |
| Config   | its settings as written                                                      |

It also names the jobs writing to its repository and the repository's other targets. **Stop watching** takes a
page-managed repository off X-Backups without touching the borg repository; its history stays, and adding it again
under the same name brings that back.

### Actions

Repository actions sit in the page's header, each with a line saying what it does. Those that change the repository
ask first in a dialog naming the target and saying whether it can be undone.

| Action          | Does                                                                          |
| :-------------- | :---------------------------------------------------------------------------- |
| Run Backup      | back up the source paths now                                                  |
| Dry Run         | list what a backup would store, without writing anything                      |
| Verify Restore  | restore the canary file from the newest archive and compare it with the live copy |
| Check           | verify the repository's segments and archive metadata; a data check also reads every chunk |
| Compact         | free the space pruned and deleted archives left behind                        |
| Prune Preview   | list which archives the retention policy would keep and drop, changing nothing |
| Prune           | delete the archives the retention policy drops                                |
| Purge Preview   | list the files the exclude patterns now drop from older archives              |
| Purge Excluded  | rewrite every archive without those files, then compact                       |
| Break Lock      | remove a lock left by a borg process that died, only when nothing is running  |

Prune, archive deletion and Break Lock appear only with `allow_delete`, and the purge actions only with
`allow_purge`. Purge Excluded and a forced Break Lock ask you to type the repository's name. Each action's outcome
arrives as a notice linking to its run.

## Archives

An archive's page has breadcrumbs, a step to the previous and next archive, and the change in files, original size
and unique data against the previous one.

- **Changes** shows the diff against the previous archive, coloured by added, modified and removed, with the net size
  per folder and a switch between a tree and a flat list.
- **Files** is a searchable tree with checkboxes. **Restore picked** restores the selection on the host; **Download
  picked** downloads it, a single file as itself and folders as a gzipped tar.

A restore goes to the folder chosen in the restore dialog, `restore_dir` by default: into a new dated folder inside
it, or the folder itself only when it is empty or missing, so a restore never overwrites files.

A download holds borg's lock, so it is refused while a run is going on that repository. Running downloads are listed
on the repository's Overview with who started them, and can be stopped there.

## Sources and Jobs

A source's page lists its paths, excludes and the jobs using it. A job's page lists its sources and repositories, a
target per host and repository with its newest archive against `max_age`, its tasks with Run now and a switch that
says when it differs from the config, and its runs.

## Runs

Every run across all targets, filtered by target, host, job, task, kind, outcome and period, with the filters in the
URL. Each shows a duration bar against the usual time for its kind and a badge for a run waiting for its host's agent
or lost. A run's page has a result bar, its output (live while it runs), **Cancel** and **Retry**.

## Schedules

The week of each task's next and newest runs beside the host timers, with missed and failed runs marked and a day
switcher on phones, and the tasks and timers as tables.

## Events

Every event across the targets you can see: polls that changed state, runs, config changes. Searchable, filterable
and paged.

## Settings

The defaults, each host, repository, source and job as written, and for admins the Backups section for the
X-Backups database itself (see [Monitoring and integrations](monitoring.html)). Whether entities can be changed here
depends on the config mode; see [Editing from the page](editing-from-the-page.html).
