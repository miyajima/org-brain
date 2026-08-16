import { HttpError, isOrgRole, type OrgRole } from "@org-brain/shared";
import { verifyAccessJwt, type AccessClaims } from "./access-jwt";
import { resolveVerifiedAccessUser } from "./auth";
import {
  resolveMcpClientInstallation,
  touchMcpClientInstallation,
  type McpClientType
} from "./mcp-client-installation-service";
import type { Env } from "./types";

type TenantPolicy = {
  principals?: Record<string, string[]>;
  default_tenants?: string[];
  default_role?: OrgRole;
};

type ServiceTokenConfig = {
  tokens?: Array<{
    client_id?: string;
    client_secret?: string;
    principal?: string;
    tenants?: string[];
    role?: OrgRole;
  }>;
};

type LegacyPrincipalResolution = {
  principal: string;
  source: "legacy-service-token";
  inlineAllowedTenants?: string[];
  role?: OrgRole;
};

export type McpAuthResult = {
  principal: string;
  tenantId: string;
  allowedTenants: string[];
  source: "access-user" | "access-service" | "legacy-service-token";
  defaultRole: OrgRole;
  clientInstallationId?: string;
  clientType?: McpClientType;
  runtimeActor: string;
  allowedTools?: string[];
};

function normalizeTenantList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return [...new Set(input
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean))];
}

function parseTenantPolicy(raw: string | undefined): TenantPolicy | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? parsed as TenantPolicy : null;
  } catch {
    throw new HttpError(500, "misconfigured", "MCP_TENANT_POLICY_JSON is not valid JSON");
  }
}

function parseServiceTokenConfig(raw: string | undefined): ServiceTokenConfig {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") throw new Error("invalid");
    return parsed as ServiceTokenConfig;
  } catch {
    throw new HttpError(500, "misconfigured", "MCP service token JSON is not valid JSON");
  }
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const maxLength = Math.max(leftBytes.length, rightBytes.length);
  let mismatch = leftBytes.length === rightBytes.length ? 0 : 1;
  for (let index = 0; index < maxLength; index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return mismatch === 0;
}

function legacyAuthMode(env: Partial<Env>): "legacy" | "dual" | "access" {
  const mode = env.MCP_AUTH_MODE?.trim() || "access";
  if (mode !== "legacy" && mode !== "dual" && mode !== "access") {
    throw new HttpError(500, "misconfigured", "MCP_AUTH_MODE must be legacy, dual, or access");
  }
  return mode;
}

function resolveLegacyServiceToken(headers: Headers, env: Partial<Env>): LegacyPrincipalResolution | null {
  const clientId = headers.get("cf-access-client-id")?.trim();
  const clientSecret = headers.get("cf-access-client-secret")?.trim();
  if (!clientId && !clientSecret) return null;
  if (!clientId || !clientSecret) throw new HttpError(401, "unauthorized", "Incomplete service token headers");
  const configured = [
    env.MCP_SERVICE_TOKENS_JSON,
    env.MCP_SERVICE_TOKENS_ADDITIONAL_JSON,
    env.MCP_SERVICE_TOKENS_MACHINE_JSON
  ].flatMap((raw) => parseServiceTokenConfig(raw).tokens ?? []);
  for (const token of configured) {
    const expectedId = token.client_id?.trim();
    const expectedSecret = token.client_secret?.trim();
    if (!expectedId || !expectedSecret) continue;
    if (!constantTimeEquals(expectedId, clientId) || !constantTimeEquals(expectedSecret, clientSecret)) continue;
    return {
      principal: token.principal?.trim() || `service:${expectedId}`,
      source: "legacy-service-token",
      inlineAllowedTenants: normalizeTenantList(token.tenants),
      role: isOrgRole(token.role) ? token.role : undefined
    };
  }
  throw new HttpError(403, "forbidden", "Invalid legacy service token");
}

function resolveAllowedTenants(
  policy: TenantPolicy | null,
  principal: string,
  inlineAllowedTenants?: string[]
): string[] {
  if (inlineAllowedTenants?.length) return inlineAllowedTenants;
  if (!policy) return ["default"];
  const direct = normalizeTenantList(policy.principals?.[principal]);
  if (direct.length) return direct;
  const wildcard = normalizeTenantList(policy.principals?.["*"]);
  if (wildcard.length) return wildcard;
  const defaults = normalizeTenantList(policy.default_tenants);
  if (defaults.length) return defaults;
  throw new HttpError(403, "forbidden", `No tenant grants configured for principal: ${principal}`);
}

function pickTenant(requestedTenant: string | null, allowedTenants: string[]): string {
  const requested = requestedTenant?.trim();
  if (!requested) return allowedTenants[0];
  if (allowedTenants.includes(requested)) return requested;
  throw new HttpError(403, "forbidden", `Tenant "${requested}" is not allowed`);
}

