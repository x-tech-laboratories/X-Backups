// The agents the server can reach, by host name: those that have dialled in over /api/agent with their host's token
// or declared key, and the one built into the server for its own machine. Everything that runs a command on a host
// goes through here. A host with a declared key logs in only with that key, so a leaked token cannot stand in for it.

// ── Imports ──────────────────────────────────────────────────────────────────

import { randomBytes, type KeyObject } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingHttpHeaders } from "node:http";

import { parse_public_key, verify_challenge } from "../../shared/agent_keys.ts";
import {
  encode_message, key_host_header, parse_agent_message, protocol_version, type HealthSample, type LongRun, type LongRunPoll,
} from "../../shared/agent_protocol.ts";
import { cmd_result, type CmdResult } from "../borg/types.ts";
import { AgentError, ended_stream, type Agent, type AgentRunOptions, type AgentStreamOptions, type CommandStream } from "./agent.ts";
import { AgentConnection, type ConnectionOptions, type ServerSocket } from "./connection.ts";
import type { AgentEnrolment, AgentTokens } from "./tokens.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

export interface HubOptions {
  // The server's own machine, answered by an agent built into the server.
  local?: { host: string; agent: Agent };
  // How long a new socket has to say hello.
  hello_timeout_in_milliseconds?: number;
  connection?: Partial<ConnectionOptions>;
}

// A connected agent as the page shows it.
export interface AgentStatus {
  host: string;
  // The name the agent gave itself, which may differ from the host it is enrolled as.
  reported_host: string;
  agent_version: string;
  connected_epoch: number;
  built_in: boolean;
  // How the agent logged in; null for the built-in one.
  login: AgentLogin | null;
  // The long runs the agent knew of when it connected.
  runs: LongRun[];
}

export type AgentLogin = "token" | "key";

// Who an agent's upgrade says it is, before any socket opens, or why it is turned away.
export type Admission = { host: string; login: AgentLogin } | { error: string };

interface HubEvents {
  connect: [status: AgentStatus];
  disconnect: [host: string];
}

// Close codes the hub hangs up with.
export const close_codes = {
  protocol: 4002,
  replaced: 4003,
  revoked: 4004,
  no_hello: 4005,
  bad_key: 4006,
} as const;

const default_connection: ConnectionOptions = {
  window_in_bytes: 1024 * 1024,
  request_timeout_in_milliseconds: 60_000,
  heartbeat_in_milliseconds: 15_000,
};

// ── Hub ──────────────────────────────────────────────────────────────────────

export class AgentHub extends EventEmitter<HubEvents> {
  private readonly tokens: AgentTokens;
  private readonly local: { host: string; readonly agent: Agent } | null;
  private readonly hello_timeout: number;
  private readonly connection_options: ConnectionOptions;
  private readonly connections = new Map<string, AgentConnection>();
  private readonly logins = new WeakMap<AgentConnection, AgentLogin>();
  // Each host's declared public key, with the line it was read from.
  private agent_keys = new Map<string, { line: string; key: KeyObject }>();

  constructor(tokens: AgentTokens, options: HubOptions = {}) {
    super();
    this.tokens = tokens;
    this.local = options.local === undefined ? null : { ...options.local };
    this.hello_timeout = options.hello_timeout_in_milliseconds ?? 10_000;
    this.connection_options = { ...default_connection, ...options.connection };
  }

  // The host the built-in agent answers for, which follows the config as it names this server's own host.
  set_local_host(host: string): void {
    if (this.local !== null) this.local.host = host;
  }

  // ── Enrolment ────────────────────────────────────────────────────────────

  // Takes each host's declared OpenSSH public key line, which config.ts has checked, and hangs up on an agent whose
  // host's key is new, changed or gone, so it logs in again the way the config now asks.
  set_agent_keys(lines: Map<string, string>): void {
    const next = new Map([...lines].map(([host, line]) => [host, { line, key: parse_public_key(line) }]));
    for (const host of new Set([...this.agent_keys.keys(), ...next.keys()])) {
      if (this.agent_keys.get(host)?.line === next.get(host)?.line) continue;
      this.disconnect(host, close_codes.revoked, "The host's declared agent key changed.");
    }
    this.agent_keys = next;
  }

  has_agent_key(host: string): boolean {
    return this.agent_keys.has(host);
  }

  // A new token for the host, shown this once; an agent still using the old one is hung up on.
  issue_token(host: string): string {
    const token = this.tokens.issue(host);
    this.disconnect_token_login(host, "The host's token was replaced.");
    return token;
  }

  revoke(host: string): void {
    this.tokens.revoke(host);
    this.disconnect_token_login(host, "The host's token was revoked.");
  }

  // An agent logged in with its key is left alone when the host's token changes.
  private disconnect_token_login(host: string, reason: string): void {
    const connection = this.connections.get(host);
    if (connection !== undefined && this.logins.get(connection) === "token") connection.close(close_codes.revoked, reason);
  }

  // Each host issued a token, with when its agent was last in touch.
  enrolments(): AgentEnrolment[] {
    return this.tokens.enrolments();
  }

  // The host an Authorization header's bearer token belongs to.
  authenticate(authorization: string | undefined): string | null {
    const match = /^Bearer\s+(\S+)$/.exec(authorization ?? "");
    return match === null ? null : this.tokens.host_for(match[1]);
  }

  // Who an agent's upgrade request says it is: a token's host, or the host it names to log in with that host's key.
  admit(headers: IncomingHttpHeaders): Admission {
    const named = headers[key_host_header];
    if (typeof named === "string" && named !== "") {
      if (!this.agent_keys.has(named)) return { error: `Host '${named}' has no declared agent key.` };
      return { host: named, login: "key" };
    }
    const host = this.authenticate(headers.authorization);
    if (host === null) return { error: "This agent token is not enrolled." };
    if (this.agent_keys.has(host)) return { error: `Host '${host}' has a declared agent key, so it logs in with that key, not a token.` };
    return { host, login: "token" };
  }

