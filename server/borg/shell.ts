// Shell plumbing shared by every borg call: framing several calls into one command, reading them back apart, and naming what went wrong.

import { cmd_result, type CmdResult } from "./types.ts";

// ── Names the generated shell uses ───────────────────────────────────────────

export const POLL_BASE_DIR_VAR = "__x_monitor_poll_base";
export const POLL_DEADLINE_VAR = "__x_monitor_poll_end";
export const POLL_LEFT_FN = "__x_monitor_poll_left";
export const POLL_RC_VAR = "__x_monitor_poll_rc";
const JOB_RC_VAR = "__x_monitor_job_rc";
const STEP_RC_VAR = "__x_monitor_step_rc";
const SKIP_VAR = "__x_monitor_skip";
const SKIP_MARK = "__XMONITOR_SKIP__ ";
// A job prints this before each step, and the line is its progress until borg reports its own.
export const STEP_MARK = "==> ";
const FRAME = "__XMONITOR_BORG__";
export const CUT_SHORT = "no output: the poll ended before this call ran";
// Only characters a hostname or an IP address can hold may reach a shell probe.
const safe_host = /^[A-Za-z0-9.:_-]+$/;

// ── Quoting and redaction ────────────────────────────────────────────────────

// Quotes a word for a POSIX shell, leaving plainly safe words bare.
export function shell_quote(text: string): string {
  if (text === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
  return "'" + text.replaceAll("'", `'"'"'`) + "'";
}

export function as_list(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.map((item) => String(item));
  return [String(value)];
}

export function redact(command: string): string {
  return command.replace(/(BORG_PASS(?:PHRASE|COMMAND)=)('(?:[^']|'\\'')*'|"[^"]*"|\S+)/g, "$1*****");
}

// ── Framed sequences ─────────────────────────────────────────────────────────

// The marker that separates one call's captured output from the next.
export function frame_line(index: number, stream: string, code: number | string): string {
  return `${FRAME} ${index} ${stream} ${code}`;
}

// Splits a framed transcript back into one result per call.
export function split_poll(result: CmdResult, count: number): CmdResult[] {
  const streams = new Map<number, Map<string, string>>();
  const codes = new Map<number, number>();
  let key: [index: number, stream: string] | null = null;
  let buffer: string[] = [];

  const flush = (): void => {
    if (key === null) return;
    if (!streams.has(key[0])) streams.set(key[0], new Map());
    streams.get(key[0])!.set(key[1], buffer.join("\n").trim());
  };

  for (const line of split_lines_of(result.stdout)) {
    if (!line.startsWith(FRAME + " ")) {
      buffer.push(line);
      continue;
    }
    flush();
    buffer = [];
    const fields = line.split(/\s+/).filter((field) => field !== "");
    // A live call's stdout frame comes before it ends, so its code is "-" and the stderr frame carries the real one.
    const index = parse_int(fields[1]);
    const code = fields[3] === "-" ? null : parse_int(fields[3]);
    if (index === null || fields[2] === undefined || (fields[3] !== "-" && code === null)) {
      key = null;
      continue;
    }
    key = [index, fields[2]];
    if (code !== null) codes.set(index, code);
  }
  flush();

  // No frame at all means the shell or sudo failed before the first call, so the whole transcript is that failure.
  if (codes.size === 0) {
    return [result, ...Array.from({ length: count - 1 }, () => cmd_result(result.exit_code, "", result.stderr))];
  }

  const results: CmdResult[] = [];
  for (let index = 0; index < count; index++) {
    if (!codes.has(index)) {
      results.push(cmd_result(result.exit_code || 1, "", CUT_SHORT));
      continue;
    }
    const captured = streams.get(index) ?? new Map<string, string>();
    results.push(cmd_result(codes.get(index)!, captured.get("out") ?? "", captured.get("err") ?? ""));
  }
  return results;
}

// ── Reading failures ─────────────────────────────────────────────────────────

export function failure_hint(stderr: string): string | null {
  const text = (stderr || "").toLowerCase();
  if (text.includes("permission denied (publickey)") || text.includes("publickey")) {
    return "Hint: borg could not authenticate to the repo server — set `ssh_key` to a private key on that host " +
      "which the borg server authorizes (borg makes its own SSH connection, so X-Monitor's own login key does not apply).";
  }
  if (text.includes("command not found")) {
    return "Hint: the borg binary is not on PATH for that user — under sudo it must be on root's PATH too " +
      "(set `borg_bin` to an absolute path).";
  }
  if (text.includes("a password is required") || text.includes("sudo: a terminal is required")) {
    return "Hint: sudo needs a password — grant the SSH user passwordless sudo for borg (NOPASSWD).";
  }
  if (text.includes("not allowed to set the following environment variables")) {
    return "Hint: sudoers forbids setting BORG_PASSPHRASE — the rule needs the SETENV tag to pass the passphrase through sudo.";
  }
  if (text.includes("passphrase") || text.includes("not a valid repository")) {
    return "Hint: the repo is encrypted and the passphrase was missing or wrong — check `passphrase_file` / `passphrase_command`.";
  }
  if (text.includes("permission denied")) {
    return "Hint: the SSH user cannot read the repo — add it to the repo's group or set `require_sudo: true`.";
  }
  if (text.includes("does not exist") || text.includes("no such file")) {
    return "Hint: the `repo` path does not exist on that host.";
  }
  if (text.includes("failed to create/acquire the lock")) {
    // borg locks its local chunks cache as well as the repo, and the two mean different things.
    if (text.includes("/.cache/borg/")) {
      return "Hint: the lock is on borg's local chunks cache on this host, not on the repo — another borg process " +
        "is using the same `cache_dir`. Give it a cache_dir of its own, or raise `lock_wait` past the time that process needs.";
    }
    return "Hint: the repo is locked by another borg process — a backup may be running.";
  }
  return null;
}

// True when the listing could not be gathered at all, as opposed to borg reporting a repo problem.
export function list_unavailable(exit_code: number, detail: string): boolean {
  const text = detail.toLowerCase();
  // A lock borg gave up on leaves the archives unread rather than bad.
  return exit_code === -1 || text.includes("command not found") || text.includes("permission denied") ||
    text.includes("failed to create/acquire the lock");
}

// ── Job preflight ────────────────────────────────────────────────────────────

// The host and port of an ssh:// repository, or null for a local path or a name the shell could misread.
export function ssh_endpoint(repo: string | null | undefined): [host: string, port: number] | null {
  if (!(repo || "").startsWith("ssh://")) return null;
  let parsed: URL;
  try {
    parsed = new URL(repo!);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  const port = parsed.port ? Number(parsed.port) : 22;
  if (!host || !safe_host.test(host)) return null;
  return [host, port];
}

// Shell that sets the skip variable to the first reason a job should not start, or null when there is nothing to test.
export function preflight_script(endpoint: [string, number] | null, units: string[]): string | null {
  const tests: string[] = [];
  if (endpoint) {
    const [host, port] = endpoint;
    // Reads the SSH banner rather than pinging, since a host can answer pings while its SSH hangs.
    const probe = shell_quote(`exec 3<>/dev/tcp/${host}/${port} && head -c 4 <&3`);
    const reason = shell_quote(`${host}:${port} is not answering SSH`);
    tests.push(`if ! timeout 5 bash -c ${probe} 2>/dev/null | grep -q '^SSH-'; then ${SKIP_VAR}=${reason}; fi`);
  }
  for (const unit of units) {
    const reason = shell_quote(`${unit} is running`);
    tests.push(`if [ -z "$${SKIP_VAR}" ] && systemctl is-active --quiet ${shell_quote(unit)}; ` +
      `then ${SKIP_VAR}=${reason}; fi`);
  }
  if (tests.length === 0) return null;
  return [`${SKIP_VAR}=`, ...tests].join("; ");
}

// Runs the launch only when the preflight found no reason to skip, and otherwise prints that reason.
export function with_preflight(preflight: string | null, launch: string): string {
  if (!preflight) return launch;
  return `${preflight}; if [ -n "$${SKIP_VAR}" ]; then echo "${SKIP_MARK}$${SKIP_VAR}"; else ${launch}; fi`;
}

export function skip_reason(stdout: string): string | null {
  for (const line of split_lines_of(stdout)) {
    if (line.startsWith(SKIP_MARK)) return line.slice(SKIP_MARK.length).trim();
  }
  return null;
}

// ── Job chaining and wrapping ────────────────────────────────────────────────

// Runs each step while everything so far ended in success or a borg warning, exiting with the worst status.
export function then_steps(first: string, steps: [label: string, command: string][]): string {
  if (steps.length === 0) return first;
  const parts = [`${first}; ${JOB_RC_VAR}=$?`];
  for (const [label, command] of steps) {
    parts.push(`if [ "$${JOB_RC_VAR}" -le 1 ]; then echo ${shell_quote(STEP_MARK + label)}; ${command}; ` +
      `${STEP_RC_VAR}=$?; if [ "$${STEP_RC_VAR}" -gt "$${JOB_RC_VAR}" ]; then ${JOB_RC_VAR}=$${STEP_RC_VAR}; fi; fi`);
  }
  // A plain exit would leave before the job records its status, so a subshell carries it instead.
  parts.push(`(exit "$${JOB_RC_VAR}")`);
  return parts.join("; ");
}

// Runs the whole job under the wrapper argv, saying so first when it has to wait for the lock.
export function wrap_job(command: string, wrappers: string[], lock: string | null): string {
  if (wrappers.length === 0) return command;
  const wrapped = wrappers.map(shell_quote).join(" ") + " sh -c " + shell_quote(command);
  if (!lock) return wrapped;
  const waiting = shell_quote(`${STEP_MARK}Waiting for another job to release ${lock}`);
  return `flock -n ${shell_quote(lock)} true 2>/dev/null || echo ${waiting}; ${wrapped}`;
}

// ── Archive paths ────────────────────────────────────────────────────────────

// A path as borg stores it inside an archive, or null when it could climb out of the restore folder.
export function archive_member(path: string | null | undefined): string | null {
  const member = (path || "").trim().replace(/^\/+|\/+$/g, "");
  if (member.split("/").some((part) => part === ".." || part === ".")) return null;
  return member;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Splits text into lines the way Python's splitlines does, with no empty last line for a trailing newline.
export function split_lines_of(text: string | null | undefined): string[] {
  if (!text) return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function parse_int(text: string | undefined): number | null {
  if (text === undefined || !/^[+-]?\d+$/.test(text)) return null;
  return Number(text);
}
