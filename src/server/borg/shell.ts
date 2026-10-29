// Shell plumbing shared by every borg call: quoting, piping output while keeping the call's status, and naming what went wrong.

// ── Names the generated shell uses ───────────────────────────────────────────

export const BASE_DIR_VAR = "__x_backups_base";
export const PASSPHRASE_VAR = "__x_backups_passphrase";
const CALL_RC_VAR = "__x_backups_call_rc";
const JOB_RC_VAR = "__x_backups_job_rc";
const STEP_RC_VAR = "__x_backups_step_rc";
const SKIP_VAR = "__x_backups_skip";
const SKIP_MARK = "__XBACKUPS_SKIP__ ";
// A job prints this before each step, and the line is its progress until borg reports its own.
export const STEP_MARK = "==> ";
// Only characters a hostname or an IP address can hold may reach a shell probe.
const safe_host = /^[A-Za-z0-9.:_-]+$/;

// ── Quoting and redaction ────────────────────────────────────────────────────

// Quotes a word for a POSIX shell, leaving plainly safe words bare.
export function shell_quote(text: string): string {
  if (text === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
  return "'" + text.replaceAll("'", `'"'"'`) + "'";
}

// Runs the command only when the folder is missing or empty, else fails with 3, so it never writes over existing files.
// A subshell carries the failure, since a plain exit would leave a job's wrapper before it records its status.
export function when_folder_empty(folder: string, sudo: string, command: string): string {
  const quoted = shell_quote(folder);
  return `if [ -n "$(${sudo}find ${quoted} -mindepth 1 -maxdepth 1 2>/dev/null | head -n 1)" ]; then ` +
    `echo ${shell_quote(`Refusing to restore into ${folder}: it is not empty`)} >&2; (exit 3); else ${command}; fi`;
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

// ── Passphrase ───────────────────────────────────────────────────────────────

// Reads the passphrase from stdin before a command whose borg calls need it, so it never shows in a process list.
export function with_passphrase(command: string, options: { exported?: boolean } = {}): string {
  if (!command.includes(PASSPHRASE_VAR)) return command;
  // A long run's command runs in a shell under its wrappers, which sees the passphrase only when it is exported.
  const handoff = options.exported ? `export ${PASSPHRASE_VAR}; ` : "";
  return `IFS= read -r ${PASSPHRASE_VAR}; ${handoff}${command}`;
}

// ── Pipes ────────────────────────────────────────────────────────────────────

// Pipes a call's stdout through the reader and exits with the call's own status, which a plain pipe would replace with
// the reader's. The status travels on fd 3 while the reader's output goes out on fd 4.
export function piped(call: string, reader: string): string {
  return `{ { { ${call}; echo $? >&3; } | ${reader} >&4; } 3>&1 | (read -r ${CALL_RC_VAR}; exit "$${CALL_RC_VAR}"); } 4>&1`;
}

// ── Reading failures ─────────────────────────────────────────────────────────

export function failure_hint(stderr: string): string | null {
  const text = (stderr || "").toLowerCase();
  if (text.includes("permission denied (publickey)") || text.includes("publickey")) {
    return "Hint: borg could not authenticate to the repo server — set `ssh_key` to a private key on that host " +
      "which the borg server authorizes.";
  }
  if (text.includes("command not found")) {
    return "Hint: the borg binary is not on PATH for that user — under sudo it must be on root's PATH too " +
      "(set `borg_bin` to an absolute path).";
  }
  if (text.includes("a password is required") || text.includes("sudo: a terminal is required")) {
    return "Hint: sudo needs a password — grant the agent's user passwordless sudo for borg (NOPASSWD).";
  }
  if (text.includes("not allowed to set the following environment variables")) {
    return "Hint: sudoers forbids setting borg's environment — the rule needs the SETENV tag to pass it through sudo.";
  }
  if (text.includes("passphrase") || text.includes("not a valid repository")) {
    return "Hint: the repo is encrypted and the passphrase was missing or wrong — check `passphrase_file` / `passphrase_command`.";
  }
  if (text.includes("permission denied")) {
    return "Hint: the agent's user cannot read the repo — add it to the repo's group or set `require_sudo: true`.";
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

// Runs the rest of its arguments under systemd-inhibit where the host has it, and plainly where it does not; its $0 is
// the reason the inhibitor shows.
export const INHIBIT_SCRIPT = 'if command -v systemd-inhibit >/dev/null 2>&1; then ' +
  'exec systemd-inhibit --who=X-Backups --what=sleep:shutdown "--why=$0" "$@"; else exec "$@"; fi';

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
