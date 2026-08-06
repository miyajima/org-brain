import { z } from "zod";

export const MEMORY_IMPACT_CONTRACT_VERSION = "memory-impact/v1" as const;

export const MEMORY_IMPACT_EVENT_TYPES = ["eligible", "assessed", "failed"] as const;
export const AVOIDED_LOOKUP_TYPES = ["source_search", "web_search", "past_context", "none"] as const;
export const MEMORY_IMPACT_CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;

export type MemoryImpactEventType = (typeof MEMORY_IMPACT_EVENT_TYPES)[number];
export type AvoidedLookup = (typeof AVOIDED_LOOKUP_TYPES)[number];
export type MemoryImpactConfidence = (typeof MEMORY_IMPACT_CONFIDENCE_LEVELS)[number];

const identifierSchema = z.string().trim().min(1).max(256);
const optionalIdentifierSchema = z.string().trim().min(1).max(256).optional();

export const memoryImpactStartSchema = z.object({
  contract_version: z.literal(MEMORY_IMPACT_CONTRACT_VERSION).default(MEMORY_IMPACT_CONTRACT_VERSION),
  tenant_id: z.string().trim().min(1).max(128).optional(),
  project_id: optionalIdentifierSchema,
  task_id: optionalIdentifierSchema,
  trace_id: optionalIdentifierSchema,
  external_run_id: identifierSchema,
  idempotency_key: identifierSchema,
  agent_name: optionalIdentifierSchema,
  model: optionalIdentifierSchema,
  occurred_at: z.number().int().nonnegative().optional()
});

export const memoryImpactAssessmentSchema = z.object({
  contract_version: z.literal(MEMORY_IMPACT_CONTRACT_VERSION).default(MEMORY_IMPACT_CONTRACT_VERSION),
  tenant_id: z.string().trim().min(1).max(128).optional(),
  idempotency_key: identifierSchema,
  outcome: z.literal("assessed").default("assessed"),
  memory_used: z.boolean(),
  avoided_lookup: z.enum(AVOIDED_LOOKUP_TYPES),
  memory_basis_ids: z.array(identifierSchema).max(20).default([]),
  confidence: z.enum(MEMORY_IMPACT_CONFIDENCE_LEVELS).nullable().optional(),
  occurred_at: z.number().int().nonnegative().optional()
}).superRefine((value, context) => {
  if (!value.memory_used) {
    if (value.avoided_lookup !== "none") {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["avoided_lookup"], message: "avoided_lookup must be none when memory_used is false" });
    }
    if (value.memory_basis_ids.length > 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["memory_basis_ids"], message: "memory_basis_ids must be empty when memory_used is false" });
    }
    if (value.confidence != null) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["confidence"], message: "confidence must be null when memory_used is false" });
    }
    return;
  }
  if (value.memory_basis_ids.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["memory_basis_ids"], message: "memory_basis_ids is required when memory_used is true" });
  }
  if (value.confidence == null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["confidence"], message: "confidence is required when memory_used is true" });
  }
});

export const memoryImpactFailureSchema = z.object({
  contract_version: z.literal(MEMORY_IMPACT_CONTRACT_VERSION).default(MEMORY_IMPACT_CONTRACT_VERSION),
  tenant_id: z.string().trim().min(1).max(128).optional(),
  idempotency_key: identifierSchema,
  outcome: z.literal("failed"),
  failure_category: z.enum(["agent_error", "tool_error", "cancelled", "unknown"]).default("unknown"),
  occurred_at: z.number().int().nonnegative().optional()
});

export const memoryImpactReportSchema = z.union([memoryImpactAssessmentSchema, memoryImpactFailureSchema]);

export type MemoryImpactStartInput = z.infer<typeof memoryImpactStartSchema>;
export type MemoryImpactAssessmentInput = z.infer<typeof memoryImpactAssessmentSchema>;
export type MemoryImpactFailureInput = z.infer<typeof memoryImpactFailureSchema>;
export type MemoryImpactReportInput = z.infer<typeof memoryImpactReportSchema>;

export type MemoryImpactSummary = {
  eligible_runs: number;
  assessed_runs: number;
  failed_runs: number;
  memory_used_runs: number;
  avoided_runs: number;
  reporting_rate: number | null;
  memory_usage_rate: number | null;
  avoided_lookup_rate: number | null;
  by_avoided_lookup: Record<AvoidedLookup, number>;
};
