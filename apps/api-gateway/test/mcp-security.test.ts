import { describe, expect, it } from "vitest";
import { authorizeMcpRequest } from "../src/mcp-security";
import type { Env } from "../src/types";

function base64UrlEncode(input: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof input === "string"
    ? new TextEncoder().encode(input)
    : input instanceof Uint8Array
      ? input
      : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/gu, "");
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
  const kid = "mcp-access-key";
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

function fakeDb(options: {
  installation?: Record<string, unknown> | null;
  identityPrincipal?: string | null;
  profileStatus?: string | null;
} = {}): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return {
            async first() {
              if (sql.includes("FROM mcp_client_installations")) return options.installation ?? null;
              if (sql.includes("FROM user_identities")) {
                return options.identityPrincipal ? { principal: options.identityPrincipal } : null;
              }
              if (sql.includes("FROM user_profiles")) {
                const status = options.profileStatus ??
                  (options.identityPrincipal || options.installation ? "active" : null);
                return status ? { status } : null;
              }
              return null;
            },
            async run() {
              return { success: true, meta: { changes: 1 } };
            }
          };
        }
      };
    }
  } as unknown as D1Database;
}

function accessEnv(jwks: string, db: D1Database, overrides: Partial<Env> = {}): Env {
  return {
    OPEN_BRAIN_DB: db,
    ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
    ACCESS_JWKS_JSON: jwks,
    MCP_ACCESS_AUD: "mcp-aud",
    ...overrides
  } as Env;
}

