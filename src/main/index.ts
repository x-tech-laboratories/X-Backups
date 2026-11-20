// The desktop app: Electron's main process showing the X-Backups page from a server on another host. It is a portal and
// runs no server of its own; it keeps the servers the user added, each with this device's token, and sends the page's
// requests to the chosen one.

// ── Imports ──────────────────────────────────────────────────────────────────

import { app, BrowserWindow, ipcMain, nativeTheme, screen, session, shell } from "electron";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

import { create_certificate_trust } from "@x-tech-laboratories/x-libs/certificates";
import { connection_file_storage } from "@x-tech-laboratories/x-libs/connection_file_storage";
import { create_connections } from "@x-tech-laboratories/x-libs/connections";
import { bring_to_front, hold_single_instance } from "@x-tech-laboratories/x-libs/electron/app";
import type { IpcMainEventLike } from "@x-tech-laboratories/x-libs/electron/bridge";
import { trusting_fetch } from "@x-tech-laboratories/x-libs/electron/certificates";
import { create_main_fetch, create_main_stream_fetch, type FetchPolicy, type FetchRequest } from "@x-tech-laboratories/x-libs/electron/fetch";
import { create_window, is_app_page } from "@x-tech-laboratories/x-libs/electron/window";

import { certificate_bridge, portal_bridge, portal_events } from "../shared/desktop.ts";
import { daemon_headers, daemon_url, device_name, no_daemon_text } from "../shared/portal.ts";

// ── Profile ──────────────────────────────────────────────────────────────────

// A run with X_BACKUPS_USER_DATA keeps its own servers and window, apart from the installed app's.
if (process.env.X_BACKUPS_USER_DATA) app.setPath("userData", process.env.X_BACKUPS_USER_DATA);
// Every build, the Flatpak's sandbox included, keeps one profile in ~/.config/x-backups.
else app.setPath("userData", join(homedir(), ".config", "x-backups"));

const profile = app.getPath("userData");

// The built app sits in out/main, with resources/ beside out/ in the source tree and in the package.
const icon_path = join(__dirname, "../../resources/icon.png");

const page = {
  dev_url: !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined,
  file: join(__dirname, "../renderer/index.html"),
};

// ── Servers ──────────────────────────────────────────────────────────────────

const trust = create_certificate_trust({ file: join(profile, "trusted-certificates.json") });

// Requests to a server go through Chromium, which accepts a certificate the user trusted, such as a home server's self-signed one.
const remote_fetch = trusting_fetch(session, trust);

const connections = create_connections({
  storage: connection_file_storage(join(profile, "connections.json")),
  offers_local: false,
  device_name: device_name(hostname()),
  fetch: remote_fetch,
});

// Only the chosen server's host is reached.
const policy: FetchPolicy = {
  get hosts() {
    const daemon = connections.current();
    return daemon?.kind === "remote" ? [new URL(daemon.address).host] : [];
  },
  allow_http: true,
};

// The page's request, made to its own origin, sent to the chosen server's API with this device's token.
function to_daemon<Request extends FetchRequest>(request: Request): Request {
  const daemon = connections.current();
  if (daemon === null || daemon.kind !== "remote") throw new Error(no_daemon_text);
  return { ...request, url: daemon_url(daemon.address, request.url), headers: daemon_headers(request.headers, daemon.token) };
}

const windows = () => BrowserWindow.getAllWindows();
const main_fetch = create_main_fetch(policy, remote_fetch);
const stream_fetch = create_main_stream_fetch(policy, (chunk) => portal_events.emit(windows(), "stream_chunk", chunk), remote_fetch);

// ── Bridge ───────────────────────────────────────────────────────────────────

// Only the app's own page may make calls, never a site a link opened.
const trusted = (event: IpcMainEventLike) => event.senderFrame !== null && event.senderFrame !== undefined && is_app_page(event.senderFrame.url, page);

function register_bridge(): void {
  portal_bridge.handle(ipcMain, {
    ...connections.methods,
    http_fetch: (request) => main_fetch(to_daemon(request)),
    http_stream: (request) => stream_fetch.start(to_daemon(request)),
    http_stream_cancel: async (stream_id) => stream_fetch.cancel(stream_id),
  }, { trusted });
  certificate_bridge.handle(ipcMain, trust.methods, { trusted });
  connections.subscribe(() => portal_events.emit(windows(), "daemon_changed", null));
}

// ── Window ───────────────────────────────────────────────────────────────────

function create_main_window(): BrowserWindow {
  return create_window(BrowserWindow, {
    title: "X-Backups",
    icon: icon_path,
    // electron-vite emits an ESM preload as .mjs.
    preload: join(__dirname, "../preload/index.mjs"),
    ...page,
    default_size: { width: 1200, height: 800 },
    min_size: { width: 400, height: 500 },
    native_theme: nativeTheme,
    shell,
    screen,
    state_file: join(profile, "window.json"),
  });
}

function show_window(): void {
  const [window] = windows();
  if (window) bring_to_front(window);
  else create_main_window();
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

if (hold_single_instance(app, show_window)) {
  void app.whenReady().then(() => {
    register_bridge();
    create_main_window();
    app.on("activate", show_window);
  });
  app.on("window-all-closed", () => app.quit());
}
