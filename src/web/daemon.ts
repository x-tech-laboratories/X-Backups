// Where the page's requests go. In a browser the page talks to the daemon that served it. The desktop and Android apps
// are portals onto a daemon on another host, chosen under Settings → Connections: the desktop page asks its main
// process, which holds the list and each daemon's token, and the Android page holds the list itself and sends its
// requests straight to the daemon with the token.

// ── Imports ──────────────────────────────────────────────────────────────────

import { Capacitor } from "@capacitor/core";
import type { CertificateClient } from "@x-tech-laboratories/x-libs/certificate_protocol";
import type { ConnectionClient } from "@x-tech-laboratories/x-libs/connection_protocol";
import { create_connections, type Connections } from "@x-tech-laboratories/x-libs/connections";
import { create_page_fetch, create_page_stream_fetch } from "@x-tech-laboratories/x-libs/electron/fetch";
import { phone_certificates } from "@x-tech-laboratories/x-libs/phone_certificates";
import { local_connection_storage } from "@x-tech-laboratories/x-libs/web/connection_storage";
import type { DesktopWindow } from "../shared/desktop.ts";
import { daemon_headers, daemon_url, device_name, follow_stream, no_daemon_text, type StreamHandlers } from "../shared/portal.ts";

// ── Host ─────────────────────────────────────────────────────────────────────

export type Host = "browser" | "desktop" | "android";

const desktop = (window as Window & DesktopWindow);

export const host: Host = desktop.x_backups ? "desktop" : Capacitor.isNativePlatform() ? "android" : "browser";

// Whether the page is a portal app's, which picks its daemon under Settings → Connections.
export const is_portal = host !== "browser";

// ── Android ──────────────────────────────────────────────────────────────────

// Made only on a phone, so a browser's local storage never holds a list.
const phone: Connections | null = host === "android"
  ? create_connections({ storage: local_connection_storage("x-backups-connections"), offers_local: false, device_name: device_name("Android") })
  : null;

// The page's request sent to the phone's chosen daemon with its token.
async function phone_fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const daemon = phone!.current();
  if (daemon === null || daemon.kind !== "remote") throw new Error(no_daemon_text);
  const request = new Request(input, init);
  return fetch(daemon_url(daemon.address, request.url), {
    method: request.method,
    headers: daemon_headers(request.headers.entries(), daemon.token),
    body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
    signal: init?.signal ?? request.signal,
  });
}

// ── Requests ─────────────────────────────────────────────────────────────────

const desktop_fetch = desktop.x_backups ? create_page_fetch((request) => desktop.x_backups!.http_fetch(request)) : null;

const desktop_stream_fetch = desktop.x_backups && desktop.x_backups_events
  ? create_page_stream_fetch({
    start: (request) => desktop.x_backups!.http_stream(request),
    cancel: (stream_id) => desktop.x_backups!.http_stream_cancel(stream_id),
    on_chunk: (handler) => desktop.x_backups_events!.on("stream_chunk", handler),
  })
  : null;

// A fetch for the daemon's routes, such as "/api/runs", wherever the daemon runs.
export const daemon_fetch: typeof fetch = (input, init) => {
  if (host === "desktop") return desktop_fetch!(input as string | URL | Request, init);
  if (host === "android") return phone_fetch(input as string | URL | Request, init);
  return fetch(input, init);
};

// Follows the daemon's change stream at the path; a browser uses an EventSource, the portals read it over fetch.
export function follow_daemon_stream(path: string, handlers: StreamHandlers): () => void {
  if (host === "browser") {
    const source = new EventSource(path);
    source.onopen = handlers.on_open;
    source.onmessage = (message) => handlers.on_message(message.data);
    source.onerror = handlers.on_error;
    return () => source.close();
  }
  const open = (signal: AbortSignal) => host === "desktop"
    ? desktop_stream_fetch!(path, { headers: { accept: "text/event-stream" }, signal })
    : phone_fetch(path, { headers: { accept: "text/event-stream" }, signal });
  return follow_stream(open, handlers);
}

// Saves a file the daemon sends, such as an archive download, which a portal cannot reach by a plain link.
export async function save_from_daemon(path: string): Promise<void> {
  const response = await daemon_fetch(path);
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `The daemon answered ${response.status}.`);
  const name = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(response.headers.get("content-disposition") ?? "")?.[1];
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name ? decodeURIComponent(name) : "download";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ── Connections ──────────────────────────────────────────────────────────────

// The connection manager's calls, or null in a browser.
export const connections: ConnectionClient | null = desktop.x_backups ?? phone?.methods ?? null;

// Trusting a daemon's certificate the device refuses, such as a home server's self-signed one.
export const certificates: CertificateClient | undefined = host === "desktop" ? desktop.x_certificates : host === "android" ? phone_certificates() : undefined;

// Calls back whenever the daemon the portal talks to changes; returns how to stop.
export function on_daemon_changed(listener: () => void): () => void {
  if (desktop.x_backups_events) return desktop.x_backups_events.on("daemon_changed", listener);
  if (phone) return phone.subscribe(listener);
  return () => {};
}
