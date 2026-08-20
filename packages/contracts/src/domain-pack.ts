import { z } from "zod";
import { recallProfileSchema } from "./domain-recall.js";

export const DOMAIN_PACK_CONTRACT_VERSION = "domain-pack/v1" as const;
export const PACK_ENVELOPE_CONTRACT_VERSION = "pack-envelope/v1" as const;
export const METRIC_CONTRACT_VERSION = "metric/v1" as const;

export const DOMAIN_PACK_CLASSIFICATIONS = [
  "function",
  "industry_overlay",
  "organization_overlay"
] as const;
export const METRIC_ORIGIN_TYPES = ["pack", "custom"] as const;
export const METRIC_SCOPE_TYPES = ["tenant", "project", "managed_object"] as const;
export const METRIC_SOURCE_TYPES = ["manual", "connector", "derived"] as const;
export const METRIC_OPERATIONS = [
  "count",
  "sum",
  "average",
  "ratio",
  "percentile",
  "duration",
  "distinct_count"
] as const;
export const METRIC_TARGET_DIRECTIONS = ["increase", "decrease", "range", "maintain"] as const;
export const METRIC_SNAPSHOT_STATES = ["measured", "unknown", "stale"] as const;
export const METRIC_SOURCE_BINDING_STATES = [
  "unconfigured",
  "configured",
  "active",
  "error",
  "paused"
] as const;
export const DOMAIN_WORKSPACE_METRIC_STATES = [
  "achieved",
  "approaching",
  "missed",
  "waiting",
  "stale",
  "unknown"
] as const;
export const DECISION_DOMAIN_RELATIONS = [
  "about_object",
  "triggered_by_metric",
  "sets_metric_target",
  "implemented_by_asset_run",
  "verified_by_metric"
] as const;

const identifier = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const slug = z.string().trim().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/u);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const semver = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);

export const managedObjectTypeSchema = z.object({
  key: slug,
  label: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1_000).default(""),
  attribute_schema: z.record(z.unknown()).default({}),
  allowed_relations: z.array(slug).max(64).default([])
}).strict();

export const managedObjectSchema = z.object({
  contract_version: z.literal(DOMAIN_PACK_CONTRACT_VERSION).default(DOMAIN_PACK_CONTRACT_VERSION),
  id: identifier,
  object_type_key: slug,
  tenant_id: identifier.optional(),
  project_id: identifier.nullable().optional(),
  name: z.string().trim().min(1).max(240),
  attributes: z.record(z.unknown()).default({}),
  visibility: z.enum(["tenant", "project", "restricted"]).default("tenant"),
  owner_principal: z.string().trim().min(1).max(128).nullable().default(null)
}).strict();

export const metricFormulaSchema = z.object({
  operation: z.enum(METRIC_OPERATIONS),
  metric_keys: z.array(slug).min(1).max(32),
  percentile: z.number().min(0).max(100).optional()
}).strict().superRefine((value, context) => {
  if (value.operation === "ratio" && value.metric_keys.length !== 2) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["metric_keys"], message: "ratio requires exactly two metric keys" });
  }
  if (value.operation === "percentile" && value.percentile === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["percentile"], message: "percentile is required" });
  }
  if (value.operation !== "percentile" && value.percentile !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["percentile"], message: "percentile is only valid for percentile operation" });
  }
});

export const metricDefinitionSchema = z.object({
  contract_version: z.literal(METRIC_CONTRACT_VERSION).default(METRIC_CONTRACT_VERSION),
  key: slug,
  label: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2_000).default(""),
  origin_type: z.enum(METRIC_ORIGIN_TYPES),
  scope_type: z.enum(METRIC_SCOPE_TYPES),
  source_type: z.enum(METRIC_SOURCE_TYPES),
  unit: z.string().trim().min(1).max(64),
  aggregation_window: z.string().trim().min(1).max(64),
  dimensions: z.array(slug).max(32).default([]),
  freshness_seconds: z.number().int().positive().max(31_536_000),
  target_direction: z.enum(METRIC_TARGET_DIRECTIONS),
  formula: metricFormulaSchema.nullable().default(null),
  connector: z.object({
    adapter_id: identifier,
    query_template: identifier
  }).strict().nullable().default(null),
  evidence_source: z.string().trim().max(512).nullable().default(null)
}).strict().superRefine((value, context) => {
  if (value.source_type === "derived" && !value.formula) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["formula"], message: "derived metrics require a formula" });
  }
  if (value.source_type !== "derived" && value.formula) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["formula"], message: "formula is only valid for derived metrics" });
  }
  if (value.source_type === "connector" && !value.connector) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["connector"], message: "connector metrics require an adapter and query template" });
  }
  if (value.source_type !== "connector" && value.connector) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["connector"], message: "connector config is only valid for connector metrics" });
  }
});

