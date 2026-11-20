// Listens to the server's stream of changes, and falls back to fetching now and then while the stream is down.

import type { Change } from "./api.ts";
import { follow_daemon_stream, is_portal } from "./daemon.ts";

// How often a page refetches while the stream is down and the page is in view.
const fallback_interval_in_milliseconds = 15_000;

// Changes arriving this close together are handed on as one batch.
const batch_window_in_milliseconds = 300;

type Listener = (changes: Change[] | null) => void;

// Stops following the stream, or null while it is not followed.
let stop_stream: (() => void) | null = null;
let up = false;
const listeners = new Set<Listener>();
let fallback_timer: number | undefined;
let batch: Change[] = [];
let batch_timer: number | undefined;
let was_down = false;

// Hands each batch of changes to the listener until the returned function is called.
export function on_changes(listener: Listener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function tell(changes: Change[] | null): void {
  for (const listener of listeners) listener(changes);
}

// Opens the stream once logged in; reopening while it is open does nothing.
export function connect(): void {
  if (stop_stream !== null) return;
  stop_stream = follow_daemon_stream("/api/stream", {
    on_open: () => {
      up = true;
      stop_fallback();
      // Whatever changed while the stream was down was missed, so everything is fetched again, unless a deploy replaced this page.
      if (was_down) void reload_if_replaced().then((replaced) => replaced || tell(null));
      was_down = false;
    },
    on_message: (data) => {
      batch.push(JSON.parse(data) as Change);
      clearTimeout(batch_timer);
      batch_timer = window.setTimeout(() => {
        const changes = batch;
        batch = [];
        tell(changes);
      }, batch_window_in_milliseconds);
    },
    on_error: () => {
      up = false;
      was_down = true;
      start_fallback();
    },
  });
}

export function disconnect(): void {
  stop_stream?.();
  stop_stream = null;
  up = false;
  stop_fallback();
}

export function stream_up(): boolean {
  return up;
}

// A deploy restarts the server with new scripts, and a page left open would read its data wrongly, so the page loads again
// when the server now names another script than the one running.
// A portal's page is bundled with the app, so a deploy of the daemon never replaces it.
async function reload_if_replaced(): Promise<boolean> {
  if (is_portal) return false;
  const running = document.querySelector("script[type=module][src]")?.getAttribute("src");
  try {
    const page = await (await fetch("/", { cache: "no-store" })).text();
    const served = /<script[^>]*type="module"[^>]*src="([^"]+)"/.exec(page)?.[1];
    if (running === undefined || running === null || served === undefined || served === running) return false;
    location.reload();
    return true;
  } catch {
    return false;
  }
}

function start_fallback(): void {
  if (fallback_timer !== undefined) return;
  fallback_timer = window.setInterval(() => {
    if (document.visibilityState === "visible") tell(null);
  }, fallback_interval_in_milliseconds);
}

function stop_fallback(): void {
  clearInterval(fallback_timer);
  fallback_timer = undefined;
}

// A page brought back into view may have missed changes while the browser held its timers back.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && stop_stream !== null) tell(null);
});
