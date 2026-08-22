import { DASHBOARD_SOURCE_TYPES, dashboardActivityQuerySchema, dashboardKnowledgeGraphQuerySchema, dashboardStrataQuerySchema, memoryMapTraceQuerySchema, type DashboardSourceType } from "@org-brain/contracts";
import { HttpError } from "./errors.js";
import type { DashboardAccessPort, RouteApp, RouteAppEnv, RouteContext } from "./ports.js";
import { withRouteContracts } from "./route-contracts.js";

export function registerDashboardAccessRoutes<TEnv extends RouteAppEnv>(
  app: RouteApp<TEnv>,
  ports: DashboardAccessPort<TEnv>
): void {
const routes = withRouteContracts(app, "dashboard-access");
routes.get("/v1/access-policies/:resourceType/:resourceId", async (c) => {
  ports.assertDecisionConsoleEnabled(c.env);
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.getAccessPolicy(c.env, {
    tenantId,
    resourceType: ports.accessPolicyResourceType(c.req.param("resourceType")),
    resourceId: c.req.param("resourceId"),
    principal: ports.getApiPrincipal(c),
    projectId: c.req.query("project_id") ?? null,
    isAdmin: await ports.isTenantAdmin(c, tenantId)
  }));
});

routes.put("/v1/access-policies/:resourceType/:resourceId", async (c) => {
  ports.assertDecisionConsoleEnabled(c.env);
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body) ?? c.req.query("tenant_id"));
  const payload = body && typeof body === "object" && !Array.isArray(body)
    ? {
        ...body as Record<string, unknown>,
        tenant_id: tenantId,
        resource_type: ports.accessPolicyResourceType(c.req.param("resourceType")),
        resource_id: c.req.param("resourceId")
      }
    : body;
  return ports.jsonOk(c, await ports.updateAccessPolicy(c.env, payload, {
    tenantId,
    actorPrincipal: ports.getApiPrincipal(c),
    isAdmin: await ports.isTenantAdmin(c, tenantId)
  }));
});

routes.get("/v1/ops/access-policy-shadow", async (c) => {
  ports.assertDecisionConsoleEnabled(c.env);
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  if (!await ports.isTenantAdmin(c, tenantId)) {
    throw new HttpError(403, "forbidden", "Tenant admin role is required");
  }
  const rawLimit = Number(c.req.query("limit") ?? 100);
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 500) {
    throw new HttpError(400, "invalid_query", "limit must be an integer between 1 and 500");
  }
  return ports.jsonOk(c, await ports.getAccessPolicyShadowSummary(c.env, tenantId, {
    limit: rawLimit,
    includeResolved: c.req.query("include_resolved") === "true"
  }));
});

routes.get("/v1/dashboard/activity", async (c) => {
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
  const tenantId = ports.assertApiTenantAccess(c, parsed.data.tenant_id);
  const data = await ports.runDashboardView(
    c,
    "activity",
    () => ports.getActivityDashboard(c.env, tenantId, {
      projectId: parsed.data.project_id,
      from: parsed.data.from,
      to: parsed.data.to,
      before: parsed.data.before,
      after: parsed.data.after,
      limit: parsed.data.limit,
      principal: ports.getApiPrincipal(c)
    }),
    (result: { events: unknown[]; has_more: boolean }) => ({ count: result.events.length, truncated: result.has_more })
  );
  return ports.jsonOk(c, data);
});

routes.get("/v1/dashboard/knowledge-graph", async (c) => {
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
  const tenantId = ports.assertApiTenantAccess(c, parsed.data.tenant_id);
  const data = await ports.runDashboardView(
    c,
    "knowledge_graph",
    () => ports.getKnowledgeGraph(c.env, tenantId, {
      project_id: parsed.data.project_id,
      q: parsed.data.q,
      focus_type: parsed.data.focus_type,
      focus_id: parsed.data.focus_id,
      depth: parsed.data.depth,
      node_limit: parsed.data.node_limit,
      edge_limit: parsed.data.edge_limit,
      principal: ports.getApiPrincipal(c)
    }),
    (result: { nodes: unknown[]; truncated: boolean }) => ({ count: result.nodes.length, truncated: result.truncated })
  );
  return ports.jsonOk(c, data);
});

function dashboardPeriod<TEnv extends RouteAppEnv>(c: RouteContext<TEnv>) {
  const now = Date.now();
  const from = Number(c.req.query("from"));
  const to = Number(c.req.query("to"));
  const resolvedFrom = Number.isFinite(from) ? from : now - 30 * 24 * 60 * 60 * 1000;
  const resolvedTo = Number.isFinite(to) ? to : now;
  if (resolvedFrom > resolvedTo) {
    throw new HttpError(400, "invalid_period", "from must be before or equal to to");
  }
  if (resolvedTo - resolvedFrom > 180 * 24 * 60 * 60 * 1000) {
    throw new HttpError(400, "invalid_period", "analytics period cannot exceed 180 days");
  }
  return { from: resolvedFrom, to: resolvedTo };
}

routes.get("/v1/dashboard/memory-analytics", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  const scope = c.req.query("scope") === "mine" ? "mine" : "org";
  const perspective = c.req.query("perspective") === "spread" ? "spread" : "work";
  const period = dashboardPeriod(c);
  const canViewConsumerDetails = scope === "mine" && perspective === "spread"
    ? true
    : await ports.isTenantAdmin(c, tenantId);
  return ports.jsonOk(c, await ports.getMemoryAnalytics(c.env, {
    tenantId,
    principal: ports.getApiPrincipal(c),
    scope,
    perspective,
    projectId: c.req.query("project_id"),
    ownerPrincipal: scope === "org" ? c.req.query("owner_principal") : null,
    consumerPrincipal: c.req.query("consumer_principal"),
    canViewConsumerDetails,
    ...period
  }));
});

