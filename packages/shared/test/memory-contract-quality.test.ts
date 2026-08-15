import { describe, expect, it } from "vitest";
import {
  certifyMemoryContractQuality,
  evaluateAiJudgeConsensus,
  evaluateMemoryIngestionOracleQualification,
  evaluateMemoryIngestionCalibrationQualification,
  evaluateMemoryContractMeasurement,
  evaluateMemoryContractPerformance,
  wilsonInterval
} from "../src/memory-quality-certifier";
import {
  buildMemoryContractJudgeRequest,
  isAiConsensusCertified,
  runMemoryContractJudgeConsensus
} from "../src/memory-contract-judge";

function qualifiedOracle() {
  return {
    schema_version: 1,
    dataset_id: "orgbrain-memory-ingestion-oracle-v1",
    dataset_sha256: `sha256:${"a".repeat(64)}`,
    locked: true,
    passed: true,
    status: "qualified",
    total_cases: 40,
    layer_counts: { contract: 14, verification: 11, routing: 15 },
    route_counts: { active: 3, review: 2, excluded: 10 },
    label_mismatch_count: 0,
    metamorphic_pair_count: 8,
    metamorphic_violation_count: 0,
    duplicate_ids: 0,
    leakage_violations: 0,
    structural_errors: [],
    labels_static: true,
    labels_derived_from_runtime: false
  };
}

function qualifiedCalibration() {
  const perfectMetric = { passed: true, precision: 1, recall: 1, precision_wilson_lower: 1, recall_wilson_lower: 1 };
  return {
    schema_version: 1,
    dataset_id: "orgbrain-memory-ingestion-calibration-v1",
    dataset_sha256: `sha256:${"b".repeat(64)}`,
    case_hash: `sha256:${"1".repeat(64)}`,
    selected_case_hash: `sha256:${"2".repeat(64)}`,
    seed_hash: `sha256:${"c".repeat(64)}`,
    rubric_hash: `sha256:${"d".repeat(64)}`,
    contract_hash: `sha256:${"e".repeat(64)}`,
    prompt_hash: `sha256:${"f".repeat(64)}`,
    reason_code_hash: `sha256:${"0".repeat(64)}`,
    locked: true,
    passed: true,
    status: "qualified",
    selected_case_count: 900,
    route_counts: { active: 300, review: 300, excluded: 300 },
    reviewer_agreement: { route_agreement: 1, route_cohen_kappa: 1, reason_code_micro_f1: 1 },
    route_metrics: { active: perfectMetric, review: perfectMetric, excluded: perfectMetric },
    route_accuracy: { passed: true, point_estimate: 1, wilson_lower: 1 },
    reason_code_required: { passed: true },
    reason_code_forbidden: { passed: true },
    lesson_type_errors: 0,
    judge_metrics: {
      evidence_entailment: { passed: true },
      durability_atomicity: { passed: true },
      future_reuse_overgeneralization: { passed: true }
    },
    judge_class_counts: {
      evidence_entailment: { pass: 300, fail: 600 },
      durability_atomicity: { pass: 300, fail: 600 },
      future_reuse_overgeneralization: { pass: 300, fail: 600 }
    },
    judge_consensus_metrics: { passed: true },
    ai_judge_results_present: true,
    metamorphic: { pair_count: 90, violation_count: 0 },
    hard_guardrails: { unsupported_active: 0 },
    structural_errors: [],
    labels_static: true,
    labels_derived_from_runtime: false,
    privacy: { raw_transcript_copied: false, runtime_predictions_in_gold: false, real_credentials_or_pii: false }
  };
}

