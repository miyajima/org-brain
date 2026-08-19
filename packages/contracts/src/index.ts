import { z } from "zod";

export * from "./domain-pack.js";

export const MEMORY_IMPACT_CONTRACT_VERSION = "memory-impact/v1" as const;

export const IDENTITY_CONTRACT_VERSION = "identity/v1" as const;
export const USER_STATUSES = ["invited", "active", "suspended", "deprovisioned"] as const;
export const USER_PROVISION_SOURCES = ["email", "oidc", "scim", "legacy"] as const;
export const GROUP_SOURCES = ["local", "scim"] as const;
export const BUSINESS_WORK_TYPES = [
  "implementation",
  "review",
  "debug",
  "proposal",
  "support",
  "research",
  "operations",
  "other"
] as const;

export type UserStatus = (typeof USER_STATUSES)[number];
export type UserProvisionSource = (typeof USER_PROVISION_SOURCES)[number];
export type GroupSource = (typeof GROUP_SOURCES)[number];
export type BusinessWorkType = (typeof BUSINESS_WORK_TYPES)[number];

const principalSchema = z.string().trim().min(1).max(128);
const emailSchema = z.string().trim().email().max(254).transform((value) => value.toLowerCase());

export const userSummarySchema = z.object({
  principal: principalSchema,
  display_name: z.string().trim().min(1).max(120),
  avatar_url: z.string().url().max(500).nullable().default(null),
  status: z.enum(USER_STATUSES)
});

export const userPrivateProfileSchema = userSummarySchema.extend({
  tenant_id: z.string().trim().min(1).max(128),
  full_name: z.string().trim().min(1).max(200).nullable().default(null),
  email: emailSchema.nullable().default(null),
  email_verified: z.boolean().default(false),
  provision_source: z.enum(USER_PROVISION_SOURCES),
  full_name_source: z.enum(USER_PROVISION_SOURCES),
  created_at: z.number().int().nonnegative().nullable(),
  updated_at: z.number().int().nonnegative().nullable()
});

export const organizationSchema = z.object({
  tenant_id: z.string().trim().min(1).max(128),
  slug: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/u),
  display_name: z.string().trim().min(1).max(160),
  allowed_email_domains: z.array(z.string().trim().toLowerCase().max(253)).max(50).default([]),
  email_self_registration_enabled: z.boolean().default(false)
});

export const businessCategorySchema = z.object({
  id: z.string().trim().min(1).max(128),
  tenant_id: z.string().trim().min(1).max(128),
  slug: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u),
  label: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1000).nullable().default(null),
  is_active: z.boolean().default(true),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative()
});

export const scimRoleMappingSchema = z.object({
  group_id: z.string().trim().min(1).max(128),
  role: z.enum(["tenant_admin", "project_owner", "contributor", "reader", "service_agent", "auditor"]),
  project_id: z.string().trim().min(1).max(128).nullable().default(null)
});

export type UserSummary = z.infer<typeof userSummarySchema>;
export type UserPrivateProfile = z.infer<typeof userPrivateProfileSchema>;
export type Organization = z.infer<typeof organizationSchema>;
export type BusinessCategory = z.infer<typeof businessCategorySchema>;
export type ScimRoleMapping = z.infer<typeof scimRoleMappingSchema>;

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

export const MEMORY_MAP_TRACE_CONTRACT_VERSION = "memory-map-trace/v1" as const;

export const memoryMapTraceQuerySchema = z.object({
  tenant_id: z.string().trim().min(1).max(128).optional(),
  project_id: z.string().trim().min(1).max(256).optional(),
  scope: z.enum(["mine", "org"]).default("org"),
  memory_id: z.string().trim().min(1).max(256).optional(),
  decision_rationale_id: z.string().trim().min(1).max(256).optional()
}).superRefine((value, context) => {
  if (Boolean(value.memory_id) === Boolean(value.decision_rationale_id)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["memory_id"],
      message: "exactly one of memory_id or decision_rationale_id is required"
    });
  }
});

