import {
  DASHBOARD_SOURCE_TYPES,
  dashboardActivityQuerySchema,
  dashboardKnowledgeGraphQuerySchema,
  dashboardStrataQuerySchema,
  type DashboardSourceType
} from "@org-brain/contracts";
import { HttpError, runRecordedScheduledJob, type AgentMemoryEventV1, type OrgPermission } from "@org-brain/shared";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import {
  ackAgentMessage,
  getAgentMessage,
  listAgentMessages,
  markAgentMessageRead,
  sendAgentMessage
} from "./agent-message-service";
import { getActivityDashboard } from "./activity-dashboard-service";
import { appendAuditEvent, listAuditEvents, parseAuditLimit, verifyAuditChain } from "./audit-service";
import {
  createBusinessCategory,
  listBusinessCategories,
  updateBusinessCategory
} from "./business-category-service";
import {
  memoryImpactReport,
  createMemoryFailurePattern,
  listMemoryFailurePatterns,
  recordMemoryEffect,
  recordMemoryUsage,
  recordMemoryUsageFromRequest,
  updateMemoryFailurePattern,
  updateMemoryUsageStates
} from "./memory-effect-service";
import {
  assignRetrievalGeneration,
  backfillRetrievalGeneration,
  createRetrievalGeneration,
  createRetrievalRankingProfile,
  resolveRetrievalGenerationAssignment,
  transitionRetrievalGeneration
} from "./retrieval-generation-service";
import {
  backfillV3RetrievalUnits,
  backfillV4RetrievalUnits,
  rebuildSemanticIndex
} from "./retrieval-index-service";
import { getOperationsStatus } from "./operations-service";
import { runOpsWatchdog } from "./ops-watchdog-service";
import { assertRequestRateLimit } from "./rate-limit-service";
import { extractMemoryCandidates } from "./memory-extraction-service";
import {
  applyRetentionPolicies,
  listRetentionPolicies,
  upsertRetentionPolicy
} from "./retention-service";
import {
  cancelRetentionQueue,
  listRetentionQueue,
  runScheduledRetentionSweep,
  type RetentionQueueStatus
} from "./retention-queue-service";
import { apiKeyAuth, assertApiTenantAccess, getApiAuthContext, getApiPrincipal, jsonOk, tenantFromBody, type ApiContextEnv } from "./auth";
import {
  backfillDecisionRetrievalUnits,
  confirmDecisionMemory,
  createDecisionMemory,
  enrichContext,
  getDecisionMemoryContext,
  getDecisionReviewQueue,
  preActionDecisionGate,
  reviseDecisionMemory,
  searchDecisionMemories
} from "./context-engine-service";
import { addGroupMember, archiveGroup, createGroup, getGroup, listGroups, removeGroupMember, updateGroup } from "./group-service";
import { getMyIdentity, updateUserProfile } from "./identity-service";
import {
  assertSessionCsrf,
  logoutSession,
  requestEmailCode,
  revokeAllSessions,
  SESSION_COOKIE,
  SESSION_COOKIE_MAX_AGE,
  verifyEmailCode
} from "./email-auth-service";
import {
  createUser,
  getOrganization,
  listDirectory,
  listUsers,
  updateOrganization,
  updateUser
} from "./organization-user-service";
import { getKnowledgeDoc, getKnowledgeDocContext, searchKnowledgeDocs, upsertKnowledgeDoc } from "./knowledge-docs-service";
import { getKnowledgeGraph } from "./knowledge-graph-service";
import {
  captureMemories,
  deleteMemoryById,
  getMemoryDetails,
  getMemoryProfile,
  listMemories,
  listMemoriesCursorPage,
  listMemoriesPage,
  refreshMemoryByRequest,
  reviseMemoryByRequest,
  retrieveMemoryContext,
  searchMemories,
  suppressMemoryByRequest,
  upsertMemories
} from "./memory-service";
import { getMemoryStrata, getMemoryStrataDetail } from "./memory-strata-service";
import { mountMcp } from "./mcp";
import {
  getMemoryImpactExecution,
  getMemoryImpactSummary,
  reportMemoryImpact,
  startMemoryImpact
} from "./memory-impact-service";
import {
  captureMemoryWithInferredRationale,
  captureRequestClaimsVerified,
  confirmProposedMemory,
  proposeMemoryWithRationale
} from "./rationale-service";
import {
  assertPermission,
  deleteRoleAssignment,
  listRoleAssignments,
  upsertRoleAssignment
} from "./rbac-service";
import { getResourceShare, updateResourceShare } from "./share-service";
import {
  addKnowledgeResourceLocation,
  backfillKnowledgeResources,
  captureKnowledgeResourceVersion,
  confirmDecisionResourceLinkProposal,
  createDecisionResourceLink,
  getDecisionResources,
  getResourceDecisions,
  listDecisionResourceLinkProposals,
  resolveKnowledgeResource,
  retireDecisionResourceLink,
  searchKnowledgeResources,
  upsertKnowledgeResource
} from "./resource-decision-service";
import { createTask, getTask, getTaskEvents, listTasks, replayFailedTask } from "./task-service";
import { issueScopedToken, listScopedTokens, revokeScopedToken } from "./token-service";
import type { Env } from "./types";

const app = new Hono<ApiContextEnv>();

const dashboardStrataDetailQuerySchema = z.object({
  tenant_id: z.string().trim().min(1).max(128).optional(),
  project_id: z.string().trim().min(1).max(256).optional()
});

type DashboardLogSummary = { count: number; truncated: boolean };

