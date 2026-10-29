// One connected agent, as the server sees it: sends it requests and matches each reply by id, and turns its streamed
// output back into a readable stream, granting the agent more credit only as the reader takes what has come.

// ── Imports ──────────────────────────────────────────────────────────────────

import { Readable } from "node:stream";

import {
  decode_chunk, encode_message, parse_agent_message,
  type AgentMessage, type HealthSample, type LongRun, type LongRunPoll, type RequestType, type Requests, type ServerMessage,
} from "../../shared/agent_protocol.ts";
import { cmd_result, type CmdResult } from "../borg/types.ts";
import { AgentError, type Agent, type AgentRunOptions, type AgentStreamOptions, type CommandStream } from "./agent.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

// The server end of an agent's WebSocket, as the ws library hands it over.
export interface ServerSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: Buffer | ArrayBuffer | Buffer[], is_binary: boolean) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface ConnectionOptions {
  // How far a stream's output may run ahead of its reader.
  window_in_bytes: number;
  // How long a request other than a run waits for its reply.
  request_timeout_in_milliseconds: number;
  heartbeat_in_milliseconds: number;
}

type Hello = Extract<AgentMessage, { type: "hello" }>;

const socket_open = 1;

// A run's reply may come this long after its own timeout, which the agent enforces, before the server gives up.
const run_reply_slack_in_milliseconds = 30_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

// ── Incoming streams ─────────────────────────────────────────────────────────

// A stream's output arriving from the agent, readable as it comes.
class IncomingStream {
  readonly stdout: Readable;
  readonly done: Promise<{ exit_code: number; stderr: string }>;
  private readonly id: string;
  private readonly connection: AgentConnection;
  private readonly window: number;
  // Credit the agent still holds: bytes it may send before it hears from us again.
  private outstanding: number;
  private reader_full = false;
  private result: { exit_code: number; stderr: string } | null = null;
  private stdout_closed = false;
  private settle!: (result: { exit_code: number; stderr: string }) => void;

  constructor(id: string, connection: AgentConnection, window: number) {
    this.id = id;
    this.connection = connection;
    this.window = window;
    this.outstanding = window;
    this.done = new Promise((resolve) => (this.settle = resolve));
    this.stdout = new Readable({
      read: () => {
        this.reader_full = false;
        this.grant();
      },
      destroy: (error, callback) => {
        if (this.result === null) this.connection.send({ type: "cancel", id: this.id });
        callback(error);
      },
    });
    this.stdout.on("close", () => {
      this.stdout_closed = true;
      this.settle_when_done();
    });
  }

  receive(data: Buffer): void {
    this.outstanding -= data.length;
    if (this.result !== null || this.stdout.destroyed) return;
    if (!this.stdout.push(data)) this.reader_full = true;
    this.grant();
  }

  end(result: { exit_code: number; stderr: string }): void {
    if (this.result !== null) return;
    this.result = result;
    if (!this.stdout.destroyed) this.stdout.push(null);
    this.settle_when_done();
  }

  stop(): void {
    this.stdout.destroy();
  }

  // Tops the agent's credit back up once half of it has been read.
  private grant(): void {
    if (this.reader_full || this.result !== null || this.outstanding > this.window / 2) return;
    this.connection.send({ type: "credit", id: this.id, bytes: this.window - this.outstanding });
    this.outstanding = this.window;
  }

  private settle_when_done(): void {
    if (this.result !== null && this.stdout_closed) this.settle(this.result);
  }
}

// ── Connection ───────────────────────────────────────────────────────────────

export class AgentConnection implements Agent {
  readonly host: string;
  readonly hello: Hello;
  readonly connected_epoch = Math.floor(Date.now() / 1000);
  private readonly socket: ServerSocket;
  private readonly options: ConnectionOptions;
  private readonly pending = new Map<string, Pending>();
  private readonly streams = new Map<string, IncomingStream>();
  private next_id = 1;
  private last_heard = Date.now();
  private readonly heartbeat: NodeJS.Timeout;
  private closed_reason: string | null = null;

  constructor(socket: ServerSocket, host: string, hello: Hello, options: ConnectionOptions) {
    this.socket = socket;
    this.host = host;
    this.hello = hello;
    this.options = options;
    this.heartbeat = setInterval(() => this.beat(), options.heartbeat_in_milliseconds);
    this.heartbeat.unref();
  }

  get is_open(): boolean {
    return this.closed_reason === null;
  }

  // ── Agent ────────────────────────────────────────────────────────────────

