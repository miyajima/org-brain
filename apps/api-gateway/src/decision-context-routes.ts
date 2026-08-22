import { HttpError } from "@org-brain/shared";
import { applyPortableImport, createPortableImport, getDomainRecall, getDomainRecallById, planPortableImport, putPortableImportChunk, recordDomainRecallFeedback } from "./domain-recall-service";
import { assertApiTenantAccess, getApiAuthContext, getApiPrincipal, jsonOk, tenantFromBody, type ApiContextEnv } from "./auth";
import { confirmDecisionMemory, createDecisionMemory, enrichContext, getDecisionMemoryContext, getDecisionReviewQueue, preActionDecisionGate, reviseDecisionMemory, searchDecisionMemories } from "./context-engine-service";
import { getKnowledgeDoc, getKnowledgeDocContext, searchKnowledgeDocs, upsertKnowledgeDoc } from "./knowledge-docs-service";
import { assertPermission } from "./rbac-service";
import { addKnowledgeResourceLocation, backfillKnowledgeResources, captureKnowledgeResourceVersion, confirmDecisionResourceLinkProposal, createDecisionResourceLink, getDecisionResources, getResourceDecisions, listDecisionResourceLinkProposals, resolveKnowledgeResource, retireDecisionResourceLink, searchKnowledgeResources, upsertKnowledgeResource } from "./resource-decision-service";
import type { Hono } from "hono";
import { assertFeatureEnabled, isTenantAdmin, requireIdempotencyKey } from "./route-support";

export function registerDecisionContextRoutes(app: Hono<ApiContextEnv>): void {
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
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  const result = await enrichContext(c.env, body, { principal: getApiPrincipal(c) });
  const payload = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  if (payload.include_domain_recall === true) {
    const task = payload.task && typeof payload.task === "object" && !Array.isArray(payload.task) ? payload.task as Record<string, unknown> : {};
    const recall = await getDomainRecall(c.env, {
      tenant_id: tenantId,
      project_id: payload.project_id ?? payload.projectId,
      query: payload.query ?? payload.prompt ?? [task.title, task.description].filter((value) => typeof value === "string").join(" "),
      object_type_key: payload.object_type_key,
      object_id: payload.object_id,
      scope: payload.scope,
      max_tokens: payload.domain_recall_max_tokens ?? 2_000
    }, { ownerPrincipal: getApiPrincipal(c), runtimeActor: `principal:${getApiPrincipal(c)}`, clientName: "api" });
    return jsonOk(c, { ...result, domainRecall: recall.inject ? recall.bundle : null, domainRecallMeta: { mode: recall.mode, injected: recall.inject } });
  }
  return jsonOk(c, result);
});

app.get("/v1/domain-recalls/:id", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await getDomainRecallById(c.env, tenantId, c.req.param("id"), getApiPrincipal(c), await isTenantAdmin(c, tenantId)));
});

app.post("/v1/domain-recalls/:id/feedback", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  const principal = getApiPrincipal(c);
  return jsonOk(c, await recordDomainRecallFeedback(c.env, tenantId, c.req.param("id"), body, {
    ownerPrincipal: principal,
    runtimeActor: `principal:${principal}`,
    clientName: "api"
  }), 201);
});

app.post("/v1/portable-imports", async (c) => {
  if (!["plan", "on"].includes(c.env.PORTABLE_ARCHIVE_MODE ?? "off")) throw new HttpError(404, "feature_disabled", "Portable archive import is not enabled");
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await createPortableImport(c.env, tenantId, getApiPrincipal(c), body), 201);
});

app.put("/v1/portable-imports/:id/chunks/:sequence", async (c) => {
  if (!["plan", "on"].includes(c.env.PORTABLE_ARCHIVE_MODE ?? "off")) throw new HttpError(404, "feature_disabled", "Portable archive import is not enabled");
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await putPortableImportChunk(c.env, tenantId, c.req.param("id"), Number(c.req.param("sequence")), body));
});

app.post("/v1/portable-imports/:id/plan", async (c) => {
  if (!["plan", "on"].includes(c.env.PORTABLE_ARCHIVE_MODE ?? "off")) throw new HttpError(404, "feature_disabled", "Portable archive import is not enabled");
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await planPortableImport(c.env, tenantId, c.req.param("id")));
});

app.post("/v1/portable-imports/:id/apply", async (c) => {
  if (c.env.PORTABLE_ARCHIVE_MODE !== "on") throw new HttpError(404, "feature_disabled", "Portable archive apply is not enabled");
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await applyPortableImport(c.env, tenantId, c.req.param("id")));
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
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  const result = await enrichContext(c.env, body, { principal: getApiPrincipal(c) });
  const payload = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  if (payload.include_domain_recall === true) {
    const task = payload.task && typeof payload.task === "object" && !Array.isArray(payload.task) ? payload.task as Record<string, unknown> : {};
    const recall = await getDomainRecall(c.env, {
      tenant_id: tenantId,
      project_id: payload.project_id ?? payload.projectId,
      query: payload.query ?? payload.prompt ?? [task.title, task.description].filter((value) => typeof value === "string").join(" "),
      object_type_key: payload.object_type_key,
      object_id: payload.object_id,
      scope: payload.scope,
      max_tokens: payload.domain_recall_max_tokens ?? 2_000
    }, { ownerPrincipal: getApiPrincipal(c), runtimeActor: `principal:${getApiPrincipal(c)}`, clientName: "api-compat" });
    return jsonOk(c, { ...result, domainRecall: recall.inject ? recall.bundle : null, domainRecallMeta: { mode: recall.mode, injected: recall.inject } });
  }
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
}
