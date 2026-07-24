import { z } from "zod";
import {
  AGENT_MESSAGE_STATUSES,
  AGENT_MESSAGE_TARGET_TYPES,
  CAPABILITIES
} from "./constants";

export const createTaskSchema = z.object({
  tenant_id: z.string().min(1).default("default").optional(),
  project_id: z.string().min(1).optional(),
  capability: z.enum(CAPABILITIES),
  priority: z.number().int().min(0).max(100).default(0).optional(),
  input_ref: z.string().min(1),
  constraints: z.record(z.unknown()).optional(),
  idempotency_key: z.string().min(1).optional(),
  trace_id: z.string().min(1).optional(),
  wait_event_type: z.string().min(1).optional(),
  measurement_mode: z.boolean().optional(),
  measurement_session_id: z.string().min(1).optional(),
  measurement_unit: z.enum(["task", "session"]).default("task").optional(),
  measurement_reference_model: z.string().min(1).default("estimated_tokens_v1").optional()
});

export const leaseAcquireSchema = z.object({
  task_id: z.string().min(1),
  ttl_ms: z.number().int().min(1000).max(60 * 60 * 1000).default(60_000).optional(),
  max_concurrency: z.number().int().min(1).max(100).optional()
});

export const leaseReleaseSchema = z.object({
  task_id: z.string().min(1)
});

export const mailboxPushSchema = z.object({
  type: z.string().min(1),
  payload: z.record(z.unknown()),
  ts: z.number().int().optional()
});

export const agentMessageTargetSchema = z.object({
  target_type: z.enum(AGENT_MESSAGE_TARGET_TYPES),
  target_key: z.string().trim().min(1).max(256)
});

export const sendAgentMessageSchema = z.object({
  tenant_id: z.string().min(1).optional().default("default"),
  project_id: z.string().min(1).nullable().optional(),
  target_type: z.enum(AGENT_MESSAGE_TARGET_TYPES),
  target_key: z.string().trim().min(1).max(256),
  subject: z.string().max(500).nullable().optional(),
  body: z.string().min(1).max(20_000),
  metadata: z.record(z.unknown()).optional(),
  thread_id: z.string().min(1).max(128).optional(),
  reply_to_message_id: z.string().min(1).max(128).optional(),
  idempotency_key: z.string().min(1).max(256).optional()
});

export const listAgentMessagesSchema = z.object({
  tenant_id: z.string().min(1).optional().default("default"),
  project_id: z.string().min(1).nullable().optional(),
  target_type: z.enum(AGENT_MESSAGE_TARGET_TYPES).optional(),
  target_key: z.string().trim().min(1).max(256).optional(),
  status: z.union([z.enum(AGENT_MESSAGE_STATUSES), z.literal("active")]).optional().default("active"),
  limit: z.number().int().min(1).max(200).optional().default(50),
  cursor: z.number().int().positive().optional()
});

export const agentMessageActionSchema = z.object({
  tenant_id: z.string().min(1).optional().default("default"),
  target_type: z.enum(AGENT_MESSAGE_TARGET_TYPES).optional(),
  target_key: z.string().trim().min(1).max(256).optional()
});