function shouldSampleDashboardView(c: Context<ApiContextEnv>): boolean {
  const requestId = c.req.header("cf-ray") || c.req.header("x-request-id");
  if (!requestId) return false;
  let hash = 2166136261;
  for (let index = 0; index < requestId.length; index += 1) {
    hash ^= requestId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 20 === 0;
}

async function runDashboardView<T>(
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

function assertFeatureEnabled(env: Env, key: "KNOWLEDGE_RESOURCE_INGESTION_ENABLED" | "DECISION_RESOURCE_LINKS_ENABLED" | "RESOURCE_RELATION_EXTRACTION_ENABLED") {
  if (env[key] !== "true") throw new HttpError(404, "feature_disabled", "Feature is not enabled for this deployment");
}

function requireIdempotencyKey(c: { req: { header(name: string): string | undefined } }): string {
  const value = c.req.header("x-idempotency-key")?.trim();
  if (!value || value.length > 256) {
    throw new HttpError(400, "idempotency_key_required", "x-idempotency-key is required");
  }
  return value;
}

app.post("/internal/ops/watchdog/run", async (c) => {
  const expected = c.env.OPS_WATCHDOG_TOKEN?.trim();
  if (!expected) throw new HttpError(503, "watchdog_not_configured", "OPS_WATCHDOG_TOKEN is not configured");
  if (c.req.header("authorization") !== `Bearer ${expected}`) {
    throw new HttpError(401, "unauthorized", "Invalid watchdog token");
  }
  return c.json(await runOpsWatchdog(c.env));
});

function withPrincipalActor(rawBody: unknown, principal: string): unknown {
  if (!rawBody || typeof rawBody !== "object") return rawBody;
  const body = rawBody as Record<string, unknown>;
  return {
    ...body,
    actor_type: "principal",
    actor_id: principal
  };
}

function assertRetrievalOperator(env: Env, principal: string) {
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

mountMcp(app);

app.use(
  "/v1/*",
  cors({
    origin: "*",
    allowHeaders: ["content-type", "x-api-key", "authorization", "x-idempotency-key", "x-csrf-token"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    maxAge: 86400
  })
);
app.use(
  "/api/*",
  cors({
    origin: "*",
    allowHeaders: ["content-type", "x-api-key", "authorization", "x-idempotency-key", "x-csrf-token"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    maxAge: 86400
  })
);

app.use("/v1/*", apiKeyAuth);
app.use("/api/*", apiKeyAuth);

function permissionForRequest(method: string, path: string): OrgPermission {
  if (path.startsWith("/v1/auth/")) return method === "GET" ? "read" : "write";
  if (
    path === "/v1/organization" ||
    path.startsWith("/v1/users") ||
    path.startsWith("/v1/role-assignments") ||
    path.startsWith("/v1/groups") ||
    path.startsWith("/v1/scoped-tokens") ||
    path.startsWith("/v1/retention-policies") ||
    path.startsWith("/v1/retention-queue") ||
    path.startsWith("/v1/ops/") ||
    path.startsWith("/v1/retrieval-index") ||
    path.startsWith("/v1/retrieval-ranking-profiles") ||
    path.startsWith("/v1/retrieval-generations") ||
    path.startsWith("/v1/retrieval-generation-assignments") ||
    path === "/v1/resources/backfill"
  ) return "admin";
  if (path.startsWith("/v1/business-categories")) return method === "GET" ? "read" : "admin";
  if (path.startsWith("/v1/resource-shares")) return method === "GET" ? "read" : "share";
  if (path.startsWith("/v1/audit-events")) return "export";
  if (
    path.endsWith("/search") ||
    path.endsWith("/profile") ||
    path.endsWith("/context") ||
    path.endsWith("/review-queue") ||
    path.startsWith("/v1/context/") ||
    path === "/api/context/enrich"
  ) return "read";
  if (method === "DELETE") return "delete";
  if (path.includes("/export")) return "export";
  if (method === "GET") return "read";
  return "write";
}

const rbacAuditMiddleware: MiddlewareHandler<ApiContextEnv> = async (c, next) => {
  if (c.req.method === "OPTIONS") {
    await next();
    return;
  }
  if (c.req.path === "/v1/auth/email/request-code" || c.req.path === "/v1/auth/email/verify") {
    await next();
    return;
  }
  const clonedBody = !["GET", "HEAD", "DELETE"].includes(c.req.method)
    ? await c.req.raw.clone().json().catch(() => ({}))
    : {};
  const tenantId = assertApiTenantAccess(
    c,
    c.req.query("tenant_id") || tenantFromBody(clonedBody)
  );
  const bodyRecord = clonedBody && typeof clonedBody === "object"
    ? clonedBody as Record<string, unknown>
    : {};
  const projectId = (
    c.req.query("project_id") ||
    (typeof bodyRecord.project_id === "string" ? bodyRecord.project_id : null)
  )?.trim() || null;
  const auth = getApiAuthContext(c);
  const permission = permissionForRequest(c.req.method, c.req.path);
  const auditBase = {
    tenantId,
    projectId,
    principal: auth.principal,
    action: `${c.req.method} ${c.req.path}`,
    resourceType: c.req.path.split("/").filter(Boolean)[1] ?? "api",
    resourceId: c.req.param("memoryId") || c.req.param("id") || null,
    requestId: c.req.header("x-request-id") || c.req.header("cf-ray") || null,
    metadata: { permission }
  } as const;
  try {
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      if (auth.source === "session") {
        const allowedOrigin = c.env.SESSION_ALLOWED_ORIGIN?.trim();
        if (!allowedOrigin) throw new HttpError(500, "misconfigured", "SESSION_ALLOWED_ORIGIN is required for session mutations");
        if (c.req.header("origin") !== allowedOrigin) throw new HttpError(403, "origin_failed", "Request origin is not allowed");
      }
      await assertSessionCsrf(auth, c.req.header("x-csrf-token"));
    }
    await assertRequestRateLimit(c.env, {
      tenantId,
      principal: auth.principal,
      path: c.req.path
    });
    if (auth.scopes && !auth.scopes.includes(permission)) {
      throw new HttpError(403, "forbidden", `Scoped token lacks ${permission} permission`);
    }
    if (auth.projectId && auth.projectId !== projectId) {
      throw new HttpError(403, "forbidden", `Scoped token is restricted to project "${auth.projectId}"`);
    }
    await assertPermission(c.env, {
      tenantId,
      projectId,
      principal: auth.principal,
      permission,
      fallbackRole: auth.defaultRole
    });
  } catch (error) {
    await appendAuditEvent(c.env, { ...auditBase, outcome: "denied" });
    throw error;
  }
  try {
    await next();
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      await appendAuditEvent(c.env, {
        ...auditBase,
        outcome: c.res.status < 400 ? "succeeded" : "failed",
        metadata: { permission, status: c.res.status }
      });
    }
  } catch (error) {
    await appendAuditEvent(c.env, { ...auditBase, outcome: "failed" });
    throw error;
  }
};

app.use("/v1/*", rbacAuditMiddleware);
app.use("/api/*", rbacAuditMiddleware);

app.get("/v1/dashboard/activity", async (c) => {
  const parsed = dashboardActivityQuerySchema.safeParse({
    tenant_id: c.req.query("tenant_id"),
    project_id: c.req.query("project_id"),
    from: c.req.query("from"),
    to: c.req.query("to"),
    before: c.req.query("before"),
    after: c.req.query("after"),
    limit: c.req.query("limit")
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".") || "query";
    throw new HttpError(400, "invalid_query", `Invalid ${field}: ${issue?.message || "invalid value"}`);
  }
  const tenantId = assertApiTenantAccess(c, parsed.data.tenant_id);
  const data = await runDashboardView(
    c,
    "activity",
    () => getActivityDashboard(c.env, tenantId, {
      projectId: parsed.data.project_id,
      from: parsed.data.from,
      to: parsed.data.to,
      before: parsed.data.before,
      after: parsed.data.after,
      limit: parsed.data.limit,
      principal: getApiPrincipal(c)
    }),
    (result) => ({ count: result.events.length, truncated: result.has_more })
  );
  return jsonOk(c, data);
});

app.get("/v1/dashboard/knowledge-graph", async (c) => {
  const parsed = dashboardKnowledgeGraphQuerySchema.safeParse({
    tenant_id: c.req.query("tenant_id"),
    project_id: c.req.query("project_id"),
    q: c.req.query("q"),
    focus_type: c.req.query("focus_type"),
    focus_id: c.req.query("focus_id"),
    depth: c.req.query("depth"),
    node_limit: c.req.query("node_limit"),
    edge_limit: c.req.query("edge_limit")
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".") || "query";
    throw new HttpError(400, "invalid_query", `Invalid ${field}: ${issue?.message || "invalid value"}`);
  }
  const tenantId = assertApiTenantAccess(c, parsed.data.tenant_id);
  const data = await runDashboardView(
    c,
    "knowledge_graph",
    () => getKnowledgeGraph(c.env, tenantId, {
      project_id: parsed.data.project_id,
      q: parsed.data.q,
      focus_type: parsed.data.focus_type,
      focus_id: parsed.data.focus_id,
      depth: parsed.data.depth,
      node_limit: parsed.data.node_limit,
      edge_limit: parsed.data.edge_limit,
      principal: getApiPrincipal(c)
    }),
    (result) => ({ count: result.nodes.length, truncated: result.truncated })
  );
  return jsonOk(c, data);
});

app.get("/v1/dashboard/strata", async (c) => {
  const parsed = dashboardStrataQuerySchema.safeParse({
    tenant_id: c.req.query("tenant_id"),
    project_id: c.req.query("project_id"),
    types: c.req.query("types"),
    from: c.req.query("from"),
    to: c.req.query("to"),
    before: c.req.query("before"),
    limit: c.req.query("limit")
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".") || "query";
    throw new HttpError(400, "invalid_query", `Invalid ${field}: ${issue?.message || "invalid value"}`);
  }
  const tenantId = assertApiTenantAccess(c, parsed.data.tenant_id);
  const data = await runDashboardView(
    c,
    "strata",
    () => getMemoryStrata(c.env, tenantId, {
      project_id: parsed.data.project_id,
      types: parsed.data.types,
      from: parsed.data.from,
      to: parsed.data.to,
      before: parsed.data.before,
      limit: parsed.data.limit,
      principal: getApiPrincipal(c)
    }),
    (result) => ({ count: result.chains.length, truncated: result.truncated })
  );
  return jsonOk(c, data);
});

app.get("/v1/dashboard/strata/:sourceType/:sourceId", async (c) => {
  const sourceType = c.req.param("sourceType");
  if (!DASHBOARD_SOURCE_TYPES.includes(sourceType as DashboardSourceType)) {
    throw new HttpError(400, "invalid_source_type", `Unsupported strata source type: ${sourceType}`);
  }
  const parsed = dashboardStrataDetailQuerySchema.safeParse({
    tenant_id: c.req.query("tenant_id"),
    project_id: c.req.query("project_id")
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".") || "query";
    throw new HttpError(400, "invalid_query", `Invalid ${field}: ${issue?.message || "invalid value"}`);
  }
  const tenantId = assertApiTenantAccess(c, parsed.data.tenant_id);
  const data = await runDashboardView(
    c,
    "strata_detail",
    () => getMemoryStrataDetail(
      c.env,
      tenantId,
      sourceType as DashboardSourceType,
      c.req.param("sourceId"),
      {
        project_id: parsed.data.project_id,
        principal: getApiPrincipal(c)
      }
    ),
    (result) => ({
      count: result.chain.revisions.length + result.chain.sources.length,
      truncated: result.truncated.revisions || result.truncated.sources
    })
  );
  return jsonOk(c, data);
});

app.post("/v1/auth/email/request-code", async (c) => {
  const body = await c.req.json<unknown>();
  const requestIp = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || null;
  const result = await requestEmailCode(c.env, body, requestIp);
  return c.json({ ok: true as const, data: result }, 202);
});

app.post("/v1/auth/email/verify", async (c) => {
  const body = await c.req.json<unknown>();
  const result = await verifyEmailCode(c.env, body);
  await appendAuditEvent(c.env, {
    tenantId: result.user.tenant_id,
    principal: result.user.principal,
    action: "auth.email.verify",
    resourceType: "session",
    outcome: "succeeded",
    requestId: c.req.header("x-request-id") || c.req.header("cf-ray") || null,
    metadata: { auth_source: "email" }
  });
  c.header(
    "set-cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(result.session_token)}; Max-Age=${SESSION_COOKIE_MAX_AGE}; Path=/; Secure; HttpOnly; SameSite=Lax`
  );
  return jsonOk(c, {
    csrf_token: result.csrf_token,
    expires_at: result.expires_at,
    user: result.user
  });
});

app.post("/v1/auth/logout", async (c) => {
  const result = await logoutSession(c.env, getApiAuthContext(c));
  c.header("set-cookie", `${SESSION_COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`);
  return jsonOk(c, result);
});

app.post("/v1/ops/auth-sessions/revoke-all", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await revokeAllSessions(c.env, tenantId));
});

app.get("/v1/organization", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await getOrganization(c.env, tenantId));
});

