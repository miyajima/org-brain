import { HttpError } from "@org-brain/shared";
import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "./types";

type ApiTenantPolicy = {
  keys?: Array<{
    api_key?: string;
    key?: string;
    principal?: string;
    tenants?: string[];
  }>;
  api_keys?: Array<{
    api_key?: string;
    key?: string;
    principal?: string;
    tenants?: string[];
  }>;
  default_tenants?: string[];
};

type ApiKeyGrant = {
  principal: string;
  allowedTenants: string[];
  source: "api-key" | "access-jwt";
  email?: string | null;
  displayName?: string | null;
};

export type ApiAuthContext = ApiKeyGrant;

export type ApiContextEnv = {
  Bindings: Env;
  Variables: {
    apiAuth: ApiAuthContext;
  };
};

function normalizeTenantList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return [
    ...new Set(
      input
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ];
}

function parseApiTenantPolicy(raw: string | undefined): ApiTenantPolicy | null {
  if (!raw || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as ApiTenantPolicy;
  } catch {
    throw new HttpError(500, "misconfigured", "API_TENANT_POLICY_JSON is not valid JSON");
  }
}

type AccessClaims = {
  sub?: string;
  email?: string;
  name?: string;
  aud?: string | string[];
  iss?: string;
  exp?: number;
  nbf?: number;
};

type AccessTenantPolicy = {
  principals?: Record<string, string[]>;
  email_domains?: Record<string, string[]>;
  default_tenants?: string[];
};

type AccessJwk = JsonWebKey & { kid?: string };

function parseAccessTenantPolicy(raw: string | undefined): AccessTenantPolicy | null {
  if (!raw || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as AccessTenantPolicy;
  } catch {
    throw new HttpError(500, "misconfigured", "ACCESS_TENANT_POLICY_JSON is not valid JSON");
  }
}

function constantTimeEquals(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const maxLength = Math.max(leftBytes.length, rightBytes.length);
  let mismatch = leftBytes.length === rightBytes.length ? 0 : 1;
  for (let index = 0; index < maxLength; index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return mismatch === 0;
}

function resolveApiKeyGrant(env: Env, provided: string): ApiKeyGrant | null {
  const policy = parseApiTenantPolicy(env.API_TENANT_POLICY_JSON);
  const entries = [...(policy?.keys ?? []), ...(policy?.api_keys ?? [])];

  for (const entry of entries) {
    const expected = entry.api_key?.trim() || entry.key?.trim();
    if (!expected || !constantTimeEquals(expected, provided)) continue;
    const allowedTenants = normalizeTenantList(entry.tenants);
    return {
      principal: entry.principal?.trim() || "api-key",
      allowedTenants: allowedTenants.length > 0 ? allowedTenants : normalizeTenantList(policy?.default_tenants),
      source: "api-key"
    };
  }

  if (env.API_KEY && constantTimeEquals(env.API_KEY, provided)) {
    return {
      principal: "api-key:default",
      allowedTenants: policy ? normalizeTenantList(policy.default_tenants) : ["default"],
      source: "api-key"
    };
  }

  return null;
}

function base64UrlDecode(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function parseJwtPart<T>(part: string, field: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(part))) as T;
  } catch {
    throw new HttpError(401, "unauthorized", `Invalid Access JWT ${field}`);
  }
}

async function loadAccessJwks(env: Env): Promise<{ keys?: AccessJwk[] }> {
  if (env.ACCESS_JWKS_JSON?.trim()) {
    try {
      return JSON.parse(env.ACCESS_JWKS_JSON) as { keys?: AccessJwk[] };
    } catch {
      throw new HttpError(500, "misconfigured", "ACCESS_JWKS_JSON is not valid JSON");
    }
  }
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim();
  if (!teamDomain) throw new HttpError(500, "misconfigured", "ACCESS_TEAM_DOMAIN is required for login auth");
  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) throw new HttpError(500, "misconfigured", "Could not load Cloudflare Access certificates");
  return response.json();
}

