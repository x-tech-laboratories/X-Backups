// Logs in through an OpenID Connect provider: the authorization code flow with PKCE, and a checked ID token.
//
// The provider proves who someone is; whether they may log in, and as what, is still the X-Backups user of that name.

// ── Imports ──────────────────────────────────────────────────────────────────

import { createHash, createPublicKey, randomBytes, verify as verify_signature, type JsonWebKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface OidcSettings {
  issuer: string;
  client_id: string;
  client_secret: string;
  // The public URL of /api/auth/oidc/callback, as registered with the provider.
  redirect_url: string;
  // What the login button says, such as the provider's name.
  label: string;
  // The claim holding the X-Backups user name.
  username_claim: string;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface Pending {
  nonce: string;
  verifier: string;
  expires: number;
}

export type Fetch = typeof fetch;

// A login has this long between leaving for the provider and coming back.
const pending_lifetime_ms = 10 * 60 * 1000;

// Clocks may disagree by this much when checking a token's times.
const clock_skew_in_seconds = 60;

// The JOSE algorithms accepted, with the hash and options node's verify takes for each.
const algorithms: Record<string, { hash: string; options?: object }> = {
  RS256: { hash: "sha256" },
  RS384: { hash: "sha384" },
  RS512: { hash: "sha512" },
  PS256: { hash: "sha256", options: { padding: 6, saltLength: 32 } },
  ES256: { hash: "sha256", options: { dsaEncoding: "ieee-p1363" } },
  ES384: { hash: "sha384", options: { dsaEncoding: "ieee-p1363" } },
};

// ── Settings ─────────────────────────────────────────────────────────────────

// The provider from X_BACKUPS_OIDC_*, or null when no issuer is set.
export function oidc_from_environment(environment = process.env): OidcSettings | null {
  const issuer = environment.X_BACKUPS_OIDC_ISSUER;
  if (!issuer) return null;
  const missing = ["X_BACKUPS_OIDC_CLIENT_ID", "X_BACKUPS_OIDC_CLIENT_SECRET_FILE", "X_BACKUPS_OIDC_REDIRECT_URL"].filter((name) => !environment[name]);
  if (missing.length > 0) throw new Error(`X_BACKUPS_OIDC_ISSUER is set, so ${missing.join(", ")} must be too.`);
  return {
    issuer: issuer.replace(/\/+$/, ""),
    client_id: environment.X_BACKUPS_OIDC_CLIENT_ID!,
    client_secret: readFileSync(environment.X_BACKUPS_OIDC_CLIENT_SECRET_FILE!, "utf8").trim(),
    redirect_url: environment.X_BACKUPS_OIDC_REDIRECT_URL!,
    label: environment.X_BACKUPS_OIDC_LABEL || "single sign-on",
    username_claim: environment.X_BACKUPS_OIDC_USERNAME_CLAIM || "preferred_username",
  };
}

// ── Client ───────────────────────────────────────────────────────────────────

export class OidcClient {
  readonly settings: OidcSettings;
  private readonly fetch: Fetch;
  private discovery: Discovery | null = null;
  private keys = new Map<string, KeyObject>();
  // State sent to the provider, to the nonce and PKCE verifier its answer must match; each is used once.
  private readonly pending = new Map<string, Pending>();

  constructor(settings: OidcSettings, fetch_function: Fetch = fetch) {
    this.settings = settings;
    this.fetch = fetch_function;
  }

  // Where to send the browser to log in.
  async start(): Promise<string> {
    const discovery = await this.discover();
    for (const [state, pending] of this.pending) if (pending.expires < Date.now()) this.pending.delete(state);
    const state = random_text();
    const nonce = random_text();
    const verifier = random_text();
    this.pending.set(state, { nonce, verifier, expires: Date.now() + pending_lifetime_ms });
    const url = new URL(discovery.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.settings.client_id,
      redirect_uri: this.settings.redirect_url,
      scope: "openid profile email",
      state,
      nonce,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    return url.toString();
  }

  // The user name the provider vouches for, after checking the answer belongs to a login this server started.
  async finish(state: string, code: string): Promise<string> {
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || pending.expires < Date.now()) throw new Error("That login is unknown or took too long; start again.");

    const discovery = await this.discover();
    const response = await this.fetch(discovery.token_endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${encodeURIComponent(this.settings.client_id)}:${encodeURIComponent(this.settings.client_secret)}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code", code, redirect_uri: this.settings.redirect_url, code_verifier: pending.verifier,
      }).toString(),
    });
    const answer = await response.json() as { id_token?: string; error?: string; error_description?: string };
    if (!response.ok || !answer.id_token) {
      throw new Error(`The provider refused the login: ${answer.error_description ?? answer.error ?? response.status}`);
    }
    const claims = await this.verify(answer.id_token, pending.nonce);
    const name = claims[this.settings.username_claim];
    if (typeof name !== "string" || !name) throw new Error(`The provider's token has no ${this.settings.username_claim} claim.`);
    return name;
  }

  // Checks the ID token's signature against the provider's keys, and its issuer, audience, times and nonce.
  async verify(token: string, nonce: string): Promise<Record<string, unknown>> {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("The ID token is not a JWT.");
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString()) as { alg?: string; kid?: string };
    const algorithm = algorithms[header.alg ?? ""];
    if (!algorithm) throw new Error(`The ID token is signed with ${header.alg}, which X-Backups does not accept.`);
    const key = await this.key(header.kid ?? "");
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
    const valid = verify_signature(algorithm.hash, signed, { key, ...algorithm.options }, Buffer.from(parts[2], "base64url"));
    if (!valid) throw new Error("The ID token's signature does not match the provider's keys.");

    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as Record<string, unknown>;
    const now = Date.now() / 1000;
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (String(claims.iss).replace(/\/+$/, "") !== this.settings.issuer) throw new Error("The ID token comes from another issuer.");
    if (!audience.includes(this.settings.client_id)) throw new Error("The ID token is meant for another client.");
    if (typeof claims.exp !== "number" || claims.exp + clock_skew_in_seconds < now) throw new Error("The ID token has expired.");
    if (typeof claims.iat === "number" && claims.iat - clock_skew_in_seconds > now) throw new Error("The ID token is dated in the future.");
    if (claims.nonce !== nonce) throw new Error("The ID token does not answer this login.");
    return claims;
  }

  private async discover(): Promise<Discovery> {
    if (this.discovery) return this.discovery;
    const response = await this.fetch(`${this.settings.issuer}/.well-known/openid-configuration`);
    if (!response.ok) throw new Error(`Could not read the provider's configuration: ${response.status}`);
    this.discovery = await response.json() as Discovery;
    return this.discovery;
  }

  // The provider's key with that id, fetching its key set again once when the id is new, since providers rotate keys.
  private async key(kid: string): Promise<KeyObject> {
    if (!this.keys.has(kid)) {
      const response = await this.fetch((await this.discover()).jwks_uri);
      const set = await response.json() as { keys?: (JsonWebKey & { kid?: string; use?: string })[] };
      this.keys = new Map((set.keys ?? []).filter((jwk) => jwk.use !== "enc").map((jwk) => [jwk.kid ?? "", createPublicKey({ key: jwk, format: "jwk" })]));
    }
    const key = this.keys.get(kid) ?? (kid === "" && this.keys.size === 1 ? [...this.keys.values()][0] : undefined);
    if (!key) throw new Error("The ID token names a key the provider does not publish.");
    return key;
  }
}

function random_text(): string {
  return randomBytes(32).toString("base64url");
}
