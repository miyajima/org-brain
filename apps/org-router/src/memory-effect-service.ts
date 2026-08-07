import {
  memoryImpactUtcDay,
  rebuildMemoryImpactMetricsForDay,
  resolveMemoryTokenEstimate,
  validateAvoidedLookupCategories,
  ulid,
  type TaskResultPayload
} from "@org-brain/shared";
import type { Env } from "./types";

type TaskMemoryEffect = NonNullable<TaskResultPayload["memory_effect"]>;

function median(values: number[]) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

export async function recordTaskMemoryEffect(
  env: Env,
  tenantId: string,
  body: TaskMemoryEffect
) {
  const avoided = validateAvoidedLookupCategories(body.avoided_lookup_categories ?? []);
  const existing = await env.OPEN_BRAIN_DB.prepare(
    `SELECT e.id, u.created_at AS usage_created_at
     FROM memory_effect_events e
     JOIN memory_usage_events u ON u.tenant_id = e.tenant_id AND u.id = e.usage_event_id
     WHERE e.tenant_id = ? AND e.idempotency_key = ?`
  ).bind(tenantId, body.idempotency_key).first<{ id: string; usage_created_at: number }>();
  if (existing) {
    await rebuildMemoryImpactMetricsForDay(
      env.OPEN_BRAIN_DB,
      memoryImpactUtcDay(Number(existing.usage_created_at))
    );
    return { effect_id: existing.id, created: false };
  }
  const usage = await env.OPEN_BRAIN_DB.prepare(
    "SELECT id, created_at FROM memory_usage_events WHERE tenant_id = ? AND id = ?"
  ).bind(tenantId, body.usage_event_id).first<{ id: string; created_at: number }>();
  if (!usage) throw new Error("memory_usage_event_not_found");
  if (body.supersedes_effect_id) {
    const superseded = await env.OPEN_BRAIN_DB.prepare(
      `SELECT id FROM memory_effect_events
       WHERE tenant_id = ? AND usage_event_id = ? AND id = ?`
    ).bind(tenantId, body.usage_event_id, body.supersedes_effect_id).first<{ id: string }>();
    if (!superseded) throw new Error("invalid_supersedes_effect_id");
  }
  const currentEffect = await env.OPEN_BRAIN_DB.prepare(
    `SELECT e.id FROM memory_effect_events e
     WHERE e.tenant_id = ? AND e.usage_event_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM memory_effect_events child
         WHERE child.tenant_id = e.tenant_id AND child.supersedes_effect_id = e.id
       )
     ORDER BY e.created_at DESC, e.id DESC LIMIT 1`
  ).bind(tenantId, body.usage_event_id).first<{ id: string }>();
  if (currentEffect && body.supersedes_effect_id !== currentEffect.id) throw new Error("effect_supersedes_latest_required");
  if (!currentEffect && body.supersedes_effect_id) throw new Error("effect_supersedes_latest_required");
  if (body.failure_pattern_id) {
    const pattern = await env.OPEN_BRAIN_DB.prepare(
      "SELECT id FROM memory_failure_patterns WHERE tenant_id = ? AND id = ? AND is_active = 1"
    ).bind(tenantId, body.failure_pattern_id).first<{ id: string }>();
    if (!pattern) throw new Error("invalid_failure_pattern_id");
  }
  if (body.failure_opportunity_state === "applicable" && !body.failure_pattern_id) {
    throw new Error("failure_pattern_id_required");
  }
  if (body.evidence_level === "verified" && !(body.verification_ref_type && body.verification_ref_id)) {
    throw new Error("verification_reference_required");
  }
  const usageItems = (await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, source_type, source_id, business_category_id_snapshot, injected_token_estimate
     FROM memory_usage_items WHERE tenant_id = ? AND usage_event_id = ? ORDER BY rank, id`
  ).bind(tenantId, body.usage_event_id).all<{
    id: string; source_type: "memory" | "decision_memory"; source_id: string;
    business_category_id_snapshot: string | null; injected_token_estimate: number;
  }>()).results;
  if (!usageItems.length) throw new Error("memory_usage_items_required");
  const opportunity = body.failure_opportunity_state ?? "unknown";
  if (
    body.failure_avoided &&
    !(opportunity === "applicable" && body.action_changed && body.alternative_executed)
  ) {
    throw new Error("invalid_failure_avoidance_evidence");
  }
  const usageItemIds = new Set(usageItems.map((item) => item.id));
  const requestedWeights = new Map<string, number>();
  for (const attribution of body.attributions ?? []) {
    if (!usageItemIds.has(attribution.usage_item_id)) throw new Error("invalid_usage_item_attribution");
    if (!Number.isFinite(attribution.attribution_weight) || attribution.attribution_weight <= 0 || attribution.attribution_weight > 1) {
      throw new Error("invalid_attribution_weight");
    }
    requestedWeights.set(attribution.usage_item_id, attribution.attribution_weight);
  }
  const attributions = usageItems.map((item) => ({
    usage_item_id: item.id,
    attribution_weight: requestedWeights.size
      ? requestedWeights.get(item.id) ?? 0
      : 1 / usageItems.length
  })).filter((item) => item.attribution_weight > 0);
  const weightTotal = attributions.reduce((sum, item) => sum + item.attribution_weight, 0);
  if (Math.abs(weightTotal - 1) > 0.000001) throw new Error("attribution_weights_must_sum_to_one");
  const estimationCandidates = body.token_estimation_candidates
    ? { ...body.token_estimation_candidates }
    : {};
  if (body.gross_saved_tokens_estimate === undefined) {
    let sourceCharacters = 0;
    for (const item of usageItems) {
      const row = item.source_type === "memory"
        ? await env.OPEN_BRAIN_DB.prepare(
          "SELECT length(content) AS chars FROM memories WHERE tenant_id = ? AND id = ?"
        ).bind(tenantId, item.source_id).first<{ chars: number }>()
        : await env.OPEN_BRAIN_DB.prepare(
          `SELECT length(title || char(10) || decision || char(10) || rationale || char(10) || constraints_json || char(10) || known_pitfalls_json) AS chars
           FROM decision_memories WHERE tenant_id = ? AND id = ?`
        ).bind(tenantId, item.source_id).first<{ chars: number }>();
      sourceCharacters += Math.max(0, Number(row?.chars ?? 0));
    }
    const sourceTokens = Math.max(1, Math.ceil(sourceCharacters / 4));
    estimationCandidates.text_size_heuristic_tokens ??= sourceTokens;
    if (avoided.some((category) => category === "source_search" || category === "past_context")) {
      estimationCandidates.avoided_source_tokens ??= sourceTokens;
    }
    if (body.failure_pattern_id && estimationCandidates.failure_pattern_median_tokens === undefined) {
      const rows = (await env.OPEN_BRAIN_DB.prepare(
        `SELECT e.gross_saved_tokens_estimate AS value FROM memory_effect_events e
         WHERE e.tenant_id = ? AND e.failure_pattern_id = ? AND e.evidence_level IN ('estimated', 'verified')
           AND NOT EXISTS (
             SELECT 1 FROM memory_effect_events child
             WHERE child.tenant_id = e.tenant_id AND child.supersedes_effect_id = e.id
           )
         ORDER BY e.created_at DESC LIMIT 101`
      ).bind(tenantId, body.failure_pattern_id).all<{ value: number }>()).results;
      const value = median(rows.map((row) => Number(row.value)).filter(Number.isFinite));
      if (value !== undefined) estimationCandidates.failure_pattern_median_tokens = value;
    }
    const categories = [...new Set(usageItems.map((item) => item.business_category_id_snapshot).filter(Boolean))] as string[];
    if (categories.length && estimationCandidates.category_median_tokens === undefined) {
      const rows = (await env.OPEN_BRAIN_DB.prepare(
        `SELECT ea.gross_saved_tokens AS value FROM memory_effect_attributions ea
         JOIN memory_effect_events e ON e.tenant_id = ea.tenant_id AND e.id = ea.effect_event_id
         JOIN memory_usage_items ui ON ui.tenant_id = ea.tenant_id AND ui.id = ea.usage_item_id
         WHERE ea.tenant_id = ? AND e.evidence_level IN ('estimated', 'verified')
           AND ui.business_category_id_snapshot IN (${categories.map(() => "?").join(",")})
           AND NOT EXISTS (
             SELECT 1 FROM memory_effect_events child
             WHERE child.tenant_id = e.tenant_id AND child.supersedes_effect_id = e.id
           )
         ORDER BY ea.created_at DESC LIMIT 101`
      ).bind(tenantId, ...categories).all<{ value: number }>()).results;
      const value = median(rows.map((row) => Number(row.value)).filter(Number.isFinite));
      if (value !== undefined) estimationCandidates.category_median_tokens = value;
    }
  }
  const tokenEstimate = resolveMemoryTokenEstimate({ ...body, token_estimation_candidates: estimationCandidates });
  const gross = tokenEstimate.gross_saved_tokens_estimate;
  const attributedItemIds = new Set(attributions.map((attribution) => attribution.usage_item_id));
  const derivedInjected = usageItems
    .filter((item) => attributedItemIds.has(item.id))
    .reduce((sum, item) => sum + Math.max(0, Number(item.injected_token_estimate ?? 0)), 0);
  const injected = Math.max(0, Math.round(body.injected_tokens ?? derivedInjected));
  const net = gross - injected;
  if (body.net_saved_tokens_estimate !== undefined && Math.round(body.net_saved_tokens_estimate) !== net) {
    throw new Error("net_saved_tokens_mismatch");
  }
  const failureSaved = Math.round(body.failure_saved_tokens_estimate ?? 0);
  if (failureSaved !== 0 && !body.failure_avoided) throw new Error("failure_saved_tokens_without_avoidance");
  if (![gross, injected, net, failureSaved].every(Number.isFinite)) throw new Error("invalid_token_estimate");
  const effectId = ulid();
  const now = Date.now();
  const statements: D1PreparedStatement[] = [env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO memory_effect_events(
       id, tenant_id, usage_event_id, idempotency_key, evidence_level,
       supersedes_effect_id, effect_outcome, avoided_lookup_categories_json,
       gross_saved_tokens_estimate, injected_tokens, net_saved_tokens_estimate,
       estimate_lower_bound, estimate_upper_bound, estimation_method,
       estimator_version, estimate_confidence, failure_pattern_id,
       failure_opportunity_state, action_changed, alternative_executed,
       failure_avoided, failure_saved_tokens_estimate, verification_ref_type,
       verification_ref_id, estimated_tool_calls_saved, estimated_seconds_saved,
       created_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    effectId, tenantId, body.usage_event_id, body.idempotency_key,
    body.evidence_level ?? "reported", body.supersedes_effect_id ?? null,
    body.effect_outcome, JSON.stringify(avoided), gross, injected, net,
    body.estimate_lower_bound ?? null, body.estimate_upper_bound ?? null,
    tokenEstimate.estimation_method, body.estimator_version ?? null,
    body.estimate_confidence ?? null, body.failure_pattern_id ?? null, opportunity,
    body.action_changed ? 1 : 0, body.alternative_executed ? 1 : 0,
    body.failure_avoided ? 1 : 0, failureSaved,
    body.verification_ref_type ?? null, body.verification_ref_id ?? null,
    body.estimated_tool_calls_saved ?? null, body.estimated_seconds_saved ?? null, now
  )];
  let allocatedGross = 0;
  let allocatedNet = 0;
  let allocatedFailure = 0;
  attributions.forEach((attribution, index) => {
    const last = index === attributions.length - 1;
    const attributedGross = last ? gross - allocatedGross : Math.round(gross * attribution.attribution_weight);
    const attributedNet = last ? net - allocatedNet : Math.round(net * attribution.attribution_weight);
    const attributedFailure = last ? failureSaved - allocatedFailure : Math.round(failureSaved * attribution.attribution_weight);
    allocatedGross += attributedGross;
    allocatedNet += attributedNet;
    allocatedFailure += attributedFailure;
    statements.push(env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO memory_effect_attributions(
         id, tenant_id, effect_event_id, usage_item_id, attribution_weight,
         gross_saved_tokens, net_saved_tokens, failure_saved_tokens, created_at
       ) VALUES(?,?,?,?,?,?,?,?,?)`
    ).bind(ulid(), tenantId, effectId, attribution.usage_item_id,
      attribution.attribution_weight, attributedGross, attributedNet,
      attributedFailure, now));
  });
  if (body.supersedes_effect_id) {
    statements.push(env.OPEN_BRAIN_DB.prepare(
      `UPDATE memory_usage_items SET used_state = 'unknown', used_state_source = 'reported'
       WHERE tenant_id = ? AND usage_event_id = ? AND used_state_source = 'effect'
         AND id IN (
           SELECT usage_item_id FROM memory_effect_attributions
           WHERE tenant_id = ? AND effect_event_id = ?
         )`
    ).bind(tenantId, body.usage_event_id, tenantId, body.supersedes_effect_id));
  }
  if (body.effect_outcome !== "unknown") {
    const attributedItemIds = attributions.map((attribution) => attribution.usage_item_id);
    statements.push(env.OPEN_BRAIN_DB.prepare(
      `UPDATE memory_usage_items SET used_state = 'used', used_state_source = 'effect'
       WHERE tenant_id = ? AND usage_event_id = ?
         AND (used_state_source = 'effect' OR used_state = 'unknown')
         AND id IN (${attributedItemIds.map(() => "?").join(",")})`
    ).bind(tenantId, body.usage_event_id, ...attributedItemIds));
  }
  await env.OPEN_BRAIN_DB.batch(statements);
  await rebuildMemoryImpactMetricsForDay(
    env.OPEN_BRAIN_DB,
    memoryImpactUtcDay(Number(usage.created_at ?? now))
  );
  return { effect_id: effectId, created: true, net_saved_tokens_estimate: net };
}