routes.get("/v1/dashboard/memory-map", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  const scope = c.req.query("scope") === "mine" ? "mine" : "org";
  const rawFrom = c.req.query("from")?.trim();
  const rawTo = c.req.query("to")?.trim();
  const fromValue = rawFrom ? Number(rawFrom) : Number.NaN;
  const toValue = rawTo ? Number(rawTo) : Number.NaN;
  if ((Number.isFinite(fromValue) && !Number.isFinite(toValue)) || (!Number.isFinite(fromValue) && Number.isFinite(toValue))) {
    throw new HttpError(400, "invalid_period", "from and to must be supplied together");
  }
  if (Number.isFinite(fromValue) && Number.isFinite(toValue) && fromValue > toValue) {
    throw new HttpError(400, "invalid_period", "from must be before or equal to to");
  }
  if (Number.isFinite(fromValue) && Number.isFinite(toValue) && toValue - fromValue > 180 * 24 * 60 * 60 * 1000) {
    throw new HttpError(400, "invalid_period", "memory map period cannot exceed 180 days");
  }
  const limit = Number.parseInt(c.req.query("limit") ?? "1500", 10);
  const display = c.req.query("display") === "top" ? "top" : c.req.query("display") === "cluster" ? "cluster" : c.req.query("display") === "all" ? "all" : undefined;
  return ports.jsonOk(c, await ports.getMemoryMap(c.env, {
    tenantId,
    principal: ports.getApiPrincipal(c),
    scope,
    display,
    projectId: c.req.query("project_id"),
    ownerPrincipal: scope === "org" ? c.req.query("owner_principal") : null,
    q: c.req.query("q"),
    from: Number.isFinite(fromValue) ? fromValue : null,
    to: Number.isFinite(toValue) ? toValue : null,
    limit: Number.isFinite(limit) ? limit : 1500
  }));
});

routes.get("/v1/dashboard/memory-map/trace", async (c) => {
  const parsed = memoryMapTraceQuerySchema.safeParse({
    tenant_id: c.req.query("tenant_id") || undefined,
    project_id: c.req.query("project_id") || undefined,
    scope: c.req.query("scope") || "org",
    memory_id: c.req.query("memory_id") || undefined,
    decision_rationale_id: c.req.query("decision_rationale_id") || undefined
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".") || "query";
    throw new HttpError(400, "invalid_query", `Invalid ${field}: ${issue?.message || "invalid value"}`);
  }
  const tenantId = ports.assertApiTenantAccess(c, parsed.data.tenant_id);
  return ports.jsonOk(c, await ports.getMemoryMapTrace(c.env, {
    tenantId,
    principal: ports.getApiPrincipal(c),
    projectId: parsed.data.project_id ?? null,
    scope: parsed.data.scope,
    memoryId: parsed.data.memory_id ?? null,
    decisionRationaleId: parsed.data.decision_rationale_id ?? null
  }));
});

routes.get("/v1/dashboard/strata", async (c) => {
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
  const tenantId = ports.assertApiTenantAccess(c, parsed.data.tenant_id);
  const data = await ports.runDashboardView(
    c,
    "strata",
    () => ports.getMemoryStrata(c.env, tenantId, {
      project_id: parsed.data.project_id,
      types: parsed.data.types,
      from: parsed.data.from,
      to: parsed.data.to,
      before: parsed.data.before,
      limit: parsed.data.limit,
      principal: ports.getApiPrincipal(c)
    }),
    (result: { chains: unknown[]; truncated: boolean }) => ({ count: result.chains.length, truncated: result.truncated })
  );
  return ports.jsonOk(c, data);
});

routes.get("/v1/dashboard/strata/:sourceType/:sourceId", async (c) => {
  const sourceType = c.req.param("sourceType");
  if (!DASHBOARD_SOURCE_TYPES.includes(sourceType as DashboardSourceType)) {
    throw new HttpError(400, "invalid_source_type", `Unsupported strata source type: ${sourceType}`);
  }
  const parsed = ports.dashboardStrataDetailQuerySchema.safeParse({
    tenant_id: c.req.query("tenant_id"),
    project_id: c.req.query("project_id")
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".") || "query";
    throw new HttpError(400, "invalid_query", `Invalid ${field}: ${issue?.message || "invalid value"}`);
  }
  const tenantId = ports.assertApiTenantAccess(c, parsed.data.tenant_id);
  const data = await ports.runDashboardView(
    c,
    "strata_detail",
    () => ports.getMemoryStrataDetail(
      c.env,
      tenantId,
      sourceType as DashboardSourceType,
      c.req.param("sourceId"),
      {
        project_id: parsed.data.project_id,
        principal: ports.getApiPrincipal(c)
      }
    ),
    (result: {
      chain: { revisions: unknown[]; sources: unknown[] };
      truncated: { revisions: boolean; sources: boolean };
    }) => ({
      count: result.chain.revisions.length + result.chain.sources.length,
      truncated: result.truncated.revisions || result.truncated.sources
    })
  );
  return ports.jsonOk(c, data);
});
}
