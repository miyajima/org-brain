import { HttpError, isOrgRole, ulid, type OrgRole } from "@org-brain/shared";
import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "./types";
import { verifyAccessJwt, type AccessClaims } from "./access-jwt";
import { authenticateScopedToken } from "./token-service";
import { authenticateSession, SESSION_COOKIE } from "./email-auth-service";

type ApiTenantPolicy = {
  keys?: Array<{
    api_key?: string;
    key?: string;
    principal?: string;
    tenants?: string[];
    role?: OrgRole;
  }>;
  api_keys?: Array<{
    api_key?: string;
    key?: string;
    principal?: string;
    tenants?: string[];
    role?: OrgRole;
  }>;
  default_tenants?: string[];
  default_role?: OrgRole;
};

type ApiKeyGrant = {
  principal: string;
  allowedTenants: string[];
  source: "api-key" | "access-jwt" | "oidc-jwt" | "scoped-token" | "session";
  email?: string | null;
  displayName?: string | null;
  defaultRole: OrgRole;
  scopes?: import("@org-brain/shared").OrgPermission[];
  projectId?: string | null;
  sessionId?: string;
  csrfHash?: string;
  emailVerified?: boolean;
  issuer?: string;
  subject?: string;
};

export type ApiAuthContext = ApiKeyGrant;

export type ApiContextEnv = {
  Bindings: Env;
  Variables: {
    apiAuth: ApiAuthContext;
  };
};

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

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

type AccessTenantPolicy = {
  principals?: Record<string, string[]>;
  email_domains?: Record<string, string[]>;
  default_tenants?: string[];
  default_role?: OrgRole;
};

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
      source: "api-key",
      defaultRole: isOrgRole(entry.role)
        ? entry.role
        : isOrgRole(policy?.default_role)
          ? policy.default_role
          : "service_agent"
    };
  }

  if (env.CONSOLE_API_KEY && constantTimeEquals(env.CONSOLE_API_KEY, provided)) {
    return {
      principal: "service:open-brain-console",
      allowedTenants: ["default"],
      source: "api-key",
      defaultRole: "reader"
    };
  }

  if (env.API_KEY && constantTimeEquals(env.API_KEY, provided)) {
    return {
      principal: "api-key:default",
      allowedTenants: policy ? normalizeTenantList(policy.default_tenants) : ["default"],
      source: "api-key",
      defaultRole: "service_agent"
    };
  }

  return null;
}

export function resolveAccessTenantGrant(
  env: Env,
  principal: string,
  email: string | null,
  source?: "access-jwt" | "oidc-jwt"
): string[] {
  const policy = parseAccessTenantPolicy(
    source === "access-jwt"
      ? env.ACCESS_TENANT_POLICY_JSON
      : env.OIDC_TENANT_POLICY_JSON || env.ACCESS_TENANT_POLICY_JSON
  );
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
  return resolveVerifiedAccessUser(env, claims);
}

export async function resolveVerifiedAccessUser(
  env: Env,
  claims: AccessClaims,
  verifiedSource?: "access-jwt" | "oidc-jwt",
  options: { requireExistingIdentity?: boolean } = {}
): Promise<ApiAuthContext> {
  if (!claims.sub?.trim()) throw new HttpError(401, "unauthorized", "Access JWT subject is missing");
  const source = verifiedSource ?? (env.OIDC_ISSUER ? "oidc-jwt" : "access-jwt");
  const tenantPolicy = parseAccessTenantPolicy(
    source === "access-jwt"
      ? env.ACCESS_TENANT_POLICY_JSON
      : env.OIDC_TENANT_POLICY_JSON || env.ACCESS_TENANT_POLICY_JSON
  );
  const email = claims.email?.trim().toLowerCase() || null;
  const legacyPrincipal = `user:${claims.sub}`;
  const allowedTenants = resolveAccessTenantGrant(env, legacyPrincipal, email, source);
  const issuer = claims.iss?.replace(/\/+$/u, "") || (source === "access-jwt" ? "cloudflare-access" : "");
  let principal: string;
  let resolvedTenants = allowedTenants;
  if (options.requireExistingIdentity) {
    if (!env.OPEN_BRAIN_DB) {
      throw new HttpError(500, "misconfigured", "OPEN_BRAIN_DB is required for existing identity resolution");
    }
    const resolved = await resolveExistingFederatedIdentity(
      env,
      allowedTenants,
      issuer,
      claims.sub
    );
    principal = resolved.principal;
    resolvedTenants = resolved.tenantIds;
  } else {
    principal = await ensureFederatedIdentity(env, {
      legacyPrincipal,
      issuer,
      subject: claims.sub,
      email,
      emailVerified: source === "access-jwt" || claims.email_verified === true,
      displayName: claims.name?.trim() || email,
      tenantIds: allowedTenants,
      source
    });
  }
  return {
    principal,
    allowedTenants: resolvedTenants,
    source,
    email,
    displayName: claims.name?.trim() || email,
    emailVerified: source === "access-jwt" || claims.email_verified === true,
    issuer,
    subject: claims.sub!,
    defaultRole: isOrgRole(tenantPolicy?.default_role)
      ? tenantPolicy.default_role
      : "reader"
  };
}

