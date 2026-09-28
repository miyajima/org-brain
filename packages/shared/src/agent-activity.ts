import { z } from "zod";

export const AGENT_ACTIVITY_SCHEMA_VERSION = "agent-activity/v1" as const;

export const agentActivityV1Schema = z.object({
  id: z.string().min(1),
  schema_version: z.literal(AGENT_ACTIVITY_SCHEMA_VERSION),
  tenant_id: z.string().min(1),
  project_id: z.string().min(1).nullable(),
  occurred_at: z.string().datetime(),
  sequence: z.number().int().positive().nullable(),
  harness_name: z.enum(["codex", "claude", "cursor", "opencode", "openclaw", "unknown"]),
  collection_method: z.enum(["hook", "plugin", "otlp", "poll", "manual"]),
  fidelity: z.enum(["observed", "inferred"]),
  action: z.string().min(1).max(128),
  category: z.enum(["session", "tool", "command", "file", "approval", "mcp", "token", "model", "other"]),
  session_id: z.string().min(1).max(256).nullable(),
  tool_call_id: z.string().min(1).max(256).nullable(),
  model: z.string().min(1).max(256).nullable(),
  provider: z.string().min(1).max(128).nullable(),
  tokens: z.object({
    input: z.number().int().nonnegative().nullable(),
    output: z.number().int().nonnegative().nullable(),
    cache_read: z.number().int().nonnegative().nullable(),
    cache_write: z.number().int().nonnegative().nullable()
  }),
  metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
  content: z.null(),
  source_event_hash: z.string().regex(/^[a-f0-9]{64}$/u)
});

export type AgentActivityV1 = z.infer<typeof agentActivityV1Schema>;

export const activitySecurityRuleSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/u),
  version: z.number().int().positive(),
  maturity: z.enum(["experimental", "stable"]),
  severity: z.enum(["low", "medium", "high", "critical"]),
  field: z.enum(["command_class", "file_class", "result_status", "approval_state"]),
  equals: z.string().min(1).max(128),
  fixtures: z.object({
    positive: z.array(z.string().min(1)).min(1),
    negative: z.array(z.string().min(1)).min(1)
  })
});

export type ActivitySecurityRule = z.infer<typeof activitySecurityRuleSchema>;
