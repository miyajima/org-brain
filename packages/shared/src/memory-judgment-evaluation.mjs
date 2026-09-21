import { MEMORY_JUDGMENT_MODEL, MEMORY_JUDGMENT_THRESHOLDS, MEMORY_JUDGMENT_VERSION, decideMemoryCandidate, judgmentHash, memoryJudgmentPolicyHash } from "./memory-judgment-runtime.mjs";

export const MEMORY_JUDGMENT_ARMS = ["no_memory", "baseline", "capture_only", "use_only", "both"];

export function validateJudgmentDataset(dataset) {
  if (dataset?.schema !== "memory-judgment-dataset/v1" || !Array.isArray(dataset.cases) || !dataset.cases.length) throw new Error("invalid_dataset");
  const ids = new Set();
  const conversations = new Map();
  for (const item of dataset.cases) {
    if (!item.id || ids.has(item.id) || !item.conversation_id || !["dev", "holdout"].includes(item.split) || !Array.isArray(item.candidates)) throw new Error("invalid_case");
    ids.add(item.id);
    const previous = conversations.get(item.conversation_id);
    if (previous && previous !== item.split) throw new Error("conversation_split_leak");
    conversations.set(item.conversation_id, item.split);
    if (new Set(item.candidates.map((c) => c.id)).size !== item.candidates.length) throw new Error("duplicate_candidate_id");
  }
  if (!dataset.cases.some((c) => c.split === "dev") || !dataset.cases.some((c) => c.split === "holdout")) throw new Error("both_splits_required");
  return dataset;
}

// Calibration accepts development judgments only; holdout is never consulted.
// These are selection labels, not observed task-success/usefulness labels.
export function calibrateMemoryJudgment(examples) {
  if (!examples.length || examples.some((example) => example.split !== "dev")) throw new Error("development_data_required");
  const rows = MEMORY_JUDGMENT_THRESHOLDS.map((threshold) => {
    let requiredLoss = 0, falseApplication = 0, reviews = 0;
    for (const example of examples) {
      const decision = decideMemoryCandidate(example.stage, example.candidate, example.scores, threshold);
      if (example.required && decision.action === "omit") requiredLoss++;
      if (example.forbidden && decision.action === "retain") falseApplication++;
      if (decision.requires_review) reviews++;
    }
    return { threshold, required_loss: requiredLoss, predicted_false_application: falseApplication, reviews };
  });
  const passing = rows.filter((r) => r.required_loss === 0).sort((a, b) => a.predicted_false_application - b.predicted_false_application || b.reviews - a.reviews || b.threshold - a.threshold);
  return { status: passing.length ? "calibrated" : "inconclusive", threshold: passing[0]?.threshold ?? 0.98, rows };
}

export async function replayMemoryJudgmentCase(item, judge, threshold) {
  const context = { ...(item.context ?? {}), project_id: item.project_id, query: item.query };
  const judgments = [];
  const select = async (stage, candidates) => {
    const result = await judge({ stage, context: stage === "capture" ? { project_id: item.project_id, ...(item.capture_context ?? {}), purpose: "Future reuse within the project" } : context,
      candidates, policy: { mode: "shadow", threshold } });
    judgments.push(result);
    // Offline projection only. This never activates a runtime policy or writes memory.
    if (result.status !== "judged") return candidates;
    return candidates.filter((c) => result.decisions.find((d) => d.id === c.id)?.action !== "omit");
  };
  const capture = await select("capture", item.candidates);
  const use = await select("use", item.candidates);
  const both = await select("use", capture);
  const groups = { no_memory: [], baseline: item.candidates, capture_only: capture, use_only: use, both };
  const rows = MEMORY_JUDGMENT_ARMS.map((arm) => {
    const selected = groups[arm].slice(0, item.top_k ?? 5);
    const ids = selected.map((c) => c.id);
    return { case_id: item.id, conversation_id: item.conversation_id, split: item.split, arm,
      selected_ids: ids, selected_characters: selected.reduce((n, c) => n + JSON.stringify(c).length, 0),
      required_memory_missing: (item.required_ids ?? []).filter((id) => !ids.includes(id)).length,
      irrelevant_memory_included: (item.forbidden_ids ?? []).filter((id) => ids.includes(id)).length,
      upstream_missing: (item.required_ids ?? []).filter((id) => !item.candidates.some((c) => c.id === id)).length,
      task_success: null, parent_usage: null, task_elapsed_ms: null, false_application: null };
  });
  return { rows, judgments };
}

