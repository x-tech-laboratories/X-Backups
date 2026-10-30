// The messages the server and an agent exchange over the agent's WebSocket, shared by both sides.
//
// Every message but a stream's output is one JSON text frame with a `type`. A request from the server carries an `id`
// the agent answers with one `reply` or `failed` of the same id. A stream or an attach sends its output as binary
// frames tagged with its id, only as far as the credit the server has granted, then one `stream_end`. Either side
// sends `ping` while idle and drops a connection that has been silent too long.
//
// An agent logging in with its host's key, rather than a token, names the host in the upgrade; the server's first
// message is then a `challenge`, and the agent's hello carries its signature of that nonce (see agent_keys.ts).

// ── Version ──────────────────────────────────────────────────────────────────

export const protocol_version = 1;

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface RunResult {
  exit_code: number;
  stdout: string;
  stderr: string;
}

// How loaded a host is, in the shape the server keeps host samples in.
export interface HealthSample {
  load1: number;
  cpus: number;
  memory_total: number;
  memory_available: number;
  disk_size: number;
  disk_available: number;
}

export type LongRunState = "running" | "exited" | "stopped" | "lost";

// A command the agent keeps going on its own, which outlives the connection and the agent.
export interface LongRun {
  run_id: string;
  pid: number;
  started_epoch: number;
  // Lost means it ended with no exit code written, as when the host rebooted under it.
  state: LongRunState;
  exit_code: number | null;
}

// What a long run has written since an offset, and whether it is still going.
export interface LongRunPoll {
  state: LongRunState;
  exit_code: number | null;
  alive: boolean;
  // The size of its whole output in bytes.
  size: number;
  new_output: string;
  // Where the next poll starts, which is short of `size` when a poll returns only part of the output.
  next_offset: number;
}

// ── Server to agent ──────────────────────────────────────────────────────────

// Each request the server makes and what its reply carries.
export interface Requests {
  run: { body: { command: string; stdin: string | null; timeout_in_seconds: number }; reply: RunResult };
  start: { body: { run_id: string; command: string; stdin: string | null }; reply: LongRun };
  poll: { body: { run_id: string; offset: number }; reply: LongRunPoll };
  stop: { body: { run_id: string }; reply: LongRun };
  forget: { body: { run_id: string }; reply: null };
  runs: { body: Record<never, never>; reply: LongRun[] };
  health: { body: Record<never, never>; reply: HealthSample };
}

export type RequestType = keyof Requests;

export type RequestMessage = {
  [K in RequestType]: { type: K; id: string } & Requests[K]["body"];
}[RequestType];

export type ServerMessage =
  | RequestMessage
  // Runs a command and sends its stdout as it comes, `window` bytes ahead of the credit that follows.
  | { type: "stream"; id: string; command: string; stdin: string | null; window: number }
  // Follows a long run's output from an offset until it ends, as a stream does.
  | { type: "attach"; id: string; run_id: string; offset: number; window: number }
  | { type: "credit"; id: string; bytes: number }
  // Stops a stream or an attach; the agent still ends it with a stream_end.
  | { type: "cancel"; id: string }
  | { type: "ping"; epoch_ms: number }
  | { type: "pong"; epoch_ms: number }
  // Sent first to an agent logging in with its key, which signs the nonce in its hello.
  | { type: "challenge"; nonce: string };

// ── Agent to server ──────────────────────────────────────────────────────────

export type AgentMessage =
  // An agent logging in with its key adds its signature of the challenge.
  | { type: "hello"; protocol: number; host: string; agent_version: string; runs: LongRun[]; signature?: string }
  | { type: "reply"; id: string; value: unknown }
  | { type: "failed"; id: string; error: string }
  | { type: "stream_end"; id: string; exit_code: number; stderr: string }
  | { type: "ping"; epoch_ms: number }
  | { type: "pong"; epoch_ms: number };

// ── Checking ─────────────────────────────────────────────────────────────────

type FieldKind = "string" | "number" | "string_or_null" | "array" | "any";

const id_fields = { id: "string" } as const;
const run_fields = { ...id_fields, run_id: "string" } as const;

const server_fields: Record<ServerMessage["type"], Record<string, FieldKind>> = {
  run: { ...id_fields, command: "string", stdin: "string_or_null", timeout_in_seconds: "number" },
  start: { ...run_fields, command: "string", stdin: "string_or_null" },
  poll: { ...run_fields, offset: "number" },
  stop: run_fields,
  forget: run_fields,
  runs: id_fields,
  health: id_fields,
  stream: { ...id_fields, command: "string", stdin: "string_or_null", window: "number" },
  attach: { ...run_fields, offset: "number", window: "number" },
  credit: { ...id_fields, bytes: "number" },
  cancel: id_fields,
  ping: { epoch_ms: "number" },
  pong: { epoch_ms: "number" },
  challenge: { nonce: "string" },
};

const agent_fields: Record<AgentMessage["type"], Record<string, FieldKind>> = {
  hello: { protocol: "number", host: "string", agent_version: "string", runs: "array" },
  reply: { ...id_fields, value: "any" },
  failed: { ...id_fields, error: "string" },
  stream_end: { ...id_fields, exit_code: "number", stderr: "string" },
  ping: { epoch_ms: "number" },
  pong: { epoch_ms: "number" },
};

function has_kind(value: unknown, kind: FieldKind): boolean {
  if (kind === "any") return value !== undefined;
  if (kind === "array") return Array.isArray(value);
  if (kind === "string_or_null") return value === null || typeof value === "string";
  if (kind === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === kind;
}

function parse_with<T>(text: string, fields: Record<string, Record<string, FieldKind>>): T | null {
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof message !== "object" || message === null) return null;
  const type = (message as { type?: unknown }).type;
  if (typeof type !== "string" || !Object.hasOwn(fields, type)) return null;
  const record = message as Record<string, unknown>;
  for (const [name, kind] of Object.entries(fields[type])) {
    if (!has_kind(record[name], kind)) return null;
  }
  return message as T;
}

// A message from the server, or null for one this protocol does not know.
export function parse_server_message(text: string): ServerMessage | null {
  return parse_with<ServerMessage>(text, server_fields);
}

// A message from an agent, or null for one this protocol does not know.
export function parse_agent_message(text: string): AgentMessage | null {
  return parse_with<AgentMessage>(text, agent_fields);
}

export function encode_message(message: ServerMessage | AgentMessage): string {
  return JSON.stringify(message);
}

// ── Output frames ────────────────────────────────────────────────────────────

// A binary frame is one byte giving the id's length, the id, then the output bytes.
export function encode_chunk(id: string, data: Uint8Array): Buffer {
  const id_bytes = Buffer.from(id, "utf8");
  if (id_bytes.length > 255) throw new Error("A stream id is at most 255 bytes.");
  return Buffer.concat([Buffer.from([id_bytes.length]), id_bytes, data]);
}

export function decode_chunk(frame: Uint8Array): { id: string; data: Buffer } | null {
  const bytes = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  if (bytes.length < 1 || bytes.length < 1 + bytes[0]) return null;
  return { id: bytes.subarray(1, 1 + bytes[0]).toString("utf8"), data: bytes.subarray(1 + bytes[0]) };
}

// ── Key login ────────────────────────────────────────────────────────────────

// The upgrade header an agent logging in with its key names its host in.
export const key_host_header = "x-backups-agent-host";

// ── Long run ids ─────────────────────────────────────────────────────────────

// A long run's id names its folder on the agent, so it is kept to safe characters.
export function is_run_id(value: string): boolean {
  return /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(value);
}
