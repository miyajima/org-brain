export const MEMORY_CAPTURE_HOOK_PROFILE: Readonly<{
  schema_version: number;
  profile_id: string;
  source_dataset: string;
  source_dataset_sha256: string;
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
}>;
