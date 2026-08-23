import { sha256Hex } from "@org-brain/core";
import { HttpError } from "./errors.js";
import type { MemoryPort, RouteApp, RouteAppEnv } from "./ports.js";
import { withRouteContracts } from "./route-contracts.js";

type AgentMemoryEventV1 = {
  event_id: string;
  tenant_id: string;
  project_id?: string | null;
  source: string;
  actor_type?: string | null;
  actor_id?: string | null;
  occurred_at: number;
  text: string;
  source_references?: unknown[];
  metadata?: Record<string, unknown>;
};

type MemoryWorkType = string;

type EvidenceResultItem = {
  kind?: string;
  id: string;
  current_version?: number | null;
  score?: number | null;
};

export function registerMemoryRoutes<TEnv extends RouteAppEnv>(
  app: RouteApp<TEnv>,
  ports: MemoryPort<TEnv>
): void {
const routes = withRouteContracts(app, "memory");
routes.post("/v1/memory-impact-executions", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.startMemoryImpact(c.env, tenantId, body, ports.getApiPrincipal(c)), 201);
});

routes.post("/v1/memory-impact-executions/:externalRunId/report", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.reportMemoryImpact(
    c.env,
    tenantId,
    c.req.param("externalRunId"),
    body,
    ports.getApiPrincipal(c)
  ), 201);
});

routes.get("/v1/memory-impact-executions/:externalRunId", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.getMemoryImpactExecution(c.env, tenantId, c.req.param("externalRunId")));
});

routes.get("/v1/memory-impact-summary", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  const from = Number.parseInt(c.req.query("from") ?? "", 10);
  const to = Number.parseInt(c.req.query("to") ?? "", 10);
  return ports.jsonOk(c, await ports.getMemoryImpactSummary(c.env, tenantId, {
    from: Number.isNaN(from) ? undefined : from,
    to: Number.isNaN(to) ? undefined : to,
    projectId: c.req.query("project_id")
  }));
});

routes.get("/v1/memory-quality/runs", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  const limit = Number.parseInt(c.req.query("limit") ?? "20", 10);
  return ports.jsonOk(c, await ports.listMemoryQualityRuns(c.env, tenantId, { limit: Number.isNaN(limit) ? undefined : limit }));
});

routes.get("/v1/memory-quality/runs/:runId", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  const limit = Number.parseInt(c.req.query("limit") ?? "100", 10);
  const offset = Number.parseInt(c.req.query("offset") ?? "0", 10);
  const mismatch = c.req.query("parity_mismatch")?.trim() || undefined;
  return ports.jsonOk(c, await ports.getMemoryQualityRun(c.env, tenantId, c.req.param("runId"), {
    route: c.req.query("route"), lessonType: c.req.query("lesson_type"),
    actualRoute: c.req.query("actual_route"), issue: c.req.query("issue"),
    projectHash: c.req.query("project_hash"),
    parityMismatch: mismatch === undefined ? undefined : mismatch === "1" || mismatch === "true",
    limit: Number.isNaN(limit) ? undefined : limit,
    offset: Number.isNaN(offset) ? undefined : offset
  }));
});

routes.get("/v1/memories", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  const scope = c.req.query("scope") === "mine" ? "mine" : "org";
  const source = c.req.query("source");
  const projectId = c.req.query("project_id");
  const businessCategoryId = c.req.query("business_category_id");
  const workType = c.req.query("work_type") as MemoryWorkType | undefined;
  const lifecycle = ["active", "review", "trash", "all"].includes(c.req.query("lifecycle") ?? "")
    ? c.req.query("lifecycle") as "active" | "review" | "trash" | "all"
    : "active";
  const ownerPrincipal = scope === "mine" ? ports.getApiPrincipal(c) : c.req.query("owner_principal");
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
    const page = await ports.listMemoriesCursorPage(c.env, tenantId, {
      limit: Number.isNaN(limit) ? (view === "compact" ? 500 : 100) : limit,
      source,
      projectId,
      businessCategoryId,
      workType,
      cursor,
      view: view as "full" | "compact" | undefined
    });
    return ports.jsonOk(c, page);
  }
  if (paginated) {
    const page = await ports.listMemoriesPage(c.env, tenantId, {
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
    return ports.jsonOk(c, page);
  }

  const memories = await ports.listMemories(c.env, tenantId, {
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
  return ports.jsonOk(c, memories);
});

routes.get("/v1/principal-owner-mappings", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  if (!(await ports.isTenantAdmin(c, tenantId))) {
    throw new HttpError(403, "tenant_admin_required", "Only a tenant admin can view producer-owner mappings");
  }
  return ports.jsonOk(c, await ports.listPrincipalOwnerMappings(c.env, tenantId));
});

routes.get("/v1/principal-owner-mappings/me", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.getPrincipalOwnerMapping(c.env, tenantId, ports.getApiPrincipal(c)));
});

