import { parseLimitParam } from "./limit-param.js";
import type { CollaborationPort, RouteApp, RouteAppEnv } from "./ports.js";
import { withRouteContracts } from "./route-contracts.js";

export function registerCollaborationRoutes<TEnv extends RouteAppEnv>(
  app: RouteApp<TEnv>,
  ports: CollaborationPort<TEnv>
): void {
const routes = withRouteContracts(app, "collaboration");
routes.get("/v1/auth/me", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  const result = await ports.getMyIdentity(
    c.env,
    tenantId,
    ports.getApiAuthContext(c),
    c.req.query("project_id")?.trim() || null
  );
  return ports.jsonOk(c, result);
});

routes.put("/v1/auth/me/profile", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  const result = await ports.updateUserProfile(c.env, tenantId, ports.getApiAuthContext(c), body);
  return ports.jsonOk(c, result);
});

routes.get("/v1/groups", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  const result = await ports.listGroups(c.env, tenantId, ports.getApiPrincipal(c), true);
  return ports.jsonOk(c, result);
});

routes.post("/v1/groups", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  const result = await ports.createGroup(c.env, tenantId, ports.getApiPrincipal(c), body);
  return ports.jsonOk(c, result, 201);
});

routes.get("/v1/groups/:groupId", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  const result = await ports.getGroup(c.env, tenantId, c.req.param("groupId"), ports.getApiPrincipal(c), true);
  return ports.jsonOk(c, result);
});

routes.patch("/v1/groups/:groupId", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  const result = await ports.updateGroup(c.env, tenantId, c.req.param("groupId"), ports.getApiPrincipal(c), body, true);
  return ports.jsonOk(c, result);
});

routes.post("/v1/groups/:groupId/members", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  const result = await ports.addGroupMember(c.env, tenantId, c.req.param("groupId"), ports.getApiPrincipal(c), body, true);
  return ports.jsonOk(c, result);
});

routes.get("/v1/groups/:groupId/members/:principal/impact", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  const result = await ports.getGroupMemberImpact(
    c.env, tenantId, c.req.param("groupId"), ports.getApiPrincipal(c),
    decodeURIComponent(c.req.param("principal")), true
  );
  return ports.jsonOk(c, result);
});

routes.delete("/v1/groups/:groupId/members/:principal", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  const ifMatch = c.req.header("if-match")?.trim().replace(/^W\//u, "").replace(/^"|"$/gu, "") || null;
  const result = await ports.removeGroupMember(
    c.env,
    tenantId,
    c.req.param("groupId"),
    ports.getApiPrincipal(c),
    decodeURIComponent(c.req.param("principal")),
    ifMatch,
    true
  );
  return ports.jsonOk(c, result);
});

routes.delete("/v1/groups/:groupId", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  const result = await ports.archiveGroup(c.env, tenantId, c.req.param("groupId"), ports.getApiPrincipal(c), true);
  return ports.jsonOk(c, result);
});

routes.put("/v1/resource-shares", async (c) => {
  const body = await c.req.json<unknown>();
  ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  const result = await ports.updateResourceShare(c.env, body, ports.getApiPrincipal(c));
  return ports.jsonOk(c, result);
});

routes.get("/v1/resource-shares/:resourceType/:resourceId", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  const result = await ports.getResourceShare(c.env, tenantId, c.req.param("resourceType"), c.req.param("resourceId"));
  return ports.jsonOk(c, result);
});

routes.post("/v1/agent-messages", async (c) => {
  const body = await c.req.json<unknown>();
  ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  const result = await ports.sendAgentMessage(c.env, body, { principal: ports.getApiPrincipal(c) });
  return ports.jsonOk(c, result, result.deduped ? 200 : 201);
});

routes.get("/v1/agent-messages", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  const limit = parseLimitParam(c.req.query("limit"), { field: "limit", min: 1, max: Number.MAX_SAFE_INTEGER, fallback: 50 });
  const cursorValue = c.req.query("cursor");
  const cursor = cursorValue ? Number.parseInt(cursorValue, 10) : undefined;
  const result = await ports.listAgentMessages(
    c.env,
    {
      tenant_id: tenantId,
      project_id: c.req.query("project_id"),
      target_type: c.req.query("target_type"),
      target_key: c.req.query("target_key"),
      status: c.req.query("status"),
      limit,
      cursor: cursor && !Number.isNaN(cursor) ? cursor : undefined
    },
    { principal: ports.getApiPrincipal(c) }
  );
  return ports.jsonOk(c, result);
});

routes.get("/v1/agent-messages/:messageId", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  const result = await ports.getAgentMessage(
    c.env,
    tenantId,
    c.req.param("messageId"),
    {
      tenant_id: tenantId,
      target_type: c.req.query("target_type"),
      target_key: c.req.query("target_key")
    },
    { principal: ports.getApiPrincipal(c) }
  );
  return ports.jsonOk(c, result);
});

routes.post("/v1/agent-messages/:messageId/read", async (c) => {
  const body = await c.req.json<unknown>().catch(() => ({}));
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  const result = await ports.markAgentMessageRead(c.env, tenantId, c.req.param("messageId"), body, {
    principal: ports.getApiPrincipal(c)
  });
  return ports.jsonOk(c, result);
});

routes.post("/v1/agent-messages/:messageId/ack", async (c) => {
  const body = await c.req.json<unknown>().catch(() => ({}));
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  const result = await ports.ackAgentMessage(c.env, tenantId, c.req.param("messageId"), body, {
    principal: ports.getApiPrincipal(c)
  });
  return ports.jsonOk(c, result);
});

routes.post("/v1/tasks", async (c) => {
  const body = await c.req.json<unknown>();
  ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  const created = await ports.createTask(c.env, body, { actorPrincipal: ports.getApiPrincipal(c) });
  return ports.jsonOk(c, created, 201);
});

routes.get("/v1/tasks", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  const status = c.req.query("status");
  const query = c.req.query("q");
  const limit = parseLimitParam(c.req.query("limit"), { field: "limit", min: 1, max: Number.MAX_SAFE_INTEGER, fallback: 50 });
  const offset = parseLimitParam(c.req.query("offset"), { field: "offset", min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 });
  const tasks = await ports.listTasks(
    c.env,
    tenantId,
    limit,
    status,
    query,
    offset
  );
  return ports.jsonOk(c, tasks);
});

routes.get("/v1/tasks/:taskId", async (c) => {
  const taskId = c.req.param("taskId");
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  const task = await ports.getTask(c.env, tenantId, taskId);
  return ports.jsonOk(c, task);
});

routes.get("/v1/tasks/:taskId/events", async (c) => {
  const taskId = c.req.param("taskId");
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  const limit = parseLimitParam(c.req.query("limit"), { field: "limit", min: 1, max: Number.MAX_SAFE_INTEGER, fallback: 50 });
  const cursorValue = c.req.query("cursor");
  const cursor = cursorValue ? Number.parseInt(cursorValue, 10) : undefined;
  const events = await ports.getTaskEvents(c.env, tenantId, taskId, limit, cursor);
  return ports.jsonOk(c, events);
});
}
