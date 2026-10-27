import { describe, expect, it } from "vitest";

import { base32_decode, base32_encode, code_at, matching_step, otpauth_uri } from "../src/server/totp.ts";

// RFC 6238's SHA-1 test secret, "12345678901234567890", in base32.
const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("totp", () => {
  it("gives the RFC 6238 codes, cut to six digits", () => {
    expect(code_at(secret, 59)).toBe("287082");
    expect(code_at(secret, 1111111109)).toBe("081804");
    expect(code_at(secret, 2000000000)).toBe("279037");
  });

  it("accepts a code one step either way and nothing further", () => {
    const now = 1111111109;
    expect(matching_step(secret, code_at(secret, now - 30), now)).not.toBeNull();
    expect(matching_step(secret, code_at(secret, now + 30), now)).not.toBeNull();
    expect(matching_step(secret, code_at(secret, now - 90), now)).toBeNull();
    expect(matching_step(secret, "12345", now)).toBeNull();
    expect(matching_step(secret, "081 804", now)).toBe(Math.floor(now / 30));
  });

  it("round-trips base32 and names the account in the app link", () => {
    expect(base32_decode(secret).toString()).toBe("12345678901234567890");
    expect(base32_encode(Buffer.from("12345678901234567890"))).toBe(secret);
    expect(otpauth_uri(secret, "alice")).toContain("otpauth://totp/X-Backups%3Aalice?secret=");
  });
});
