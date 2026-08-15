import { createHash } from "node:crypto";

export const AUTONOMY_POLICY_SCHEMA_VERSION = 1;
export const AUTONOMY_MODES = Object.freeze(["shadow", "guarded", "autonomous"]);
export const AUTONOMY_PROFILES = Object.freeze(["conservative", "balanced", "aggressive"]);
export const JUDGE_EXECUTIONS = Object.freeze(["managed", "local", "deny"]);
export const RISK_TIERS = Object.freeze([0, 1, 2]);

const PROFILE_DEFAULTS = Object.freeze({
  conservative: Object.freeze({ minimum_confidence: 0.995, max_mutation_ratio_per_run: 0.01, max_mutations_per_run: 25 }),
  balanced: Object.freeze({ minimum_confidence: 0.98, max_mutation_ratio_per_run: 0.05, max_mutations_per_run: 100 }),
  aggressive: Object.freeze({ minimum_confidence: 0.95, max_mutation_ratio_per_run: 0.1, max_mutations_per_run: 250 })
});

export const DEFAULT_AUTONOMY_POLICY = Object.freeze({
  schema_version: AUTONOMY_POLICY_SCHEMA_VERSION,
  mode: "shadow",
  target_mode: "autonomous",
  auto_advance: true,
  profile: "balanced",
  judge: Object.freeze({
    execution: "managed",
    strategy: "risk_tiered",
    active_consensus: 3,
    minimum_model_families: 2,
    minimum_confidence: 0.98
  }),
  quarantine: Object.freeze({ reevaluate_interval_hours: 24, expire_after_days: 180 }),
  maintenance: Object.freeze({
    auto_apply: true,
    max_mutation_ratio_per_run: 0.05,
    max_mutations_per_run: 100,
    physical_delete: "retention_policy_only"
  }),
  tuning: Object.freeze({
    enabled: true,
    maximum_threshold_delta_per_week: 0.01,
    minimum_confidence_bound: 0.95,
    maximum_confidence_bound: 0.995
  }),
  rollback: Object.freeze({ automatic: true, hard_violation_limit: 0, retrieval_coverage_minimum: 0.98 })
});

