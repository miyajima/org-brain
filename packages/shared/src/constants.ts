export const TASK_STATUSES = [
  "created",
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled"
] as const;

export const CAPABILITIES = ["memory_measurement"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type CapabilityName = (typeof CAPABILITIES)[number];
