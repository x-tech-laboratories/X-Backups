# X-Backups

A web platform for managing borg backups, part of X-Tech Laboratories.

## Layout

- `server/` — the Fastify API, written in TypeScript and run directly by Node 24.
- `web/` — the browser page, built by Vite into `dist/`.

## Development

```sh
nix develop          # or: nix-shell
npm install
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

## Licence

GPL-3.0-or-later.
