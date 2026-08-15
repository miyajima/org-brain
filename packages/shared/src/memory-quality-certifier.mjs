export const MEMORY_QUALITY_AXES = [
  "decision_utility",
  "evidence_rationale_quality",
  "retrieval_reproducibility",
  "freshness_validity",
  "duplicate_conflict_control",
  "coverage_utility",
  "structure_metadata"
];

export const MEMORY_CONTRACT_KPIS = [
  "verified_knowledge_correctness",
  "durable_knowledge_coverage",
  "decision_continuity"
];

export const MEMORY_CONTRACT_HARD_GUARDRAILS = [
  "unsupported_active_record",
  "credential_or_pii_leak",
  "cross_tenant_or_scope_injection",
  "stale_or_superseded_application",
  "final_answer_self_attestation",
  "canonical_duplicate",
  "contract_hash_mismatch",
  "same_decision_key_reask"
];

export const MEMORY_CONTRACT_CORPUS_MINIMUMS = {
  success: 75,
  decision: 75,
  failure: 75,
  non_durable_turn: 200,
  next_task_retrieval: 300,
  continuity_same_key_reask: 75,
  continuity_paraphrase: 75,
  continuity_compaction_resume: 75,
  continuity_change_conflict_scope: 75
};

export const MEMORY_CONTRACT_OPERATION_GATES = Object.freeze({
  pre_tool_use_p95_ms: 100,
  post_tool_use_p95_ms: 250,
  stop_p95_ms: 2_500,
  hard_timeout_count: 0,
  api_5xx_count: 0,
  cloudflare_1102_count: 0,
  smoke_turns: 200
});

export const MEMORY_INGESTION_ORACLE_MINIMUMS = Object.freeze({
  total_cases: 40,
  contract_cases: 14,
  verification_cases: 11,
  routing_cases: 15,
  active_routes: 3,
  review_routes: 2,
  excluded_routes: 10,
  metamorphic_pairs: 8
});

export const MEMORY_INGESTION_CALIBRATION_MINIMUMS = Object.freeze({
  selected_case_count: 900,
  active_routes: 300,
  review_routes: 300,
  excluded_routes: 300,
  metamorphic_pairs: 90
});

export const MEMORY_INGESTION_CALIBRATION_JUDGE_CLASS_MINIMUM = 200;

export const MEMORY_INGESTION_AUTONOMOUS_MINIMUMS = Object.freeze({
  selected_case_count: 900,
  active_routes: 300,
  quarantine_routes: 300,
  excluded_routes: 300
});

export const MEMORY_INGESTION_AUTONOMOUS_HARD_GUARDRAILS = Object.freeze([
  "unsupported_active",
  "credential_or_pii_active",
  "scope_violation_active",
  "self_attestation_active",
  "unsafe_active",
  "lesson_type_misclassification"
]);

export const MEMORY_INGESTION_AUTONOMOUS_JUDGE_PROFILES = Object.freeze([
  "evidence_entailment",
  "durability_atomicity",
  "future_reuse_overgeneralization",
  "adversarial_critic",
  "policy_consistency"
]);

function metricWilsonGate(metric, threshold = 0.95) {
  return metric?.passed === true &&
    Number(metric.precision) >= threshold &&
    Number(metric.recall) >= threshold &&
    Number(metric.precision_wilson_lower ?? metric.precision_wilson_95_lower) >= threshold &&
    Number(metric.recall_wilson_lower ?? metric.recall_wilson_95_lower) >= threshold;
}

function accuracyWilsonGate(metric, threshold = 0.95) {
  return metric?.passed === true &&
    Number(metric.point_estimate) >= threshold &&
    Number(metric.wilson_lower ?? metric.wilson_95_lower) >= threshold;
}

