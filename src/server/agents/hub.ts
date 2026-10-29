// The agents the server can reach, by host name: those that have dialled in over /api/agent with their host's token,
// and the one built into the server for its own machine. Everything that runs a command on a host goes through here.

// ── Imports ──────────────────────────────────────────────────────────────────

import { EventEmitter } from "node:events";

import { parse_agent_message, protocol_version, type HealthSample, type LongRun, type LongRunPoll } from "../../shared/agent_protocol.ts";
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
  // The long runs the agent knew of when it connected.
  runs: LongRun[];
}

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

  // A new token for the host, shown this once; an agent still using the old one is hung up on.
  issue_token(host: string): string {
    const token = this.tokens.issue(host);
    this.disconnect(host, close_codes.revoked, "The host's token was replaced.");
    return token;
  }

  revoke(host: string): void {
    this.tokens.revoke(host);
    this.disconnect(host, close_codes.revoked, "The host's token was revoked.");
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

  // ── Connections ──────────────────────────────────────────────────────────

  // Takes a socket whose token named the host, and waits for its hello before using it.
  accept(socket: ServerSocket, host: string): void {
    let connection: AgentConnection | null = null;
    const hello_timer = setTimeout(() => socket.close(close_codes.no_hello, "No hello came."), this.hello_timeout);

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
      this.connections.get(host)?.close(close_codes.replaced, "A newer connection from the same host replaced this one.");
      connection = new AgentConnection(socket, host, hello, this.connection_options);
      this.connections.set(host, connection);
      this.emit("connect", status_of(connection));
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
    return connection?.is_open ? status_of(connection) : null;
  }

  statuses(): AgentStatus[] {
    const remote = [...this.connections.values()].filter((connection) => connection.is_open).map(status_of);
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
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function not_connected(host: string): string {
  return `No agent is connected for ${host}.`;
}

function status_of(connection: AgentConnection): AgentStatus {
  return {
    host: connection.host,
    reported_host: connection.hello.host,
    agent_version: connection.hello.agent_version,
    connected_epoch: connection.connected_epoch,
    built_in: false,
    runs: connection.hello.runs,
  };
}

function local_status(host: string): AgentStatus {
  return { host, reported_host: host, agent_version: "built in", connected_epoch: 0, built_in: true, runs: [] };
}

function as_buffer(raw: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
}
