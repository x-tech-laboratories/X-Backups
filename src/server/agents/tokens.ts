// Each enrolled host's agent token. A token is shown once when it is issued, and only its digest is kept, so issuing
// a new one for a host replaces the old.

// ── Imports ──────────────────────────────────────────────────────────────────

import { randomBytes } from "node:crypto";

import { digest } from "../accounts.ts";
import type { Store } from "../store.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface AgentEnrolment {
  host: string;
  created_epoch: number;
  last_seen_epoch: number | null;
}

// ── Tokens ───────────────────────────────────────────────────────────────────

export class AgentTokens {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  // A new token for the host, replacing any it had.
  issue(host: string): string {
    const token = `xba_${randomBytes(32).toString("base64url")}`;
    this.store.run(
      "INSERT INTO agent_tokens (host, hash, created_epoch) VALUES (?, ?, ?) " +
      "ON CONFLICT (host) DO UPDATE SET hash = excluded.hash, created_epoch = excluded.created_epoch, last_seen_epoch = NULL",
      host, digest(token), now_seconds(),
    );
    return token;
  }

  revoke(host: string): void {
    this.store.run("DELETE FROM agent_tokens WHERE host = ?", host);
  }

  // The host the token belongs to, noting when it was last used, or null for a token nobody was issued.
  host_for(token: string): string | null {
    if (!token) return null;
    const row = this.store.get("SELECT host FROM agent_tokens WHERE hash = ?", digest(token));
    if (!row) return null;
    this.store.run("UPDATE agent_tokens SET last_seen_epoch = ? WHERE host = ?", now_seconds(), String(row.host));
    return String(row.host);
  }

  // Notes that the host's agent was in touch now, as when it hangs up.
  seen(host: string): void {
    this.store.run("UPDATE agent_tokens SET last_seen_epoch = ? WHERE host = ?", now_seconds(), host);
  }

  enrolments(): AgentEnrolment[] {
    return this.store.all("SELECT host, created_epoch, last_seen_epoch FROM agent_tokens ORDER BY host").map((row) => ({
      host: String(row.host),
      created_epoch: Number(row.created_epoch),
      last_seen_epoch: row.last_seen_epoch === null ? null : Number(row.last_seen_epoch),
    }));
  }
}

function now_seconds(): number {
  return Math.floor(Date.now() / 1000);
}
