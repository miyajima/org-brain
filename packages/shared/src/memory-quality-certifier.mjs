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
        : null;
  const judgePassed = !judgeConsensus || judgeConsensus.pass === true;
  const corpus = validateMemoryContractCorpus(manifest.corpus);
  const corpusRequired = options.requireCorpus !== false;
  const insufficientEvidence = measurements.length === 0 || missingAxes.length > 0 || measurements.some((measurement) => measurement.point_estimate === null) || (corpusRequired && !corpus.passed);
  const passed = !insufficientEvidence && measurements.every((measurement) => measurement.passed) && hardGuardrails.every((guardrail) => guardrail.passed) && judgePassed;
  return {
    schema_version: 2,
    certification: passed ? "oracle_certified" : "not_certified",
    status: insufficientEvidence ? "insufficient_evidence" : (passed ? "certified" : "not_certified"),
    aggregate_score: null,
    measurements,
    required_axes: requiredAxes,
    missing_axes: missingAxes,
    corpus,
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
