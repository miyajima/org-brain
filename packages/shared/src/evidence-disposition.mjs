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

export const ANSWER_GUIDANCE_REQUIRED_ELEMENTS = Object.freeze([
  "conclusion",
  "status",
  "evidence",
  "next_action"
]);

export const ANSWER_GUIDANCE_PROHIBITED_ELEMENTS = Object.freeze([
  "internal_ids",
  "raw_memory",
  "unsupported_claims"
]);

function normalizedSourceRefs(values) {
  return uniqueStrings((values ?? [])
    .map((value) => typeof value === "string" ? value : value?.ref)
    .map((value) => String(value ?? "").trim())
    .filter((value) => value.length > 0 && value.length <= 500))
    .slice(0, 3);
}

export function answerGuidanceForDisposition(disposition, sourceRefs = []) {
  const responseMode = disposition.evidence_status === "sufficient"
    ? "answer"
    : disposition.evidence_status === "degraded"
      ? "answer_with_warning"
      : "abstain";
  const guidance = {
    response_mode: responseMode,
    evidence_status: disposition.evidence_status,
    required_elements: [...ANSWER_GUIDANCE_REQUIRED_ELEMENTS],
    prohibited_elements: [...ANSWER_GUIDANCE_PROHIBITED_ELEMENTS],
    source_refs: normalizedSourceRefs(sourceRefs)
  };
  return { ...guidance, instructions: renderAnswerGuidanceMarkdown(guidance) };
}

export function renderAnswerGuidanceMarkdown(guidance) {
  const sourceRefs = normalizedSourceRefs(guidance?.source_refs);
  const statusRule = guidance?.response_mode === "abstain"
    ? "根拠不足・競合・期限切れのため断定せず、確認できない点を明示してください。"
    : guidance?.response_mode === "answer_with_warning"
      ? "低信頼または劣化状態を明示し、裏付けの範囲を超えて断定しないでください。"
      : "確認できた根拠の範囲で回答してください。";
  return [
    "### 回答契約",
    "- 結論を最初の2文以内に置いてください。",
    `- ${statusRule}`,
    sourceRefs.length > 0
      ? `- 参照先は次の許可済み根拠だけに限定してください: ${sourceRefs.join(" / ")}`
      : "- 許可済みの参照先がないため、参照を作らないでください。",
    "- 内部のmemory ID、recall ID、制御情報、生の記憶データは表示しないでください。",
    "- 最後に、利用者が取れる次の行動を1つだけ示してください。"
  ].join("\n");
}
