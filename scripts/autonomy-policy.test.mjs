import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceAutonomyMode,
  buildQuarantineCandidate,
  classifyAutonomyRisk,
  decideAutonomyAction,
  evaluateAutonomyConsensus,
  evaluateAutonomyCanary,
  evaluateAutonomyPostApply,
  normalizeAutonomyPolicy,
  tuneAutonomyPolicy
} from "../packages/shared/src/autonomy-policy.mjs";
import { certifyMemoryContractQuality, evaluateMemoryIngestionAutonomousQualification } from "../packages/shared/src/memory-quality-certifier.mjs";
import { TaskCommitmentStore } from "../packages/orgbrain-cli/src/lib/task-commitment-store.mjs";
import { autonomyPolicyFromWorkspaceEntry } from "../packages/orgbrain-cli/src/lib/workspace-config.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const passingJudgments = () => [
  { judge_name: "evidence", model_family: "family-a", model_version: "a-1", verdict: "pass", confidence: 0.99, prompt_hash: "sha256:e" },
  { judge_name: "durability", model_family: "family-b", model_version: "b-1", verdict: "pass", confidence: 0.99, prompt_hash: "sha256:d" },
  { judge_name: "reuse", model_family: "family-c", model_version: "c-1", verdict: "pass", confidence: 0.99, prompt_hash: "sha256:r" }
];

test("autonomy policy normalizes bounded defaults and preserves deny execution", () => {
  const policy = normalizeAutonomyPolicy({ profile: "balanced", judge: { execution: "deny" } });
  assert.equal(policy.mode, "shadow");
  assert.equal(policy.judge.execution, "deny");
  assert.equal(policy.maintenance.physical_delete, "retention_policy_only");
  assert.throws(() => normalizeAutonomyPolicy({ tuning: { minimum_confidence_bound: 0.99, maximum_confidence_bound: 0.96 } }), /bounds are inverted/);
  assert.equal(autonomyPolicyFromWorkspaceEntry({ memory_learning_mode: "on" }).mode, "guarded");
  assert.equal(autonomyPolicyFromWorkspaceEntry({ memory_learning_mode: "off" }).mode, "shadow");
});

test("consensus requires distinct profiles, model families, versions and confidence", () => {
  const result = evaluateAutonomyConsensus(passingJudgments());
  assert.equal(result.pass, true);
  assert.equal(evaluateAutonomyConsensus(passingJudgments(), { requireSignatures: true }).pass, false);
  assert.equal(evaluateAutonomyConsensus(passingJudgments().map((row, index) => ({
    ...row,
    candidate_hash: `sha256:${String(index + 1).repeat(64)}`,
    signature: `signature-${index}`,
    public_key_fingerprint: `key-${index}`,
    support_selector: [`evidence-${index}`]
  })), { requireSignatures: true }).pass, true);
  assert.equal(result.status, "certified");
  assert.equal(evaluateAutonomyConsensus(passingJudgments().slice(0, 2)).quarantine, true);
  assert.equal(evaluateAutonomyConsensus(passingJudgments().map((row) => ({ ...row, model_family: "same" }))).pass, false);
});

test("risk tiers quarantine uncertain semantic changes and never promote in shadow", () => {
  assert.equal(classifyAutonomyRisk("index_rebuild"), 0);
  assert.equal(classifyAutonomyRisk("summary_revise"), 1);
  assert.equal(classifyAutonomyRisk("active_promotion"), 2);
  const policy = normalizeAutonomyPolicy({ mode: "autonomous" });
  assert.equal(decideAutonomyAction({ action: "active_promotion", policy, deterministic: { passed: true }, judgments: passingJudgments(), candidate: { route: "active" } }).action, "apply");
  assert.equal(decideAutonomyAction({ action: "active_promotion", policy, deterministic: { passed: false }, judgments: passingJudgments(), candidate: { route: "active" } }).action, "quarantine");
  assert.equal(decideAutonomyAction({ action: "summary_revise", policy, deterministic: { passed: true }, judgments: passingJudgments() }).action, "apply");
  assert.equal(decideAutonomyAction({ action: "summary_revise", policy: { ...policy, mode: "shadow" }, deterministic: { passed: true }, judgments: passingJudgments() }).action, "shadow");
  assert.equal(decideAutonomyAction({ action: "index_rebuild", policy: { ...policy, mode: "shadow" }, deterministic: { passed: true } }).action, "apply");
});

test("quarantine has deterministic expiry metadata and post-apply failures request rollback", () => {
  const now = 1_700_000_000_000;
  const item = buildQuarantineCandidate({ candidate_hash: "candidate-1", reason_codes: ["ai_consensus_required"] }, normalizeAutonomyPolicy(), now);
  assert.equal(item.route, "quarantine");
  assert.equal(item.next_evaluation_at, now + 24 * 60 * 60 * 1000);
  assert.equal(evaluateAutonomyPostApply({ hard_violations: 1, retrieval_coverage: 1, failed_operations: 0 }).rollback_required, true);
});

test("canary qualification is independent, bounded, and fail-closed", () => {
  const passing = evaluateAutonomyCanary({
    turns: 200,
    active_candidates: 200,
    quarantine_audit_samples: 50,
    excluded_audit_samples: 50,
    observed_days: 7,
    reask_rate: 0.01,
    retrieval_coverage: 0.99
  });
  assert.equal(passing.passed, true);
  assert.equal(evaluateAutonomyCanary({ ...passing.values, disagreement_count: 1 }).passed, false);
  assert.equal(evaluateAutonomyCanary({ turns: 199 }).status, "insufficient_evidence");
});

