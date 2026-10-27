import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";

import { OidcClient, type Fetch, type OidcSettings } from "../src/server/oidc.ts";

const settings: OidcSettings = {
  issuer: "https://id.example.org",
  client_id: "x-backups",
  client_secret: "client secret",
  redirect_url: "https://backups.example.org/api/auth/oidc/callback",
  label: "Example ID",
  username_claim: "preferred_username",
};

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "key-1", use: "sig" };

function jwt(claims: Record<string, unknown>, kid = "key-1"): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${encode({ alg: "RS256", kid })}.${encode(claims)}`;
  return `${body}.${sign("sha256", Buffer.from(body), privateKey).toString("base64url")}`;
}

// A provider answering discovery, its key set and the token endpoint with the claims given.
function provider(claims: () => Record<string, unknown>, seen: { body?: string; authorization?: string } = {}): Fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const json = (value: object, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/.well-known/openid-configuration")) {
      return json({ issuer: settings.issuer, authorization_endpoint: `${settings.issuer}/authorize`, token_endpoint: `${settings.issuer}/token`, jwks_uri: `${settings.issuer}/jwks` });
    }
    if (url.endsWith("/jwks")) return json({ keys: [jwk] });
    if (url.endsWith("/token")) {
      seen.body = String(init?.body);
      seen.authorization = String((init?.headers as Record<string, string> | undefined)?.authorization);
      return json({ id_token: jwt(claims()) });
    }
    return json({ error: "not_found" }, 404);
  }) as Fetch;
}

function good_claims(nonce: string): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { iss: settings.issuer, aud: settings.client_id, exp: now + 300, iat: now, nonce, preferred_username: "alice" };
}

async function started(client: OidcClient): Promise<{ state: string; nonce: string; url: URL }> {
  const url = new URL(await client.start());
  return { state: url.searchParams.get("state")!, nonce: url.searchParams.get("nonce")!, url };
}

describe("oidc", () => {
  it("sends the browser to the provider with PKCE, and accepts its signed answer once", async () => {
    let nonce = "";
    const seen: { body?: string; authorization?: string } = {};
    const client = new OidcClient(settings, provider(() => good_claims(nonce), seen));

    const login = await started(client);
    nonce = login.nonce;

    expect(login.url.origin + login.url.pathname).toBe(`${settings.issuer}/authorize`);
    expect(login.url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(await client.finish(login.state, "the code")).toBe("alice");
    expect(seen.body).toContain("code_verifier=");
    expect(seen.authorization).toMatch(/^Basic /);
    await expect(client.finish(login.state, "the code")).rejects.toThrow("unknown or took too long");
  });

  it("refuses a token for another client, an expired one, or one answering another login", async () => {
    for (const [change, message] of [
      [{ aud: "someone-else" }, "another client"],
      [{ exp: Math.floor(Date.now() / 1000) - 3600 }, "expired"],
      [{ nonce: "other" }, "does not answer this login"],
      [{ iss: "https://evil.example.org" }, "another issuer"],
    ] as [Record<string, unknown>, string][]) {
      let nonce = "";
      const client = new OidcClient(settings, provider(() => ({ ...good_claims(nonce), ...change })));
      const login = await started(client);
      nonce = login.nonce;
      await expect(client.finish(login.state, "code")).rejects.toThrow(message);
    }
  });

  it("refuses a token signed by a key the provider does not publish", async () => {
    const client = new OidcClient(settings, provider(() => good_claims("n")));
    const forged = jwt(good_claims("n"), "key-2");
    await expect(client.verify(forged, "n")).rejects.toThrow("does not publish");
  });
});
