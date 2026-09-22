import {
  HttpError,
  assessMemoryUsefulnessV2,
  answerGuidanceForDisposition,
  buildTenantMemoryProfile,
  deriveEvidenceDisposition,
  evidenceAnswerTemplate,
  requiresMultipleEvidenceSources,
  type MemoryEvidenceBundle,
  type MemoryProfileResponse,
  type MemorySearchMode,
  type MemoryWorkType
} from "@org-brain/shared";
import type { Env } from "./types";
import { validateBusinessClassification } from "./business-category-service";
import { recordMemoryUsage } from "./memory-effect-service";
import { parseOptionalNullableString as parseOptionalString } from "./request-value-utils";
import { parseMemorySearchMode, parseOptionalBoolean, parseOptionalInteger, parseString } from "./memory-service-utils";
import type { MemoryProfileRequest, PrincipalActorOptions } from "./memory-service-types";
import { bestEffortMarkMemoryResultsAccessed, searchMemories } from "./memory-search-service";

type MemorySearchHit = Awaited<ReturnType<typeof searchMemories>>["results"][number];

type RetrieveMemoryContextResponse = {
  results: Array<Pick<
    MemorySearchHit,
    "kind" | "id" | "score" | "memory_kind" | "lifecycle_state" | "current_version" | "source_references"
  >>;
  meta: Awaited<ReturnType<typeof searchMemories>>["meta"] & {
    usage_id: string;
    verification_sampled: boolean;
  };
  evidence_bundle: Omit<MemoryEvidenceBundle, "evidence"> & {
    evidence: Array<Record<string, unknown>>;
  };
};

// The answer guidance contract is always returned, so its characters are held
// back from the evidence budget instead of being spent on excerpts.
const ANSWER_GUIDANCE_CHAR_RESERVE = 600;

function hasRetrievalSignal(result: MemorySearchHit): boolean {
  const breakdown = result.score_breakdown;
  if (!breakdown) return true;
  return Number(breakdown.lexical) !== 0 || Number(breakdown.semantic) !== 0;
}

function parseProfileRequest(raw: unknown): {
  tenantId: string;
  projectId: string | null;
  q?: string;
  limitDurable: number;
  limitRecent: number;
  rewriteQuery: boolean;
  searchMode: MemorySearchMode;
  businessCategoryId: string | null;
  workType: MemoryWorkType | null;
} {
  if (!raw || typeof raw !== "object") {
    throw new HttpError(400, "invalid_payload", "request body must be an object");
  }
  const body = raw as MemoryProfileRequest;
  const q = typeof body.q === "string" && body.q.trim() ? body.q.trim().slice(0, 500) : undefined;
  return {
    tenantId: body.tenant_id ? parseString(body.tenant_id, "tenant_id") : "default",
    projectId: parseOptionalString(body.project_id, "project_id", 128),
    q,
    limitDurable: parseOptionalInteger(body.limit_durable, "limit_durable", 8, 1, 16),
    limitRecent: parseOptionalInteger(body.limit_recent, "limit_recent", 8, 1, 16),
    rewriteQuery: parseOptionalBoolean(body.rewrite_query, "rewrite_query", false),
    searchMode: parseMemorySearchMode(body.search_mode, "search_mode", "hybrid_v4"),
    businessCategoryId: parseOptionalString(body.business_category_id, "business_category_id", 128),
    workType: body.work_type ?? null
  };
}

