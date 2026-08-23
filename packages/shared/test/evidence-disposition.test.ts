import { describe, expect, it } from "vitest";
import {
  deriveEvidenceDisposition,
  evidenceAnswerTemplate,
  requiresMultipleEvidenceSources
} from "../src/evidence-disposition";

describe("evidence disposition", () => {
  it("detects cross-session and Japanese multi-source requests", () => {
    expect(requiresMultipleEvidenceSources("what changed across three sessions")).toBe(true);
    expect(requiresMultipleEvidenceSources("複数資料を比較して")).toBe(true);
    expect(requiresMultipleEvidenceSources("show the rollout policy")).toBe(false);
  });

  it("keeps useful evidence actionable when optional extraction is degraded", () => {
    const disposition = deriveEvidenceDisposition({
      evidenceCount: 1,
      independentSourceCount: 1,
      requiresMultipleSources: false,
      conflictCount: 0,
      hasDegradedExtraction: true,
      hasLowConfidence: false,
      degradedReasons: ["onnx_embedding_not_configured"]
    });

    expect(disposition).toEqual({
      evidence_status: "degraded",
      missing_evidence: [],
      degraded_reasons: [
        "onnx_embedding_not_configured",
        "gemini_structured_extractor_not_configured"
      ],
      abstention_recommended: false
    });
    expect(evidenceAnswerTemplate(disposition, {
      hasTimeline: false,
      hasCurrentState: false,
      requiresMultipleSources: false
    })).toBe("evidence");
  });

  it("abstains when no relevant evidence exists", () => {
    const disposition = deriveEvidenceDisposition({
      evidenceCount: 0,
      independentSourceCount: 0,
      requiresMultipleSources: false,
      conflictCount: 0,
      hasDegradedExtraction: false,
      hasLowConfidence: false
    });
    expect(disposition.evidence_status).toBe("insufficient");
    expect(disposition.missing_evidence).toEqual(["no_relevant_evidence"]);
    expect(disposition.abstention_recommended).toBe(true);
  });

  it("requires two independent sources for an explicit comparison", () => {
    const disposition = deriveEvidenceDisposition({
      evidenceCount: 2,
      independentSourceCount: 1,
      requiresMultipleSources: true,
      conflictCount: 0,
      hasDegradedExtraction: false,
      hasLowConfidence: false
    });
    expect(disposition.evidence_status).toBe("insufficient");
    expect(disposition.missing_evidence).toEqual(["insufficient_independent_sessions"]);
  });

  it("treats conflicts as blocking and low confidence as non-blocking", () => {
    const conflicted = deriveEvidenceDisposition({
      evidenceCount: 2,
      independentSourceCount: 2,
      requiresMultipleSources: false,
      conflictCount: 1,
      hasDegradedExtraction: false,
      hasLowConfidence: true
    });
    expect(conflicted.evidence_status).toBe("conflicted");
    expect(conflicted.abstention_recommended).toBe(true);
    expect(conflicted.degraded_reasons).toContain("low_confidence_evidence");

    const lowConfidence = deriveEvidenceDisposition({
      evidenceCount: 1,
      independentSourceCount: 1,
      requiresMultipleSources: false,
      conflictCount: 0,
      hasDegradedExtraction: false,
      hasLowConfidence: true
    });
    expect(lowConfidence.evidence_status).toBe("degraded");
    expect(lowConfidence.abstention_recommended).toBe(false);
  });
});
