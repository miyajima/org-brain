export type EvidenceStatus = "sufficient" | "degraded" | "insufficient" | "conflicted";

export type EvidenceDisposition = {
  evidence_status: EvidenceStatus;
  missing_evidence: string[];
  degraded_reasons: string[];
  abstention_recommended: boolean;
};

export function deriveEvidenceDisposition(input: {
  evidenceCount: number;
  independentSourceCount: number;
  requiresMultipleSources: boolean;
  conflictCount: number;
  hasDegradedExtraction: boolean;
  hasLowConfidence: boolean;
  degradedReasons?: string[];
}): EvidenceDisposition;

export function evidenceAnswerTemplate(
  disposition: EvidenceDisposition,
  shape: {
    hasTimeline: boolean;
    hasCurrentState: boolean;
    requiresMultipleSources: boolean;
  }
): "profile" | "timeline" | "multi_session" | "abstention" | "evidence";

export const EVIDENCE_STATUSES: readonly EvidenceStatus[];
export function requiresMultipleEvidenceSources(query: unknown): boolean;

export type AnswerGuidance = {
  response_mode: "answer" | "answer_with_warning" | "abstain";
  evidence_status: EvidenceStatus;
  required_elements: Array<"conclusion" | "status" | "evidence" | "next_action">;
  prohibited_elements: Array<"internal_ids" | "raw_memory" | "unsupported_claims">;
  source_refs: string[];
  instructions: string;
};

export const ANSWER_GUIDANCE_REQUIRED_ELEMENTS: readonly ["conclusion", "status", "evidence", "next_action"];
export const ANSWER_GUIDANCE_PROHIBITED_ELEMENTS: readonly ["internal_ids", "raw_memory", "unsupported_claims"];
export function answerGuidanceForDisposition(
  disposition: EvidenceDisposition,
  sourceRefs?: Array<string | { ref?: string | null } | null>
): AnswerGuidance;
export function renderAnswerGuidanceMarkdown(guidance: Omit<AnswerGuidance, "instructions"> | AnswerGuidance): string;
