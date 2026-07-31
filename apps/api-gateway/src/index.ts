import { HttpError, type AgentMemoryEventV1, type OrgPermission } from "@org-brain/shared";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { MiddlewareHandler } from "hono";
import {
  ackAgentMessage,
  getAgentMessage,
  listAgentMessages,
  markAgentMessageRead,
  sendAgentMessage
} from "./agent-message-service";
import { appendAuditEvent, listAuditEvents, parseAuditLimit, verifyAuditChain } from "./audit-service";
import {
  backfillV3RetrievalUnits,
  backfillV4RetrievalUnits,
  rebuildSemanticIndex
} from "./retrieval-index-service";
import { getOperationsStatus } from "./operations-service";
import { assertRequestRateLimit } from "./rate-limit-service";
import { extractMemoryCandidates } from "./memory-extraction-service";
import {
  applyRetentionPolicies,
  listRetentionPolicies,
  upsertRetentionPolicy
} from "./retention-service";
import { apiKeyAuth, assertApiTenantAccess, getApiAuthContext, getApiPrincipal, jsonOk, tenantFromBody, type ApiContextEnv } from "./auth";
import {
  confirmDecisionMemory,
  createDecisionMemory,
  enrichContext,
  getDecisionMemoryContext,
  getDecisionReviewQueue,
  preActionDecisionGate,
  reviseDecisionMemory,
  searchDecisionMemories
} from "./context-engine-service";
import { addGroupMember, createGroup, getGroup, listGroups, removeGroupMember, updateGroup } from "./group-service";
import { getMyIdentity, updateUserProfile } from "./identity-service";
import { getKnowledgeDoc, getKnowledgeDocContext, searchKnowledgeDocs, upsertKnowledgeDoc } from "./knowledge-docs-service";
import {
  captureMemories,
  deleteMemoryById,
  getMemoryDetails,
  getMemoryProfile,
  listMemories,
  listMemoriesPage,
  refreshMemoryByRequest,
  reviseMemoryByRequest,
  retrieveMemoryContext,
  searchMemories,
  suppressMemoryByRequest,
  upsertMemories
} from "./memory-service";
import { mountMcp, OrgBrainMCP } from "./mcp";
import { captureMemoryWithInferredRationale, confirmProposedMemory, proposeMemoryWithRationale } from "./rationale-service";
import {
  assertPermission,
  deleteRoleAssignment,
  listRoleAssignments,
  upsertRoleAssignment
} from "./rbac-service";
import { getResourceShare, updateResourceShare } from "./share-service";
import { createTask, getTask, getTaskEvents, listTasks, replayFailedTask } from "./task-service";
import { issueScopedToken, listScopedTokens, revokeScopedToken } from "./token-service";
import type { Env } from "./types";

const app = new Hono<ApiContextEnv>();

function withPrincipalActor(rawBody: unknown, principal: string): unknown {
  if (!rawBody || typeof rawBody !== "object") return rawBody;
  const body = rawBody as Record<string, unknown>;
  return {
    ...body,
    actor_type: "principal",
    actor_id: principal
  };
}

mountMcp(app);

app.use(
  "/v1/*",
  cors({
    origin: "*",
    allowHeaders: ["content-type", "x-api-key", "authorization"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    maxAge: 86400
  })
);
app.use(
  "/api/*",
  cors({
    origin: "*",
    allowHeaders: ["content-type", "x-api-key", "authorization"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    maxAge: 86400
  })
);

app.use("/v1/*", apiKeyAuth);
app.use("/api/*", apiKeyAuth);

function permissionForRequest(method: string, path: string): OrgPermission {
  if (path.startsWith("/v1/auth/")) return method === "GET" ? "read" : "write";
  if (
    path.startsWith("/v1/role-assignments") ||
    path.startsWith("/v1/groups") ||
    path.startsWith("/v1/scoped-tokens") ||
    path.startsWith("/v1/retention-policies") ||
    path.startsWith("/v1/ops/") ||
    path.startsWith("/v1/retrieval-index")
  ) return "admin";
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

app.get("/v1/ops/status", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await getOperationsStatus(c.env, tenantId));
});

app.post("/v1/ops/tasks/:id/replay", async (c) => {
  const body: { tenant_id?: string } = await c.req.json<{ tenant_id?: string }>().catch(() => ({}));
  const tenantId = assertApiTenantAccess(c, body.tenant_id);
  return jsonOk(c, await replayFailedTask(c.env, tenantId, c.req.param("id")), 201);
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
  const result = await listGroups(c.env, tenantId, getApiPrincipal(c));
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
  const result = await getGroup(c.env, tenantId, c.req.param("groupId"), getApiPrincipal(c));
  return jsonOk(c, result);
});

app.patch("/v1/groups/:groupId", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  const result = await updateGroup(c.env, tenantId, c.req.param("groupId"), getApiPrincipal(c), body);
  return jsonOk(c, result);
});

