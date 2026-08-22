import { decisionBriefingQuerySchema, decisionTraceQuerySchema } from "@org-brain/contracts";
import { HttpError } from "./errors.js";
import type { DomainPort, RouteApp, RouteAppEnv } from "./ports.js";
import { withRouteContracts } from "./route-contracts.js";

export function registerDomainRoutes<TEnv extends RouteAppEnv>(
  app: RouteApp<TEnv>,
  ports: DomainPort<TEnv>
): void {
const routes = withRouteContracts(app, "domain");
routes.get("/v1/capabilities", async (c) => {
  ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, ports.domainCapabilities(c.env));
});

routes.get("/v1/domain-packs", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.listDomainPacks(c.env, tenantId));
});

routes.post("/v1/domain-packs/installations/plan", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.planDomainPackInstallation(c.env, tenantId, body));
});

routes.post("/v1/domain-packs/installations", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.installDomainPacks(c.env, tenantId, ports.getApiPrincipal(c), body), 201);
});

routes.delete("/v1/domain-packs/installations/:id", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.uninstallDomainPack(c.env, tenantId, c.req.param("id")));
});

routes.get("/v1/domain-packs/:packId/workspace", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.getDomainPackWorkspace(c.env, tenantId, c.req.param("packId"), {
    scopeId: c.req.query("scope_id") ?? null,
    from: c.req.query("from") ? Number(c.req.query("from")) : undefined,
    to: c.req.query("to") ? Number(c.req.query("to")) : undefined,
    principal: ports.getApiPrincipal(c),
    includeAllRecalls: await ports.isTenantAdmin(c, tenantId)
  }));
});

routes.post("/v1/metric-definitions", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.createMetricDefinition(c.env, tenantId, ports.getApiPrincipal(c), body), 201);
});

routes.post("/v1/metric-definitions/:id/versions", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.createMetricDefinitionVersion(c.env, tenantId, ports.getApiPrincipal(c), c.req.param("id"), body), 201);
});

routes.post("/v1/metric-definitions/:id/promotion", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.recordMetricPromotion(c.env, tenantId, c.req.param("id"), body));
});

routes.put("/v1/metric-definitions/:id/target", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.setMetricTarget(c.env, tenantId, ports.getApiPrincipal(c), c.req.param("id"), body));
});

routes.post("/v1/metric-definitions/:id/bindings", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.createMetricBinding(c.env, tenantId, ports.getApiPrincipal(c), c.req.param("id"), body), 201);
});

routes.post("/v1/metric-snapshots", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.createMetricSnapshot(c.env, tenantId, ports.getApiPrincipal(c), body), 201);
});

routes.get("/v1/metrics/query", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.queryMetrics(c.env, tenantId, {
    metricKeys: c.req.queries("metric_key") ?? c.req.query("metric_keys")?.split(","),
    scopeId: c.req.query("scope_id") ?? null,
    limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined
  }));
});

routes.get("/v1/metric-snapshots/query", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.queryMetricSnapshots(c.env, tenantId, {
    metricKeys: c.req.queries("metric_key") ?? c.req.query("metric_keys")?.split(","),
    scopeId: c.req.query("scope_id") ?? null,
    from: c.req.query("from") ? Number(c.req.query("from")) : undefined,
    to: c.req.query("to") ? Number(c.req.query("to")) : undefined,
    limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined
  }));
});

routes.get("/v1/metric-source-bindings", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.listMetricSourceBindings(c.env, tenantId, {
    metricDefinitionId: c.req.query("metric_definition_id"),
    status: c.req.query("status")
  }));
});

routes.get("/v1/domain-dashboards", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.listDomainDashboards(c.env, tenantId));
});

routes.post("/v1/domain-dashboards", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.upsertDomainDashboard(c.env, tenantId, ports.getApiPrincipal(c), body), 201);
});

routes.post("/v1/managed-object-types", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.createManagedObjectType(c.env, tenantId, ports.getApiPrincipal(c), body), 201);
});