export function evaluateMemoryIngestionOracleQualification(input = {}) {
  const layerCounts = input?.layer_counts && typeof input.layer_counts === "object" ? input.layer_counts : {};
  const routeCounts = input?.route_counts && typeof input.route_counts === "object" ? input.route_counts : {};
  const values = {
    total_cases: Number(input.total_cases),
    contract_cases: Number(layerCounts.contract),
    verification_cases: Number(layerCounts.verification),
    routing_cases: Number(layerCounts.routing),
    active_routes: Number(routeCounts.active),
    review_routes: Number(routeCounts.review),
    excluded_routes: Number(routeCounts.excluded),
    metamorphic_pairs: Number(input.metamorphic_pair_count)
  };
  const minimumChecks = Object.fromEntries(Object.entries(MEMORY_INGESTION_ORACLE_MINIMUMS).map(([key, minimum]) => [
    key,
    Number.isInteger(values[key]) && values[key] >= minimum
  ]));
  const checks = {
    schema_version: input.schema_version === 1,
    dataset_id: typeof input.dataset_id === "string" && input.dataset_id.length > 0,
    dataset_sha256: /^sha256:[a-f0-9]{64}$/u.test(String(input.dataset_sha256 ?? "")),
    locked: input.locked === true,
    runner_passed: input.passed === true && input.status === "qualified",
    labels_static: input.labels_static === true,
    labels_not_runtime_derived: input.labels_derived_from_runtime === false,
    label_mismatches: input.label_mismatch_count === 0,
    metamorphic_violations: input.metamorphic_violation_count === 0,
    duplicate_ids: input.duplicate_ids === 0,
    leakage_violations: input.leakage_violations === 0,
    structural_errors: Array.isArray(input.structural_errors) && input.structural_errors.length === 0,
    ...minimumChecks
  };
  const hasInput = input && typeof input === "object" && Object.keys(input).length > 0;
  const passed = hasInput && Object.values(checks).every(Boolean);
  return {
    certification: passed ? "oracle_qualified" : "not_qualified",
    status: !hasInput ? "insufficient_evidence" : passed ? "qualified" : "not_qualified",
    pass: passed,
    checks,
    values,
    minimums: MEMORY_INGESTION_ORACLE_MINIMUMS,
    dataset_id: typeof input.dataset_id === "string" ? input.dataset_id : null,
    dataset_sha256: typeof input.dataset_sha256 === "string" ? input.dataset_sha256 : null
  };
}

