import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CALIBRATION_CANDIDATE_COUNT,
  CALIBRATION_LOCKED_COUNT,
  CALIBRATION_STRATUM_QUOTAS,
  buildCalibrationSeal,
  casesHash,
  evaluateCalibrationPredictions,
  evaluateCalibrationQualification,
  generateCalibrationCandidates,
  prepareCalibrationReviewBundle,
  signCalibrationAdjudication,
  signCalibrationReview,
  validateCalibrationCaseInputs,
  validateCalibrationReview
} from "./memory-ingestion-calibration.mjs";
import { predictCalibrationCases } from "./memory-ingestion-calibration-predictor.mjs";
import { runCalibrationCanary } from "./memory-ingestion-calibration-canary.mjs";

function annotationForFamily(family, caseId) {
  const route = family.startsWith("active_") ? "active" : family.startsWith("review_") ? "review" : "excluded";
  const lessonType = family.startsWith("active_") ? family.slice("active_".length) : null;
  const requiredReasonCodes = {
    active_success: [],
    active_decision: [],
    active_failure: [],
    review_evidence_gap: ["gaps_present"],
    review_observe_incomplete: ["command_attestation_invalid"],
    review_conflict_scope: ["cross_tenant_or_scope_injection"],
    review_durable_final: ["review_intent"],
    excluded_transient: ["final_answer_self_attestation"],
    excluded_self_attested: ["final_answer_self_attestation"],
    excluded_credential: ["credential_detected"],
    excluded_pii: ["sensitive_default_deny"],
    excluded_unsafe: ["sensitive_default_deny"],
    excluded_automation: ["cross_tenant_or_scope_injection"],
    excluded_subagent: ["cross_tenant_or_scope_injection"],
    excluded_workspace: ["cross_tenant_or_scope_injection"],
    excluded_structural: ["invalid_event"],
    excluded_duplicate: ["canonical_duplicate"]
  }[family] ?? ["invalid_event"];
  return {
    case_id: caseId,
    route,
    stratum: family,
    lesson_type: lessonType,
    verification_state: route === "active" ? "verified" : route === "review" ? "partial" : "unverified",
    required_reason_codes: requiredReasonCodes,
    forbidden_reason_codes: requiredReasonCodes.includes("credential_detected") ? ["sensitive_default_deny"] : ["credential_detected"],
    judge_expectations: {
      evidence_entailment: route === "active" ? "pass" : "fail",
      durability_atomicity: route === "active" ? "pass" : "fail",
      future_reuse_overgeneralization: route === "active" ? "pass" : "fail"
    },
    criterion_refs: [`fixture:${family}`]
  };
}

function familySequenceForTest() {
  const sequence = [];
  for (const [family, count] of Object.entries(CALIBRATION_STRATUM_QUOTAS)) {
    for (let index = 0; index < count; index += 1) sequence.push(family);
  }
  const reserve = ["active_success", "active_decision", "active_failure", "review_evidence_gap", "review_observe_incomplete", "review_conflict_scope", "review_durable_final", "excluded_structural"];
  for (let index = sequence.length; index < CALIBRATION_CANDIDATE_COUNT; index += 1) sequence.push(reserve[(index - 900) % reserve.length]);
  return sequence;
}

