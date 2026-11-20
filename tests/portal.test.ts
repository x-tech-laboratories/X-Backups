import { describe, expect, it, vi } from "vitest";
import { daemon_headers, daemon_url, follow_stream, parse_event } from "../src/shared/portal.ts";

describe("daemon_url", () => {
  it("puts the path the page asked for under the daemon's address", () => {
    expect(daemon_url("https://backups.example.org", "/api/runs?state=running")).toBe("https://backups.example.org/api/runs?state=running");
  });

  it("reads the path from the page's own origin, as the desktop and Android pages resolve it", () => {
    expect(daemon_url("http://192.168.1.5:7710", "file:///api/me")).toBe("http://192.168.1.5:7710/api/me");
    expect(daemon_url("https://home.example.org/backups", "https://localhost/api/stream")).toBe("https://home.example.org/backups/api/stream");
  });

  it("refuses anything outside the API", () => {
    expect(() => daemon_url("https://backups.example.org", "/index.html")).toThrow("not one of the daemon's routes");
  });
});

describe("daemon_headers", () => {
  it("sends the device's token in place of the page's credentials and origin", () => {
    const headers = daemon_headers([["Content-Type", "application/json"], ["Authorization", "Bearer old"], ["Cookie", "a=b"], ["Origin", "file://"]], "xb_token");

    expect(headers).toEqual([["Content-Type", "application/json"], ["authorization", "Bearer xb_token"]]);
  });
});

describe("parse_event", () => {
  it("reads a message's data across lines", () => {
    expect(parse_event("data: {\"a\":\ndata: 1}")).toEqual({ event: "message", data: "{\"a\":\n1}" });
  });

  it("reads a named event and skips a heartbeat", () => {
    expect(parse_event("event: hello\ndata: x")).toEqual({ event: "hello", data: "x" });
    expect(parse_event(": heartbeat")).toBeNull();
  });
});

// A response whose body sends the chunks and then ends.
function streamed(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status });
}

describe("follow_stream", () => {
  it("hands on each message, even one split across chunks, then tries again once the stream ends", async () => {
    vi.useFakeTimers();
    const messages: string[] = [];
    const handlers = { on_open: vi.fn(), on_message: (data: string) => messages.push(data), on_error: vi.fn() };
    const open = vi.fn(async () => streamed(["data: one\n\nda", "ta: two\r\n\r\n: ping\n\n"]));

    const stop = follow_stream(open, handlers, 1000);
    await vi.waitFor(() => expect(handlers.on_error).toHaveBeenCalledTimes(1));

    expect(handlers.on_open).toHaveBeenCalledTimes(1);
    expect(messages).toEqual(["one", "two"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(open).toHaveBeenCalledTimes(2);
    stop();
    vi.useRealTimers();
  });

  it("counts a refused stream as down without opening it", async () => {
    vi.useFakeTimers();
    const handlers = { on_open: vi.fn(), on_message: vi.fn(), on_error: vi.fn() };

    const stop = follow_stream(async () => streamed([], 401), handlers, 1000);
    await vi.waitFor(() => expect(handlers.on_error).toHaveBeenCalledTimes(1));

    expect(handlers.on_open).not.toHaveBeenCalled();
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(handlers.on_error).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
