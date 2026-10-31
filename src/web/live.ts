// Listens to the server's stream of changes, and falls back to fetching now and then while the stream is down.

import type { Change } from "./api.ts";

// How often a page refetches while the stream is down and the page is in view.
const fallback_interval_in_milliseconds = 15_000;

// Changes arriving this close together are handed on as one batch.
const batch_window_in_milliseconds = 300;

type Listener = (changes: Change[] | null) => void;

let source: EventSource | null = null;
let listener: Listener = () => {};
let fallback_timer: number | undefined;
let batch: Change[] = [];
let batch_timer: number | undefined;
let was_down = false;

export function on_changes(next: Listener): void {
  listener = next;
}

// Opens the stream once logged in; reopening while it is open does nothing.
export function connect(): void {
  if (source !== null && source.readyState !== EventSource.CLOSED) return;
  source = new EventSource("/api/stream");
  source.onopen = () => {
    stop_fallback();
    // Whatever changed while the stream was down was missed, so everything is fetched again, unless a deploy replaced this page.
    if (was_down) void reload_if_replaced().then((replaced) => replaced || listener(null));
    was_down = false;
  };
  source.onmessage = (message) => {
    batch.push(JSON.parse(message.data) as Change);
    clearTimeout(batch_timer);
    batch_timer = window.setTimeout(() => {
      const changes = batch;
      batch = [];
      listener(changes);
    }, batch_window_in_milliseconds);
  };
  source.onerror = () => {
    was_down = true;
    start_fallback();
  };
}

export function disconnect(): void {
  source?.close();
  source = null;
  stop_fallback();
}

export function stream_up(): boolean {
  return source?.readyState === EventSource.OPEN;
}

// A deploy restarts the server with new scripts, and a page left open would read its data wrongly, so the page loads again
// when the server now names another script than the one running.
async function reload_if_replaced(): Promise<boolean> {
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
    if (document.visibilityState === "visible") listener(null);
  }, fallback_interval_in_milliseconds);
}

function stop_fallback(): void {
  clearInterval(fallback_timer);
  fallback_timer = undefined;
}

// A page brought back into view may have missed changes while the browser held its timers back.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && source !== null) listener(null);
});
