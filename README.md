# X-Backups

<a href="https://liberapay.com/BeatLink/donate"><img alt="Donate using Liberapay" src="https://liberapay.com/assets/widgets/donate.svg"></a> <a href="https://ko-fi.com/I4V52ANK6N"><img alt="Support me on Ko-fi" src="https://ko-fi.com/img/githubbutton_sm.svg"></a>

A platform for managing borg backups, part of X-Tech Laboratories. It runs every backup, prune, check and compact
on a small agent on each host, and shows how fresh, large and healthy each backup is.

## Platforms

- **Web**: the server serves the page; sign in with a browser.
- **Linux desktop**: an Electron app, as an AppImage or a Flatpak.
- **Android**: a Capacitor app.

The server belongs on one host, where it reaches the agents, so the desktop and Android apps are portals onto it and
never run a server of their own. To connect one, open it: with no server chosen it opens on Settings → Connections.
Enter the server's address, your name and password (and the code with a second factor) and press **Add daemon**. The
device signs in for a token of its own, named "X-Backups on <device>", kept by the app and revocable from the Account
page; Remove or Sign out gives it back. A self-signed certificate is offered for trust once. See
[Getting started](docs/user/getting-started.md#desktop-and-android-apps).

**Documentation: <https://x-tech-laboratories.github.io/X-Backups/>**, built from `docs/` with the [X-Libs site framework](https://github.com/x-tech-laboratories/X-Libs#a-static-site), with the [user guide](docs/user/index.md),
[architecture](docs/architecture.md), [roadmap](docs/roadmap.md) and [changelog](docs/changelog.md).

## Layout

- `src/server/` — the Fastify API, written in TypeScript and run directly by Node 24.
- `src/server/borg/` — one borg repository: the shell commands it runs, how their output is read, and its actions.
- `src/server/agents/` — the hub agents connect to, and the agent built in for the server's own machine.
- `src/agent/` — the agent each managed host runs.
- `src/shared/` — the messages the server and its agents exchange.
- `src/web/` — the page, built by Vite into `dist/`, and drawn by the desktop and Android apps too.
- `src/main/`, `src/preload/` — the desktop app's Electron main process and its preload bridge.
- `android/` — the Android app's Capacitor project; `capacitor.config.json` beside it.
- `docs/` — the documentation site.

## Development

```sh
nix develop          # or: nix-shell
npm install
npm run hash-password   # asks for the login password, writes password.hash
npm run dev:server   # API on http://127.0.0.1:7710
npm run dev:web      # page on http://localhost:5173, proxying /api to the server
npm run dev          # the desktop app, against a server added under Settings → Connections
```

Desktop and Android builds:

```sh
npm run dist           # AppImage and Flatpak in dist-desktop/
npm run build:android  # the page in out/android, synced into android/; then: cd android && ./gradlew assembleDebug
npm run icons          # every icon, regenerated from resources/icon.svg
```

The Apps workflow builds both on every pull request and push to `main` and keeps them as the run's artifacts.

## Checks

```sh
npm run build   # type-check both halves and build the page
npm test
npm run coverage   # tests with a coverage floor
npm run lint
```

The coverage floor in `vite.config.ts` only rises; CI fails when coverage drops below it or a raised floor is not committed.

## Production

```sh
npm run build && npm start
```

See [Getting started](docs/user/getting-started.md) for the NixOS modules, the environment and the agents. The Nix
build reads its npm packages straight from `package-lock.json`, so a lock file change needs nothing else.

## Deviations

- The Android APK is a debug build: the repository holds no signing key yet, so CI cannot sign a release.
- Downloading archive files works in the browser and on the desktop, but not in the Android app, which says so:
  Android's WebView saves no file from a page without a native download handler, which X-Libs does not offer yet.

## Licence

GPL-3.0-or-later.