describe("Memory Contract v2 quality gates", () => {
  it("keeps Wilson bounds explicit instead of certifying a small perfect sample", () => {
    const interval = wilsonInterval(19, 20);
    expect(interval.lower).toBeLessThan(0.95);
    expect(interval.upper).toBeLessThanOrEqual(1);
  });

  it("enforces hook latency and 200-turn smoke gates independently", () => {
    expect(evaluateMemoryContractPerformance({
      pre_tool_use_p95_ms: 99,
      post_tool_use_p95_ms: 249,
      stop_p95_ms: 2499,
      hard_timeout_count: 0,
      api_5xx_count: 0,
      cloudflare_1102_count: 0,
      smoke_turns: 200
    }).passed).toBe(true);
    expect(evaluateMemoryContractPerformance({
      pre_tool_use_p95_ms: 100,
      post_tool_use_p95_ms: 249,
      stop_p95_ms: 2499,
      hard_timeout_count: 0,
      api_5xx_count: 0,
      cloudflare_1102_count: 0,
      smoke_turns: 200
    }).passed).toBe(false);
  });

  it("fails closed when decision continuity omits its re-ask measurement", () => {
    expect(evaluateMemoryContractMeasurement({
      axis: "decision_continuity",
      successes: 300,
      total: 300
    }).passed).toBe(false);
  });

  it("certifies each KPI and cohort independently, with no aggregate score", () => {
    const measurements = [
      { axis: "verified_knowledge_correctness", cohort: "decision/codex", successes: 999, total: 1_000 },
      { axis: "durable_knowledge_coverage", cohort: "success/codex", successes: 999, total: 1_000 },
      { axis: "decision_continuity", cohort: "compaction/codex", successes: 300, total: 300, reask_count: 0 }
    ];
    const result = certifyMemoryContractQuality({
      measurements,
      oracle_qualification: qualifiedOracle(),
      calibration_qualification: qualifiedCalibration(),
      judgments: [
        { judge_name: "entailment", model_family: "family-a", verdict: "pass" },
        { judge_name: "durability", model_family: "family-b", verdict: "pass" },
        { judge_name: "reuse", model_family: "family-a", verdict: "pass" }
      ]
    }, {
      requiredAxes: ["verified_knowledge_correctness", "durable_knowledge_coverage", "decision_continuity"],
      requireCorpus: false
    });
    expect(result.certification).toBe("oracle_certified");
    expect(result.aggregate_score).toBeNull();
    expect(result.measurements).toHaveLength(3);
    expect(result.measurements.every((measurement) => measurement.passed)).toBe(true);
  });

  it("requires a locked independent ingestion oracle before overall certification", () => {
    expect(evaluateMemoryIngestionOracleQualification({}).status).toBe("insufficient_evidence");
    expect(evaluateMemoryIngestionOracleQualification(qualifiedOracle()).pass).toBe(true);
    expect(evaluateMemoryIngestionOracleQualification({
      ...qualifiedOracle(),
      labels_derived_from_runtime: true
    }).pass).toBe(false);
    const result = certifyMemoryContractQuality({
      measurements: [{ axis: "decision_continuity", successes: 300, total: 300, reask_count: 0 }],
      judgments: [
        { judge_name: "entailment", model_family: "family-a", verdict: "pass" },
        { judge_name: "durability", model_family: "family-b", verdict: "pass" },
        { judge_name: "reuse", model_family: "family-a", verdict: "pass" }
      ]
    }, { requiredAxes: ["decision_continuity"], requireCorpus: false });
    expect(result.certification).toBe("not_certified");
    expect(result.oracle_qualification.status).toBe("insufficient_evidence");
  });

  it("requires an independent calibration report in addition to the conformance oracle", () => {
    expect(evaluateMemoryIngestionCalibrationQualification({}).status).toBe("insufficient_evidence");
    expect(evaluateMemoryIngestionCalibrationQualification(qualifiedCalibration()).pass).toBe(true);
    const result = certifyMemoryContractQuality({
      measurements: [{ axis: "decision_continuity", successes: 300, total: 300, reask_count: 0 }],
      oracle_qualification: qualifiedOracle(),
      judgments: [
        { judge_name: "entailment", model_family: "family-a", verdict: "pass" },
        { judge_name: "durability", model_family: "family-b", verdict: "pass" },
        { judge_name: "reuse", model_family: "family-a", verdict: "pass" }
      ]
    }, { requiredAxes: ["decision_continuity"], requireCorpus: false });
    expect(result.certification).toBe("not_certified");
    expect(result.calibration_qualification.status).toBe("insufficient_evidence");
  });

  it("requires the locked corpus minimums and keeps session splits isolated", () => {
    const result = certifyMemoryContractQuality({
      measurements: [{ axis: "decision_continuity", successes: 300, total: 300, reask_count: 0 }],
      corpus: {
        counts: {
          success: 75,
          decision: 75,
          failure: 75,
          non_durable_turn: 200,
          next_task_retrieval: 300,
          continuity: {
            same_key_reask: 75,
            paraphrase: 75,
            compaction_resume: 75,
            change_conflict_scope: 75
          }
        },
        cases: [{ session_hash: "sha256:shared", split: "train" }, { session_hash: "sha256:shared", split: "test" }]
      }
    }, { requiredAxes: ["decision_continuity"] });
    expect(result.status).toBe("insufficient_evidence");
    expect(result.corpus.split_violations).toHaveLength(1);
  });

  it("fails closed on hard violations even when the point estimate is high", () => {
    const result = certifyMemoryContractQuality({
      measurements: [{ axis: "decision_continuity", successes: 300, total: 300, reask_count: 0 }],
      hard_violations: [{ type: "same_decision_key_reask", count: 1 }]
    }, { requiredAxes: ["decision_continuity"], requireCorpus: false, requireOracleQualification: false, requireCalibrationQualification: false });
    expect(result.status).toBe("not_certified");
    expect(result.hard_guardrails.find((guardrail) => guardrail.name === "same_decision_key_reask")?.passed).toBe(false);
  });

  it("does not trust a bare AI pass without the three judge records", () => {
    const result = certifyMemoryContractQuality({
      measurements: [{ axis: "decision_continuity", successes: 300, total: 300, reask_count: 0 }],
      judge_consensus: { pass: true }
    }, { requiredAxes: ["decision_continuity"], requireCorpus: false, requireOracleQualification: false, requireCalibrationQualification: false });
    expect(result.status).toBe("not_certified");
  });

  it("requires three independent judges, at least two model families, and unanimity", () => {
    const pass = evaluateAiJudgeConsensus([
      { judge_name: "entailment", model_family: "family-a", verdict: "pass", support: ["e1"] },
      { judge_name: "durability", model_family: "family-b", verdict: "pass", support: ["e2"] },
      { judge_name: "reuse", model_family: "family-a", verdict: "pass", support: ["e3"] }
    ]);
    expect(pass.certification).toBe("ai_consensus_certified");

    const disagreement = evaluateAiJudgeConsensus([
      { judge_name: "entailment", model_family: "family-a", verdict: "pass" },
      { judge_name: "durability", model_family: "family-b", verdict: "fail" },
      { judge_name: "reuse", model_family: "family-a", verdict: "pass" }
    ]);
    expect(disagreement.status).toBe("ai_review_pending/disagreed");

    const sameFamily = evaluateAiJudgeConsensus([
      { judge_name: "entailment", model_family: "family-a", verdict: "pass" },
      { judge_name: "durability", model_family: "family-a", verdict: "pass" },
      { judge_name: "reuse", model_family: "family-a", verdict: "pass" }
    ]);
    expect(sameFamily.status).toBe("insufficient_evidence");
  });

  it("runs judge profiles independently and keeps only verdict metadata", async () => {
    const requests: Record<string, unknown>[] = [];
    const result = await runMemoryContractJudgeConsensus(
      { observation: { lesson_type: "success", procedure: "Use the verified command" }, verification: { state: "verified", evidence: [{ type: "command", ref: "sha256:abc" }] } },
      {
        evidence_entailment: async (request) => { requests.push(request as Record<string, unknown>); return { verdict: "pass", reason_codes: [], support: ["command-1"], model_family: "family-a" }; },
        durability_atomicity: async (request) => { requests.push(request as Record<string, unknown>); return { verdict: "pass", reason_codes: [], support: ["procedure"], model_family: "family-b" }; },
        future_reuse_overgeneralization: async (request) => { requests.push(request as Record<string, unknown>); return { verdict: "pass", reason_codes: [], support: ["reuse_when"], model_family: "family-a" }; }
      }
    );
    expect(result.certification).toBe("ai_consensus_certified");
    expect(isAiConsensusCertified({ ai_certification: result.certification, judge_consensus: result })).toBe(true);
    expect(isAiConsensusCertified({
      ai_certification: result.certification,
      judge_consensus: {
        ...result,
        judgments: result.judgments.map((judgment, index) => index === 0 ? { ...judgment, prompt_hash: "sha256:wrong" } : judgment)
      }
    })).toBe(false);
    expect(isAiConsensusCertified({
      ai_certification: result.certification,
      judge_consensus: {
        ...result,
        judgments: result.judgments.map((judgment, index) => index === 0 ? { ...judgment, judge_name: "unregistered-judge" } : judgment)
      }
    })).toBe(false);
    expect(isAiConsensusCertified({
      ai_certification: result.certification,
      judge_consensus: {
        ...result,
        judgments: result.judgments.map((judgment, index) => index === 0 ? { ...judgment, model_family: "family-b" } : judgment)
      }
    })).toBe(false);
    expect(requests).toHaveLength(3);
    expect(requests.every((request) => request.temperature === 0)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("reasoning");
    expect(buildMemoryContractJudgeRequest({ raw_transcript: "must not be sent" }, "evidence_entailment").candidate).toEqual({
      observation: {},
      verification: { state: "unverified", reason_codes: [], evidence: [] }
    });
    expect(buildMemoryContractJudgeRequest({
      observation: { lesson_type: "success" },
      evidence: [{ evidence_type: "command", evidence_ref: "rtk node --version", content_hash: "sha256:abc" }]
    }, "evidence_entailment").candidate.verification.evidence[0]).toMatchObject({
      type: "command",
      ref: "rtk node --version",
      content_hash: "sha256:abc"
    });
  });
});