app.patch("/v1/organization", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await updateOrganization(c.env, tenantId, body));
});

app.get("/v1/users", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, { users: await listUsers(c.env, tenantId, c.req.query("q")) });
});

app.post("/v1/users", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await createUser(c.env, tenantId, body, getApiPrincipal(c)), 201);
});

app.patch("/v1/users/:principal{.+}", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await updateUser(c.env, tenantId, decodeURIComponent(c.req.param("principal")), body, getApiPrincipal(c)));
});

app.get("/v1/directory", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, { users: await listDirectory(c.env, tenantId, c.req.query("q")) });
});

app.get("/v1/role-assignments", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  const result = await listRoleAssignments(c.env, tenantId, {
    principal: c.req.query("principal"),
    projectId: c.req.query("project_id")
  });
  return jsonOk(c, result);
});

app.put("/v1/role-assignments", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await upsertRoleAssignment(c.env, tenantId, body, getApiPrincipal(c)), 201);
});

app.delete("/v1/role-assignments/:id", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await deleteRoleAssignment(c.env, tenantId, c.req.param("id")));
});

app.get("/v1/scoped-tokens", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await listScopedTokens(c.env, tenantId));
});

app.post("/v1/scoped-tokens", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await issueScopedToken(c.env, tenantId, body, getApiPrincipal(c)), 201);
});

app.delete("/v1/scoped-tokens/:id", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await revokeScopedToken(c.env, tenantId, c.req.param("id")));
});

app.get("/v1/retention-policies", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await listRetentionPolicies(c.env, tenantId));
});

app.put("/v1/retention-policies", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await upsertRetentionPolicy(c.env, tenantId, body, getApiPrincipal(c)));
});

