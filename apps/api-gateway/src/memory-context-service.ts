import {
  HttpError,
  assessMemoryUsefulnessV2,
  answerGuidanceForDisposition,
  buildTenantMemoryProfile,
  deriveEvidenceDisposition,
  estimateJsonTokens,
  estimateTextTokens,
  truncateTextToTokens,
  evidenceAnswerTemplate,
  localTaskQueryPlan,
  coversLocalTaskQuery,
  matchesLocalTaskQuery,
  requiresMultipleEvidenceSources,
  type MemoryEvidenceBundle,
  type MemoryProfileResponse,
  type MemorySearchMode,
  type MemoryWorkType
} from "@org-brain/shared";
import type { Env } from "./types";
import { validateBusinessClassification } from "./business-category-service";
import { recordMemoryUsage } from "./memory-effect-service";
import { parseOptionalNullableString as parseOptionalString, parseLimitParam } from "./request-value-utils";
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
// back from the evidence budget instead of being spent on excerpts. The
// budget is enforced in estimated tokens, the same estimator that reports
// estimated_tokens, so CJK text cannot overrun it. The Japanese guidance
// renders at about 135-165 tokens, hence 200 (the old 600 characters = 150).
const ANSWER_GUIDANCE_TOKEN_RESERVE = 200;
// Longest single excerpt, in tokens (4,000 ASCII characters under the estimator).
const MAX_EXCERPT_TOKENS = 1_000;

