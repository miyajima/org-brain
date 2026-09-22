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
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, ports.domainCapabilities(c.env, tenantId, await ports.isTenantAdmin(c, tenantId)));
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

routes.post("/v1/knowledge-pack-onboardings", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.createKnowledgePackOnboarding(
    c.env,
    tenantId,
    ports.getApiPrincipal(c),
    ports.requireIdempotencyKey(c),
    body
  ), 201);
});

routes.get("/v1/knowledge-pack-onboardings/:id", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.getKnowledgePackOnboarding(
    c.env,
    tenantId,
    c.req.param("id"),
    c.req.query("project_id") ?? null
  ));
});

routes.patch("/v1/knowledge-pack-onboardings/:id/steps/:step", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.updateKnowledgePackOnboardingStep(
    c.env,
    tenantId,
    c.req.param("id"),
    c.req.param("step"),
    body
  ));
});

routes.post("/v1/knowledge-pack-onboardings/:id/plan", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  ports.requireIdempotencyKey(c);
  return ports.jsonOk(c, await ports.planKnowledgePackOnboarding(c.env, tenantId, c.req.param("id"), body));
});

routes.post("/v1/knowledge-pack-onboardings/:id/complete", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.completeKnowledgePackOnboarding(
    c.env,
    tenantId,
    ports.getApiPrincipal(c),
    c.req.param("id"),
    ports.requireIdempotencyKey(c),
    body
  ));
});

routes.get("/v1/dashboard/organization", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.getOrganizationDashboard(c.env, tenantId, {
    principal: ports.getApiPrincipal(c), projectId: c.req.query("project_id") ?? null,
    includeAll: await ports.isTenantAdmin(c, tenantId)
  }));
});

routes.get("/v1/dashboard/organization/metrics", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  const dashboard = await ports.getOrganizationDashboard(c.env, tenantId, {
    principal: ports.getApiPrincipal(c), projectId: c.req.query("project_id") ?? null,
    includeAll: await ports.isTenantAdmin(c, tenantId)
  }) as { goals?: unknown[] };
  return ports.jsonOk(c, dashboard.goals ?? []);
});

routes.post("/v1/dashboard/organization/knowledge-packs/:installationId/goals/:goalLinkId/snapshots", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  if (!await ports.isTenantAdmin(c, tenantId)) throw new HttpError(403, "admin_required", "Tenant administrator access is required");
  return ports.jsonOk(c, await ports.recordKnowledgePackGoalSnapshot(
    c.env, tenantId, ports.getApiPrincipal(c), c.req.param("installationId"), c.req.param("goalLinkId"),
    ports.requireIdempotencyKey(c), body
  ), 201);
});

routes.get("/v1/metric-connections", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  if (!await ports.isTenantAdmin(c, tenantId)) throw new HttpError(403, "admin_required", "Tenant administrator access is required");
  return ports.jsonOk(c, await ports.listMetricConnections(c.env, tenantId, c.req.query("adapter_id")));
});

routes.post("/v1/metric-source-bindings/:bindingId/import", async (c) => {
  const body = await c.req.json<unknown>().catch(() => ({}));
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  if (!await ports.isTenantAdmin(c, tenantId)) throw new HttpError(403, "admin_required", "Tenant administrator access is required");
  return ports.jsonOk(c, await ports.enqueueMetricImport(
    c.env, tenantId, ports.getApiPrincipal(c), c.req.param("bindingId"), ports.requireIdempotencyKey(c)
  ), 202);
});

routes.get("/v1/metric-import-runs/:runId", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  if (!await ports.isTenantAdmin(c, tenantId)) throw new HttpError(403, "admin_required", "Tenant administrator access is required");
  return ports.jsonOk(c, await ports.getMetricImportRun(c.env, tenantId, c.req.param("runId")));
});

routes.post("/v1/retrospective-schedules", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  if (!await ports.isTenantAdmin(c, tenantId)) throw new HttpError(403, "admin_required", "Tenant administrator access is required");
  return ports.jsonOk(c, await ports.createRetrospectiveSchedule(c.env, tenantId, ports.getApiPrincipal(c), body), 201);
});