async function verifyAccessJwt(env: Env, token: string): Promise<AccessClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new HttpError(401, "unauthorized", "Invalid Access JWT");
  const header = parseJwtPart<{ alg?: string; kid?: string }>(parts[0], "header");
  if (header.alg !== "RS256" || !header.kid) throw new HttpError(401, "unauthorized", "Unsupported Access JWT");
  const jwks = await loadAccessJwks(env);
  const key = jwks.keys?.find((item) => item.kid === header.kid);
  if (!key) throw new HttpError(401, "unauthorized", "Access JWT key not found");
  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    key,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    toArrayBuffer(base64UrlDecode(parts[2])),
    toArrayBuffer(new TextEncoder().encode(`${parts[0]}.${parts[1]}`))
  );
  if (!verified) throw new HttpError(401, "unauthorized", "Invalid Access JWT signature");
  const claims = parseJwtPart<AccessClaims>(parts[1], "payload");
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp && claims.exp < now) throw new HttpError(401, "unauthorized", "Access JWT expired");
  if (claims.nbf && claims.nbf > now) throw new HttpError(401, "unauthorized", "Access JWT not yet valid");
  const expectedAud = env.ACCESS_AUD?.trim();
  if (expectedAud) {
    const aud = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
    if (!aud.includes(expectedAud)) throw new HttpError(401, "unauthorized", "Access JWT audience is not allowed");
  }
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim();
  if (teamDomain && claims.iss && claims.iss !== `https://${teamDomain}`) {
    throw new HttpError(401, "unauthorized", "Access JWT issuer is not allowed");
  }
  if (!claims.sub) throw new HttpError(401, "unauthorized", "Access JWT subject is missing");
  return claims;
}

function resolveAccessTenantGrant(env: Env, principal: string, email: string | null): string[] {
  const policy = parseAccessTenantPolicy(env.ACCESS_TENANT_POLICY_JSON);
  if (!policy) return ["default"];
  const direct = normalizeTenantList(policy.principals?.[principal]);
  if (direct.length > 0) return direct;
  const domain = email?.split("@")[1]?.toLowerCase();
  const domainGrant = domain ? normalizeTenantList(policy.email_domains?.[domain]) : [];
  if (domainGrant.length > 0) return domainGrant;
  const wildcard = normalizeTenantList(policy.principals?.["*"]);
  if (wildcard.length > 0) return wildcard;
  const defaults = normalizeTenantList(policy.default_tenants);
  if (defaults.length > 0) return defaults;
  throw new HttpError(403, "forbidden", `No tenant grants configured for principal: ${principal}`);
}

async function resolveAccessGrant(env: Env, token: string): Promise<ApiKeyGrant> {
  const claims = await verifyAccessJwt(env, token);
  const email = claims.email?.trim().toLowerCase() || null;
  const principal = `user:${claims.sub}`;
  return {
    principal,
    allowedTenants: resolveAccessTenantGrant(env, principal, email),
    source: "access-jwt",
    email,
    displayName: claims.name?.trim() || email
  };
}

export const apiKeyAuth: MiddlewareHandler<ApiContextEnv> = async (c, next) => {
  const accessJwt = c.req.header("cf-access-jwt-assertion")?.trim();
  if (accessJwt) {
    const grant = await resolveAccessGrant(c.env, accessJwt);
    c.set("apiAuth", grant);
    await next();
    return;
  }

  const provided = c.req.header("x-api-key");
  const grant = provided ? resolveApiKeyGrant(c.env, provided) : null;
  if (!grant) {
    throw new HttpError(401, "unauthorized", "Missing or invalid API key");
  }
  c.set("apiAuth", grant);
  await next();
};

export function getApiAuthContext(c: Context<ApiContextEnv>): ApiAuthContext {
  const auth = c.get("apiAuth");
  if (!auth) {
    throw new HttpError(401, "unauthorized", "Missing or invalid API key");
  }
  return auth;
}

export function getApiPrincipal(c: Context<ApiContextEnv>): string {
  return getApiAuthContext(c).principal;
}

export function assertApiTenantAccess(c: Context<ApiContextEnv>, tenantId: string | null | undefined): string {
  const requested = tenantId?.trim() || "default";
  const grant = getApiAuthContext(c);
  if (!grant.allowedTenants.includes(requested)) {
    throw new HttpError(403, "forbidden", `Tenant "${requested}" is not allowed`);
  }
  return requested;
}

export function tenantFromBody(rawBody: unknown): string {
  if (!rawBody || typeof rawBody !== "object") return "default";
  const body = rawBody as Record<string, unknown>;
  const tenant = body.tenant_id ?? body.orgId;
  return typeof tenant === "string" && tenant.trim() ? tenant.trim() : "default";
}

export function jsonOk<T>(c: Context<ApiContextEnv>, data: T, status: number = 200): Response {
  return c.json({ ok: true as const, data }, { status: status as 200 });
}