// Only externally verified, paired task outcomes can qualify activation.
// The replay evaluator deliberately cannot manufacture these observations.
export async function qualifyMemoryJudgment(manifest, observations) {
  const common = { schema: "memory-judgment-qualification/v1", status: "inconclusive", policy_version: MEMORY_JUDGMENT_VERSION,
    model: MEMORY_JUDGMENT_MODEL, threshold: manifest?.threshold, policy_hash: await memoryJudgmentPolicyHash(manifest?.threshold), stages: [], evidence_kind: "verified_task_outcomes",
    manifest_hash: await judgmentHash(manifest), evidence_hash: await judgmentHash(observations), holdout_count: 0 };
  if (manifest?.schema !== "memory-judgment-experiment/v1" || manifest.policy_version !== MEMORY_JUDGMENT_VERSION || manifest.model !== MEMORY_JUDGMENT_MODEL
    || !MEMORY_JUDGMENT_THRESHOLDS.includes(manifest.threshold) || !/^[a-f0-9]{64}$/u.test(manifest.dataset_hash ?? "")
    || manifest.policy_hash !== common.policy_hash || !Array.isArray(manifest.holdout_cases)
    || !/^[a-f0-9]{64}$/u.test(manifest.implementation_hash ?? "")
    || !/^[a-f0-9]{64}$/u.test(manifest.runtime_hash ?? "") || !Array.isArray(observations)) return { ...common, reason: "invalid_manifest" };
  if (!Array.isArray(manifest.dev_conversations) || !manifest.dev_conversations.length || !Array.isArray(manifest.holdout_conversations)
    || manifest.holdout_conversations.some((id) => manifest.dev_conversations.includes(id))
    || manifest.holdout_cases.some((c) => !manifest.holdout_conversations.includes(c.conversation_id))
    || new Set(manifest.holdout_cases.map((c) => c.id)).size !== manifest.holdout_cases.length) return { ...common, reason: "invalid_conversation_split" };
  const groups = new Map();
  for (const item of observations) {
    if (item.split !== "holdout") continue;
    if (!manifest.holdout_cases.some((c) => c.id === item.case_id && c.conversation_id === item.conversation_id)
      || !item.case_id || !MEMORY_JUDGMENT_ARMS.includes(item.arm) || typeof item.task_success !== "boolean"
      || ![item.false_application, item.required_memory_missing, item.critical_regressions].every((n) => Number.isInteger(n) && n >= 0)
      || !item.verification?.artifact_hash || !item.verification?.test_hash || item.verification?.verified !== true
      || !item.parent_model || !item.settings_hash || !item.start_state_hash || !item.budget_hash
      || !item.parent_usage || ![item.parent_usage.input_tokens, item.parent_usage.cached_input_tokens, item.parent_usage.output_tokens, item.task_elapsed_ms].every((n) => Number.isFinite(n) && n >= 0)) {
      return { ...common, reason: "unverified_or_incomplete_outcome" };
    }
    const group = groups.get(item.case_id) ?? [];
    if (group.some((other) => other.arm === item.arm)) return { ...common, reason: "duplicate_arm" };
    group.push(item); groups.set(item.case_id, group);
  }
  for (const group of groups.values()) {
    if (group.length !== MEMORY_JUDGMENT_ARMS.length || ["parent_model", "settings_hash", "start_state_hash", "budget_hash"].some((key) => new Set(group.map((o) => o[key])).size !== 1)) return { ...common, reason: "unmatched_conditions" };
  }
  common.holdout_count = new Set([...groups.values()].map((g) => g[0].conversation_id)).size;
  if (common.holdout_count < 20 || groups.size !== manifest.holdout_cases.length) return { ...common, reason: "insufficient_holdout" };
  const sum = (arm, field) => [...groups.values()].reduce((total, group) => total + Number(group.find((o) => o.arm === arm)[field]), 0);
  const comparisons = {};
  for (const arm of ["capture_only", "use_only", "both"]) {
    comparisons[arm] = {
      task_success_improvement: (sum(arm, "task_success") - sum("baseline", "task_success")) / groups.size,
      false_application_regression: sum(arm, "false_application") - sum("baseline", "false_application"),
      required_memory_loss_regression: sum(arm, "required_memory_missing") - sum("baseline", "required_memory_missing"),
      critical_regressions: sum(arm, "critical_regressions")
    };
    comparisons[arm].passed = comparisons[arm].task_success_improvement > 0 && comparisons[arm].false_application_regression <= 0
      && comparisons[arm].required_memory_loss_regression <= 0 && comparisons[arm].critical_regressions === 0;
  }
  // A stage can be enabled alone only if its isolated comparison passes.
  const stages = [comparisons.capture_only.passed ? "capture" : null, comparisons.use_only.passed ? "use" : null].filter(Boolean);
  if (stages.length === 2 && !comparisons.both.passed) return { ...common, comparisons, reason: "combined_regression" };
  const selected = stages.length === 2 ? comparisons.both : stages[0] === "capture" ? comparisons.capture_only : comparisons.use_only;
  return { ...common, ...selected, comparisons, stages, status: stages.length ? "passed" : "inconclusive", reason: stages.length ? null : "improvement_not_demonstrated" };
}
