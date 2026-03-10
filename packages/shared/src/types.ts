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
  wait_event_type?: string;
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
};
