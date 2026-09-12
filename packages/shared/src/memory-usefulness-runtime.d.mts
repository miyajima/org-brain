export const MEMORY_USEFULNESS_CONTRACT: "memory-usefulness/v2";
export const MEMORY_REVIEW_LABELS: readonly string[];
export type MemoryUsefulnessV2Input = {
  stage?: "capture" | "use";
  basis?: "prediction" | "human_confirmation" | "observed";
  evidence_supported?: boolean | null;
  applicable?: boolean | null;
  task_contribution?: boolean | null;
  incremental_value?: boolean | null;
  within_budget?: boolean | null;
  source_available?: boolean | null;
  project_id?: string | null;
  task_project_id?: string | null;
  valid_until?: number | null;
  expires_at?: number | null;
  now?: number;
};
export type MemoryUsefulnessV2Assessment = {
  contract: "memory-usefulness/v2";
  stage: "capture" | "use";
  basis: "prediction" | "human_confirmation" | "observed";
  axes: Record<"grounding" | "applicability" | "task_contribution" | "incremental_value" | "information_amount", {
    status: "supported" | "unsupported" | "unknown"; basis: string;
  }>;
  disposition: "exclude" | "reduce" | "needs_evidence" | "eligible";
  reason_codes: string[];
};
export function assessMemoryUsefulnessV2(input?: MemoryUsefulnessV2Input): MemoryUsefulnessV2Assessment;
export function classifyMemoryReviewAnswer(value: unknown): "accepted" | "corrected" | "not_needed" | "incorrect" | "not_decided" | "deferred" | "unknown";
