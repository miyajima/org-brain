import { HttpError } from "@org-brain/shared";

type TenantPolicy = {
  principals?: Record<string, string[]>;
  default_tenants?: string[];
};

type ServiceTokenConfig = {
  tokens?: Array<{
    client_id?: string;
    client_secret?: string;
    principal?: string;
    tenants?: string[];
  }>;
};

type PrincipalResolution = {
  principal: string;
  source: "service-token";
  inlineAllowedTenants?: string[];
};

export type McpAuthResult = {
  principal: string;
  tenantId: string;
  allowedTenants: string[];
  source: PrincipalResolution["source"];
};

function normalizeTenantList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const list = input
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
  return [...new Set(list)];
}

function parseTenantPolicy(raw: string | undefined): TenantPolicy | null {
  if (!raw || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as TenantPolicy;
  } catch {
    throw new HttpError(500, "misconfigured", "MCP_TENANT_POLICY_JSON is not valid JSON");
  }
}

function parseServiceTokenConfig(raw: string | undefined): ServiceTokenConfig {
  if (!raw || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      throw new HttpError(500, "misconfigured", "MCP_SERVICE_TOKENS_JSON is not valid JSON");
    }
    return parsed as ServiceTokenConfig;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(500, "misconfigured", "MCP_SERVICE_TOKENS_JSON is not valid JSON");
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

function resolveServiceToken(headers: Headers, rawConfig: string | undefined): PrincipalResolution | null {
  const clientId = headers.get("cf-access-client-id")?.trim();
  const clientSecret = headers.get("cf-access-client-secret")?.trim();

  if (!clientId && !clientSecret) return null;
  if (!clientId || !clientSecret) {
    throw new HttpError(401, "unauthorized", "Incomplete service token headers");
  }

  const config = parseServiceTokenConfig(rawConfig);
  const tokens = Array.isArray(config.tokens) ? config.tokens : [];
  if (tokens.length === 0) {
    throw new HttpError(401, "unauthorized", "Service token auth is not configured");
  }

  for (const token of tokens) {
    const expectedId = token.client_id?.trim();
    const expectedSecret = token.client_secret?.trim();
    if (!expectedId || !expectedSecret) continue;
    if (!constantTimeEquals(expectedId, clientId)) continue;
    if (!constantTimeEquals(expectedSecret, clientSecret)) continue;
    return {
      principal: token.principal?.trim() || `service:${expectedId}`,
      source: "service-token",
      inlineAllowedTenants: normalizeTenantList(token.tenants)
    };
  }

  throw new HttpError(403, "forbidden", "Invalid service token");
}

function resolveAllowedTenants(
  policy: TenantPolicy | null,
  principal: string,
  inlineAllowedTenants?: string[]
): string[] {
  if (inlineAllowedTenants && inlineAllowedTenants.length > 0) return inlineAllowedTenants;
  if (!policy) return ["default"];

  const principalMap = policy.principals ?? {};
  const direct = normalizeTenantList(principalMap[principal]);
  if (direct.length > 0) return direct;

  const wildcard = normalizeTenantList(principalMap["*"]);
  if (wildcard.length > 0) return wildcard;

  const defaults = normalizeTenantList(policy.default_tenants);
  if (defaults.length > 0) return defaults;

  throw new HttpError(403, "forbidden", `No tenant grants configured for principal: ${principal}`);
}

function pickTenant(requestedTenant: string | null, allowedTenants: string[]): string {
  const requested = requestedTenant?.trim();
  if (!requested) return allowedTenants[0];
  if (allowedTenants.includes(requested)) return requested;
  throw new HttpError(403, "forbidden", `Tenant "${requested}" is not allowed`);
}

export function authorizeMcpRequest(
  request: Request,
  env: { MCP_TENANT_POLICY_JSON?: string; MCP_ACCESS_AUD?: string; MCP_SERVICE_TOKENS_JSON?: string }
): McpAuthResult {
  const serviceToken = resolveServiceToken(request.headers, env.MCP_SERVICE_TOKENS_JSON);
  if (serviceToken) {
    const policy = parseTenantPolicy(env.MCP_TENANT_POLICY_JSON);
    const allowedTenants = resolveAllowedTenants(policy, serviceToken.principal, serviceToken.inlineAllowedTenants);
    const tenantId = pickTenant(request.headers.get("x-orgbrain-tenant"), allowedTenants);
    return {
      principal: serviceToken.principal,
      tenantId,
      allowedTenants,
      source: serviceToken.source
    };
  }

  if (request.headers.get("cf-access-jwt-assertion")?.trim()) {
    throw new HttpError(
      401,
      "unauthorized",
      "Interactive Cloudflare Access login is not enabled for this MCP endpoint"
    );
  }

  throw new HttpError(401, "unauthorized", "Missing MCP authentication");
}