function requestedTenant(request: Request): string | null {
  return request.headers.get("x-orgbrain-tenant") || new URL(request.url).searchParams.get("tenant_id");
}

export async function verifyMcpAccessAssertion(request: Request, env: Env): Promise<AccessClaims> {
  const assertion = request.headers.get("cf-access-jwt-assertion")?.trim();
  if (!assertion) throw new HttpError(401, "unauthorized", "Missing Cloudflare Access assertion");
  const audience = env.MCP_ACCESS_AUD?.trim();
  if (!audience) throw new HttpError(500, "misconfigured", "MCP_ACCESS_AUD is required");
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim();
  if (!teamDomain) throw new HttpError(500, "misconfigured", "ACCESS_TEAM_DOMAIN is required for MCP Access auth");
  return verifyAccessJwt(
    {
      ACCESS_TEAM_DOMAIN: teamDomain,
      ACCESS_JWKS_JSON: env.ACCESS_JWKS_JSON
    },
    assertion,
    {
      expectedAudience: audience,
      expectedIssuer: `https://${teamDomain}`,
      requireSubject: false
    }
  );
}

export function accessServiceSubject(claims: AccessClaims): string | null {
  const subject = claims.common_name?.trim() || claims.service_token_id?.trim();
  if (!subject) return null;
  if (claims.service_token_status === false || claims.service_token_status === "false") {
    throw new HttpError(403, "forbidden", "Cloudflare Access service token is not active");
  }
  return subject;
}

async function authorizeAccessRequest(request: Request, env: Env): Promise<McpAuthResult> {
  const claims = await verifyMcpAccessAssertion(request, env);
  const serviceSubject = accessServiceSubject(claims);
  if (serviceSubject) {
    const installation = await resolveMcpClientInstallation(env, serviceSubject);
    if (!installation) throw new HttpError(403, "forbidden", "MCP client installation is not active");
    const owner = await env.OPEN_BRAIN_DB.prepare(
      "SELECT status FROM user_profiles WHERE tenant_id=? AND principal=?"
    ).bind(installation.tenant_id, installation.owner_principal).first<{ status: string }>();
    if (owner?.status !== "active") {
      throw new HttpError(403, "forbidden", "MCP client installation owner is not active");
    }
    const tenantId = pickTenant(requestedTenant(request), [installation.tenant_id]);
    await touchMcpClientInstallation(env, installation.id).catch(() => undefined);
    const runtimeActor = `client:${installation.id}`;
    return {
      // Automated hooks are a separate machine identity. Reusing the human
      // owner's principal would also reuse their explicit RBAC assignments
      // (for example, reader), which can either block capture or broaden the
      // machine's authority unexpectedly.
      principal: runtimeActor,
      tenantId,
      allowedTenants: [installation.tenant_id],
      source: "access-service",
      // Installation identities are restricted to the single capture tool
      // below. They still need the contributor fallback so that the allowed
      // tool can persist a memory when the owning principal is read-only.
      defaultRole: "contributor",
      clientInstallationId: installation.id,
      clientType: installation.client_type,
      runtimeActor,
      allowedTools: ["orgbrain_memories_capture_rationale"]
    };
  }
  const grant = await resolveVerifiedAccessUser(
    env,
    claims,
    "access-jwt",
    { requireExistingIdentity: true }
  );
  const tenantId = pickTenant(requestedTenant(request), grant.allowedTenants);
  return {
    principal: grant.principal,
    tenantId,
    allowedTenants: grant.allowedTenants,
    source: "access-user",
    defaultRole: grant.defaultRole,
    runtimeActor: `principal:${grant.principal}`
  };
}

export async function authorizeMcpRequest(request: Request, env: Partial<Env>): Promise<McpAuthResult> {
  const mode = legacyAuthMode(env);
  if (request.headers.get("cf-access-jwt-assertion")?.trim()) {
    if (mode === "legacy") throw new HttpError(401, "unauthorized", "Access assertion auth is disabled");
    if (!env.OPEN_BRAIN_DB) throw new HttpError(500, "misconfigured", "OPEN_BRAIN_DB is required for Access MCP auth");
    return authorizeAccessRequest(request, env as Env);
  }
  if (mode === "legacy" || mode === "dual") {
    const legacy = resolveLegacyServiceToken(request.headers, env);
    if (legacy) {
      const policy = parseTenantPolicy(env.MCP_TENANT_POLICY_JSON);
      const allowedTenants = resolveAllowedTenants(policy, legacy.principal, legacy.inlineAllowedTenants);
      return {
        principal: legacy.principal,
        tenantId: pickTenant(requestedTenant(request), allowedTenants),
        allowedTenants,
        source: legacy.source,
        defaultRole: legacy.role ?? (isOrgRole(policy?.default_role) ? policy.default_role : "service_agent"),
        runtimeActor: legacy.principal
      };
    }
  }
  throw new HttpError(401, "unauthorized", "Missing MCP authentication");
}
