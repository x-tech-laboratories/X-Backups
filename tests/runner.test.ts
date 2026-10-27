import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { run_command, ssh_arguments, stream_command } from "../src/server/runner.ts";

const local = { host: null, ssh_user: null };

describe("runner", () => {
  it("runs a local command and keeps its output and exit code", async () => {
    const result = await run_command(local, "echo out; echo err >&2; exit 3", { timeout_in_seconds: 5 });

    expect(result).toEqual({ exit_code: 3, stdout: "out", stderr: "err" });
  });

  it("feeds stdin to the command", async () => {
    const result = await run_command(local, "cat", { timeout_in_seconds: 5, stdin: "secret\n" });

    expect(result.stdout).toBe("secret");
  });

  it("kills a command that runs past its timeout", async () => {
    const result = await run_command(local, "sleep 30", { timeout_in_seconds: 0.2 });

    expect(result).toEqual({ exit_code: -1, stdout: "", stderr: "Timed out after 0.2s" });
  });

  it("streams a local command's stdout and settles with its exit code and stderr", async () => {
    const stream = stream_command(local, "cat; printf 'more'; echo warn >&2; exit 1", { stdin: "secret\n" });
    const chunks: Buffer[] = [];
    stream.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

    const ended = await stream.done;

    expect(Buffer.concat(chunks).toString()).toBe("secret\nmore");
    expect(ended).toEqual({ exit_code: 1, stderr: "warn" });
  });

  it("stops a streamed command and its children", async () => {
    const stream = stream_command(local, "sleep 30 & wait");
    stream.stdout.on("data", () => {});

    stream.stop();
    const ended = await stream.done;

    expect(ended.exit_code).toBe(-1);
  });

  it("ends a stopped stream even while its output is piped to a reader that stopped reading", async () => {
    const stream = stream_command(local, "yes x-backups");
    // A writable that never finishes a write, like a browser that paused a download.
    const stuck = new Writable({ highWaterMark: 16, write: () => {} });
    stream.stdout.pipe(stuck);
    await new Promise((resolve) => setTimeout(resolve, 100));

    stream.stop();
    const ended = await stream.done;

    expect(ended.exit_code).not.toBe(0);
  });

  it("builds a multiplexed ssh call", () => {
    const arguments_list = ssh_arguments({ host: "nas", ssh_user: "backup" }, "borg list", "/run/ssh", "");

    expect(arguments_list).toContain("ControlPath=/run/ssh/%C");
    expect(arguments_list).not.toContain("-i");
    expect(arguments_list.slice(-5)).toEqual(["-l", "backup", "--", "nas", "borg list"]);
  });

  it("offers only the configured key", () => {
    const arguments_list = ssh_arguments({ host: "nas", ssh_user: null }, "borg list", "/run/ssh", "/run/key");

    expect(arguments_list.slice(-7)).toEqual(["-i", "/run/key", "-o", "IdentitiesOnly=yes", "--", "nas", "borg list"]);
  });
});
