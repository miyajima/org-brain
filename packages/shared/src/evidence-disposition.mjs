export const EVIDENCE_STATUSES = Object.freeze([
  "sufficient",
  "degraded",
  "insufficient",
  "conflicted"
]);

const MULTI_SOURCE_QUERY = /\b(?:and|compare|both|between|combined|together|across|how many|multiple|two|three|four|five)\b|(?:かつ|両方|比較|合計|複数|二件|2件|三件|3件)/iu;

export function requiresMultipleEvidenceSources(query) {
  return MULTI_SOURCE_QUERY.test(String(query ?? ""));
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

export function deriveEvidenceDisposition(input) {
  const missingEvidence = [];
  if (input.evidenceCount === 0) missingEvidence.push("no_relevant_evidence");
  if (input.requiresMultipleSources && input.independentSourceCount < 2) {
    missingEvidence.push("insufficient_independent_sessions");
  }

  const degradedReasons = uniqueStrings([
    ...(input.degradedReasons ?? []),
    ...(input.hasDegradedExtraction ? ["gemini_structured_extractor_not_configured"] : []),
    ...(input.hasLowConfidence ? ["low_confidence_evidence"] : [])
  ]);

  const evidenceStatus = input.conflictCount > 0
    ? "conflicted"
    : missingEvidence.length > 0
      ? "insufficient"
      : degradedReasons.length > 0
        ? "degraded"
        : "sufficient";

  return {
    evidence_status: evidenceStatus,
    missing_evidence: uniqueStrings(missingEvidence),
    degraded_reasons: degradedReasons,
    abstention_recommended: evidenceStatus === "insufficient" || evidenceStatus === "conflicted"
  };
}

export function evidenceAnswerTemplate(disposition, shape) {
  if (disposition.abstention_recommended) return "abstention";
  if (shape.hasTimeline) return "timeline";
  if (shape.hasCurrentState) return "profile";
  if (shape.requiresMultipleSources) return "multi_session";
  return "evidence";
}