app.post("/v1/groups/:groupId/members", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  const result = await addGroupMember(c.env, tenantId, c.req.param("groupId"), getApiPrincipal(c), body);
  return jsonOk(c, result);
});

app.delete("/v1/groups/:groupId/members/:principal", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  const result = await removeGroupMember(
    c.env,
    tenantId,
    c.req.param("groupId"),
    getApiPrincipal(c),
    decodeURIComponent(c.req.param("principal"))
  );
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
  const created = await createTask(c.env, body);
  return jsonOk(c, created, 201);
});

app.get("/v1/tasks", async (c) => {
  const tenantId = c.req.query("tenant_id") ?? "default";
  const status = c.req.query("status");
  const limit = Number.parseInt(c.req.query("limit") ?? "50", 10);
  const tasks = await listTasks(c.env, tenantId, Number.isNaN(limit) ? 50 : limit, status);
  return jsonOk(c, tasks);
});

app.get("/v1/tasks/:taskId", async (c) => {
  const taskId = c.req.param("taskId");
  const tenantId = c.req.query("tenant_id") ?? "default";
  const task = await getTask(c.env, tenantId, taskId);
  return jsonOk(c, task);
});

app.get("/v1/tasks/:taskId/events", async (c) => {
  const taskId = c.req.param("taskId");
  const tenantId = c.req.query("tenant_id") ?? "default";
  const limit = Number.parseInt(c.req.query("limit") ?? "50", 10);
  const cursorValue = c.req.query("cursor");
  const cursor = cursorValue ? Number.parseInt(cursorValue, 10) : undefined;
  const events = await getTaskEvents(c.env, tenantId, taskId, Number.isNaN(limit) ? 50 : limit, cursor);
  return jsonOk(c, events);
});

app.get("/v1/memories", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  const source = c.req.query("source");
  const projectId = c.req.query("project_id");
  const limit = Number.parseInt(c.req.query("limit") ?? "100", 10);
  const offset = Number.parseInt(c.req.query("offset") ?? "0", 10);
  const paginated = c.req.query("paginated") === "1";
  if (paginated) {
    const page = await listMemoriesPage(c.env, tenantId, {
      limit: Number.isNaN(limit) ? 24 : limit,
      offset: Number.isNaN(offset) ? 0 : offset,
      source,
      projectId
    });
    return jsonOk(c, page);
  }

  const memories = await listMemories(c.env, tenantId, {
    limit: Number.isNaN(limit) ? 100 : limit,
    offset: Number.isNaN(offset) ? 0 : offset,
    source,
    projectId
  });
  return jsonOk(c, memories);
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
  assertApiTenantAccess(c, tenantFromBody(body));
  const result = await captureMemoryWithInferredRationale(c.env, withPrincipalActor(body, getApiPrincipal(c)));
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
  const result = await searchMemories(c.env, body, { actorPrincipal: getApiPrincipal(c) });
  return jsonOk(c, result);
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
  const result = await getMemoryProfile(c.env, body);
  return jsonOk(c, result);
});

app.get("/v1/memories/:memoryId/details", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  const result = await getMemoryDetails(c.env, tenantId, c.req.param("memoryId"));
  return jsonOk(c, result);
});

app.post("/v1/decision-memories", async (c) => {
  const body = await c.req.json<unknown>();
  assertApiTenantAccess(c, tenantFromBody(body));
  const result = await createDecisionMemory(c.env, body, { principal: getApiPrincipal(c) });
  return jsonOk(c, result, 201);
});

app.post("/v1/decision-memories/search", async (c) => {
  const body = await c.req.json<unknown>();
  assertApiTenantAccess(c, tenantFromBody(body));
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

export default app;
export { OrgBrainMCP };