export const metricSnapshotSchema = z.object({
  contract_version: z.literal(METRIC_CONTRACT_VERSION).default(METRIC_CONTRACT_VERSION),
  tenant_id: identifier.optional(),
  metric_key: slug,
  scope_type: z.enum(METRIC_SCOPE_TYPES),
  scope_id: identifier.nullable().default(null),
  value: z.number().finite().nullable(),
  state: z.enum(METRIC_SNAPSHOT_STATES),
  dimensions: z.record(z.string().max(256)).default({}),
  observed_at: z.number().int().nonnegative(),
  expires_at: z.number().int().nonnegative(),
  evidence_ref: z.string().trim().max(2_048).nullable().default(null),
  query_digest: sha256.nullable().default(null),
  source_binding_id: identifier.nullable().default(null),
  idempotency_key: identifier
}).strict().superRefine((value, context) => {
  if (value.state === "measured" && value.value === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "measured snapshots require a value" });
  }
  if (value.state !== "measured" && value.value !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "unknown and stale snapshots must not contain a numeric value" });
  }
  if (value.expires_at < value.observed_at) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["expires_at"], message: "expires_at must be on or after observed_at" });
  }
});

export const metricSourceBindingSchema = z.object({
  contract_version: z.literal(METRIC_CONTRACT_VERSION).default(METRIC_CONTRACT_VERSION),
  id: identifier,
  tenant_id: identifier,
  metric_definition_id: identifier,
  metric_key: slug.optional(),
  metric_binding_id: identifier.nullable().default(null),
  adapter_id: identifier,
  query_template: identifier,
  connection_ref: z.string().trim().max(512).nullable().default(null),
  external_scope_ref: z.string().trim().max(512).nullable().default(null),
  status: z.enum(METRIC_SOURCE_BINDING_STATES),
  last_attempt_at: z.number().int().nonnegative().nullable().default(null),
  last_success_at: z.number().int().nonnegative().nullable().default(null),
  last_error_code: identifier.nullable().default(null),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative()
}).strict();

const workspaceSnapshotSchema = z.object({
  id: identifier,
  value: z.number().finite().nullable(),
  state: z.enum(METRIC_SNAPSHOT_STATES),
  observed_at: z.number().int().nonnegative(),
  expires_at: z.number().int().nonnegative(),
  evidence_ref: z.string().trim().max(2_048).nullable(),
  source_binding_id: identifier.nullable(),
  historical: z.boolean().default(false)
}).strict();

const workspaceEvidenceSchema = z.object({
  id: identifier,
  title: z.string().trim().min(1).max(240),
  resource_kind: z.string().trim().min(1).max(64),
  source_system: z.string().trim().min(1).max(128),
  observed_at: z.number().int().nonnegative().nullable(),
  verification_state: z.enum(["verified", "unverified", "stale"]),
  technical_ref: z.string().trim().min(1).max(2_048)
}).strict();

const workspaceMetricSchema = z.object({
  metric_key: slug,
  label: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2_000),
  group: slug,
  origin_type: z.enum(METRIC_ORIGIN_TYPES),
  unit: z.string().trim().min(1).max(64),
  aggregation_window: z.string().trim().min(1).max(64),
  baseline: workspaceSnapshotSchema.nullable(),
  current: workspaceSnapshotSchema.nullable(),
  outcome: workspaceSnapshotSchema.nullable(),
  delta: z.number().finite().nullable(),
  target: z.object({
    direction: z.enum(METRIC_TARGET_DIRECTIONS),
    value: z.number().finite().nullable(),
    min: z.number().finite().nullable(),
    max: z.number().finite().nullable(),
    reason: z.string().trim().max(2_000).nullable()
  }).strict().nullable(),
  status: z.enum(DOMAIN_WORKSPACE_METRIC_STATES),
  source: z.object({
    adapter_id: identifier.nullable(),
    query_template: identifier.nullable(),
    state: z.enum(METRIC_SOURCE_BINDING_STATES),
    last_success_at: z.number().int().nonnegative().nullable(),
    last_error_code: identifier.nullable()
  }).strict(),
  series: z.array(workspaceSnapshotSchema).max(500)
}).strict();

