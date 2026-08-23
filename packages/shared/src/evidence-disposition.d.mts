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
