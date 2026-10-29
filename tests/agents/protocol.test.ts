import { describe, expect, it } from "vitest";
import {
  decode_chunk, encode_chunk, encode_message, is_run_id, parse_agent_message, parse_server_message, protocol_version,
  type AgentMessage, type HealthSample, type ServerMessage,
} from "../../src/shared/agent_protocol.ts";
import { check_url } from "../../src/agent/agent.ts";
import { needed } from "../../src/server/auth.ts";
import type { HostSample } from "../../src/server/host_health.ts";

const server_messages: ServerMessage[] = [
  { type: "run", id: "r1", command: "echo hi", stdin: null, timeout_in_seconds: 5 },
  { type: "start", id: "r2", run_id: "backup-1", command: "borg create", stdin: "passphrase\n" },
  { type: "poll", id: "r3", run_id: "backup-1", offset: 10 },
  { type: "stop", id: "r4", run_id: "backup-1" },
  { type: "forget", id: "r5", run_id: "backup-1" },
  { type: "runs", id: "r6" },
  { type: "health", id: "r7" },
  { type: "stream", id: "s8", command: "borg extract --stdout", stdin: null, window: 1024 },
  { type: "attach", id: "s9", run_id: "backup-1", offset: 0, window: 1024 },
  { type: "credit", id: "s8", bytes: 512 },
  { type: "cancel", id: "s8" },
  { type: "ping", epoch_ms: 1 },
  { type: "pong", epoch_ms: 1 },
];

const agent_messages: AgentMessage[] = [
  {
    type: "hello", protocol: protocol_version, host: "odin", agent_version: "0.1.0",
    runs: [{ run_id: "backup-1", pid: 42, started_epoch: 1, state: "running", exit_code: null }],
  },
  { type: "reply", id: "r1", value: { exit_code: 0, stdout: "hi", stderr: "" } },
  { type: "reply", id: "r5", value: null },
  { type: "failed", id: "r2", error: "A run named 'backup-1' already exists." },
  { type: "stream_end", id: "s8", exit_code: 0, stderr: "" },
  { type: "ping", epoch_ms: 2 },
  { type: "pong", epoch_ms: 2 },
];

describe("agent protocol", () => {
  it("reads back every server message it writes", () => {
    for (const message of server_messages) expect(parse_server_message(encode_message(message))).toEqual(message);
  });

  it("reads back every agent message it writes", () => {
    for (const message of agent_messages) expect(parse_agent_message(encode_message(message))).toEqual(message);
  });

  it("refuses text that is not a known, complete message", () => {
    expect(parse_server_message("not json")).toBeNull();
    expect(parse_server_message("[]")).toBeNull();
    expect(parse_server_message(JSON.stringify({ type: "format_disk", id: "r1" }))).toBeNull();
    expect(parse_server_message(JSON.stringify({ type: "run", id: "r1", command: "ls" }))).toBeNull();
    expect(parse_server_message(JSON.stringify({ type: "poll", id: "r1", run_id: "x", offset: "0" }))).toBeNull();
    expect(parse_agent_message(JSON.stringify({ type: "reply", id: "r1" }))).toBeNull();
    expect(parse_agent_message(JSON.stringify({ type: "hello", protocol: 1, host: "odin", agent_version: "1" }))).toBeNull();
  });

  it("tags a binary output frame with its stream id", () => {
    const data = Buffer.from([0, 1, 2, 255]);
    expect(decode_chunk(encode_chunk("s12", data))).toEqual({ id: "s12", data });
    expect(decode_chunk(encode_chunk("s1", Buffer.alloc(0)))).toEqual({ id: "s1", data: Buffer.alloc(0) });
    expect(decode_chunk(new Uint8Array([5, 1]))).toBeNull();
  });

  it("keeps run ids to names safe for a folder", () => {
    expect(is_run_id("backup-odin.2026_10_29")).toBe(true);
    for (const bad of ["", ".", "..", "../etc", "a/b", "a b", "x".repeat(129)]) expect(is_run_id(bad)).toBe(false);
  });

  it("samples health in the shape the server keeps", () => {
    const sample: HealthSample = { load1: 0.5, cpus: 4, memory_total: 8, memory_available: 4, disk_size: 100, disk_available: 50 };
    const kept: HostSample = sample;
    expect(kept).toBe(sample);
  });
});

describe("agent URL", () => {
  it("takes wss:// anywhere and ws:// only to this machine", () => {
    expect(check_url("wss://backups.example.org/api/agent").host).toBe("backups.example.org");
    for (const local of ["ws://localhost:7710/api/agent", "ws://127.0.0.1:7710/api/agent", "ws://[::1]:7710/api/agent"]) {
      expect(check_url(local).protocol).toBe("ws:");
    }
    expect(() => check_url("ws://backups.example.org/api/agent")).toThrow(/only allowed to this machine/);
    expect(() => check_url("https://backups.example.org/api/agent")).toThrow(/must start with wss/);
    expect(() => check_url("backups")).toThrow(/not a URL/);
  });

  it("is reached without a login, since the agent brings its own token", () => {
    expect(needed("GET", "/api/agent")).toBe("open");
  });
});
