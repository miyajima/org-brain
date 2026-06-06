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
      allowedTenants: allowedTenants.length > 0 ? allowedTenants : normalizeTenantList(policy?.default_tenants)
    };
  }

  if (env.API_KEY && constantTimeEquals(env.API_KEY, provided)) {
    return {
      principal: "api-key:default",
      allowedTenants: policy ? normalizeTenantList(policy.default_tenants) : ["default"]
    };
  }

  return null;
}

export const apiKeyAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const provided = c.req.header("x-api-key");
  if (!provided || !resolveApiKeyGrant(c.env, provided)) {
    throw new HttpError(401, "unauthorized", "Missing or invalid API key");
  }
  await next();
};

export function assertApiTenantAccess(c: Context<{ Bindings: Env }>, tenantId: string | null | undefined): string {
  const requested = tenantId?.trim() || "default";
  const provided = c.req.header("x-api-key");
  const grant = provided ? resolveApiKeyGrant(c.env, provided) : null;
  if (!grant) {
    throw new HttpError(401, "unauthorized", "Missing or invalid API key");
  }
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

export function jsonOk<T>(c: Context<{ Bindings: Env }>, data: T, status: number = 200): Response {
  return c.json({ ok: true as const, data }, { status: status as 200 });
}
