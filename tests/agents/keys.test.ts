import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { make_key } from "./test_keys.ts";
import { key_fingerprint, parse_private_key, parse_public_key, sign_challenge, verify_challenge } from "../../src/shared/agent_keys.ts";

let folder: string;

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), "x-backups-keys-"));
});

describe("agent keys", () => {
  it("reads a key ssh-keygen made and signs a challenge its public line verifies", () => {
    const { private_file, public_line } = make_key(folder, "odin");
    const private_key = parse_private_key(readFileSync(private_file, "utf8"));
    const public_key = parse_public_key(public_line);

    const signature = sign_challenge(private_key, "odin", "nonce-1");

    expect(verify_challenge(public_key, "odin", "nonce-1", signature)).toBe(true);
    expect(verify_challenge(public_key, "odin", "nonce-2", signature)).toBe(false);
    expect(verify_challenge(public_key, "thor", "nonce-1", signature)).toBe(false);
    expect(verify_challenge(public_key, "odin", "nonce-1", "not a signature")).toBe(false);
  });

  it("refuses another key's signature", () => {
    const first = make_key(folder, "first");
    const second = make_key(folder, "second");

    const signature = sign_challenge(parse_private_key(readFileSync(first.private_file, "utf8")), "odin", "nonce");

    expect(verify_challenge(parse_public_key(second.public_line), "odin", "nonce", signature)).toBe(false);
  });

  it("gives the fingerprint ssh-keygen prints", () => {
    const { private_file, public_line } = make_key(folder, "fingerprint");

    const printed = execFileSync("ssh-keygen", ["-l", "-f", `${private_file}.pub`], { encoding: "utf8" }).split(" ")[1];

    expect(key_fingerprint(public_line)).toBe(printed);
  });

  it("refuses an encrypted private key without quoting it", () => {
    const { private_file } = make_key(folder, "encrypted", ["-N", "a test passphrase"]);
    const text = readFileSync(private_file, "utf8");

    expect(() => parse_private_key(text)).toThrow(/encrypted with a passphrase/);
    try {
      parse_private_key(text);
    } catch (error) {
      expect((error as Error).message).not.toContain(text.split("\n")[1]);
    }
  });

  it("refuses text that is no OpenSSH private key", () => {
    expect(() => parse_private_key("hello")).toThrow(/not an OpenSSH private key/);
  });

  it("refuses a bad or non-ed25519 public line", () => {
    const { public_line } = make_key(folder, "line");
    const blob = public_line.split(" ")[1];

    expect(() => parse_public_key("")).toThrow(/OpenSSH public key line/);
    expect(() => parse_public_key("ssh-ed25519")).toThrow(/OpenSSH public key line/);
    expect(() => parse_public_key(`ssh-rsa ${blob}`)).toThrow(/must be an ssh-ed25519 key, not ssh-rsa/);
    expect(() => parse_public_key("ssh-ed25519 not*base64")).toThrow(/not base64/);
    expect(() => parse_public_key(`ssh-ed25519 ${blob.slice(0, 20)}`)).toThrow(/cut short|wrong length/);
    expect(() => parse_public_key(`ssh-ed25519 ${blob} a comment with spaces`)).not.toThrow();
  });
});
