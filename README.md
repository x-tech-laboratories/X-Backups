# X-Backups

A web platform for managing borg backups, part of X-Tech Laboratories.

## Layout

- `src/server/` — the Fastify API, written in TypeScript and run directly by Node 24.
- `src/server/borg/` — one borg repository: the shell commands it runs, how their output is read, and its actions.
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

`/api/health` stays open, so X-Monitor can poll it without logging in.

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

Each repository takes the fields of a `config.example.json` entry. Host keys come from
`programs.ssh.knownHosts`. After changing `package-lock.json`, update `npmDepsHash` in
`nix/package.nix` to the hash `nix build` reports.

## Editing the config from the page

`X_BACKUPS_CONFIG_MODE` (the module's `configMode`) decides whether the page may change the config:

- `declarative`, the default: everything comes from `X_BACKUPS_CONFIG` and the page shows it
  read-only.
- `mixed`: what the file declares stays locked, and the page may add repositories and set the
  defaults the file leaves open.
- `page`: the same, with `X_BACKUPS_CONFIG` optional.

The page keeps its part in `config.json` under `X_BACKUPS_STATE_DIR`, and a passphrase typed there in
`passphrases/<name>`, both readable only by X-Backups. A declared repository replaces a page one of
the same name. A file's top-level `defaults` (the module's `defaults`) sets `interval`, `max_age`,
`check_max_age` and `browse_limit` for every repository that does not set its own.

Anyone who can log in to a page that edits the config can make X-Backups run commands as its user,
through fields such as `rsh`, `borg_bin` and `passphrase_command`.

## Licence

GPL-3.0-or-later.