app.post("/v1/retention-policies/apply", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await applyRetentionPolicies(c.env, tenantId, body, getApiPrincipal(c)));
});

app.get("/v1/retention-queue", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  const rawStatus = c.req.query("status");
  const statuses: RetentionQueueStatus[] = ["pending", "deleted", "cancelled", "failed", "manual_review"];
  if (rawStatus && !statuses.includes(rawStatus as RetentionQueueStatus)) {
    throw new HttpError(400, "invalid_payload", "invalid retention queue status");
  }
  const rawLimit = Number(c.req.query("limit") ?? 100);
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 500) {
    throw new HttpError(400, "invalid_payload", "limit must be between 1 and 500");
  }
  return jsonOk(c, await listRetentionQueue(c.env, tenantId, {
    status: rawStatus as RetentionQueueStatus | undefined,
    limit: rawLimit
  }));
});

app.post("/v1/retention-queue/cancel", async (c) => {
  const body = await c.req.json<{ tenant_id?: string; ids?: unknown }>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  if (!Array.isArray(body.ids) || !body.ids.every((id) => typeof id === "string")) {
    throw new HttpError(400, "invalid_payload", "ids must be an array of strings");
  }
  return jsonOk(c, await cancelRetentionQueue(c.env, tenantId, body.ids));
});

app.get("/v1/audit-events", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await listAuditEvents(c.env, tenantId, parseAuditLimit(c.req.query("limit"))));
});

app.get("/v1/audit-events/verify", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await verifyAuditChain(c.env, tenantId));
});

app.post("/v1/retrieval-index/rebuild", async (c) => {
  const body = await c.req.json<{ tenant_id?: string; project_id?: string | null }>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await rebuildSemanticIndex(c.env, tenantId, body.project_id));
});

app.post("/v1/retrieval-index/v3/backfill", async (c) => {
  const body = await c.req.json<{
    tenant_id?: string;
    project_id?: string | null;
    cursor?: string | null;
    limit?: number;
  }>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await backfillV3RetrievalUnits(c.env, {
    tenantId,
    projectId: body.project_id,
    cursor: body.cursor,
    limit: body.limit
  }));
});

app.post("/v1/retrieval-index/v4/backfill", async (c) => {
  const body = await c.req.json<{
    tenant_id?: string;
    project_id?: string | null;
    cursor?: string | null;
    limit?: number;
  }>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await backfillV4RetrievalUnits(c.env, {
    tenantId,
    projectId: body.project_id,
    cursor: body.cursor,
    limit: body.limit
  }));
});

app.post("/v1/retrieval-index/v4/decisions/backfill", async (c) => {
  const body = await c.req.json<{
    tenant_id?: string;
    project_id?: string | null;
    cursor?: string | null;
    limit?: number;
  }>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await backfillDecisionRetrievalUnits(c.env, {
    tenantId,
    projectId: body.project_id,
    cursor: body.cursor,
    limit: body.limit
  }));
});

app.get("/v1/ops/status", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await getOperationsStatus(c.env, tenantId));
});

app.post("/v1/ops/tasks/:id/replay", async (c) => {
  const body: { tenant_id?: string } = await c.req.json<{ tenant_id?: string }>().catch(() => ({}));
  const tenantId = assertApiTenantAccess(c, body.tenant_id);
  return jsonOk(c, await replayFailedTask(
    c.env,
    tenantId,
    c.req.param("id"),
    getApiPrincipal(c)
  ), 201);
});

app.get("/v1/auth/me", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  const result = await getMyIdentity(c.env, tenantId, getApiAuthContext(c));
  return jsonOk(c, result);
});

app.put("/v1/auth/me/profile", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  const result = await updateUserProfile(c.env, tenantId, getApiAuthContext(c), body);
  return jsonOk(c, result);
});

app.get("/v1/groups", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  const result = await listGroups(c.env, tenantId, getApiPrincipal(c), true);
  return jsonOk(c, result);
});

app.post("/v1/groups", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  const result = await createGroup(c.env, tenantId, getApiPrincipal(c), body);
  return jsonOk(c, result, 201);
});

app.get("/v1/groups/:groupId", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  const result = await getGroup(c.env, tenantId, c.req.param("groupId"), getApiPrincipal(c), true);
  return jsonOk(c, result);
});

app.patch("/v1/groups/:groupId", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  const result = await updateGroup(c.env, tenantId, c.req.param("groupId"), getApiPrincipal(c), body, true);
  return jsonOk(c, result);
});

app.post("/v1/groups/:groupId/members", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  const result = await addGroupMember(c.env, tenantId, c.req.param("groupId"), getApiPrincipal(c), body, true);
  return jsonOk(c, result);
});

app.delete("/v1/groups/:groupId/members/:principal", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  const result = await removeGroupMember(
    c.env,
    tenantId,
    c.req.param("groupId"),
    getApiPrincipal(c),
    decodeURIComponent(c.req.param("principal")),
    true
  );
  return jsonOk(c, result);
});

app.delete("/v1/groups/:groupId", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  const result = await archiveGroup(c.env, tenantId, c.req.param("groupId"), getApiPrincipal(c), true);
  return jsonOk(c, result);
});

app.put("/v1/resource-shares", async (c) => {
  const body = await c.req.json<unknown>();
  assertApiTenantAccess(c, tenantFromBody(body));
  const result = await updateResourceShare(c.env, body, getApiPrincipal(c));
  return jsonOk(c, result);
});

app.get("/v1/resource-shares/:resourceType/:resourceId", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  const result = await getResourceShare(c.env, tenantId, c.req.param("resourceType"), c.req.param("resourceId"));
  return jsonOk(c, result);
});

app.post("/v1/agent-messages", async (c) => {
  const body = await c.req.json<unknown>();
  assertApiTenantAccess(c, tenantFromBody(body));
  const result = await sendAgentMessage(c.env, body, { principal: getApiPrincipal(c) });
  return jsonOk(c, result, result.deduped ? 200 : 201);
});

app.get("/v1/agent-messages", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  const limit = Number.parseInt(c.req.query("limit") ?? "50", 10);
  const cursorValue = c.req.query("cursor");
  const cursor = cursorValue ? Number.parseInt(cursorValue, 10) : undefined;
  const result = await listAgentMessages(
    c.env,
    {
      tenant_id: tenantId,
      project_id: c.req.query("project_id"),
      target_type: c.req.query("target_type"),
      target_key: c.req.query("target_key"),
      status: c.req.query("status"),
      limit: Number.isNaN(limit) ? 50 : limit,
      cursor: cursor && !Number.isNaN(cursor) ? cursor : undefined
    },
    { principal: getApiPrincipal(c) }
  );
  return jsonOk(c, result);
});

