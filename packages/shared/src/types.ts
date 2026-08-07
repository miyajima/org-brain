import type { CapabilityName } from "./constants";

export type EnvelopeType = "task.created" | "task.result";

export type Envelope<TPayload extends Record<string, unknown> = Record<string, unknown>> = {
  message_id: string;
  tenant_id: string;
  project_id?: string;
  trace_id?: string;
  type: EnvelopeType;
  ts: number;
  idempotency_key?: string;
  payload: TPayload;
};

export type TaskCreatedPayload = {
  task_id: string;
  capability: CapabilityName;
  priority: number;
  input_ref: string;
  constraints?: Record<string, unknown>;
  wait_event_type?: string;
  measurement?: {
    run_id: string;
    session_id?: string;
    unit: "task" | "session";
    variant: "control" | "treatment";
    reference_model: string;
    memory_enabled: boolean;
    memory_write_enabled: boolean;
  };
};

export type TaskResultPayload = {
  task_id: string;
  capability: CapabilityName;
  status: "succeeded" | "failed";
  output_ref?: string;
  error?: {
    code: string;
    message: string;
  };
  wait_event_type?: string;
  memory_effect?: {
    usage_event_id: string;
    idempotency_key: string;
    evidence_level?: "reported" | "estimated" | "verified" | "unverifiable";
    supersedes_effect_id?: string | null;
    effect_outcome: "positive" | "neutral" | "negative" | "unknown";
    avoided_lookup_categories?: Array<"source_search" | "web_search" | "past_context" | "none">;
    gross_saved_tokens_estimate?: number;
    token_estimation_candidates?: {
      paired_control_tokens?: number;
      safe_replay_tokens?: number;
      avoided_source_tokens?: number;
      failure_pattern_median_tokens?: number;
      category_median_tokens?: number;
      text_size_heuristic_tokens?: number;
    };
    injected_tokens?: number;
    net_saved_tokens_estimate?: number;
    estimate_lower_bound?: number | null;
    estimate_upper_bound?: number | null;
    estimation_method?: string | null;
    estimator_version?: string | null;
    estimate_confidence?: number | null;
    failure_pattern_id?: string | null;
    failure_opportunity_state?: "applicable" | "not_applicable" | "unknown";
    action_changed?: boolean;
    alternative_executed?: boolean;
    failure_avoided?: boolean;
    failure_saved_tokens_estimate?: number;
    verification_ref_type?: string | null;
    verification_ref_id?: string | null;
    estimated_tool_calls_saved?: number | null;
    estimated_seconds_saved?: number | null;
    attributions?: Array<{ usage_item_id: string; attribution_weight: number }>;
  };
};

export type CreateTaskInput = {
  tenant_id?: string;
  project_id?: string;
  capability: CapabilityName;
  priority?: number;
  input_ref: string;
  constraints?: Record<string, unknown>;
  idempotency_key?: string;
  trace_id?: string;
  wait_event_type?: string;
  measurement_mode?: boolean;
  measurement_session_id?: string;
  measurement_unit?: "task" | "session";
  measurement_reference_model?: string;
};
