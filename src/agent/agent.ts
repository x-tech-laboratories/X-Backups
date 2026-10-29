// The agent's connection to the server: dials out over a WebSocket with its host's token, hands the connection to a
// session, and dials again with a growing, jittered wait whenever it drops.

// ── Imports ──────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";

import { LongRuns, type LongRunOptions } from "./long_runs.ts";
import { AgentSession } from "./session.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

export interface AgentConfig {
  url: string;
  token_file: string;
  state_directory: string;
  // The name the agent says hello with; the server knows the host by its token.
  host: string;
  agent_version: string;
  heartbeat_in_milliseconds?: number;
  // The first wait before dialling again, doubled each failure up to the longest.
  backoff_initial_in_milliseconds?: number;
  backoff_longest_in_milliseconds?: number;
  long_runs?: LongRunOptions;
  log?: (line: string) => void;
}

export class AgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentConfigError";
  }
}

const local_names = new Set(["localhost", "[::1]", "::1"]);

// ── Checks ───────────────────────────────────────────────────────────────────

// The server's URL, which must be wss:// so the token and passphrases are encrypted, unless it is this machine.
export function check_url(text: string): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new AgentConfigError(`'${text}' is not a URL.`);
  }
  if (url.protocol === "wss:") return url;
  if (url.protocol !== "ws:") throw new AgentConfigError(`The server URL must start with wss://, not ${url.protocol}//.`);
  const local = local_names.has(url.hostname) || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  if (!local) throw new AgentConfigError(`ws:// sends the token unencrypted, so it is only allowed to this machine; use wss://${url.host}${url.pathname}.`);
  return url;
}

// ── Agent ────────────────────────────────────────────────────────────────────

export interface RunningAgent {
  readonly runs: LongRuns;
  // Whether a session is open now.
  connected(): boolean;
  // Hangs up and stops dialling; long runs carry on.
  stop(): Promise<void>;
}

export function start_agent(config: AgentConfig): RunningAgent {
  const url = check_url(config.url);
  const runs = new LongRuns(config.state_directory, config.long_runs);
  const log = config.log ?? ((line: string) => console.log(line));
  const heartbeat = config.heartbeat_in_milliseconds ?? 15_000;
  const initial = config.backoff_initial_in_milliseconds ?? 1000;
  const longest = config.backoff_longest_in_milliseconds ?? 60_000;

  let socket: WebSocket | null = null;
  let session: AgentSession | null = null;
  let failures = 0;
  let stopping = false;
  let retry_timer: NodeJS.Timeout | undefined;
  let closed_resolve: (() => void) | null = null;

  const dial_later = () => {
    if (stopping) return;
    // Half the wait is fixed and half random, so hosts that lost the server together do not all return at once.
    const wait = Math.min(longest, initial * 2 ** failures);
    failures++;
    retry_timer = setTimeout(dial, wait / 2 + Math.random() * (wait / 2));
  };

  const dial = () => {
    if (stopping) return;
    let token: string;
    try {
      token = readFileSync(config.token_file, "utf8").trim();
    } catch (error) {
      log(`Could not read the token file: ${(error as Error).message}`);
      dial_later();
      return;
    }
    const current = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    current.binaryType = "arraybuffer";
    socket = current;
    current.addEventListener("open", () => {
      failures = 0;
      log(`Connected to ${url.origin}`);
      session = new AgentSession(current, runs, { host: config.host, agent_version: config.agent_version, heartbeat_in_milliseconds: heartbeat });
    });
    current.addEventListener("message", (event) => {
      if (typeof event.data === "string") session?.receive(event.data);
    });
    current.addEventListener("error", () => {});
    current.addEventListener("close", (event) => {
      if (session !== null) log(`Disconnected from ${url.origin} (${event.code}${event.reason ? `: ${event.reason}` : ""})`);
      session?.close();
      session = null;
      socket = null;
      if (closed_resolve !== null) closed_resolve();
      else dial_later();
    });
  };

  dial();

  return {
    runs,
    connected: () => session !== null,
    stop: () => {
      stopping = true;
      clearTimeout(retry_timer);
      if (socket === null) return Promise.resolve();
      const closing = new Promise<void>((resolve) => (closed_resolve = resolve));
      socket.close(1000, "The agent is stopping.");
      return closing;
    },
  };
}