routes.put("/v1/principal-owner-mappings/me", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.upsertOwnPrincipalOwnerMapping(c.env, tenantId, body, ports.getApiPrincipal(c)));
});

routes.put("/v1/principal-owner-mappings", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  if (!(await ports.isTenantAdmin(c, tenantId))) {
    throw new HttpError(403, "tenant_admin_required", "Only a tenant admin can manage producer-owner mappings");
  }
  return ports.jsonOk(c, await ports.upsertPrincipalOwnerMapping(c.env, tenantId, body, ports.getApiPrincipal(c)));
});

routes.get("/v1/business-categories", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.listBusinessCategories(
    c.env,
    tenantId,
    c.req.query("include_inactive") === "true"
  ));
});

routes.post("/v1/business-categories", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.createBusinessCategory(c.env, tenantId, body), 201);
});

routes.patch("/v1/business-categories/:id", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.updateBusinessCategory(c.env, tenantId, c.req.param("id"), body));
});

routes.post("/v1/memory-effects", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.recordMemoryEffect(c.env, tenantId, body), 201);
});

routes.post("/v1/memory-usages", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.recordMemoryUsageFromRequest(c.env, tenantId, body, ports.getApiPrincipal(c)), 201);
});

routes.post("/v1/memory-usages/state", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.updateMemoryUsageStates(c.env, tenantId, body));
});

routes.get("/v1/memory-failure-patterns", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.listMemoryFailurePatterns(c.env, tenantId, c.req.query("project_id")));
});

routes.post("/v1/memory-failure-patterns", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.createMemoryFailurePattern(c.env, tenantId, body), 201);
});

routes.patch("/v1/memory-failure-patterns/:id", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.updateMemoryFailurePattern(c.env, tenantId, c.req.param("id"), body));
});

routes.get("/v1/metrics/memory-impact", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.memoryImpactReport(c.env, tenantId, {
    group_by: c.req.query("group_by") ?? "memory"
  }));
});

routes.get("/v1/retrieval-generation-assignments/resolve", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  return ports.jsonOk(c, await ports.resolveRetrievalGenerationAssignment(
    c.env,
    tenantId,
    c.req.query("project_id") ?? null
  ));
});

routes.put("/v1/retrieval-generation-assignments", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  return ports.jsonOk(c, await ports.assignRetrievalGeneration(c.env, tenantId, body));
});

routes.post("/v1/retrieval-ranking-profiles", async (c) => {
  const body = await c.req.json<unknown>();
  ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  ports.assertRetrievalOperator(c.env, ports.getApiAuthContext(c).principal);
  return ports.jsonOk(c, await ports.createRetrievalRankingProfile(c.env, body), 201);
});

routes.post("/v1/retrieval-generations", async (c) => {
  const body = await c.req.json<unknown>();
  ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  ports.assertRetrievalOperator(c.env, ports.getApiAuthContext(c).principal);
  return ports.jsonOk(c, await ports.createRetrievalGeneration(c.env, body), 201);
});

routes.post("/v1/retrieval-generations/:id/backfill", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  ports.assertRetrievalOperator(c.env, ports.getApiAuthContext(c).principal);
  return ports.jsonOk(c, await ports.backfillRetrievalGeneration(c.env, tenantId, c.req.param("id"), body));
});

routes.patch("/v1/retrieval-generations/:id", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  ports.assertRetrievalOperator(c.env, ports.getApiAuthContext(c).principal);
  if (typeof body.status !== "string") {
    throw new HttpError(400, "status_required", "status is required");
  }
  return ports.jsonOk(c, await ports.transitionRetrievalGeneration(c.env, c.req.param("id"), body.status, body));
});

