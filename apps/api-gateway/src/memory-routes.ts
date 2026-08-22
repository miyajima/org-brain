import { HttpError, sha256, type AgentMemoryEventV1 } from "@org-brain/shared";
import { createBusinessCategory, listBusinessCategories, updateBusinessCategory } from "./business-category-service";
import { memoryImpactReport, createMemoryFailurePattern, listMemoryFailurePatterns, recordMemoryEffect, recordMemoryUsage, recordMemoryUsageFromRequest, updateMemoryFailurePattern, updateMemoryUsageStates } from "./memory-effect-service";
import { assignRetrievalGeneration, backfillRetrievalGeneration, createRetrievalGeneration, createRetrievalRankingProfile, resolveRetrievalGenerationAssignment, transitionRetrievalGeneration } from "./retrieval-generation-service";
import { extractMemoryCandidates } from "./memory-extraction-service";
import { assertApiTenantAccess, getApiAuthContext, getApiPrincipal, jsonOk, tenantFromBody, type ApiContextEnv } from "./auth";
import { searchDecisionMemories } from "./context-engine-service";
import { captureMemories, deleteMemoryById, getMemoryDetails, getMemoryProfile, listMemories, listMemoriesCursorPage, listMemoriesPage, refreshMemoryByRequest, restoreMemoryByRequest, reviseMemoryByRequest, retrieveMemoryContext, searchMemories, suppressMemoryByRequest, trashMemoryByRequest, upsertMemories } from "./memory-service";
import { getPrincipalOwnerMapping, listPrincipalOwnerMappings, upsertOwnPrincipalOwnerMapping, upsertPrincipalOwnerMapping } from "./memory-ownership-service";
import { getMemoryQualityRun, listMemoryQualityRuns } from "./memory-quality-service";
import { getMemoryImpactExecution, getMemoryImpactSummary, reportMemoryImpact, startMemoryImpact } from "./memory-impact-service";
import { captureMemoryWithInferredRationale, captureRequestClaimsVerified, confirmProposedMemory, proposeMemoryWithRationale } from "./rationale-service";
import { assertPermission } from "./rbac-service";
import type { Hono } from "hono";
import { assertRetrievalOperator, isTenantAdmin, withPrincipalActor } from "./route-support";

export function registerMemoryRoutes(app: Hono<ApiContextEnv>): void {
app.post("/v1/memory-impact-executions", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await startMemoryImpact(c.env, tenantId, body, getApiPrincipal(c)), 201);
});

app.post("/v1/memory-impact-executions/:externalRunId/report", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await reportMemoryImpact(
    c.env,
    tenantId,
    c.req.param("externalRunId"),
    body,
    getApiPrincipal(c)
  ), 201);
});

app.get("/v1/memory-impact-executions/:externalRunId", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await getMemoryImpactExecution(c.env, tenantId, c.req.param("externalRunId")));
});

app.get("/v1/memory-impact-summary", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  const from = Number.parseInt(c.req.query("from") ?? "", 10);
  const to = Number.parseInt(c.req.query("to") ?? "", 10);
  return jsonOk(c, await getMemoryImpactSummary(c.env, tenantId, {
    from: Number.isNaN(from) ? undefined : from,
    to: Number.isNaN(to) ? undefined : to,
    projectId: c.req.query("project_id")
  }));
});

app.get("/v1/memory-quality/runs", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  const limit = Number.parseInt(c.req.query("limit") ?? "20", 10);
  return jsonOk(c, await listMemoryQualityRuns(c.env, tenantId, { limit: Number.isNaN(limit) ? undefined : limit }));
});

app.get("/v1/memory-quality/runs/:runId", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  const limit = Number.parseInt(c.req.query("limit") ?? "100", 10);
  const offset = Number.parseInt(c.req.query("offset") ?? "0", 10);
  const mismatch = c.req.query("parity_mismatch")?.trim() || undefined;
  return jsonOk(c, await getMemoryQualityRun(c.env, tenantId, c.req.param("runId"), {
    route: c.req.query("route"), lessonType: c.req.query("lesson_type"),
    actualRoute: c.req.query("actual_route"), issue: c.req.query("issue"),
    projectHash: c.req.query("project_hash"),
    parityMismatch: mismatch === undefined ? undefined : mismatch === "1" || mismatch === "true",
    limit: Number.isNaN(limit) ? undefined : limit,
    offset: Number.isNaN(offset) ? undefined : offset
  }));
});