export function evaluateMemoryIngestionCalibrationQualification(input = {}) {
  const routeCounts = input?.route_counts && typeof input.route_counts === "object" ? input.route_counts : {};
  const values = {
    selected_case_count: Number(input.selected_case_count),
    active_routes: Number(routeCounts.active),
    review_routes: Number(routeCounts.review),
    excluded_routes: Number(routeCounts.excluded),
    metamorphic_pairs: Number(input.metamorphic?.pair_count)
  };
  const minimumChecks = Object.fromEntries(Object.entries(MEMORY_INGESTION_CALIBRATION_MINIMUMS).map(([key, minimum]) => [
    key,
    Number.isInteger(values[key]) && values[key] >= minimum
  ]));
  const checks = {
    schema_version: input.schema_version === 1,
    dataset_id: input.dataset_id === "orgbrain-memory-ingestion-calibration-v1",
    dataset_sha256: /^sha256:[a-f0-9]{64}$/u.test(String(input.dataset_sha256 ?? "")),
    case_hashes: [input.case_hash, input.selected_case_hash].every((value) => /^sha256:[a-f0-9]{64}$/u.test(String(value ?? ""))),
    provenance_hashes: [input.seed_hash, input.rubric_hash, input.contract_hash, input.prompt_hash, input.reason_code_hash].every((value) => /^sha256:[a-f0-9]{64}$/u.test(String(value ?? ""))),
    locked: input.locked === true,
    runner_passed: input.passed === true && input.status === "qualified",
    labels_static: input.labels_static === true,
    labels_not_runtime_derived: input.labels_derived_from_runtime === false,
    structural_errors: Array.isArray(input.structural_errors) && input.structural_errors.length === 0,
    reviewer_agreement: Number(input.reviewer_agreement?.route_agreement) >= 0.9 && Number(input.reviewer_agreement?.route_cohen_kappa) >= 0.8 && Number(input.reviewer_agreement?.reason_code_micro_f1) >= 0.85,
    route_metrics: input.route_metrics && ["active", "review", "excluded"].every((route) => metricWilsonGate(input.route_metrics[route])),
    route_accuracy: accuracyWilsonGate(input.route_accuracy),
    reason_codes: input.reason_code_required?.passed === true && input.reason_code_forbidden?.passed === true,
    lesson_type_errors: Number(input.lesson_type_errors) === 0,
    judge_metrics: input.judge_metrics && ["evidence_entailment", "durability_atomicity", "future_reuse_overgeneralization"].every((profile) => input.judge_metrics[profile]?.passed === true),
    judge_class_counts: input.judge_class_counts && ["evidence_entailment", "durability_atomicity", "future_reuse_overgeneralization"].every((profile) => Number(input.judge_class_counts[profile]?.pass) >= MEMORY_INGESTION_CALIBRATION_JUDGE_CLASS_MINIMUM && Number(input.judge_class_counts[profile]?.fail) >= MEMORY_INGESTION_CALIBRATION_JUDGE_CLASS_MINIMUM),
    ai_judge_results_present: input.ai_judge_results_present === true,
    metamorphic: Number(input.metamorphic?.violation_count) === 0,
    hard_guardrails: input.hard_guardrails && Object.keys(input.hard_guardrails).length > 0 && Object.values(input.hard_guardrails).every((count) => Number(count) === 0),
    privacy: input.privacy && input.privacy.raw_transcript_copied === false && input.privacy.runtime_predictions_in_gold === false && input.privacy.real_credentials_or_pii === false,
    ...minimumChecks
  };
  const hasInput = input && typeof input === "object" && Object.keys(input).length > 0;
  const passed = hasInput && Object.values(checks).every(Boolean);
  return {
    certification: passed ? "calibration_qualified" : "not_qualified",
    status: !hasInput ? "insufficient_evidence" : passed ? "qualified" : "not_qualified",
    pass: passed,
    checks,
    values,
    minimums: MEMORY_INGESTION_CALIBRATION_MINIMUMS,
    dataset_id: typeof input.dataset_id === "string" ? input.dataset_id : null,
    dataset_sha256: typeof input.dataset_sha256 === "string" ? input.dataset_sha256 : null
  };
}