routes.post("/v1/managed-objects", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.createManagedObject(c.env, tenantId, ports.getApiPrincipal(c), body), 201);
});

routes.post("/v1/managed-object-relations", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.createManagedObjectRelation(c.env, tenantId, ports.getApiPrincipal(c), body), 201);
});

routes.post("/v1/managed-object-external-refs", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.createManagedObjectExternalRef(c.env, tenantId, body), 201);
});

routes.get("/v1/managed-objects/search", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.searchManagedObjects(c.env, tenantId, {
    q: c.req.query("q"), typeKey: c.req.query("type_key"), projectId: c.req.query("project_id"),
    limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined
  }));
});

routes.post("/v1/decision-domain-links", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.createDecisionDomainLink(c.env, tenantId, ports.getApiPrincipal(c), body), 201);
});

routes.get("/v1/domain-context", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.getDomainContext(c.env, tenantId, {
    objectId: c.req.query("object_id"), metricKey: c.req.query("metric_key"), decisionId: c.req.query("decision_id")
  }));
});

routes.get("/v1/decision-briefing", async (c) => {
  ports.assertDecisionConsoleEnabled(c.env);
  const parsed = decisionBriefingQuerySchema.safeParse({
    tenant_id: c.req.query("tenant_id"),
    project_id: c.req.query("project_id"),
    limit: c.req.query("limit")
  });
  if (!parsed.success) throw new HttpError(400, "invalid_query", parsed.error.issues[0]?.message ?? "Invalid query");
  const tenantId = ports.assertApiTenantAccess(c, parsed.data.tenant_id);
  return ports.jsonOk(c, await ports.getDecisionBriefing(c.env, {
    tenantId,
    principal: ports.getApiPrincipal(c),
    projectId: parsed.data.project_id,
    limit: parsed.data.limit
  }));
});

routes.get("/v1/decisions/:id/trace", async (c) => {
  ports.assertDecisionConsoleEnabled(c.env);
  const parsed = decisionTraceQuerySchema.safeParse({
    tenant_id: c.req.query("tenant_id"),
    project_id: c.req.query("project_id"),
    include_inferred: c.req.query("include_inferred"),
    node_limit: c.req.query("node_limit"),
    edge_limit: c.req.query("edge_limit")
  });
  if (!parsed.success) throw new HttpError(400, "invalid_query", parsed.error.issues[0]?.message ?? "Invalid query");
  const tenantId = ports.assertApiTenantAccess(c, parsed.data.tenant_id);
  return ports.jsonOk(c, await ports.getDecisionTrace(c.env, {
    tenantId,
    decisionId: c.req.param("id"),
    principal: ports.getApiPrincipal(c),
    projectId: parsed.data.project_id,
    includeInferred: parsed.data.include_inferred,
    nodeLimit: parsed.data.node_limit,
    edgeLimit: parsed.data.edge_limit
  }));
});

routes.get("/v1/decisions/:id/map", async (c) => {
  ports.assertDecisionConsoleEnabled(c.env);
  const parsed = decisionTraceQuerySchema.safeParse({
    tenant_id: c.req.query("tenant_id"),
    project_id: c.req.query("project_id"),
    include_inferred: c.req.query("include_inferred"),
    node_limit: c.req.query("node_limit"),
    edge_limit: c.req.query("edge_limit")
  });
  if (!parsed.success) throw new HttpError(400, "invalid_query", parsed.error.issues[0]?.message ?? "Invalid query");
  const tenantId = ports.assertApiTenantAccess(c, parsed.data.tenant_id);
  return ports.jsonOk(c, await ports.getDecisionMap(c.env, {
    tenantId,
    decisionId: c.req.param("id"),
    principal: ports.getApiPrincipal(c),
    projectId: parsed.data.project_id,
    includeInferred: parsed.data.include_inferred,
    nodeLimit: parsed.data.node_limit,
    edgeLimit: parsed.data.edge_limit
  }));
});
}