export type MemoryMapTraceQuery = z.infer<typeof memoryMapTraceQuerySchema>;

export type MemoryMapTraceAlternative = {
  alternative: string;
  reason_rejected: string | null;
};

export type MemoryMapTraceDerived = {
  lesson_type: string | null;
  trigger: string | null;
  question: string | null;
  decision_key: string | null;
  decision: string | null;
  selected_value: string | null;
  rationale: string | null;
  alternatives: MemoryMapTraceAlternative[];
  constraints: string[];
  reuse_when: string | null;
  outcome: string | null;
  symptom: string | null;
  failed_approach: string | null;
  root_cause: string | null;
  correction: string | null;
  verified_outcome: string | null;
  avoidance_rule: string | null;
};

export type MemoryMapTraceEvidence = {
  id: string;
  evidence_type: string;
  evidence_ref: string;
  relation: string;
  note: string | null;
  weight_score: number | null;
  content_hash: string | null;
  observed_at: number | null;
  attestation_ref: string | null;
};

export type MemoryMapTraceResourceVersion = {
  id: string;
  source_version: string | null;
  content_hash: string;
  captured_at: number;
  extraction_state: KnowledgeResourceExtractionState;
  pinned: boolean;
};

export type MemoryMapTraceResource = {
  link: DecisionResourceLink;
  resource: KnowledgeResource;
  version: MemoryMapTraceResourceVersion | null;
  freshness: KnowledgeResourceLifecycleState;
  availability: "readable";
};

export type MemoryMapTraceRationale = {
  id: string;
  decision_type: string;
  conclusion: string;
  reason_summary: string;
  status: string;
  confirmation_state: string;
  confidence_score: number | null;
  created_at: number;
  confirmed_at: number | null;
  derived: MemoryMapTraceDerived;
  evidence: MemoryMapTraceEvidence[];
  resources: {
    sources: MemoryMapTraceResource[];
    artifacts: MemoryMapTraceResource[];
  };
};

export type MemoryMapTraceResponse = {
  contract_version: typeof MEMORY_MAP_TRACE_CONTRACT_VERSION;
  selected: {
    node_type: "memory" | "decision";
    id: string;
    memory_id: string;
    decision_rationale_id: string | null;
  };
  memory: {
    id: string;
    project_id: string | null;
    kind: string;
    summary: string | null;
    lifecycle_state: string;
    verification_state: string;
    verified_at: number | null;
    reuse_rule: string | null;
    learning: Record<string, unknown> | null;
    versions: Array<{
      version: number;
      operation: string;
      summary: string | null;
      kind: string;
      lifecycle_state: string;
      actor_type: string | null;
      actor_id: string | null;
      created_at: number;
    }>;
  };
  selected_rationale_id: string | null;
  rationales: MemoryMapTraceRationale[];
  completeness: {
    rationale_count: number;
    evidence_count: number;
    source_count: number;
    artifact_count: number;
    missing: Array<"decision" | "reason" | "alternative" | "evidence" | "artifact" | "verification">;
    partial: boolean;
    truncated: boolean;
  };
};

export const DASHBOARD_CONTRACT_VERSION = "dashboard/v1" as const;

export const DASHBOARD_NODE_TYPES = ["project", "memory", "decision", "resource", "entity", "task"] as const;
export const DASHBOARD_STRATA_TYPES = ["canonical", "decision", "learning", "assumption", "source"] as const;
export const DASHBOARD_SOURCE_TYPES = ["memory", "decision_memory", "knowledge_assertion", "knowledge_resource"] as const;
export const DASHBOARD_SEVERITIES = ["info", "warning", "critical"] as const;
export const DASHBOARD_ATTENTION_KINDS = [
  "task_stalled",
  "task_failed",
  "handoff_unacked",
  "impact_unreported",
  "retrieval_miss",
  "negative_memory_effect",
  "decision_conflict",
  "memory_dormant",
  "memory_expired"
] as const;

