import { z } from "zod";
import { CAPABILITIES } from "./constants";

export const createTaskSchema = z.object({
  tenant_id: z.string().min(1).default("default").optional(),
  project_id: z.string().min(1).optional(),
  capability: z.enum(CAPABILITIES),
  priority: z.number().int().min(0).max(100).default(0).optional(),
  input_ref: z.string().min(1),
  constraints: z.record(z.unknown()).optional(),
  idempotency_key: z.string().min(1).optional(),
  trace_id: z.string().min(1).optional(),
  wait_event_type: z.string().min(1).optional()
});

export const workflowStartSchema = z.object({
  tenant_id: z.string().min(1).default("default").optional(),
  project_id: z.string().min(1),
  spec_ref: z.string().min(1)
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
