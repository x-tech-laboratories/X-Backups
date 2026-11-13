---
title: Borg 2
parent: User guide
nav_order: 10
---

# Borg 2

A repository with `borg_version: 2` is driven with borg 2, which the flake packages as `borg2` (`packages.borg2`, the
2.0 beta) so it sits beside borg 1. Its host runs `borg2` unless `borg_bin` says otherwise, and its repository server
needs borg 2 for `borg serve` too. On NixOS, set `borg2 = true` on the agent to put it on the agent's `PATH`.

Borg 2 cannot open a borg 1 repository, so each repository keeps the version it was made with until
`borg2 transfer --from-borg1` copies it into a new one.

- Borg 2 reads `ssh://host/path` as relative to the login folder; an absolute path is `ssh://host//srv/repo`.
- Borg 2 keeps no repository-wide sizes, so its repositories show each archive's size and file count but no
  deduplication figures.
- Borg 2 has one `--keep` for both `keep_within` and `keep_last`, so set only one of them.