app.get("/v1/agent-messages/:messageId", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  const result = await getAgentMessage(
    c.env,
    tenantId,
    c.req.param("messageId"),
    {
      tenant_id: tenantId,
      target_type: c.req.query("target_type"),
      target_key: c.req.query("target_key")
    },
    { principal: getApiPrincipal(c) }
  );
  return jsonOk(c, result);
});

app.post("/v1/agent-messages/:messageId/read", async (c) => {
  const body = await c.req.json<unknown>().catch(() => ({}));
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  const result = await markAgentMessageRead(c.env, tenantId, c.req.param("messageId"), body, {
    principal: getApiPrincipal(c)
  });
  return jsonOk(c, result);
});

app.post("/v1/agent-messages/:messageId/ack", async (c) => {
  const body = await c.req.json<unknown>().catch(() => ({}));
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  const result = await ackAgentMessage(c.env, tenantId, c.req.param("messageId"), body, {
    principal: getApiPrincipal(c)
  });
  return jsonOk(c, result);
});

app.post("/v1/tasks", async (c) => {
  const body = await c.req.json<unknown>();
  assertApiTenantAccess(c, tenantFromBody(body));
  const created = await createTask(c.env, body, { actorPrincipal: getApiPrincipal(c) });
  return jsonOk(c, created, 201);
});

app.get("/v1/tasks", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  const status = c.req.query("status");
  const query = c.req.query("q");
  const limit = Number.parseInt(c.req.query("limit") ?? "50", 10);
  const offset = Number.parseInt(c.req.query("offset") ?? "0", 10);
  const tasks = await listTasks(
    c.env,
    tenantId,
    Number.isNaN(limit) ? 50 : limit,
    status,
    query,
    Number.isNaN(offset) ? 0 : offset
  );
  return jsonOk(c, tasks);
});

app.get("/v1/tasks/:taskId", async (c) => {
  const taskId = c.req.param("taskId");
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  const task = await getTask(c.env, tenantId, taskId);
  return jsonOk(c, task);
});

app.get("/v1/tasks/:taskId/events", async (c) => {
  const taskId = c.req.param("taskId");
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  const limit = Number.parseInt(c.req.query("limit") ?? "50", 10);
  const cursorValue = c.req.query("cursor");
  const cursor = cursorValue ? Number.parseInt(cursorValue, 10) : undefined;
  const events = await getTaskEvents(c.env, tenantId, taskId, Number.isNaN(limit) ? 50 : limit, cursor);
  return jsonOk(c, events);
});

app.post("/v1/memory-impact-executions", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await startMemoryImpact(c.env, tenantId, body, getApiPrincipal(c)), 201);
});

app.post("/v1/memory-impact-executions/:externalRunId/report", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await reportMemoryImpact(
    c.env,
    tenantId,
    c.req.param("externalRunId"),
    body,
    getApiPrincipal(c)
  ), 201);
});

app.get("/v1/memory-impact-executions/:externalRunId", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await getMemoryImpactExecution(c.env, tenantId, c.req.param("externalRunId")));
});

app.get("/v1/memory-impact-summary", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  const from = Number.parseInt(c.req.query("from") ?? "", 10);
  const to = Number.parseInt(c.req.query("to") ?? "", 10);
  return jsonOk(c, await getMemoryImpactSummary(c.env, tenantId, {
    from: Number.isNaN(from) ? undefined : from,
    to: Number.isNaN(to) ? undefined : to,
    projectId: c.req.query("project_id")
  }));
});

app.get("/v1/memories", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  const source = c.req.query("source");
  const projectId = c.req.query("project_id");
  const businessCategoryId = c.req.query("business_category_id");
  const workType = c.req.query("work_type") as import("@org-brain/shared").MemoryWorkType | undefined;
  const limit = Number.parseInt(c.req.query("limit") ?? "100", 10);
  const offset = Number.parseInt(c.req.query("offset") ?? "0", 10);
  const paginated = c.req.query("paginated") === "1";
  const cursor = c.req.query("cursor");
  const view = c.req.query("view");
  if (cursor || view) {
    const page = await listMemoriesCursorPage(c.env, tenantId, {
      limit: Number.isNaN(limit) ? (view === "compact" ? 500 : 100) : limit,
      source,
      projectId,
      businessCategoryId,
      workType,
      cursor,
      view: view as "full" | "compact" | undefined
    });
    return jsonOk(c, page);
  }
  if (paginated) {
    const page = await listMemoriesPage(c.env, tenantId, {
      limit: Number.isNaN(limit) ? 24 : limit,
      offset: Number.isNaN(offset) ? 0 : offset,
      source,
      projectId,
      businessCategoryId,
      workType
    });
    return jsonOk(c, page);
  }

  const memories = await listMemories(c.env, tenantId, {
    limit: Number.isNaN(limit) ? 100 : limit,
    offset: Number.isNaN(offset) ? 0 : offset,
    source,
    projectId,
    businessCategoryId,
    workType
  });
  return jsonOk(c, memories);
});

app.get("/v1/business-categories", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await listBusinessCategories(
    c.env,
    tenantId,
    c.req.query("include_inactive") === "true"
  ));
});

app.post("/v1/business-categories", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await createBusinessCategory(c.env, tenantId, body), 201);
});

app.patch("/v1/business-categories/:id", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await updateBusinessCategory(c.env, tenantId, c.req.param("id"), body));
});

app.post("/v1/memory-effects", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await recordMemoryEffect(c.env, tenantId, body), 201);
});

app.post("/v1/memory-usages", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await recordMemoryUsageFromRequest(c.env, tenantId, body, getApiPrincipal(c)), 201);
});

app.post("/v1/memory-usages/state", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await updateMemoryUsageStates(c.env, tenantId, body));
});

app.get("/v1/memory-failure-patterns", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await listMemoryFailurePatterns(c.env, tenantId, c.req.query("project_id")));
});

app.post("/v1/memory-failure-patterns", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await createMemoryFailurePattern(c.env, tenantId, body), 201);
});

app.patch("/v1/memory-failure-patterns/:id", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await updateMemoryFailurePattern(c.env, tenantId, c.req.param("id"), body));
});

app.get("/v1/metrics/memory-impact", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await memoryImpactReport(c.env, tenantId, {
    group_by: c.req.query("group_by") ?? "memory"
  }));
});

app.get("/v1/retrieval-generation-assignments/resolve", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await resolveRetrievalGenerationAssignment(
    c.env,
    tenantId,
    c.req.query("project_id") ?? null
  ));
});

app.put("/v1/retrieval-generation-assignments", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await assignRetrievalGeneration(c.env, tenantId, body));
});

app.post("/v1/retrieval-ranking-profiles", async (c) => {
  const body = await c.req.json<unknown>();
  assertApiTenantAccess(c, tenantFromBody(body));
  assertRetrievalOperator(c.env, getApiAuthContext(c).principal);
  return jsonOk(c, await createRetrievalRankingProfile(c.env, body), 201);
});

