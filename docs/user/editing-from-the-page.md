---
title: Editing from the page
parent: User guide
nav_order: 7
---

# Editing from the page

`X_BACKUPS_CONFIG_MODE` (the NixOS module's `configMode`) decides whether the page may change the config:

| Mode          | The page                                                                        |
| :------------ | :------------------------------------------------------------------------------ |
| `declarative` | shows everything from `X_BACKUPS_CONFIG` read-only. The default.                |
| `mixed`       | keeps what the file declares locked, and may add hosts, repositories, sources and jobs, and set the defaults the file leaves open |
| `page`        | the same, with `X_BACKUPS_CONFIG` optional                                       |

In `mixed` and `page` modes an admin adds, changes and removes entities in Settings: picking a job's sources and
repositories from lists, and writing its tasks with presets and their meaning in words. Each field is checked as you
save, with the message beside the field. A declared entity shows the same form read-only.

- A save applies at once, without a restart, and is logged as an event.
- An entity another one names cannot be removed. Removing a repository keeps its history.
- A name cannot change once saved, since it names archives and the stored history.
- A passphrase typed on the page is written once into `passphrases/<name>` under `X_BACKUPS_STATE_DIR`, readable
  only by X-Backups, and never sent back to the page.
- The page keeps its part in `config.json` under `X_BACKUPS_STATE_DIR`.

A declared host, repository, source or job replaces a page one of the same kind and name, and a declared default wins
over a saved one. Settings tags each default declared, saved or default. To move a page-managed entity into the
declared config, press **Show as Nix** or **Show as JSON** on its form and copy that into the NixOS module or the
file; once declared it shadows the page copy, which can then be deleted.

{: .warning }
Anyone who can sign in to a page that edits the config can make X-Backups run commands as its user and as each agent's
user, through fields such as `rsh`, `borg_bin` and `passphrase_command`. Grant the admin role accordingly.