app.get("/v1/memories", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  const scope = c.req.query("scope") === "mine" ? "mine" : "org";
  const source = c.req.query("source");
  const projectId = c.req.query("project_id");
  const businessCategoryId = c.req.query("business_category_id");
  const workType = c.req.query("work_type") as import("@org-brain/shared").MemoryWorkType | undefined;
  const lifecycle = ["active", "review", "trash", "all"].includes(c.req.query("lifecycle") ?? "")
    ? c.req.query("lifecycle") as "active" | "review" | "trash" | "all"
    : "active";
  const ownerPrincipal = scope === "mine" ? getApiPrincipal(c) : c.req.query("owner_principal");
  const createdByPrincipal = c.req.query("created_by_principal");
  const includeTrashed = c.req.query("include_trashed") === "true" || c.req.query("include_trashed") === "1";
  const rawFrom = c.req.query("from")?.trim();
  const rawTo = c.req.query("to")?.trim();
  const fromValue = rawFrom ? Number(rawFrom) : Number.NaN;
  const toValue = rawTo ? Number(rawTo) : Number.NaN;
  const sort = ["created", "updated", "usage"].includes(c.req.query("sort") ?? "")
    ? c.req.query("sort") as "created" | "updated" | "usage"
    : "created";
  const limit = Number.parseInt(c.req.query("limit") ?? "100", 10);
  const offset = Number.parseInt(c.req.query("offset") ?? "0", 10);
  const paginated = c.req.query("paginated") === "1";
  const cursor = c.req.query("cursor");
  const view = c.req.query("view");
  if (cursor || view) {
    const page = await listMemoriesCursorPage(c.env, tenantId, {
      limit: Number.isNaN(limit) ? (view === "compact" ? 500 : 100) : limit,
      source,
      projectId,
      businessCategoryId,
      workType,
      cursor,
      view: view as "full" | "compact" | undefined
    });
    return jsonOk(c, page);
  }
  if (paginated) {
    const page = await listMemoriesPage(c.env, tenantId, {
      limit: Number.isNaN(limit) ? 24 : limit,
      offset: Number.isNaN(offset) ? 0 : offset,
      source,
      projectId,
      businessCategoryId,
      workType,
      ownerPrincipal,
      createdByPrincipal,
      lifecycle,
      includeTrashed,
      from: Number.isFinite(fromValue) ? fromValue : null,
      to: Number.isFinite(toValue) ? toValue : null,
      sort
    });
    return jsonOk(c, page);
  }

  const memories = await listMemories(c.env, tenantId, {
    limit: Number.isNaN(limit) ? 100 : limit,
    offset: Number.isNaN(offset) ? 0 : offset,
    source,
    projectId,
    businessCategoryId,
    workType,
    ownerPrincipal,
    createdByPrincipal,
    lifecycle,
    includeTrashed,
    from: Number.isFinite(fromValue) ? fromValue : null,
    to: Number.isFinite(toValue) ? toValue : null,
    sort
  });
  return jsonOk(c, memories);
});

app.get("/v1/principal-owner-mappings", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  if (!(await isTenantAdmin(c, tenantId))) {
    throw new HttpError(403, "tenant_admin_required", "Only a tenant admin can view producer-owner mappings");
  }
  return jsonOk(c, await listPrincipalOwnerMappings(c.env, tenantId));
});

app.get("/v1/principal-owner-mappings/me", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await getPrincipalOwnerMapping(c.env, tenantId, getApiPrincipal(c)));
});

app.put("/v1/principal-owner-mappings/me", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await upsertOwnPrincipalOwnerMapping(c.env, tenantId, body, getApiPrincipal(c)));
});

app.put("/v1/principal-owner-mappings", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  if (!(await isTenantAdmin(c, tenantId))) {
    throw new HttpError(403, "tenant_admin_required", "Only a tenant admin can manage producer-owner mappings");
  }
  return jsonOk(c, await upsertPrincipalOwnerMapping(c.env, tenantId, body, getApiPrincipal(c)));
});

app.get("/v1/business-categories", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await listBusinessCategories(
    c.env,
    tenantId,
    c.req.query("include_inactive") === "true"
  ));
});

app.post("/v1/business-categories", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await createBusinessCategory(c.env, tenantId, body), 201);
});

app.patch("/v1/business-categories/:id", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await updateBusinessCategory(c.env, tenantId, c.req.param("id"), body));
});

app.post("/v1/memory-effects", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await recordMemoryEffect(c.env, tenantId, body), 201);
});

app.post("/v1/memory-usages", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await recordMemoryUsageFromRequest(c.env, tenantId, body, getApiPrincipal(c)), 201);
});

app.post("/v1/memory-usages/state", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await updateMemoryUsageStates(c.env, tenantId, body));
});

app.get("/v1/memory-failure-patterns", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await listMemoryFailurePatterns(c.env, tenantId, c.req.query("project_id")));
});

app.post("/v1/memory-failure-patterns", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await createMemoryFailurePattern(c.env, tenantId, body), 201);
});

app.patch("/v1/memory-failure-patterns/:id", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await updateMemoryFailurePattern(c.env, tenantId, c.req.param("id"), body));
});

