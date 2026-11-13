---
title: Agents
parent: User guide
nav_order: 5
---

# Agents

Each managed host runs the X-Backups agent, which dials out to the server's `/api/agent` WebSocket, so a host needs no
open port and a laptop that sleeps reconnects when it wakes. It runs the commands the server sends, keeps long runs
such as backups going across a dropped connection or its own restart, and samples the host's load, memory and disk.
The server's own machine has an agent built in.

## Enrolling a host with a key

Each host's agent signs in with its own ed25519 key, declared in the server's config, so enrolling a host needs no
step on the page. Make one key per host:

```sh
ssh-keygen -t ed25519 -N "" -C x-backups-agent-<host> -f x-backups-agent-<host>
```

The private file, in OpenSSH format and unencrypted since the agent cannot type a passphrase, goes in the host's
secret store (such as sops) and is the agent's `keyFile`. The `.pub` line is the host's `agent_public_key` in the
server's config:

```nix
# On the server.
services.x-backups.hosts.fileserver = {
  address = "fileserver.example.org";
  agent_public_key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA... x-backups-agent-fileserver";
};

# On fileserver.
services.x-backups-agent = {
  enable = true;
  url = "wss://backups.example.org/api/agent";
  host = "fileserver";
  keyFile = config.sops.secrets.x-backups-agent-key.path;
};
```

`host` must be the host's name in the server's config; it defaults to the lower-case hostname. A host with a declared
key refuses token sign-ins, so a leaked token cannot stand in for it, and its page shows the key's fingerprint.
Changing or removing the key hangs up on its agent.

## Enrolling a host with a token

A host with no declared key signs in with a token instead. An admin presses **Enrol agent** on the host's page, which
shows the token once with the `services.x-backups-agent` options and the variables for a host without NixOS. Put the
token in a file on the host and give the agent `tokenFile` in place of `keyFile`. Issuing a new token hangs up on an
agent using the old one, and the host's page revokes it.

## The connection

The URL must be `wss://`, since repository passphrases travel over it; the agent accepts `ws://` only to the machine it
runs on. Node keeps its own CA list, so the module sets `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt`, and a
server certificate from an internal CA in `security.pki.certificates` is trusted.

The Hosts page shows each agent as built in, connected, offline or never enrolled, with its version, when it was last
seen and its newest health reading.

## What the module sets up

The module runs the agent as the system user `x-backups-agent` (`user`, `group` and `extraGroups` change it), with its
state and `HOME` in `/var/lib/x-backups-agent` and a cache folder in `/var/cache/x-backups-agent`.

- Its `PATH` is `/run/wrappers/bin`, then `path` (such as `"/run/current-system/sw"`), then its own bash, ssh, borg,
  util-linux and core tools, plus borg 2 when `borg2 = true`.
- It may read `/home` and run `sudo`.
- A restart stops only the agent, so its long runs carry on.

## Without NixOS

Run `packages.agent` with these set, and have the service manager stop only the agent's own process, so its long runs
survive a restart:

| Variable                     | What it sets                                         |
| :--------------------------- | :--------------------------------------------------- |
| `X_BACKUPS_AGENT_URL`        | the server's `wss://…/api/agent` URL                 |
| `X_BACKUPS_AGENT_KEY_FILE`   | the private key, or instead:                         |
| `X_BACKUPS_AGENT_TOKEN_FILE` | the token                                            |
| `X_BACKUPS_AGENT_HOST`       | the host's name in the server's config               |
| `X_BACKUPS_AGENT_STATE_DIR`  | where long runs keep their output                    |

## Running borg as root

A host with `require_sudo` runs these as root through `sudo -n`, with borg's environment given as arguments, so the
agent's user needs passwordless rules with `SETENV` for borg:

```sh
sudo -n BORG_PASSPHRASE_FD=0 BORG_RELOCATED_REPO_ACCESS_IS_OK=no BORG_BASE_DIR=<cache_dir> borg <list|info|create|extract|prune|compact|check|delete> ...
sudo -n cat <canary_path>                               # only when the agent cannot read the canary itself
sudo -n find <restore folder> -mindepth 1 -maxdepth 1   # a restore checks the folder is empty
sudo -n mkdir -p <restore folder>
```

The passphrase reaches borg on stdin, never as an argument. Borg may also be given `BORG_PASSCOMMAND` (a
`passphrase_command`), `BORG_RSH` (`ssh_key` or `rsh`) and `BORG_EXIT_CODES=legacy` (borg 2), and `BORG_BASE_DIR` is a
throwaway folder under `/tmp` when the host sets no `cache_dir`. Sudo matches a rule by the file it names, so a rule
for the module's own borg covers it:

```nix
security.sudo.extraRules = [{
  users = [ "x-backups-agent" ];
  commands = [
    { command = "${pkgs.borgbackup}/bin/borg"; options = [ "NOPASSWD" "SETENV" ]; }
    { command = "${pkgs.coreutils}/bin/cat /srv/data/.canary"; options = [ "NOPASSWD" ]; }
  ];
}];
```

Borg 2 needs `${inputs.x-backups.packages.${pkgs.system}.borg2}/bin/borg2` too, and restores need `find` and `mkdir`.

{: .warning }
Borg under sudo with `SETENV` runs whatever `rsh` and `passphrase_command` say as root, so whoever may change the config
may act as root on that host.

## Long runs

A backup, prune, check, compact, restore, delete or purge is a long run, which the agent keeps going on its own while
the server reads its output from where it last stopped. After the server restarts, each run it had going is followed
again once its host's agent connects. While that agent is away the run shows as waiting for it rather than failed, and
a run the agent no longer knows, as when its state folder was wiped, is marked failed as lost.
