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

export const KNOWLEDGE_RESOURCE_CONTRACT_VERSION = "knowledge-resource/v1" as const;

export const KNOWLEDGE_RESOURCE_KINDS = [
  "document",
  "issue",
  "pull_request",
  "commit",
  "design",
  "runbook",
  "dashboard",
  "dataset",
  "report",
  "test_result",
  "build",
  "release",
  "other"
] as const;

export const KNOWLEDGE_RESOURCE_LOCATION_ROLES = ["canonical", "mirror", "source"] as const;
export const KNOWLEDGE_RESOURCE_VISIBILITIES = ["tenant", "project", "restricted"] as const;
export const KNOWLEDGE_RESOURCE_LIFECYCLE_STATES = ["active", "stale", "retired"] as const;
export const KNOWLEDGE_RESOURCE_EXTRACTION_STATES = ["pending", "ready", "degraded", "failed"] as const;
export const DECISION_SOURCE_TYPES = ["decision_memory", "decision_rationale"] as const;
export const DECISION_RESOURCE_ROLES = [
  "conclusion_source",
  "rationale_source",
  "contradiction",
  "input",
  "implementation_artifact",
  "output_artifact",
  "verification_artifact"
] as const;
export const DECISION_RESOURCE_CONFIRMATION_STATES = ["proposal", "confirmed", "retired"] as const;

export type KnowledgeResourceKind = (typeof KNOWLEDGE_RESOURCE_KINDS)[number];
export type KnowledgeResourceLocationRole = (typeof KNOWLEDGE_RESOURCE_LOCATION_ROLES)[number];
export type KnowledgeResourceVisibility = (typeof KNOWLEDGE_RESOURCE_VISIBILITIES)[number];
export type KnowledgeResourceLifecycleState = (typeof KNOWLEDGE_RESOURCE_LIFECYCLE_STATES)[number];
export type KnowledgeResourceExtractionState = (typeof KNOWLEDGE_RESOURCE_EXTRACTION_STATES)[number];
export type DecisionSourceType = (typeof DECISION_SOURCE_TYPES)[number];
export type DecisionResourceRole = (typeof DECISION_RESOURCE_ROLES)[number];
export type DecisionResourceConfirmationState = (typeof DECISION_RESOURCE_CONFIRMATION_STATES)[number];

const uriSchema = z.string().trim().min(1).max(2048);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u, "must be a lowercase SHA-256 digest");
const snapshotUriSchema = uriSchema.superRefine((value, context) => {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "snapshot URI credentials are forbidden" });
    }
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "snapshot URI must be absolute" });
  }
});

export const decisionRefSchema = z.object({
  source_type: z.enum(DECISION_SOURCE_TYPES),
  source_id: identifierSchema
});

export const resourceLocatorSchema = z.object({
  page: z.number().int().positive().optional(),
  heading: z.string().trim().min(1).max(512).optional(),
  anchor: z.string().trim().min(1).max(512).optional(),
  line_start: z.number().int().positive().optional(),
  line_end: z.number().int().positive().optional(),
  selector: z.string().trim().min(1).max(1024).optional()
}).superRefine((value, context) => {
  if (Object.values(value).every((item) => item === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "locator must identify at least one source position" });
  }
  if (value.line_start && value.line_end && value.line_end < value.line_start) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["line_end"], message: "line_end must be greater than or equal to line_start" });
  }
});

export const knowledgeResourceCreateSchema = z.object({
  contract_version: z.literal(KNOWLEDGE_RESOURCE_CONTRACT_VERSION).default(KNOWLEDGE_RESOURCE_CONTRACT_VERSION),
  tenant_id: z.string().trim().min(1).max(128).optional(),
  project_id: optionalIdentifierSchema.nullable(),
  resource_kind: z.enum(KNOWLEDGE_RESOURCE_KINDS),
  canonical_uri: uriSchema,
  title: z.string().trim().min(1).max(512),
  source_system: z.string().trim().min(1).max(128),
  media_type: z.string().trim().min(1).max(128),
  visibility: z.enum(KNOWLEDGE_RESOURCE_VISIBILITIES).default("tenant"),
  permissions: z.array(z.string().trim().min(1).max(128)).max(64).default([]),
  connector_id: optionalIdentifierSchema.nullable(),
  fetch_enabled: z.boolean().default(false)
});