app.get("/v1/metrics/memory-impact", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await memoryImpactReport(c.env, tenantId, {
    group_by: c.req.query("group_by") ?? "memory"
  }));
});

app.get("/v1/retrieval-generation-assignments/resolve", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  return jsonOk(c, await resolveRetrievalGenerationAssignment(
    c.env,
    tenantId,
    c.req.query("project_id") ?? null
  ));
});

app.put("/v1/retrieval-generation-assignments", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  return jsonOk(c, await assignRetrievalGeneration(c.env, tenantId, body));
});

app.post("/v1/retrieval-ranking-profiles", async (c) => {
  const body = await c.req.json<unknown>();
  assertApiTenantAccess(c, tenantFromBody(body));
  assertRetrievalOperator(c.env, getApiAuthContext(c).principal);
  return jsonOk(c, await createRetrievalRankingProfile(c.env, body), 201);
});

app.post("/v1/retrieval-generations", async (c) => {
  const body = await c.req.json<unknown>();
  assertApiTenantAccess(c, tenantFromBody(body));
  assertRetrievalOperator(c.env, getApiAuthContext(c).principal);
  return jsonOk(c, await createRetrievalGeneration(c.env, body), 201);
});

app.post("/v1/retrieval-generations/:id/backfill", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  assertRetrievalOperator(c.env, getApiAuthContext(c).principal);
  return jsonOk(c, await backfillRetrievalGeneration(c.env, tenantId, c.req.param("id"), body));
});

app.patch("/v1/retrieval-generations/:id", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  assertApiTenantAccess(c, tenantFromBody(body));
  assertRetrievalOperator(c.env, getApiAuthContext(c).principal);
  if (typeof body.status !== "string") {
    throw new HttpError(400, "status_required", "status is required");
  }
  return jsonOk(c, await transitionRetrievalGeneration(c.env, c.req.param("id"), body.status, body));
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
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  const claimsVerified = captureRequestClaimsVerified(body);
  if (claimsVerified) {
    const auth = getApiAuthContext(c);
    if (auth.scopes && !auth.scopes.includes("memory:attest")) {
      throw new HttpError(403, "memory_attestation_required", "Scoped token lacks memory:attest permission");
    }
    const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const rows = Array.isArray(record.items) ? record.items : record.item ? [record.item] : [];
    const projectIds = new Set(rows.map((item) => item && typeof item === "object" && !Array.isArray(item)
      ? ((item as Record<string, unknown>).project_id as string | null | undefined) ?? null
      : null));
    for (const projectId of projectIds) {
      await assertPermission(c.env, {
        tenantId,
        projectId,
        principal: auth.principal,
        permission: "memory:attest",
        fallbackRole: auth.defaultRole
      });
    }
  }
  const result = await captureMemoryWithInferredRationale(
    c.env,
    withPrincipalActor(body, getApiPrincipal(c)),
    { canAttest: claimsVerified }
  );
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
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  const result = await reviseMemoryByRequest(c.env, body, {
    actorPrincipal: getApiPrincipal(c),
    canManageAll: await isTenantAdmin(c, tenantId)
  });
  return jsonOk(c, result);
});

app.post("/v1/memories/refresh", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  const result = await refreshMemoryByRequest(c.env, body, {
    actorPrincipal: getApiPrincipal(c),
    canManageAll: await isTenantAdmin(c, tenantId)
  });
  return jsonOk(c, result);
});

app.post("/v1/memories/suppress", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = assertApiTenantAccess(c, tenantFromBody(body));
  const result = await suppressMemoryByRequest(c.env, body, {
    actorPrincipal: getApiPrincipal(c),
    canManageAll: await isTenantAdmin(c, tenantId)
  });
  return jsonOk(c, result);
});

app.post("/v1/memories/:memoryId/trash", async (c) => {
  const body = await c.req.json<unknown>().catch(() => ({}));
  const bodyWithId = body && typeof body === "object" && !Array.isArray(body)
    ? { ...(body as Record<string, unknown>), memory_id: c.req.param("memoryId") }
    : { memory_id: c.req.param("memoryId") };
  const tenantId = assertApiTenantAccess(c, tenantFromBody(bodyWithId));
  return jsonOk(c, await trashMemoryByRequest(c.env, bodyWithId, {
    actorPrincipal: getApiPrincipal(c),
    canManageAll: await isTenantAdmin(c, tenantId)
  }));
});

app.post("/v1/memories/:memoryId/restore", async (c) => {
  const body = await c.req.json<unknown>().catch(() => ({}));
  const bodyWithId = body && typeof body === "object" && !Array.isArray(body)
    ? { ...(body as Record<string, unknown>), memory_id: c.req.param("memoryId") }
    : { memory_id: c.req.param("memoryId") };
  const tenantId = assertApiTenantAccess(c, tenantFromBody(bodyWithId));
  return jsonOk(c, await restoreMemoryByRequest(c.env, bodyWithId, {
    actorPrincipal: getApiPrincipal(c),
    canManageAll: await isTenantAdmin(c, tenantId)
  }));
});

