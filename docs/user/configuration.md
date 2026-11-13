---
title: Configuration
parent: User guide
nav_order: 3
---

# Configuration

The config is a JSON file named by `X_BACKUPS_CONFIG`, which the NixOS module writes from `services.x-backups`. It
holds `hosts`, `repositories`, `sources` and `jobs`, as `config.example.json` in the repository shows. The same
entities can be added from the page; see [Editing from the page](editing-from-the-page.html).

## Hosts

A host is `managed` (it runs the agent) or `storage-only` (it only holds repositories).

- `address` is its network name, shown on the page. The one managed host with no `address` is the server itself, run
  by the agent built into it.
- `agent_public_key` is the OpenSSH `ssh-ed25519` line of the key its agent signs in with; see [Agents](agents.html).
- `ssh_key` and `rsh` set the SSH borg itself uses for an `ssh://` repository.
- `require_sudo` runs borg as root through `sudo -n`; `borg_bin` names the borg program; `cache_dir` is borg's cache
  folder.
- `job_nice`, `job_io_idle` and `job_lock` set how politely runs share the host, `skip_when_unreachable` and
  `skip_while_active` when a run is skipped, and `inhibit_sleep` keeps the host awake through `systemd-inhibit` where
  the host has it.

## Repositories

A repository sits on a host, with its `repo` URL, passphrase, `quota`, `borg_version`, checks and safety switches.

- `repo_by_host` gives a client host its own URL for the repository.
- `poll_via` names the managed host that polls a repository no job writes to.
- A `repo` that is a plain folder path is a folder on the repository's own host, so every other host that backs up to
  it or polls it needs an `ssh://` URL in `repo_by_host`.
- `allow_delete` shows Prune, Break Lock and archive deletion on the page, and `allow_purge` shows Purge Excluded.
- The passphrase comes from `passphrase_file` or `passphrase_command`; on NixOS put it in `passphraseFile`, which
  systemd loads as a credential. Avoid writing it into the config as `passphrase`.
- `restore_dir` is where restores go unless the restore dialog names another folder.

## Sources

A source is `source_paths` on one managed host, with `exclude`, `exclude_from`, `exclude_caches` and
`exclude_if_present` as borg reads them.

## Jobs

A job backs up `sources` to `repositories`, with:

- retention, as `keep_within`, `keep_last`, `keep_daily`, `keep_weekly` and the rest of borg's `keep_*` options;
- `compression`;
- `archive_prefix`, the job's name by default;
- freshness ages (below);
- a restore canary: `canary_path`, a file in a source that Verify Restore restores from the newest archive and compares
  with the live copy;
- `tasks`, when each step runs; see [Scheduling](scheduling.html).

## Defaults and health ages

A top-level `defaults` (the module's `defaults`) sets `interval`, `max_age`, `warn_age`, `check_max_age`,
`check_warn_age`, `canary_max_age`, `canary_warn_age` and `browse_limit` for every repository that does not set its
own.

| Setting           | Meaning                                                              |
| :---------------- | :------------------------------------------------------------------- |
| `interval`        | how often each target is polled, an hour by default                  |
| `max_age`, `warn_age` | the newest archive's age that makes a target critical, or a warning |
| `check_max_age`, `check_warn_age` | the same for the oldest passing check                |
| `canary_max_age`, `canary_warn_age` | the same for when the restore canary last ran      |
| `browse_limit`    | how many entries a folder in the archive browser lists               |

A warning age of 0 is off, as is `canary_max_age` by default. Ages are durations such as `26h` or `8d`.

## Storage

A repository's storage bar on the Overview is drawn against its `quota` (such as `500G` or `2T`) when one is set, and
otherwise against the free space of its filesystem, which each poll reads with `df` for a repository on a local path.
A repository reached over `ssh://` has no free space to read, since its storage host allows only `borg serve`. The bar
turns amber at 75 % and red at 90 %.

## Flat entries

An entry in `repositories` of the older flat shape, holding every field at once with `host` naming its host, still
loads. It expands into a host, a repository, a source and a job of its name, and keeps its name as its target and its
archives' prefix. One with no `host` runs on the server. On NixOS, a flat entry whose `host` is a declared host's name
runs on that host with its key, so a setup of flat entries can declare `hosts` beside them.
