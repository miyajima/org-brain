import { ACCESS_POLICY_RESOURCE_TYPES, type AccessPolicyResourceType } from "@org-brain/contracts";
import { HttpError } from "@org-brain/shared";
import type { Context } from "hono";
import { z } from "zod";
import { authorizePermission } from "./rbac-service";
import { getApiAuthContext, getApiPrincipal, type ApiContextEnv } from "./auth";
import { fnv1a32 } from "./deterministic-sampling";
import type { Env } from "./types";

export const dashboardStrataDetailQuerySchema = z.object({
  tenant_id: z.string().trim().min(1).max(128).optional(),
  project_id: z.string().trim().min(1).max(256).optional()
});

type DashboardLogSummary = { count: number; truncated: boolean };

function shouldSampleDashboardView(c: Context<ApiContextEnv>): boolean {
  const requestId = c.req.header("cf-ray") || c.req.header("x-request-id");
  if (!requestId) return false;
  return fnv1a32(requestId) % 20 === 0;
}

export async function runDashboardView<T>(
  c: Context<ApiContextEnv>,
  view: "activity" | "knowledge_graph" | "strata" | "strata_detail",
  operation: () => Promise<T>,
  summarize: (data: T) => DashboardLogSummary
): Promise<T> {
  const startedAt = performance.now();
  const sampled = shouldSampleDashboardView(c);
  try {
    const data = await operation();
    if (sampled) {
      const summary = summarize(data);
      console.info(JSON.stringify({
        event: "dashboard.view",
        view,
        duration_ms: Math.round((performance.now() - startedAt) * 10) / 10,
        count: summary.count,
        status: 200,
        truncated: summary.truncated
      }));
    }
    return data;
  } catch (error) {
    if (sampled) {
      console.info(JSON.stringify({
        event: "dashboard.view",
        view,
        duration_ms: Math.round((performance.now() - startedAt) * 10) / 10,
        count: 0,
        status: error instanceof HttpError ? error.status : 500,
        truncated: false
      }));
    }
    throw error;
  }
}

export function assertFeatureEnabled(
  env: Env,
  key: "KNOWLEDGE_RESOURCE_INGESTION_ENABLED" | "DECISION_RESOURCE_LINKS_ENABLED" | "RESOURCE_RELATION_EXTRACTION_ENABLED"
) {
  if (env[key] !== "true") {
    throw new HttpError(404, "feature_disabled", "Feature is not enabled for this deployment");
  }
}

export function assertDecisionConsoleEnabled(env: Env) {
  if (!["beta", "on"].includes(env.DECISION_CONSOLE_MODE ?? "off")) {
    throw new HttpError(404, "feature_disabled", "Decision Console is not enabled for this deployment");
  }
}

export function accessPolicyResourceType(value: string): AccessPolicyResourceType {
  if (!ACCESS_POLICY_RESOURCE_TYPES.includes(value as AccessPolicyResourceType)) {
    throw new HttpError(400, "invalid_resource_type", "Unsupported access policy resource type");
  }
  return value as AccessPolicyResourceType;
}

export function requireIdempotencyKey(c: { req: { header(name: string): string | undefined } }): string {
  const value = c.req.header("x-idempotency-key")?.trim();
  if (!value || value.length > 256) {
    throw new HttpError(400, "idempotency_key_required", "x-idempotency-key is required");
  }
  return value;
}

export function withPrincipalActor(rawBody: unknown, principal: string): unknown {
  if (!rawBody || typeof rawBody !== "object") return rawBody;
  const body = rawBody as Record<string, unknown>;
  return { ...body, actor_type: "principal", actor_id: principal };
}

export function assertRetrievalOperator(env: Env, principal: string) {
  let operators: string[] = [];
  try {
    const parsed = JSON.parse(env.RETRIEVAL_OPERATOR_PRINCIPALS_JSON ?? "[]") as unknown;
    operators = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    operators = [];
  }
  if (!operators.includes(principal)) {
    throw new HttpError(403, "retrieval_operator_required", "global retrieval generation operations require an explicit operator principal");
  }
}

export async function isTenantAdmin(c: Context<ApiContextEnv>, tenantId: string): Promise<boolean> {
  const auth = getApiAuthContext(c);
  if (auth.defaultRole === "tenant_admin") return true;
  const decision = await authorizePermission(c.env, {
    tenantId,
    principal: getApiPrincipal(c),
    permission: "admin",
    fallbackRole: auth.defaultRole
  });
  return decision.matched_roles.includes("tenant_admin");
}
