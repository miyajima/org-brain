import { HttpError } from "./errors.js";
import type { DecisionContextPort, RouteApp, RouteAppEnv } from "./ports.js";
import { withRouteContracts } from "./route-contracts.js";

export function registerDecisionContextRoutes<TEnv extends RouteAppEnv>(
  app: RouteApp<TEnv>,
  ports: DecisionContextPort<TEnv>
): void {
const routes = withRouteContracts(app, "decision-context");
routes.post("/v1/resources", async (c) => {
  ports.assertFeatureEnabled(c.env, "KNOWLEDGE_RESOURCE_INGESTION_ENABLED");
  ports.requireIdempotencyKey(c);
  const body = await c.req.json<unknown>();
  ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  const result = await ports.upsertKnowledgeResource(c.env, body, ports.getApiPrincipal(c));
  return ports.jsonOk(c, result, result.created ? 201 : 200);
});

routes.post("/v1/resources/search", async (c) => {
  ports.assertFeatureEnabled(c.env, "KNOWLEDGE_RESOURCE_INGESTION_ENABLED");
  const body = await c.req.json<unknown>();
  ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  return ports.jsonOk(c, await ports.searchKnowledgeResources(c.env, body, {
    principal: ports.getApiPrincipal(c),
    projectId: typeof record.project_id === "string" ? record.project_id : null
  }));
});

routes.get("/v1/resources/resolve", async (c) => {
  ports.assertFeatureEnabled(c.env, "KNOWLEDGE_RESOURCE_INGESTION_ENABLED");
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  const uri = c.req.query("uri");
  if (!uri) throw new HttpError(400, "invalid_payload", "uri is required");
  return ports.jsonOk(c, await ports.resolveKnowledgeResource(c.env, tenantId, uri, {
    principal: ports.getApiPrincipal(c),
    projectId: c.req.query("project_id") ?? null
  }));
});

routes.post("/v1/resources/backfill", async (c) => {
  ports.assertFeatureEnabled(c.env, "KNOWLEDGE_RESOURCE_INGESTION_ENABLED");
  ports.requireIdempotencyKey(c);
  const body = await c.req.json<unknown>();
  ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.backfillKnowledgeResources(c.env, body, ports.getApiPrincipal(c)));
});

routes.post("/v1/resources/:id/locations", async (c) => {
  ports.assertFeatureEnabled(c.env, "KNOWLEDGE_RESOURCE_INGESTION_ENABLED");
  ports.requireIdempotencyKey(c);
  const body = await c.req.json<unknown>();
  ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const result = await ports.addKnowledgeResourceLocation(c.env, { ...record, resource_id: c.req.param("id") }, ports.getApiPrincipal(c));
  return ports.jsonOk(c, result, result.created ? 201 : 200);
});

routes.post("/v1/resources/:id/refresh", async (c) => {
  ports.assertFeatureEnabled(c.env, "KNOWLEDGE_RESOURCE_INGESTION_ENABLED");
  ports.requireIdempotencyKey(c);
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const result = await ports.captureKnowledgeResourceVersion(
    c.env,
    tenantId,
    c.req.param("id"),
    body,
    ports.getApiPrincipal(c),
    typeof record.project_id === "string" ? record.project_id : null
  );
  return ports.jsonOk(c, result, result.created ? 201 : 200);
});

routes.get("/v1/resources/:id/decisions", async (c) => {
  ports.assertFeatureEnabled(c.env, "DECISION_RESOURCE_LINKS_ENABLED");
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.getResourceDecisions(c.env, tenantId, c.req.param("id"), {
    principal: ports.getApiPrincipal(c),
    projectId: c.req.query("project_id") ?? null,
    resourceVersionId: c.req.query("resource_version_id") ?? null
  }));
});

routes.get("/v1/decisions/:decisionRef{.+}/resources", async (c) => {
  ports.assertFeatureEnabled(c.env, "DECISION_RESOURCE_LINKS_ENABLED");
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  const rawRef = decodeURIComponent(c.req.param("decisionRef"));
  const separator = rawRef.indexOf(":");
  if (separator < 1) throw new HttpError(400, "invalid_payload", "decisionRef must be source_type:source_id");
  return ports.jsonOk(c, await ports.getDecisionResources(c.env, tenantId, {
    source_type: rawRef.slice(0, separator),
    source_id: rawRef.slice(separator + 1)
  }, {
    principal: ports.getApiPrincipal(c),
    projectId: c.req.query("project_id") ?? null,
    includeRelated: c.req.query("include_related") === "true"
  }));
});

routes.post("/v1/decision-resource-links", async (c) => {
  ports.assertFeatureEnabled(c.env, "DECISION_RESOURCE_LINKS_ENABLED");
  const idempotencyKey = ports.requireIdempotencyKey(c);
  const body = await c.req.json<unknown>();
  ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const result = await ports.createDecisionResourceLink(
    c.env,
    { ...record, idempotency_key: idempotencyKey },
    ports.getApiPrincipal(c)
  );
  return ports.jsonOk(c, result, result.created ? 201 : 200);
});

