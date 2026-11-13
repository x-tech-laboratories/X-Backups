---
title: Concepts
parent: User guide
nav_order: 2
---

# Concepts

X-Backups describes your backups with four kinds of thing you write down, and works out two more from them.

## What you describe

- A **host** is one machine. A **managed** host runs the X-Backups agent, which runs borg there. A **storage-only**
  host only holds repositories, reached by `borg serve` over SSH or as a hosted service, and runs no agent.
- A **repository** is a borg repository on a host: its URL, passphrase, quota and borg version, and the tasks that act
  on the whole repository, compact and repository check.
- A **source** is a list of paths, with excludes, on one managed host.
- A **job** backs up one or more sources to one or more repositories, with a retention policy, compression, archive
  naming and freshness limits, and its tasks: backup, prune, archive check and restore canary.

## What X-Backups works out

- A **target** is one job's backups from one host to one repository, named `job:host:repository`. A job with two
  source hosts and two repositories has four targets. Each target has its own health, its own archives and its own
  history. A repository no job writes to, such as one a host's own borgmatic fills, is a target of its own and is
  still watched.
- A **task** is one step of a job or a repository on its own schedule: a job's backup at 02:00, its prune right after,
  the repository's check every Sunday. A **run** is one execution of a task, or of an action you start by hand.

## Archive names

Sources on one host go into one archive named `{prefix}-{host}-{time}`, where the prefix is the job's
`archive_prefix`, its name by default. Prune and freshness read only archives of that name, so two jobs writing to one
repository never prune or judge each other's archives.

Compact and the repository check act on the whole repository, so only one of its targets offers them: the one polled
from the repository's `poll_via` host.

## Health

Every target is **ok**, **warning** or **critical**, with the reasons on its card and in the Overview's
needs-attention list:

- its newest archive is older than `warn_age` (warning) or `max_age` (critical);
- its oldest passing check is older than `check_warn_age` or `check_max_age`;
- its restore canary last ran longer ago than `canary_warn_age` or `canary_max_age`;
- its last poll failed, or its host could not be reached.

A run that finishes with borg's warnings is shown as **warning**, apart from success.
