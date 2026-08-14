import { describe, expect, it } from "vitest";
import {
  certifyMemoryContractQuality,
  evaluateAiJudgeConsensus,
  evaluateMemoryContractMeasurement,
  evaluateMemoryContractPerformance,
  wilsonInterval
} from "../src/memory-quality-certifier";
import {
  buildMemoryContractJudgeRequest,
  isAiConsensusCertified,
  runMemoryContractJudgeConsensus
} from "../src/memory-contract-judge";

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
    const result = certifyMemoryContractQuality({ measurements }, {
      requiredAxes: ["verified_knowledge_correctness", "durable_knowledge_coverage", "decision_continuity"],
      requireCorpus: false
    });
    expect(result.certification).toBe("oracle_certified");
    expect(result.aggregate_score).toBeNull();
    expect(result.measurements).toHaveLength(3);
    expect(result.measurements.every((measurement) => measurement.passed)).toBe(true);
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
    }, { requiredAxes: ["decision_continuity"], requireCorpus: false });
    expect(result.status).toBe("not_certified");
    expect(result.hard_guardrails.find((guardrail) => guardrail.name === "same_decision_key_reask")?.passed).toBe(false);
  });

  it("does not trust a bare AI pass without the three judge records", () => {
    const result = certifyMemoryContractQuality({
      measurements: [{ axis: "decision_continuity", successes: 300, total: 300, reask_count: 0 }],
      judge_consensus: { pass: true }
    }, { requiredAxes: ["decision_continuity"], requireCorpus: false });
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