export function evaluateMemoryIngestionAutonomousQualification(input = {}) {
  const routeCounts = input?.route_counts && typeof input.route_counts === "object" ? input.route_counts : {};
  const values = {
    selected_case_count: Number(input.selected_case_count),
    active_routes: Number(routeCounts.active),
    quarantine_routes: Number(routeCounts.quarantine ?? routeCounts.review),
    excluded_routes: Number(routeCounts.excluded),
    council_stability: Number(input.council_stability?.point_estimate ?? input.council_stability),
    metamorphic_pairs: Number(input.metamorphic?.pair_count)
  };
  const minimumChecks = Object.fromEntries(Object.entries(MEMORY_INGESTION_AUTONOMOUS_MINIMUMS).map(([key, minimum]) => [
    key,
    Number.isInteger(values[key]) && values[key] >= minimum
  ]));
  const hasInput = input && typeof input === "object" && Object.keys(input).length > 0;
  const checks = {
    schema_version: input.schema_version === 1,
    dataset_id: typeof input.dataset_id === "string" && input.dataset_id.includes("machine-reference"),
    dataset_sha256: /^sha256:[a-f0-9]{64}$/u.test(String(input.dataset_sha256 ?? "")),
    case_hashes: [input.case_hash, input.selected_case_hash].every((value) => /^sha256:[a-f0-9]{64}$/u.test(String(value ?? ""))),
    provenance_hashes: [input.seed_hash, input.rubric_hash, input.contract_hash, input.prompt_hash, input.reason_code_hash].every((value) => /^sha256:[a-f0-9]{64}$/u.test(String(value ?? ""))),
    locked: input.locked === true,
    runner_passed: input.passed === true && input.status === "qualified",
    ground_truth_basis: input.ground_truth_basis === "machine_reference",
    human_grounded: input.human_grounded === false,
    labels_not_runtime_derived: input.labels_derived_from_runtime === false,
    structural_errors: Array.isArray(input.structural_errors) && input.structural_errors.length === 0,
    route_metrics: input.route_metrics && ["active", "quarantine", "excluded"].every((route) => metricWilsonGate(input.route_metrics[route]) || (route === "quarantine" && metricWilsonGate(input.route_metrics.review))),
    route_accuracy: accuracyWilsonGate(input.route_accuracy),
    judge_metrics: input.judge_metrics && MEMORY_INGESTION_AUTONOMOUS_JUDGE_PROFILES.every((profile) => metricWilsonGate(input.judge_metrics[profile])),
    consensus_metrics: metricWilsonGate(input.consensus_metrics),
    council_stability: Number.isFinite(values.council_stability) && values.council_stability >= 0.99,
    hard_guardrails: input.hard_guardrails && MEMORY_INGESTION_AUTONOMOUS_HARD_GUARDRAILS.every((name) => Object.hasOwn(input.hard_guardrails, name) && Number(input.hard_guardrails[name]) === 0),
    metamorphic: Number(input.metamorphic?.violation_count) === 0,
    metamorphic_pairs: Number.isInteger(values.metamorphic_pairs) && values.metamorphic_pairs >= 90,
    observed_outcomes: input.observed_outcomes?.passed === true,
    privacy: input.privacy && input.privacy.raw_transcript_copied === false && input.privacy.reasoning_persisted === false && input.privacy.real_credentials_or_pii === false,
    council_results_present: input.council_results_present === true,
    council_signature: typeof input.council_signature === "string" && input.council_signature.length > 0,
    council_key_fingerprints: Array.isArray(input.council_key_fingerprints) && new Set(input.council_key_fingerprints.map(String).filter(Boolean)).size >= 3
  };
  const passed = hasInput && Object.values(checks).every(Boolean);
  return {
    // Keep only the signed, non-content provenance needed to re-verify this
    // result when the report is handed to the quality certifier.  This makes
    // the evaluator output itself a safe manifest fragment rather than a
    // self-attested boolean that cannot be checked again.
    schema_version: input.schema_version,
    dataset_id: input.dataset_id,
    dataset_sha256: input.dataset_sha256,
    case_hash: input.case_hash,
    selected_case_hash: input.selected_case_hash,
    seed_hash: input.seed_hash,
    rubric_hash: input.rubric_hash,
    contract_hash: input.contract_hash,
    prompt_hash: input.prompt_hash,
    reason_code_hash: input.reason_code_hash,
    locked: input.locked,
    passed: input.passed,
    status: input.status,
    selected_case_count: input.selected_case_count,
    route_counts: input.route_counts,
    route_metrics: input.route_metrics,
    route_accuracy: input.route_accuracy,
    judge_metrics: input.judge_metrics,
    consensus_metrics: input.consensus_metrics,
    council_stability: input.council_stability,
    hard_guardrails: input.hard_guardrails,
    metamorphic: input.metamorphic,
    observed_outcomes: input.observed_outcomes,
    council_signature: input.council_signature,
    council_public_key_fingerprint: input.council_public_key_fingerprint,
    council_key_fingerprints: input.council_key_fingerprints,
    ground_truth_basis: input.ground_truth_basis,
    human_grounded: input.human_grounded,
    labels_derived_from_runtime: input.labels_derived_from_runtime,
    privacy: input.privacy,
    council_results_present: input.council_results_present,
    structural_errors: input.structural_errors,
    certification: passed ? "autonomous_qualified" : "not_qualified",
    status: !hasInput ? "insufficient_evidence" : passed ? "qualified" : "not_qualified",
    pass: passed,
    checks,
    values,
    minimums: MEMORY_INGESTION_AUTONOMOUS_MINIMUMS,
    dataset_id: typeof input.dataset_id === "string" ? input.dataset_id : null,
    dataset_sha256: typeof input.dataset_sha256 === "string" ? input.dataset_sha256 : null
  };
}

