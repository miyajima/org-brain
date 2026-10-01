import { MEMORY_JUDGMENT_MODEL, MEMORY_JUDGMENT_VERSION, MEMORY_JUDGMENT_THRESHOLDS,
  judgmentHash, memoryJudgmentPolicyHash } from "./memory-judgment-runtime.mjs";

export async function memoryCostConfigurationHash(stages, threshold = .95, resolvedModel = MEMORY_JUDGMENT_MODEL) {
  return judgmentHash({ objective: "cost", stages: [...new Set(stages)].sort(), resolved_model: resolvedModel,
    policy_hash: await memoryJudgmentPolicyHash(threshold, { objective: "cost" }) });
}

// Imported outcomes must already be bound to real artifacts and test receipts.
// Equal quality is sufficient; lower prompt size alone is not cost evidence.
export async function qualifyMemoryCostJudgment(manifest, observations) {
  const result = { schema: "memory-judgment-qualification/v2", objective: "cost", status: "inconclusive",
    policy_version: MEMORY_JUDGMENT_VERSION, model: MEMORY_JUDGMENT_MODEL, resolved_model: manifest?.resolved_model ?? null,
    threshold: manifest?.threshold, policy_hash: await memoryJudgmentPolicyHash(manifest?.threshold, { objective: "cost" }),
    configuration_hash: manifest?.configuration_hash ?? null, stages: [], evidence_kind: "verified_task_outcomes",
    manifest_hash: await judgmentHash(manifest), evidence_hash: await judgmentHash(observations), holdout_count: 0,
    jev_assumed_cost_usd: 0 };
  const fail = (reason) => ({ ...result, reason });
  const digest = (v) => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
  const finite = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (manifest?.schema !== "memory-judgment-experiment/v2" || manifest.objective !== "cost"
    || manifest.policy_version !== MEMORY_JUDGMENT_VERSION || manifest.model !== MEMORY_JUDGMENT_MODEL
    || !manifest.resolved_model || !MEMORY_JUDGMENT_THRESHOLDS.includes(manifest.threshold)
    || manifest.policy_hash !== result.policy_hash
    || ![manifest.dataset_hash, manifest.implementation_hash, manifest.runtime_hash, manifest.configuration_hash].every(digest)
    || !Array.isArray(manifest.stages) || !manifest.stages.length || new Set(manifest.stages).size !== manifest.stages.length
    || manifest.stages.some((s) => !["wiki", "capture", "use", "search"].includes(s))
    || manifest.configuration_hash !== await memoryCostConfigurationHash(manifest.stages, manifest.threshold, manifest.resolved_model)
    || !Array.isArray(manifest.holdout_cases) || !Array.isArray(observations)) return fail("invalid_manifest");
  if (!Array.isArray(manifest.dev_conversations) || !manifest.dev_conversations.length
    || !Array.isArray(manifest.holdout_conversations) || manifest.holdout_conversations.some((id) => manifest.dev_conversations.includes(id))
    || manifest.holdout_cases.some((c) => !c.id || !c.conversation_id || !manifest.holdout_conversations.includes(c.conversation_id))
    || new Set(manifest.holdout_cases.map((c) => c.id)).size !== manifest.holdout_cases.length) return fail("invalid_conversation_split");
  const groups = new Map();
  for (const item of observations) {
    if (item.split !== "holdout") continue;
    const cost = item.cost;
    if (!manifest.holdout_cases.some((c) => c.id === item.case_id && c.conversation_id === item.conversation_id)
      || !["baseline", "jev"].includes(item.arm) || typeof item.task_success !== "boolean"
      || ![item.false_application, item.required_memory_missing, item.critical_regressions].every((n) => Number.isInteger(n) && n >= 0)
      || item.verification?.verified !== true || !digest(item.verification.artifact_hash) || !digest(item.verification.test_hash)
      || !item.parent_model || !item.settings_hash || !item.start_state_hash || !item.budget_hash
      || item.configuration_hash !== manifest.configuration_hash || !item.parent_usage
      || ![item.parent_usage.input_tokens, item.parent_usage.cached_input_tokens, item.parent_usage.output_tokens, item.task_elapsed_ms].every(finite)
      || item.parent_usage.cached_input_tokens > item.parent_usage.input_tokens
      || !["provider", "price_snapshot"].includes(cost?.source) || cost.jev_assumed_usd !== 0
      || (cost.source === "price_snapshot" && !digest(cost.price_snapshot_hash))
      || ![cost.parent_usd, cost.fallback_usd, cost.review_usd, cost.rework_usd, cost.other_usd].every(finite)) {
      return fail("unverified_or_incomplete_outcome");
    }
    const group = groups.get(item.case_id) ?? [];
    if (group.some((other) => other.arm === item.arm)) return fail("duplicate_arm");
    group.push(item); groups.set(item.case_id, group);
  }
  const pairs = [...groups.values()];
  if (pairs.some((g) => g.length !== 2 || ["parent_model", "settings_hash", "start_state_hash", "budget_hash"]
    .some((key) => new Set(g.map((o) => o[key])).size !== 1)
    || g[0].cost.source !== g[1].cost.source || g[0].cost.price_snapshot_hash !== g[1].cost.price_snapshot_hash)) return fail("unmatched_conditions");
  result.holdout_count = new Set(pairs.map((g) => g[0].conversation_id)).size;
  if (result.holdout_count < 20 || groups.size !== manifest.holdout_cases.length) return fail("insufficient_holdout");
  const get = (pair, arm) => pair.find((item) => item.arm === arm);
  const total = (o) => [o.cost.parent_usd, o.cost.fallback_usd, o.cost.review_usd, o.cost.rework_usd, o.cost.other_usd].reduce((a, b) => a + b, 0);
  result.task_success_improvement = pairs.reduce((n, p) => n + Number(get(p, "jev").task_success) - Number(get(p, "baseline").task_success), 0) / pairs.length;
  result.false_application_regression = pairs.reduce((n, p) => n + get(p, "jev").false_application - get(p, "baseline").false_application, 0);
  result.required_memory_loss_regression = pairs.reduce((n, p) => n + get(p, "jev").required_memory_missing - get(p, "baseline").required_memory_missing, 0);
  result.critical_regressions = pairs.reduce((n, p) => n + get(p, "jev").critical_regressions, 0);
  result.baseline_cost_usd = pairs.reduce((n, p) => n + total(get(p, "baseline")), 0);
  result.jev_configuration_cost_usd = pairs.reduce((n, p) => n + total(get(p, "jev")), 0);
  result.cost_savings_usd = result.baseline_cost_usd - result.jev_configuration_cost_usd;
  const deltas = pairs.map((p) => get(p, "jev").task_elapsed_ms - get(p, "baseline").task_elapsed_ms).sort((a, b) => a - b);
  result.added_latency_p95_ms = deltas[Math.ceil(deltas.length * .95) - 1];
  if (pairs.some((p) => {
    const base = get(p, "baseline"), proposed = get(p, "jev");
    return (base.task_success && !proposed.task_success) || proposed.false_application > base.false_application
      || proposed.required_memory_missing > 0 || proposed.critical_regressions > 0;
  })) return fail("quality_regression");
  if (!(result.cost_savings_usd > 0)) return fail("cost_reduction_not_demonstrated");
  if (result.added_latency_p95_ms > 5_000) return fail("latency_budget_exceeded");
  return { ...result, status: "passed", stages: [...manifest.stages], reason: null };
}