function hasRetrievalSignal(result: MemorySearchHit): boolean {
  const breakdown = result.score_breakdown;
  if (!breakdown) return true;
  return [breakdown.lexical, breakdown.semantic, breakdown.graph]
    .some((score) => typeof score === "number" && Number.isFinite(score) && score > 0);
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
    limitDurable: parseLimitParam(body.limit_durable, { field: "limit_durable", min: 1, max: 16, fallback: 8 }),
    limitRecent: parseLimitParam(body.limit_recent, { field: "limit_recent", min: 1, max: 16, fallback: 8 }),
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
  const topK = parseLimitParam(body.top_k, { field: "top_k", min: 1, max: 50, fallback: 5 });
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
  const query = parseString(body.q, "q");
  const taskPlan = search.meta.task_query?.applied ? localTaskQueryPlan(search.meta.task_query.subject_query ?? query) : null;
  const selected = search.results
    .filter((result) => result.kind === "memory" && (hasRetrievalSignal(result)
      // This lane already checked every delivered subject lexically. A zero
      // base-v4 score is not a failed lexical match in this separate lane.
      || search.meta.task_query?.applied && search.meta.task_query.coverage === "covered"))
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
  type ContextMemoryRow = { id: string; confidence_score: number | null; content: string; learning_json: string | null; current_version: number | null };
  const confidenceRows = ids.length === 0
    ? { results: [] as ContextMemoryRow[] }
    : await env.OPEN_BRAIN_DB.prepare(
        `SELECT id, confidence_score, content, learning_json, current_version FROM memories
         WHERE tenant_id = ? AND id IN (${ids.map(() => "?").join(",")})`
      ).bind(tenantId, ...ids).all<ContextMemoryRow>();
  const confidenceById = new Map(
    confidenceRows.results.map((row) => [row.id, Number(row.confidence_score ?? 0.5)])
  );
  const capsules = new Map<string, { content: string; version: number }>();
  if (search.meta.task_query?.applied) {
    for (const row of confidenceRows.results) {
      try {
        const provenance = JSON.parse(row.learning_json ?? '{}').conversation_provenance;
        if (provenance?.evidence_status === 'supplied_unverified') {
          capsules.set(row.id, { content: row.content, version: row.current_version ?? 1 });
        }
      } catch { /* Legacy malformed metadata does not identify a conversation capsule. */ }
    }
  }
  const tokenLimit = Math.max(0, tokenBudget - ANSWER_GUIDANCE_TOKEN_RESERVE);
  let usedTokens = 0;
  // Charged cost per delivered item (evidence entries, including provenance fields); reused for enforcement and reporting.
  const chargedCost = new WeakMap<object, number>();
  const evidence: Array<Record<string, unknown>> = [];
  const currentState: Array<Record<string, unknown>> = [];
  const timeline: Array<Record<string, unknown>> = [];
  const conflicts: Array<{ memory_id: string; conflict: string }> = [];
  for (const result of selected) {
    if (usedTokens >= tokenLimit) break;
    const capsule = capsules.get(result.id);
    const useCapsule = capsule && capsule.version === (result.current_version ?? 1);
    const units = useCapsule ? [] : grouped.get(result.id) ?? [];
    const unit = taskPlan
      ? units.find(item => matchesLocalTaskQuery({ content: item.text }, taskPlan))
      : units[0];
    const remaining = tokenLimit - usedTokens;
    let sourceReference = result.source_references?.[0] ?? null;
    try {
      sourceReference = unit?.source_ref_json ? JSON.parse(unit.source_ref_json) : sourceReference;
    } catch {
      // Keep canonical response provenance if a rebuildable projection is malformed.
    }
    const entryFor = (text: string, withinBudget: boolean) => ({
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
        within_budget: withinBudget })
    });
    // The charged cost of an evidence item is its whole JSON entry, so provenance fields count against the budget.
    // Reviewed conversation content includes the reason and reuse conditions.
    // A sentence projection can remove stop conditions. Deliver it atomically,
    // without upgrading its supplied/unverified provenance or using stale versions.
    const overhead = estimateJsonTokens(entryFor("", true));
    const excerptLimit = Math.min(MAX_EXCERPT_TOKENS, remaining - overhead);
    if (excerptLimit <= 0) continue;
    let text: string;
    let entry: ReturnType<typeof entryFor>;
    let cost: number;
    if (useCapsule) {
      if (estimateTextTokens(capsule.content) > excerptLimit) continue;
      text = capsule.content;
      entry = entryFor(text, true);
      cost = estimateJsonTokens(entry);
      if (cost > remaining) continue;
    } else {
      text = truncateTextToTokens(String(unit?.text ?? result.content_preview), excerptLimit);
      entry = entryFor(text, true);
      cost = estimateJsonTokens(entry);
      // JSON escaping can cost more than the plain text estimate; shrink until the whole entry fits.
      for (let limit = excerptLimit; cost > remaining && limit > 0; ) {
        limit = Math.min(limit - 1, Math.floor(limit * remaining / cost));
        text = truncateTextToTokens(String(unit?.text ?? result.content_preview), limit);
        entry = entryFor(text, true);
        cost = estimateJsonTokens(entry);
      }
      if (cost > remaining) continue;
    }
    usedTokens += cost;
    chargedCost.set(entry, cost);
    evidence.push(entry);
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
        const cost = estimateJsonTokens(entry);
        if (usedTokens + cost > tokenLimit) continue;
        usedTokens += cost;
        chargedCost.set(entry, cost);
        currentState.push(entry);
      }
      if (candidate.unit_type === "timeline") {
        const entry = {
          memory_id: result.id,
          event_at: candidate.event_at,
          delta_from_question_ms: candidate.event_at === null ? null : queryAt - candidate.event_at,
          ...metadata
        };
        const cost = estimateJsonTokens(entry);
        if (usedTokens + cost > tokenLimit) continue;
        usedTokens += cost;
        chargedCost.set(entry, cost);
        timeline.push(entry);
      }
    }
    for (const conflict of result.conflicts ?? []) conflicts.push({ memory_id: result.id, conflict });
  }
  // A search hit is not a delivered context excerpt. Recheck after top_k,
  // projection selection and text budgeting, before disposition and receipts.
  if (taskPlan && !coversLocalTaskQuery(evidence.map(item => ({ content: String(item.text ?? '') })), taskPlan)) {
    evidence.length = 0;
    currentState.length = 0;
    timeline.length = 0;
    usedTokens = 0;
  }
  const multiSession = requiresMultipleEvidenceSources(query);
  const shadowMode = env.EVIDENCE_DISPOSITION_MODE === "shadow";
  const derive = () => {
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
    const legacyAbstention = legacyMissingEvidence.length > 0 || conflicts.length > 0;
    const effectiveAbstention = shadowMode ? legacyAbstention : disposition.abstention_recommended;
    // Abstaining means nothing is auto-injected; the wide candidate set stays
    // reachable through the explicit search tool.
    const injectedEvidence = effectiveAbstention ? [] : evidence;
    const injectedCurrentState = effectiveAbstention ? [] : currentState;
    const injectedTimeline = effectiveAbstention ? [] : timeline;
    // Sum of the costs charged during packing; zero when abstaining or when nothing was delivered.
    const injectedCharged = [...injectedEvidence, ...injectedCurrentState, ...injectedTimeline]
      .reduce((sum, item) => sum + (chargedCost.get(item) ?? 0), 0);
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
    return {
      disposition, answerTemplate, legacyMissingEvidence, legacyAbstention, effectiveAbstention,
      injectedEvidence, injectedCurrentState, injectedTimeline, injectedCharged, answerGuidance,
      total: injectedCharged + estimateTextTokens(answerGuidance.instructions)
    };
  };
  let derived = derive();
  // The guidance embeds up to 3 source refs (500 chars each), so it can outgrow the fixed reserve.
  // Drop the lowest-priority (last-packed) memory, with its state and timeline, until everything fits.
  // With no evidence left the guidance carries no refs and has a fixed small size.
  while (derived.total > tokenBudget && evidence.length > 0) {
    const dropped = String(evidence.pop()?.memory_id);
    for (const list of [currentState, timeline, conflicts]) {
      for (let index = list.length - 1; index >= 0; index -= 1) {
        if (String(list[index].memory_id) === dropped) list.splice(index, 1);
      }
    }
    derived = derive();
  }
  const {
    disposition, answerTemplate, legacyMissingEvidence, legacyAbstention, effectiveAbstention,
    injectedEvidence, injectedCurrentState, injectedTimeline, injectedCharged, answerGuidance
  } = derived;
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
      injected_token_estimate: chargedCost.get(item) ?? estimateJsonTokens(item)
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
      ...(search.meta.task_query ? {
        task_query: { ...search.meta.task_query, coverage: taskPlan
          && coversLocalTaskQuery(injectedEvidence.map(item => ({ content: String(item.text ?? '') })), taskPlan)
          ? 'covered' as const : 'missing' as const },
        returned_count: injectedEvidence.length,
        top_result_ids: injectedEvidence.map(item => String(item.memory_id)),
        top_result_ranks: injectedEvidence.map(item => typeof item.score === 'number' ? item.score : null)
      } : {}),
      usage_id: contextUsage.usage_id,
      usage_item_ids:contextUsage.usage_item_ids,
      usage_items:contextUsage.usage_items,
      verification_sampled: contextUsage.verification_sampled
    },
    evidence_bundle: {
      query_at: queryAt,
      token_budget: tokenBudget,
      estimated_tokens: injectedCharged + estimateTextTokens(answerGuidance.instructions),
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
  const scope = (rawBody as { scope?: "mine" | "org" }).scope;
  if (scope !== undefined && scope !== "mine" && scope !== "org") throw new HttpError(400, "invalid_scope", "scope must be mine or org");
  let profile = await buildTenantMemoryProfile(env.OPEN_BRAIN_DB, { ...request, readAccess: options.actorPrincipal ? { principal: options.actorPrincipal, allowedProjectId: options.allowedProjectId, isAdmin: options.canManageAll, scope } : undefined });
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
