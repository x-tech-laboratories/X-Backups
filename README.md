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

- A **host** is `managed` (X-Backups runs commands on it, at `address` with `ssh_user`, or on this
  machine with no address) or `storage-only` (it only holds repositories reached by `borg serve`).
  It holds `ssh_key`, `rsh`, `require_sudo`, `borg_bin`, `cache_dir` and the `job_*` and `skip_*`
  settings.
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

A flat entry in `repositories`, holding every field at once with `host` as an SSH address, still
loads: it expands into a host, a repository, a source and a job of its name, and keeps its name as
its target and its archives' prefix.

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
  sshKeyFile = "/run/secrets/x-backups-ssh-key";
  repositories.fileserver = {
    host = "fileserver.example.org";
    ssh_user = "backup";
    repo = "ssh://borg@storage.example.org/./fileserver";
    passphraseFile = "/run/secrets/borg-fileserver";
  };
};
```

Each repository takes the fields of a flat entry (see Config). Host keys come from
`programs.ssh.knownHosts`. After changing `package-lock.json`, update `npmDepsHash` in
`nix/package.nix` to the hash `nix build` reports.

## Agents

Each managed host runs the X-Backups agent, which dials out to the server's `/api/agent`
WebSocket, so a host needs no open port and a laptop that sleeps reconnects when it wakes. It runs
the commands the server sends, keeps long runs such as backups going across a dropped connection
or its own restart, and samples the host's load, memory and disk. The server's own machine has an
agent built in.

To enrol a host, issue it a token on the server; the token is shown once and only its hash is
kept. Put it in a file on the host and enable the flake's `nixosModules.agent`:

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
`df` for a repository on a local path. A repository reached over SSH has no free space to read, since
its storage host allows only `borg serve`. The bar turns amber at 75 % and red at 90 %.

Anyone who can log in to a page that edits the config can make X-Backups run commands as its user,
through fields such as `rsh`, `borg_bin` and `passphrase_command`.

## Licence

GPL-3.0-or-later.