function numberInRange(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function integerInRange(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function normalizeAutonomyPolicy(raw = {}, options = {}) {
  if (raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
    throw new Error("autonomy must be an object");
  }
  const input = raw ?? {};
  const profile = AUTONOMY_PROFILES.includes(input.profile) ? input.profile : (options.profile ?? DEFAULT_AUTONOMY_POLICY.profile);
  const profileDefaults = PROFILE_DEFAULTS[profile];
  const mode = AUTONOMY_MODES.includes(input.mode) ? input.mode : DEFAULT_AUTONOMY_POLICY.mode;
  const targetMode = AUTONOMY_MODES.includes(input.target_mode) ? input.target_mode : DEFAULT_AUTONOMY_POLICY.target_mode;
  const judgeInput = input.judge && typeof input.judge === "object" ? input.judge : {};
  const quarantineInput = input.quarantine && typeof input.quarantine === "object" ? input.quarantine : {};
  const maintenanceInput = input.maintenance && typeof input.maintenance === "object" ? input.maintenance : {};
  const tuningInput = input.tuning && typeof input.tuning === "object" ? input.tuning : {};
  const rollbackInput = input.rollback && typeof input.rollback === "object" ? input.rollback : {};
  const minimumConfidence = numberInRange(
    judgeInput.minimum_confidence,
    profileDefaults.minimum_confidence,
    0.95,
    0.995
  );
  const policy = {
    schema_version: AUTONOMY_POLICY_SCHEMA_VERSION,
    mode,
    target_mode: targetMode,
    auto_advance: input.auto_advance !== false,
    profile,
    judge: {
      execution: JUDGE_EXECUTIONS.includes(judgeInput.execution) ? judgeInput.execution : DEFAULT_AUTONOMY_POLICY.judge.execution,
      strategy: judgeInput.strategy === "risk_tiered" ? "risk_tiered" : DEFAULT_AUTONOMY_POLICY.judge.strategy,
      active_consensus: integerInRange(judgeInput.active_consensus, DEFAULT_AUTONOMY_POLICY.judge.active_consensus, 1, 5),
      minimum_model_families: integerInRange(judgeInput.minimum_model_families, DEFAULT_AUTONOMY_POLICY.judge.minimum_model_families, 1, 5),
      minimum_confidence: minimumConfidence
    },
    quarantine: {
      reevaluate_interval_hours: integerInRange(quarantineInput.reevaluate_interval_hours, DEFAULT_AUTONOMY_POLICY.quarantine.reevaluate_interval_hours, 1, 24 * 30),
      expire_after_days: integerInRange(quarantineInput.expire_after_days, DEFAULT_AUTONOMY_POLICY.quarantine.expire_after_days, 1, 3650)
    },
    maintenance: {
      auto_apply: maintenanceInput.auto_apply !== false,
      max_mutation_ratio_per_run: numberInRange(maintenanceInput.max_mutation_ratio_per_run, profileDefaults.max_mutation_ratio_per_run, 0.001, 1),
      max_mutations_per_run: integerInRange(maintenanceInput.max_mutations_per_run, profileDefaults.max_mutations_per_run, 1, 10000),
      physical_delete: maintenanceInput.physical_delete === "retention_policy_only" ? "retention_policy_only" : "retention_policy_only"
    },
    tuning: {
      enabled: tuningInput.enabled !== false,
      maximum_threshold_delta_per_week: numberInRange(tuningInput.maximum_threshold_delta_per_week, DEFAULT_AUTONOMY_POLICY.tuning.maximum_threshold_delta_per_week, 0, 0.1),
      minimum_confidence_bound: numberInRange(tuningInput.minimum_confidence_bound, DEFAULT_AUTONOMY_POLICY.tuning.minimum_confidence_bound, 0.95, 0.995),
      maximum_confidence_bound: numberInRange(tuningInput.maximum_confidence_bound, DEFAULT_AUTONOMY_POLICY.tuning.maximum_confidence_bound, 0.95, 0.995)
    },
    rollback: {
      automatic: rollbackInput.automatic !== false,
      hard_violation_limit: 0,
      retrieval_coverage_minimum: numberInRange(rollbackInput.retrieval_coverage_minimum, DEFAULT_AUTONOMY_POLICY.rollback.retrieval_coverage_minimum, 0.98, 1)
    }
  };
  if (policy.tuning.minimum_confidence_bound > policy.tuning.maximum_confidence_bound) {
    throw new Error("autonomy tuning confidence bounds are inverted");
  }
  return policy;
}

export function autonomyPolicyHash(policy) {
  const normalized = normalizeAutonomyPolicy(policy);
  return `sha256:${createHash("sha256").update(JSON.stringify(normalized), "utf8").digest("hex")}`;
}

export function classifyAutonomyRisk(action) {
  const value = String(action ?? "").trim().toLowerCase();
  if (["index_rebuild", "expiry_check", "retention_delete", "exact_duplicate_suppress"].includes(value)) return 0;
  if (["digest", "summary_revise", "suppress", "restore", "quarantine_expire"].includes(value)) return 1;
  return 2;
}

function normalizeJudgment(judgment) {
  const support = judgment?.support_selector ?? judgment?.support;
  return {
    judge_name: String(judgment?.judge_name ?? judgment?.profile_id ?? ""),
    model_family: String(judgment?.model_family ?? ""),
    model_version: String(judgment?.model_version ?? ""),
    verdict: String(judgment?.verdict ?? judgment?.route ?? ""),
    confidence: Number(judgment?.confidence),
    prompt_hash: String(judgment?.prompt_hash ?? ""),
    candidate_hash: String(judgment?.candidate_hash ?? ""),
    signature: String(judgment?.signature ?? ""),
    public_key_fingerprint: String(judgment?.public_key_fingerprint ?? ""),
    support_selector: Array.isArray(support) ? support.map(String).slice(0, 16) : [],
    support_selector_present: Array.isArray(support),
    reason_codes: Array.isArray(judgment?.reason_codes) ? [...new Set(judgment.reason_codes.map(String))].sort() : []
  };
}

export function evaluateAutonomyConsensus(judgments = [], options = {}) {
  const required = integerInRange(options.requiredJudges, 3, 1, 5);
  const minimumFamilies = integerInRange(options.minimumModelFamilies, 2, 1, 5);
  const minimumConfidence = numberInRange(options.minimumConfidence, 0.98, 0.95, 0.995);
  const requireSignatures = options.requireSignatures === true;
  const rows = (Array.isArray(judgments) ? judgments : []).map(normalizeJudgment);
  const names = new Set(rows.map((row) => row.judge_name).filter(Boolean));
  const families = new Set(rows.map((row) => row.model_family).filter(Boolean));
  const valid = rows.length === required && names.size === required && families.size >= minimumFamilies && rows.every((row) =>
    ["pass", "fail", "quarantine"].includes(row.verdict) && Number.isFinite(row.confidence) && row.confidence >= minimumConfidence && row.model_version && row.prompt_hash &&
    (!requireSignatures || (row.candidate_hash && row.signature && row.public_key_fingerprint && row.support_selector_present))
  );
  if (!valid) return { status: "insufficient_evidence", pass: false, active: false, quarantine: true, judgments: rows, required_judges: required, model_families: families.size };
  const unanimousPass = rows.every((row) => row.verdict === "pass");
  const unanimousFail = rows.every((row) => row.verdict === "fail");
  return {
    status: unanimousPass ? "certified" : unanimousFail ? "rejected" : "quarantine",
    pass: unanimousPass,
    active: unanimousPass,
    quarantine: !unanimousPass && !unanimousFail,
    rejected: unanimousFail,
    judgments: rows,
    required_judges: required,
    model_families: families.size
  };
}

export function decideAutonomyAction({ action, deterministic = {}, judgments = [], policy = DEFAULT_AUTONOMY_POLICY, candidate = {} } = {}) {
  const normalized = normalizeAutonomyPolicy(policy);
  const riskTier = classifyAutonomyRisk(action);
  const hardGuardrails = Array.isArray(deterministic.hard_guardrails) ? deterministic.hard_guardrails.filter(Boolean) : [];
  if (hardGuardrails.length > normalized.rollback.hard_violation_limit) {
    return { action: "quarantine", risk_tier: riskTier, reason_codes: ["hard_guardrail_violation"], hard_guardrails: hardGuardrails };
  }
  if (normalized.maintenance.auto_apply === false) {
    return { action: "shadow", risk_tier: riskTier, reason_codes: ["autonomy_auto_apply_disabled"], hard_guardrails: [] };
  }
  if (riskTier === 0) return { action: "apply", risk_tier: riskTier, reason_codes: [], hard_guardrails: [] };
  if (normalized.mode === "shadow") {
    return { action: "shadow", risk_tier: riskTier, reason_codes: ["autonomy_shadow_mode"], hard_guardrails: [] };
  }
  if (normalized.judge.execution === "deny") {
    return { action: "quarantine", risk_tier: riskTier, reason_codes: ["judge_execution_denied"], hard_guardrails: [] };
  }
  if (deterministic.passed !== true) {
    return { action: "quarantine", risk_tier: riskTier, reason_codes: ["deterministic_verification_failed"], hard_guardrails: [] };
  }
  const consensus = evaluateAutonomyConsensus(judgments, {
    requiredJudges: normalized.judge.active_consensus,
    minimumModelFamilies: normalized.judge.minimum_model_families,
    minimumConfidence: normalized.judge.minimum_confidence
  });
  if (riskTier >= 1 && consensus.pass && candidate.route !== "excluded") {
    return { action: "apply", risk_tier: riskTier, reason_codes: [], hard_guardrails: [], consensus };
  }
  return { action: "quarantine", risk_tier: riskTier, reason_codes: ["ai_consensus_required"], hard_guardrails: [], consensus };
}

export function buildQuarantineCandidate(candidate, policy = DEFAULT_AUTONOMY_POLICY, now = Date.now()) {
  const normalized = normalizeAutonomyPolicy(policy);
  const sourceHash = String(candidate?.candidate_hash ?? candidate?.external_key ?? candidate?.id ?? "");
  const nextEvaluationAt = now + normalized.quarantine.reevaluate_interval_hours * 60 * 60 * 1000;
  const expiresAt = now + normalized.quarantine.expire_after_days * 24 * 60 * 60 * 1000;
  return {
    ...clone(candidate),
    lifecycle_state: "quarantine",
    route: "quarantine",
    candidate_hash: sourceHash,
    next_evaluation_at: nextEvaluationAt,
    expires_at: expiresAt,
    autonomy_policy_hash: autonomyPolicyHash(normalized)
  };
}

export function evaluateAutonomyPostApply(observation = {}, policy = DEFAULT_AUTONOMY_POLICY) {
  const normalized = normalizeAutonomyPolicy(policy);
  const hardViolations = Number(observation.hard_violations ?? observation.hard_guardrails ?? 0);
  const retrievalCoverage = Number(observation.retrieval_coverage ?? 1);
  const failed = Number(observation.failed_operations ?? 0);
  const passed = hardViolations <= normalized.rollback.hard_violation_limit &&
    retrievalCoverage >= normalized.rollback.retrieval_coverage_minimum && failed === 0;
  return {
    passed,
    rollback_required: !passed && normalized.rollback.automatic,
    checks: {
      hard_violations: hardViolations <= normalized.rollback.hard_violation_limit,
      retrieval_coverage: retrievalCoverage >= normalized.rollback.retrieval_coverage_minimum,
      failed_operations: failed === 0
    },
    values: { hard_violations: hardViolations, retrieval_coverage: retrievalCoverage, failed_operations: failed }
  };
}

export function evaluateAutonomyCanary(observation = {}) {
  const turns = Number(observation.turns_scanned ?? observation.turns ?? 0);
  const active = Number(observation.active_candidates ?? 0);
  const quarantineSamples = Number(observation.quarantine_audit_samples ?? observation.review_audit_samples ?? 0);
  const excludedSamples = Number(observation.excluded_audit_samples ?? 0);
  const checks = {
    turns: Number.isInteger(turns) && turns >= 200,
    active_evidence: active > 0,
    active_deterministic: Number(observation.active_deterministic_verified_count ?? active) === active,
    active_profile_agreement: Number(observation.active_profile_agreement_count ?? active) === active,
    active_model_family_coverage: Number(observation.active_two_model_family_count ?? active) === active,
    audit_quarantine: quarantineSamples >= 50,
    audit_excluded: excludedSamples >= 50,
    observed_days: Number(observation.observed_days ?? 0) >= 7,
    reask_rate: Number(observation.reask_rate ?? 1) <= 0.05,
    retrieval_coverage: Number(observation.retrieval_coverage ?? 0) >= 0.98,
    contradictions: Number(observation.contradiction_count ?? 0) === 0,
    hard_violations: Number(observation.hard_violation_count ?? 0) === 0,
    disagreement: Number(observation.disagreement_count ?? 0) === 0,
    scope_violations: Number(observation.scope_violation_count ?? 0) === 0,
    privacy_violations: Number(observation.privacy_violation_count ?? 0) === 0
  };
  const sufficient = checks.turns && checks.active_evidence && checks.audit_quarantine && checks.audit_excluded;
  return {
    passed: sufficient && Object.values(checks).every(Boolean),
    status: !sufficient ? "insufficient_evidence" : Object.values(checks).every(Boolean) ? "qualified" : "not_qualified",
    checks,
    values: {
      turns,
      active_candidates: active,
      quarantine_audit_samples: quarantineSamples,
      excluded_audit_samples: excludedSamples,
      observed_days: Number(observation.observed_days ?? 0),
      reask_rate: Number(observation.reask_rate ?? 1),
      retrieval_coverage: Number(observation.retrieval_coverage ?? 0)
    }
  };
}

export function tuneAutonomyPolicy(policy, observation = {}) {
  const current = normalizeAutonomyPolicy(policy);
  if (!current.tuning.enabled) return { policy: current, changed: false, reason: "tuning_disabled" };
  const deltaLimit = current.tuning.maximum_threshold_delta_per_week;
  const requested = Number(observation.minimum_confidence_delta ?? 0);
  const used = Math.max(0, Math.min(deltaLimit, Number(observation.weekly_delta_used ?? 0) || 0));
  const remaining = Math.max(0, deltaLimit - used);
  const requestedDelta = Math.max(-remaining, Math.min(remaining, Number.isFinite(requested) ? requested : 0));
  const minimum = current.tuning.minimum_confidence_bound;
  const maximum = current.tuning.maximum_confidence_bound;
  const target = Math.max(minimum, Math.min(maximum, current.judge.minimum_confidence + requestedDelta));
  const delta = Math.round((target - current.judge.minimum_confidence) * 1e6) / 1e6;
  const next = normalizeAutonomyPolicy({
    ...current,
    judge: { ...current.judge, minimum_confidence: target }
  });
  return {
    policy: next,
    changed: next.judge.minimum_confidence !== current.judge.minimum_confidence,
    delta: Math.round((next.judge.minimum_confidence - current.judge.minimum_confidence) * 1e6) / 1e6,
    bounded: Math.abs(next.judge.minimum_confidence - current.judge.minimum_confidence) <= remaining,
    weekly_delta_used: used,
    weekly_delta_remaining: remaining
  };
}

export function advanceAutonomyMode(policy, evidence = {}) {
  const current = normalizeAutonomyPolicy(policy);
  if (!current.auto_advance || current.mode === current.target_mode) return current;
  if (current.mode === "shadow" && evidence.machine_reference_qualified === true && evidence.canary_qualified === true) {
    return { ...current, mode: "guarded" };
  }
  if (current.mode === "guarded" && evidence.observed_outcomes_qualified === true && evidence.rollback_ready === true) {
    return { ...current, mode: "autonomous" };
  }
  return current;
}
