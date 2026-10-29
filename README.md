# X-Backups

A web platform for managing borg backups, part of X-Tech Laboratories.

## Layout

- `src/server/` — the Fastify API, written in TypeScript and run directly by Node 24.
- `src/server/borg/` — one borg repository: the shell commands it runs, how their output is read, and its actions.
- `src/server/agents/` — the hub agents connect to, and the agent built in for the server's own machine.
- `src/agent/` — the agent each managed host runs.
- `src/shared/` — the messages the server and its agents exchange.
- `src/web/` — the browser page, built by Vite into `dist/`.

## Development

```sh
nix develop          # or: nix-shell
npm install
npm run hash-password   # asks for the login password, writes password.hash
npm run dev:server   # API on http://127.0.0.1:7710
npm run dev:web      # page on http://localhost:5173, proxying /api to the server
```

## Checks

```sh
npm run build   # type-check both halves and build the page
npm test
npm run lint
```

## Production

```sh
npm run build && npm start
```

`npm start` serves the API and the built page together. `HOST` and `PORT` change where it listens.

The API asks for a login, checked against the hash in the file `X_BACKUPS_PASSWORD_HASH_FILE` names.
`npm run hash-password -- <file>` asks for the password and writes that file, readable only by you.
State is kept in a SQLite file under the folder `X_BACKUPS_STATE_DIR` names, `state/` by default.

`/api/health` stays open, so X-Monitor can poll it without logging in. Its `status` is `ok`,
`warning` or `critical`, the worst of the repositories', each listed with its reasons; it answers
503 when critical, so a plain HTTP check alerts on that without reading the body.

## Config

`X_BACKUPS_CONFIG` names a JSON file of `hosts`, `repositories`, `sources` and `jobs`, as
`config.example.json` shows:

- A **host** is `managed` (it runs the X-Backups agent, which runs its commands; see Agents) or
  `storage-only` (it only holds repositories reached by `borg serve` or a hosted service, and runs
  no agent). `address` is its network name, shown on the page; the one managed host with no
  `address` is this server, run by the agent built into it. A host holds `ssh_key` and `rsh` (the
  SSH borg itself uses for an `ssh://` repository), `require_sudo`, `borg_bin`, `cache_dir` and the
  `job_*`, `skip_*` and `inhibit_sleep` settings. `inhibit_sleep` keeps the host awake through
  `systemd-inhibit` where the host has it, and runs without it where it does not.
- A **repository** sits on a host, with its `repo` URL, passphrase, `quota`, `borg_version`, checks
  and safety switches. `repo_by_host` gives a client host its own URL, and `poll_via` names the
  managed host that polls a repository no job writes to.
- A **source** is `source_paths` and its excludes on one managed host.
- A **job** backs up `sources` to `repositories`, with retention, `compression`, `archive_prefix`
  (the job's name by default), freshness ages and the restore canary.

Each job builds one target per source host and repository, named `job:host:repository`. Sources on
one host go into one archive named `{prefix}-{host}-{time}`, and prune and freshness read only the
archives of that name, so targets sharing a repository stay apart. Compact and the repository check
act on the whole repository, so only the target polling from `poll_via` offers them. A repository no
job writes to is still watched, with its own `max_age`.

A flat entry in `repositories`, holding every field at once with `host` naming its host, still
loads: it expands into a host, a repository, a source and a job of its name, and keeps its name as
its target and its archives' prefix. One with no `host` runs on this server. Its `ssh_user` is
accepted and unused; on a host, `ssh_user` is refused, since the agent replaces SSH.

## Users and access

The password hash file logs in as `admin` (`X_BACKUPS_ADMIN_NAME` renames it). That admin adds
other users on the Users page, each with a role and the repositories they see; a repository shows
every job target that writes to it:

- `viewer` sees status, history, runs and events.
- `operator` also runs actions, restores, and reads and downloads what is inside archives.
- `admin` also changes the config, users and API tokens.

Anyone can turn on a second factor (an authenticator app, with recovery codes) on the Account
page. Five wrong passwords for one name from one address lock that pair out for five minutes.

API tokens, made on the Users page, read like a viewer of every repository and nothing more:
send one as `Authorization: Bearer <token>`. `/metrics` serves Prometheus metrics to a token or a
logged-in user.

Two other ways in, both only for users an admin has added:

- **Single sign-on:** `X_BACKUPS_OIDC_ISSUER`, `X_BACKUPS_OIDC_CLIENT_ID`,
  `X_BACKUPS_OIDC_CLIENT_SECRET_FILE` and `X_BACKUPS_OIDC_REDIRECT_URL` (the public URL of
  `/api/auth/oidc/callback`). The `preferred_username` claim names the user
  (`X_BACKUPS_OIDC_USERNAME_CLAIM`).
- **A reverse proxy's header:** `X_BACKUPS_PROXY_USER_HEADER`, believed only from
  `X_BACKUPS_TRUSTED_PROXIES` (default `127.0.0.1,::1`). The proxy must strip that header from
  what clients send.

The NixOS module has the same as `adminName`, `oidc.*` and `proxyLogin.*`.

## NixOS

The flake's `nixosModules.default` runs X-Backups as a service:

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
  jobs.nightly = { sources = [ "fileserver-data" ]; repositories = [ "offsite" ]; keep_daily = 7; };
};
```

`hosts`, `repositories`, `sources` and `jobs` are keyed by name and take the fields of their kind
in `config.example.json`, other than `name`; fields the module has no option for, such as a job's
`tasks`, are written as given. Each one declared here is locked on the page. A repository's
passphrase goes in `passphraseFile`, which systemd loads as a credential, never in `passphrase`.
With `configMode` declarative, evaluation fails when a job names a source or repository not
declared here; in `mixed` and `page` modes the page may add it.

A repository entry of the older flat shape still works unchanged: one whose `host` is an address
rather than a declared host's name, or that holds fields a repository does not, such as
`source_paths`, is written as given and expanded as a flat entry (see Config).

A managed host other than this server runs `nixosModules.agent`, pointed at this server with the
token an admin issues for it (see Agents). The fileserver above enables it in its own configuration:

```nix
services.x-backups-agent = {
  enable = true;
  url = "wss://backups.example.org/api/agent";
  tokenFile = "/run/secrets/x-backups-agent-token";
};
```

Borg on this machine reaches an
`ssh://` repository through the system's ssh, whose host keys come from `programs.ssh.knownHosts`.
A restart of the service stops only the server, so a backup its built-in agent started keeps going.
After changing `package-lock.json`, update `npmDepsHash` in
`nix/package.nix` to the hash `nix build` reports.

