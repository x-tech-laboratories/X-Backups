// What the desktop app's main process and its page agree on over the preload: the connection manager's calls, the
// page's requests sent on to the chosen daemon, the daemon's change stream in chunks, and the trusted certificates.

// ── Imports ──────────────────────────────────────────────────────────────────

import { certificate_method_names, type CertificateMethods } from "@x-tech-laboratories/x-libs/certificate_protocol";
import { connection_method_names, type ConnectionMethods } from "@x-tech-laboratories/x-libs/connection_protocol";
import { define_bridge, type Client } from "@x-tech-laboratories/x-libs/electron/bridge";
import { define_events, type EventsClient } from "@x-tech-laboratories/x-libs/electron/events";
import type { FetchAnswer, FetchRequest, StreamChunk, StreamHead, StreamRequest } from "@x-tech-laboratories/x-libs/electron/fetch";

// ── Bridges ──────────────────────────────────────────────────────────────────

export interface PortalMethods extends ConnectionMethods {
  http_fetch(request: FetchRequest): Promise<FetchAnswer>;
  http_stream(request: StreamRequest): Promise<StreamHead>;
  http_stream_cancel(stream_id: string): Promise<void>;
}

export const portal_bridge = define_bridge<PortalMethods>("x_backups", [...connection_method_names, "http_fetch", "http_stream", "http_stream_cancel"]);

export interface PortalEvents extends Record<string, unknown> {
  stream_chunk: StreamChunk;
  // The user chose another daemon, or removed the one in use.
  daemon_changed: null;
}

export const portal_events = define_events<PortalEvents>("x_backups_events");

export const certificate_bridge = define_bridge<CertificateMethods>("x_certificates", certificate_method_names);

// What the preload puts on the page's window.
export interface DesktopWindow {
  x_backups?: Client<PortalMethods>;
  x_backups_events?: EventsClient<PortalEvents>;
  x_certificates?: Client<CertificateMethods>;
}
