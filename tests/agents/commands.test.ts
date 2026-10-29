import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { run_command, stream_command } from "../../src/agent/commands.ts";

describe("commands", () => {
  it("runs a local command and keeps its output and exit code", async () => {
    const result = await run_command("echo out; echo err >&2; exit 3", { timeout_in_seconds: 5 });

    expect(result).toEqual({ exit_code: 3, stdout: "out", stderr: "err" });
  });

  it("feeds stdin to the command", async () => {
    const result = await run_command("cat", { timeout_in_seconds: 5, stdin: "secret\n" });

    expect(result.stdout).toBe("secret");
  });

  it("kills a command that runs past its timeout", async () => {
    const result = await run_command("sleep 30", { timeout_in_seconds: 0.2 });

    expect(result).toEqual({ exit_code: -1, stdout: "", stderr: "Timed out after 0.2s" });
  });

  it("streams a local command's stdout and settles with its exit code and stderr", async () => {
    const stream = stream_command("cat; printf 'more'; echo warn >&2; exit 1", { stdin: "secret\n" });
    const chunks: Buffer[] = [];
    stream.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

    const ended = await stream.done;

    expect(Buffer.concat(chunks).toString()).toBe("secret\nmore");
    expect(ended).toEqual({ exit_code: 1, stderr: "warn" });
  });

  it("stops a streamed command and its children", async () => {
    const stream = stream_command("sleep 30 & wait");
    stream.stdout.on("data", () => {});

    stream.stop();
    const ended = await stream.done;

    expect(ended.exit_code).toBe(-1);
  });

  it("ends a stopped stream even while its output is piped to a reader that stopped reading", async () => {
    const stream = stream_command("yes x-backups");
    // A writable that never finishes a write, like a browser that paused a download.
    const stuck = new Writable({ highWaterMark: 16, write: () => {} });
    stream.stdout.pipe(stuck);
    await new Promise((resolve) => setTimeout(resolve, 100));

    stream.stop();
    const ended = await stream.done;

    expect(ended.exit_code).not.toBe(0);
  });
});
