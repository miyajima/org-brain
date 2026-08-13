export type MemoryCaptureHookProfile = {
  schema_version: number;
  profile_id: string;
  source_dataset: string;
  source_dataset_sha256: string | null;
  max_candidates: number;
  accepted_kinds: string[];
  required_fields: string[];
  minimum_rationale_characters: number;
  minimum_reuse_rule_characters: number;
  minimum_evidence_by_kind: Record<string, number>;
  allowed_evidence_types: string[];
  ttl_days_by_kind: Record<string, number>;
  reject_gaps: boolean;
  require_atomic_conclusion: boolean;
  require_distinct_rationale: boolean;
  rejected_example_reasons: string[];
};

export function deriveMemoryCaptureHookProfile(
  dataset: Record<string, unknown>,
  options?: { dataset_sha256?: string }
): MemoryCaptureHookProfile;
export function isVerifiableMemoryEvidence(
  item: Record<string, unknown>,
  profile: MemoryCaptureHookProfile
): boolean;
export function assessMemoryCaptureDraft(
  draft: Record<string, unknown>,
  profile: MemoryCaptureHookProfile
): {
  accepted: boolean;
  reasons: string[];
  verifiable_evidence: Array<Record<string, unknown>>;
  quality_score: number;
};
export function enforceMemoryCaptureHookProfile(
  result: Record<string, unknown>,
  profile: MemoryCaptureHookProfile
): Record<string, unknown>;
