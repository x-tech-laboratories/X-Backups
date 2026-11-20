// How the desktop and Android apps, which are portals onto a daemon on another host, send the page's requests on: the
// path the page asked for under the chosen daemon's address, with this device's token, and the daemon's change stream
// read over fetch, since an EventSource cannot carry the token.

// ── Requests ─────────────────────────────────────────────────────────────────

export const no_daemon_text = "No daemon is chosen yet. Choose one under Settings → Connections.";

// What the device is called on the daemon's list of tokens.
export function device_name(where: string): string {
  return `X-Backups on ${where}`;
}

// The daemon's URL for a request the page made to its own origin, such as "/api/runs?limit=5"; only the API is reached.
export function daemon_url(address: string, requested: string): string {
  const url = new URL(requested, "http://page.invalid");
  const path = `${url.pathname}${url.search}`;
  if (!path.startsWith("/api/")) throw new Error(`${url.pathname} is not one of the daemon's routes.`);
  return `${address}${path}`;
}

// The page's headers with this device's token in place of any credentials or origin the page's own request carried.
export function daemon_headers(headers: Iterable<[string, string]>, token: string): [string, string][] {
  const dropped = new Set(["authorization", "cookie", "origin", "referer", "host"]);
  const kept = [...headers].filter(([name]) => !dropped.has(name.toLowerCase()));
  return [...kept, ["authorization", `Bearer ${token}`]];
}

// ── Change stream ────────────────────────────────────────────────────────────

// One server-sent event block's name and data, or null for a comment or heartbeat.
export function parse_event(block: string): { event: string; data: string } | null {
  let event = "message";
  const data: string[] = [];
  let has_field = false;
  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else continue;
    has_field = true;
  }
  return has_field ? { event, data: data.join("\n") } : null;
}

export interface StreamHandlers {
  on_open: () => void;
  on_message: (data: string) => void;
  // The stream broke off or could not be opened; it is tried again after retry_ms.
  on_error: () => void;
}

// Follows the daemon's change stream through the given fetch until the returned function is called.
export function follow_stream(open: (signal: AbortSignal) => Promise<Response>, handlers: StreamHandlers, retry_ms = 5000): () => void {
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | null = null;

  async function read(): Promise<void> {
    controller = new AbortController();
    const response = await open(controller.signal);
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`The change stream answered ${response.status}.`);
    }
    handlers.on_open();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let cut: number;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const parsed = parse_event(buffer.slice(0, cut));
        buffer = buffer.slice(cut + 2);
        if (parsed?.event === "message") handlers.on_message(parsed.data);
      }
    }
  }

  function start(): void {
    void read()
      .catch(() => undefined)
      .finally(() => {
        controller = null;
        if (stopped) return;
        handlers.on_error();
        retry = setTimeout(start, retry_ms);
      });
  }

  start();
  return () => {
    stopped = true;
    clearTimeout(retry);
    controller?.abort();
  };
}
