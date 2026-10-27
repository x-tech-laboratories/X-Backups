// Time-based one-time codes (RFC 6238, the six digits an authenticator app shows), and their base32 secrets.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const step_in_seconds = 30;
const digits = 6;

// A clock this many steps off either way still counts, since phones and servers drift.
const allowed_drift_in_steps = 1;

// ── Secrets ──────────────────────────────────────────────────────────────────

export function new_secret(): string {
  return base32_encode(randomBytes(20));
}

// The link an authenticator app takes, naming the account and X-Backups as its issuer.
export function otpauth_uri(secret: string, account: string, issuer = "X-Backups"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${digits}&period=${step_in_seconds}`;
}

// ── Codes ────────────────────────────────────────────────────────────────────

export function code_at(secret: string, epoch_in_seconds: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(epoch_in_seconds / step_in_seconds)));
  const mac = createHmac("sha1", base32_decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const value = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(value).padStart(digits, "0");
}

// The step the code matches, so a caller can refuse the same code twice; null when it matches none.
export function matching_step(secret: string, code: string, epoch_in_seconds = Date.now() / 1000): number | null {
  const typed = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(typed)) return null;
  const now_step = Math.floor(epoch_in_seconds / step_in_seconds);
  for (let drift = -allowed_drift_in_steps; drift <= allowed_drift_in_steps; drift++) {
    const step = now_step + drift;
    const expected = Buffer.from(code_at(secret, step * step_in_seconds));
    if (timingSafeEqual(expected, Buffer.from(typed))) return step;
  }
  return null;
}

// ── Base32 ───────────────────────────────────────────────────────────────────

export function base32_encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let text = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      text += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) text += alphabet[(value << (5 - bits)) & 31];
  return text;
}

export function base32_decode(text: string): Buffer {
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const character of text.toUpperCase().replace(/[\s=]/g, "")) {
    const index = alphabet.indexOf(character);
    if (index === -1) throw new Error(`'${character}' is not base32`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}