routes.get("/v1/retrospective-schedules", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  if (!await ports.isTenantAdmin(c, tenantId)) throw new HttpError(403, "admin_required", "Tenant administrator access is required");
  return ports.jsonOk(c, await ports.listRetrospectiveSchedules(c.env, tenantId));
});

routes.patch("/v1/retrospective-schedules/:id", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  if (!await ports.isTenantAdmin(c, tenantId)) throw new HttpError(403, "admin_required", "Tenant administrator access is required");
  return ports.jsonOk(c, await ports.updateRetrospectiveSchedule(c.env, tenantId, c.req.param("id"), body));
});

routes.post("/v1/retrospectives", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  if (!await ports.isTenantAdmin(c, tenantId)) throw new HttpError(403, "admin_required", "Tenant administrator access is required");
  return ports.jsonOk(c, await ports.createRetrospective(c.env, tenantId, ports.getApiPrincipal(c), body), 201);
});

routes.get("/v1/retrospectives", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.listRetrospectives(
    c.env, tenantId, ports.getApiPrincipal(c), await ports.isTenantAdmin(c, tenantId)
  ));
});

routes.get("/v1/retrospectives/:id", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.getRetrospective(
    c.env, tenantId, c.req.param("id"), ports.getApiPrincipal(c), await ports.isTenantAdmin(c, tenantId)
  ));
});

routes.put("/v1/retrospectives/:id/items/:itemId/response", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.putRetrospectiveResponse(
    c.env, tenantId, c.req.param("id"), c.req.param("itemId"), ports.getApiPrincipal(c), body
  ));
});

routes.post("/v1/retrospectives/:id/close", async (c) => {
  const body = await c.req.json<unknown>().catch(() => ({}));
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  if (!await ports.isTenantAdmin(c, tenantId)) throw new HttpError(403, "admin_required", "Tenant administrator access is required");
  return ports.jsonOk(c, await ports.closeRetrospective(
    c.env, tenantId, c.req.param("id"), ports.getApiPrincipal(c), ports.requireIdempotencyKey(c), body
  ));
});

routes.post("/v1/retrospectives/:id/cancel", async (c) => {
  const body = await c.req.json<unknown>().catch(() => ({}));
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  if (!await ports.isTenantAdmin(c, tenantId)) throw new HttpError(403, "admin_required", "Tenant administrator access is required");
  return ports.jsonOk(c, await ports.cancelRetrospective(c.env, tenantId, c.req.param("id")));
});

routes.get("/v1/retrospectives/:id/results", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.getRetrospectiveResults(
    c.env, tenantId, c.req.param("id"), ports.getApiPrincipal(c), await ports.isTenantAdmin(c, tenantId)
  ));
});

routes.post("/v1/improvement-actions", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  if (!await ports.isTenantAdmin(c, tenantId)) throw new HttpError(403, "admin_required", "Tenant administrator access is required");
  return ports.jsonOk(c, await ports.createImprovementAction(c.env, tenantId, ports.getApiPrincipal(c), body), 201);
});

routes.get("/v1/improvement-actions", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.listImprovementActions(c.env, tenantId, {
    status: c.req.query("status"), owner: c.req.query("owner"),
    principal: ports.getApiPrincipal(c), includeAll: await ports.isTenantAdmin(c, tenantId)
  }));
});

routes.patch("/v1/improvement-actions/:id", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.updateImprovementAction(
    c.env, tenantId, c.req.param("id"), ports.getApiPrincipal(c), await ports.isTenantAdmin(c, tenantId), body
  ));
});

routes.post("/v1/improvement-actions/:id/verify", async (c) => {
  const body = await c.req.json<unknown>().catch(() => ({}));
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.verifyImprovementAction(
    c.env, tenantId, c.req.param("id"), ports.getApiPrincipal(c), await ports.isTenantAdmin(c, tenantId)
  ));
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
