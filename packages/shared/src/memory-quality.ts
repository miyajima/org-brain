import {
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

export function classifyMemoryQuality(
  input: MemoryQualityInput,
  options: MemoryQualityOptions = {}
): MemoryQualityDecision {
  return classifyMemoryQualityRuntime(input, options);
}

export function isLowSignalMemory(input: MemoryQualityInput, options: MemoryQualityOptions = {}): boolean {
  return isLowSignalMemoryRuntime(input, options);
}