export function evaluateMemoryContractPerformance(input = {}) {
  const values = Object.fromEntries(Object.keys(MEMORY_CONTRACT_OPERATION_GATES).map((key) => [key, Number(input[key])]));
  const checks = {
    pre_tool_use_p95_ms: Number.isFinite(values.pre_tool_use_p95_ms) && values.pre_tool_use_p95_ms < MEMORY_CONTRACT_OPERATION_GATES.pre_tool_use_p95_ms,
    post_tool_use_p95_ms: Number.isFinite(values.post_tool_use_p95_ms) && values.post_tool_use_p95_ms < MEMORY_CONTRACT_OPERATION_GATES.post_tool_use_p95_ms,
    stop_p95_ms: Number.isFinite(values.stop_p95_ms) && values.stop_p95_ms < MEMORY_CONTRACT_OPERATION_GATES.stop_p95_ms,
    hard_timeout_count: values.hard_timeout_count === MEMORY_CONTRACT_OPERATION_GATES.hard_timeout_count,
    api_5xx_count: values.api_5xx_count === MEMORY_CONTRACT_OPERATION_GATES.api_5xx_count,
    cloudflare_1102_count: values.cloudflare_1102_count === MEMORY_CONTRACT_OPERATION_GATES.cloudflare_1102_count,
    smoke_turns: Number.isInteger(values.smoke_turns) && values.smoke_turns >= MEMORY_CONTRACT_OPERATION_GATES.smoke_turns
  };
  return { passed: Object.values(checks).every(Boolean), gates: MEMORY_CONTRACT_OPERATION_GATES, values, checks };
}

export function validateMemoryContractCorpus(corpus = {}) {
  const counts = corpus?.counts && typeof corpus.counts === "object" ? corpus.counts : {};
  const continuity = counts.continuity && typeof counts.continuity === "object" ? counts.continuity : {};
  const actual = {
    success: Number(counts.success ?? counts.lesson_types?.success ?? 0),
    decision: Number(counts.decision ?? counts.lesson_types?.decision ?? 0),
    failure: Number(counts.failure ?? counts.lesson_types?.failure ?? 0),
    non_durable_turn: Number(counts.non_durable_turn ?? counts.non_durable_turns ?? 0),
    next_task_retrieval: Number(counts.next_task_retrieval ?? counts.next_task_retrievals ?? 0),
    continuity_same_key_reask: Number(counts.continuity_same_key_reask ?? continuity.same_key_reask ?? 0),
    continuity_paraphrase: Number(counts.continuity_paraphrase ?? continuity.paraphrase ?? 0),
    continuity_compaction_resume: Number(counts.continuity_compaction_resume ?? continuity.compaction_resume ?? 0),
    continuity_change_conflict_scope: Number(counts.continuity_change_conflict_scope ?? continuity.change_conflict_scope ?? 0)
  };
  const missing = Object.entries(MEMORY_CONTRACT_CORPUS_MINIMUMS)
    .filter(([name, minimum]) => !Number.isInteger(actual[name]) || actual[name] < minimum)
    .map(([name, minimum]) => ({ name, actual: actual[name], minimum }));
  const sessionSplits = new Map();
  for (const item of Array.isArray(corpus?.cases) ? corpus.cases : Array.isArray(corpus?.sessions) ? corpus.sessions : []) {
    const sessionHash = String(item?.session_hash ?? "");
    const split = String(item?.split ?? "");
    if (!sessionHash || !split) continue;
    const splits = sessionSplits.get(sessionHash) ?? new Set();
    splits.add(split);
    sessionSplits.set(sessionHash, splits);
  }
  const splitViolations = [...sessionSplits.entries()]
    .filter(([, splits]) => splits.size > 1)
    .map(([session_hash, splits]) => ({ session_hash, splits: [...splits].sort() }));
  return {
    passed: missing.length === 0 && splitViolations.length === 0 && corpus?.privacy?.raw_transcript_copied !== true && corpus?.privacy?.text_persisted !== true,
    actual,
    minimums: MEMORY_CONTRACT_CORPUS_MINIMUMS,
    missing,
    split_violations: splitViolations,
    privacy_passed: corpus?.privacy?.raw_transcript_copied !== true && corpus?.privacy?.text_persisted !== true
  };
}

