import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { apiKeyAuth, assertApiTenantAccess, getApiAuthContext, type ApiContextEnv } from "../src/auth";
import type { Env } from "../src/types";

function buildApp() {
  const app = new Hono<ApiContextEnv>();
  app.use("*", apiKeyAuth);
  app.get("/tenant", (c) => c.json({ tenant: assertApiTenantAccess(c, c.req.query("tenant_id")) }));
  app.get("/principal", (c) => c.json(getApiAuthContext(c)));
  app.onError((error, c) => {
    const maybeStatus = (error as unknown as { status?: unknown }).status;
    const status = typeof maybeStatus === "number" ? maybeStatus : 500;
    return c.json({ error: error instanceof Error ? error.message : String(error) }, status as 500);
  });
  return app;
}

function base64UrlEncode(input: ArrayBuffer | Uint8Array | string): string {
  const bytes =
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : input instanceof Uint8Array
        ? input
        : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function signedAccessJwt(claims: Record<string, unknown>) {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256"
    },
    true,
    ["sign", "verify"]
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const kid = "test-access-key";
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const payload = base64UrlEncode(JSON.stringify(claims));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    new TextEncoder().encode(`${header}.${payload}`)
  );
  return {
    token: `${header}.${payload}.${base64UrlEncode(signature)}`,
    jwks: JSON.stringify({ keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }] })
  };
}

describe("api tenant auth", () => {
  it("allows default tenant without an explicit policy", async () => {
    const app = buildApp();
    const response = await app.fetch(
      new Request("https://example.test/tenant?tenant_id=default", { headers: { "x-api-key": "secret" } }),
      { API_KEY: "secret" } as Env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tenant: "default" });
  });

  it("rejects non-default tenant without an explicit policy", async () => {
    const app = buildApp();
    const response = await app.fetch(
      new Request("https://example.test/tenant?tenant_id=team-a", { headers: { "x-api-key": "secret" } }),
      { API_KEY: "secret" } as Env
    );

    expect(response.status).toBe(403);
  });

  it("allows configured API keys only for granted tenants", async () => {
    const app = buildApp();
    const env = {
      API_KEY: "default-secret",
      API_TENANT_POLICY_JSON: JSON.stringify({
        keys: [{ api_key: "team-secret", principal: "service:test", tenants: ["team-a"] }]
      })
    } as Env;

    const allowed = await app.fetch(
      new Request("https://example.test/tenant?tenant_id=team-a", { headers: { "x-api-key": "team-secret" } }),
      env
    );
    const denied = await app.fetch(
      new Request("https://example.test/tenant?tenant_id=team-b", { headers: { "x-api-key": "team-secret" } }),
      env
    );

    expect(allowed.status).toBe(200);
    expect(denied.status).toBe(403);
  });

  it("stores the resolved API key principal in context", async () => {
    const app = buildApp();
    const env = {
      API_TENANT_POLICY_JSON: JSON.stringify({
        keys: [{ api_key: "alice-secret", principal: "user:alice@example.com", tenants: ["default", "team-a"] }]
      })
    } as Env;

    const response = await app.fetch(
      new Request("https://example.test/principal", { headers: { "x-api-key": "alice-secret" } }),
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      principal: "user:alice@example.com",
      allowedTenants: ["default", "team-a"]
    });
  });

  it("accepts a valid Cloudflare Access JWT and resolves tenant grants", async () => {
    const app = buildApp();
    const now = Math.floor(Date.now() / 1000);
    const { token, jwks } = await signedAccessJwt({
      sub: "access-user-123",
      email: "alice@example.com",
      name: "Alice",
      aud: "aud-test",
      iss: "https://team.cloudflareaccess.com",
      exp: now + 600
    });
    const env = {
      ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
      ACCESS_AUD: "aud-test",
      ACCESS_JWKS_JSON: jwks,
      ACCESS_TENANT_POLICY_JSON: JSON.stringify({
        email_domains: { "example.com": ["default", "team-a"] }
      })
    } as Env;

    const response = await app.fetch(
      new Request("https://example.test/principal", {
        headers: { "cf-access-jwt-assertion": token }
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      principal: "user:access-user-123",
      source: "access-jwt",
      allowedTenants: ["default", "team-a"],
      email: "alice@example.com",
      displayName: "Alice"
    });
  });
});