export async function retrieveMemoryContext(
  env: Env,
  rawBody: unknown,
  options: PrincipalActorOptions = {}
): Promise<RetrieveMemoryContextResponse> {
  if (!rawBody || typeof rawBody !== "object") {
    throw new HttpError(400, "invalid_payload", "request body must be an object");
  }
  const body = rawBody as Record<string, unknown>;
  const tenantId = body.tenant_id ? parseString(body.tenant_id, "tenant_id") : "default";
  const topK = parseOptionalInteger(body.top_k, "top_k", 5, 1, 50);
  const tokenBudget = parseOptionalInteger(body.token_budget, "token_budget", 8_000, 512, 16_000);
  const queryAt =
    typeof body.at === "number" && Number.isFinite(body.at)
      ? body.at
      : Date.now();
  const search = await searchMemories(
    env,
    {
      ...body,
      tenant_id: tenantId,
      limit: Math.min(50, topK * 2),
      search_mode: body.search_mode ?? "hybrid_v4"
    },
    { ...options, recordUsage: false }
  );
  const selected = search.results
    .filter((result) => result.kind === "memory" && hasRetrievalSignal(result))
    .slice(0, topK);
  const ids = selected.map((result) => result.id);
  const selectedGenerationId = search.meta.retrieval?.generation_id ?? null;
  const unitRows = ids.length === 0
    ? { results: [] as Array<{
        memory_id: string;
        unit_type: string;
        speaker: string | null;
        text: string;
        event_at: number | null;
        source_ref_json: string | null;
        source_span_start: number | null;
        source_span_end: number | null;
        metadata_json: string;
        extraction_state: string;
      }> }
    : selectedGenerationId
      ? await env.OPEN_BRAIN_DB.prepare(
        `SELECT source_id AS memory_id, unit_type, speaker, text, event_at,
                source_ref_json, source_span_start, source_span_end,
                metadata_json, extraction_state
         FROM retrieval_units
         WHERE generation_id = ? AND tenant_id = ? AND source_type = 'memory'
           AND source_id IN (${ids.map(() => "?").join(",")})
         ORDER BY source_id,
           CASE unit_type
             WHEN 'atomic' THEN 0 WHEN 'profile' THEN 1 WHEN 'timeline' THEN 2
             WHEN 'ledger' THEN 3 ELSE 4
           END,
           event_at DESC`
      ).bind(selectedGenerationId, tenantId, ...ids).all<{
        memory_id: string;
        unit_type: string;
        speaker: string | null;
        text: string;
        event_at: number | null;
        source_ref_json: string | null;
        source_span_start: number | null;
        source_span_end: number | null;
        metadata_json: string;
        extraction_state: string;
      }>()
      : await env.OPEN_BRAIN_DB.prepare(
        `SELECT memory_id, unit_type, speaker, text, event_at, source_ref_json,
                source_span_start, source_span_end, metadata_json, extraction_state
         FROM memory_retrieval_units_v4
         WHERE tenant_id = ? AND memory_id IN (${ids.map(() => "?").join(",")})
         ORDER BY memory_id,
           CASE unit_type
             WHEN 'atomic' THEN 0 WHEN 'profile' THEN 1 WHEN 'timeline' THEN 2
             WHEN 'ledger' THEN 3 ELSE 4
           END,
           event_at DESC`
      ).bind(tenantId, ...ids).all<{
        memory_id: string;
        unit_type: string;
        speaker: string | null;
        text: string;
        event_at: number | null;
        source_ref_json: string | null;
        source_span_start: number | null;
        source_span_end: number | null;
        metadata_json: string;
        extraction_state: string;
      }>();
  const grouped = new Map<string, typeof unitRows.results>();
  for (const unit of unitRows.results) {
    const rows = grouped.get(unit.memory_id) ?? [];
    if (rows.length < 8) rows.push(unit);
    grouped.set(unit.memory_id, rows);
  }
  const versionRows = ids.length === 0
    ? { results: [] as Array<{ memory_id: string; version: number; snapshot_json: string }> }
    : await env.OPEN_BRAIN_DB.prepare(
        `SELECT memory_id, version, snapshot_json
         FROM memory_versions
         WHERE tenant_id = ? AND memory_id IN (${ids.map(() => "?").join(",")})
         ORDER BY memory_id, version DESC`
      ).bind(tenantId, ...ids).all<{
        memory_id: string;
        version: number;
        snapshot_json: string;
      }>();
  const previousValues = new Map<string, string[]>();
  for (const version of versionRows.results) {
    const values = previousValues.get(version.memory_id) ?? [];
    if (values.length >= 3) continue;
    try {
      const snapshot = JSON.parse(version.snapshot_json) as { content?: unknown };
      if (typeof snapshot.content === "string" && snapshot.content.trim()) {
        values.push(snapshot.content);
        previousValues.set(version.memory_id, values);
      }
    } catch {
      // Version snapshots are canonical but may predate the current JSON shape.
    }
  }
  const confidenceRows = ids.length === 0
    ? { results: [] as Array<{ id: string; confidence_score: number | null }> }
    : await env.OPEN_BRAIN_DB.prepare(
        `SELECT id, confidence_score FROM memories
         WHERE tenant_id = ? AND id IN (${ids.map(() => "?").join(",")})`
      ).bind(tenantId, ...ids).all<{ id: string; confidence_score: number | null }>();
  const confidenceById = new Map(
    confidenceRows.results.map((row) => [row.id, Number(row.confidence_score ?? 0.5)])
  );
  const charBudget = Math.max(0, tokenBudget * 4 - ANSWER_GUIDANCE_CHAR_RESERVE);
  let usedChars = 0;
  const evidence: Array<Record<string, unknown>> = [];
  const currentState: Array<Record<string, unknown>> = [];
  const timeline: Array<Record<string, unknown>> = [];
  const conflicts: Array<{ memory_id: string; conflict: string }> = [];
  for (const result of selected) {
    if (usedChars >= charBudget) break;
    const units = grouped.get(result.id) ?? [];
    const unit = units[0];
    const remaining = charBudget - usedChars;
    const text = String(unit?.text ?? result.content_preview).slice(0, Math.min(4_000, remaining));
    usedChars += text.length;
    let sourceReference = result.source_references?.[0] ?? null;
    try {
      sourceReference = unit?.source_ref_json ? JSON.parse(unit.source_ref_json) : sourceReference;
    } catch {
      // Keep canonical response provenance if a rebuildable projection is malformed.
    }
    evidence.push({
      memory_id: result.id,
      text,
      speaker: unit?.speaker ?? null,
      session_date: unit?.event_at ?? sourceReference?.captured_at ?? result.created_at,
      source_reference: sourceReference,
      source_span: {
        start: unit?.source_span_start ?? null,
        end: unit?.source_span_end ?? null
      },
      score: result.score,
      extraction_state: unit?.extraction_state ?? "degraded",
      usefulness: assessMemoryUsefulnessV2({ stage: "use",
        task_project_id: typeof body.project_id === "string" ? body.project_id : null,
        within_budget: usedChars <= charBudget })
    });
    for (const candidate of units) {
      let metadata: Record<string, unknown> = {};
      try {
        metadata = JSON.parse(candidate.metadata_json || "{}") as Record<string, unknown>;
      } catch {
        metadata = {};
      }
      if (candidate.unit_type === "profile" || candidate.unit_type === "ledger") {
        const entry = {
          memory_id: result.id,
          current: candidate.text,
          previous_values: (previousValues.get(result.id) ?? []).slice(1),
          ...metadata
        };
        const cost = JSON.stringify(entry).length;
        if (usedChars + cost > charBudget) continue;
        usedChars += cost;
        currentState.push(entry);
      }
      if (candidate.unit_type === "timeline") {
        const entry = {
          memory_id: result.id,
          event_at: candidate.event_at,
          delta_from_question_ms: candidate.event_at === null ? null : queryAt - candidate.event_at,
          ...metadata
        };
        const cost = JSON.stringify(entry).length;
        if (usedChars + cost > charBudget) continue;
        usedChars += cost;
        timeline.push(entry);
      }
    }
    for (const conflict of result.conflicts ?? []) conflicts.push({ memory_id: result.id, conflict });
  }
  const query = parseString(body.q, "q");
  const multiSession = requiresMultipleEvidenceSources(query);
  const disposition = deriveEvidenceDisposition({
    evidenceCount: evidence.length,
    independentSourceCount: new Set(evidence.map((item) =>
      (item.source_reference as { ref?: string } | null)?.ref ?? String(item.memory_id)
    )).size,
    requiresMultipleSources: multiSession,
    conflictCount: conflicts.length,
    hasDegradedExtraction: evidence.some((item) => item.extraction_state !== "ready"),
    hasLowConfidence: selected.some((item) => (confidenceById.get(item.id) ?? 0.5) < 0.5),
    degradedReasons: search.meta.retrieval?.degraded_reasons ?? []
  });
  const answerTemplate = evidenceAnswerTemplate(disposition, {
    hasTimeline: timeline.length > 0,
    hasCurrentState: currentState.length > 0,
    requiresMultipleSources: multiSession
  });
  const legacyMissingEvidence = [
    ...disposition.missing_evidence,
    ...(evidence.some((item) => item.extraction_state !== "ready")
      ? ["structured_extractor_degraded"]
      : [])
  ];
  const shadowMode = env.EVIDENCE_DISPOSITION_MODE === "shadow";
  const legacyAbstention = legacyMissingEvidence.length > 0 || conflicts.length > 0;
  const effectiveAbstention = shadowMode ? legacyAbstention : disposition.abstention_recommended;
  // Abstaining means nothing is auto-injected; the wide candidate set stays
  // reachable through the explicit search tool.
  const injectedEvidence = effectiveAbstention ? [] : evidence;
  const injectedCurrentState = effectiveAbstention ? [] : currentState;
  const injectedTimeline = effectiveAbstention ? [] : timeline;
  const injectedChars = effectiveAbstention ? 0 : usedChars;
  const answerGuidance = answerGuidanceForDisposition(
    effectiveAbstention && !["insufficient", "conflicted"].includes(disposition.evidence_status)
      ? { ...disposition, evidence_status: "insufficient", abstention_recommended: true }
      : disposition,
    injectedEvidence.map((item) => {
      const reference = item.source_reference;
      if (!reference || typeof reference !== "object") return null;
      const ref = (reference as { ref?: unknown }).ref;
      return typeof ref === "string" ? { ref } : null;
    })
  );
  if (shadowMode && legacyAbstention !== disposition.abstention_recommended) {
    console.warn(JSON.stringify({
      event: "orgbrain.evidence_disposition.shadow_difference",
      proposed_status: disposition.evidence_status,
      legacy_abstention: legacyAbstention,
      evidence_count: evidence.length,
      conflict_count: conflicts.length
    }));
  }
  const contextUsage = await recordMemoryUsage(env, {
    tenant_id: tenantId,
    project_id: typeof body.project_id === "string" ? body.project_id : null,
    task_id:typeof body.task_id === "string" ? body.task_id : null,
    capability: "memory_retrieve_context",
    access_path: "context",
    request_source: "api",
    requested_business_category_id: typeof body.business_category_id === "string"
      ? body.business_category_id
      : null,
    requested_work_type: typeof body.work_type === "string"
      ? body.work_type as MemoryWorkType
      : null,
    retrieval_generation_id: selectedGenerationId,
    ranking_profile_id: search.meta.retrieval?.ranking_profile_id ?? null,
    actor_principal: options.actorPrincipal ?? null,
    items: injectedEvidence.map((item, index) => ({
      source_type: "memory" as const,
      source_id: String(item.memory_id),
      source_version:selected.find(source=>source.id===item.memory_id)?.current_version ?? null,
      rank: index + 1,
      score: typeof item.score === "number" ? item.score : null,
      reference_type: "injected" as const,
      used_state: "unknown" as const,
      injected_token_estimate: Math.ceil(String(item.text ?? "").length / 4)
    }))
  });
  const selectedById = new Map(selected.map((result) => [result.id, result]));
  return {
    ...search,
    results: injectedEvidence.flatMap((item) => {
      const result = selectedById.get(String(item.memory_id));
      return result
        ? [{
          kind: result.kind,
          id: result.id,
          score: result.score,
          memory_kind: result.memory_kind,
          lifecycle_state: result.lifecycle_state,
          current_version: result.current_version,
          source_references: result.source_references
        }]
        : [];
    }),
    meta: {
      ...search.meta,
      usage_id: contextUsage.usage_id,
      usage_item_ids:contextUsage.usage_item_ids,
      usage_items:contextUsage.usage_items,
      verification_sampled: contextUsage.verification_sampled
    },
    evidence_bundle: {
      query_at: queryAt,
      token_budget: tokenBudget,
      estimated_tokens: Math.ceil((injectedChars + answerGuidance.instructions.length) / 4),
      evidence_status: disposition.evidence_status,
      answer_template: shadowMode && legacyAbstention ? "abstention" : answerTemplate,
      evidence: injectedEvidence,
      current_state: injectedCurrentState,
      timeline: injectedTimeline,
      conflicts,
      missing_evidence: shadowMode ? legacyMissingEvidence : disposition.missing_evidence,
      abstention_recommended: effectiveAbstention,
      degraded_reasons: disposition.degraded_reasons,
      answer_guidance: answerGuidance
    }
  };
}