test("tuning is bounded and mode advancement is evidence-driven", () => {
  const policy = normalizeAutonomyPolicy({ mode: "shadow" });
  const tuned = tuneAutonomyPolicy(policy, { minimum_confidence_delta: -0.5 });
  assert.equal(Math.abs(tuned.delta), 0.01);
  assert.equal(tuneAutonomyPolicy(policy, { minimum_confidence_delta: -0.5, weekly_delta_used: 0.009 }).delta, -0.001);
  const upperBoundPolicy = normalizeAutonomyPolicy({
    mode: "shadow",
    judge: { minimum_confidence: 0.995 },
    tuning: { minimum_confidence_bound: 0.95, maximum_confidence_bound: 0.995 }
  });
  const upperBound = tuneAutonomyPolicy(upperBoundPolicy, { minimum_confidence_delta: 0.01 });
  assert.equal(upperBound.policy.judge.minimum_confidence, 0.995);
  assert.equal(upperBound.delta, 0);
  assert.equal(advanceAutonomyMode(policy, { machine_reference_qualified: true, canary_qualified: true }).mode, "guarded");
  assert.equal(advanceAutonomyMode({ ...policy, mode: "guarded" }, { observed_outcomes_qualified: true, rollback_ready: true }).mode, "autonomous");
});

test("autonomous qualification is accepted without human reviewer provenance", () => {
  const hash = `sha256:${"a".repeat(64)}`;
  const perfectMetric = { passed: true, precision: 1, recall: 1, precision_wilson_lower: 1, recall_wilson_lower: 1 };
  const qualification = evaluateMemoryIngestionAutonomousQualification({
    schema_version: 1,
    dataset_id: "orgbrain-memory-ingestion-machine-reference-v1",
    dataset_sha256: hash,
    case_hash: hash,
    selected_case_hash: hash,
    seed_hash: hash,
    rubric_hash: hash,
    contract_hash: hash,
    prompt_hash: hash,
    reason_code_hash: hash,
    locked: true,
    passed: true,
    status: "qualified",
    selected_case_count: 900,
    route_counts: { active: 300, quarantine: 300, excluded: 300 },
    route_metrics: { active: perfectMetric, quarantine: perfectMetric, excluded: perfectMetric },
    judge_metrics: {
      evidence_entailment: perfectMetric,
      durability_atomicity: perfectMetric,
      future_reuse_overgeneralization: perfectMetric,
      adversarial_critic: perfectMetric,
      policy_consistency: perfectMetric
    },
    consensus_metrics: perfectMetric,
    route_accuracy: { passed: true, point_estimate: 1, wilson_lower: 1 },
    council_stability: { point_estimate: 1 },
    hard_guardrails: {
      unsupported_active: 0,
      credential_or_pii_active: 0,
      scope_violation_active: 0,
      self_attestation_active: 0,
      unsafe_active: 0,
      lesson_type_misclassification: 0
    },
    metamorphic: { pair_count: 90, violation_count: 0 },
    observed_outcomes: { passed: true },
    council_signature: "signed-council",
    council_key_fingerprints: ["key-a", "key-b", "key-c"],
    ground_truth_basis: "machine_reference",
    privacy: { raw_transcript_copied: false, reasoning_persisted: false, real_credentials_or_pii: false },
    council_results_present: true,
    labels_derived_from_runtime: false,
    human_grounded: false,
    structural_errors: []
  });
  assert.equal(qualification.pass, true);
  const certified = certifyMemoryContractQuality({
    measurements: [],
    autonomous_qualification: qualification
  }, {
    requiredAxes: [],
    requireCorpus: false,
    requireOracleQualification: false,
    requireCalibrationQualification: true,
    requireAutonomousQualification: true,
    requireJudgeConsensus: false
  });
  assert.equal(certified.certification, "autonomous_qualified");
  assert.equal(certifyMemoryContractQuality({}, {
    requiredAxes: [],
    requireCorpus: false,
    requireOracleQualification: false,
    requireCalibrationQualification: false,
    requireAutonomousQualification: true,
    requireJudgeConsensus: false
  }).status, "insufficient_evidence");
});

test("quarantine candidates are re-evaluated automatically without a human queue", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orgbrain-quarantine-"));
  try {
    const store = new TaskCommitmentStore(path.join(directory, "memory.sqlite"));
    await store.saveLearningCandidates({
      tenantId: "default",
      projectId: "example",
      candidates: [{ external_key: "candidate:automatic", reason_codes: ["ai_consensus_required"], item: { learning: { schema_version: 2 } } }]
    });
    const result = await store.maintainLearningCandidates({
      tenantId: "default",
      evaluate: async () => ({ route: "active", verified: true, consensus_pass: true }),
      promote: async () => ({ ok: true, memory_count: 1 })
    });
    assert.equal(result.reevaluated, 1);
    assert.equal(result.promoted, 1);
    assert.equal(result.promoted_memory_count, 1);
    const db = store.open();
    try {
      assert.equal(db.prepare("SELECT status FROM memory_learning_candidates WHERE external_key = ?").get("candidate:automatic").status, "verified");
    } finally {
      db.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
