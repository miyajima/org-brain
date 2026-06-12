import { HttpError } from "@org-brain/shared";
import { Hono } from "hono";
import { apiKeyAuth, assertApiTenantAccess, getApiAuthContext, getApiPrincipal, jsonOk, tenantFromBody, type ApiContextEnv } from "./auth";
import { confirmDecisionMemory, createDecisionMemory, enrichContext, getDecisionMemoryContext, reviseDecisionMemory, searchDecisionMemories } from "./context-engine-service";
import { addGroupMember, createGroup, getGroup, listGroups, removeGroupMember, updateGroup } from "./group-service";
import { getMyIdentity, updateUserProfile } from "./identity-service";
import { getKnowledgeDoc, getKnowledgeDocContext, searchKnowledgeDocs, upsertKnowledgeDoc } from "./knowledge-docs-service";
import {
  captureMemories,
  getMemoryDetails,
  getMemoryProfile,
  listMemories,
  listMemoriesPage,
  refreshMemoryByRequest,
  reviseMemoryByRequest,
  searchMemories,
  suppressMemoryByRequest,
  upsertMemories
} from "./memory-service";
import { mountMcp, OrgBrainMCP } from "./mcp";
import { captureMemoryWithInferredRationale, confirmProposedMemory, proposeMemoryWithRationale } from "./rationale-service";
import { getResourceShare, updateResourceShare } from "./share-service";
import { createTask, getTask, getTaskEvents, listTasks } from "./task-service";
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

app.use("/v1/*", apiKeyAuth);
app.use("/api/*", apiKeyAuth);

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

app.post("/v1/memories/search", async (c) => {
  const body = await c.req.json<unknown>();
  assertApiTenantAccess(c, tenantFromBody(body));
  const result = await searchMemories(c.env, body);
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
