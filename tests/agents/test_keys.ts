// Key pairs for tests, made with ssh-keygen in a test's own folder, so no key is ever kept in the repository.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function make_key(directory: string, name: string, extra: string[] = ["-N", ""]): { private_file: string; public_line: string } {
  const private_file = join(directory, name);
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", ...extra, "-C", `x-backups-agent-${name}`, "-f", private_file], { stdio: "ignore" });
  return { private_file, public_line: readFileSync(`${private_file}.pub`, "utf8").trim() };
}
