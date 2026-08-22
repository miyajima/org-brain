import { ackAgentMessage, getAgentMessage, listAgentMessages, markAgentMessageRead, sendAgentMessage } from "./agent-message-service";
import { assertApiTenantAccess, getApiAuthContext, getApiPrincipal, jsonOk, tenantFromBody, type ApiContextEnv } from "./auth";
import { addGroupMember, archiveGroup, createGroup, getGroup, listGroups, removeGroupMember, updateGroup } from "./group-service";
import { getMyIdentity, updateUserProfile } from "./identity-service";
import { getResourceShare, updateResourceShare } from "./share-service";
import { createTask, getTask, getTaskEvents, listTasks } from "./task-service";
import type { Hono } from "hono";

export function registerCollaborationRoutes(app: Hono<ApiContextEnv>): void {
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
}
