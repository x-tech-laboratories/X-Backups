// Runs one shell command on a repository's host over a shared SSH connection, or on this machine when it has no host.

// ── Imports ──────────────────────────────────────────────────────────────────

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const default_control_dir = join(tmpdir(), "x-backups-ssh");

// Give a stopped command this long to exit before it is killed outright.
const kill_grace_in_milliseconds = 5000;

// ── Arguments ────────────────────────────────────────────────────────────────

export function ssh_arguments(target: RunTarget & { host: string }, command: string, control_dir: string): string[] {
  const user_arguments = target.ssh_user === null ? [] : ["-l", target.ssh_user];
  return [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${join(control_dir, "%C")}`,
    "-o", "ControlPersist=10m",
    ...user_arguments,
    "--", target.host, command,
  ];
}

// ── Running ──────────────────────────────────────────────────────────────────

export function run_command(target: RunTarget, command: string, options: RunOptions): Promise<CmdResult> {
  const control_dir = options.control_dir ?? default_control_dir;
  const [program, program_arguments] = target.host === null
    ? ["sh", ["-c", command]]
    : ["ssh", ssh_arguments({ ...target, host: target.host }, command, control_dir)];
  if (target.host !== null) mkdirSync(control_dir, { recursive: true, mode: 0o700 });

  return new Promise((resolve) => {
    // Its own process group, so a timeout stops the command's children too.
    const child = spawn(program, program_arguments, { detached: true, stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    const stdout_chunks: Buffer[] = [];
    const stderr_chunks: Buffer[] = [];
    let timed_out = false;
    let kill_timer: NodeJS.Timeout | undefined;

    const stop = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, signal);
      } catch {
        // The process group is already gone.
      }
    };

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