## Agents

Each managed host runs the X-Backups agent, which dials out to the server's `/api/agent`
WebSocket, so a host needs no open port and a laptop that sleeps reconnects when it wakes. It runs
the commands the server sends, keeps long runs such as backups going across a dropped connection
or its own restart, and samples the host's load, memory and disk. The server's own machine has an
agent built in.

To enrol a host, an admin issues it a token with `POST /api/hosts/<name>/token`; the token is shown
once and only its hash is kept, and issuing a new one hangs up on an agent using the old.
`DELETE /api/hosts/<name>/token` revokes it. `GET /api/hosts` lists each host with whether its agent
is connected, its version, when it was last seen and its newest health reading. Put the token in a
file on the host and enable the flake's `nixosModules.agent`:

```nix
services.x-backups-agent = {
  enable = true;
  url = "wss://backups.example.org/api/agent";
  tokenFile = "/run/secrets/x-backups-agent-token";
};
```

The URL must be `wss://`, since the token and repository passphrases travel over it; the agent
accepts `ws://` only to the machine it runs on. The agent runs as root unless `user` says
otherwise, since borg must read every source, and has borg and borg 2 on its path. Outside NixOS,
run `packages.agent` with `X_BACKUPS_AGENT_URL`, `X_BACKUPS_AGENT_TOKEN_FILE` and
`X_BACKUPS_AGENT_STATE_DIR` set, and have the service manager stop only the agent's own process,
so its long runs outlive it.

A backup, prune, check, compact, restore, delete or purge is a long run, which the agent keeps going
on its own and the server follows by reading its output from where it last stopped. After the
server restarts, each run it had going is followed again once its host's agent connects; while that
agent is away the run shows as waiting for it rather than failed, and a run the agent no longer
knows, as when its state folder was wiped, is marked failed as lost. A run left going over SSH
before agents is marked lost when the database is first opened. Borg's backup timers are still read
on hosts that have `systemctl`, for repositories filled by a host's own borgmatic.

## Borg 2

A repository with `borg_version: 2` is driven with borg 2, which the flake packages as `borg2`
(`packages.borg2`, the 2.0 beta) so it sits beside borg 1. Its host runs `borg2` unless
`borg_bin` says otherwise, and its repository server needs borg 2 for `borg serve` too. Borg 2
cannot open a borg 1 repository, so each repository keeps the version it was made with until
`borg2 transfer --from-borg1` copies it into a new one.

- Borg 2 reads `ssh://host/path` as relative to the login folder; an absolute path is
  `ssh://host//srv/repo`.
- Borg 2 keeps no repository-wide sizes, so its repositories show each archive's size and file
  count but no deduplication figures.
- Borg 2 has one `--keep` for both `keep_within` and `keep_last`, so set only one of them.

## Editing the config from the page

`X_BACKUPS_CONFIG_MODE` (the module's `configMode`) decides whether the page may change the config:

- `declarative`, the default: everything comes from `X_BACKUPS_CONFIG` and the page shows it
  read-only.
- `mixed`: what the file declares stays locked, and the page may add repositories and set the
  defaults the file leaves open.
- `page`: the same, with `X_BACKUPS_CONFIG` optional.

The page keeps its part in `config.json` under `X_BACKUPS_STATE_DIR`, and a passphrase typed there in
`passphrases/<name>`, both readable only by X-Backups. A declared host, repository, source or job
replaces a page one of the same kind and name, and one another entity names cannot be removed. A file's top-level `defaults` (the module's `defaults`) sets `interval`, `max_age`,
`warn_age`, `check_max_age`, `check_warn_age`, `canary_max_age`, `canary_warn_age` and
`browse_limit` for every repository that does not set its own.

Each `*_max_age` makes a repository critical and each `*_warn_age` gives a warning before it:
`max_age` and `warn_age` for the newest archive, `check_*` for the oldest passing check, and
`canary_*` for when the restore canary last ran. A warning age of 0 is off, as is `canary_max_age`
by default.

A repository's storage bar on the overview is drawn against its `quota` (such as `500G` or `2T`)
when one is set, and otherwise against the free space of its filesystem, which each poll reads with
`df` for a repository on a local path. A repository reached over `ssh://` has no free space to read, since
its storage host allows only `borg serve`. The bar turns amber at 75 % and red at 90 %.

Anyone who can log in to a page that edits the config can make X-Backups run commands as its user
and as each agent's user, through fields such as `rsh`, `borg_bin` and `passphrase_command`.

## Licence

GPL-3.0-or-later.
