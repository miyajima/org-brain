import {
  HttpError,
  countContextTokens,
  measureContextPayload,
  shouldSampleMemoryEffectVerification,
  ulid,
  assessMemoryUsefulnessV2,
  answerGuidanceForDisposition,
  buildTenantMemoryProfile,
  deriveEvidenceDisposition,
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
import { parseUsagePurpose, recordMemoryUsage, resolveMemoryUsageContext } from "./memory-effect-service";
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
    usage_item_ids: string[];
    usage_items: Array<{ usage_item_id: string; source_type: string; source_id: string; source_version: number | null }>;
    task_id: string | null;
    usage_purpose: string;
  };
  evidence_bundle: Omit<MemoryEvidenceBundle, "evidence"> & {
    evidence: Array<Record<string, unknown>>;
    token_count_basis: string;
    budget_limited: boolean;
  };
};

// The answer guidance contract is always returned, so its characters are held
// back from the evidence budget instead of being spent on excerpts.
const ANSWER_GUIDANCE_CHAR_RESERVE = 600;

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
  const body = { ...rawBody as Record<string, unknown> };
  const tenantId = body.tenant_id ? parseString(body.tenant_id, "tenant_id") : "default";
  const topK = parseOptionalInteger(body.top_k, "top_k", 5, 1, 50);
  const tokenBudget = parseOptionalInteger(body.token_budget, "token_budget", 8_000, 512, 16_000);
  const usagePurpose = parseUsagePurpose(body.usage_purpose);
  const requestedTaskId = parseOptionalString(body.task_id, "task_id", 128);
  const requestedTraceId = parseOptionalString(body.trace_id, "trace_id", 128);
  const externalRunId = parseOptionalString(body.external_run_id, "external_run_id", 256);
  const usageContext = await resolveMemoryUsageContext(env, {
    tenant_id: tenantId, project_id: body.project_id === undefined ? undefined : parseOptionalString(body.project_id, "project_id", 128),
    task_id: body.task_id === undefined ? undefined : requestedTaskId,
    trace_id: body.trace_id === undefined ? undefined : requestedTraceId, external_run_id: externalRunId
  });
  const { task_id: taskId, trace_id: traceId } = usageContext;
  if (body.project_id === undefined && usageContext.project_id) body.project_id = usageContext.project_id;
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
  type ContextMemoryRow = { id: string; confidence_score: number | null; content: string; learning_json: string | null; current_version: number | null; rationale: string | null; reuse_rule: string | null; verification_state: string | null };
  const confidenceRows = ids.length === 0
    ? { results: [] as ContextMemoryRow[] }
    : await env.OPEN_BRAIN_DB.prepare(
        `SELECT id, confidence_score, content, learning_json, current_version, rationale, reuse_rule, verification_state FROM memories
         WHERE tenant_id = ? AND id IN (${ids.map(() => "?").join(",")})`
      ).bind(tenantId, ...ids).all<ContextMemoryRow>();
  const confidenceById = new Map(
    confidenceRows.results.map((row) => [row.id, Number(row.confidence_score ?? 0.5)])
  );
  const capsules = new Map<string, { content: string; version: number }>();
  for (const row of confidenceRows.results) {
    let conversation = false;
    try { conversation = JSON.parse(row.learning_json ?? '{}').conversation_provenance?.evidence_status === 'supplied_unverified'; }
    catch { /* Malformed provenance does not remove independent reuse conditions. */ }
    if (conversation || row.rationale || row.reuse_rule) {
      capsules.set(row.id, { content: [row.content,
        ...(row.rationale ? [`Rationale: ${row.rationale}`] : []),
        ...(row.reuse_rule ? [`Reuse or avoid: ${row.reuse_rule}`] : [])].join('\n'), version: row.current_version ?? 1 });
    }
  }
  const charBudget = Math.max(0, tokenBudget * 4 - ANSWER_GUIDANCE_CHAR_RESERVE);
  let usedChars = 0;
  const evidence: Array<Record<string, unknown>> = [];
  const currentState: Array<Record<string, unknown>> = [];
  const timeline: Array<Record<string, unknown>> = [];
  const conflicts: Array<{ memory_id: string; conflict: string }> = [];
  for (const result of selected) {
    if (usedChars >= charBudget) break;
    const capsule = capsules.get(result.id);
    if (capsule && capsule.version !== (result.current_version ?? 1)) continue;
    const useCapsule = capsule;
    const units = useCapsule ? [] : grouped.get(result.id) ?? [];
    const unit = taskPlan
      ? units.find(item => matchesLocalTaskQuery({ content: item.text }, taskPlan))
      : units[0];
    const remaining = charBudget - usedChars;
    // Reviewed conversation content includes the reason and reuse conditions.
    // A sentence projection can remove stop conditions. Deliver it atomically,
    // without upgrading its supplied/unverified provenance or using stale versions.
    if (useCapsule && capsule.content.length > remaining) continue;
    const text = useCapsule ? capsule.content : String(unit?.text ?? result.content_preview);
    if (text.length > (useCapsule ? remaining : Math.min(4_000, remaining))) continue;
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
      verification_state: confidenceRows.results.find(row => row.id === result.id)?.verification_state ?? "unverified",
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
  // A search hit is not a delivered context excerpt. Recheck after top_k,
  // projection selection and text budgeting, before disposition and receipts.
  if (taskPlan && !coversLocalTaskQuery(evidence.map(item => ({ content: String(item.text ?? '') })), taskPlan)) {
    evidence.length = 0;
    currentState.length = 0;
    timeline.length = 0;
    usedChars = 0;
  }
  const multiSession = requiresMultipleEvidenceSources(query);
  const usageId = ulid();
  const sampled = shouldSampleMemoryEffectVerification(tenantId, usageId);
  const selectedById = new Map(selected.map(result => [result.id, result]));
  const receiptIds = new Map(evidence.map(item => [String(item.memory_id), ulid()]));
  let budgetLimited = false;
  const buildResponse = (proposed: typeof evidence, forPacking = false): RetrieveMemoryContextResponse => {
    const covered = !taskPlan || coversLocalTaskQuery(proposed.map(item => ({ content: String(item.text ?? "") })), taskPlan);
    const candidates = covered || forPacking ? proposed : [];
    const disposition = deriveEvidenceDisposition({
      evidenceCount: candidates.length,
      independentSourceCount: new Set(candidates.map(item =>
        (item.source_reference as { ref?: string } | null)?.ref ?? String(item.memory_id))).size,
      requiresMultipleSources: multiSession,
      conflictCount: conflicts.length,
      hasDegradedExtraction: candidates.some(item => item.extraction_state !== "ready"),
      hasLowConfidence: candidates.some(item => (confidenceById.get(String(item.memory_id)) ?? 0.5) < 0.5),
      degradedReasons: search.meta.retrieval?.degraded_reasons ?? []
    });
    const legacyMissingEvidence = [...disposition.missing_evidence,
      ...(candidates.some(item => item.extraction_state !== "ready") ? ["structured_extractor_degraded"] : [])];
    const shadowMode = env.EVIDENCE_DISPOSITION_MODE === "shadow";
    const abstain = shadowMode ? legacyMissingEvidence.length > 0 || conflicts.length > 0 : disposition.abstention_recommended;
    const delivered = forPacking ? proposed : abstain ? [] : candidates;
    const deliveredIds = new Set(delivered.map(item => String(item.memory_id)));
    const states = currentState.filter(item => deliveredIds.has(String(item.memory_id)));
    const times = timeline.filter(item => deliveredIds.has(String(item.memory_id)));
    const receiptItems = delivered.map(item => ({ usage_item_id: receiptIds.get(String(item.memory_id))!,
      source_type: "memory", source_id: String(item.memory_id),
      source_version: selectedById.get(String(item.memory_id))?.current_version ?? null }));
    const response: RetrieveMemoryContextResponse = {
      ...search,
      results: delivered.map(item => {
        const result = selectedById.get(String(item.memory_id))!;
        return { kind: result.kind, id: result.id, score: result.score, memory_kind: result.memory_kind,
          lifecycle_state: result.lifecycle_state, current_version: result.current_version, source_references: result.source_references };
      }),
      meta: { ...search.meta,
        ...(search.meta.task_query ? { task_query: { ...search.meta.task_query,
          coverage: taskPlan && delivered.length && covered ? "covered" as const : "missing" as const } } : {}),
        returned_count: delivered.length,
        top_result_ids: delivered.map(item => String(item.memory_id)),
        top_result_ranks: delivered.map(item => typeof item.score === "number" ? item.score : null),
        task_id: taskId, usage_purpose: usagePurpose,
        usage_id: usageId, usage_item_ids: receiptItems.map(item => item.usage_item_id),
        usage_items: receiptItems, verification_sampled: sampled },
      evidence_bundle: {
        query_at: queryAt, token_budget: tokenBudget, estimated_tokens: 0,
        token_count_basis: "o200k_base_complete_mcp_text", budget_limited: budgetLimited,
        evidence_status: disposition.evidence_status,
        answer_template: abstain ? "abstention" : evidenceAnswerTemplate(disposition, {
          hasTimeline: times.length > 0, hasCurrentState: states.length > 0, requiresMultipleSources: multiSession }),
        evidence: delivered, current_state: states, timeline: times, conflicts,
        missing_evidence: [...new Set([...(shadowMode ? legacyMissingEvidence : disposition.missing_evidence),
          ...(!covered ? ["incomplete_question_coverage"] : []), ...(budgetLimited ? ["context_budget_exhausted"] : [])])],
        abstention_recommended: abstain, degraded_reasons: disposition.degraded_reasons,
        answer_guidance: answerGuidanceForDisposition(abstain ? { ...disposition,
          evidence_status: conflicts.length ? "conflicted" : "insufficient", abstention_recommended: true } : disposition,
          delivered.map(item => {
            const ref = (item.source_reference as { ref?: unknown } | null)?.ref;
            return typeof ref === "string" ? { ref } : null;
          }))
      }
    };
    return measureContextPayload(response, response.evidence_bundle);
  };
  // Pack the final envelope before writing usage. Preserve each excerpt with its
  // conditions and provenance; never count omitted candidates as injections.
  const deliveredCandidates: typeof evidence = [];
  for (const item of evidence) {
    if (countContextTokens(buildResponse([...deliveredCandidates, item], true)) <= tokenBudget) deliveredCandidates.push(item);
    else budgetLimited = true;
  }
  let response = buildResponse(deliveredCandidates);
  while (deliveredCandidates.length && countContextTokens(response) > tokenBudget) {
    deliveredCandidates.pop();
    budgetLimited = true;
    response = buildResponse(deliveredCandidates);
  }
  if (countContextTokens(response) > tokenBudget) {
    throw new HttpError(400, "context_budget_below_envelope", "token_budget cannot fit the complete context envelope");
  }
  await recordMemoryUsage(env, {
    id: usageId, tenant_id: tenantId,
    project_id: typeof body.project_id === "string" ? body.project_id : null,
    task_id: taskId, trace_id: traceId, external_run_id: externalRunId, usage_purpose: usagePurpose,
    capability: "memory_retrieve_context", access_path: "context", request_source: "api",
    requested_business_category_id: typeof body.business_category_id === "string" ? body.business_category_id : null,
    requested_work_type: typeof body.work_type === "string" ? body.work_type as MemoryWorkType : null,
    retrieval_generation_id: selectedGenerationId,
    ranking_profile_id: search.meta.retrieval?.ranking_profile_id ?? null,
    actor_principal: options.actorPrincipal ?? null,
    items: response.evidence_bundle.evidence.map((item, index) => ({
      id: receiptIds.get(String(item.memory_id)), source_type: "memory" as const,
      source_id: String(item.memory_id), source_version: selectedById.get(String(item.memory_id))?.current_version ?? null,
      rank: index + 1, score: typeof item.score === "number" ? item.score : null,
      reference_type: "injected" as const, used_state: "unknown" as const,
      injected_token_estimate: countContextTokens(item)
    }))
  });
  return response;
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
