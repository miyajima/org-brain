import { z } from "zod";

export const DOMAIN_RECALL_CONTRACT_VERSION = "domain-recall/v1" as const;
export const PORTABLE_ARCHIVE_CONTRACT_VERSION = "orgbrain-portable-archive/v1" as const;
export const DOMAIN_RECALL_RISK_MODES = ["standard", "high_assurance"] as const;
export const DOMAIN_RECALL_FEEDBACK_KINDS = [
  "useful",
  "not_relevant",
  "wrong_scope",
  "outdated",
  "incorrect_relation",
  "dismiss_for_session"
] as const;

const identifier = z.string().trim().min(1).max(256);
const key = z.string().trim().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/u);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);

export const recallProfileSchema = z.object({
  intent_aliases: z.array(z.string().trim().min(1).max(160)).min(1).max(64),
  object_type_keys: z.array(key).min(1).max(64),
  primary_metric_keys: z.array(key).max(64).default([]),
  guardrail_metric_keys: z.array(key).max(64).default([]),
  risk_mode: z.enum(DOMAIN_RECALL_RISK_MODES),
  auto_recall_threshold: z.number().min(0).max(1),
  required_scope_keys: z.array(key).max(16).default([])
}).strict().superRefine((value, context) => {
  if (value.risk_mode === "high_assurance" && value.required_scope_keys.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["required_scope_keys"], message: "high_assurance recall requires exact scope keys" });
  }
});

export const domainRecallScoreBreakdownSchema = z.object({
  object_match: z.number().min(0).max(0.35),
  intent_match: z.number().min(0).max(0.2),
  scope_match: z.number().min(0).max(0.15),
  decision_link: z.number().min(0).max(0.1),
  active_confirmed: z.number().min(0).max(0.08),
  verified_evidence: z.number().min(0).max(0.07),
  fresh_metric: z.number().min(0).max(0.05),
  total: z.number().min(0).max(1)
}).strict();

const recallMetricObservationSchema = z.object({
  metric_key: key,
  role: z.enum(["baseline", "current", "outcome", "target"]),
  value: z.number().finite().nullable(),
  unit: z.string().trim().min(1).max(64),
  state: z.enum(["measured", "unknown", "stale"]),
  observed_at: z.number().int().nonnegative().nullable()
}).strict().superRefine((value, context) => {
  if (value.state === "measured" && value.value === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "measured recall metrics require a value" });
  }
  if (value.state !== "measured" && value.value !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "stale and unknown recall metrics must not disclose a numeric value" });
  }
});

export const domainRecallCandidateSchema = z.object({
  recall_unit_id: identifier,
  role: z.enum(["primary", "supporting", "conflict"]),
  why_recalled: z.array(z.string().trim().min(1).max(500)).min(1).max(12),
  scope: z.record(z.string().max(256)),
  score: domainRecallScoreBreakdownSchema,
  decision: z.object({
    source_type: z.enum(["decision_memory", "decision_rationale"]),
    id: identifier,
    statement: z.string().trim().min(1).max(4_000),
    rationale: z.string().trim().max(8_000),
    confirmation_state: z.enum(["proposal", "confirmed", "superseded", "conflict"]),
    valid_from: z.number().int().nonnegative().nullable(),
    valid_until: z.number().int().nonnegative().nullable(),
    rejected_alternatives: z.array(z.object({ statement: z.string().max(2_000), reason: z.string().max(2_000) }).strict()).max(32),
    constraints: z.array(z.string().max(2_000)).max(32),
    success_conditions: z.array(z.string().max(2_000)).max(32)
  }).strict(),
  metrics: z.array(recallMetricObservationSchema).max(128),
  evidence: z.array(z.object({
    id: identifier,
    title: z.string().trim().min(1).max(240),
    source: z.string().trim().min(1).max(256),
    resource_kind: z.string().trim().min(1).max(64),
    verification_state: z.enum(["verified", "unverified", "stale"]),
    observed_at: z.number().int().nonnegative().nullable()
  }).strict()).max(32),
  workflow: z.string().trim().max(256).nullable(),
  follow_up: z.string().trim().max(4_000).nullable()
}).strict();

