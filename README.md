# X-Backups

A web platform for managing borg backups, part of X-Tech Laboratories.

## Layout

- `server/` — the Fastify API, written in TypeScript and run directly by Node 24.
- `server/borg/` — one borg repository: the shell commands it runs, how their output is read, and its actions.
- `web/` — the browser page, built by Vite into `dist/`.

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
`/api/health` stays open, so X-Monitor can poll it without logging in.

## Licence

GPL-3.0-or-later.
