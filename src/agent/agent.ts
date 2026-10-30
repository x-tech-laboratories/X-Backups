// The agent's connection to the server: dials out over a WebSocket with its host's key or token, hands the connection
// to a session, and dials again with a growing, jittered wait whenever it drops.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

import { AgentKeyError, parse_private_key } from "../shared/agent_keys.ts";
import { key_host_header } from "../shared/agent_protocol.ts";
import { LongRuns, type LongRunOptions } from "./long_runs.ts";
import { AgentSession } from "./session.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

export interface AgentConfig {
  url: string;
  // Exactly one of these: the host's OpenSSH ed25519 private key, or the token the server issued it.
  key_file?: string;
  token_file?: string;
  state_directory: string;
  // The name the agent says hello with, and with a key the host it logs in as; with a token the server knows the host by it.
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
  if (!local) throw new AgentConfigError(`ws:// sends the token and passphrases unencrypted, so it is only allowed to this machine; use wss://${url.host}${url.pathname}.`);
  return url;
}

// How the agent logs in, which is read again on each dial so a replaced secret file is picked up.
type Login = { kind: "key"; file: string } | { kind: "token"; file: string };

function login_of(config: AgentConfig): Login {
  const has_key = Boolean(config.key_file);
  const has_token = Boolean(config.token_file);
  if (has_key === has_token) throw new AgentConfigError("Give exactly one of a key file and a token file.");
  return has_key ? { kind: "key", file: config.key_file! } : { kind: "token", file: config.token_file! };
}

// The key in the file, or an AgentConfigError naming the file for one that is not a usable key.
export function read_key_file(file: string): KeyObject {
  const text = readFileSync(file, "utf8");
  try {
    return parse_private_key(text);
  } catch (error) {
    if (error instanceof AgentKeyError) throw new AgentConfigError(`The key file ${file} ${error.message}`);
    throw error;
  }
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
  const login = login_of(config);
  // A key that is there but unusable stops the agent at once; one not there yet, as before secrets are in place, is retried.
  if (login.kind === "key") {
    try {
      read_key_file(login.file);
    } catch (error) {
      if (error instanceof AgentConfigError) throw error;
    }
  }
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
    let headers: Record<string, string>;
    let key: KeyObject | null = null;
    try {
      if (login.kind === "key") {
        key = read_key_file(login.file);
        headers = { [key_host_header]: config.host };
      } else {
        headers = { authorization: `Bearer ${readFileSync(login.file, "utf8").trim()}` };
      }
    } catch (error) {
      log(`Could not read the ${login.kind} file: ${(error as Error).message}`);
      dial_later();
      return;
    }
    const current = new WebSocket(url, { headers });
    current.binaryType = "arraybuffer";
    socket = current;
    current.addEventListener("open", () => {
      failures = 0;
      log(`Connected to ${url.origin}`);
      session = new AgentSession(current, runs, { host: config.host, agent_version: config.agent_version, heartbeat_in_milliseconds: heartbeat, key });
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