describe("authorizeMcpRequest", () => {
  it("rejects when auth headers are missing", async () => {
    await expect(authorizeMcpRequest(new Request("https://example.com/mcp"), {}))
      .rejects.toThrow(/Missing MCP authentication/u);
  });

  it("keeps legacy service token auth behind explicit dual mode", async () => {
    const request = new Request("https://example.com/mcp", {
      headers: {
        "cf-access-client-id": "token-1",
        "cf-access-client-secret": "secret-1"
      }
    });
    const legacy = {
      MCP_SERVICE_TOKENS_JSON: JSON.stringify({
        tokens: [{ client_id: "token-1", client_secret: "secret-1", tenants: ["default"] }]
      })
    };
    await expect(authorizeMcpRequest(request, legacy)).rejects.toThrow(/Missing MCP authentication/u);
    await expect(authorizeMcpRequest(request, { ...legacy, MCP_AUTH_MODE: "dual" })).resolves.toMatchObject({
      principal: "service:token-1",
      tenantId: "default",
      source: "legacy-service-token"
    });
  });

  it("resolves an active Access service token to its owner and hook-only capability", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { token, jwks } = await signedAccessJwt({
      sub: "",
      common_name: "cf-client-id",
      service_token_status: true,
      aud: "mcp-aud",
      iss: "https://team.cloudflareaccess.com",
      exp: now + 600
    });
    const installation = {
      id: "install-1",
      tenant_id: "default",
      owner_principal: "user:alice",
      client_type: "codex",
      device_label: "Work Mac",
      purpose: "hook",
      status: "active",
      access_subject_hash: "ignored-by-fake",
      enrollment_token_hash: null,
      enrollment_expires_at: null,
      created_at: Date.now(),
      activated_at: Date.now(),
      last_used_at: null,
      revoked_at: null
    };
    const request = new Request("https://example.com/mcp", {
      headers: { "cf-access-jwt-assertion": token }
    });
    await expect(authorizeMcpRequest(request, accessEnv(jwks, fakeDb({ installation }))))
      .resolves.toMatchObject({
        principal: "user:alice",
        source: "access-service",
        clientInstallationId: "install-1",
        runtimeActor: "client:install-1",
        allowedTools: ["orgbrain_memories_capture_rationale"]
      });
  });

  it("rejects an unregistered Access service token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { token, jwks } = await signedAccessJwt({
      sub: "",
      common_name: "unknown-client",
      aud: "mcp-aud",
      iss: "https://team.cloudflareaccess.com",
      exp: now + 600
    });
    await expect(authorizeMcpRequest(
      new Request("https://example.com/mcp", { headers: { "cf-access-jwt-assertion": token } }),
      accessEnv(jwks, fakeDb())
    )).rejects.toThrow(/not active/u);
  });

  it("rejects an installation whose owner is no longer active", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { token, jwks } = await signedAccessJwt({
      sub: "",
      common_name: "cf-client-id",
      aud: "mcp-aud",
      iss: "https://team.cloudflareaccess.com",
      exp: now + 600
    });
    const installation = {
      id: "install-suspended",
      tenant_id: "default",
      owner_principal: "user:suspended",
      client_type: "claude",
      status: "active"
    };
    await expect(authorizeMcpRequest(
      new Request("https://example.com/mcp", { headers: { "cf-access-jwt-assertion": token } }),
      accessEnv(jwks, fakeDb({ installation, profileStatus: "suspended" }))
    )).rejects.toThrow(/owner is not active/u);
  });

  it("resolves an interactive Access user through the existing federated principal", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { token, jwks } = await signedAccessJwt({
      sub: "access-user-1",
      email: "alice@example.com",
      aud: "mcp-aud",
      iss: "https://team.cloudflareaccess.com",
      exp: now + 600
    });
    await expect(authorizeMcpRequest(
      new Request("https://example.com/mcp", { headers: { "cf-access-jwt-assertion": token } }),
      accessEnv(jwks, fakeDb({ identityPrincipal: "user:alice" }))
    )).resolves.toMatchObject({
      principal: "user:alice",
      source: "access-user",
      tenantId: "default",
      runtimeActor: "principal:user:alice"
    });
  });

  it("does not JIT-create an interactive MCP user without an existing identity", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { token, jwks } = await signedAccessJwt({
      sub: "unknown-access-user",
      email: "unknown@example.com",
      aud: "mcp-aud",
      iss: "https://team.cloudflareaccess.com",
      exp: now + 600
    });
    await expect(authorizeMcpRequest(
      new Request("https://example.com/mcp", { headers: { "cf-access-jwt-assertion": token } }),
      accessEnv(jwks, fakeDb())
    )).rejects.toThrow(/not registered/u);
  });

  it("rejects an MCP Access assertion with the wrong audience", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { token, jwks } = await signedAccessJwt({
      sub: "access-user-1",
      aud: "wrong-aud",
      iss: "https://team.cloudflareaccess.com",
      exp: now + 600
    });
    await expect(authorizeMcpRequest(
      new Request("https://example.com/mcp", { headers: { "cf-access-jwt-assertion": token } }),
      accessEnv(jwks, fakeDb())
    )).rejects.toThrow(/audience/u);
  });

  it("requires the dedicated Access issuer configuration and rejects a wrong issuer", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { token, jwks } = await signedAccessJwt({
      sub: "access-user-1",
      aud: "mcp-aud",
      iss: "https://wrong.cloudflareaccess.com",
      exp: now + 600
    });
    const request = new Request("https://example.com/mcp", {
      headers: { "cf-access-jwt-assertion": token }
    });
    await expect(authorizeMcpRequest(
      request,
      accessEnv(jwks, fakeDb(), { ACCESS_TEAM_DOMAIN: undefined })
    )).rejects.toThrow(/ACCESS_TEAM_DOMAIN is required/u);
    await expect(authorizeMcpRequest(
      request,
      accessEnv(jwks, fakeDb())
    )).rejects.toThrow(/issuer/u);
  });

  it("rejects expired, expiry-boundary, and tampered MCP Access assertions", async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = await signedAccessJwt({
      sub: "access-user-1",
      aud: "mcp-aud",
      iss: "https://team.cloudflareaccess.com",
      exp: now - 1
    });
    await expect(authorizeMcpRequest(
      new Request("https://example.com/mcp", {
        headers: { "cf-access-jwt-assertion": expired.token }
      }),
      accessEnv(expired.jwks, fakeDb())
    )).rejects.toThrow(/expired/u);

    const expiryBoundary = await signedAccessJwt({
      sub: "access-user-1",
      aud: "mcp-aud",
      iss: "https://team.cloudflareaccess.com",
      exp: Math.floor(Date.now() / 1000)
    });
    await expect(authorizeMcpRequest(
      new Request("https://example.com/mcp", {
        headers: { "cf-access-jwt-assertion": expiryBoundary.token }
      }),
      accessEnv(expiryBoundary.jwks, fakeDb())
    )).rejects.toThrow(/expired/u);

    const valid = await signedAccessJwt({
      sub: "access-user-1",
      aud: "mcp-aud",
      iss: "https://team.cloudflareaccess.com",
      exp: now + 600
    });
    const parts = valid.token.split(".");
    parts[1] = base64UrlEncode(JSON.stringify({
      sub: "access-user-2",
      aud: "mcp-aud",
      iss: "https://team.cloudflareaccess.com",
      exp: now + 600
    }));
    await expect(authorizeMcpRequest(
      new Request("https://example.com/mcp", {
        headers: { "cf-access-jwt-assertion": parts.join(".") }
      }),
      accessEnv(valid.jwks, fakeDb())
    )).rejects.toThrow(/signature/u);
  });

  it("keeps MCP Access verification independent from generic OIDC JWKS settings", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { token, jwks } = await signedAccessJwt({
      sub: "access-user-1",
      email: "alice@example.com",
      aud: "mcp-aud",
      iss: "https://team.cloudflareaccess.com",
      exp: now + 600
    });
    await expect(authorizeMcpRequest(
      new Request("https://example.com/mcp?tenant_id=access-tenant", {
        headers: { "cf-access-jwt-assertion": token }
      }),
      accessEnv(jwks, fakeDb({ identityPrincipal: "user:alice" }), {
        OIDC_ISSUER: "https://issuer.example.test",
        OIDC_AUD: "api-aud",
        OIDC_JWKS_JSON: JSON.stringify({ keys: [] }),
        OIDC_TENANT_POLICY_JSON: JSON.stringify({ default_tenants: ["oidc-tenant"] }),
        ACCESS_TENANT_POLICY_JSON: JSON.stringify({ default_tenants: ["access-tenant"] })
      })
    )).resolves.toMatchObject({
      principal: "user:alice",
      source: "access-user",
      tenantId: "access-tenant"
    });
  });
});
