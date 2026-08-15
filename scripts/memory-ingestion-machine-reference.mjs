#!/usr/bin/env node

import crypto from "node:crypto";

export const MACHINE_REFERENCE_DATASET_ID = "orgbrain-memory-ingestion-machine-reference-v1";
export const MACHINE_REFERENCE_JUDGE_PROFILES = Object.freeze([
  "evidence_entailment",
  "durability_atomicity",
  "future_reuse_overgeneralization",
  "adversarial_critic",
  "policy_consistency"
]);
export const MACHINE_REFERENCE_ROUTES = Object.freeze(["active", "quarantine", "excluded"]);
export const MACHINE_REFERENCE_QUOTAS = Object.freeze({ active: 300, quarantine: 300, excluded: 300 });
export const WILSON_Z_95 = 1.959963984540054;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

export function sha(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value), "utf8").digest("hex")}`;
}

function normalizeLabel(label = {}) {
  return {
    route: String(label.route ?? ""),
    lesson_type: label.lesson_type == null ? null : String(label.lesson_type),
    verification_state: String(label.verification_state ?? ""),
    required_reason_codes: [...new Set((label.required_reason_codes ?? []).map(String))].sort(),
    forbidden_reason_codes: [...new Set((label.forbidden_reason_codes ?? []).map(String))].sort(),
    hard_guardrails: [...new Set((label.hard_guardrails ?? []).map(String))].sort()
  };
}

function normalizeJudgment(row = {}) {
  const support = row.support_selector ?? row.support;
  return {
    judge_name: String(row.judge_name ?? row.profile_id ?? ""),
    model_family: String(row.model_family ?? ""),
    model_version: String(row.model_version ?? ""),
    prompt_hash: String(row.prompt_hash ?? ""),
    candidate_hash: String(row.candidate_hash ?? ""),
    verdict: String(row.verdict ?? row.route ?? ""),
    confidence: Number(row.confidence),
    support_selector: Array.isArray(support) ? support.map(String).slice(0, 16) : [],
    support_selector_present: Array.isArray(support),
    reason_codes: Array.isArray(row.reason_codes) ? [...new Set(row.reason_codes.map(String))].sort() : [],
    signature: row.signature ? String(row.signature) : null,
    public_key_fingerprint: row.public_key_fingerprint ? String(row.public_key_fingerprint) : null,
    label: normalizeLabel(row.label ?? row)
  };
}

function majority(values, minimum) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const winner = [...counts.entries()].sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0])))[0];
  return winner && winner[1] >= minimum ? { value: winner[0], count: winner[1] } : null;
}

export function wilsonLowerBound(successes, total, z = WILSON_Z_95) {
  const n = Number(total);
  const x = Number(successes);
  if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(x) || x < 0 || x > n) return null;
  const p = x / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return (center - margin) / denominator;
}

function labelKey(label) {
  return stableJson(normalizeLabel(label));
}

export function evaluateMachineReferenceCouncil(input = {}) {
  const first = (input.first ?? []).map(normalizeJudgment);
  const second = (input.second ?? []).map(normalizeJudgment);
  const expected = MACHINE_REFERENCE_JUDGE_PROFILES.length;
  const rows = [...first, ...second];
  const profileNames = new Set(rows.map((row) => row.judge_name).filter(Boolean));
  const families = new Set(rows.map((row) => row.model_family).filter(Boolean));
  const keyFingerprints = new Set(rows.map((row) => row.public_key_fingerprint).filter(Boolean));
  const producerFamilies = new Set((input.producer_model_families ?? input.producerModelFamilies ?? []).map(String).filter(Boolean));
  const producerVersions = new Set((input.producer_model_versions ?? input.producerModelVersions ?? []).map(String).filter(Boolean));
  const firstNames = new Set(first.map((row) => row.judge_name).filter(Boolean));
  const secondNames = new Set(second.map((row) => row.judge_name).filter(Boolean));
  const expectedNames = new Set(MACHINE_REFERENCE_JUDGE_PROFILES);
  const expectedCandidateHash = input.candidate_hash ?? input.candidateHash ?? null;
  const shapeValid = first.length === expected && second.length === expected &&
    firstNames.size === expected && secondNames.size === expected &&
    profileNames.size === expected && [...firstNames].every((name) => expectedNames.has(name)) &&
    [...secondNames].every((name) => expectedNames.has(name)) && families.size >= 3 && keyFingerprints.size >= 3 &&
    !rows.some((row) => producerFamilies.has(row.model_family) || producerVersions.has(row.model_version)) &&
    rows.every((row) => row.model_version && row.prompt_hash && row.candidate_hash &&
      (!expectedCandidateHash || row.candidate_hash === expectedCandidateHash) &&
      row.signature && row.public_key_fingerprint && row.support_selector_present &&
      Number.isFinite(row.confidence) && row.confidence >= 0.95 && MACHINE_REFERENCE_ROUTES.includes(row.label.route));
  if (!shapeValid) {
    return { accepted: false, status: "insufficient_evidence", reason: "council_shape_invalid", first, second, model_family_count: families.size, key_fingerprint_count: keyFingerprints.size };
  }
  const firstKeys = first.map((row) => labelKey(row.label));
  const secondByJudge = new Map(second.map((row) => [row.judge_name, row]));
  const stable = firstKeys.length === second.length && first.every((row, index) => {
    const other = secondByJudge.get(row.judge_name);
    return firstKeys[index] === labelKey(other?.label) &&
      row.model_family === other?.model_family &&
      row.model_version === other?.model_version &&
      row.prompt_hash === other?.prompt_hash &&
      row.candidate_hash === other?.candidate_hash &&
      row.signature === other?.signature &&
      labelKey({ required_reason_codes: row.reason_codes }) === labelKey({ required_reason_codes: other?.reason_codes });
  });
  const routeCounts = Object.fromEntries(MACHINE_REFERENCE_ROUTES.map((route) => [route, first.filter((row) => row.label.route === route).length]));
  const winningRoute = [...MACHINE_REFERENCE_ROUTES]
    .sort((left, right) => routeCounts[right] - routeCounts[left] || left.localeCompare(right))[0];
  const routeMajority = majority(first.map((row) => row.label.route), winningRoute === "active" ? expected : 4);
  const guardrailKeys = new Set(rows.map((row) => stableJson(row.label.hard_guardrails)));
  const noHardGuardrailDissent = guardrailKeys.size === 1 && !(routeMajority?.value === "active" && first.some((row) => row.label.hard_guardrails.length > 0));
  const accepted = stable && Boolean(routeMajority) && noHardGuardrailDissent;
  const label = accepted ? normalizeLabel(first.find((row) => row.label.route === routeMajority.value)?.label ?? first[0].label) : null;
  return {
    accepted,
    status: accepted ? "accepted" : "quarantine",
    reason: accepted ? null : (!stable ? "council_repeat_disagreement" : "council_route_disagreement"),
    label,
    first,
    second,
    model_family_count: families.size,
    key_fingerprint_count: keyFingerprints.size,
    repeat_agreement: stable ? 1 : 0,
    route_agreement: first.filter((row) => row.label.route === routeMajority?.value).length / expected,
    hard_guardrail_dissent: !noHardGuardrailDissent
  };
}

export function sealMachineReference(cases, references, options = {}) {
  if (!Array.isArray(cases) || !Array.isArray(references)) throw new Error("machine_reference_cases_and_labels_required");
  const caseIds = cases.map((item) => String(item?.case_id ?? ""));
  const referenceIds = references.map((item) => String(item?.case_id ?? ""));
  if (caseIds.some((id) => !id) || new Set(caseIds).size !== caseIds.length) throw new Error("machine_reference_duplicate_case_id");
  if (referenceIds.some((id) => !id) || new Set(referenceIds).size !== referenceIds.length) throw new Error("machine_reference_duplicate_reference_id");
  const caseIdSet = new Set(caseIds);
  const referenceIdSet = new Set(referenceIds);
  if (referenceIds.length !== caseIds.length || [...caseIdSet].some((id) => !referenceIdSet.has(id)) || [...referenceIdSet].some((id) => !caseIdSet.has(id))) {
    throw new Error("machine_reference_case_reference_set_mismatch");
  }
  if (cases.some((item) => /raw_transcript|reasoning|chain.of.thought|sk-[A-Za-z0-9]{20,}|\/Users\/[^/]+\//iu.test(stableJson(item)))) {
    throw new Error("machine_reference_privacy_violation");
  }
  if ([...cases, ...references].some((item) => item?.human_grounded === true || /(?:reviewer[_-]?id|human[_-]signature|manual[_-]approval|adjudicator[_-]?id)/iu.test(stableJson(item)))) {
    throw new Error("machine_reference_human_provenance_forbidden");
  }
  const byId = new Map(references.map((item) => [String(item.case_id), item]));
  const labeled = cases.map((item) => ({ ...item, reference: byId.get(String(item.case_id)) })).filter((item) => item.reference?.accepted === true && MACHINE_REFERENCE_ROUTES.includes(item.reference?.label?.route));
  const selected = [];
  for (const route of MACHINE_REFERENCE_ROUTES) {
    const quota = MACHINE_REFERENCE_QUOTAS[route];
    const rows = labeled.filter((item) => item.reference.label.route === route).sort((left, right) => sha(left.case_id).localeCompare(sha(right.case_id)));
    if (rows.length < quota) throw new Error(`machine_reference_quota_missing:${route}`);
    selected.push(...rows.slice(0, quota));
  }
  const selectedCases = selected.map(({ reference: _reference, ...item }) => item).sort((left, right) => String(left.case_id).localeCompare(String(right.case_id)));
  const gold = selected.map((item) => ({
    case_id: item.case_id,
    route: item.reference.label.route,
    lesson_type: item.reference.label.lesson_type,
    verification_state: item.reference.label.verification_state,
    required_reason_codes: item.reference.label.required_reason_codes,
    forbidden_reason_codes: item.reference.label.forbidden_reason_codes,
    reference_judge_hashes: item.reference.judgment_hashes ?? [],
    reference_state: "machine_consensus"
  })).sort((left, right) => left.case_id.localeCompare(right.case_id));
  return {
    schema_version: 1,
    dataset_id: options.datasetId ?? MACHINE_REFERENCE_DATASET_ID,
    seed_hash: options.seed_hash ?? null,
    locked: true,
    evaluated: false,
    selected_case_count: selectedCases.length,
    route_counts: Object.fromEntries(MACHINE_REFERENCE_ROUTES.map((route) => [route, gold.filter((item) => item.route === route).length])),
    cases_sha256: sha(stableJson(selectedCases)),
    gold_sha256: sha(stableJson(gold)),
    case_hash: options.case_hash ?? sha(stableJson(cases)),
    selected_case_hash: options.selected_case_hash ?? sha(stableJson(selectedCases)),
    rubric_hash: options.rubric_hash ?? null,
    contract_hash: options.contract_hash ?? null,
    prompt_hash: options.prompt_hash ?? null,
    reason_code_hash: options.reason_code_hash ?? null,
    council_signature: options.council_signature ?? null,
    council_public_key_fingerprint: options.council_public_key_fingerprint ?? null,
    council_key_fingerprints: [...new Set((options.council_key_fingerprints ?? []).map(String).filter(Boolean))],
    ground_truth_basis: "machine_reference",
    human_grounded: false,
    labels_derived_from_runtime: false,
    council_stability: {
      point_estimate: references.length
        ? references.reduce((sum, item) => sum + Number(item.repeat_agreement === 1), 0) / references.length
        : 0
    },
    council_results_present: true,
    privacy: { raw_transcript_copied: false, reasoning_persisted: false, real_credentials_or_pii: false },
    metamorphic: options.metamorphic ?? { pair_count: 0, violation_count: 0 },
    selectedCases,
    gold
  };
}

export function evaluateMachineReferencePredictions({ seal, cases, gold, predictions, observedOutcomes = {} } = {}) {
  if (!seal?.locked || seal.selected_case_count !== 900) throw new Error("machine_reference_seal_invalid");
  if (seal.evaluated === true) throw new Error("machine_reference_seal_already_evaluated_new_version_required");
  if (!MACHINE_REFERENCE_ROUTES.every((route) => Number(seal.route_counts?.[route]) === MACHINE_REFERENCE_QUOTAS[route])) {
    throw new Error("machine_reference_route_quota_invalid");
  }
  if (!Array.isArray(cases) || cases.length !== 900 || new Set(cases.map((item) => String(item?.case_id ?? ""))).size !== cases.length) {
    throw new Error("machine_reference_case_count_or_duplicate_invalid");
  }
  if (!Array.isArray(gold) || gold.length !== 900 || new Set(gold.map((item) => String(item?.case_id ?? ""))).size !== gold.length) {
    throw new Error("machine_reference_gold_count_or_duplicate_invalid");
  }
  if (!Array.isArray(predictions) || predictions.length !== 900 || new Set(predictions.map((item) => String(item?.case_id ?? ""))).size !== predictions.length) {
    throw new Error("machine_reference_prediction_count_or_duplicate_invalid");
  }
  if (predictions.some((item) => Object.hasOwn(item, "gold") || Object.hasOwn(item, "reference") || Object.hasOwn(item, "expected_route"))) {
    throw new Error("machine_reference_prediction_leakage");
  }
  const canonicalCases = [...cases].sort((left, right) => String(left.case_id).localeCompare(String(right.case_id)));
  const canonicalGold = [...gold].sort((left, right) => String(left.case_id).localeCompare(String(right.case_id)));
  if (seal.cases_sha256 && sha(stableJson(canonicalCases)) !== seal.cases_sha256) throw new Error("machine_reference_cases_hash_mismatch");
  if (seal.gold_sha256 && sha(stableJson(canonicalGold)) !== seal.gold_sha256) throw new Error("machine_reference_gold_hash_mismatch");
  const goldById = new Map((gold ?? []).map((item) => [String(item.case_id), item]));
  const predictionById = new Map((predictions ?? []).map((item) => [String(item.case_id), item]));
  const rows = (cases ?? []).map((item) => ({ case_id: item.case_id, gold: goldById.get(item.case_id), prediction: predictionById.get(item.case_id) })).filter((item) => item.gold && item.prediction);
  if (rows.length !== 900) throw new Error("machine_reference_case_gold_prediction_set_mismatch");
  const routeMetrics = Object.fromEntries(MACHINE_REFERENCE_ROUTES.map((route) => {
    const tp = rows.filter((row) => row.gold.route === route && row.prediction.route === route).length;
    const fp = rows.filter((row) => row.gold.route !== route && row.prediction.route === route).length;
    const fn = rows.filter((row) => row.gold.route === route && row.prediction.route !== route).length;
    const precision = tp + fp ? tp / (tp + fp) : null;
    const recall = tp + fn ? tp / (tp + fn) : null;
    const precisionWilsonLower = wilsonLowerBound(tp, tp + fp);
    const recallWilsonLower = wilsonLowerBound(tp, tp + fn);
    return [route, {
      true_positive: tp,
      false_positive: fp,
      false_negative: fn,
      precision,
      recall,
      precision_wilson_lower: precisionWilsonLower,
      recall_wilson_lower: recallWilsonLower,
      passed: precision !== null && recall !== null && precision >= 0.95 && recall >= 0.95 && precisionWilsonLower >= 0.95 && recallWilsonLower >= 0.95
    }];
  }));
  const exact = rows.filter((row) => row.gold.route === row.prediction.route).length;
  const activeHardViolations = rows.filter((row) => row.prediction.route === "active" && row.gold.route !== "active").length;
  const lessonTypeErrors = rows.filter((row) => row.gold.route === "active" && row.prediction.route === "active" && row.gold.lesson_type && row.prediction.lesson_type !== row.gold.lesson_type).length;
  const routeAccuracyWilsonLower = wilsonLowerBound(exact, rows.length);
  const routeAccuracyPassed = rows.length === 900 && exact / rows.length >= 0.95 && routeAccuracyWilsonLower >= 0.95;
  const predictionFlags = (prediction) => {
    const values = [
      ...(Array.isArray(prediction?.hard_guardrails) ? prediction.hard_guardrails : []),
      ...(Array.isArray(prediction?.reason_codes) ? prediction.reason_codes : [])
    ].map((value) => String(value).toLocaleLowerCase());
    const has = (pattern) => values.some((value) => pattern.test(value));
    return {
      credential_or_pii: has(/credential|secret|token|password|pii|personal/u),
      scope_violation: has(/scope|workspace|tenant|repository|repo/u),
      self_attestation: has(/self.?attest|asserted.?success|unverified.?claim/u),
      unsafe: has(/unsafe|security.?boundary|exfiltrat|disable.?safety/u)
    };
  };
  const hardGuardrailCounts = {
    unsupported_active: activeHardViolations,
    credential_or_pii_active: rows.filter((row) => row.prediction.route === "active" && predictionFlags(row.prediction).credential_or_pii).length,
    scope_violation_active: rows.filter((row) => row.prediction.route === "active" && predictionFlags(row.prediction).scope_violation).length,
    self_attestation_active: rows.filter((row) => row.prediction.route === "active" && predictionFlags(row.prediction).self_attestation).length,
    unsafe_active: rows.filter((row) => row.prediction.route === "active" && predictionFlags(row.prediction).unsafe).length,
    lesson_type_misclassification: lessonTypeErrors
  };
  const profileMetrics = Object.fromEntries(MACHINE_REFERENCE_JUDGE_PROFILES.map((profile) => {
    const judged = rows.filter((row) => row.prediction.judge_verdicts && Object.hasOwn(row.prediction.judge_verdicts, profile));
    const predictedPass = (row) => String(row.prediction.judge_verdicts?.[profile]).toLowerCase() === "pass";
    const expectedPass = (row) => row.gold.route === "active";
    const tp = judged.filter((row) => predictedPass(row) && expectedPass(row)).length;
    const fp = judged.filter((row) => predictedPass(row) && !expectedPass(row)).length;
    const fn = judged.filter((row) => !predictedPass(row) && expectedPass(row)).length;
    const precision = tp + fp > 0 ? tp / (tp + fp) : null;
    const recall = tp + fn > 0 ? tp / (tp + fn) : null;
    return [profile, {
      total: judged.length,
      precision,
      recall,
      precision_wilson_lower: wilsonLowerBound(tp, tp + fp),
      recall_wilson_lower: wilsonLowerBound(tp, tp + fn),
      passed: judged.length === rows.length && precision !== null && recall !== null && precision >= 0.95 && recall >= 0.95 && wilsonLowerBound(tp, tp + fp) >= 0.95 && wilsonLowerBound(tp, tp + fn) >= 0.95
    }];
  }));
  const consensusRows = rows.filter((row) => row.prediction.judge_verdicts && typeof row.prediction.judge_verdicts === "object");
  const consensusCorrect = consensusRows.filter((row) => {
    const verdicts = MACHINE_REFERENCE_JUDGE_PROFILES.map((profile) => String(row.prediction.judge_verdicts?.[profile] ?? "").toLowerCase());
    return verdicts.length === MACHINE_REFERENCE_JUDGE_PROFILES.length && new Set(verdicts).size === 1 && ((verdicts[0] === "pass") === (row.gold.route === "active"));
  }).length;
  const consensusPassRows = consensusRows.filter((row) => {
    const verdicts = MACHINE_REFERENCE_JUDGE_PROFILES.map((profile) => String(row.prediction.judge_verdicts?.[profile] ?? "").toLowerCase());
    return verdicts.length === MACHINE_REFERENCE_JUDGE_PROFILES.length && new Set(verdicts).size === 1;
  });
  const consensusTp = consensusPassRows.filter((row) => String(row.prediction.judge_verdicts?.[MACHINE_REFERENCE_JUDGE_PROFILES[0]]).toLowerCase() === "pass" && row.gold.route === "active").length;
  const consensusFp = consensusPassRows.filter((row) => String(row.prediction.judge_verdicts?.[MACHINE_REFERENCE_JUDGE_PROFILES[0]]).toLowerCase() === "pass" && row.gold.route !== "active").length;
  const consensusFn = consensusPassRows.filter((row) => String(row.prediction.judge_verdicts?.[MACHINE_REFERENCE_JUDGE_PROFILES[0]]).toLowerCase() !== "pass" && row.gold.route === "active").length;
  const consensusPrecision = consensusTp + consensusFp ? consensusTp / (consensusTp + consensusFp) : null;
  const consensusRecall = consensusTp + consensusFn ? consensusTp / (consensusTp + consensusFn) : null;
  const consensusMetrics = {
    total: consensusRows.length,
    agreement: consensusRows.length ? consensusRows.filter((row) => new Set(MACHINE_REFERENCE_JUDGE_PROFILES.map((profile) => String(row.prediction.judge_verdicts?.[profile] ?? "").toLowerCase())).size === 1).length / consensusRows.length : null,
    accuracy: consensusRows.length ? consensusCorrect / consensusRows.length : null,
    precision: consensusPrecision,
    recall: consensusRecall,
    precision_wilson_lower: wilsonLowerBound(consensusTp, consensusTp + consensusFp),
    recall_wilson_lower: wilsonLowerBound(consensusTp, consensusTp + consensusFn),
    passed: consensusRows.length === rows.length && consensusRows.length > 0 && consensusCorrect / consensusRows.length >= 0.95 && consensusPrecision >= 0.95 && consensusRecall >= 0.95 && wilsonLowerBound(consensusTp, consensusTp + consensusFp) >= 0.95 && wilsonLowerBound(consensusTp, consensusTp + consensusFn) >= 0.95
  };
  const judgeQualificationPassed = Object.values(profileMetrics).every((metric) => metric.passed) && consensusMetrics.passed === true;
  const passed = rows.length === 900 && Object.values(routeMetrics).every((metric) => metric.passed) && routeAccuracyPassed && Object.values(hardGuardrailCounts).every((count) => count === 0) && judgeQualificationPassed && observedOutcomes.passed === true;
  return {
    schema_version: 1,
    dataset_id: seal.dataset_id,
    dataset_sha256: seal.cases_sha256,
    locked: seal.locked === true,
    selected_case_count: rows.length,
    route_counts: seal.route_counts,
    route_metrics: routeMetrics,
    route_accuracy: { successes: exact, total: rows.length, point_estimate: rows.length ? exact / rows.length : null, wilson_lower: routeAccuracyWilsonLower, passed: rows.length > 0 && exact / rows.length >= 0.95 && routeAccuracyWilsonLower >= 0.95 },
    case_hash: seal.case_hash ?? seal.cases_sha256,
    selected_case_hash: seal.selected_case_hash ?? seal.cases_sha256,
    seed_hash: seal.seed_hash,
    rubric_hash: seal.rubric_hash,
    contract_hash: seal.contract_hash,
    prompt_hash: seal.prompt_hash,
    reason_code_hash: seal.reason_code_hash,
    council_stability: seal.council_stability,
    council_signature: seal.council_signature,
    council_public_key_fingerprint: seal.council_public_key_fingerprint,
    council_key_fingerprints: seal.council_key_fingerprints,
    labels_derived_from_runtime: seal.labels_derived_from_runtime,
    council_results_present: seal.council_results_present,
    structural_errors: [],
    metamorphic: seal.metamorphic,
    privacy: seal.privacy,
    hard_guardrails: hardGuardrailCounts,
    judge_metrics: profileMetrics,
    consensus_metrics: consensusMetrics,
    observed_outcomes: observedOutcomes,
    ground_truth_basis: "machine_reference",
    human_grounded: false,
    passed,
    status: passed ? "qualified" : "not_qualified"
  };
}
