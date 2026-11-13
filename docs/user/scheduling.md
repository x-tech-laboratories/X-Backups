---
title: Scheduling
parent: User guide
nav_order: 4
---

# Scheduling

X-Backups starts every backup itself, on the agent of each target's host; it needs no systemd timer.

A job has the tasks `backup`, `prune` (when it has a `keep_*` policy), `check` and `canary` (when it has a
`canary_path`). A repository has `compact` and `check`. Each is written under `tasks`, as a schedule or as an object:

```json
"jobs": [{
  "name": "nightly", "sources": ["fileserver-data"], "repositories": ["offsite"], "keep_daily": 7,
  "tasks": { "backup": "daily 02:00", "prune": { "after": "backup" }, "check": { "schedule": "weekly sun 04:00" } }
}],
"repositories": [{ "name": "offsite", "...": "...", "tasks": { "compact": { "schedule": "monthly", "after": "backup" } } }]
```

## Writing a schedule

A schedule is one of:

- a duration, `30m`, `6h`, `1d`, `1h30m` or a number of seconds, counted from the start of the task's last run;
- `hourly`, `daily`, `weekly` (Monday) or `monthly` (the 1st), at 00:00 or on the hour;
- `daily HH:MM`, or `weekly <weekday> HH:MM` such as `weekly sun 03:00`;
- a five-field cron line, `minute hour day-of-month month day-of-week`, with `*`, lists, ranges, `/step` and names,
  such as `30 2 * * mon-fri`. With both day fields set, either matching is due.

Calendar forms read the server's own time zone, or `X_BACKUPS_TIMEZONE` (an IANA name such as `Europe/Berlin`). A
time the clocks skip runs as far past the jump as it was into the gap, and a time they repeat runs once. Each start is
put off by up to a minute, the same for a task each time.

The config form on the page describes a schedule in words with its next three times while you type it.

## Task objects

An object takes:

- `schedule`;
- `enabled`, true whenever it has a schedule or `after`;
- `after: "backup"` on a prune or compact. A job's prune runs right after each successful backup of the same target,
  and a repository's compact once the backups and prunes due on it have finished.

A check takes `kind`:

| Owner      | Kind         | Runs                                                              |
| :--------- | :----------- | :---------------------------------------------------------------- |
| job        | `archives`   | `borg check --archives-only`, limited to the job's own archives   |
| job        | `extract`    | a dry-run extract of its newest archive                           |
| repository | `repository` | `--repository-only`, the default where a job writes               |
| repository | `all`        | the whole check, the default where no job writes                  |
| repository | `data`       | `--verify-data`, the default with `check_verify_data`             |

`check` may also be a list, one object per kind, each with its own schedule, such as a weekly `all` and a monthly
`data`:

```json
"tasks": { "check": [{ "kind": "all", "schedule": "weekly sun 13:00" }, { "kind": "data", "schedule": "0 13 9 * *" }] }
```

## Defaults

Left out, a task still has defaults. Where a job's backup is scheduled, the checks of that job and of the
repositories it writes to run every half of their `check_kinds` age, so they land well before going stale, and the
canary runs every `canary_interval` (a day unless set). A repository filled by a host's own timer keeps its checks to
that host. `prune_after_backup` and `compact_after_backup` still work, as a prune and a compact `after: "backup"`.

A task with no schedule runs only when started by hand. A scheduled prune needs no `allow_delete`, which guards only
the Prune button.

## When a task runs

- When a task is due comes from its last run on each target, or the last action of the same kind started by hand, so a
  restart picks up where it left off.
- A task never run on a duration is due at once, and one never run on a calendar form at its first time after
  X-Backups first saw it, so checks taken over from another tool keep their days.
- One run goes at a time on a repository, and on one job's targets from one host; the rest queue.
- A task whose host's agent is away waits, and runs once when the agent connects however many times it fell due
  meanwhile.
- A start that is refused or skipped, such as by `skip_while_active`, tries again after ten minutes.

## Run now, enable and disable

The Jobs page and each repository's Schedule tab list every task with its schedule in words, whether it is enabled,
when it is next due, its last run and why it waits. An operator can **Run now**, and switch a task on or off; the
switch is kept over the declared config, and the page says when it differs. A repository's task also needs an admin or
a user who sees every job writing there.

Host timers are still read for repositories no job writes to, such as one a host's own borgmatic fills, and shown on
the Schedules page beside the tasks.