export function wilsonLowerBound(successes, total, z = 1.959963984540054) {
  if (!Number.isInteger(successes) || !Number.isInteger(total) || total <= 0 || successes < 0 || successes > total) return null;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
  return Math.max(0, (center - margin) / denominator);
}

export function wilsonInterval(successes, total, z = 1.959963984540054) {
  if (!Number.isInteger(successes) || !Number.isInteger(total) || total <= 0 || successes < 0 || successes > total) {
    return { lower: null, upper: null };
  }
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
  return {
    lower: Math.max(0, (center - margin) / denominator),
    upper: Math.min(1, (center + margin) / denominator)
  };
}

export function evaluateMemoryContractMeasurement(input = {}, options = {}) {
  const threshold = Number(options.threshold ?? 0.95);
  const axis = String(input.axis ?? "unnamed");
  const cohort = String(input.cohort ?? "all");
  const successes = Number(input.successes);
  const total = Number(input.total);
  const interval = wilsonInterval(successes, total);
  const point = interval.lower === null ? null : successes / total;
  const reaskCount = input.reask_count === undefined ? null : Number(input.reask_count);
  const reaskInterval = reaskCount === null ? null : wilsonInterval(reaskCount, total);
  const reaskUpperThreshold = Number(options.reaskUpperThreshold ?? 0.05);
  const requiresReaskMeasurement = axis === "decision_continuity" || options.requireReaskCount === true;
  const hardViolationCount = Number(input.hard_violation_count ?? 0);
  const validHardViolationCount = Number.isInteger(hardViolationCount) ? hardViolationCount : 0;
  const validReask = (!requiresReaskMeasurement && reaskCount === null) ||
    (Number.isInteger(reaskCount) && reaskCount >= 0 && reaskCount <= total);
  const validHardViolations = Number.isInteger(hardViolationCount) && hardViolationCount >= 0;
  const valid = point !== null && interval.lower !== null && validReask && validHardViolations;
  const reaskPassed = validReask && (reaskInterval === null || reaskInterval.upper <= reaskUpperThreshold);
  return {
    axis,
    cohort,
    successes: Number.isInteger(successes) ? successes : null,
    total: Number.isInteger(total) ? total : null,
    point_estimate: valid ? point : null,
    wilson_lower: valid ? interval.lower : null,
    wilson_upper: valid ? interval.upper : null,
    reask_count: reaskCount,
    reask_wilson_upper: reaskInterval?.upper ?? null,
    hard_violation_count: validHardViolations ? validHardViolationCount : null,
    passed: valid && point >= threshold && interval.lower >= threshold && reaskPassed && validHardViolationCount === 0
  };
}

function normalizeHardViolations(input) {
  const counts = Object.fromEntries(MEMORY_CONTRACT_HARD_GUARDRAILS.map((name) => [name, 0]));
  for (const violation of Array.isArray(input) ? input : []) {
    const name = typeof violation === "string" ? violation : violation?.name ?? violation?.type;
    if (!name) continue;
    const count = typeof violation === "string" ? 1 : Number(violation.count ?? 1);
    counts[name] = (counts[name] ?? 0) + (Number.isFinite(count) ? Math.max(0, count) : 0);
  }
  return counts;
}