export const domainRecallBundleSchema = z.object({
  contract_version: z.literal(DOMAIN_RECALL_CONTRACT_VERSION).default(DOMAIN_RECALL_CONTRACT_VERSION),
  id: identifier,
  generated_at: z.number().int().nonnegative(),
  query_hash: sha256,
  primary: domainRecallCandidateSchema.nullable(),
  supporting: z.array(domainRecallCandidateSchema).max(2),
  conflicts: z.array(domainRecallCandidateSchema).max(2),
  warnings: z.array(z.string().trim().min(1).max(500)).max(32),
  trace_url: z.string().trim().min(1).max(2_048),
  summary: z.string().trim().min(1).max(6_144)
}).strict();

export const domainRecallFeedbackSchema = z.object({
  contract_version: z.literal(DOMAIN_RECALL_CONTRACT_VERSION).default(DOMAIN_RECALL_CONTRACT_VERSION),
  recall_id: identifier,
  candidate_id: identifier.nullable().default(null),
  feedback: z.enum(DOMAIN_RECALL_FEEDBACK_KINDS),
  effect: z.enum(["none", "session_suppression", "personal_suppression", "team_review_proposal"]),
  session_id: identifier.nullable().default(null),
  note: z.string().trim().max(2_000).nullable().default(null),
  occurred_at: z.number().int().nonnegative()
}).strict().superRefine((value, context) => {
  const expected = value.feedback === "dismiss_for_session"
    ? "session_suppression"
    : value.feedback === "not_relevant" || value.feedback === "wrong_scope"
      ? "personal_suppression"
      : value.feedback === "outdated" || value.feedback === "incorrect_relation"
        ? "team_review_proposal"
        : "none";
  if (value.effect !== expected) context.addIssue({ code: z.ZodIssueCode.custom, path: ["effect"], message: `feedback effect must be ${expected}` });
  if (value.effect === "session_suppression" && !value.session_id) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["session_id"], message: "session suppression requires session_id" });
  }
});

export const portableArchiveHeaderSchema = z.object({
  contract_version: z.literal(PORTABLE_ARCHIVE_CONTRACT_VERSION),
  record_type: z.literal("header"),
  archive_id: identifier,
  created_at: z.number().int().nonnegative(),
  source_authority: z.enum(["local", "cloud", "enterprise"]),
  source_tenant_id: identifier,
  target_tenant_id: identifier.nullable(),
  schema_versions: z.record(z.string().trim().min(1).max(64)),
  sections: z.array(z.enum([
    "memories", "memory_versions", "decisions", "decision_versions", "knowledge_resources",
    "domain_pack_installations", "managed_objects", "metric_definitions", "metric_snapshots",
    "metric_targets", "decision_domain_links", "recall_preferences", "tasks", "messages",
    "telemetry", "audit"
  ])).min(1)
}).strict();

export const portableArchiveRecordSchema = z.object({
  contract_version: z.literal(PORTABLE_ARCHIVE_CONTRACT_VERSION),
  record_type: z.literal("record"),
  section: portableArchiveHeaderSchema.shape.sections.element,
  id: identifier,
  version: z.number().int().positive(),
  digest: sha256,
  payload: z.record(z.unknown())
}).strict();

export const portableArchiveFooterSchema = z.object({
  contract_version: z.literal(PORTABLE_ARCHIVE_CONTRACT_VERSION),
  record_type: z.literal("footer"),
  archive_id: identifier,
  record_count: z.number().int().nonnegative(),
  section_counts: z.record(z.number().int().nonnegative()),
  content_digest: sha256
}).strict();

export const portableArchiveLineSchema = z.discriminatedUnion("record_type", [
  portableArchiveHeaderSchema,
  portableArchiveRecordSchema,
  portableArchiveFooterSchema
]);

export type RecallProfileV1 = z.infer<typeof recallProfileSchema>;
export type DomainRecallCandidateV1 = z.infer<typeof domainRecallCandidateSchema>;
export type DomainRecallBundleV1 = z.infer<typeof domainRecallBundleSchema>;
export type DomainRecallFeedbackV1 = z.infer<typeof domainRecallFeedbackSchema>;
export type OrgBrainPortableArchiveV1 = z.infer<typeof portableArchiveLineSchema>;
