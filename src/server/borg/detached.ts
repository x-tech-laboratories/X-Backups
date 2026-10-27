// Detached jobs on the target: launching one so it outlives the connection, then polling its output and exit code.

import { shell_quote } from "./shell.ts";

// ── Markers ──────────────────────────────────────────────────────────────────

const size_mark = "===XBACKUPS_SIZE===";
const exit_mark = "===XBACKUPS_EXIT===";
const alive_mark = "===XBACKUPS_ALIVE===";
const output_mark = "===XBACKUPS_OUT===";

export interface PollResult {
  size: number;
  exit_code: number | null;
  alive: boolean;
  new_output: string;
}

// ── Launching ────────────────────────────────────────────────────────────────

// The job's working folder on the target, named before the job has an id.
export function workdir_for(token: string): string {
  const safe = [...token].filter((character) => /[\p{L}\p{N}._-]/u.test(character)).join("");
  return `$HOME/.cache/x_backups/jobs/${safe}`;
}

function quote_workdir(workdir: string): string {
  return workdir.startsWith("$") ? `"${workdir}"` : shell_quote(workdir);
}

// One detached command whose stdout is the job's process id.
export function launch_command(command: string, workdir: string): string {
  const inner = `{ ${command}; } > "$d/out" 2>&1; echo $? > "$d/exit"`;
  // The detached sh is a child process, so $d must be exported or it writes to "/out" and dies.
  return `export d=${quote_workdir(workdir)}; mkdir -p "$d"; : > "$d/out"; rm -f "$d/exit"; ` +
    `setsid sh -c ${shell_quote(inner)} < /dev/null > /dev/null 2>&1 & ` +
    "echo $!";
}

export function parse_launch(stdout: string): number | null {
  const trimmed = stdout.trim();
  const lines = trimmed ? trimmed.split(/\r\n|\r|\n/) : [];
  const line = lines.length > 0 ? lines[lines.length - 1] : "";
  return /^\s*[+-]?\d+\s*$/.test(line) ? Number(line) : null;
}

// Stops the job's whole process group, which setsid made with the job's pid at its head.
export function cancel_command(pid: number): string {
  return `kill -TERM -- -${Math.trunc(pid)}`;
}

// ── Polling ──────────────────────────────────────────────────────────────────

// One command giving the job's output size, exit code, liveness, and any output past the offset.
export function poll_command(workdir: string, pid: number, offset: number): string {
  const start = offset + 1;
  return `d=${quote_workdir(workdir)}; ` +
    `echo ${size_mark}; wc -c < "$d/out" 2>/dev/null || echo 0; ` +
    `echo ${exit_mark}; cat "$d/exit" 2>/dev/null; ` +
    `echo ${alive_mark}; kill -0 ${Math.trunc(pid)} 2>/dev/null && echo 1 || echo 0; ` +
    `echo ${output_mark}; tail -c +${start} "$d/out" 2>/dev/null`;
}

export function parse_poll(stdout: string): PollResult {
  const sections: Record<string, string[]> = { size: [], exit: [], alive: [], out: [] };
  const marks: Record<string, string> = {
    [size_mark]: "size",
    [exit_mark]: "exit",
    [alive_mark]: "alive",
    [output_mark]: "out",
  };
  let current: string | null = null;
  for (const line of stdout.split("\n")) {
    if (Object.hasOwn(marks, line)) {
      current = marks[line];
      continue;
    }
    if (current !== null) sections[current].push(line);
  }

  const as_int = (lines: string[]): number | null => {
    const text = lines.join("").trim();
    return /^-?\d+$/.test(text) ? Number(text) : null;
  };

  // Rejoined with newlines so a trailing partial line stays partial for split_job_output.
  return {
    size: as_int(sections.size) || 0,
    exit_code: as_int(sections.exit),
    alive: sections.alive.join("").trim() === "1",
    new_output: sections.out.join("\n"),
  };
}

// Whole lines of newly read output and how many bytes they used, leaving a trailing partial line for the next poll.
// Once the job has ended no more output follows, so that last line is taken too rather than lost; the runner trims
// stdout, so a job's final line usually arrives without its newline.
export function split_job_output(new_output: string, ended = false): [lines: string[], consumed_bytes: number] {
  if (!new_output) return [[], 0];
  if (ended) return [new_output.replace(/\n$/, "").split("\n"), Buffer.byteLength(new_output, "utf8")];
  const last_newline = new_output.lastIndexOf("\n");
  if (last_newline === -1) return [[], 0];
  // Counted in bytes, since the next poll resumes with `tail -c`.
  const consumed_bytes = Buffer.byteLength(new_output.slice(0, last_newline + 1), "utf8");
  return [new_output.slice(0, last_newline).split("\n"), consumed_bytes];
}
