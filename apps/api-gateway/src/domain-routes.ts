import { decisionBriefingQuerySchema, decisionTraceQuerySchema } from "@org-brain/contracts";
import { HttpError } from "@org-brain/shared";
import { getDomainContext, createDecisionDomainLink, createManagedObject, createManagedObjectExternalRef, createManagedObjectRelation, createManagedObjectType, createMetricBinding, createMetricDefinition, createMetricDefinitionVersion, createMetricSnapshot, listDomainDashboards, listMetricSourceBindings, queryMetricSnapshots, queryMetrics, recordMetricPromotion, searchManagedObjects, setMetricTarget, upsertDomainDashboard } from "./domain-metric-service";
import { getDomainPackWorkspace } from "./domain-workspace-service";
import { installDomainPacks, listDomainPacks, planDomainPackInstallation, uninstallDomainPack } from "./domain-pack-service";
import { getDecisionBriefing, getDecisionMap, getDecisionTrace } from "./decision-console-service";
import { assertApiTenantAccess, getApiPrincipal, jsonOk, tenantFromBody, type ApiContextEnv } from "./auth";
import type { Hono } from "hono";
import { assertDecisionConsoleEnabled, isTenantAdmin } from "./route-support";

export function registerDomainRoutes(app: Hono<ApiContextEnv>): void {
app.get("/v1/capabilities", async (c) => {
  assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, {
    domain_packs: {
      mode: c.env.DOMAIN_PACKS_MODE ?? "off",
      enabled: c.env.DOMAIN_PACKS_MODE !== undefined && c.env.DOMAIN_PACKS_MODE !== "off"
    },
    domain_metrics: {
      mode: c.env.DOMAIN_METRICS_MODE ?? "off",
      enabled: c.env.DOMAIN_METRICS_MODE !== undefined && c.env.DOMAIN_METRICS_MODE !== "off"
    },
    domain_workspaces: {
      mode: c.env.DOMAIN_WORKSPACES_MODE ?? "off",
      enabled: c.env.DOMAIN_WORKSPACES_MODE !== undefined && c.env.DOMAIN_WORKSPACES_MODE !== "off"
    },
    pack_builder: { enabled: false, href: null, edition: "enterprise" }
  });
});

app.get("/v1/domain-packs", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await listDomainPacks(c.env, tenantId));
});

app.post("/v1/domain-packs/installations/plan", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await planDomainPackInstallation(c.env, tenantId, body));
});

app.post("/v1/domain-packs/installations", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await installDomainPacks(c.env, tenantId, getApiPrincipal(c), body), 201);
});

app.delete("/v1/domain-packs/installations/:id", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await uninstallDomainPack(c.env, tenantId, c.req.param("id")));
});

app.get("/v1/domain-packs/:packId/workspace", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await getDomainPackWorkspace(c.env, tenantId, c.req.param("packId"), {
    scopeId: c.req.query("scope_id") ?? null,
    from: c.req.query("from") ? Number(c.req.query("from")) : undefined,
    to: c.req.query("to") ? Number(c.req.query("to")) : undefined,
    principal: getApiPrincipal(c),
    includeAllRecalls: await isTenantAdmin(c, tenantId)
  }));
});

app.post("/v1/metric-definitions", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await createMetricDefinition(c.env, tenantId, getApiPrincipal(c), body), 201);
});

app.post("/v1/metric-definitions/:id/versions", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await createMetricDefinitionVersion(c.env, tenantId, getApiPrincipal(c), c.req.param("id"), body), 201);
});

app.post("/v1/metric-definitions/:id/promotion", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await recordMetricPromotion(c.env, tenantId, c.req.param("id"), body));
});

app.put("/v1/metric-definitions/:id/target", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await setMetricTarget(c.env, tenantId, getApiPrincipal(c), c.req.param("id"), body));
});

app.post("/v1/metric-definitions/:id/bindings", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await createMetricBinding(c.env, tenantId, getApiPrincipal(c), c.req.param("id"), body), 201);
});

app.post("/v1/metric-snapshots", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await createMetricSnapshot(c.env, tenantId, getApiPrincipal(c), body), 201);
});

app.get("/v1/metrics/query", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await queryMetrics(c.env, tenantId, {
    metricKeys: c.req.queries("metric_key") ?? c.req.query("metric_keys")?.split(","),
    scopeId: c.req.query("scope_id") ?? null,
    limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined
  }));
});