routes.post("/v1/memories/upsert", async (c) => {
  const body = await c.req.json<unknown>();
  ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  const result = await ports.upsertMemories(c.env, body, { actorPrincipal: ports.getApiPrincipal(c) });
  return ports.jsonOk(c, result, 201);
});

routes.post("/v1/memories/capture", async (c) => {
  const body = await c.req.json<unknown>();
  ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  const result = await ports.captureMemories(c.env, body, { actorPrincipal: ports.getApiPrincipal(c) });
  return ports.jsonOk(c, result, 201);
});

routes.post("/v1/memories/extract", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  if (!body || typeof body !== "object") {
    throw new HttpError(400, "invalid_payload", "request body must be an object");
  }
  const event = body as AgentMemoryEventV1;
  const result = await ports.extractMemoryCandidates(c.env, {
    ...event,
    tenant_id: tenantId,
    actor_type: "principal",
    actor_id: ports.getApiPrincipal(c)
  });
  return ports.jsonOk(c, result);
});

routes.post("/v1/memories/propose", async (c) => {
  const body = await c.req.json<unknown>();
  ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  const result = await ports.proposeMemoryWithRationale(c.env, ports.withPrincipalActor(body, ports.getApiPrincipal(c)));
  return ports.jsonOk(c, result, 201);
});

routes.post("/v1/memories/capture-rationale", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  const claimsVerified = ports.captureRequestClaimsVerified(body);
  if (claimsVerified) {
    const auth = ports.getApiAuthContext(c);
    if (auth.scopes && !auth.scopes.includes("memory:attest")) {
      throw new HttpError(403, "memory_attestation_required", "Scoped token lacks memory:attest permission");
    }
    const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const rows = Array.isArray(record.items) ? record.items : record.item ? [record.item] : [];
    const projectIds = new Set(rows.map((item) => item && typeof item === "object" && !Array.isArray(item)
      ? ((item as Record<string, unknown>).project_id as string | null | undefined) ?? null
      : null));
    for (const projectId of projectIds) {
      await ports.assertPermission(c.env, {
        tenantId,
        projectId,
        principal: auth.principal,
        permission: "memory:attest",
        fallbackRole: auth.defaultRole
      });
    }
  }
  const result = await ports.captureMemoryWithInferredRationale(
    c.env,
    ports.withPrincipalActor(body, ports.getApiPrincipal(c)),
    { canAttest: claimsVerified }
  );
  return ports.jsonOk(c, result, 201);
});

routes.post("/v1/memories/confirm", async (c) => {
  const body = await c.req.json<unknown>();
  ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  const result = await ports.confirmProposedMemory(c.env, body);
  return ports.jsonOk(c, result);
});

routes.post("/v1/memories/revise", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  const result = await ports.reviseMemoryByRequest(c.env, body, {
    actorPrincipal: ports.getApiPrincipal(c),
    canManageAll: await ports.isTenantAdmin(c, tenantId)
  });
  return ports.jsonOk(c, result);
});

routes.post("/v1/memories/refresh", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  const result = await ports.refreshMemoryByRequest(c.env, body, {
    actorPrincipal: ports.getApiPrincipal(c),
    canManageAll: await ports.isTenantAdmin(c, tenantId)
  });
  return ports.jsonOk(c, result);
});

routes.post("/v1/memories/suppress", async (c) => {
  const body = await c.req.json<unknown>();
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  const result = await ports.suppressMemoryByRequest(c.env, body, {
    actorPrincipal: ports.getApiPrincipal(c),
    canManageAll: await ports.isTenantAdmin(c, tenantId)
  });
  return ports.jsonOk(c, result);
});

routes.post("/v1/memories/:memoryId/trash", async (c) => {
  const body = await c.req.json<unknown>().catch(() => ({}));
  const bodyWithId = body && typeof body === "object" && !Array.isArray(body)
    ? { ...(body as Record<string, unknown>), memory_id: c.req.param("memoryId") }
    : { memory_id: c.req.param("memoryId") };
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(bodyWithId));
  return ports.jsonOk(c, await ports.trashMemoryByRequest(c.env, bodyWithId, {
    actorPrincipal: ports.getApiPrincipal(c),
    canManageAll: await ports.isTenantAdmin(c, tenantId)
  }));
});