async function keyFile(directory, name) {
  const pair = generateKeyPairSync("ed25519");
  const privatePath = join(directory, `${name}.pem`);
  await writeFile(privatePath, pair.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  return privatePath;
}

test("calibration generator is blind, private, and has the planned 1,200-case shape", async () => {
  const generated = await generateCalibrationCandidates({ seed: "test-calibration-seed" });
  assert.equal(generated.cases.length, CALIBRATION_CANDIDATE_COUNT);
  assert.equal(generated.metadata.length, CALIBRATION_CANDIDATE_COUNT);
  assert.equal(generated.privacy.labels_derived_from_runtime, false);
  assert.equal(JSON.stringify(generated.metadata).includes("active_success"), false);
  assert.equal(validateCalibrationCaseInputs(generated.cases, { count: CALIBRATION_CANDIDATE_COUNT }).passed, true);
  const bundle = prepareCalibrationReviewBundle(generated.cases, "A");
  assert.equal(bundle.length, CALIBRATION_CANDIDATE_COUNT);
  assert.equal(JSON.stringify(bundle).includes("route_hint_for_generation_only"), false);
  assert.equal(JSON.stringify(bundle).includes("expected_route"), false);
  assert.equal(JSON.stringify(bundle).includes("gold"), false);
  const leaked = structuredClone(generated.cases);
  leaked[0].rows[0].payload.cwd = "/Users/real-user/private";
  assert.equal(validateCalibrationCaseInputs(leaked).passed, false);
});

test("two signed reviews and a third-party adjudication produce a 900-case locked seal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-calibration-test-"));
  try {
    const generated = await generateCalibrationCandidates({ seed: "seal-test-seed" });
    const cases = generated.cases;
    const sequence = familySequenceForTest();
    const annotations = generated.metadata.map((item, index) => annotationForFamily(sequence[index], item.case_id));
    const reviewValidation = validateCalibrationReview(cases, annotations);
    assert.equal(reviewValidation.passed, true);
    const casesSha = casesHash(cases);
    const keyA = await keyFile(directory, "review-a");
    const keyB = await keyFile(directory, "review-b");
    const keyC = await keyFile(directory, "adjudicator");
    const reviewA = signCalibrationReview({ schema_version: 1, dataset_id: "orgbrain-memory-ingestion-calibration-v1", cases_sha256: casesSha, reviewer_slot: "A", reviewer_id_hash: `sha256:${"a".repeat(64)}`, annotations }, keyA);
    const reviewB = signCalibrationReview({ schema_version: 1, dataset_id: "orgbrain-memory-ingestion-calibration-v1", cases_sha256: casesSha, reviewer_slot: "B", reviewer_id_hash: `sha256:${"b".repeat(64)}`, annotations }, keyB);
    const adjudication = signCalibrationAdjudication({ schema_version: 1, dataset_id: "orgbrain-memory-ingestion-calibration-v1", cases_sha256: casesSha, annotations: [] }, keyC);
    const sealed = buildCalibrationSeal(cases, reviewA, reviewB, adjudication);
    assert.equal(sealed.seal.selected_case_count, CALIBRATION_LOCKED_COUNT);
    assert.deepEqual(sealed.seal.route_counts, { active: 300, review: 300, excluded: 300 });
    assert.ok(sealed.seal.metamorphic_pair_count >= 90);
    assert.match(sealed.seal.seed_hash, /^sha256:[a-f0-9]{64}$/u);
    assert.match(sealed.seal.contract_hash, /^sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(sealed.seal.judge_class_counts.evidence_entailment, { pass: 300, fail: 600 });
    assert.equal(sealed.selectedGold.every((item) => item.reviewer_signature_hashes.length === 2 && ["agreed", "adjudicated"].includes(item.adjudication_state)), true);
    const predictions = sealed.selectedGold.map((item) => ({
      case_id: item.case_id,
      route: item.route,
      lesson_type: item.lesson_type,
      verification_state: item.verification_state,
      reason_codes: item.required_reason_codes,
      judge_verdicts: item.judge_expectations,
      hard_guardrails: []
    }));
    const aiJudgeResults = sealed.selectedGold.map((item) => ({ case_id: item.case_id, judge_verdicts: item.judge_expectations }));
    const report = evaluateCalibrationPredictions({ seal: sealed.seal, cases: sealed.sealedCases, gold: sealed.selectedGold, predictions, aiJudgeResults });
    assert.equal(report.passed, true);
    assert.equal(evaluateCalibrationQualification(report).pass, true);
    const replayReport = evaluateCalibrationPredictions({ seal: { ...sealed.seal, evaluated: true }, cases: sealed.sealedCases, gold: sealed.selectedGold, predictions, aiJudgeResults });
    assert.equal(replayReport.structural_errors.includes("seal_already_evaluated_new_version_required"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("calibration qualification rejects missing AI judge results and Wilson-bound failures", () => {
  const result = evaluateCalibrationQualification({
    schema_version: 1,
    dataset_id: "orgbrain-memory-ingestion-calibration-v1",
    dataset_sha256: `sha256:${"a".repeat(64)}`,
    locked: true,
    passed: true,
    status: "qualified",
    selected_case_count: 900,
    route_counts: { active: 300, review: 300, excluded: 300 },
    reviewer_agreement: { route_agreement: 1, route_cohen_kappa: 1, reason_code_micro_f1: 1 },
    route_metrics: { active: { passed: false }, review: { passed: true }, excluded: { passed: true } },
    route_accuracy: { passed: true },
    reason_code_required: { passed: true },
    reason_code_forbidden: { passed: true },
    lesson_type_errors: 0,
    judge_metrics: { evidence_entailment: { passed: true }, durability_atomicity: { passed: true }, future_reuse_overgeneralization: { passed: true } },
    ai_judge_results_present: false,
    metamorphic: { pair_count: 90, violation_count: 0 },
    hard_guardrails: {},
    structural_errors: [],
    labels_static: true,
    labels_derived_from_runtime: false
  });
  assert.equal(result.pass, false);
  assert.equal(result.checks.route_metrics, false);
  assert.equal(result.checks.ai_judge_results_present, false);
});

test("the default predictor executes the importer without receiving gold labels", async () => {
  const generated = await generateCalibrationCandidates({ seed: "predictor-test-seed" });
  const predictions = await predictCalibrationCases(generated.cases.slice(0, 4));
  assert.equal(predictions.length, 4);
  assert.ok(predictions.every((item) => ["active", "review", "excluded"].includes(item.route)));
  assert.equal(JSON.stringify(predictions).includes("expected_route"), false);
  assert.equal(JSON.stringify(predictions).includes("gold"), false);
});

test("real-session canary remains insufficient without 200 turns and 50-case audits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-calibration-canary-test-"));
  try {
    const sessionsRoot = join(directory, "sessions");
    const output = join(directory, "canary.json");
    await mkdir(sessionsRoot, { recursive: true });
    await writeFile(join(sessionsRoot, "automation.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { id: "automation-case", cwd: process.cwd(), thread_source: "automation" } })}\n`);
    const result = await runCalibrationCanary({
      get(name, fallback) {
        return ({ "--workspace": process.cwd(), "--sessions-root": sessionsRoot, "--output": output, "--min-turns": "200" }[name] ?? fallback);
      }
    }, { schemaVersion: 1, datasetId: "orgbrain-memory-ingestion-calibration-v1" });
    process.exitCode = 0;
    assert.equal(result.status, "insufficient_evidence");
    assert.equal(result.audit_samples_complete, false);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(result).includes("automation-case"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
