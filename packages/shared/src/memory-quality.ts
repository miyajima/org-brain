import {
  assessMemoryUsefulnessV1 as assessMemoryUsefulnessV1Runtime,
  assessMemoryUsefulness as assessMemoryUsefulnessRuntime,
  classifyMemoryQuality as classifyMemoryQualityRuntime,
  isLowSignalMemory as isLowSignalMemoryRuntime
} from "./memory-quality-runtime.mjs";

export type MemoryQualityInput = {
  id?: string | null;
  project_id?: string | null;
  source?: string | null;
  summary?: string | null;
  content?: string | null;
  assistantText?: string | null;
  tags?: string[] | null;
  tags_json?: string | null;
  kind?: string | null;
  lifecycle_state?: string | null;
  created_at?: number | null;
  utility_score?: number | null;
  confidence_score?: number | null;
  expires_at?: number | null;
};

export type MemoryQualityOptions = {
  keepProjectFacts?: boolean;
};

export const CAPTURE_ROUTES = [
  "realtime_hook",
  "initial_import",
  "manual",
  "repair",
  "legacy"
] as const;

export type CaptureRoute = (typeof CAPTURE_ROUTES)[number];

export type MemoryUsefulnessDimensionsV1 = {
  semantic_completeness: number;
  evidence_support: number;
  rationale_quality: number;
  future_reuse: number;
  scope_specificity: number;
  freshness_validity: number;
  atomicity: number;
};

export type MemoryUsefulnessAssessmentV1 = {
  schema_version: 1;
  route: "active" | "quarantine" | "excluded";
  quality_dimensions: MemoryUsefulnessDimensionsV1;
  reason_codes: string[];
  hard_violations: string[];
};

export type MemoryUsefulnessInputV1 = {
  content?: string | null;
  summary?: string | null;
  rationale?: string | null;
  reuse_rule?: string | null;
  learning?: Record<string, unknown> | null;
  evidence?: Array<Record<string, unknown>> | null;
  source_references?: Array<Record<string, unknown>> | null;
  quality_dimensions?: Record<string, number> | null;
  capture_origin?: string | null;
  verification_state?: string | null;
  verified_at?: number | null;
  valid_until?: number | null;
  expires_at?: number | null;
  conflicts?: string[] | null;
  reason_codes?: string[] | null;
  ai_certification?: string | null;
  judge_consensus?: Record<string, unknown> | null;
  now?: number;
};

export type MemoryQualityDecision = {
  action: "delete" | "keep" | "promote";
  quality: string;
  reason: string;
};

export type MemoryQualityAssessment = MemoryQualityDecision & {
  category: string;
  summary: string;
  utility_score: number;
  confidence_score: number;
  expires_at: number | null;
  expires_reason: string | null;
  risky_low_signal: boolean;
  suppression_candidate: boolean;
  short_summary_candidate: boolean;
  artifact_expiry_candidate: boolean;
  temporary: boolean;
};

export function assessMemoryUsefulness(
  input: MemoryQualityInput,
  options: MemoryQualityOptions = {}
): MemoryQualityAssessment {
  return assessMemoryUsefulnessRuntime(input, options);
}

export function assessMemoryUsefulnessV1(input: MemoryUsefulnessInputV1): MemoryUsefulnessAssessmentV1 {
  return assessMemoryUsefulnessV1Runtime(input) as MemoryUsefulnessAssessmentV1;
}

export function classifyMemoryQuality(
  input: MemoryQualityInput,
  options: MemoryQualityOptions = {}
): MemoryQualityDecision {
  return classifyMemoryQualityRuntime(input, options);
}

export function isLowSignalMemory(input: MemoryQualityInput, options: MemoryQualityOptions = {}): boolean {
  return isLowSignalMemoryRuntime(input, options);
}