app.post("/v1/retrieval-generations", async (c) => {
  const body = await c.req.json<unknown>();
  assertApiTenantAccess(c, tenantFromBody(body));
  assertRetrievalOperator(c.env, getApiAuthContext(c).principal);
  return jsonOk(c, await createRetrievalGeneration(c.env, body), 201);
});

app.post("/v1/retrieval-generations/:id/backfill", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  assertRetrievalOperator(c.env, getApiAuthContext(c).principal);
  return jsonOk(c, await backfillRetrievalGeneration(c.env, tenantId, c.req.param("id"), body));
});

app.patch("/v1/retrieval-generations/:id", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  assertApiTenantAccess(c, tenantFromBody(body));
  assertRetrievalOperator(c.env, getApiAuthContext(c).principal);
  if (typeof body.status !== "string") {
    throw new HttpError(400, "status_required", "status is required");
  }
  return jsonOk(c, await transitionRetrievalGeneration(c.env, c.req.param("id"), body.status, body));
});

app.post("/v1/memories/upsert", async (c) => {
  const body = await c.req.json<unknown>();
  assertApiTenantAccess(c, tenantFromBody(body));
  const result = await upsertMemories(c.env, body, { actorPrincipal: getApiPrincipal(c) });
  return jsonOk(c, result, 201);
});

app.post("/v1/memories/capture", async (c) => {
  const body = await c.req.json<unknown>();
  assertApiTenantAccess(c, tenantFromBody(body));
  const result = await captureMemories(c.env, body, { actorPrincipal: getApiPrincipal(c) });
  return jsonOk(c, result, 201);
});

app.post("/v1/memories/extract", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  if (!body || typeof body !== "object") {
    throw new HttpError(400, "invalid_payload", "request body must be an object");
  }
  const event = body as AgentMemoryEventV1;
  const result = await extractMemoryCandidates(c.env, {
    ...event,
    tenant_id: tenantId,
    actor_type: "principal",
    actor_id: getApiPrincipal(c)
  });
  return jsonOk(c, result);
});

app.post("/v1/memories/propose", async (c) => {
  const body = await c.req.json<unknown>();
  assertApiTenantAccess(c, tenantFromBody(body));
  const result = await proposeMemoryWithRationale(c.env, withPrincipalActor(body, getApiPrincipal(c)));
  return jsonOk(c, result, 201);
});

app.post("/v1/memories/capture-rationale", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  const claimsVerified = captureRequestClaimsVerified(body);
  if (claimsVerified) {
    const auth = getApiAuthContext(c);
    if (auth.scopes && !auth.scopes.includes("memory:attest")) {
      throw new HttpError(403, "memory_attestation_required", "Scoped token lacks memory:attest permission");
    }
    const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const rows = Array.isArray(record.items) ? record.items : record.item ? [record.item] : [];
    const projectIds = new Set(rows.map((item) => item && typeof item === "object" && !Array.isArray(item)
      ? ((item as Record<string, unknown>).project_id as string | null | undefined) ?? null
      : null));
    for (const projectId of projectIds) {
      await assertPermission(c.env, {
        tenantId,
        projectId,
        principal: auth.principal,
        permission: "memory:attest",
        fallbackRole: auth.defaultRole
      });
    }
  }
  const result = await captureMemoryWithInferredRationale(
    c.env,
    withPrincipalActor(body, getApiPrincipal(c)),
    { canAttest: claimsVerified }
  );
  return jsonOk(c, result, 201);
});

app.post("/v1/memories/confirm", async (c) => {
  const body = await c.req.json<unknown>();
  assertApiTenantAccess(c, tenantFromBody(body));
  const result = await confirmProposedMemory(c.env, body);
  return jsonOk(c, result);
});

app.post("/v1/memories/revise", async (c) => {
  const body = await c.req.json<unknown>();
  assertApiTenantAccess(c, tenantFromBody(body));
  const result = await reviseMemoryByRequest(c.env, body, { actorPrincipal: getApiPrincipal(c) });
  return jsonOk(c, result);
});

app.post("/v1/memories/refresh", async (c) => {
  const body = await c.req.json<unknown>();
  assertApiTenantAccess(c, tenantFromBody(body));
  const result = await refreshMemoryByRequest(c.env, body, { actorPrincipal: getApiPrincipal(c) });
  return jsonOk(c, result);
});

app.post("/v1/memories/suppress", async (c) => {
  const body = await c.req.json<unknown>();
  assertApiTenantAccess(c, tenantFromBody(body));
  const result = await suppressMemoryByRequest(c.env, body, { actorPrincipal: getApiPrincipal(c) });
  return jsonOk(c, result);
});

app.delete("/v1/memories/:memoryId", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  const result = await deleteMemoryById(c.env, tenantId, c.req.param("memoryId"), {
    actorPrincipal: getApiPrincipal(c)
  });
  return jsonOk(c, result);
});

app.post("/v1/memories/search", async (c) => {
  const body = await c.req.json<unknown>();
  assertApiTenantAccess(c, tenantFromBody(body));
  const payload = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  if (payload.generation_id || payload.ranking_profile_id) {
    const tenantId = tenantFromBody(body) ?? "default";
    const auth = getApiAuthContext(c);
    await assertPermission(c.env, {
      tenantId,
      projectId: typeof payload.project_id === "string" ? payload.project_id : null,
      principal: getApiPrincipal(c),
      permission: "admin",
      fallbackRole: auth.defaultRole
    });
  }
  const scope = payload.search_scope ?? "evidence";
  if (!["evidence", "governance", "both"].includes(String(scope))) {
    throw new HttpError(400, "invalid_search_scope", "search_scope must be evidence, governance, or both");
  }
  if (scope === "governance") {
    return jsonOk(c, await searchDecisionMemories(c.env, body, { principal: getApiPrincipal(c) }));
  }
  const evidence = await searchMemories(c.env, body, {
    actorPrincipal: getApiPrincipal(c),
    recordUsage: scope !== "both"
  });
  if (scope === "evidence") return jsonOk(c, evidence);
  const governance = await searchDecisionMemories(c.env, body, {
    principal: getApiPrincipal(c),
    recordUsage: false
  });
  const queryHash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(typeof payload.q === "string" ? payload.q : "")
  ).then((digest) => [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""));
  const governanceResults = governance.results as Array<Record<string, unknown>>;
  const usage = await recordMemoryUsage(c.env, {
    tenant_id: evidence.tenant_id,
    project_id: evidence.project_id ?? undefined,
    task_id: typeof payload.task_id === "string" ? payload.task_id : undefined,
    trace_id: typeof payload.trace_id === "string" ? payload.trace_id : undefined,
    external_run_id: typeof payload.external_run_id === "string" ? payload.external_run_id : undefined,
    capability: "memory_search_both",
    access_path: "search",
    request_source: "api",
    query_hash: queryHash,
    requested_business_category_id: typeof payload.business_category_id === "string" ? payload.business_category_id : null,
    requested_work_type: typeof payload.work_type === "string"
      ? payload.work_type as import("@org-brain/shared").MemoryWorkType
      : null,
    retrieval_generation_id: evidence.meta.retrieval?.generation_id === governance.meta.retrieval.generation_id
      ? evidence.meta.retrieval?.generation_id
      : null,
    ranking_profile_id: evidence.meta.retrieval?.ranking_profile_id === governance.meta.retrieval.ranking_profile_id
      ? evidence.meta.retrieval?.ranking_profile_id
      : null,
    actor_principal: getApiPrincipal(c),
    items: [
      ...evidence.results.filter((item) => item.kind === "memory").map((item, index) => ({
        source_type: "memory" as const,
        source_id: item.id,
        source_version: item.current_version ?? null,
        rank: index + 1,
        score: item.score,
        reference_type: "returned" as const,
        used_state: "unknown" as const
      })),
      ...governanceResults.flatMap((item, index) => typeof item.id === "string" ? [{
        source_type: "decision_memory" as const,
        source_id: item.id,
        rank: index + 1,
        score: typeof (item.score as Record<string, unknown> | undefined)?.finalScore === "number"
          ? Number((item.score as Record<string, unknown>).finalScore)
          : null,
        reference_type: "returned" as const,
        used_state: "unknown" as const
      }] : [])
    ]
  });
  return jsonOk(c, {
    tenant_id: evidence.tenant_id,
    project_id: evidence.project_id,
    q: evidence.q,
    search_scope: "both",
    governance,
    evidence,
    meta: {
      usage_id: usage.usage_id,
      verification_sampled: usage.verification_sampled,
      channel_usage_ids: {
        evidence: usage.usage_id,
        governance: usage.usage_id
      }
    }
  });
});