const dashboardTenantSchema = z.string().trim().min(1).max(128);
const dashboardOptionalIdentifierSchema = z.string().trim().min(1).max(256).optional();
const dashboardCursorSchema = z.string().trim().min(1).max(1024).optional();
const dashboardOptionalTimestampSchema = z.preprocess(
  (value) => value === "" || value === null ? undefined : value,
  z.coerce.number().int().nonnegative().optional()
);

export const dashboardActivityQuerySchema = z.object({
  tenant_id: dashboardTenantSchema.optional(),
  project_id: dashboardOptionalIdentifierSchema,
  from: dashboardOptionalTimestampSchema,
  to: dashboardOptionalTimestampSchema,
  before: dashboardCursorSchema,
  after: dashboardCursorSchema,
  limit: z.coerce.number().int().min(1).max(250).default(100)
}).superRefine((value, context) => {
  if (value.before && value.after) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["after"], message: "before and after are mutually exclusive" });
  }
  if (value.from !== undefined && value.to !== undefined) {
    if (value.from > value.to) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["from"], message: "from must be before or equal to to" });
    } else if (value.to - value.from > 30 * 24 * 60 * 60 * 1000) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["from"], message: "activity range cannot exceed 30 days" });
    }
  }
});

export const dashboardKnowledgeGraphQuerySchema = z.object({
  tenant_id: dashboardTenantSchema.optional(),
  project_id: dashboardOptionalIdentifierSchema,
  q: z.string().trim().max(512).optional(),
  focus_type: z.enum(DASHBOARD_NODE_TYPES).optional(),
  focus_id: dashboardOptionalIdentifierSchema,
  depth: z.coerce.number().int().min(1).max(2).default(1),
  node_limit: z.coerce.number().int().min(1).max(150).default(80),
  edge_limit: z.coerce.number().int().min(1).max(300).default(160)
}).superRefine((value, context) => {
  if ((value.focus_type && !value.focus_id) || (!value.focus_type && value.focus_id)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: value.focus_type ? ["focus_id"] : ["focus_type"],
      message: "focus_type and focus_id must be supplied together"
    });
  }
});

const dashboardStrataTypesQuerySchema = z.preprocess((value) => {
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return value;
}, z.array(z.enum(DASHBOARD_STRATA_TYPES)).max(DASHBOARD_STRATA_TYPES.length).optional());

export const dashboardStrataQuerySchema = z.object({
  tenant_id: dashboardTenantSchema.optional(),
  project_id: dashboardOptionalIdentifierSchema,
  types: dashboardStrataTypesQuerySchema,
  from: dashboardOptionalTimestampSchema,
  to: dashboardOptionalTimestampSchema,
  before: dashboardCursorSchema,
  limit: z.coerce.number().int().min(1).max(100).default(30)
}).superRefine((value, context) => {
  if (value.from !== undefined && value.to !== undefined && value.from > value.to) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["from"], message: "from must be before or equal to to" });
  }
});

export type DashboardActivityQuery = z.infer<typeof dashboardActivityQuerySchema>;
export type DashboardKnowledgeGraphQuery = z.infer<typeof dashboardKnowledgeGraphQuerySchema>;
export type DashboardStrataQuery = z.infer<typeof dashboardStrataQuerySchema>;
export type DashboardNodeType = (typeof DASHBOARD_NODE_TYPES)[number];
export type DashboardStrataType = (typeof DASHBOARD_STRATA_TYPES)[number];
export type DashboardSourceType = (typeof DASHBOARD_SOURCE_TYPES)[number];
export type DashboardSeverity = (typeof DASHBOARD_SEVERITIES)[number];
export type DashboardAttentionKind = (typeof DASHBOARD_ATTENTION_KINDS)[number];

const dashboardActorSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["principal", "agent", "system"])
});