export function certifyMemoryContractQuality(manifest = {}, options = {}) {
  const measurements = Array.isArray(manifest.measurements)
    ? manifest.measurements.map((measurement) => evaluateMemoryContractMeasurement(measurement, options))
    : [];
  const requiredAxes = Array.isArray(options.requiredAxes)
    ? options.requiredAxes.map(String)
    : [...MEMORY_CONTRACT_KPIS, ...MEMORY_QUALITY_AXES];
  const presentAxes = new Set(measurements.map((measurement) => measurement.axis));
  const missingAxes = requiredAxes.filter((axis) => !presentAxes.has(axis));
  const hardViolations = normalizeHardViolations(manifest.hard_violations);
  const hardGuardrails = Object.entries(hardViolations).map(([name, count]) => ({ name, count, passed: count === 0 }));
  const suppliedConsensus = manifest.judge_consensus && typeof manifest.judge_consensus === "object"
    ? manifest.judge_consensus
    : null;
  const judgeConsensus = Array.isArray(manifest.judgments)
    ? evaluateAiJudgeConsensus(manifest.judgments, options)
    : Array.isArray(suppliedConsensus?.judgments)
      ? evaluateAiJudgeConsensus(suppliedConsensus.judgments, options)
      : suppliedConsensus
        ? { certification: "not_certified", status: "insufficient_evidence", pass: false, required_judges: 3, judgments: [] }
        : { certification: "not_certified", status: "insufficient_evidence", pass: false, required_judges: 3, judgments: [] };
  const judgeRequired = options.requireJudgeConsensus !== false;
  const judgePassed = !judgeRequired || judgeConsensus.pass === true;
  const oracleQualification = evaluateMemoryIngestionOracleQualification(manifest.oracle_qualification);
  const oracleRequired = options.requireOracleQualification !== false;
  const oraclePassed = !oracleRequired || oracleQualification.pass === true;
  const calibrationQualification = evaluateMemoryIngestionCalibrationQualification(manifest.calibration_qualification);
  const calibrationRequired = options.requireCalibrationQualification !== false;
  const autonomousQualification = evaluateMemoryIngestionAutonomousQualification(manifest.autonomous_qualification);
  const autonomousInput = manifest.autonomous_qualification && typeof manifest.autonomous_qualification === "object" && Object.keys(manifest.autonomous_qualification).length > 0;
  const autonomousRequired = options.requireAutonomousQualification === true || (autonomousInput && options.requireAutonomousQualification !== false);
  const selectedQualification = autonomousInput ? autonomousQualification : calibrationQualification;
  const qualificationPassed = autonomousInput
    ? (!autonomousRequired || autonomousQualification.pass === true)
    : (!calibrationRequired || calibrationQualification.pass === true);
  const corpus = validateMemoryContractCorpus(manifest.corpus);
  const corpusRequired = options.requireCorpus !== false;
  const qualificationRequired = autonomousInput ? autonomousRequired : calibrationRequired;
  const autonomousMissing = options.requireAutonomousQualification === true && !autonomousInput;
  const insufficientEvidence = (requiredAxes.length > 0 && measurements.length === 0) || missingAxes.length > 0 || measurements.some((measurement) => measurement.point_estimate === null) || (corpusRequired && !corpus.passed) || (oracleRequired && oracleQualification.status === "insufficient_evidence") || autonomousMissing || (qualificationRequired && selectedQualification.status === "insufficient_evidence");
  const passed = !insufficientEvidence && measurements.every((measurement) => measurement.passed) && hardGuardrails.every((guardrail) => guardrail.passed) && judgePassed && oraclePassed && qualificationPassed;
  return {
    schema_version: 2,
    certification: passed ? (autonomousInput && autonomousQualification.pass ? "autonomous_qualified" : "oracle_certified") : "not_certified",
    status: insufficientEvidence ? "insufficient_evidence" : (passed ? "certified" : "not_certified"),
    aggregate_score: null,
    measurements,
    required_axes: requiredAxes,
    missing_axes: missingAxes,
    corpus,
    oracle_qualification: oracleQualification,
    calibration_qualification: calibrationQualification,
    autonomous_qualification: autonomousQualification,
    selected_qualification: selectedQualification,
    judge_consensus: judgeConsensus,
    hard_guardrails: hardGuardrails,
    threshold: Number(options.threshold ?? 0.95),
    reask_upper_threshold: Number(options.reaskUpperThreshold ?? 0.05)
  };
}