app.delete("/v1/memories/:memoryId", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  const result = await deleteMemoryById(c.env, tenantId, c.req.param("memoryId"), {
    actorPrincipal: getApiPrincipal(c),
    canManageAll: await isTenantAdmin(c, tenantId)
  });
  return jsonOk(c, result);
});

app.post("/v1/memories/search", async (c) => {
  const body = await c.req.json<unknown>();
  assertApiTenantAccess(c, tenantFromBody(body));
  const payload = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  if (payload.generation_id || payload.ranking_profile_id) {
    const tenantId = tenantFromBody(body) ?? "default";
    const auth = getApiAuthContext(c);
    await assertPermission(c.env, {
      tenantId,
      projectId: typeof payload.project_id === "string" ? payload.project_id : null,
      principal: getApiPrincipal(c),
      permission: "admin",
      fallbackRole: auth.defaultRole
    });
  }
  const scope = payload.search_scope ?? "evidence";
  if (!["evidence", "governance", "both"].includes(String(scope))) {
    throw new HttpError(400, "invalid_search_scope", "search_scope must be evidence, governance, or both");
  }
  if (scope === "governance") {
    return jsonOk(c, await searchDecisionMemories(c.env, body, { principal: getApiPrincipal(c) }));
  }
  const evidence = await searchMemories(c.env, body, {
    actorPrincipal: getApiPrincipal(c),
    recordUsage: scope !== "both"
  });
  if (scope === "evidence") return jsonOk(c, evidence);
  const governance = await searchDecisionMemories(c.env, body, {
    principal: getApiPrincipal(c),
    recordUsage: false
  });
  const queryHash = await sha256(typeof payload.q === "string" ? payload.q : "");
  const governanceResults = governance.results as Array<Record<string, unknown>>;
  const usage = await recordMemoryUsage(c.env, {
    tenant_id: evidence.tenant_id,
    project_id: evidence.project_id ?? undefined,
    task_id: typeof payload.task_id === "string" ? payload.task_id : undefined,
    trace_id: typeof payload.trace_id === "string" ? payload.trace_id : undefined,
    external_run_id: typeof payload.external_run_id === "string" ? payload.external_run_id : undefined,
    capability: "memory_search_both",
    access_path: "search",
    request_source: "api",
    query_hash: queryHash,
    requested_business_category_id: typeof payload.business_category_id === "string" ? payload.business_category_id : null,
    requested_work_type: typeof payload.work_type === "string"
      ? payload.work_type as import("@org-brain/shared").MemoryWorkType
      : null,
    retrieval_generation_id: evidence.meta.retrieval?.generation_id === governance.meta.retrieval.generation_id
      ? evidence.meta.retrieval?.generation_id
      : null,
    ranking_profile_id: evidence.meta.retrieval?.ranking_profile_id === governance.meta.retrieval.ranking_profile_id
      ? evidence.meta.retrieval?.ranking_profile_id
      : null,
    actor_principal: getApiPrincipal(c),
    items: [
      ...evidence.results.filter((item) => item.kind === "memory").map((item, index) => ({
        source_type: "memory" as const,
        source_id: item.id,
        source_version: item.current_version ?? null,
        rank: index + 1,
        score: item.score,
        reference_type: "returned" as const,
        used_state: "unknown" as const
      })),
      ...governanceResults.flatMap((item, index) => typeof item.id === "string" ? [{
        source_type: "decision_memory" as const,
        source_id: item.id,
        rank: index + 1,
        score: typeof (item.score as Record<string, unknown> | undefined)?.finalScore === "number"
          ? Number((item.score as Record<string, unknown>).finalScore)
          : null,
        reference_type: "returned" as const,
        used_state: "unknown" as const
      }] : [])
    ]
  });
  return jsonOk(c, {
    tenant_id: evidence.tenant_id,
    project_id: evidence.project_id,
    q: evidence.q,
    search_scope: "both",
    governance,
    evidence,
    meta: {
      usage_id: usage.usage_id,
      verification_sampled: usage.verification_sampled,
      channel_usage_ids: {
        evidence: usage.usage_id,
        governance: usage.usage_id
      }
    }
  });
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
  const result = await getMemoryProfile(c.env, body, { actorPrincipal: getApiPrincipal(c) });
  return jsonOk(c, result);
});

app.get("/v1/memories/:memoryId/details", async (c) => {
  const tenantId = assertApiTenantAccess(c, c.req.query("tenant_id"));
  const result = await getMemoryDetails(c.env, tenantId, c.req.param("memoryId"), {
    actorPrincipal: getApiPrincipal(c)
  });
  return jsonOk(c, result);
});
}