const workspaceRecallHistorySchema = z.object({
  id: identifier,
  created_at: z.number().int().nonnegative(),
  mode: z.enum(["shadow", "on"]),
  client_name: z.string().trim().min(1).max(128).nullable(),
  candidate_count: z.number().int().nonnegative(),
  candidates: z.array(z.object({
    recall_unit_id: identifier,
    role: z.enum(["primary", "supporting", "conflict"]),
    score: z.number().finite().min(0).max(1),
    why_recalled: z.array(z.string().trim().min(1).max(128)).max(16),
    decision_statement: z.string().trim().min(1).max(4_000)
  }).strict()).max(8),
  feedback: z.array(z.enum(["useful", "not_relevant", "wrong_scope", "outdated", "incorrect_relation", "dismiss_for_session"])).max(100),
  trace_url: z.string().trim().min(1).max(2_048)
}).strict();

export const domainPackWorkspaceSchema = z.object({
  contract_version: z.literal(DOMAIN_PACK_CONTRACT_VERSION).default(DOMAIN_PACK_CONTRACT_VERSION),
  generated_at: z.number().int().nonnegative(),
  pack: z.object({
    pack_id: slug,
    title: z.string().trim().min(1).max(160),
    version: semver,
    description: z.string().trim().max(2_000)
  }).strict(),
  installation: z.object({
    id: identifier,
    state: z.literal("installed"),
    installed_at: z.number().int().nonnegative()
  }).strict(),
  managed_objects: z.array(z.object({
    id: identifier,
    type_key: slug,
    type_label: z.string().trim().min(1).max(160),
    name: z.string().trim().min(1).max(240)
  }).strict()).max(500),
  selected_scope_id: identifier.nullable(),
  metric_groups: z.array(z.object({
    key: slug,
    label: z.string().trim().min(1).max(160),
    metrics: z.array(workspaceMetricSchema).max(256)
  }).strict()).max(32),
  decision: z.object({
    source_type: z.enum(["decision_memory", "decision_rationale"]),
    id: identifier,
    statement: z.string().trim().min(1).max(4_000),
    rationale: z.string().trim().max(8_000),
    confirmation_state: z.enum(["proposal", "confirmed", "retired"]),
    rejected_alternatives: z.array(z.object({
      statement: z.string().trim().min(1).max(2_000),
      reason: z.string().trim().max(2_000)
    }).strict()).max(32),
    constraints: z.array(z.string().trim().min(1).max(2_000)).max(32),
    success_conditions: z.array(z.string().trim().min(1).max(2_000)).max(32),
    workflow: z.string().trim().max(256).nullable(),
    playbook: z.string().trim().max(256).nullable(),
    outcome_summary: z.string().trim().max(4_000).nullable(),
    followup_decision: z.string().trim().max(4_000).nullable(),
    evidence: z.array(workspaceEvidenceSchema).max(100)
  }).strict().nullable(),
  recall_history: z.array(workspaceRecallHistorySchema).max(50).default([]),
  source_readiness: z.array(metricSourceBindingSchema).max(512)
}).strict();

export const dashboardDefinitionSchema = z.object({
  key: slug,
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1_000).default(""),
  widgets: z.array(z.object({
    key: slug,
    kind: z.enum(["metric", "trend", "table", "decision_trace", "object_graph"]),
    title: z.string().trim().min(1).max(160),
    metric_keys: z.array(slug).max(32).default([]),
    object_type_keys: z.array(slug).max(32).default([]),
    layout: z.object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), w: z.number().int().positive().max(12), h: z.number().int().positive().max(12) }).strict()
  }).strict()).max(128)
}).strict();

export const domainPackDependencySchema = z.object({
  pack_id: slug,
  version: semver
}).strict();

