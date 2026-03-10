export const TASK_STATUSES = [
  "created",
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled"
] as const;

export const CAPABILITIES = ["plan_writer", "code_gen", "code_review"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type CapabilityName = (typeof CAPABILITIES)[number];