export async function getMemoryProfile(
  env: Env,
  rawBody: unknown,
  options: PrincipalActorOptions = {}
): Promise<MemoryProfileResponse> {
  const request = parseProfileRequest(rawBody);
  await validateBusinessClassification(env, request.tenantId, request.businessCategoryId, request.workType, { required: false });
  let profile = await buildTenantMemoryProfile(env.OPEN_BRAIN_DB, request);
  if (request.businessCategoryId || request.workType) {
    const ids = [...new Set([
      ...profile.durable.map((item) => item.id),
      ...profile.recent.map((item) => item.id),
      ...profile.search_results.filter((item) => item.kind === "memory").map((item) => item.id)
    ])];
    const allowed = new Set<string>();
    if (ids.length) {
      const clauses = ["tenant_id = ?", `id IN (${ids.map(() => "?").join(",")})`];
      const bindings: unknown[] = [request.tenantId, ...ids];
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
    profile = {
      ...profile,
      durable: profile.durable.filter((item) => allowed.has(item.id)),
      recent: profile.recent.filter((item) => allowed.has(item.id)),
      search_results: profile.search_results.filter((item) => item.kind === "memory" && allowed.has(item.id))
    };
  }
  await bestEffortMarkMemoryResultsAccessed(
    env,
    request.tenantId,
    [
      ...profile.durable.map((item) => item.id),
      ...profile.recent.map((item) => item.id),
      ...profile.search_results.filter((item) => item.kind === "memory").map((item) => item.id)
    ]
  );
  const ids = [...new Set([
    ...profile.durable.map((item) => item.id),
    ...profile.recent.map((item) => item.id),
    ...profile.search_results.filter((item) => item.kind === "memory").map((item) => item.id)
  ])];
  const usage = await recordMemoryUsage(env, {
    tenant_id: request.tenantId,
    project_id: request.projectId,
    capability: "memory_profile",
    access_path: "profile",
    request_source: "api",
    requested_business_category_id: request.businessCategoryId,
    requested_work_type: request.workType,
    actor_principal: options.actorPrincipal ?? null,
    items: ids.map((id, index) => ({
      source_type: "memory" as const,
      source_id: id,
      rank: index + 1,
      reference_type: "returned" as const,
      used_state: "unknown" as const
    }))
  });
  return {
    ...profile,
    meta: {
      ...profile.meta,
      usage_id: usage.usage_id,
      verification_sampled: usage.verification_sampled
    }
  };
}
