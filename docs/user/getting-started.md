---
title: Getting started
parent: User guide
nav_order: 1
---

# Getting started

X-Backups is two programs: the **server**, which holds the config, keeps the history and serves the page, and the
**agent**, which runs on every machine whose files are backed up and runs borg there. The server's own machine needs no
separate agent; one is built in.

## On NixOS

Add the flake as an input and import its modules:

```nix
inputs.x-backups.url = "github:x-tech-laboratories/X-Backups";
```

On the server, `nixosModules.default` runs X-Backups as a service:

```nix
services.x-backups = {
  enable = true;
  passwordHashFile = "/run/secrets/x-backups-password-hash";
  hosts = {
    fileserver.address = "fileserver.example.org";
    storage = { kind = "storage-only"; address = "storage.example.org"; };
  };
  repositories.offsite = {
    host = "storage";
    repo = "ssh://borg@storage.example.org/./fileserver";
    passphraseFile = "/run/secrets/borg-offsite";
  };
  sources.fileserver-data = { host = "fileserver"; source_paths = [ "/srv/data" ]; };
  jobs.nightly = {
    sources = [ "fileserver-data" ];
    repositories = [ "offsite" ];
    keep_daily = 7;
    tasks = { backup = "daily 02:00"; prune.after = "backup"; };
  };
};
```

On every other machine with files to back up, `nixosModules.agent` runs the agent; see [Agents](agents.html) for its
key. Borg on the server reaches an `ssh://` repository through the system's ssh, whose host keys come from
`programs.ssh.knownHosts`.

Put the server behind a reverse proxy with HTTPS: agents connect over `wss://`, since repository passphrases travel
over that connection.

## The admin password

The first user is the admin, who signs in with the password whose hash is in `passwordHashFile`
(`X_BACKUPS_PASSWORD_HASH_FILE` outside NixOS). Write that file with:

```sh
npm run hash-password -- <file>
```

It asks for the password and writes the file readable only by you. The admin is called `admin` unless `adminName`
(`X_BACKUPS_ADMIN_NAME`) says otherwise.

## Without NixOS

Build and start the server with Node 24:

```sh
npm install
npm run build
X_BACKUPS_CONFIG=config.json X_BACKUPS_PASSWORD_HASH_FILE=password.hash npm start
```

`npm start` serves the API and the page together on port 7710. `HOST` and `PORT`, or `--host` and `--port`, change
where it listens; `--help` lists the options. `config.example.json` in the repository is a complete config to start
from. The server needs `borg` and `ssh` on its `PATH` for the built-in agent.

| Variable                       | What it sets                                                     |
| :----------------------------- | :--------------------------------------------------------------- |
| `X_BACKUPS_CONFIG`             | the declared config file                                         |
| `X_BACKUPS_PASSWORD_HASH_FILE` | the admin's password hash                                        |
| `X_BACKUPS_STATE_DIR`          | where the database and page-managed config live, `state/` by default |
| `X_BACKUPS_CONFIG_MODE`        | `declarative`, `mixed` or `page`; see [Editing from the page](editing-from-the-page.html) |
| `X_BACKUPS_TIMEZONE`           | the time zone schedules are read in, the server's own by default |
| `X_BACKUPS_ADMIN_NAME`         | the admin's user name                                            |

Run the agent on other hosts as described in [Agents](agents.html).

## First sign-in

Open the page and sign in as the admin. The Overview shows every target's health as soon as the first polls finish,
and the Hosts page shows which agents have connected. From there, see [Using the page](using-the-page.html).