export const knowledgeResourceVersionCaptureSchema = z.object({
  contract_version: z.literal(KNOWLEDGE_RESOURCE_CONTRACT_VERSION).default(KNOWLEDGE_RESOURCE_CONTRACT_VERSION),
  tenant_id: z.string().trim().min(1).max(128).optional(),
  connector_id: identifierSchema,
  source_version: z.string().trim().min(1).max(256).nullable().optional(),
  etag: z.string().trim().min(1).max(512).nullable().optional(),
  last_modified: z.string().trim().min(1).max(128).nullable().optional(),
  content_hash: sha256Schema,
  snapshot_object_ref: snapshotUriSchema,
  extracted_text: z.string().max(1_000_000),
  extracted_text_hash: sha256Schema,
  extraction_state: z.enum(KNOWLEDGE_RESOURCE_EXTRACTION_STATES).default("ready"),
  captured_at: z.number().int().nonnegative().optional()
});

export const knowledgeResourceLocationCreateSchema = z.object({
  contract_version: z.literal(KNOWLEDGE_RESOURCE_CONTRACT_VERSION).default(KNOWLEDGE_RESOURCE_CONTRACT_VERSION),
  tenant_id: z.string().trim().min(1).max(128).optional(),
  project_id: optionalIdentifierSchema.nullable(),
  resource_id: identifierSchema,
  uri: uriSchema,
  location_role: z.enum(["mirror", "source"]).default("source"),
  connector_id: optionalIdentifierSchema.nullable(),
  fetch_enabled: z.boolean().default(false)
});

export const decisionResourceLinkCreateSchema = z.object({
  contract_version: z.literal(KNOWLEDGE_RESOURCE_CONTRACT_VERSION).default(KNOWLEDGE_RESOURCE_CONTRACT_VERSION),
  tenant_id: z.string().trim().min(1).max(128).optional(),
  project_id: optionalIdentifierSchema.nullable(),
  decision_ref: decisionRefSchema,
  resource_id: identifierSchema,
  role: z.enum(DECISION_RESOURCE_ROLES),
  resource_version_id: identifierSchema.nullable().optional(),
  locator: resourceLocatorSchema.nullable().optional(),
  excerpt_digest: sha256Schema.nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
  confirmation_state: z.enum(DECISION_RESOURCE_CONFIRMATION_STATES).default("confirmed"),
  confidence: z.number().min(0).max(1).default(1),
  idempotency_key: identifierSchema
}).superRefine((value, context) => {
  if (value.confirmation_state === "confirmed" && !value.resource_version_id && [
    "conclusion_source",
    "rationale_source",
    "contradiction"
  ].includes(value.role)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["resource_version_id"],
      message: "confirmed source links must pin a resource version"
    });
  }
  if (value.confirmation_state === "confirmed" && [
    "conclusion_source",
    "rationale_source",
    "contradiction"
  ].includes(value.role)) {
    if (!value.locator) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["locator"], message: "confirmed source links require a locator" });
    }
    if (!value.excerpt_digest) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["excerpt_digest"], message: "confirmed source links require an excerpt digest" });
    }
  }
});

export type DecisionRef = z.infer<typeof decisionRefSchema>;
export type ResourceLocator = z.infer<typeof resourceLocatorSchema>;
export type KnowledgeResourceCreateInput = z.input<typeof knowledgeResourceCreateSchema>;
export type KnowledgeResourceVersionCaptureInput = z.input<typeof knowledgeResourceVersionCaptureSchema>;
export type KnowledgeResourceLocationCreateInput = z.input<typeof knowledgeResourceLocationCreateSchema>;
export type DecisionResourceLinkCreateInput = z.input<typeof decisionResourceLinkCreateSchema>;

export type KnowledgeResource = {
  id: string;
  tenant_id: string;
  project_id: string | null;
  resource_kind: KnowledgeResourceKind;
  canonical_uri: string;
  title: string;
  source_system: string;
  media_type: string;
  visibility: KnowledgeResourceVisibility;
  permissions: string[];
  current_version_id: string | null;
  lifecycle_state: KnowledgeResourceLifecycleState;
  created_at: number;
  updated_at: number;
};

export type DecisionResourceLink = {
  assertion_id: string;
  decision_ref: DecisionRef;
  resource_id: string;
  role: DecisionResourceRole;
  resource_version_id: string | null;
  locator: ResourceLocator | null;
  excerpt_digest: string | null;
  note: string | null;
  confirmation_state: DecisionResourceConfirmationState;
  valid_from: number;
  valid_until: number | null;
  actor: string;
  reviewed_by: string | null;
  created_at: number;
};