routes.post("/v1/memories/:memoryId/restore", async (c) => {
  const body = await c.req.json<unknown>().catch(() => ({}));
  const bodyWithId = body && typeof body === "object" && !Array.isArray(body)
    ? { ...(body as Record<string, unknown>), memory_id: c.req.param("memoryId") }
    : { memory_id: c.req.param("memoryId") };
  const tenantId = ports.assertApiTenantAccess(c, ports.tenantFromBody(bodyWithId));
  return ports.jsonOk(c, await ports.restoreMemoryByRequest(c.env, bodyWithId, {
    actorPrincipal: ports.getApiPrincipal(c),
    canManageAll: await ports.isTenantAdmin(c, tenantId)
  }));
});

routes.delete("/v1/memories/:memoryId", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  const result = await ports.deleteMemoryById(c.env, tenantId, c.req.param("memoryId"), {
    actorPrincipal: ports.getApiPrincipal(c),
    canManageAll: await ports.isTenantAdmin(c, tenantId)
  });
  return ports.jsonOk(c, result);
});

routes.post("/v1/memories/search", async (c) => {
  const body = await c.req.json<unknown>();
  ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  const payload = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  if (payload.generation_id || payload.ranking_profile_id) {
    const tenantId = ports.tenantFromBody(body) ?? "default";
    const auth = ports.getApiAuthContext(c);
    await ports.assertPermission(c.env, {
      tenantId,
      projectId: typeof payload.project_id === "string" ? payload.project_id : null,
      principal: ports.getApiPrincipal(c),
      permission: "admin",
      fallbackRole: auth.defaultRole
    });
  }
  const scope = payload.search_scope ?? "evidence";
  if (!["evidence", "governance", "both"].includes(String(scope))) {
    throw new HttpError(400, "invalid_search_scope", "search_scope must be evidence, governance, or both");
  }
  if (scope === "governance") {
    return ports.jsonOk(c, await ports.searchDecisionMemories(c.env, body, { principal: ports.getApiPrincipal(c) }));
  }
  const evidence = await ports.searchMemories(c.env, body, {
    actorPrincipal: ports.getApiPrincipal(c),
    recordUsage: scope !== "both"
  });
  if (scope === "evidence") return ports.jsonOk(c, evidence);
  const governance = await ports.searchDecisionMemories(c.env, body, {
    principal: ports.getApiPrincipal(c),
    recordUsage: false
  });
  const queryHash = await sha256Hex(typeof payload.q === "string" ? payload.q : "");
  const governanceResults = governance.results as Array<Record<string, unknown>>;
  const usage = await ports.recordMemoryUsage(c.env, {
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
      ? payload.work_type as MemoryWorkType
      : null,
    retrieval_generation_id: evidence.meta.retrieval?.generation_id === governance.meta.retrieval.generation_id
      ? evidence.meta.retrieval?.generation_id
      : null,
    ranking_profile_id: evidence.meta.retrieval?.ranking_profile_id === governance.meta.retrieval.ranking_profile_id
      ? evidence.meta.retrieval?.ranking_profile_id
      : null,
    actor_principal: ports.getApiPrincipal(c),
    items: [
      ...evidence.results
        .filter((item: EvidenceResultItem) => item.kind === "memory")
        .map((item: EvidenceResultItem, index: number) => ({
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
  return ports.jsonOk(c, {
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

routes.post("/v1/memories/retrieve-context", async (c) => {
  const body = await c.req.json<unknown>();
  ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  const result = await ports.retrieveMemoryContext(c.env, body, {
    actorPrincipal: ports.getApiPrincipal(c)
  });
  return ports.jsonOk(c, result);
});

routes.post("/v1/memories/profile", async (c) => {
  const body = await c.req.json<unknown>();
  ports.assertApiTenantAccess(c, ports.tenantFromBody(body));
  const result = await ports.getMemoryProfile(c.env, body, { actorPrincipal: ports.getApiPrincipal(c) });
  return ports.jsonOk(c, result);
});

routes.get("/v1/memories/:memoryId/details", async (c) => {
  const tenantId = ports.assertApiTenantAccess(c, c.req.query("tenant_id"));
  const result = await ports.getMemoryDetails(c.env, tenantId, c.req.param("memoryId"), {
    actorPrincipal: ports.getApiPrincipal(c)
  });
  return ports.jsonOk(c, result);
});
}
