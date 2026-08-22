import { HttpError, searchTenantMemories, searchTenantRetrievalUnitsV3, searchTenantRetrievalUnitsV4, sha256, type MemoryKind, type MemoryLifecycleState, type MemorySearchResponse, type MemorySearchMode, type MemorySourceReference, type MemoryWorkType } from "@org-brain/shared";
import { filterMemorySearchResults, parseSearchFilters } from "./rationale-service";
import { rerankV3MemoryCandidates, searchRetrievalGenerationSemanticIndex, searchSemanticIndex, searchV3SemanticIndex, searchV4SemanticIndex } from "./retrieval-index-service";
import type { Env } from "./types";
import { validateBusinessClassification } from "./business-category-service";
import { recordMemoryUsage } from "./memory-effect-service";
import { loadRetrievalGenerationProfile, resolveRetrievalGenerationAssignment, type RetrievalGenerationProfile } from "./retrieval-generation-service";
import { fnv1a32 } from "./deterministic-sampling";
import { parseOptionalNullableString as parseOptionalString } from "./request-value-utils";
import { normalizeActorPrincipal, parseMemorySearchMode, parseOptionalBoolean, parseOptionalFiniteNumber, parseOptionalInteger, parseString } from "./memory-service-utils";
import type { MemoryRow, MemorySearchRequest, PrincipalActorOptions } from "./memory-service-types";

function shadowSampleRate(raw: string | undefined): number {
  if (!raw?.trim()) return 1;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : 0;
}

export function shouldRunRetrievalShadow(rawRate: string | undefined, sampleKey: string): boolean {
  const rate = shadowSampleRate(rawRate);
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  return fnv1a32(sampleKey) / 0x1_0000_0000 < rate;
}

export function resolveRetrievalSearchMode(
  requested: MemorySearchMode,
  env: Pick<Env,
    | "HYBRID_V3_MODE"
    | "HYBRID_V4_MODE"
    | "HYBRID_V3_CANARY_SAMPLE_RATE"
    | "HYBRID_V4_CANARY_SAMPLE_RATE">,
  sampleKey: string
): MemorySearchMode {
  if (requested !== "memories") return requested;
  if (env.HYBRID_V4_MODE === "on") return "hybrid_v4";
  if (
    env.HYBRID_V4_MODE === "canary" &&
    shouldRunRetrievalShadow(env.HYBRID_V4_CANARY_SAMPLE_RATE ?? "0.05", sampleKey)
  ) return "hybrid_v4";
  if (env.HYBRID_V3_MODE === "on") return "hybrid_v3";
  if (
    env.HYBRID_V3_MODE === "canary" &&
    shouldRunRetrievalShadow(env.HYBRID_V3_CANARY_SAMPLE_RATE ?? "0.05", sampleKey)
  ) return "hybrid_v3";
  return requested;
}

function parseSearchRequest(raw: unknown): {
  tenantId: string;
  projectId: string | null;
  q: string;
  limit: number;
  rewriteQuery: boolean;
  searchMode: MemorySearchMode;
  includeHistory: boolean;
  includeSuppressed: boolean;
  at: number;
  businessCategoryId: string | null;
  workType: MemoryWorkType | null;
  generationId: string | null;
  rankingProfileId: string | null;
  taskId: string | null;
  traceId: string | null;
  externalRunId: string | null;
} {
  if (!raw || typeof raw !== "object") {
    throw new HttpError(400, "invalid_payload", "request body must be an object");
  }
  const body = raw as MemorySearchRequest;
  return {
    tenantId: body.tenant_id ? parseString(body.tenant_id, "tenant_id") : "default",
    projectId: parseOptionalString(body.project_id, "project_id", 128),
    q: parseString(body.q, "q").slice(0, 500),
    limit: parseOptionalInteger(body.limit, "limit", 5, 1, 50),
    rewriteQuery: parseOptionalBoolean(body.rewrite_query, "rewrite_query", false),
    searchMode: parseMemorySearchMode(
      body.search_mode ?? ({
        default: "memories",
        lexical: "hybrid_v3",
        hybrid: "hybrid_v4",
        structured: "hybrid_v4"
      } as const)[body.retrieval_profile ?? "default"],
      "search_mode",
      "memories"
    ),
    includeHistory: parseOptionalBoolean(body.include_history, "include_history", false),
    includeSuppressed: parseOptionalBoolean(body.include_suppressed, "include_suppressed", false),
    at: parseOptionalFiniteNumber(body.at, "at") ?? Date.now(),
    businessCategoryId: parseOptionalString(body.business_category_id, "business_category_id", 128),
    workType: body.work_type ?? null,
    generationId: parseOptionalString(body.generation_id, "generation_id", 128),
    rankingProfileId: parseOptionalString(body.ranking_profile_id, "ranking_profile_id", 128),
    taskId: parseOptionalString(body.task_id, "task_id", 128),
    traceId: parseOptionalString(body.trace_id, "trace_id", 128),
    externalRunId: parseOptionalString(body.external_run_id, "external_run_id", 256)
  };
}