const dashboardSubjectSchema = z.object({
  type: z.string(),
  id: z.string(),
  label: z.string()
});

const dashboardMetadataValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const dashboardActivityEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  occurred_at: z.number().int().nonnegative(),
  project_id: z.string().nullable(),
  task_id: z.string().nullable(),
  trace_id: z.string().nullable(),
  actor: dashboardActorSchema,
  subject: dashboardSubjectSchema,
  target: dashboardSubjectSchema.nullable(),
  severity: z.enum(DASHBOARD_SEVERITIES),
  status: z.string().nullable(),
  summary: z.string(),
  metadata: z.record(dashboardMetadataValueSchema)
});

export const dashboardObservedAgentSchema = z.object({
  id: z.string(),
  label: z.string(),
  model: z.string().nullable(),
  state: z.enum(["active", "idle"]),
  last_seen_at: z.number().int().nonnegative(),
  active_task_count: z.number().int().nonnegative(),
  read_count: z.number().int().nonnegative(),
  write_count: z.number().int().nonnegative(),
  failure_count: z.number().int().nonnegative()
});

export const dashboardAttentionSchema = z.object({
  id: z.string(),
  kind: z.enum(DASHBOARD_ATTENTION_KINDS),
  severity: z.enum(["warning", "critical"]),
  detected_at: z.number().int().nonnegative(),
  subject_type: z.string(),
  subject_id: z.string(),
  reason: z.string()
});

export const dashboardActivityResponseSchema = z.object({
  contract_version: z.literal(DASHBOARD_CONTRACT_VERSION).default(DASHBOARD_CONTRACT_VERSION),
  events: z.array(dashboardActivityEventSchema),
  observed_agents: z.array(dashboardObservedAgentSchema),
  attention: z.array(dashboardAttentionSchema),
  oldest_cursor: z.string().nullable(),
  newest_cursor: z.string().nullable(),
  has_more: z.boolean(),
  generated_at: z.number().int().nonnegative()
});

export const dashboardKnowledgeNodeSchema = z.object({
  id: z.string(),
  source_id: z.string(),
  type: z.enum(DASHBOARD_NODE_TYPES),
  kind: z.string().nullable(),
  label: z.string(),
  summary: z.string().nullable(),
  project_id: z.string().nullable(),
  status: z.string().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  updated_at: z.number().int().nonnegative().nullable(),
  last_used_at: z.number().int().nonnegative().nullable(),
  usage_count_30d: z.number().int().nonnegative(),
  degree: z.number().int().nonnegative(),
  cluster_ids: z.array(z.string()),
  deep_link: z.string().optional()
});

export const dashboardKnowledgeEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  relation: z.string(),
  directed: z.boolean(),
  inferred: z.literal(false),
  weight: z.number().nonnegative(),
  confidence: z.number().min(0).max(1).nullable()
});

export const dashboardKnowledgeClusterSchema = z.object({
  id: z.string(),
  kind: z.enum(["project", "domain", "memory_kind"]),
  label: z.string(),
  node_ids: z.array(z.string())
});

export const dashboardKnowledgeGraphResponseSchema = z.object({
  contract_version: z.literal(DASHBOARD_CONTRACT_VERSION).default(DASHBOARD_CONTRACT_VERSION),
  nodes: z.array(dashboardKnowledgeNodeSchema),
  edges: z.array(dashboardKnowledgeEdgeSchema),
  clusters: z.array(dashboardKnowledgeClusterSchema),
  generated_at: z.number().int().nonnegative(),
  truncated: z.boolean(),
  omitted_node_count: z.number().int().nonnegative()
});

export const dashboardStrataRevisionSchema = z.object({
  id: z.string(),
  operation: z.string(),
  recorded_at: z.number().int().nonnegative(),
  valid_from: z.number().int().nonnegative().nullable(),
  valid_until: z.number().int().nonnegative().nullable(),
  actor_id: z.string().nullable(),
  state: z.string(),
  summary: z.string().nullable(),
  partial: z.boolean(),
  snapshot: z.record(z.unknown()).optional()
});