export function evaluateAiJudgeConsensus(judgments = [], options = {}) {
  const requiredJudges = Number(options.requiredJudges ?? 3);
  const rows = (Array.isArray(judgments) ? judgments : []).map((judgment) => ({
    judge_name: String(judgment?.judge_name ?? ""),
    model_family: String(judgment?.model_family ?? judgment?.judge_model ?? ""),
    verdict: String(judgment?.verdict ?? ""),
    reason_codes: Array.isArray(judgment?.reason_codes) ? judgment.reason_codes.map(String).slice(0, 16) : [],
    support: Array.isArray(judgment?.support) ? judgment.support.map(String).slice(0, 16) : []
  }));
  const names = new Set(rows.map((row) => row.judge_name).filter(Boolean));
  const families = new Set(rows.map((row) => row.model_family).filter(Boolean));
  const validShape = rows.length === requiredJudges && names.size === requiredJudges && families.size >= 2 && rows.every((row) => ["pass", "fail"].includes(row.verdict));
  if (!validShape) {
    return { certification: "not_certified", status: "insufficient_evidence", pass: false, required_judges: requiredJudges, judgments: rows };
  }
  const unanimous = rows.every((row) => row.verdict === rows[0].verdict);
  if (unanimous && rows[0].verdict === "pass") {
    return { certification: "ai_consensus_certified", status: "certified", pass: true, required_judges: requiredJudges, judgments: rows };
  }
  return {
    certification: "not_certified",
    status: unanimous ? "rejected" : "ai_review_pending/disagreed",
    pass: false,
    required_judges: requiredJudges,
    judgments: rows
  };
}

export function certifyMemoryQuality(manifest, options = {}) {
  const threshold = Number(options.threshold ?? 95);
  const axes = {};
  for (const axis of MEMORY_QUALITY_AXES) {
    const metrics = Array.isArray(manifest?.axes?.[axis]) ? manifest.axes[axis] : [];
    const evaluated = metrics.map((metric) => {
      const successes = Number(metric?.successes);
      const total = Number(metric?.total);
      const point = Number.isInteger(successes) && Number.isInteger(total) && total > 0
        ? (100 * successes) / total
        : null;
      const lower = wilsonLowerBound(successes, total);
      return {
        name: String(metric?.name ?? "unnamed"),
        successes,
        total,
        point_estimate: point,
        wilson_95_lower: lower === null ? null : lower * 100,
        passed: point !== null && lower !== null && point >= threshold && lower * 100 >= threshold
      };
    });
    const sufficient = evaluated.length > 0 && evaluated.every((metric) => metric.point_estimate !== null && metric.wilson_95_lower !== null);
    const score = sufficient
      ? Math.min(...evaluated.flatMap((metric) => [metric.point_estimate, metric.wilson_95_lower]))
      : null;
    axes[axis] = {
      status: sufficient ? (evaluated.every((metric) => metric.passed) ? "certified" : "not_certified") : "insufficient_evidence",
      score: score === null ? null : Math.round(score * 100) / 100,
      threshold,
      metrics: evaluated
    };
  }
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    aggregate_score: null,
    axes
  };
}
