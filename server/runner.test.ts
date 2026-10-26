import { describe, expect, it } from "vitest";
import { run_command, ssh_arguments } from "./runner.ts";

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

  it("builds a multiplexed ssh call", () => {
    const arguments_list = ssh_arguments({ host: "nas", ssh_user: "backup" }, "borg list", "/run/ssh");

    expect(arguments_list).toContain("ControlPath=/run/ssh/%C");
    expect(arguments_list.slice(-5)).toEqual(["-l", "backup", "--", "nas", "borg list"]);
  });
});