routes.get("/v1/decision-resource-links/review-queue", async (c) => {
  ports.assertFeatureEnabled(c.env, "DECISION_RESOURCE_LINKS_ENABLED");
  ports.assertFeatureEnabled(c.env, "RESOURCE_RELATION_EXTRACTION_ENABLED");
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.listDecisionResourceLinkProposals(c.env, tenantId, {
    principal: ports.getApiPrincipal(c),
    projectId: c.req.query("project_id") ?? null
  }));
});

routes.post("/v1/decision-resource-links/:id/confirm", async (c) => {
  ports.assertFeatureEnabled(c.env, "DECISION_RESOURCE_LINKS_ENABLED");
  ports.assertFeatureEnabled(c.env, "RESOURCE_RELATION_EXTRACTION_ENABLED");
  const idempotencyKey = ports.requireIdempotencyKey(c);
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  return ports.jsonOk(c, await ports.confirmDecisionResourceLinkProposal(
    c.env,
    tenantId,
    c.req.param("id"),
    body,
    ports.getApiPrincipal(c),
    idempotencyKey,
    typeof record.project_id === "string" ? record.project_id : null
  ));
});

routes.post("/v1/decision-resource-links/:id/retire", async (c) => {
  ports.assertFeatureEnabled(c.env, "DECISION_RESOURCE_LINKS_ENABLED");
  ports.requireIdempotencyKey(c);
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  return ports.jsonOk(c, await ports.retireDecisionResourceLink(
    c.env,
    tenantId,
    c.req.param("id"),
    ports.getApiPrincipal(c),
    typeof record.project_id === "string" ? record.project_id : null
  ));
});

routes.post("/v1/decision-memories", async (c) => {
  const body = await c.req.json<unknown>();
  ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  const result = await ports.createDecisionMemory(c.env, body, { principal: ports.getApiPrincipal(c) });
  return ports.jsonOk(c, result, 201);
});

routes.post("/v1/decision-memories/search", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  const payload = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  if (payload.generation_id || payload.ranking_profile_id) {
    const auth = ports.getApiAuthContext(c);
    await ports.assertPermission(c.env, {
      tenantId,
      projectId: typeof payload.project_id === "string" ? payload.project_id : null,
      principal: ports.getApiPrincipal(c),
      permission: "admin",
      fallbackRole: auth.defaultRole
    });
  }
  const result = await ports.searchDecisionMemories(c.env, body, { principal: ports.getApiPrincipal(c) });
  return ports.jsonOk(c, result);
});

routes.get("/v1/decision-memories/:id/context", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  const principal = ports.getApiPrincipal(c);
  const result = await ports.getDecisionMemoryContext(c.env, {
    tenantId,
    id: c.req.param("id"),
    userId: principal,
    agentId: principal
  });
  return ports.jsonOk(c, result);
});

routes.post("/v1/decision-memories/:id/revise", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  const body = await c.req.json<unknown>();
  const result = await ports.reviseDecisionMemory(c.env, tenantId, c.req.param("id"), body, { principal: ports.getApiPrincipal(c) });
  return ports.jsonOk(c, result);
});

routes.post("/v1/decision-memories/:id/confirm", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  const body = await c.req.json<unknown>();
  const result = await ports.confirmDecisionMemory(c.env, tenantId, c.req.param("id"), body, { principal: ports.getApiPrincipal(c) });
  return ports.jsonOk(c, result);
});

routes.post("/v1/context/enrich", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  const result = await ports.enrichContext(c.env, body, { principal: ports.getApiPrincipal(c) });
  const payload = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  if (payload.include_domain_recall === true) {
    const task = payload.task && typeof payload.task === "object" && !Array.isArray(payload.task) ? payload.task as Record<string, unknown> : {};
    const recall = await ports.getDomainRecall(c.env, {
      tenant_id: tenantId,
      project_id: payload.project_id ?? payload.projectId,
      query: payload.query ?? payload.prompt ?? [task.title, task.description].filter((value) => typeof value === "string").join(" "),
      object_type_key: payload.object_type_key,
      object_id: payload.object_id,
      scope: payload.scope,
      max_tokens: payload.domain_recall_max_tokens ?? 2_000
    }, { ownerPrincipal: ports.getApiPrincipal(c), runtimeActor: `principal:${ports.getApiPrincipal(c)}`, clientName: "api" });
    return ports.jsonOk(c, { ...result, domainRecall: recall.inject ? recall.bundle : null, domainRecallMeta: { mode: recall.mode, injected: recall.inject } });
  }
  return ports.jsonOk(c, result);
});

routes.get("/v1/domain-recalls/:id", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.getDomainRecallById(c.env, tenantId, c.req.param("id"), ports.getApiPrincipal(c), await ports.isTenantAdmin(c, tenantId)));
});