export function stableResultReadable(permissionsJson: string | null | undefined, principalId: string | null) {
  if (!permissionsJson) return true;
  try {
    const grants = JSON.parse(permissionsJson) as Array<{
      principal_type?: string;
      principal_id?: string;
      permissions?: string[];
    }>;
    if (!Array.isArray(grants) || grants.length === 0) return true;
    return Boolean(principalId) && grants.some((grant) =>
      grant.principal_type === "principal" &&
      grant.principal_id === principalId &&
      grant.permissions?.includes("read")
    );
  } catch {
    return false;
  }
}

function parseJsonStringArray(raw: string | null | undefined): string[] {
  try {
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function parseSourceReferences(raw: string | null | undefined): MemorySourceReference[] {
  try {
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((value): value is MemorySourceReference =>
        Boolean(value) &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        typeof (value as Record<string, unknown>).type === "string" &&
        typeof (value as Record<string, unknown>).ref === "string"
      )
      : [];
  } catch {
    return [];
  }
}

async function searchStableRetrievalUnits(
  env: Env,
  request: ReturnType<typeof parseSearchRequest>,
  generation: {
    id: string;
    unit_schema_version: number;
    extractor_name: string;
    extractor_version: string;
    embedding_profile_id: string | null;
    ranking_profile_id: string;
    ranking_algorithm: string;
    ranking_config_json: string;
  },
  principalId: string | null
): Promise<MemorySearchResponse> {
  const tokens = [...new Set(request.q.toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((token) => token.trim().replaceAll('"', ""))
    .filter((token) => token.length >= 2))].slice(0, 16);
  const categorySql = request.businessCategoryId ? " AND u.business_category_id = ?" : "";
  const workSql = request.workType ? " AND u.work_type = ?" : "";
  const projectSql = request.projectId ? " AND (u.project_id = ? OR u.project_id IS NULL)" : "";
  const bindings: unknown[] = [generation.id, request.tenantId];
  type StableUnitCandidate = {
    id: string;
    source_id: string;
    unit_type: string;
    text: string;
    raw_rank: number | null;
  };
  let unitRows: StableUnitCandidate[];
  if (tokens.length) {
    const ftsQuery = tokens.map((token) => `"${token}"*`).join(" AND ");
    bindings.push(ftsQuery);
    if (request.projectId) bindings.push(request.projectId);
    if (request.businessCategoryId) bindings.push(request.businessCategoryId);
    if (request.workType) bindings.push(request.workType);
    unitRows = (await env.OPEN_BRAIN_DB.prepare(
      `SELECT u.id, u.source_id, u.unit_type, u.text, bm25(retrieval_units_fts) AS raw_rank
       FROM retrieval_units_fts
       JOIN retrieval_units u
         ON u.id = retrieval_units_fts.unit_id
        AND u.generation_id = retrieval_units_fts.generation_id
        AND u.tenant_id = retrieval_units_fts.tenant_id
       WHERE u.generation_id = ? AND u.tenant_id = ?
         AND u.source_type = 'memory' AND retrieval_units_fts MATCH ?
         ${projectSql}${categorySql}${workSql}
       ORDER BY bm25(retrieval_units_fts), u.created_at DESC
       LIMIT 200`
    ).bind(...bindings).all<StableUnitCandidate>()).results;
  } else {
    if (request.projectId) bindings.push(request.projectId);
    if (request.businessCategoryId) bindings.push(request.businessCategoryId);
    if (request.workType) bindings.push(request.workType);
    unitRows = (await env.OPEN_BRAIN_DB.prepare(
      `SELECT u.id, u.source_id, u.unit_type, u.text, NULL AS raw_rank
       FROM retrieval_units u
       WHERE u.generation_id = ? AND u.tenant_id = ? AND u.source_type = 'memory'
         ${projectSql}${categorySql}${workSql}
       ORDER BY u.created_at DESC LIMIT 200`
    ).bind(...bindings).all<StableUnitCandidate>()).results;
  }
  let rankingConfig: Record<string, unknown> = {};
  try {
    rankingConfig = JSON.parse(generation.ranking_config_json) as Record<string, unknown>;
  } catch {
    rankingConfig = {};
  }
  const rrfConstant = Number.isFinite(Number(rankingConfig.rrf_constant))
    ? Math.max(1, Number(rankingConfig.rrf_constant))
    : 60;
  const semanticWeight = Number.isFinite(Number(rankingConfig.semantic_weight))
    ? Math.max(0, Number(rankingConfig.semantic_weight))
    : 0.9;
  const rerankerWeight = Number.isFinite(Number(rankingConfig.reranker_weight))
    ? Math.max(0, Number(rankingConfig.reranker_weight))
    : 1;
  const degradedReasons: string[] = [];
  let semantic: Awaited<ReturnType<typeof searchRetrievalGenerationSemanticIndex>> = null;
  if (generation.embedding_profile_id) {
    try {
      semantic = await searchRetrievalGenerationSemanticIndex(env, generation.id, {
        tenant_id: request.tenantId,
        project_id: request.projectId,
        query: request.q,
        limit: 50
      });
      if (!semantic) degradedReasons.push("semantic_provider_unavailable");
    } catch {
      degradedReasons.push("semantic_provider_unavailable");
    }
  }
  const semanticHits = semantic?.hits ?? [];
  const semanticRows: StableUnitCandidate[] = [];
  for (let offset = 0; offset < semanticHits.length; offset += 100) {
    const chunk = semanticHits.slice(offset, offset + 100);
    if (chunk.length === 0) continue;
    const rows = (await env.OPEN_BRAIN_DB.prepare(
      `SELECT id, source_id, unit_type, text, NULL AS raw_rank
       FROM retrieval_units
       WHERE generation_id = ? AND tenant_id = ? AND id IN (${chunk.map(() => "?").join(",")})
         AND source_type = 'memory'`
    ).bind(generation.id, request.tenantId, ...chunk.map((item) => item.id)).all<StableUnitCandidate>()).results;
    semanticRows.push(...rows);
  }
  const allUnits = new Map<string, StableUnitCandidate>();
  for (const unit of [...unitRows, ...semanticRows]) allUnits.set(unit.id, unit);
  const scoreById = new Map<string, number>();
  unitRows.forEach((unit, index) => {
    const configuredWeight = Number(rankingConfig[`${unit.unit_type}_weight`]);
    const weight = Number.isFinite(configuredWeight) ? Math.max(0, configuredWeight) : 1;
    const score = generation.ranking_algorithm === "reciprocal_rank_fusion"
      ? weight / (rrfConstant + index + 1)
      : weight / (1 + Math.abs(unit.raw_rank ?? index));
    scoreById.set(unit.source_id, (scoreById.get(unit.source_id) ?? 0) + score);
  });
  semanticHits.forEach((hit, index) => {
    const unit = allUnits.get(hit.id);
    if (!unit) return;
    const configuredWeight = Number(rankingConfig[`${unit.unit_type}_weight`]);
    const channelWeight = Number.isFinite(configuredWeight) ? Math.max(0, configuredWeight) : 1;
    const score = semanticWeight * channelWeight / (rrfConstant + index + 1);
    scoreById.set(unit.source_id, (scoreById.get(unit.source_id) ?? 0) + score);
  });
  const candidateTextByMemory = new Map<string, string[]>();
  for (const unit of allUnits.values()) {
    const values = candidateTextByMemory.get(unit.source_id) ?? [];
    if (!values.includes(unit.text)) values.push(unit.text);
    candidateTextByMemory.set(unit.source_id, values.slice(0, 5));
  }
  let reranker: Awaited<ReturnType<typeof rerankV3MemoryCandidates>> = null;
  try {
    reranker = await rerankV3MemoryCandidates(env, request.q, [...candidateTextByMemory.entries()].map(([id, texts]) => ({
      id,
      text: texts.join("\n")
    })));
    if (!reranker) degradedReasons.push("reranker_unavailable");
  } catch {
    degradedReasons.push("reranker_unavailable");
  }
  [...(reranker?.scores.entries() ?? [])]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .forEach(([memoryId], index) => {
      scoreById.set(memoryId, (scoreById.get(memoryId) ?? 0) + rerankerWeight / (rrfConstant + index + 1));
    });
  const ids = [...scoreById.keys()].sort((left, right) =>
    (scoreById.get(right) ?? 0) - (scoreById.get(left) ?? 0) || left.localeCompare(right)
  );
  const memoryRows = ids.length
    ? (await env.OPEN_BRAIN_DB.prepare(
      `SELECT id, project_id, content, summary, tags_json, source, external_key,
              created_at, kind, lifecycle_state, current_version, confidence_score,
              utility_score, permissions_json, source_refs_json, conflicts_json,
              business_category_id, work_type
       FROM memories WHERE tenant_id = ? AND id IN (${ids.map(() => "?").join(",")})
         AND (lifecycle_state IS NULL OR lifecycle_state != 'suppressed')
         AND (valid_from IS NULL OR valid_from <= ?)
         AND (valid_until IS NULL OR valid_until > ?)
         AND (tags_json IS NULL OR tags_json NOT LIKE '%"source-drift"%')
         AND (conflicts_json IS NULL OR conflicts_json NOT LIKE '%source_drift%')`
    ).bind(request.tenantId, ...ids, request.at, request.at).all<MemoryRow>()).results
    : [];
  const byId = new Map(memoryRows.map((row) => [row.id, row]));
  const results = ids.flatMap((id) => {
    const row = byId.get(id);
    if (!row || !stableResultReadable(row.permissions_json, principalId)) return [];
    if (request.projectId && row.project_id !== null && row.project_id !== request.projectId) return [];
    if (request.businessCategoryId && row.business_category_id !== request.businessCategoryId) return [];
    if (request.workType && row.work_type !== request.workType) return [];
    const score = scoreById.get(id) ?? null;
    return [{
      kind: "memory" as const,
      id: row.id,
      summary: row.summary,
      content_preview: row.content.slice(0, 1000),
      score,
      source: row.source,
      created_at: row.created_at,
      memory_kind: (row.kind as MemoryKind | null) ?? "episodic",
      lifecycle_state: (row.lifecycle_state as MemoryLifecycleState | null) ?? "active",
      current_version: Number(row.current_version ?? 1),
      source_references: parseSourceReferences(row.source_refs_json),
      conflicts: parseJsonStringArray(row.conflicts_json),
      permission_decision: { allowed: true, principal_id: principalId }
    }];
  }).slice(0, request.limit);
  return {
    tenant_id: request.tenantId,
    project_id: request.projectId,
    q: request.q,
    rewrite_query: request.rewriteQuery,
    search_mode: generation.unit_schema_version === 1 ? "hybrid_v3" : "hybrid_v4",
    include_history: request.includeHistory,
    results,
    meta: {
      search_strategy: generation.unit_schema_version === 1 ? "hybrid_v3" : "hybrid_v4",
      matched_count: results.length,
      returned_count: results.length,
      fallback_used: false,
      variant_count: 1,
      lexical_result_count: results.length,
      doc_result_count: 0,
      history_result_count: 0,
      top_result_ids: results.map((item) => item.id),
      top_result_ranks: results.map((item) => item.score),
      retrieval: {
        semantic: { available: Boolean(semantic), provider: semantic?.provider ?? null },
        graph: { available: false, provider: "none" },
        degraded: degradedReasons.length > 0,
        degraded_reasons: [...new Set(degradedReasons)],
        lexical_candidate_count: unitRows.length,
        semantic_candidate_count: semanticHits.length,
        parent_candidate_count: scoreById.size,
        channel_candidate_counts: Object.fromEntries(
          ["atomic", "profile", "ledger", "timeline", "segment"].map((channel) => [
            channel,
            [...allUnits.values()].filter((unit) => unit.unit_type === channel).length
          ])
        ),
        reranker_version: reranker?.provider ?? null,
        generation_id: generation.id,
        unit_schema_version: String(generation.unit_schema_version),
        extractor_name: generation.extractor_name,
        extractor_version: generation.extractor_version,
        ranking_profile_id: request.rankingProfileId ?? generation.ranking_profile_id,
        embedding_profile_id: generation.embedding_profile_id
      }
    }
  };
}

export async function searchMemories(
  env: Env,
  rawBody: unknown,
  options: PrincipalActorOptions = {}
): Promise<MemorySearchResponse> {
  const parsedRequest = parseSearchRequest(rawBody);
  await validateBusinessClassification(
    env,
    parsedRequest.tenantId,
    parsedRequest.businessCategoryId,
    parsedRequest.workType,
    { required: false }
  );
  const explicitGenerationRequested = Boolean(parsedRequest.generationId);
  let selectedGeneration: RetrievalGenerationProfile | null = null;
  let selectedAssignment: Awaited<ReturnType<typeof resolveRetrievalGenerationAssignment>> | null = null;
  if (parsedRequest.generationId) {
    const assignment = await resolveRetrievalGenerationAssignment(
      env,
      parsedRequest.tenantId,
      parsedRequest.projectId
    );
    selectedAssignment = assignment;
    if (
      parsedRequest.generationId !== assignment.active_generation_id &&
      parsedRequest.generationId !== assignment.shadow_generation_id
    ) {
      throw new HttpError(403, "generation_not_assigned", "requested generation is not assigned to tenant/project");
    }
    const generation = await loadRetrievalGenerationProfile(env, parsedRequest.generationId);
    if (!generation) throw new HttpError(404, "retrieval_generation_not_found", "generation not found");
    selectedGeneration = generation;
    parsedRequest.searchMode = generation.unit_schema_version === 1 ? "hybrid_v3" : "hybrid_v4";
  } else if (env.RETRIEVAL_GENERATION_ROUTING && env.RETRIEVAL_GENERATION_ROUTING !== "legacy") {
    try {
      const assignment = await resolveRetrievalGenerationAssignment(
        env,
        parsedRequest.tenantId,
        parsedRequest.projectId
      );
      selectedAssignment = assignment;
      const generation = await loadRetrievalGenerationProfile(env, assignment.active_generation_id);
      if (!generation) {
        throw new HttpError(503, "retrieval_generation_not_found", "assigned generation not found");
      }
      selectedGeneration = generation;
      parsedRequest.generationId = generation.id;
      parsedRequest.searchMode = generation.unit_schema_version === 1 ? "hybrid_v3" : "hybrid_v4";
    } catch (error) {
      if (env.RETRIEVAL_GENERATION_ROUTING === "enforce") throw error;
      // Observe mode preserves legacy search until assignments and stable projections are ready.
    }
  }
  if (parsedRequest.rankingProfileId) {
    if (!selectedGeneration) {
      const assignment = await resolveRetrievalGenerationAssignment(
        env,
        parsedRequest.tenantId,
        parsedRequest.projectId
      );
      selectedAssignment = assignment;
      selectedGeneration = await loadRetrievalGenerationProfile(env, assignment.active_generation_id);
      if (!selectedGeneration) throw new HttpError(404, "retrieval_generation_not_found", "assigned generation not found");
      parsedRequest.generationId = selectedGeneration.id;
      parsedRequest.searchMode = selectedGeneration.unit_schema_version === 1 ? "hybrid_v3" : "hybrid_v4";
    }
    const ranking = (await env.OPEN_BRAIN_DB.prepare(
      `SELECT id, algorithm, config_json FROM retrieval_ranking_profiles
       WHERE id = ? AND retired_at IS NULL`
    ).bind(parsedRequest.rankingProfileId).all<{
      id: string;
      algorithm: string;
      config_json: string;
    }>()).results[0];
    if (!ranking) throw new HttpError(404, "retrieval_ranking_profile_not_found", "ranking profile not found or retired");
    selectedGeneration = {
      ...selectedGeneration,
      ranking_profile_id: ranking.id,
      ranking_algorithm: ranking.algorithm,
      ranking_config_json: ranking.config_json
    };
  }
  const shadowSampleKey = `${parsedRequest.tenantId}\0${parsedRequest.projectId ?? ""}\0${parsedRequest.q}`;
  const request = {
    ...parsedRequest,
    searchMode: resolveRetrievalSearchMode(parsedRequest.searchMode, env, shadowSampleKey)
  };
  let queryHashPromise: Promise<string> | null = null;
  const getQueryHash = () => queryHashPromise ??= sha256(request.q);
  const attachUsage = async (response: MemorySearchResponse): Promise<MemorySearchResponse> => {
    if (options.recordUsage === false) return response;
    const queryHash = await getQueryHash();
    const usage = await recordMemoryUsage(env, {
      tenant_id: request.tenantId,
      project_id: request.projectId ?? undefined,
      task_id: request.taskId ?? undefined,
      trace_id: request.traceId ?? undefined,
      external_run_id: request.externalRunId ?? undefined,
      capability: "memory_search",
      access_path: "search",
      request_source: "api",
      query_hash: queryHash,
      requested_business_category_id: request.businessCategoryId,
      requested_work_type: request.workType,
      retrieval_generation_id: request.generationId ?? (request.searchMode === "hybrid_v3"
        ? "gen_baseline_units"
        : request.searchMode === "hybrid_v4"
          ? "gen_structured_context"
          : null),
      ranking_profile_id: request.rankingProfileId ?? "rank_default",
      actor_principal: options.actorPrincipal ?? null,
      items: response.results
        .filter((item) => item.kind === "memory")
        .map((item, index) => ({
          source_type: "memory" as const,
          source_id: item.id,
          source_version: item.current_version ?? null,
          rank: index + 1,
          score: item.score,
          reference_type: "returned" as const,
          used_state: "unknown" as const
        }))
    });
    const body = rawBody as Record<string, unknown>;
    return {
      ...response,
      meta: {
        ...response.meta,
        usage_id: usage.usage_id,
        verification_sampled: usage.verification_sampled,
        ...(["hybrid_v3", "hybrid_v4"].includes(String(body.search_mode))
          ? { deprecation_warnings: [`${String(body.search_mode)} is deprecated; use retrieval_profile`] }
          : {}),
        retrieval: {
          semantic: response.meta.retrieval?.semantic ?? { available: false, provider: null },
          graph: response.meta.retrieval?.graph ?? { available: false, provider: "none" },
          degraded: response.meta.retrieval?.degraded ?? false,
          ...response.meta.retrieval,
          generation_id: response.meta.retrieval?.generation_id ?? null,
          unit_schema_version: response.meta.retrieval?.unit_schema_version ?? null,
          extractor_name: response.meta.retrieval?.extractor_name ?? null,
          ranking_profile_id: response.meta.retrieval?.ranking_profile_id ?? null,
          embedding_profile_id: response.meta.retrieval?.embedding_profile_id ?? null
        }
      }
    };
  };
  if (selectedGeneration) {
    if (request.includeHistory || request.includeSuppressed) {
      throw new HttpError(
        400,
        "stable_generation_filter_unsupported",
        "stable generation search does not support history or suppressed records"
      );
    }
    const startedAt = performance.now();
    let response = await searchStableRetrievalUnits(
      env,
      request,
      selectedGeneration,
      normalizeActorPrincipal(options.actorPrincipal)
    );
    const stableFilters = parseSearchFilters(rawBody);
    if (Object.values(stableFilters).some(Boolean)) {
      const allowedIds = await filterMemorySearchResults(
        env,
        request.tenantId,
        response.results.map((item) => item.id),
        stableFilters
      );
      const results = response.results.filter((item) => allowedIds.has(item.id));
      response = {
        ...response,
        results,
        meta: {
          ...response.meta,
          matched_count: results.length,
          returned_count: results.length,
          top_result_ids: results.map((item) => item.id),
          top_result_ranks: results.map((item) => item.score)
        }
      };
    }
    const primaryLatency = performance.now() - startedAt;
    if (
      !explicitGenerationRequested &&
      selectedAssignment?.shadow_generation_id &&
      selectedAssignment.shadow_generation_id !== selectedGeneration.id &&
      shouldRunRetrievalShadow(String(selectedAssignment.shadow_sample_rate), shadowSampleKey)
    ) {
      const shadowStartedAt = performance.now();
      let shadow: MemorySearchResponse | null = null;
      let shadowError: string | null = null;
      try {
        const generation = await loadRetrievalGenerationProfile(env, selectedAssignment.shadow_generation_id);
        if (!generation) throw new Error("shadow generation not found");
        shadow = await searchStableRetrievalUnits(
          env,
          { ...request, generationId: generation.id },
          generation,
          normalizeActorPrincipal(options.actorPrincipal)
        );
        if (Object.values(stableFilters).some(Boolean)) {
          const allowedIds = await filterMemorySearchResults(
            env,
            request.tenantId,
            shadow.results.map((item) => item.id),
            stableFilters
          );
          const results = shadow.results.filter((item) => allowedIds.has(item.id));
          shadow = {
            ...shadow,
            results,
            meta: {
              ...shadow.meta,
              matched_count: results.length,
              returned_count: results.length,
              top_result_ids: results.map((item) => item.id),
              top_result_ranks: results.map((item) => item.score)
            }
          };
        }
      } catch (error) {
        shadowError = error instanceof Error ? error.message.slice(0, 200) : "shadow retrieval failed";
      }
      const queryHash = await getQueryHash();
      const primaryIds = new Set(response.results.map((item) => item.id));
      const shadowIds = shadow?.results.map((item) => item.id) ?? [];
      await env.OPEN_BRAIN_DB.prepare(
        `INSERT INTO retrieval_evaluation_events(
           id, tenant_id, project_id, query_hash, baseline_generation_id,
           candidate_generation_id, baseline_result_count, candidate_result_count,
           overlap_count, baseline_empty, candidate_empty, candidate_degraded,
           baseline_latency_ms, candidate_latency_ms, evidence_tokens,
           projection_lag_ms, error_code, created_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        crypto.randomUUID(), request.tenantId, request.projectId, queryHash,
        selectedGeneration.id, selectedAssignment.shadow_generation_id,
        response.results.length, shadowIds.length,
        shadowIds.filter((id) => primaryIds.has(id)).length,
        response.results.length === 0 ? 1 : 0, shadowIds.length === 0 ? 1 : 0,
        shadow?.meta.retrieval?.degraded ? 1 : 0,
        Number(primaryLatency.toFixed(3)),
        Number((performance.now() - shadowStartedAt).toFixed(3)),
        null, shadow?.meta.retrieval?.projection_lag_ms ?? null,
        shadowError, Date.now()
      ).run().catch(() => {
        // Shadow telemetry is best-effort and never breaks active retrieval.
      });
    }
    await bestEffortMarkMemoryResultsAccessed(
      env,
      request.tenantId,
      response.results.map((item) => item.id)
    );
    return attachUsage(response);
  }
  const widenedLimit = Math.max(request.limit, 20);
  const semantic =
    request.searchMode === "hybrid_v2"
      ? await searchSemanticIndex(env, {
          tenant_id: request.tenantId,
          project_id: request.projectId,
          query: request.q,
          limit: widenedLimit
        })
      : request.searchMode === "hybrid_v3" || request.searchMode === "hybrid_v4"
        ? await (request.searchMode === "hybrid_v4"
          ? searchV4SemanticIndex
          : searchV3SemanticIndex)(env, {
            tenant_id: request.tenantId,
            project_id: request.projectId,
            query: request.q,
            limit: 50
          })
        : null;
  const principalId = normalizeActorPrincipal(options.actorPrincipal);
  let base: MemorySearchResponse;
  if (request.searchMode === "hybrid_v3" || request.searchMode === "hybrid_v4") {
    const preliminary = await searchTenantRetrievalUnitsV3(env.OPEN_BRAIN_DB, {
      ...request,
      limit: 20,
      principalId,
      semanticHits: semantic?.hits,
      semanticProvider: semantic?.provider
    });
    let rerankerCandidates: Array<{ id: string; text: string }> = [];
    if (preliminary.results.length > 0) {
      const ids = preliminary.results.map((result) => result.id);
      const placeholders = ids.map(() => "?").join(",");
      const rows = await env.OPEN_BRAIN_DB.prepare(
        `SELECT id, content, summary FROM memories
         WHERE tenant_id = ? AND id IN (${placeholders})`
      ).bind(request.tenantId, ...ids).all<{ id: string; content: string; summary: string | null }>();
      const rowById = new Map(rows.results.map((row) => [row.id, row]));
      rerankerCandidates = ids.flatMap((id) => {
        const row = rowById.get(id);
        return row ? [{ id, text: `${row.summary ?? ""}\n${row.content}`.trim() }] : [];
      });
    }
    let reranker: Awaited<ReturnType<typeof rerankV3MemoryCandidates>> = null;
    try {
      reranker = await rerankV3MemoryCandidates(env, request.q, rerankerCandidates);
    } catch {
      reranker = null;
    }
    const searchUnits =
      request.searchMode === "hybrid_v4"
        ? searchTenantRetrievalUnitsV4
        : searchTenantRetrievalUnitsV3;
    base = await searchUnits(env.OPEN_BRAIN_DB, {
      ...request,
      limit: widenedLimit,
      principalId,
      semanticHits: semantic?.hits,
      semanticProvider: semantic?.provider,
      rerankerScores: reranker?.scores,
      rerankerProvider: reranker?.provider
    });
  } else {
    base = await searchTenantMemories(env.OPEN_BRAIN_DB, {
      ...request,
      limit: widenedLimit,
      principalId,
      semanticHits: semantic?.hits,
      semanticProvider: semantic?.provider
    });
  }
  if (
    env.HYBRID_V3_MODE === "shadow" &&
    request.searchMode !== "hybrid_v3" &&
    shouldRunRetrievalShadow(env.HYBRID_V3_SHADOW_SAMPLE_RATE, shadowSampleKey)
  ) {
    const shadowStartedAt = performance.now();
    let shadowError: string | null = null;
    let shadow: MemorySearchResponse | null = null;
    try {
      const shadowSemantic = await searchV3SemanticIndex(env, {
        tenant_id: request.tenantId,
        project_id: request.projectId,
        query: request.q,
        limit: 50
      });
      shadow = await searchTenantRetrievalUnitsV3(env.OPEN_BRAIN_DB, {
        ...request,
        searchMode: "hybrid_v3",
        limit: request.limit,
        principalId,
        semanticHits: shadowSemantic?.hits,
        semanticProvider: shadowSemantic?.provider
      });
    } catch (error) {
      shadowError = error instanceof Error ? error.message.slice(0, 500) : "shadow retrieval failed";
    }
    const legacyIds = new Set(base.results.map((result) => result.id));
    const shadowIds = shadow?.results.map((result) => result.id) ?? [];
    const queryHash = await getQueryHash();
    await env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO retrieval_v3_shadow_events(
         id, tenant_id, project_id, query_hash, legacy_result_count,
         v3_result_count, overlap_count, empty, degraded, latency_ms, error, created_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      crypto.randomUUID(),
      request.tenantId,
      request.projectId,
      queryHash,
      base.results.length,
      shadowIds.length,
      shadowIds.filter((id) => legacyIds.has(id)).length,
      shadowIds.length === 0 ? 1 : 0,
      shadow?.meta.retrieval?.degraded ? 1 : 0,
      Number((performance.now() - shadowStartedAt).toFixed(3)),
      shadowError,
      Date.now()
    ).run().catch(() => {
      // Shadow observability must never break the primary retrieval response.
    });
  }
  if (
    env.HYBRID_V4_MODE === "shadow" &&
    request.searchMode !== "hybrid_v4" &&
    shouldRunRetrievalShadow(env.HYBRID_V4_SHADOW_SAMPLE_RATE, shadowSampleKey)
  ) {
    const shadowStartedAt = performance.now();
    let shadowError: string | null = null;
    let shadow: MemorySearchResponse | null = null;
    try {
      const shadowSemantic = await searchV4SemanticIndex(env, {
        tenant_id: request.tenantId,
        project_id: request.projectId,
        query: request.q,
        limit: 50
      });
      shadow = await searchTenantRetrievalUnitsV4(env.OPEN_BRAIN_DB, {
        ...request,
        searchMode: "hybrid_v4",
        limit: request.limit,
        principalId,
        semanticHits: shadowSemantic?.hits,
        semanticProvider: shadowSemantic?.provider
      });
    } catch (error) {
      shadowError = error instanceof Error ? error.message.slice(0, 500) : "v4 shadow retrieval failed";
    }
    const v3Ids = new Set(base.results.map((result) => result.id));
    const v4Ids = shadow?.results.map((result) => result.id) ?? [];
    const queryHash = await getQueryHash();
    await env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO retrieval_v4_shadow_events(
         id, tenant_id, project_id, query_hash, v3_result_count, v4_result_count,
         overlap_count, empty, degraded, evidence_tokens, projection_lag_ms,
         latency_ms, error, created_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      crypto.randomUUID(),
      request.tenantId,
      request.projectId,
      queryHash,
      base.results.length,
      v4Ids.length,
      v4Ids.filter((id) => v3Ids.has(id)).length,
      v4Ids.length === 0 ? 1 : 0,
      shadow?.meta.retrieval?.degraded ? 1 : 0,
      null,
      shadow?.meta.retrieval?.projection_lag_ms ?? null,
      Number((performance.now() - shadowStartedAt).toFixed(3)),
      shadowError,
      Date.now()
    ).run().catch(() => {
      // Shadow observability must never break the primary retrieval response.
    });
  }
  if (request.businessCategoryId || request.workType) {
    const memoryIds = base.results.filter((item) => item.kind === "memory").map((item) => item.id);
    const allowed = new Set<string>();
    if (memoryIds.length) {
      const clauses = ["tenant_id = ?", `id IN (${memoryIds.map(() => "?").join(",")})`];
      const bindings: unknown[] = [request.tenantId, ...memoryIds];
      if (request.businessCategoryId) {
        clauses.push("business_category_id = ?");
        bindings.push(request.businessCategoryId);
      }
      if (request.workType) {
        clauses.push("work_type = ?");
        bindings.push(request.workType);
      }
      const rows = await env.OPEN_BRAIN_DB.prepare(
        `SELECT id FROM memories WHERE ${clauses.join(" AND ")}`
      ).bind(...bindings).all<{ id: string }>();
      for (const row of rows.results) allowed.add(row.id);
    }
    base = { ...base, results: base.results.filter((item) => item.kind === "memory" && allowed.has(item.id)) };
  }
  const filters = parseSearchFilters(rawBody);
  const allowedIds = await filterMemorySearchResults(
    env,
    request.tenantId,
    base.results.filter((item) => item.kind === "memory").map((item) => item.id),
    filters
  );
  const hasFilters = Object.values(filters).some(Boolean);
  if (!hasFilters) {
    const results = base.results.slice(0, request.limit);
    const response = {
      ...base,
      results,
      meta: {
        ...base.meta,
        returned_count: results.length,
        top_result_ids: results.map((item) => item.id),
        top_result_ranks: results.map((item) => item.score)
      }
    };
    await bestEffortMarkMemoryResultsAccessed(env, request.tenantId, response.results.map((item) => item.id));
    return attachUsage(response);
  }

  const filteredResults = base.results.filter((item) => item.kind !== "memory" || allowedIds.has(item.id)).slice(0, request.limit);
  const response = {
    ...base,
    results: filteredResults,
    meta: {
      ...base.meta,
      matched_count: filteredResults.length,
      returned_count: filteredResults.length,
      top_result_ids: filteredResults.map((item) => item.id),
      top_result_ranks: filteredResults.map((item) => item.score)
    }
  };
  await bestEffortMarkMemoryResultsAccessed(env, request.tenantId, filteredResults.map((item) => item.id));
  return attachUsage(response);
}

export async function bestEffortMarkMemoryResultsAccessed(env: Env, tenantId: string, ids: string[]): Promise<void> {
  const uniqueMemoryIds = [...new Set(ids.filter(Boolean))].slice(0, 8);
  const accessedAt = Date.now();
  for (const memoryId of uniqueMemoryIds) {
    try {
      await env.OPEN_BRAIN_DB.prepare(
        `UPDATE memories
         SET last_accessed_at = ?
         WHERE tenant_id = ? AND id = ?`
      ).bind(accessedAt, tenantId, memoryId).run();
    } catch {
      // Retrieval access telemetry is best-effort and must not break reads.
    }
  }
}
