export const TASK_STATUSES = [
  "created",
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled"
] as const;

export const CAPABILITIES = ["memory_measurement", "skill_generation"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type CapabilityName = (typeof CAPABILITIES)[number];

export const AGENT_MESSAGE_TARGET_TYPES = [
  "principal",
  "agent",
  "project",
  "channel"
] as const;

export const AGENT_MESSAGE_STATUSES = [
  "unread",
  "read",
  "acked",
  "archived"
] as const;

export type AgentMessageTargetType = (typeof AGENT_MESSAGE_TARGET_TYPES)[number];
export type AgentMessageStatus = (typeof AGENT_MESSAGE_STATUSES)[number];