app.get("/v1/metric-snapshots/query", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await queryMetricSnapshots(c.env, tenantId, {
    metricKeys: c.req.queries("metric_key") ?? c.req.query("metric_keys")?.split(","),
    scopeId: c.req.query("scope_id") ?? null,
    from: c.req.query("from") ? Number(c.req.query("from")) : undefined,
    to: c.req.query("to") ? Number(c.req.query("to")) : undefined,
    limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined
  }));
});

app.get("/v1/metric-source-bindings", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await listMetricSourceBindings(c.env, tenantId, {
    metricDefinitionId: c.req.query("metric_definition_id"),
    status: c.req.query("status")
  }));
});

app.get("/v1/domain-dashboards", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await listDomainDashboards(c.env, tenantId));
});

app.post("/v1/domain-dashboards", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await upsertDomainDashboard(c.env, tenantId, getApiPrincipal(c), body), 201);
});

app.post("/v1/managed-object-types", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await createManagedObjectType(c.env, tenantId, getApiPrincipal(c), body), 201);
});

app.post("/v1/managed-objects", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await createManagedObject(c.env, tenantId, getApiPrincipal(c), body), 201);
});

app.post("/v1/managed-object-relations", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await createManagedObjectRelation(c.env, tenantId, getApiPrincipal(c), body), 201);
});

app.post("/v1/managed-object-external-refs", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await createManagedObjectExternalRef(c.env, tenantId, body), 201);
});

app.get("/v1/managed-objects/search", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await searchManagedObjects(c.env, tenantId, {
    q: c.req.query("q"), typeKey: c.req.query("type_key"), projectId: c.req.query("project_id"),
    limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined
  }));
});

app.post("/v1/decision-domain-links", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await createDecisionDomainLink(c.env, tenantId, getApiPrincipal(c), body), 201);
});

app.get("/v1/domain-context", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await getDomainContext(c.env, tenantId, {
    objectId: c.req.query("object_id"), metricKey: c.req.query("metric_key"), decisionId: c.req.query("decision_id")
  }));
});

app.get("/v1/decision-briefing", async (c) => {
  assertDecisionConsoleEnabled(c.env);
  const parsed = decisionBriefingQuerySchema.safeParse({
    tenant_id: c.req.query("tenant_id"),
    project_id: c.req.query("project_id"),
    limit: c.req.query("limit")
  });
  if (!parsed.success) throw new HttpError(400, "invalid_query", parsed.error.issues[0]?.message ?? "Invalid query");
  const tenantId = assertApiTenantAccess(c, parsed.data.tenant_id);
  return jsonOk(c, await getDecisionBriefing(c.env, {
    tenantId,
    principal: getApiPrincipal(c),
    projectId: parsed.data.project_id,
    limit: parsed.data.limit
  }));
});

app.get("/v1/decisions/:id/trace", async (c) => {
  assertDecisionConsoleEnabled(c.env);
  const parsed = decisionTraceQuerySchema.safeParse({
    tenant_id: c.req.query("tenant_id"),
    project_id: c.req.query("project_id"),
    include_inferred: c.req.query("include_inferred"),
    node_limit: c.req.query("node_limit"),
    edge_limit: c.req.query("edge_limit")
  });
  if (!parsed.success) throw new HttpError(400, "invalid_query", parsed.error.issues[0]?.message ?? "Invalid query");
  const tenantId = assertApiTenantAccess(c, parsed.data.tenant_id);
  return jsonOk(c, await getDecisionTrace(c.env, {
    tenantId,
    decisionId: c.req.param("id"),
    principal: getApiPrincipal(c),
    projectId: parsed.data.project_id,
    includeInferred: parsed.data.include_inferred,
    nodeLimit: parsed.data.node_limit,
    edgeLimit: parsed.data.edge_limit
  }));
});

app.get("/v1/decisions/:id/map", async (c) => {
  assertDecisionConsoleEnabled(c.env);
  const parsed = decisionTraceQuerySchema.safeParse({
    tenant_id: c.req.query("tenant_id"),
    project_id: c.req.query("project_id"),
    include_inferred: c.req.query("include_inferred"),
    node_limit: c.req.query("node_limit"),
    edge_limit: c.req.query("edge_limit")
  });
  if (!parsed.success) throw new HttpError(400, "invalid_query", parsed.error.issues[0]?.message ?? "Invalid query");
  const tenantId = assertApiTenantAccess(c, parsed.data.tenant_id);
  return jsonOk(c, await getDecisionMap(c.env, {
    tenantId,
    decisionId: c.req.param("id"),
    principal: getApiPrincipal(c),
    projectId: parsed.data.project_id,
    includeInferred: parsed.data.include_inferred,
    nodeLimit: parsed.data.node_limit,
    edgeLimit: parsed.data.edge_limit
  }));
});
}
