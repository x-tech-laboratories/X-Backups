// One connection to the server: says hello, answers each request, and sends streamed output only as far as the
// server's credit allows. Closing it stops the streams it was sending; long runs carry on.

// ── Imports ──────────────────────────────────────────────────────────────────

import {
  encode_chunk, encode_message, parse_server_message, protocol_version,
  type AgentMessage, type RequestMessage, type ServerMessage,
} from "../shared/agent_protocol.ts";
import { type CommandStream, run_command, stream_command } from "./commands.ts";
import { read_health } from "./health.ts";
import type { LongRuns } from "./long_runs.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

export interface SessionOptions {
  host: string;
  agent_version: string;
  // A ping goes out this often, and a server silent for three of them is taken as gone.
  heartbeat_in_milliseconds: number;
}

// The smallest message a socket can send, so a test can stand in for one.
export interface MessageSocket {
  readonly readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

const socket_open = 1;

// ── Output ───────────────────────────────────────────────────────────────────

// Sends a stream's stdout as binary frames within the credit granted, then its end once all of it has gone.
class OutputPump {
  private readonly id: string;
  private readonly stream: CommandStream;
  private readonly session: AgentSession;
  private credit: number;
  private readonly pending: Buffer[] = [];
  private stdout_ended = false;
  private result: { exit_code: number; stderr: string } | null = null;
  private finished = false;

  constructor(id: string, stream: CommandStream, window: number, session: AgentSession) {
    this.id = id;
    this.stream = stream;
    this.credit = window;
    this.session = session;
    stream.stdout.on("data", (chunk: Buffer) => {
      this.pending.push(chunk);
      this.flush();
    });
    stream.stdout.on("error", () => {});
    stream.stdout.on("close", () => {
      this.stdout_ended = true;
      this.finish_when_done();
    });
    void stream.done.then((result) => {
      this.result = result;
      this.finish_when_done();
    });
  }

  grant(bytes: number): void {
    this.credit += Math.max(0, bytes);
    this.flush();
  }

  // Stops the command and drops what it had yet to send.
  cancel(): void {
    this.pending.length = 0;
    this.stream.stop();
    this.stream.stdout.resume();
  }

  private flush(): void {
    while (this.credit > 0 && this.pending.length > 0) {
      const chunk = this.pending[0];
      const piece = chunk.length > this.credit ? chunk.subarray(0, this.credit) : chunk;
      if (piece === chunk) this.pending.shift();
      else this.pending[0] = chunk.subarray(piece.length);
      this.credit -= piece.length;
      this.session.send_chunk(this.id, piece);
    }
    if (this.pending.length > 0) this.stream.stdout.pause();
    else if (!this.stdout_ended) this.stream.stdout.resume();
    this.finish_when_done();
  }

  private finish_when_done(): void {
    if (this.finished || !this.stdout_ended || this.result === null || this.pending.length > 0) return;
    this.finished = true;
    this.session.end_stream(this.id, this.result);
  }
}

// ── Session ──────────────────────────────────────────────────────────────────

export class AgentSession {
  private readonly socket: MessageSocket;
  private readonly runs: LongRuns;
  private readonly options: SessionOptions;
  private readonly pumps = new Map<string, OutputPump>();
  private last_heard = Date.now();
  private readonly heartbeat: NodeJS.Timeout;
  private closed = false;

  constructor(socket: MessageSocket, runs: LongRuns, options: SessionOptions) {
    this.socket = socket;
    this.runs = runs;
    this.options = options;
    this.heartbeat = setInterval(() => this.beat(), options.heartbeat_in_milliseconds);
    this.heartbeat.unref();
    this.send({ type: "hello", protocol: protocol_version, host: options.host, agent_version: options.agent_version, runs: runs.list() });
  }

  // Handles one text frame from the server; anything this protocol does not know is ignored.
  receive(text: string): void {
    this.last_heard = Date.now();
    const message = parse_server_message(text);
    if (message !== null) this.handle(message);
  }

  // The connection has gone: stops the streams that were being sent, since nobody reads them now.
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    for (const pump of this.pumps.values()) pump.cancel();
    this.pumps.clear();
  }

  // ── Sending ──────────────────────────────────────────────────────────────

  send(message: AgentMessage): void {
    if (!this.closed && this.socket.readyState === socket_open) this.socket.send(encode_message(message));
  }

  send_chunk(id: string, data: Buffer): void {
    if (!this.closed && this.socket.readyState === socket_open) this.socket.send(encode_chunk(id, data));
  }

  end_stream(id: string, result: { exit_code: number; stderr: string }): void {
    this.pumps.delete(id);
    this.send({ type: "stream_end", id, exit_code: result.exit_code, stderr: result.stderr });
  }

  // ── Handling ─────────────────────────────────────────────────────────────

  private handle(message: ServerMessage): void {
    switch (message.type) {
      case "ping":
        this.send({ type: "pong", epoch_ms: message.epoch_ms });
        return;
      case "pong":
        return;
      case "credit":
        this.pumps.get(message.id)?.grant(message.bytes);
        return;
      case "cancel":
        this.pumps.get(message.id)?.cancel();
        return;
      case "stream":
        this.start_pump(message.id, () => stream_command(message.command, { stdin: message.stdin }), message.window);
        return;
      case "attach":
        this.start_pump(message.id, () => this.runs.tail(message.run_id, message.offset), message.window);
        return;
      default:
        void this.answer(message);
    }
  }

  private start_pump(id: string, open: () => CommandStream, window: number): void {
    if (this.pumps.has(id)) return;
    let stream: CommandStream;
    try {
      stream = open();
    } catch (error) {
      this.send({ type: "stream_end", id, exit_code: -1, stderr: (error as Error).message });
      return;
    }
    this.pumps.set(id, new OutputPump(id, stream, window, this));
  }

  private async answer(message: RequestMessage): Promise<void> {
    try {
      const value = await this.value_for(message);
      this.send({ type: "reply", id: message.id, value });
    } catch (error) {
      this.send({ type: "failed", id: message.id, error: (error as Error).message });
    }
  }

  private async value_for(message: RequestMessage): Promise<unknown> {
    switch (message.type) {
      case "run":
        return run_command(message.command, { timeout_in_seconds: message.timeout_in_seconds, stdin: message.stdin });
      case "start":
        return this.runs.start(message.run_id, message.command, message.stdin);
      case "poll":
        return this.runs.poll(message.run_id, message.offset);
      case "stop":
        return this.runs.stop(message.run_id);
      case "forget":
        this.runs.forget(message.run_id);
        return null;
      case "runs":
        return this.runs.list();
      case "health":
        return read_health();
    }
  }

  // Pings the server, or gives up on one that has been silent for three beats.
  private beat(): void {
    if (Date.now() - this.last_heard > 3 * this.options.heartbeat_in_milliseconds) {
      this.socket.close(4008, "The server stopped answering.");
      this.close();
      return;
    }
    this.send({ type: "ping", epoch_ms: Date.now() });
  }
}