routes.post("/v1/domain-recalls/:id/feedback", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  const principal = ports.getApiPrincipal(c);
  return ports.jsonOk(c, await ports.recordDomainRecallFeedback(c.env, tenantId, c.req.param("id"), body, {
    ownerPrincipal: principal,
    runtimeActor: `principal:${principal}`,
    clientName: "api"
  }), 201);
});

routes.post("/v1/portable-imports", async (c) => {
  if (!["plan", "on"].includes(ports.portableArchiveMode(c.env))) throw new HttpError(404, "feature_disabled", "Portable archive import is not enabled");
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.createPortableImport(c.env, tenantId, ports.getApiPrincipal(c), body), 201);
});

routes.put("/v1/portable-imports/:id/chunks/:sequence", async (c) => {
  if (!["plan", "on"].includes(ports.portableArchiveMode(c.env))) throw new HttpError(404, "feature_disabled", "Portable archive import is not enabled");
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.putPortableImportChunk(c.env, tenantId, c.req.param("id"), Number(c.req.param("sequence")), body));
});

routes.post("/v1/portable-imports/:id/plan", async (c) => {
  if (!["plan", "on"].includes(ports.portableArchiveMode(c.env))) throw new HttpError(404, "feature_disabled", "Portable archive import is not enabled");
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.planPortableImport(c.env, tenantId, c.req.param("id")));
});

routes.post("/v1/portable-imports/:id/apply", async (c) => {
  if (ports.portableArchiveMode(c.env) !== "on") throw new HttpError(404, "feature_disabled", "Portable archive apply is not enabled");
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.applyPortableImport(c.env, tenantId, c.req.param("id")));
});

routes.post("/v1/context/pre-action-gate", async (c) => {
  const body = await c.req.json<unknown>();
  ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.preActionDecisionGate(c.env, body, { principal: ports.getApiPrincipal(c) }));
});

routes.post("/v1/context/review-check", async (c) => {
  const body = await c.req.json<unknown>();
  ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.preActionDecisionGate(c.env, body, { principal: ports.getApiPrincipal(c) }));
});

routes.post("/v1/decision-memories/review-queue", async (c) => {
  const body = await c.req.json<unknown>();
  ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.getDecisionReviewQueue(c.env, body, { principal: ports.getApiPrincipal(c) }));
});

routes.post("/v1/context/debt/scan", async (c) => {
  const body = await c.req.json<unknown>();
  ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.getDecisionReviewQueue(c.env, body, { principal: ports.getApiPrincipal(c) }));
});

routes.post("/api/context/enrich", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  const result = await ports.enrichContext(c.env, body, { principal: ports.getApiPrincipal(c) });
  const payload = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  if (payload.include_domain_recall === true) {
    const task = payload.task && typeof payload.task === "object" && !Array.isArray(payload.task) ? payload.task as Record<string, unknown> : {};
    const recall = await ports.getDomainRecall(c.env, {
      tenant_id: tenantId,
      project_id: payload.project_id ?? payload.projectId,
      query: payload.query ?? payload.prompt ?? [task.title, task.description].filter((value) => typeof value === "string").join(" "),
      object_type_key: payload.object_type_key,
      object_id: payload.object_id,
      scope: payload.scope,
      max_tokens: payload.domain_recall_max_tokens ?? 2_000
    }, { ownerPrincipal: ports.getApiPrincipal(c), runtimeActor: `principal:${ports.getApiPrincipal(c)}`, clientName: "api-compat" });
    return ports.jsonOk(c, { ...result, domainRecall: recall.inject ? recall.bundle : null, domainRecallMeta: { mode: recall.mode, injected: recall.inject } });
  }
  return ports.jsonOk(c, result);
});

routes.post("/v1/docs", async (c) => {
  const body = await c.req.json<unknown>();
  ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  const result = await ports.upsertKnowledgeDoc(c.env, body, { principal: ports.getApiPrincipal(c) });
  return ports.jsonOk(c, result, result.created ? 201 : 200);
});

routes.post("/v1/docs/search", async (c) => {
  const body = await c.req.json<unknown>();
  ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  const result = await ports.searchKnowledgeDocs(c.env, body, { principal: ports.getApiPrincipal(c) });
  return ports.jsonOk(c, result);
});

routes.get("/v1/docs/:slug{.+}/context", async (c) => {
  const slug = c.req.param("slug");
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  const result = await ports.getKnowledgeDocContext(c.env, tenantId, slug, { principal: ports.getApiPrincipal(c) });
  return ports.jsonOk(c, result);
});

routes.get("/v1/docs/:slug{.+}", async (c) => {
  const slug = c.req.param("slug");
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  const result = await ports.getKnowledgeDoc(c.env, tenantId, slug, { principal: ports.getApiPrincipal(c) });
  return ports.jsonOk(c, result);
});
}