  async run(command: string, options: AgentRunOptions): Promise<CmdResult> {
    try {
      const timeout = options.timeout_in_seconds * 1000 + run_reply_slack_in_milliseconds;
      const result = await this.request("run", { command, stdin: options.stdin ?? null, timeout_in_seconds: options.timeout_in_seconds }, timeout);
      return cmd_result(result.exit_code, result.stdout, result.stderr);
    } catch (error) {
      return cmd_result(-1, "", (error as Error).message);
    }
  }

  stream(command: string, options: AgentStreamOptions = {}): CommandStream {
    return this.open_stream((id, window) => ({ type: "stream", id, command, stdin: options.stdin ?? null, window }));
  }

  start(run_id: string, command: string, options: AgentStreamOptions = {}): Promise<LongRun> {
    return this.request("start", { run_id, command, stdin: options.stdin ?? null });
  }

  poll(run_id: string, offset: number): Promise<LongRunPoll> {
    return this.request("poll", { run_id, offset });
  }

  attach(run_id: string, offset: number): CommandStream {
    return this.open_stream((id, window) => ({ type: "attach", id, run_id, offset, window }));
  }

  stop(run_id: string): Promise<LongRun> {
    return this.request("stop", { run_id });
  }

  async forget(run_id: string): Promise<void> {
    await this.request("forget", { run_id });
  }

  runs(): Promise<LongRun[]> {
    return this.request("runs", {});
  }

  health(): Promise<HealthSample> {
    return this.request("health", {});
  }

  // ── Socket ───────────────────────────────────────────────────────────────

  send(message: ServerMessage): void {
    if (this.is_open && this.socket.readyState === socket_open) this.socket.send(encode_message(message));
  }

  // Handles one frame from the agent after its hello.
  receive(data: Buffer, is_binary: boolean): void {
    this.last_heard = Date.now();
    if (is_binary) {
      const chunk = decode_chunk(data);
      if (chunk !== null) this.streams.get(chunk.id)?.receive(chunk.data);
      return;
    }
    const message = parse_agent_message(data.toString("utf8"));
    if (message === null) return;
    switch (message.type) {
      case "ping":
        this.send({ type: "pong", epoch_ms: message.epoch_ms });
        return;
      case "reply":
      case "failed": {
        const pending = this.pending.get(message.id);
        if (pending === undefined) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.type === "reply") pending.resolve(message.value);
        else pending.reject(new AgentError(message.error));
        return;
      }
      case "stream_end":
        this.streams.get(message.id)?.end({ exit_code: message.exit_code, stderr: message.stderr });
        this.streams.delete(message.id);
        return;
      default:
        return;
    }
  }

  // Fails what was waiting and ends each stream; the agent's long runs carry on.
  closed(reason: string): void {
    if (this.closed_reason !== null) return;
    this.closed_reason = reason;
    clearInterval(this.heartbeat);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AgentError(reason));
    }
    this.pending.clear();
    for (const stream of this.streams.values()) stream.end({ exit_code: -1, stderr: reason });
    this.streams.clear();
  }

  close(code: number, reason: string): void {
    this.socket.close(code, reason);
    this.closed(reason);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private request<K extends RequestType>(type: K, body: Requests[K]["body"], timeout = this.options.request_timeout_in_milliseconds): Promise<Requests[K]["reply"]> {
    if (!this.is_open) return Promise.reject(new AgentError(this.closed_reason!));
    const id = `r${this.next_id++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AgentError(`The agent on ${this.host} did not answer within ${Math.round(timeout / 1000)}s.`));
      }, timeout);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.send({ type, id, ...body } as ServerMessage);
    });
  }

  private open_stream(message: (id: string, window: number) => ServerMessage): CommandStream {
    const id = `s${this.next_id++}`;
    const stream = new IncomingStream(id, this, this.options.window_in_bytes);
    if (!this.is_open) {
      stream.end({ exit_code: -1, stderr: this.closed_reason! });
    } else {
      this.streams.set(id, stream);
      this.send(message(id, this.options.window_in_bytes));
    }
    return { stdout: stream.stdout, done: stream.done, stop: () => stream.stop() };
  }

  // Pings the agent, or drops one that has been silent for three beats.
  private beat(): void {
    if (Date.now() - this.last_heard > 3 * this.options.heartbeat_in_milliseconds) {
      this.close(4008, `The agent on ${this.host} stopped answering.`);
      return;
    }
    this.send({ type: "ping", epoch_ms: Date.now() });
  }
}