app.post("/v1/memories/retrieve-context", async (c) => {
  const body = await c.req.json<unknown>();
  assertApiTenantAccess(c, tenantFromBody(body));
  const result = await retrieveMemoryContext(c.env, body, {
    actorPrincipal: getApiPrincipal(c)
  });
  return jsonOk(c, result);
});

app.post("/v1/memories/profile", async (c) => {
  const body = await c.req.json<unknown>();
  assertApiTenantAccess(c, tenantFromBody(body));
  const result = await getMemoryProfile(c.env, body, { actorPrincipal: getApiPrincipal(c) });
  return jsonOk(c, result);
});

app.get("/v1/memories/:memoryId/details", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  const result = await getMemoryDetails(c.env, tenantId, c.req.param("memoryId"), {
    actorPrincipal: getApiPrincipal(c)
  });
  return jsonOk(c, result);
});

app.post("/v1/resources", async (c) => {
  assertFeatureEnabled(c.env, "KNOWLEDGE_RESOURCE_INGESTION_ENABLED");
  requireIdempotencyKey(c);
  const body = await c.req.json<unknown>();
  assertApiTenantAccess(c, tenantFromBody(body));
  const result = await upsertKnowledgeResource(c.env, body, getApiPrincipal(c));
  return jsonOk(c, result, result.created ? 201 : 200);
});

app.post("/v1/resources/search", async (c) => {
  assertFeatureEnabled(c.env, "KNOWLEDGE_RESOURCE_INGESTION_ENABLED");
  const body = await c.req.json<unknown>();
  assertApiTenantAccess(c, tenantFromBody(body));
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  return jsonOk(c, await searchKnowledgeResources(c.env, body, {
    principal: getApiPrincipal(c),
    projectId: typeof record.project_id === "string" ? record.project_id : null
  }));
});

app.get("/v1/resources/resolve", async (c) => {
  assertFeatureEnabled(c.env, "KNOWLEDGE_RESOURCE_INGESTION_ENABLED");
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  const uri = c.req.query("uri");
  if (!uri) throw new HttpError(400, "invalid_payload", "uri is required");
  return jsonOk(c, await resolveKnowledgeResource(c.env, tenantId, uri, {
    principal: getApiPrincipal(c),
    projectId: c.req.query("project_id") ?? null
  }));
});

app.post("/v1/resources/backfill", async (c) => {
  assertFeatureEnabled(c.env, "KNOWLEDGE_RESOURCE_INGESTION_ENABLED");
  requireIdempotencyKey(c);
  const body = await c.req.json<unknown>();
  assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await backfillKnowledgeResources(c.env, body, getApiPrincipal(c)));
});

app.post("/v1/resources/:id/locations", async (c) => {
  assertFeatureEnabled(c.env, "KNOWLEDGE_RESOURCE_INGESTION_ENABLED");
  requireIdempotencyKey(c);
  const body = await c.req.json<unknown>();
  assertApiTenantAccess(c, tenantFromBody(body));
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const result = await addKnowledgeResourceLocation(c.env, { ...record, resource_id: c.req.param("id") }, getApiPrincipal(c));
  return jsonOk(c, result, result.created ? 201 : 200);
});

app.post("/v1/resources/:id/refresh", async (c) => {
  assertFeatureEnabled(c.env, "KNOWLEDGE_RESOURCE_INGESTION_ENABLED");
  requireIdempotencyKey(c);
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const result = await captureKnowledgeResourceVersion(
    c.env,
    tenantId,
    c.req.param("id"),
    body,
    getApiPrincipal(c),
    typeof record.project_id === "string" ? record.project_id : null
  );
  return jsonOk(c, result, result.created ? 201 : 200);
});

app.get("/v1/resources/:id/decisions", async (c) => {
  assertFeatureEnabled(c.env, "DECISION_RESOURCE_LINKS_ENABLED");
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await getResourceDecisions(c.env, tenantId, c.req.param("id"), {
    principal: getApiPrincipal(c),
    projectId: c.req.query("project_id") ?? null,
    resourceVersionId: c.req.query("resource_version_id") ?? null
  }));
});

app.get("/v1/decisions/:decisionRef{.+}/resources", async (c) => {
  assertFeatureEnabled(c.env, "DECISION_RESOURCE_LINKS_ENABLED");
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  const rawRef = decodeURIComponent(c.req.param("decisionRef"));
  const separator = rawRef.indexOf(":");
  if (separator < 1) throw new HttpError(400, "invalid_payload", "decisionRef must be source_type:source_id");
  return jsonOk(c, await getDecisionResources(c.env, tenantId, {
    source_type: rawRef.slice(0, separator),
    source_id: rawRef.slice(separator + 1)
  }, {
    principal: getApiPrincipal(c),
    projectId: c.req.query("project_id") ?? null,
    includeRelated: c.req.query("include_related") === "true"
  }));
});