  // ── Connections ──────────────────────────────────────────────────────────

  // Takes a socket whose upgrade named the host, and waits for its hello before using it; one logging in with its key
  // is sent a nonce first, which its hello must carry signed.
  accept(socket: ServerSocket, host: string, login: AgentLogin = "token"): void {
    let connection: AgentConnection | null = null;
    const hello_timer = setTimeout(() => socket.close(close_codes.no_hello, "No hello came."), this.hello_timeout);
    const nonce = login === "key" ? randomBytes(32).toString("base64url") : null;
    if (nonce !== null) socket.send(encode_message({ type: "challenge", nonce }));

    socket.on("message", (raw, is_binary) => {
      const data = as_buffer(raw);
      if (connection !== null) {
        connection.receive(data, is_binary);
        return;
      }
      const hello = is_binary ? null : parse_agent_message(data.toString("utf8"));
      if (hello?.type !== "hello") return;
      clearTimeout(hello_timer);
      if (hello.protocol !== protocol_version) {
        socket.close(close_codes.protocol, `This server speaks agent protocol ${protocol_version}, not ${hello.protocol}.`);
        return;
      }
      const { signature, ...greeting } = hello;
      if (nonce !== null && !this.proves_key(host, nonce, signature)) {
        socket.close(close_codes.bad_key, `The agent's key is not the one declared for ${host}.`);
        return;
      }
      this.connections.get(host)?.close(close_codes.replaced, "A newer connection from the same host replaced this one.");
      connection = new AgentConnection(socket, host, greeting, this.connection_options);
      this.connections.set(host, connection);
      this.logins.set(connection, login);
      this.emit("connect", this.status_of(connection));
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(hello_timer);
      if (connection === null) return;
      connection.closed(`The agent on ${host} disconnected.`);
      this.tokens.seen(host);
      if (this.connections.get(host) !== connection) return;
      this.connections.delete(host);
      this.emit("disconnect", host);
    });
  }

  private proves_key(host: string, nonce: string, signature: unknown): boolean {
    const declared = this.agent_keys.get(host);
    return declared !== undefined && typeof signature === "string" && verify_challenge(declared.key, host, nonce, signature);
  }

  disconnect(host: string, code = 1000, reason = "The server hung up."): void {
    this.connections.get(host)?.close(code, reason);
  }

  close(): void {
    for (const host of this.connections.keys()) this.disconnect(host, 1001, "The server is stopping.");
  }

  is_connected(host: string): boolean {
    return this.local?.host === host || this.connections.get(host)?.is_open === true;
  }

  status(host: string): AgentStatus | null {
    if (this.local?.host === host) return local_status(host);
    const connection = this.connections.get(host);
    return connection?.is_open ? this.status_of(connection) : null;
  }

  statuses(): AgentStatus[] {
    const remote = [...this.connections.values()].filter((connection) => connection.is_open).map((connection) => this.status_of(connection));
    return this.local === null ? remote : [local_status(this.local.host), ...remote];
  }

  // The host's agent, or null when it is not connected.
  agent(host: string): Agent | null {
    if (this.local?.host === host) return this.local.agent;
    const connection = this.connections.get(host);
    return connection?.is_open ? connection : null;
  }

  // ── Commands ─────────────────────────────────────────────────────────────

  // A run on a host with no agent answers with exit code -1 rather than rejecting, as a command that failed does.
  run(host: string, command: string, options: AgentRunOptions): Promise<CmdResult> {
    const agent = this.agent(host);
    return agent === null ? Promise.resolve(cmd_result(-1, "", not_connected(host))) : agent.run(command, options);
  }

  stream(host: string, command: string, options: AgentStreamOptions = {}): CommandStream {
    return this.agent(host)?.stream(command, options) ?? ended_stream(not_connected(host));
  }

  start(host: string, run_id: string, command: string, options: AgentStreamOptions = {}): Promise<LongRun> {
    return this.require(host).then((agent) => agent.start(run_id, command, options));
  }

  poll(host: string, run_id: string, offset: number): Promise<LongRunPoll> {
    return this.require(host).then((agent) => agent.poll(run_id, offset));
  }

  attach(host: string, run_id: string, offset: number): CommandStream {
    return this.agent(host)?.attach(run_id, offset) ?? ended_stream(not_connected(host));
  }

  stop(host: string, run_id: string): Promise<LongRun> {
    return this.require(host).then((agent) => agent.stop(run_id));
  }

  forget(host: string, run_id: string): Promise<void> {
    return this.require(host).then((agent) => agent.forget(run_id));
  }

  runs(host: string): Promise<LongRun[]> {
    return this.require(host).then((agent) => agent.runs());
  }

  health(host: string): Promise<HealthSample> {
    return this.require(host).then((agent) => agent.health());
  }

  private async require(host: string): Promise<Agent> {
    const agent = this.agent(host);
    if (agent === null) throw new AgentError(not_connected(host));
    return agent;
  }

  private status_of(connection: AgentConnection): AgentStatus {
    return {
      host: connection.host,
      reported_host: connection.hello.host,
      agent_version: connection.hello.agent_version,
      connected_epoch: connection.connected_epoch,
      built_in: false,
      login: this.logins.get(connection) ?? "token",
      runs: connection.hello.runs,
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function not_connected(host: string): string {
  return `No agent is connected for ${host}.`;
}

function local_status(host: string): AgentStatus {
  return { host, reported_host: host, agent_version: "built in", connected_epoch: 0, built_in: true, login: null, runs: [] };
}

function as_buffer(raw: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
}
