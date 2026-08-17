import type { MemoryMapTraceResponse } from "@org-brain/contracts";
import { describe, expect, it } from "vitest";
import { buildMemoryMapTraceView, evidenceClaimKeys, normalizeTraceStep } from "./memory-map-trace-view";

function fixture(overrides: Partial<MemoryMapTraceResponse> = {}): MemoryMapTraceResponse {
  return {
    contract_version: "memory-map-trace/v1",
    selected: { node_type: "decision", id: "decision:r1", memory_id: "m1", decision_rationale_id: "r1" },
    memory: {
      id: "m1",
      project_id: "org-brain",
      kind: "decision",
      summary: "Use the canonical API URL.",
      lifecycle_state: "active",
      verification_state: "verified",
      verified_at: 1,
      reuse_rule: "Reuse for every local client.",
      learning: null,
      versions: []
    },
    selected_rationale_id: "r1",
    rationales: [{
      id: "r1",
      decision_type: "architecture",
      conclusion: "Use ORGBRAIN_API_URL.",
      reason_summary: "One canonical setting prevents environment drift.",
      status: "accepted",
      confirmation_state: "confirmed",
      confidence_score: 0.98,
      created_at: 1,
      confirmed_at: 1,
      derived: {
        lesson_type: "decision",
        decision_key: "canonical_api_url",
        decision: "Use ORGBRAIN_API_URL.",
        selected_value: "ORGBRAIN_API_URL",
        rationale: "One canonical setting prevents environment drift.",
        trigger: "Two clients used different variables.",
        question: "Which variable is canonical?",
        alternatives: [{ alternative: "ORGBRAIN_API_BASE", reason_rejected: "Compatibility alias only." }],
        constraints: ["Keep old clients readable."],
        reuse_when: "Configuring an Org Brain client.",
        outcome: "All clients resolve the same endpoint.",
        symptom: null,
        failed_approach: null,
        root_cause: null,
        correction: null,
        verified_outcome: null,
        avoidance_rule: null
      },
      evidence: [{
        id: "e1",
        evidence_type: "file",
        evidence_ref: "docs/config.md",
        relation: "supports:decision,rationale",
        note: "The documented environment contract.",
        weight_score: 1,
        content_hash: "hash",
        observed_at: 1,
        attestation_ref: null
      }],
      resources: {
        sources: [{ availability: "readable" } as never],
        artifacts: [{ availability: "readable" } as never]
      }
    }],
    completeness: { rationale_count: 1, evidence_count: 1, source_count: 1, artifact_count: 1, missing: [], partial: false, truncated: false },
    ...overrides
  };
}

describe("memory map trace view model", () => {
  it("normalizes a confirmed decision into the four-stage path", () => {
    const view = buildMemoryMapTraceView(fixture());
    expect(view.rationaleId).toBe("r1");
    expect(view.isFailure).toBe(false);
    expect(view.stages).toEqual([
      { id: "decision", state: "available", count: 1 },
      { id: "reason", state: "available", count: 3 },
      { id: "evidence", state: "available", count: 2 },
      { id: "artifact", state: "available", count: 1 }
    ]);
  });

  it("distinguishes missing, unverified, and truncated stages", () => {
    const payload = fixture();
    payload.memory.verification_state = "pending";
    payload.rationales[0].resources.artifacts = [];
    payload.completeness.truncated = true;
    const stages = buildMemoryMapTraceView(payload).stages;
    expect(stages.find((stage) => stage.id === "evidence")?.state).toBe("unverified");
    expect(stages.find((stage) => stage.id === "artifact")?.state).toBe("missing");

    payload.memory.verification_state = "verified";
    expect(buildMemoryMapTraceView(payload).stages.find((stage) => stage.id === "evidence")?.state).toBe("truncated");
  });

  it("uses failure-specific semantics when a root cause is present", () => {
    const payload = fixture();
    payload.rationales[0].derived.lesson_type = "failure";
    payload.rationales[0].derived.root_cause = "The retry generated a new attempt key.";
    expect(buildMemoryMapTraceView(payload).isFailure).toBe(true);
  });

  it("maps known evidence claims and safely groups unknown relations", () => {
    expect(evidenceClaimKeys("supports:decision,rationale")).toEqual(["decision", "reason"]);
    expect(evidenceClaimKeys("supports:root_cause verification")).toEqual(["cause", "verification"]);
    expect(evidenceClaimKeys("mentions:decision")).toEqual(["other"]);
  });

  it("defaults invalid shared steps to decision", () => {
    expect(normalizeTraceStep("artifact")).toBe("artifact");
    expect(normalizeTraceStep("raw-transcript")).toBe("decision");
  });
});