app.post("/v1/decision-resource-links", async (c) => {
  assertFeatureEnabled(c.env, "DECISION_RESOURCE_LINKS_ENABLED");
  const idempotencyKey = requireIdempotencyKey(c);
  const body = await c.req.json<unknown>();
  assertApiTenantAccess(c, tenantFromBody(body));
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const result = await createDecisionResourceLink(
    c.env,
    { ...record, idempotency_key: idempotencyKey },
    getApiPrincipal(c)
  );
  return jsonOk(c, result, result.created ? 201 : 200);
});

app.get("/v1/decision-resource-links/review-queue", async (c) => {
  assertFeatureEnabled(c.env, "DECISION_RESOURCE_LINKS_ENABLED");
  assertFeatureEnabled(c.env, "RESOURCE_RELATION_EXTRACTION_ENABLED");
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await listDecisionResourceLinkProposals(c.env, tenantId, {
    principal: getApiPrincipal(c),
    projectId: c.req.query("project_id") ?? null
  }));
});

app.post("/v1/decision-resource-links/:id/confirm", async (c) => {
  assertFeatureEnabled(c.env, "DECISION_RESOURCE_LINKS_ENABLED");
  assertFeatureEnabled(c.env, "RESOURCE_RELATION_EXTRACTION_ENABLED");
  const idempotencyKey = requireIdempotencyKey(c);
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  return jsonOk(c, await confirmDecisionResourceLinkProposal(
    c.env,
    tenantId,
    c.req.param("id"),
    body,
    getApiPrincipal(c),
    idempotencyKey,
    typeof record.project_id === "string" ? record.project_id : null
  ));
});

app.post("/v1/decision-resource-links/:id/retire", async (c) => {
  assertFeatureEnabled(c.env, "DECISION_RESOURCE_LINKS_ENABLED");
  requireIdempotencyKey(c);
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  return jsonOk(c, await retireDecisionResourceLink(
    c.env,
    tenantId,
    c.req.param("id"),
    getApiPrincipal(c),
    typeof record.project_id === "string" ? record.project_id : null
  ));
});

app.post("/v1/decision-memories", async (c) => {
  const body = await c.req.json<unknown>();
  assertApiTenantAccess(c, tenantFromBody(body));
  const result = await createDecisionMemory(c.env, body, { principal: getApiPrincipal(c) });
  return jsonOk(c, result, 201);
});

app.post("/v1/decision-memories/search", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  const payload = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  if (payload.generation_id || payload.ranking_profile_id) {
    const auth = getApiAuthContext(c);
    await assertPermission(c.env, {
      tenantId,
      projectId: typeof payload.project_id === "string" ? payload.project_id : null,
      principal: getApiPrincipal(c),
      permission: "admin",
      fallbackRole: auth.defaultRole
    });
  }
  const result = await searchDecisionMemories(c.env, body, { principal: getApiPrincipal(c) });
  return jsonOk(c, result);
});

app.get("/v1/decision-memories/:id/context", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  const principal = getApiPrincipal(c);
  const result = await getDecisionMemoryContext(c.env, {
    tenantId,
    id: c.req.param("id"),
    userId: principal,
    agentId: principal
  });
  return jsonOk(c, result);
});

app.post("/v1/decision-memories/:id/revise", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  const body = await c.req.json<unknown>();
  const result = await reviseDecisionMemory(c.env, tenantId, c.req.param("id"), body, { principal: getApiPrincipal(c) });
  return jsonOk(c, result);
});

app.post("/v1/decision-memories/:id/confirm", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  const body = await c.req.json<unknown>();
  const result = await confirmDecisionMemory(c.env, tenantId, c.req.param("id"), body, { principal: getApiPrincipal(c) });
  return jsonOk(c, result);
});

app.post("/v1/context/enrich", async (c) => {
  const body = await c.req.json<unknown>();
  assertApiTenantAccess(c, tenantFromBody(body));
  const result = await enrichContext(c.env, body, { principal: getApiPrincipal(c) });
  return jsonOk(c, result);
});

app.post("/v1/context/pre-action-gate", async (c) => {
  const body = await c.req.json<unknown>();
  assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await preActionDecisionGate(c.env, body, { principal: getApiPrincipal(c) }));
});

app.post("/v1/context/review-check", async (c) => {
  const body = await c.req.json<unknown>();
  assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await preActionDecisionGate(c.env, body, { principal: getApiPrincipal(c) }));
});

app.post("/v1/decision-memories/review-queue", async (c) => {
  const body = await c.req.json<unknown>();
  assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await getDecisionReviewQueue(c.env, body, { principal: getApiPrincipal(c) }));
});

app.post("/v1/context/debt/scan", async (c) => {
  const body = await c.req.json<unknown>();
  assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await getDecisionReviewQueue(c.env, body, { principal: getApiPrincipal(c) }));
});

app.post("/api/context/enrich", async (c) => {
  const body = await c.req.json<unknown>();
  assertApiTenantAccess(c, tenantFromBody(body));
  const result = await enrichContext(c.env, body, { principal: getApiPrincipal(c) });
  return jsonOk(c, result);
});

app.post("/v1/docs", async (c) => {
  const body = await c.req.json<unknown>();
  assertApiTenantAccess(c, tenantFromBody(body));
  const result = await upsertKnowledgeDoc(c.env, body, { principal: getApiPrincipal(c) });
  return jsonOk(c, result, result.created ? 201 : 200);
});

app.post("/v1/docs/search", async (c) => {
  const body = await c.req.json<unknown>();
  assertApiTenantAccess(c, tenantFromBody(body));
  const result = await searchKnowledgeDocs(c.env, body, { principal: getApiPrincipal(c) });
  return jsonOk(c, result);
});

app.get("/v1/docs/:slug{.+}/context", async (c) => {
  const slug = c.req.param("slug");
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  const result = await getKnowledgeDocContext(c.env, tenantId, slug, { principal: getApiPrincipal(c) });
  return jsonOk(c, result);
});

app.get("/v1/docs/:slug{.+}", async (c) => {
  const slug = c.req.param("slug");
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  const result = await getKnowledgeDoc(c.env, tenantId, slug, { principal: getApiPrincipal(c) });
  return jsonOk(c, result);
});

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json(
      { ok: false, error: { code: err.code, message: err.message } },
      { status: err.status as 500 }
    );
  }

  return c.json(
    {
      ok: false,
      error: {
        code: "internal_error",
        message: err instanceof Error ? err.message : "Unexpected error"
      }
    },
    { status: 500 }
  );
});

app.notFound((c) =>
  c.json({ ok: false, error: { code: "not_found", message: "Route not found" } }, { status: 404 })
);

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const scheduledFor = controller.scheduledTime ?? Date.now();
    await runRecordedScheduledJob(env.OPEN_BRAIN_DB, {
      jobName: "retention-sweep",
      scheduledFor,
      now: scheduledFor
    }, async () => runScheduledRetentionSweep(env, scheduledFor));
  }
};