export const domainPackManifestSchema = z.object({
  contract_version: z.literal(DOMAIN_PACK_CONTRACT_VERSION).default(DOMAIN_PACK_CONTRACT_VERSION),
  pack_id: slug,
  version: semver,
  classification: z.enum(DOMAIN_PACK_CLASSIFICATIONS),
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(2_000),
  language: z.string().trim().min(2).max(16).default("ja"),
  min_orgbrain_version: semver,
  recall_profile: recallProfileSchema.optional(),
  dependencies: z.array(domainPackDependencySchema).max(32).default([]),
  object_types: z.array(managedObjectTypeSchema).max(128).default([]),
  metrics: z.array(metricDefinitionSchema).max(256).default([]),
  dashboards: z.array(dashboardDefinitionSchema).max(64).default([]),
  connectors: z.array(z.object({
    adapter_id: identifier,
    required: z.boolean().default(false),
    description: z.string().trim().max(1_000).default("")
  }).strict()).max(64).default([]),
  assets: z.array(z.object({
    asset_key: slug,
    asset_type: z.enum(["skill", "workflow", "playbook"]),
    version: semver
  }).strict()).max(256).default([]),
  loadout_templates: z.array(z.object({
    key: slug,
    asset_keys: z.array(slug).max(128)
  }).strict()).max(64).default([]),
  example_refs: z.array(z.string().trim().min(1).max(512)).max(32).default([])
}).strict().superRefine((value, context) => {
  const unique = (items: string[], path: string) => {
    if (new Set(items).size !== items.length) context.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: `${path} keys must be unique` });
  };
  unique(value.object_types.map((item) => item.key), "object_types");
  unique(value.metrics.map((item) => item.key), "metrics");
  unique(value.dashboards.map((item) => item.key), "dashboards");
  unique(value.assets.map((item) => item.asset_key), "assets");
});

export const packEnvelopeSchema = z.object({
  contract_version: z.literal(PACK_ENVELOPE_CONTRACT_VERSION).default(PACK_ENVELOPE_CONTRACT_VERSION),
  pack_kind: z.literal("domain"),
  manifest: domainPackManifestSchema,
  manifest_digest: sha256,
  publisher: z.object({ id: identifier, key_id: identifier }).strict(),
  signature: z.object({ alg: z.literal("EdDSA"), value_base64url: z.string().min(43).max(256) }).strict(),
  license: z.object({ id: z.string().trim().min(1).max(128), url: z.string().url().max(2_048).nullable().default(null) }).strict(),
  archive: z.object({ object_key: z.string().trim().min(1).max(1_024), size: z.number().int().nonnegative(), sha256 }).strict()
}).strict();

export const decisionDomainLinkSchema = z.object({
  tenant_id: identifier.optional(),
  decision_source_type: z.enum(["decision_memory", "decision_rationale"]),
  decision_source_id: identifier,
  relation: z.enum(DECISION_DOMAIN_RELATIONS),
  object_type: z.enum(["managed_object", "metric_definition", "metric_snapshot", "agent_asset_run"]),
  object_id: identifier,
  confirmation_state: z.enum(["proposal", "confirmed", "retired"]),
  evidence_resource_id: identifier.nullable().default(null),
  evidence_resource_version_id: identifier.nullable().default(null)
}).strict();

export type DomainPackManifestV1 = z.infer<typeof domainPackManifestSchema>;
export type PackEnvelopeV1 = z.infer<typeof packEnvelopeSchema>;
export type ManagedObjectTypeV1 = z.infer<typeof managedObjectTypeSchema>;
export type ManagedObjectV1 = z.infer<typeof managedObjectSchema>;
export type MetricFormulaV1 = z.infer<typeof metricFormulaSchema>;
export type MetricDefinitionV1 = z.infer<typeof metricDefinitionSchema>;
export type MetricSnapshotV1 = z.infer<typeof metricSnapshotSchema>;
export type MetricSourceBindingV1 = z.infer<typeof metricSourceBindingSchema>;
export type DomainPackWorkspaceV1 = z.infer<typeof domainPackWorkspaceSchema>;
export type DashboardDefinitionV1 = z.infer<typeof dashboardDefinitionSchema>;
export type DecisionDomainLinkV1 = z.infer<typeof decisionDomainLinkSchema>;
