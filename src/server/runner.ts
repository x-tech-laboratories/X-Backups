// Runs one shell command on a repository's host over a shared SSH connection, or on this machine when it has no host.

// ── Imports ──────────────────────────────────────────────────────────────────

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { cmd_result, type CmdResult } from "./borg/types.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface RunTarget {
  // No host means the command runs on this machine.
  host: string | null;
  ssh_user: string | null;
}

export interface RunOptions {
  timeout_in_seconds: number;
  stdin?: string;
  control_dir?: string;
}

export interface StreamOptions {
  stdin?: string;
  control_dir?: string;
}

// A running command whose stdout is read as it comes, rather than kept until it ends.
export interface CommandStream {
  stdout: Readable;
  // Settles once the command has ended and its stdout has been read to the end.
  done: Promise<{ exit_code: number; stderr: string }>;
  // Stops the command and everything it started, such as its ssh connection.
  stop: () => void;
}

const default_control_dir = join(tmpdir(), "x-backups-ssh");

// Give a stopped command this long to exit before it is killed outright.
const kill_grace_in_milliseconds = 5000;

// A streamed command keeps only this much of its stderr, which is all an error message needs.
const stream_stderr_limit_in_bytes = 64 * 1024;

// ── Arguments ────────────────────────────────────────────────────────────────

// A key file named by X_BACKUPS_SSH_KEY_FILE is the only key offered; otherwise ssh picks its own.
export function ssh_arguments(
  target: RunTarget & { host: string },
  command: string,
  control_dir: string,
  key_file: string | undefined = process.env.X_BACKUPS_SSH_KEY_FILE,
): string[] {
  const user_arguments = target.ssh_user === null ? [] : ["-l", target.ssh_user];
  const key_arguments = key_file ? ["-i", key_file, "-o", "IdentitiesOnly=yes"] : [];
  return [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${join(control_dir, "%C")}`,
    "-o", "ControlPersist=10m",
    ...key_arguments,
    ...user_arguments,
    "--", target.host, command,
  ];
}

// The program and its arguments that run the command where the target says.
function program_for(target: RunTarget, command: string, control_dir: string): [program: string, program_arguments: string[]] {
  if (target.host === null) return ["sh", ["-c", command]];
  mkdirSync(control_dir, { recursive: true, mode: 0o700 });
  return ["ssh", ssh_arguments({ ...target, host: target.host }, command, control_dir)];
}

// ── Running ──────────────────────────────────────────────────────────────────

// Sends the signal to the command's whole process group, which may have ended already.
function signal_group(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // The process group is already gone.
  }
}

export function run_command(target: RunTarget, command: string, options: RunOptions): Promise<CmdResult> {
  const [program, program_arguments] = program_for(target, command, options.control_dir ?? default_control_dir);

  return new Promise((resolve) => {
    // Its own process group, so a timeout stops the command's children too.
    const child = spawn(program, program_arguments, { detached: true, stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    const stdout_chunks: Buffer[] = [];
    const stderr_chunks: Buffer[] = [];
    let timed_out = false;
    let kill_timer: NodeJS.Timeout | undefined;

    const stop = (signal: NodeJS.Signals) => signal_group(child.pid, signal);

    const timeout_timer = setTimeout(() => {
      timed_out = true;
      stop("SIGTERM");
      kill_timer = setTimeout(() => stop("SIGKILL"), kill_grace_in_milliseconds);
    }, options.timeout_in_seconds * 1000);

    child.stdout!.on("data", (chunk: Buffer) => stdout_chunks.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => stderr_chunks.push(chunk));
    if (options.stdin !== undefined) {
      child.stdin!.on("error", () => {});
      child.stdin!.end(options.stdin);
    }

    child.on("error", (error) => {
      clearTimeout(timeout_timer);
      clearTimeout(kill_timer);
      resolve(cmd_result(-1, "", `Could not start ${program}: ${error.message}`));
    });

    child.on("close", (exit_code) => {
      clearTimeout(timeout_timer);
      clearTimeout(kill_timer);
      const stdout = Buffer.concat(stdout_chunks).toString("utf8").trim();
      const stderr = Buffer.concat(stderr_chunks).toString("utf8").trim();
      if (timed_out) resolve(cmd_result(-1, stdout, `Timed out after ${options.timeout_in_seconds}s`));
      else resolve(cmd_result(exit_code ?? -1, stdout, stderr));
    });
  });
}

// ── Streaming ────────────────────────────────────────────────────────────────

// Runs the command with no timeout and hands back its stdout as it comes, for output too big to hold, such as a download.
export function stream_command(target: RunTarget, command: string, options: StreamOptions = {}): CommandStream {
  const [program, program_arguments] = program_for(target, command, options.control_dir ?? default_control_dir);
  // Its own process group, so stopping it stops the command's children and its ssh too.
  const child = spawn(program, program_arguments, { detached: true, stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  const stderr_chunks: Buffer[] = [];
  let stderr_size = 0;
  let ended = false;
  let kill_timer: NodeJS.Timeout | undefined;

  child.stderr!.on("data", (chunk: Buffer) => {
    if (stderr_size >= stream_stderr_limit_in_bytes) return;
    stderr_chunks.push(chunk);
    stderr_size += chunk.length;
  });
  if (options.stdin !== undefined) {
    child.stdin!.on("error", () => {});
    child.stdin!.end(options.stdin);
  }

  const done = new Promise<{ exit_code: number; stderr: string }>((resolve) => {
    child.on("error", (error) => {
      ended = true;
      resolve({ exit_code: -1, stderr: `Could not start ${program}: ${error.message}` });
    });
    child.on("close", (exit_code) => {
      ended = true;
      clearTimeout(kill_timer);
      resolve({ exit_code: exit_code ?? -1, stderr: Buffer.concat(stderr_chunks).toString("utf8").trim() });
    });
  });

  const stop = () => {
    if (ended) return;
    signal_group(child.pid, "SIGTERM");
    // Output nobody reads any more is drained, so a full pipe cannot keep the command from ending.
    child.stdout!.resume();
    kill_timer ??= setTimeout(() => signal_group(child.pid, "SIGKILL"), kill_grace_in_milliseconds);
  };

  return { stdout: child.stdout!, done, stop };
}
