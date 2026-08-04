import { describe, expect, it } from "vitest";
import { AccessJwtError, accessJwtRequired, verifyConsoleAccessJwt } from "./access-jwt";

function encode(input: string | ArrayBuffer): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sign(claims: Record<string, unknown>) {
  const pair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256"
  }, true, ["sign", "verify"]);
  const kid = "console-test-key";
  const header = encode(JSON.stringify({ alg: "RS256", kid }));
  const payload = encode(JSON.stringify(claims));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    pair.privateKey,
    new TextEncoder().encode(`${header}.${payload}`)
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    token: `${header}.${payload}.${encode(signature)}`,
    jwks: JSON.stringify({ keys: [{ ...jwk, kid }] })
  };
}

describe("console Cloudflare Access JWT verification", () => {
  it("is required unless local development explicitly disables it", () => {
    expect(accessJwtRequired({})).toBe(true);
    expect(accessJwtRequired({ ACCESS_JWT_REQUIRED: "false" })).toBe(false);
  });

  it("accepts a signed token with the configured issuer and audience", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { token, jwks } = await sign({
      sub: "user-1",
      iss: "https://team.cloudflareaccess.com",
      aud: ["console-aud"],
      exp: now + 300
    });
    await expect(verifyConsoleAccessJwt({
      ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
      ACCESS_AUD: "console-aud",
      ACCESS_JWKS_JSON: jwks
    }, token)).resolves.toMatchObject({ sub: "user-1" });
  });

  it("rejects a token for another audience", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { token, jwks } = await sign({
      sub: "user-1",
      iss: "https://team.cloudflareaccess.com",
      aud: "wrong-aud",
      exp: now + 300
    });
    await expect(verifyConsoleAccessJwt({
      ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
      ACCESS_AUD: "console-aud",
      ACCESS_JWKS_JSON: jwks
    }, token)).rejects.toBeInstanceOf(AccessJwtError);
  });
});
