# X-Backups

<a href="https://liberapay.com/BeatLink/donate"><img alt="Donate using Liberapay" src="https://liberapay.com/assets/widgets/donate.svg"></a> <a href="https://ko-fi.com/I4V52ANK6N"><img alt="Support me on Ko-fi" src="https://ko-fi.com/img/githubbutton_sm.svg"></a>

A web platform for managing borg backups, part of X-Tech Laboratories. It runs every backup, prune, check and compact
on a small agent on each host, and shows how fresh, large and healthy each backup is.

**Documentation: <https://x-tech-laboratories.github.io/X-Backups/>**, with the [user guide](docs/user/index.md),
[architecture](docs/architecture.md), [roadmap](docs/roadmap.md) and [changelog](docs/changelog.md).

## Layout

- `src/server/` — the Fastify API, written in TypeScript and run directly by Node 24.
- `src/server/borg/` — one borg repository: the shell commands it runs, how their output is read, and its actions.
- `src/server/agents/` — the hub agents connect to, and the agent built in for the server's own machine.
- `src/agent/` — the agent each managed host runs.
- `src/shared/` — the messages the server and its agents exchange.
- `src/web/` — the browser page, built by Vite into `dist/`.
- `docs/` — the documentation site.

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

See [Getting started](docs/user/getting-started.md) for the NixOS modules, the environment and the agents. After
changing `package-lock.json`, update `npmDepsHash` in `nix/package.nix` to the hash `nix build` reports.

## Licence

GPL-3.0-or-later.