export const dashboardStrataRelationSchema = z.object({
  relation: z.string(),
  target_type: z.string(),
  target_id: z.string(),
  valid_from: z.number().int().nonnegative().nullable(),
  valid_until: z.number().int().nonnegative().nullable()
});

export const dashboardStrataSourceSchema = z.object({
  resource_id: z.string(),
  resource_version_id: z.string().nullable(),
  title: z.string(),
  relation: z.string(),
  captured_at: z.number().int().nonnegative().nullable(),
  locator: z.record(z.unknown()).nullable(),
  unresolved: z.boolean()
});

export const dashboardStrataChainSummarySchema = z.object({
  id: z.string(),
  type: z.enum(DASHBOARD_STRATA_TYPES),
  source_type: z.enum(DASHBOARD_SOURCE_TYPES),
  source_id: z.string(),
  title: z.string(),
  project_id: z.string().nullable(),
  current_state: z.string(),
  confidence: z.number().min(0).max(1).nullable(),
  valid_from: z.number().int().nonnegative().nullable(),
  valid_until: z.number().int().nonnegative().nullable(),
  changed_at: z.number().int().nonnegative(),
  partial: z.boolean(),
  revision_count: z.number().int().nonnegative(),
  source_count: z.number().int().nonnegative(),
  attention: z.array(z.string())
});

export const dashboardStrataChainSchema = dashboardStrataChainSummarySchema.extend({
  revisions: z.array(dashboardStrataRevisionSchema),
  relations: z.array(dashboardStrataRelationSchema),
  sources: z.array(dashboardStrataSourceSchema)
});

export const dashboardStrataResponseSchema = z.object({
  contract_version: z.literal(DASHBOARD_CONTRACT_VERSION).default(DASHBOARD_CONTRACT_VERSION),
  chains: z.array(dashboardStrataChainSummarySchema),
  oldest_cursor: z.string().nullable(),
  has_more: z.boolean(),
  generated_at: z.number().int().nonnegative(),
  truncated: z.boolean()
});

export const dashboardStrataDetailResponseSchema = z.object({
  contract_version: z.literal(DASHBOARD_CONTRACT_VERSION).default(DASHBOARD_CONTRACT_VERSION),
  chain: dashboardStrataChainSchema,
  truncated: z.object({ revisions: z.boolean(), sources: z.boolean() })
});

export type DashboardActivityEvent = z.infer<typeof dashboardActivityEventSchema>;
export type DashboardObservedAgent = z.infer<typeof dashboardObservedAgentSchema>;
export type DashboardAttention = z.infer<typeof dashboardAttentionSchema>;
export type DashboardActivityResponse = z.infer<typeof dashboardActivityResponseSchema>;
export type DashboardKnowledgeNode = z.infer<typeof dashboardKnowledgeNodeSchema>;
export type DashboardKnowledgeEdge = z.infer<typeof dashboardKnowledgeEdgeSchema>;
export type DashboardKnowledgeCluster = z.infer<typeof dashboardKnowledgeClusterSchema>;
export type DashboardKnowledgeGraphResponse = z.infer<typeof dashboardKnowledgeGraphResponseSchema>;
export type DashboardStrataRevision = z.infer<typeof dashboardStrataRevisionSchema>;
export type DashboardStrataRelation = z.infer<typeof dashboardStrataRelationSchema>;
export type DashboardStrataSource = z.infer<typeof dashboardStrataSourceSchema>;
export type DashboardStrataChainSummary = z.infer<typeof dashboardStrataChainSummarySchema>;
export type DashboardStrataChain = z.infer<typeof dashboardStrataChainSchema>;
export type DashboardStrataResponse = z.infer<typeof dashboardStrataResponseSchema>;
export type DashboardStrataDetailResponse = z.infer<typeof dashboardStrataDetailResponseSchema>;