async function resolveExistingFederatedIdentity(
  env: Env,
  tenantIds: string[],
  issuer: string,
  subject: string
): Promise<{ principal: string; tenantIds: string[] }> {
  let principal: string | null = null;
  const resolvedTenants: string[] = [];
  for (const tenantId of tenantIds) {
    const identity = await env.OPEN_BRAIN_DB.prepare(
      `SELECT principal FROM user_identities
       WHERE tenant_id=? AND provider_type='oidc' AND issuer=? AND subject=?`
    ).bind(tenantId, issuer, subject).first<{ principal: string }>();
    if (!identity) continue;
    if (principal && principal !== identity.principal) {
      throw new HttpError(409, "identity_conflict", "Federated identity maps to different principals across tenants");
    }
    const profile = await env.OPEN_BRAIN_DB.prepare(
      "SELECT status FROM user_profiles WHERE tenant_id=? AND principal=?"
    ).bind(tenantId, identity.principal).first<{ status: string }>();
    if (!profile || profile.status !== "active") {
      throw new HttpError(403, "user_inactive", "Federated user is not active");
    }
    principal = identity.principal;
    resolvedTenants.push(tenantId);
  }
  if (!principal || resolvedTenants.length === 0) {
    throw new HttpError(403, "identity_not_registered", "Cloudflare Access identity is not registered in Org Brain");
  }
  return { principal, tenantIds: resolvedTenants };
}

export async function ensureFederatedIdentity(env: Env, input: {
  legacyPrincipal: string;
  issuer: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  tenantIds: string[];
  source: "access-jwt" | "oidc-jwt";
}): Promise<string> {
  // Keep the pre-directory bearer path compatible for lightweight adapters and
  // staged rollouts that have not bound D1 yet. Production Gateway bindings
  // always provide OPEN_BRAIN_DB and therefore use issuer+subject identities.
  if (!env.OPEN_BRAIN_DB) return input.legacyPrincipal;
  let principal: string | null = null;
  for (const tenantId of input.tenantIds) {
    const identity = await env.OPEN_BRAIN_DB.prepare(
      `SELECT principal FROM user_identities
       WHERE tenant_id=? AND provider_type='oidc' AND issuer=? AND subject=?`
    ).bind(tenantId, input.issuer, input.subject).first<{ principal: string }>();
    if (identity) {
      if (principal && principal !== identity.principal) {
        throw new HttpError(409, "identity_conflict", "Federated identity maps to different principals across tenants");
      }
      principal = identity.principal;
    }
  }
  if (!principal) {
    for (const tenantId of input.tenantIds) {
      const legacy = await env.OPEN_BRAIN_DB.prepare(
        "SELECT principal FROM user_profiles WHERE tenant_id=? AND principal=?"
      ).bind(tenantId, input.legacyPrincipal).first<{ principal: string }>();
      if (legacy) {
        principal = legacy.principal;
        break;
      }
    }
  }
  if (!principal && input.emailVerified && input.email) {
    for (const tenantId of input.tenantIds) {
      const invited = await env.OPEN_BRAIN_DB.prepare(
        "SELECT principal FROM user_profiles WHERE tenant_id=? AND lower(email)=lower(?)"
      ).bind(tenantId, input.email).first<{ principal: string }>();
      if (invited) {
        principal = invited.principal;
        break;
      }
    }
  }
  if (!principal && (!input.emailVerified || !input.email)) {
    throw new HttpError(403, "verified_email_required", "OIDC JIT registration requires a verified email");
  }
  const now = Date.now();
  principal ??= `user:${ulid(now).toLowerCase()}`;
  for (const [index, tenantId] of input.tenantIds.entries()) {
    const existing = await env.OPEN_BRAIN_DB.prepare(
      "SELECT status FROM user_profiles WHERE tenant_id=? AND principal=?"
    ).bind(tenantId, principal).first<{ status: string }>();
    if (existing?.status === "suspended" || existing?.status === "deprovisioned") {
      throw new HttpError(403, "user_suspended", "User is not active");
    }
    if (!existing) {
      await env.OPEN_BRAIN_DB.batch([
        env.OPEN_BRAIN_DB.prepare(
          `INSERT INTO user_profiles(tenant_id, principal, display_name, full_name, email,
            email_verified, company_name, organization_name, avatar_url, status,
            provision_source, full_name_source, created_at, updated_at)
           VALUES(?,?,?,NULL,?,1,NULL,NULL,NULL,'active','oidc','oidc',?,?)`
        ).bind(tenantId, principal, input.displayName || input.email || principal, input.email, now, now),
        env.OPEN_BRAIN_DB.prepare(
          `INSERT INTO principal_role_assignments(id, tenant_id, project_id, principal, role,
            created_by_principal, created_at, updated_at, source, source_ref)
           VALUES(?,?,NULL,?,'reader',?,?,?,'local','oidc-jit')`
        ).bind(ulid(now + index + 1), tenantId, principal, principal, now, now)
      ]);
    }
    await env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO user_identities(id, tenant_id, principal, provider_type, issuer, subject,
        external_id, created_at, updated_at) VALUES(?,?,?,'oidc',?,?,NULL,?,?)
       ON CONFLICT(tenant_id, provider_type, issuer, subject)
       DO UPDATE SET principal=excluded.principal, updated_at=excluded.updated_at`
    ).bind(ulid(now + input.tenantIds.length + index + 1), tenantId, principal, input.issuer, input.subject, now, now).run();
  }
  return principal;
}

export const apiKeyAuth: MiddlewareHandler<ApiContextEnv> = async (c, next) => {
  if (c.req.path === "/v1/auth/email/request-code" || c.req.path === "/v1/auth/email/verify") {
    await next();
    return;
  }

  const sessionToken = cookieValue(c.req.header("cookie"), SESSION_COOKIE);
  if (sessionToken) {
    const session = await authenticateSession(c.env, sessionToken);
    if (!session) throw new HttpError(401, "unauthorized", "Invalid or expired session");
    c.set("apiAuth", session);
    await next();
    return;
  }

  const accessJwt = c.req.header("cf-access-jwt-assertion")?.trim();
  if (accessJwt) {
    const grant = await resolveAccessGrant(c.env, accessJwt);
    c.set("apiAuth", grant);
    await next();
    return;
  }

  const authorization = c.req.header("authorization")?.trim();
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer?.startsWith("obp_")) {
    const record = await authenticateScopedToken(c.env, bearer);
    if (!record) throw new HttpError(401, "unauthorized", "Invalid or expired scoped token");
    c.set("apiAuth", {
      principal: record.principal,
      allowedTenants: [record.tenant_id],
      source: "scoped-token",
      defaultRole: "tenant_admin",
      scopes: record.scopes,
      projectId: record.project_id
    });
    await next();
    return;
  }
  if (bearer && envHasOidc(c.env)) {
    const grant = await resolveAccessGrant(c.env, bearer);
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

function envHasOidc(env: Env): boolean {
  return Boolean(env.OIDC_ISSUER?.trim());
}

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
