import {
  KNOWLEDGE_MEASUREMENT_LOOP_CONTRACT_VERSION,
  METRIC_IMPORT_JOB_CONTRACT_VERSION,
  improvementActionSchema,
  improvementActionViewSchema,
  knowledgePackGoalLinkSchema,
  metricImportJobSchema,
  metricImportRunSchema,
  organizationDashboardSchema,
  retrospectiveResultSchema,
  retrospectiveScheduleSchema,
  retrospectiveSessionSchema,
  type ImprovementActionV1,
  type MetricImportJobV1,
  type RetrospectiveSessionV1
} from "@org-brain/contracts";
import { canonicalJson } from "@org-brain/core";
import { HttpError, sha256, ulid } from "@org-brain/shared";
import { z } from "zod";
import { createMetricSnapshot } from "./domain-metric-service";
import { assertKnowledgeLoopWritable, isKnowledgeLoopWritable } from "./knowledge-loop-feature";
import { canReadResourceWithGroups, loadAccessPolicies, loadPrincipalGroupIds } from "./access-policy-service";
import { compareMetric, type MetricTarget } from "./metric-comparison";
import type { Env } from "./types";

type FeatureKey = "ORGANIZATION_DASHBOARD_MODE" | "METRIC_IMPORT_MODE" | "RETROSPECTIVE_MODE" | "IMPROVEMENT_ACTIONS_MODE";

function assertReadable(env: Env, key: FeatureKey) {
  if (!env[key] || env[key] === "off") throw new HttpError(404, "feature_disabled", "This measurement feature is disabled");
}

function parse<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new HttpError(400, "invalid_payload", result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  }
  return result.data;
}

function transportBody(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "invalid_payload", "request body must be an object");
  const body = { ...(raw as Record<string, unknown>) };
  delete body.tenant_id;
  return body;
}

function json(value: string | null | undefined, fallback: unknown = []) {
  if (!value) return fallback;
  try { return JSON.parse(value) as unknown; } catch { return fallback; }
}

type DashboardRow = {
  link_id: string;
  onboarding_id: string | null;
  installation_id: string;
  template_pack_id: string;
  metric_definition_id: string;
  metric_binding_id: string | null;
  metric_target_id: string;
  metric_source_binding_id: string | null;
  metric_key: string;
  scope_type: "tenant" | "project";
  scope_id: string | null;
  link_created_at: number;
  pack_title: string;
  definition_json: string;
  direction: "increase" | "decrease" | "range" | "maintain";
  target_value: number | null;
  target_min: number | null;
  target_max: number | null;
  effective_to: number | null;
  snapshot_id: string | null;
  snapshot_value: number | null;
  snapshot_state: "measured" | "unknown" | "stale" | null;
  observed_at: number | null;
  expires_at: number | null;
  adapter_id: string | null;
  source_status: "unconfigured" | "configured" | "active" | "error" | "paused" | null;
  last_success_at: number | null;
  previous_value: number | null;
  run_id: string | null;
  run_status: "queued" | "running" | "succeeded" | "failed" | null;
  run_attempt: number | null;
  run_error_code: string | null;
  run_error_message: string | null;
  run_snapshot_id: string | null;
  run_queued_at: number | null;
  run_started_at: number | null;
  run_lease_expires_at: number | null;
  run_completed_at: number | null;
  run_updated_at: number | null;
};

async function principalCanReadProject(env: Env, tenantId: string, principal: string, projectId: string | null): Promise<boolean> {
  if (!projectId) return true;
  const assignment = await env.OPEN_BRAIN_DB.prepare(
    `SELECT 1 AS allowed FROM principal_role_assignments
     WHERE tenant_id=? AND principal=? AND (project_id IS NULL OR project_id=?) LIMIT 1`
  ).bind(tenantId, principal, projectId).first<{ allowed: number }>();
  return Boolean(assignment);
}

export async function getOrganizationDashboard(env: Env, tenantId: string, options: {
  principal?: string;
  projectId?: string | null;
  includeAll?: boolean;
} = {}) {
  assertReadable(env, "ORGANIZATION_DASHBOARD_MODE");
  const projectId = options.projectId ?? null;
  const principal = options.principal ?? "";
  const projectAssignments = options.includeAll ? { results: [] as Array<{ project_id: string | null }> } : await env.OPEN_BRAIN_DB.prepare(
    "SELECT project_id FROM principal_role_assignments WHERE tenant_id=? AND principal=?"
  ).bind(tenantId, principal).all<{ project_id: string | null }>();
  const canReadAllProjects = Boolean(options.includeAll || projectAssignments.results.some((row) => row.project_id === null));
  const readableProjectIds = new Set(projectAssignments.results.flatMap((row) => row.project_id ? [row.project_id] : []));
  if (projectId && !canReadAllProjects && !readableProjectIds.has(projectId)) {
    throw new HttpError(403, "project_access_required", "The principal is not assigned to this project");
  }
  const [decisionRows, rationaleRows, rows, installedPacks, openRetrospectives] = await Promise.all([
    env.OPEN_BRAIN_DB.prepare(
      `SELECT id, project_id, title, decision, rationale, constraints_json, source_refs_json, updated_at,
              confirmation_state, visibility, owner_refs_json, allowed_principals_json
       FROM decision_memories WHERE tenant_id = ?
       AND (? IS NULL OR project_id IS NULL OR project_id = ?)
       AND status NOT IN ('retired','superseded')`
    ).bind(tenantId, projectId, projectId).all<{
      id: string; project_id: string | null; title: string; decision: string; rationale: string;
      constraints_json: string; source_refs_json: string; updated_at: number; confirmation_state: string;
      visibility: string; owner_refs_json: string; allowed_principals_json: string;
    }>(),
    env.OPEN_BRAIN_DB.prepare(
      `SELECT r.id, r.memory_id FROM decision_rationales r
       JOIN decision_memories d ON d.tenant_id=r.tenant_id AND d.id=r.memory_id
       WHERE r.tenant_id = ? AND (? IS NULL OR r.project_id IS NULL OR r.project_id = ?)
       AND r.status NOT IN ('retired','superseded')`
    ).bind(tenantId, projectId, projectId).all<{ id: string; memory_id: string }>(),
    env.OPEN_BRAIN_DB.prepare(
      `SELECT l.id AS link_id, l.onboarding_id, l.knowledge_pack_installation_id AS installation_id,
              l.template_pack_id, l.metric_definition_id, l.metric_binding_id, l.metric_target_id,
              l.metric_source_binding_id, l.metric_key, l.scope_type, l.scope_id, l.created_at AS link_created_at,
              r.manifest_json, v.definition_json, t.direction, t.target_value, t.target_min, t.target_max,
              t.effective_to,
              s.id AS snapshot_id, s.value AS snapshot_value, s.state AS snapshot_state,
              s.observed_at, s.expires_at, previous.value AS previous_value,
              ms.adapter_id, ms.status AS source_status, ms.last_success_at,
              run.id AS run_id, run.status AS run_status, run.attempt AS run_attempt,
              run.error_code AS run_error_code, run.error_message AS run_error_message,
              run.snapshot_id AS run_snapshot_id, run.queued_at AS run_queued_at,
              run.started_at AS run_started_at, run.lease_expires_at AS run_lease_expires_at,
              run.completed_at AS run_completed_at, run.updated_at AS run_updated_at
       FROM knowledge_pack_goal_links l
       JOIN knowledge_pack_goal_reconciliations reconciliation
         ON reconciliation.onboarding_id=l.onboarding_id AND reconciliation.tenant_id=l.tenant_id
        AND reconciliation.status='clean'
       JOIN domain_pack_installations i ON i.id = l.knowledge_pack_installation_id AND i.tenant_id = l.tenant_id
       JOIN domain_pack_releases r ON r.id = i.release_id
       JOIN metric_definitions d ON d.id = l.metric_definition_id AND d.tenant_id = l.tenant_id
       JOIN metric_definition_versions v ON v.metric_definition_id = d.id AND v.version = d.current_version
       JOIN metric_targets t ON t.id = l.metric_target_id AND t.tenant_id = l.tenant_id
       LEFT JOIN metric_bindings b ON b.id=l.metric_binding_id AND b.tenant_id=l.tenant_id
       LEFT JOIN metric_source_bindings ms ON ms.id = l.metric_source_binding_id AND ms.tenant_id = l.tenant_id
       LEFT JOIN metric_snapshots s ON s.id = (
         SELECT s2.id FROM metric_snapshots s2
         WHERE s2.tenant_id = l.tenant_id AND s2.metric_definition_id = l.metric_definition_id
           AND s2.binding_id IS l.metric_binding_id
           AND s2.dimensions_json=COALESCE(b.dimensions_json, '{}')
         ORDER BY s2.observed_at DESC, s2.created_at DESC, s2.id DESC LIMIT 1
       )
       LEFT JOIN metric_snapshots previous ON previous.id = (
         SELECT s3.id FROM metric_snapshots s3
         WHERE s3.tenant_id=l.tenant_id AND s3.metric_definition_id=l.metric_definition_id
           AND s3.binding_id IS l.metric_binding_id AND s3.dimensions_json=COALESCE(b.dimensions_json, '{}')
           AND s3.state='measured'
         ORDER BY s3.observed_at DESC, s3.created_at DESC, s3.id DESC LIMIT 1 OFFSET 1
       )
       LEFT JOIN metric_source_import_runs run ON run.id = (
         SELECT import_run.id FROM metric_source_import_runs import_run
         WHERE import_run.tenant_id=l.tenant_id AND import_run.source_binding_id=l.metric_source_binding_id
         ORDER BY import_run.queued_at DESC, import_run.updated_at DESC, import_run.id DESC LIMIT 1
       )
       WHERE l.tenant_id = ? AND i.state = 'installed'
         AND (? IS NULL OR l.scope_id IS NULL OR l.scope_id = ?)
       ORDER BY r.pack_id, l.metric_key`
    ).bind(tenantId, projectId, projectId).all<DashboardRow>(),
    env.OPEN_BRAIN_DB.prepare(
      "SELECT COUNT(*) AS count FROM domain_pack_installations WHERE tenant_id=? AND state='installed'"
    ).bind(tenantId).first<{ count: number }>(),
    env.OPEN_BRAIN_DB.prepare(
      "SELECT id, project_id FROM retrospective_sessions WHERE tenant_id=? AND status='open' AND (? IS NULL OR project_id IS NULL OR project_id=?)"
    ).bind(tenantId, projectId, projectId).all<{ id: string; project_id: string | null }>()
  ]);
  const groupIds = options.includeAll ? new Set<string>() : await loadPrincipalGroupIds(env, tenantId, principal);
  const policies = await loadAccessPolicies(env, tenantId, "decision_memory", decisionRows.results.map((row) => row.id));
  const readableDecisions: typeof decisionRows.results = [];
  for (const decision of decisionRows.results) {
    const policy = policies.get(decision.id);
    const legacyAllowed = decision.visibility !== "restricted" || principalsCanRead(decision, [principal]) || [...groupIds].some((groupId) => principalsCanRead(decision, [groupId]));
    const canReadProject = decision.project_id === null || canReadAllProjects || readableProjectIds.has(decision.project_id);
    if (options.includeAll || (canReadProject && (policy
      ? await canReadResourceWithGroups(env, policy, { tenantId, principal, projectId: canReadProject ? decision.project_id : null, isAdmin: false }, groupIds)
      : legacyAllowed))) readableDecisions.push(decision);
  }
  const readableDecisionIds = new Set(readableDecisions.map((row) => row.id));
  const readableRationales = rationaleRows.results.filter((row) => readableDecisionIds.has(row.memory_id));
  const now = Date.now();
  const visibleGoalRows = rows.results.filter((row) => row.scope_type !== "project" || row.scope_id === null || canReadAllProjects || readableProjectIds.has(row.scope_id));
  const goals = visibleGoalRows.map((row) => {
    const definition = json(row.definition_json, {}) as { label?: string; unit?: string };
    const state = row.snapshot_state === "measured" && row.expires_at !== null && row.expires_at < now
      ? "stale"
      : row.snapshot_state ?? "unknown";
    const target: MetricTarget = { direction: row.direction, value: row.target_value, min: row.target_min, max: row.target_max };
    const comparison = state === "measured" && typeof row.snapshot_value === "number"
      ? compareMetric(row.snapshot_value, typeof row.previous_value === "number" ? row.previous_value : null, target)
      : { target_state: "unknown" as const, distance_to_target: null, previous_value: null, change_from_previous: null, trend: "unknown" as const };
    const latestRun = row.run_id ? metricImportRunSchema.parse({
      contract_version: KNOWLEDGE_MEASUREMENT_LOOP_CONTRACT_VERSION,
      id: row.run_id, tenant_id: tenantId, source_binding_id: row.metric_source_binding_id,
      status: row.run_status, attempt: row.run_attempt, error_code: row.run_error_code,
      error_message: row.run_error_message, snapshot_id: row.run_snapshot_id,
      queued_at: row.run_queued_at, started_at: row.run_started_at,
      lease_expires_at: row.run_lease_expires_at, completed_at: row.run_completed_at, updated_at: row.run_updated_at
    }) : null;
    return {
      link: knowledgePackGoalLinkSchema.parse({
        contract_version: KNOWLEDGE_MEASUREMENT_LOOP_CONTRACT_VERSION,
        id: row.link_id,
        tenant_id: tenantId,
        onboarding_id: row.onboarding_id,
        knowledge_pack_installation_id: row.installation_id,
        template_pack_id: row.template_pack_id,
        metric_definition_id: row.metric_definition_id,
        metric_binding_id: row.metric_binding_id,
        metric_target_id: row.metric_target_id,
        metric_source_binding_id: row.metric_source_binding_id,
        metric_key: row.metric_key,
        scope_type: row.scope_type,
        scope_id: row.scope_id,
        created_at: Number(row.link_created_at)
      }),
      pack_title: (json((row as DashboardRow & { manifest_json?: string }).manifest_json, {}) as { title?: string }).title ?? row.template_pack_id,
      metric_label: definition.label ?? row.metric_key,
      unit: definition.unit ?? "count",
      target: { ...target, due_at: row.effective_to },
      current: {
        snapshot_id: row.snapshot_id,
        value: state === "measured" ? row.snapshot_value : null,
        state,
        observed_at: row.observed_at,
        expires_at: row.expires_at
      },
      comparison,
      source: {
        binding_id: row.metric_source_binding_id,
        adapter_id: row.adapter_id,
        status: row.source_status,
        last_success_at: row.last_success_at,
        latest_run: latestRun
      }
    };
  });
  const legacyRuleCount = new Set(readableDecisions.flatMap((row) => {
    const values = json(row.constraints_json, []);
    return Array.isArray(values) ? values.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
  })).size;
  const ruleCandidates = readableDecisions.flatMap((row) => {
    const constraints = json(row.constraints_json, []);
    return Array.isArray(constraints) ? constraints.flatMap((constraint, index): Candidate[] => typeof constraint === "string" && constraint.trim() ? [{
      source_type: "projected_rule", source_id: `rule:${row.id}:${index}`, parent_decision_id: row.id, version: String(row.updated_at), updated_at: row.updated_at,
      title: `Rule · ${row.title}`, statement: constraint.trim(), rationale: row.rationale,
      evidence: Array.isArray(json(row.source_refs_json, [])) ? json(row.source_refs_json, []) as unknown[] : [],
      visibility: row.visibility, owner_refs_json: row.owner_refs_json, allowed_principals_json: row.allowed_principals_json
    }] : []) : [];
  });
  const publishedRules = await env.OPEN_BRAIN_DB.prepare(
    `SELECT i.source_id, i.source_version, i.title, i.statement, i.rationale, i.evidence_json,
            r.source_digest, r.decision, r.finalized_at, r.id FROM retrospective_results r
     JOIN retrospective_items i ON i.id=r.item_id AND i.session_id=r.session_id
     JOIN retrospective_sessions s ON s.id=r.session_id AND s.tenant_id=i.tenant_id
     WHERE i.tenant_id=? AND r.tenant_id=i.tenant_id AND r.source_digest=i.source_digest
       AND i.source_type='projected_rule' AND s.status='closed'
     ORDER BY r.finalized_at DESC, r.id DESC`
  ).bind(tenantId).all<{ source_id: string; source_version: string; title: string; statement: string; rationale: string; evidence_json: string; source_digest: string; decision: string }>();
  const latestRuleResults = new Map<string, string>();
  for (const row of publishedRules.results) {
    // Normalize legacy version-bearing Rule digests from their immutable item snapshot.
    const snapshot = { source_type: "projected_rule" as const, source_id: row.source_id,
      version: row.source_version, title: row.title, statement: row.statement,
      rationale: row.rationale, evidence: json(row.evidence_json, []) as unknown[] };
    const digest = await digestCandidate(snapshot);
    if (row.source_digest !== digest && row.source_digest !== await digestCandidate(snapshot, true)) continue;
    const key = `${row.source_id}:${digest}`;
    if (!latestRuleResults.has(key)) latestRuleResults.set(key, row.decision);
  }
  let adoptedRules = 0;
  for (const candidate of ruleCandidates) {
    if (latestRuleResults.get(`${candidate.source_id}:${await digestCandidate(candidate)}`) === "adopted") adoptedRules += 1;
  }
  const confirmedDecisions = readableDecisions.filter((row) => ["user_confirmed", "user_corrected", "reviewed"].includes(row.confirmation_state)).length;
  return organizationDashboardSchema.parse({
    contract_version: KNOWLEDGE_MEASUREMENT_LOOP_CONTRACT_VERSION,
    generated_at: now,
    summary: {
      installed_packs: options.includeAll
        ? Number(installedPacks?.count ?? 0)
        : new Set(visibleGoalRows.map((row) => row.installation_id)).size,
      open_retrospectives: openRetrospectives.results.filter((row) =>
        row.project_id === null || canReadAllProjects || readableProjectIds.has(row.project_id)
      ).length
    },
    knowledge: { decisions: readableDecisions.length, rules: legacyRuleCount, rationales: readableRationales.length },
    knowledge_status: {
      decisions: { total: readableDecisions.length, confirmed: confirmedDecisions, needs_review: readableDecisions.length - confirmedDecisions },
      rules: { total: ruleCandidates.length, adopted: adoptedRules, pending: ruleCandidates.length - adoptedRules },
      rationales: { total: readableRationales.length }
    },
    goals
  });
}

const manualSnapshotSchema = z.object({
  value: z.number().finite(),
  observed_at: z.number().int().nonnegative().default(() => Date.now()),
  evidence_ref: z.string().trim().max(2_048).nullable().default(null)
}).strict();

export async function recordKnowledgePackGoalSnapshot(
  env: Env,
  tenantId: string,
  principal: string,
  installationId: string,
  goalLinkId: string,
  idempotencyKey: string,
  raw: unknown
) {
  assertKnowledgeLoopWritable(env, "ORGANIZATION_DASHBOARD_MODE", tenantId);
  const body = parse(manualSnapshotSchema, transportBody(raw));
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT l.metric_key, l.metric_definition_id, l.metric_binding_id, l.scope_type, l.scope_id,
            COALESCE(binding.dimensions_json, '{}') AS dimensions_json, v.definition_json
     FROM knowledge_pack_goal_links l
     JOIN metric_definitions d ON d.id = l.metric_definition_id
     JOIN metric_definition_versions v ON v.metric_definition_id = d.id AND v.version = d.current_version
     LEFT JOIN metric_bindings binding ON binding.tenant_id=l.tenant_id AND binding.id=l.metric_binding_id
     WHERE l.tenant_id = ? AND l.id = ? AND l.knowledge_pack_installation_id = ?`
  ).bind(tenantId, goalLinkId, installationId).first<{
    metric_key: string; metric_definition_id: string; metric_binding_id: string | null; scope_type: string; scope_id: string | null;
    dimensions_json: string; definition_json: string;
  }>();
  if (!row) throw new HttpError(404, "knowledge_pack_goal_not_found", "Knowledge Pack goal not found");
  const definition = json(row.definition_json, {}) as { freshness_seconds?: number };
  const requestDigest = await sha256(canonicalJson({
    metric_definition_id: row.metric_definition_id,
    binding_id: row.metric_binding_id,
    scope_type: row.scope_type,
    scope_id: row.scope_id,
    dimensions: json(row.dimensions_json, {}),
    value: body.value,
    observed_at: body.observed_at,
    evidence_ref: body.evidence_ref
  }));
  const existing = await env.OPEN_BRAIN_DB.prepare(
    `SELECT * FROM metric_snapshots
     WHERE tenant_id=? AND metric_definition_id=? AND idempotency_key=?`
  ).bind(tenantId, row.metric_definition_id, idempotencyKey).first<Record<string, unknown>>();
  if (existing) {
    if (existing.query_digest !== requestDigest) throw new HttpError(409, "idempotency_key_conflict", "The idempotency key was already used for another measurement");
    return {
      ...existing,
      tenant_id: tenantId,
      metric_key: row.metric_key,
      scope_type: row.scope_type,
      scope_id: row.scope_id,
      dimensions: json(String(existing.dimensions_json ?? "{}"), {})
    };
  }
  try {
    return await createMetricSnapshot(env, tenantId, principal, {
      metric_key: row.metric_key,
      binding_id: row.metric_binding_id,
      scope_type: row.scope_type,
      scope_id: row.scope_id,
      value: body.value,
      state: "measured",
      observed_at: body.observed_at,
      expires_at: body.observed_at + Math.max(1, definition.freshness_seconds ?? 86_400) * 1_000,
      evidence_ref: body.evidence_ref,
      dimensions: json(row.dimensions_json, {}),
      source_binding_id: null,
      query_digest: requestDigest,
      idempotency_key: idempotencyKey
    });
  } catch (error) {
    if (!(error instanceof HttpError) || error.code !== "metric_snapshot_duplicate") throw error;
    const raced = await env.OPEN_BRAIN_DB.prepare(
      `SELECT * FROM metric_snapshots
       WHERE tenant_id=? AND metric_definition_id=? AND idempotency_key=?`
    ).bind(tenantId, row.metric_definition_id, idempotencyKey).first<Record<string, unknown>>();
    if (!raced || raced.query_digest !== requestDigest) {
      throw new HttpError(409, "idempotency_key_conflict", "The idempotency key was already used for another measurement");
    }
    return {
      ...raced,
      tenant_id: tenantId,
      metric_key: row.metric_key,
      scope_type: row.scope_type,
      scope_id: row.scope_id,
      dimensions: json(String(raced.dimensions_json ?? "{}"), {})
    };
  }
}

type MetricConnectionEntry = {
  tenant_id: string;
  token?: string;
  owner?: string;
  repo?: string;
  workflow?: string;
  branch?: string;
  deployment_workflow?: string;
  label?: string;
};

function configuredMetricConnections(env: Env, tenantId: string) {
  let parsed: unknown = {};
  try { parsed = JSON.parse(env.GITHUB_METRIC_CONNECTIONS_JSON ?? "{}"); } catch { parsed = {}; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  return Object.entries(parsed as Record<string, unknown>).flatMap(([reference, raw]) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const entry = raw as MetricConnectionEntry;
    return entry.tenant_id === tenantId ? [{ reference, entry }] : [];
  });
}

export async function listMetricConnections(env: Env, tenantId: string, adapterId?: string) {
  assertReadable(env, "METRIC_IMPORT_MODE");
  if (adapterId && adapterId !== "github-actions") throw new HttpError(400, "unsupported_metric_adapter", "Only github-actions is supported");
  return configuredMetricConnections(env, tenantId).sort((left, right) => left.reference.localeCompare(right.reference)).map(({ reference, entry }) => ({
    adapter_id: "github-actions",
    connection_ref: reference.startsWith("connection:") ? reference : `connection:github-actions:${reference}`,
    configured: true,
    label: entry.label ?? `${entry.owner ?? "GitHub"}/${entry.repo ?? "repository"}`,
    repository: entry.owner && entry.repo ? `${entry.owner}/${entry.repo}` : null,
    branch: entry.branch ?? null,
    templates: ["build_success_rate_v1", "build_duration_p95_v1", "queue_duration_p95_v1", "change_failure_rate_v1", "deployment_frequency_v1"]
  }));
}

function metricImportRunFromRow(row: Record<string, unknown>) {
  const { idempotency_key: _idempotencyKey, request_digest: _requestDigest, requested_by: _requestedBy, ...publicRow } = row;
  return metricImportRunSchema.parse({ ...publicRow, contract_version: KNOWLEDGE_MEASUREMENT_LOOP_CONTRACT_VERSION });
}

export async function enqueueMetricImport(
  env: Env,
  tenantId: string,
  principal: string,
  bindingId: string,
  idempotencyKey: string
) {
  assertKnowledgeLoopWritable(env, "METRIC_IMPORT_MODE", tenantId);
  if (!env.METRIC_IMPORT_QUEUE) throw new HttpError(503, "metric_import_queue_unavailable", "Metric import queue is not configured");
  const binding = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, adapter_id, status, connection_ref FROM metric_source_bindings WHERE tenant_id = ? AND id = ?`
  ).bind(tenantId, bindingId).first<{ id: string; adapter_id: string; status: string; connection_ref: string | null }>();
  if (!binding) throw new HttpError(404, "metric_source_binding_not_found", "Metric source binding not found");
  if (binding.adapter_id !== "github-actions") throw new HttpError(400, "unsupported_metric_adapter", "Only github-actions is supported");
  if (!["configured", "active", "error"].includes(binding.status)) throw new HttpError(409, "metric_source_not_ready", "Metric source binding is not ready");
  const connectionRef = binding.connection_ref ?? "";
  const configured = configuredMetricConnections(env, tenantId).some(({ reference }) =>
    reference === connectionRef || `connection:github-actions:${reference}` === connectionRef
  );
  if (!configured) throw new HttpError(409, "metric_connection_not_configured", "The GitHub connection is not configured for this tenant");
  const requestDigest = await sha256(canonicalJson({ source_binding_id: bindingId }));
  const existing = await env.OPEN_BRAIN_DB.prepare(
    "SELECT * FROM metric_source_import_runs WHERE tenant_id = ? AND idempotency_key = ?"
  ).bind(tenantId, idempotencyKey).first<Record<string, unknown>>();
  if (existing) {
    if (existing.request_digest !== requestDigest) throw new HttpError(409, "idempotency_key_conflict", "The idempotency key was already used for another metric import");
    return metricImportRunFromRow(existing);
  }
  const now = Date.now();
  const run = metricImportRunSchema.parse({
    contract_version: KNOWLEDGE_MEASUREMENT_LOOP_CONTRACT_VERSION,
    id: ulid(now), tenant_id: tenantId, source_binding_id: bindingId, status: "queued", attempt: 0,
    error_code: null, error_message: null, snapshot_id: null, queued_at: now,
    started_at: null, lease_expires_at: null, completed_at: null, updated_at: now
  });
  try {
    await env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO metric_source_import_runs(
         id, tenant_id, source_binding_id, status, attempt, idempotency_key, request_digest, requested_by,
         error_code, error_message, snapshot_id, queued_at, started_at, lease_expires_at, completed_at, updated_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(run.id, tenantId, bindingId, run.status, 0, idempotencyKey, requestDigest, principal, null, null, null, now, null, null, null, now).run();
  } catch (error) {
    if (!String(error).includes("UNIQUE")) throw error;
    const raced = await env.OPEN_BRAIN_DB.prepare(
      "SELECT * FROM metric_source_import_runs WHERE tenant_id = ? AND idempotency_key = ?"
    ).bind(tenantId, idempotencyKey).first<Record<string, unknown>>();
    if (!raced || raced.request_digest !== requestDigest) {
      throw new HttpError(409, "idempotency_key_conflict", "The idempotency key was already used for another metric import");
    }
    return metricImportRunFromRow(raced);
  }
  const job: MetricImportJobV1 = metricImportJobSchema.parse({
    contract_version: METRIC_IMPORT_JOB_CONTRACT_VERSION,
    run_id: run.id, tenant_id: tenantId, source_binding_id: bindingId, requested_at: now, attempt: 0
  });
  try {
    await env.METRIC_IMPORT_QUEUE.send(job, { contentType: "json" });
  } catch (error) {
    await env.OPEN_BRAIN_DB.prepare(
      "UPDATE metric_source_import_runs SET status='failed', error_code='queue_send_failed', error_message=?, completed_at=?, updated_at=? WHERE tenant_id=? AND id=?"
    ).bind(String(error).slice(0, 1_000), Date.now(), Date.now(), tenantId, run.id).run();
    throw new HttpError(503, "metric_import_queue_failed", "Metric import could not be queued");
  }
  return run;
}

export async function getMetricImportRun(env: Env, tenantId: string, runId: string) {
  assertReadable(env, "METRIC_IMPORT_MODE");
  const row = await env.OPEN_BRAIN_DB.prepare(
    "SELECT * FROM metric_source_import_runs WHERE tenant_id = ? AND id = ?"
  ).bind(tenantId, runId).first<Record<string, unknown>>();
  if (!row) throw new HttpError(404, "metric_import_run_not_found", "Metric import run not found");
  return metricImportRunFromRow(row);
}

const scheduleCreateSchema = z.object({
  project_id: z.string().trim().min(1).max(128).nullable().default(null),
  participant_group_id: z.string().trim().min(1).max(128).nullable().default(null),
  cadence_days: z.union([z.literal(7), z.literal(14)]),
  next_run_at: z.number().int().nonnegative().default(() => Date.now())
}).strict();
const schedulePatchSchema = z.object({
  cadence_days: z.union([z.literal(7), z.literal(14)]).optional(),
  status: z.enum(["active", "paused", "archived"]).optional(),
  next_run_at: z.number().int().nonnegative().optional()
}).strict().refine((value) => Object.keys(value).length > 0, "at least one field is required");

function scheduleFromRow(row: Record<string, unknown>) {
  return retrospectiveScheduleSchema.parse({ ...row, contract_version: KNOWLEDGE_MEASUREMENT_LOOP_CONTRACT_VERSION });
}

export async function createRetrospectiveSchedule(env: Env, tenantId: string, principal: string, raw: unknown) {
  assertKnowledgeLoopWritable(env, "RETROSPECTIVE_MODE", tenantId);
  const body = parse(scheduleCreateSchema, transportBody(raw));
  if (body.participant_group_id) await groupParticipants(env, tenantId, body.participant_group_id);
  const now = Date.now();
  const result = retrospectiveScheduleSchema.parse({
    contract_version: KNOWLEDGE_MEASUREMENT_LOOP_CONTRACT_VERSION,
    id: ulid(now), tenant_id: tenantId, ...body, status: "active", created_by: principal, created_at: now, updated_at: now
  });
  await env.OPEN_BRAIN_DB.prepare(
    "INSERT INTO retrospective_schedules(id, tenant_id, project_id, participant_group_id, cadence_days, status, next_run_at, created_by, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)"
  ).bind(result.id, tenantId, result.project_id, result.participant_group_id, result.cadence_days, result.status, result.next_run_at, principal, now, now).run();
  return result;
}

export async function listRetrospectiveSchedules(env: Env, tenantId: string) {
  assertReadable(env, "RETROSPECTIVE_MODE");
  const rows = await env.OPEN_BRAIN_DB.prepare(
    "SELECT * FROM retrospective_schedules WHERE tenant_id = ? ORDER BY created_at DESC"
  ).bind(tenantId).all<Record<string, unknown>>();
  return rows.results.map(scheduleFromRow);
}

export async function materializeDueRetrospectives(env: Env, now = Date.now()) {
  if (!env.RETROSPECTIVE_MODE || env.RETROSPECTIVE_MODE === "off") return { created: 0, skipped: true };
  const schedules = await env.OPEN_BRAIN_DB.prepare(
    `SELECT * FROM retrospective_schedules WHERE status='active' AND next_run_at <= ?
     ORDER BY next_run_at, id LIMIT 100`
  ).bind(now).all<Record<string, unknown>>();
  let created = 0;
  for (const schedule of schedules.results) {
    if (!isKnowledgeLoopWritable(env, "RETROSPECTIVE_MODE", String(schedule.tenant_id))) continue;
    const previousRunAt = Number(schedule.next_run_at);
    const nextRunAt = previousRunAt + Number(schedule.cadence_days) * 86_400_000;
    const claim = await env.OPEN_BRAIN_DB.prepare(
      "UPDATE retrospective_schedules SET next_run_at=?, updated_at=? WHERE id=? AND tenant_id=? AND status='active' AND next_run_at=?"
    ).bind(nextRunAt, now, schedule.id, schedule.tenant_id, previousRunAt).run();
    if (!claim.meta.changes) continue;
    try {
      await createRetrospective(env, String(schedule.tenant_id), String(schedule.created_by), {
        project_id: schedule.project_id ?? null,
        participant_group_id: schedule.participant_group_id ?? null,
        schedule_id: schedule.id,
        title: `判断軸のふりかえり · ${new Date(previousRunAt).toISOString().slice(0, 10)}`,
        participant_principals: [String(schedule.created_by)]
      });
      created += 1;
    } catch (error) {
      await env.OPEN_BRAIN_DB.prepare(
        "UPDATE retrospective_schedules SET next_run_at=?, updated_at=? WHERE id=? AND tenant_id=? AND next_run_at=?"
      ).bind(previousRunAt, Date.now(), schedule.id, schedule.tenant_id, nextRunAt).run();
      throw error;
    }
  }
  return { created, skipped: false };
}

export async function updateRetrospectiveSchedule(env: Env, tenantId: string, id: string, raw: unknown) {
  assertKnowledgeLoopWritable(env, "RETROSPECTIVE_MODE", tenantId);
  const body = parse(schedulePatchSchema, transportBody(raw));
  const current = await env.OPEN_BRAIN_DB.prepare(
    "SELECT * FROM retrospective_schedules WHERE tenant_id=? AND id=?"
  ).bind(tenantId, id).first<Record<string, unknown>>();
  if (!current) throw new HttpError(404, "retrospective_schedule_not_found", "Retrospective schedule not found");
  if (current.status === "archived" && body.status !== "archived") throw new HttpError(409, "retrospective_schedule_terminal", "Archived schedules cannot be reactivated");
  const next = { ...current, ...body, updated_at: Date.now() };
  await env.OPEN_BRAIN_DB.prepare(
    "UPDATE retrospective_schedules SET cadence_days=?, status=?, next_run_at=?, updated_at=? WHERE tenant_id=? AND id=?"
  ).bind(next.cadence_days, next.status, next.next_run_at, next.updated_at, tenantId, id).run();
  return scheduleFromRow(next);
}

const sessionCreateSchema = z.object({
  project_id: z.string().trim().min(1).max(128).nullable().default(null),
  participant_group_id: z.string().trim().min(1).max(128).nullable().default(null),
  schedule_id: z.string().trim().min(1).max(128).nullable().default(null),
  title: z.string().trim().min(1).max(240).default("判断軸のふりかえり"),
  participant_principals: z.array(z.string().trim().min(1).max(128)).max(100).default([])
}).strict();

type Candidate = {
  source_type: "decision_memory" | "decision_rationale" | "projected_rule";
  source_id: string;
  parent_decision_id: string;
  version: string;
  updated_at: number;
  title: string;
  statement: string;
  rationale: string;
  evidence: unknown[];
  visibility: string;
  owner_refs_json: string;
  allowed_principals_json: string;
};

type EligibleCandidate = Candidate & { eligible_principals: string[]; source_policy_version: number | null };

async function groupParticipants(env: Env, tenantId: string, groupId: string): Promise<string[]> {
  const group = await env.OPEN_BRAIN_DB.prepare(
    "SELECT id FROM groups WHERE tenant_id=? AND id=? AND deleted_at IS NULL"
  ).bind(tenantId, groupId).first();
  if (!group) throw new HttpError(400, "retrospective_group_invalid", "The participant group must be active and belong to this tenant");
  const members = await env.OPEN_BRAIN_DB.prepare(
    "SELECT principal FROM group_members WHERE tenant_id=? AND group_id=? ORDER BY principal"
  ).bind(tenantId, groupId).all<{ principal: string }>();
  if (members.results.length === 0) throw new HttpError(409, "retrospective_group_empty", "The participant group has no members");
  return members.results.map((row) => row.principal);
}

function principalsCanRead(row: { visibility?: string; owner_refs_json?: string; allowed_principals_json?: string }, principals: string[]) {
  if (row.visibility !== "restricted") return true;
  const allowed = json(row.allowed_principals_json, []);
  const owners = json(row.owner_refs_json, []);
  const ids = new Set([
    ...(Array.isArray(allowed) ? allowed.filter((item): item is string => typeof item === "string") : []),
    ...(Array.isArray(owners) ? owners.flatMap((item) => typeof item === "string" ? [item] : item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string" ? [String((item as { id: string }).id)] : []) : [])
  ]);
  return principals.every((principal) => ids.has(principal));
}

async function retrospectiveCandidates(
  env: Env,
  tenantId: string,
  projectId: string | null,
  principals: string[],
  creator: string,
  requireGroupMember: boolean
): Promise<EligibleCandidate[]> {
  const decisions = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, title, decision, rationale, constraints_json, source_refs_json, updated_at, visibility, owner_refs_json, allowed_principals_json
     FROM decision_memories
     WHERE tenant_id = ? AND project_id IS ? AND status NOT IN ('retired','superseded')
     ORDER BY updated_at DESC, id ASC LIMIT 20`
  ).bind(tenantId, projectId).all<{ id: string; title: string; decision: string; rationale: string; constraints_json: string; source_refs_json: string; updated_at: number; visibility: string; owner_refs_json: string; allowed_principals_json: string }>();
  const rationales = await env.OPEN_BRAIN_DB.prepare(
    `SELECT r.id, r.memory_id, r.conclusion, r.reason_summary, r.created_at, d.visibility, d.owner_refs_json, d.allowed_principals_json
     FROM decision_rationales r
     JOIN decision_memories d ON d.tenant_id=r.tenant_id AND d.id=r.memory_id
     WHERE r.tenant_id = ? AND r.project_id IS ? AND r.status NOT IN ('retired','superseded')
     ORDER BY r.created_at DESC, r.id ASC LIMIT 20`
  ).bind(tenantId, projectId).all<{ id: string; memory_id: string; conclusion: string; reason_summary: string; created_at: number; visibility: string; owner_refs_json: string; allowed_principals_json: string }>();
  const candidates: Candidate[] = [
    ...decisions.results.map((row): Candidate => ({
      source_type: "decision_memory", source_id: row.id, parent_decision_id: row.id, version: String(row.updated_at), updated_at: row.updated_at,
      title: row.title, statement: row.decision, rationale: row.rationale,
      evidence: Array.isArray(json(row.source_refs_json, [])) ? json(row.source_refs_json, []) as unknown[] : [],
      visibility: row.visibility, owner_refs_json: row.owner_refs_json, allowed_principals_json: row.allowed_principals_json
    })),
    ...decisions.results.flatMap((row) => {
      const constraints = json(row.constraints_json, []);
      return Array.isArray(constraints) ? constraints.flatMap((constraint, index): Candidate[] => typeof constraint === "string" && constraint.trim() ? [{
        source_type: "projected_rule",
        source_id: `rule:${row.id}:${index}`,
        parent_decision_id: row.id,
        version: String(row.updated_at),
        updated_at: row.updated_at,
        title: `Rule · ${row.title}`,
        statement: constraint.trim(),
        rationale: row.rationale,
        evidence: Array.isArray(json(row.source_refs_json, [])) ? json(row.source_refs_json, []) as unknown[] : [],
        visibility: row.visibility, owner_refs_json: row.owner_refs_json, allowed_principals_json: row.allowed_principals_json
      }] : []) : [];
    }),
    ...rationales.results.map((row): Candidate => ({
      source_type: "decision_rationale", source_id: row.id, parent_decision_id: row.memory_id, version: String(row.created_at), updated_at: row.created_at,
      title: row.conclusion, statement: row.conclusion, rationale: row.reason_summary, evidence: [],
      visibility: row.visibility, owner_refs_json: row.owner_refs_json, allowed_principals_json: row.allowed_principals_json
    }))
  ];
  const policies = await loadAccessPolicies(env, tenantId, "decision_memory", candidates.map((candidate) => candidate.parent_decision_id));
  const groupIdsByPrincipal = new Map<string, Set<string>>();
  await Promise.all(principals.map(async (candidatePrincipal) => {
    groupIdsByPrincipal.set(candidatePrincipal, await loadPrincipalGroupIds(env, tenantId, candidatePrincipal));
  }));
  const eligible: EligibleCandidate[] = [];
  for (const candidate of candidates.sort((left, right) => right.updated_at - left.updated_at || left.source_type.localeCompare(right.source_type) || left.source_id.localeCompare(right.source_id))) {
    const policy = policies.get(candidate.parent_decision_id);
    const eligiblePrincipals: string[] = [];
    for (const candidatePrincipal of principals) {
      if (candidatePrincipal !== creator && !await principalCanReadProject(env, tenantId, candidatePrincipal, projectId)) continue;
      const groupIds = groupIdsByPrincipal.get(candidatePrincipal) ?? new Set<string>();
      const legacyAllowed = candidate.visibility !== "restricted" || principalsCanRead(candidate, [candidatePrincipal]) || [...groupIds].some((groupId) => principalsCanRead(candidate, [groupId]));
      const readable = policy
        ? await canReadResourceWithGroups(env, policy, { tenantId, principal: candidatePrincipal, projectId, isAdmin: false }, groupIds)
        : legacyAllowed;
      if (readable) eligiblePrincipals.push(candidatePrincipal);
    }
    if (!eligiblePrincipals.includes(creator)) continue;
    if (requireGroupMember && !eligiblePrincipals.some((candidatePrincipal) => candidatePrincipal !== creator)) continue;
    eligible.push({ ...candidate, eligible_principals: eligiblePrincipals, source_policy_version: policy?.policy_version ?? null });
    if (eligible.length === 20) break;
  }
  return eligible;
}

async function digestCandidate(candidate: Pick<Candidate, "source_type" | "source_id" | "version" | "title" | "statement" | "rationale" | "evidence">, legacy = false) {
  return sha256(canonicalJson({
    source_type: candidate.source_type,
    source_id: candidate.source_id,
    ...(candidate.source_type === "projected_rule" && !legacy ? {} : { version: candidate.version }),
    title: candidate.title,
    statement: candidate.statement,
    rationale: candidate.rationale,
    evidence: candidate.evidence
  }));
}

export async function createRetrospective(env: Env, tenantId: string, principal: string, raw: unknown) {
  assertKnowledgeLoopWritable(env, "RETROSPECTIVE_MODE", tenantId);
  const body = parse(sessionCreateSchema, transportBody(raw));
  let participantGroupId = body.participant_group_id;
  if (body.schedule_id) {
    const schedule = await env.OPEN_BRAIN_DB.prepare(
      "SELECT id, participant_group_id FROM retrospective_schedules WHERE tenant_id=? AND id=? AND status='active'"
    ).bind(tenantId, body.schedule_id).first<{ id: string; participant_group_id: string | null }>();
    if (!schedule) throw new HttpError(409, "retrospective_schedule_inactive", "Retrospective schedule is not active");
    if (participantGroupId !== null && participantGroupId !== schedule.participant_group_id) {
      throw new HttpError(409, "retrospective_schedule_group_mismatch", "The retrospective group must match its schedule");
    }
    participantGroupId = schedule.participant_group_id;
  }
  const now = Date.now();
  const id = ulid(now);
  const groupMembers = participantGroupId ? await groupParticipants(env, tenantId, participantGroupId) : [];
  const participants = [...new Set(participantGroupId
    ? [principal, ...groupMembers]
    : [principal, ...body.participant_principals])];
  const candidates = await retrospectiveCandidates(env, tenantId, body.project_id, participants, principal, Boolean(participantGroupId));
  if (candidates.length === 0) throw new HttpError(409, "no_eligible_candidates", "No retrospective candidates are readable by the selected participants");
  const statements: ReturnType<Env["OPEN_BRAIN_DB"]["prepare"]>[] = [env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO retrospective_sessions(id, tenant_id, project_id, participant_group_id, schedule_id, status, title, created_by, opened_at, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, tenantId, body.project_id, participantGroupId, body.schedule_id, "open", body.title, principal, now, now, now)];
  for (const participant of participants) {
    statements.push(env.OPEN_BRAIN_DB.prepare(
      "INSERT INTO retrospective_participants(session_id, tenant_id, principal, created_at) VALUES(?,?,?,?)"
    ).bind(id, tenantId, participant, now));
  }
  for (const [ordinal, candidate] of candidates.entries()) {
    const itemId = ulid(now + ordinal + 1);
    statements.push(env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO retrospective_items(
         id, tenant_id, session_id, ordinal, source_type, source_id, source_version,
         source_digest, title, statement, rationale, evidence_json, parent_decision_id, source_policy_version, created_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(itemId, tenantId, id, ordinal, candidate.source_type, candidate.source_id,
      candidate.version, await digestCandidate(candidate), candidate.title, candidate.statement, candidate.rationale,
      canonicalJson(candidate.evidence), candidate.parent_decision_id, candidate.source_policy_version, now));
    for (const eligiblePrincipal of candidate.eligible_principals) {
      statements.push(env.OPEN_BRAIN_DB.prepare(
        `INSERT INTO retrospective_item_eligible_participants(tenant_id, session_id, item_id, principal, created_at)
         VALUES(?,?,?,?,?)`
      ).bind(tenantId, id, itemId, eligiblePrincipal, now));
    }
  }
  await env.OPEN_BRAIN_DB.batch(statements);
  return getRetrospective(env, tenantId, id, principal, true);
}

export async function listRetrospectives(env: Env, tenantId: string, principal: string, includeAll = false) {
  assertReadable(env, "RETROSPECTIVE_MODE");
  const rows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT s.id FROM retrospective_sessions s
     WHERE s.tenant_id=? AND (?=1 OR EXISTS(
       SELECT 1 FROM retrospective_participants p WHERE p.session_id=s.id AND p.tenant_id=s.tenant_id AND p.principal=?
     )) ORDER BY s.opened_at DESC LIMIT 100`
  ).bind(tenantId, includeAll ? 1 : 0, principal).all<Record<string, unknown>>();
  return Promise.all(rows.results.map(async (row) => {
    const { items, ...session } = await getRetrospective(env, tenantId, String(row.id), principal, includeAll, false);
    return { ...session, item_count: items.length, participant_count: session.progress!.participants,
      eligible_response_count: session.progress!.eligible_responses, received_response_count: session.progress!.received_responses };
  }));
}

async function assertParticipant(env: Env, tenantId: string, sessionId: string, principal: string, adminAllowed: boolean) {
  if (adminAllowed) return;
  const participant = await env.OPEN_BRAIN_DB.prepare(
    "SELECT 1 AS allowed FROM retrospective_participants WHERE tenant_id=? AND session_id=? AND principal=?"
  ).bind(tenantId, sessionId, principal).first();
  if (!participant) throw new HttpError(403, "retrospective_participant_required", "You are not a participant in this retrospective");
}

async function retrospectiveSourceReadable(
  env: Env,
  tenantId: string,
  sourceType: unknown,
  sourceId: unknown,
  principal: string,
  projectAdmin = false
) {
  const projectedDecisionId = sourceType === "projected_rule" ? String(sourceId).split(":").slice(1, -1).join(":") : null;
  const row = sourceType === "decision_rationale"
    ? await env.OPEN_BRAIN_DB.prepare(
      `SELECT d.id, d.project_id, d.visibility, d.owner_refs_json, d.allowed_principals_json
       FROM decision_rationales r JOIN decision_memories d ON d.tenant_id=r.tenant_id AND d.id=r.memory_id
       WHERE r.tenant_id=? AND r.id=? AND r.status NOT IN ('retired','superseded')`
    ).bind(tenantId, sourceId).first<{ id: string; project_id: string | null; visibility: string; owner_refs_json: string; allowed_principals_json: string }>()
    : await env.OPEN_BRAIN_DB.prepare(
      `SELECT id, project_id, visibility, owner_refs_json, allowed_principals_json FROM decision_memories
       WHERE tenant_id=? AND id=? AND status NOT IN ('retired','superseded')`
    ).bind(tenantId, projectedDecisionId ?? sourceId).first<{ id: string; project_id: string | null; visibility: string; owner_refs_json: string; allowed_principals_json: string }>();
  if (!row) return false;
  if (!projectAdmin && !await principalCanReadProject(env, tenantId, principal, row.project_id)) return false;
  const [policyMap, groupIds] = await Promise.all([
    loadAccessPolicies(env, tenantId, "decision_memory", [row.id]),
    loadPrincipalGroupIds(env, tenantId, principal)
  ]);
  const policy = policyMap.get(row.id);
  if (policy) return canReadResourceWithGroups(env, policy, { tenantId, principal, projectId: row.project_id, isAdmin: false }, groupIds);
  return principalsCanRead(row, [principal]) || [...groupIds].some((groupId) => principalsCanRead(row, [groupId]));
}

async function retrospectiveParentDecisionId(env: Env, tenantId: string, item: Record<string, unknown>): Promise<string | null> {
  if (item.source_type === "decision_memory") return String(item.source_id);
  if (item.source_type === "projected_rule") return String(item.source_id).split(":").slice(1, -1).join(":") || null;
  if (item.source_type !== "decision_rationale") return null;
  const row = await env.OPEN_BRAIN_DB.prepare(
    "SELECT memory_id FROM decision_rationales WHERE tenant_id=? AND id=?"
  ).bind(tenantId, item.source_id).first<{ memory_id: string }>();
  return row?.memory_id ?? null;
}

export async function getRetrospective(env: Env, tenantId: string, id: string, principal: string, adminAllowed = false, markViewed = true) {
  assertReadable(env, "RETROSPECTIVE_MODE");
  await assertParticipant(env, tenantId, id, principal, adminAllowed);
  const session = await env.OPEN_BRAIN_DB.prepare(
    "SELECT * FROM retrospective_sessions WHERE tenant_id=? AND id=?"
  ).bind(tenantId, id).first<Record<string, unknown>>();
  if (!session) throw new HttpError(404, "retrospective_not_found", "Retrospective not found");
  const items = await env.OPEN_BRAIN_DB.prepare(
    `SELECT i.*, r.decision AS response_decision, r.note AS response_note, r.updated_at AS response_updated_at
     FROM retrospective_items i
     JOIN retrospective_item_eligible_participants eligible
       ON eligible.tenant_id=i.tenant_id AND eligible.session_id=i.session_id AND eligible.item_id=i.id AND eligible.principal=?
     LEFT JOIN retrospective_responses r ON r.item_id=i.id AND r.principal=?
     WHERE i.tenant_id=? AND i.session_id=? ORDER BY i.ordinal`
  ).bind(principal, principal, tenantId, id).all<Record<string, unknown>>();
  const visibleItems = (await Promise.all(items.results.map(async (item) => ({
    item,
    readable: await retrospectiveSourceReadable(
      env, tenantId, item.source_type, item.source_id, principal,
      Boolean(adminAllowed && session.created_by === principal)
    )
  })))).filter((entry) => entry.readable).map((entry) => entry.item);
  const summaries = await env.OPEN_BRAIN_DB.prepare(
    `SELECT eligible.item_id,
            COUNT(*) AS eligible,
            COUNT(response.id) AS received,
            SUM(CASE WHEN response.decision='adopt' THEN 1 ELSE 0 END) AS adopt,
            SUM(CASE WHEN response.decision='do_not_adopt' THEN 1 ELSE 0 END) AS do_not_adopt,
            SUM(CASE WHEN response.decision='defer' THEN 1 ELSE 0 END) AS defer
     FROM retrospective_item_eligible_participants eligible
     LEFT JOIN retrospective_responses response
       ON response.tenant_id=eligible.tenant_id AND response.session_id=eligible.session_id
      AND response.item_id=eligible.item_id AND response.principal=eligible.principal
     WHERE eligible.tenant_id=? AND eligible.session_id=? GROUP BY eligible.item_id`
  ).bind(tenantId, id).all<{ item_id: string; eligible: number; received: number; adopt: number; do_not_adopt: number; defer: number }>();
  const summaryByItem = new Map(summaries.results.map((row) => [row.item_id, row]));
  const progress = await env.OPEN_BRAIN_DB.prepare(
    `WITH visible AS (
       SELECT eligible.principal, response.id AS response_id
       FROM retrospective_item_eligible_participants eligible
       LEFT JOIN retrospective_responses response ON response.tenant_id=eligible.tenant_id
         AND response.session_id=eligible.session_id AND response.item_id=eligible.item_id AND response.principal=eligible.principal
       WHERE eligible.tenant_id=? AND eligible.session_id=? AND eligible.item_id IN (SELECT value FROM json_each(?))
     ) SELECT COUNT(DISTINCT principal) AS participants,
       (SELECT COUNT(*) FROM (SELECT principal FROM visible GROUP BY principal HAVING COUNT(*)=COUNT(response_id))) AS completed_participants,
       COUNT(*) AS eligible_responses, COUNT(response_id) AS received_responses FROM visible`
  ).bind(tenantId, id, JSON.stringify(visibleItems.map((item) => item.id))).first<{
    participants: number; completed_participants: number; eligible_responses: number; received_responses: number;
  }>();
  const now = Date.now();
  if (markViewed && isKnowledgeLoopWritable(env, "RETROSPECTIVE_MODE", tenantId)) {
    for (const item of visibleItems) {
      await env.OPEN_BRAIN_DB.prepare(
        "INSERT OR IGNORE INTO retrospective_item_viewers(item_id, tenant_id, principal, viewed_at) VALUES(?,?,?,?)"
      ).bind(item.id, tenantId, principal, now).run();
    }
  }
  const {
    close_idempotency_key: _closeIdempotencyKey,
    close_request_digest: _closeRequestDigest,
    close_operation_id: _closeOperationId,
    participant_count_at_close: _participantCountAtClose,
    unanswered_response_count_at_close: _unansweredResponseCountAtClose,
    ...publicSession
  } = session;
  const parsedItems = await Promise.all(visibleItems.map(async (item) => {
    const summary = summaryByItem.get(String(item.id));
    const received = Number(summary?.received ?? 0);
    return {
      id: item.id, ordinal: Number(item.ordinal), source_type: item.source_type, source_id: item.source_id,
      parent_decision_id: await retrospectiveParentDecisionId(env, tenantId, item),
      source_version: item.source_version, source_digest: item.source_digest, title: item.title,
      statement: item.statement, rationale: item.rationale, evidence: json(String(item.evidence_json ?? "[]"), []),
      response: item.response_decision ? { decision: item.response_decision, note: item.response_note ?? null, updated_at: Number(item.response_updated_at) } : null,
      response_summary: {
        eligible: Number(summary?.eligible ?? 0), received,
        unanswered: Math.max(0, Number(summary?.eligible ?? 0) - received),
        adopt: Number(summary?.adopt ?? 0), do_not_adopt: Number(summary?.do_not_adopt ?? 0), defer: Number(summary?.defer ?? 0),
        adoption_rate: received > 0 ? Number(summary?.adopt ?? 0) / received : null
      }
    };
  }));
  const participants = Number(progress?.participants ?? 0);
  const completedParticipants = Number(progress?.completed_participants ?? 0);
  const eligibleResponses = Number(progress?.eligible_responses ?? 0);
  const receivedResponses = Number(progress?.received_responses ?? 0);
  const isCreatorAdmin = Boolean(adminAllowed && session.created_by === principal);
  const canClose = isCreatorAdmin && session.status === "open" && isKnowledgeLoopWritable(env, "RETROSPECTIVE_MODE", tenantId);
  const allItemCount = await env.OPEN_BRAIN_DB.prepare(
    "SELECT COUNT(*) AS count FROM retrospective_items WHERE tenant_id=? AND session_id=?"
  ).bind(tenantId, id).first<{ count: number }>();
  return retrospectiveSessionSchema.parse({
    ...publicSession,
    contract_version: KNOWLEDGE_MEASUREMENT_LOOP_CONTRACT_VERSION,
    items: parsedItems,
    viewer: { role: isCreatorAdmin ? "admin" : "participant", can_close: canClose },
    progress: {
      participants, completed_participants: completedParticipants, pending_participants: Math.max(0, participants - completedParticipants),
      eligible_responses: eligibleResponses, received_responses: receivedResponses,
      unanswered_responses: Math.max(0, eligibleResponses - receivedResponses)
    },
    close_summary: session.status === "closed" && session.participant_count_at_close !== null && visibleItems.length === Number(allItemCount?.count)
      ? { participant_count: Number(session.participant_count_at_close), unanswered_response_count: Number(session.unanswered_response_count_at_close ?? 0) }
      : null
  });
}

const responseSchema = z.object({
  decision: z.enum(["adopt", "do_not_adopt", "defer"]),
  note: z.string().trim().max(2_000).nullable().default(null)
}).strict();

export async function putRetrospectiveResponse(env: Env, tenantId: string, sessionId: string, itemId: string, principal: string, raw: unknown) {
  assertKnowledgeLoopWritable(env, "RETROSPECTIVE_MODE", tenantId);
  await assertParticipant(env, tenantId, sessionId, principal, false);
  const body = parse(responseSchema, transportBody(raw));
  const item = await env.OPEN_BRAIN_DB.prepare(
    `SELECT i.id, i.source_type, i.source_id, s.status, s.created_by FROM retrospective_items i JOIN retrospective_sessions s ON s.id=i.session_id
     JOIN retrospective_item_eligible_participants eligible
       ON eligible.tenant_id=i.tenant_id AND eligible.session_id=i.session_id AND eligible.item_id=i.id AND eligible.principal=?
     WHERE i.tenant_id=? AND i.session_id=? AND i.id=?`
  ).bind(principal, tenantId, sessionId, itemId).first<{ id: string; status: string; created_by: string }>();
  if (!item) throw new HttpError(404, "retrospective_item_not_found", "Retrospective item not found");
  if (item.status !== "open") throw new HttpError(409, "retrospective_closed", "Responses can only be changed while the retrospective is open");
  if (!await retrospectiveSourceReadable(
    env, tenantId, (item as { source_type?: unknown }).source_type,
    (item as { source_id?: unknown }).source_id, principal, item.created_by === principal
  )) {
    throw new HttpError(403, "retrospective_item_forbidden", "The source is no longer visible to this participant");
  }
  const now = Date.now();
  const id = ulid(now);
  const persisted = await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO retrospective_responses(id, tenant_id, session_id, item_id, principal, decision, note, created_at, updated_at)
     SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(
       SELECT 1 FROM retrospective_sessions WHERE tenant_id=? AND id=? AND status='open'
     )
     ON CONFLICT(session_id, item_id, principal) DO UPDATE SET
       decision=excluded.decision, note=excluded.note, updated_at=excluded.updated_at
     WHERE EXISTS(
       SELECT 1 FROM retrospective_sessions WHERE tenant_id=? AND id=? AND status='open'
     )`
  ).bind(id, tenantId, sessionId, itemId, principal, body.decision, body.note, now, now,
    tenantId, sessionId, tenantId, sessionId).run();
  if (!persisted.meta.changes) throw new HttpError(409, "retrospective_closed", "Responses can only be changed while the retrospective is open");
  return { id, session_id: sessionId, item_id: itemId, principal, ...body, updated_at: now };
}

async function verifyRetrospectiveSource(env: Env, tenantId: string, item: Record<string, unknown>): Promise<boolean> {
  let candidate: Candidate | null = null;
  if (item.source_type === "decision_memory") {
    const row = await env.OPEN_BRAIN_DB.prepare(
      "SELECT id, title, decision, rationale, source_refs_json, updated_at, visibility, owner_refs_json, allowed_principals_json FROM decision_memories WHERE tenant_id=? AND id=? AND status NOT IN ('retired','superseded')"
    ).bind(tenantId, item.source_id).first<{ id: string; title: string; decision: string; rationale: string; source_refs_json: string; updated_at: number; visibility: string; owner_refs_json: string; allowed_principals_json: string }>();
    if (row) candidate = { source_type: "decision_memory", source_id: row.id, parent_decision_id: row.id, version: String(row.updated_at), updated_at: row.updated_at, title: row.title, statement: row.decision, rationale: row.rationale, evidence: json(row.source_refs_json, []) as unknown[], visibility: row.visibility, owner_refs_json: row.owner_refs_json, allowed_principals_json: row.allowed_principals_json };
  } else if (item.source_type === "decision_rationale") {
    const row = await env.OPEN_BRAIN_DB.prepare(
      `SELECT r.id, r.memory_id, r.conclusion, r.reason_summary, r.created_at, d.visibility, d.owner_refs_json, d.allowed_principals_json
       FROM decision_rationales r JOIN decision_memories d ON d.tenant_id=r.tenant_id AND d.id=r.memory_id
       WHERE r.tenant_id=? AND r.id=? AND r.status NOT IN ('retired','superseded')`
    ).bind(tenantId, item.source_id).first<{ id: string; memory_id: string; conclusion: string; reason_summary: string; created_at: number; visibility: string; owner_refs_json: string; allowed_principals_json: string }>();
    if (row) candidate = { source_type: "decision_rationale", source_id: row.id, parent_decision_id: row.memory_id, version: String(row.created_at), updated_at: row.created_at, title: row.conclusion, statement: row.conclusion, rationale: row.reason_summary, evidence: [], visibility: row.visibility, owner_refs_json: row.owner_refs_json, allowed_principals_json: row.allowed_principals_json };
  } else if (item.source_type === "projected_rule") {
    const parts = String(item.source_id).split(":");
    const index = Number(parts.pop());
    parts.shift();
    const decisionId = parts.join(":");
    const row = await env.OPEN_BRAIN_DB.prepare(
      "SELECT id, title, rationale, constraints_json, source_refs_json, updated_at, visibility, owner_refs_json, allowed_principals_json FROM decision_memories WHERE tenant_id=? AND id=? AND status NOT IN ('retired','superseded')"
    ).bind(tenantId, decisionId).first<{ id: string; title: string; rationale: string; constraints_json: string; source_refs_json: string; updated_at: number; visibility: string; owner_refs_json: string; allowed_principals_json: string }>();
    const constraints = row ? json(row.constraints_json, []) : [];
    const statement = Array.isArray(constraints) && typeof constraints[index] === "string" ? constraints[index] : null;
    if (row && statement) candidate = {
      source_type: "projected_rule", source_id: String(item.source_id), parent_decision_id: row.id, version: String(row.updated_at), updated_at: row.updated_at,
      title: `Rule · ${row.title}`, statement: statement.trim(), rationale: row.rationale,
      evidence: Array.isArray(json(row.source_refs_json, [])) ? json(row.source_refs_json, []) as unknown[] : [],
      visibility: row.visibility, owner_refs_json: row.owner_refs_json, allowed_principals_json: row.allowed_principals_json
    };
  }
  return candidate !== null && candidate.version === String(item.source_version)
    && (await digestCandidate(candidate) === item.source_digest || await digestCandidate(candidate, true) === item.source_digest);
}

const closeRetrospectiveSchema = z.object({
  items: z.array(z.object({
    item_id: z.string().trim().min(1).max(128),
    decision: z.enum(["adopted", "not_adopted", "deferred"])
  }).strict()).min(1).max(20),
  acknowledge_unanswered: z.boolean().default(false)
}).strict();

export async function closeRetrospective(
  env: Env,
  tenantId: string,
  id: string,
  principal: string,
  idempotencyKey: string,
  raw: unknown
) {
  assertKnowledgeLoopWritable(env, "RETROSPECTIVE_MODE", tenantId);
  const body = parse(closeRetrospectiveSchema, transportBody(raw));
  const normalizedItems = [...body.items].sort((left, right) => left.item_id.localeCompare(right.item_id));
  const requestDigest = await sha256(canonicalJson({ items: normalizedItems, acknowledge_unanswered: body.acknowledge_unanswered }));
  const legacyRequestDigest = await sha256(canonicalJson({ items: normalizedItems }));
  const session = await env.OPEN_BRAIN_DB.prepare(
    "SELECT status, created_by, close_idempotency_key, close_request_digest FROM retrospective_sessions WHERE tenant_id=? AND id=?"
  ).bind(tenantId, id).first<{ status: string; created_by: string; close_idempotency_key: string | null; close_request_digest: string | null }>();
  if (!session) throw new HttpError(404, "retrospective_not_found", "Retrospective not found");
  if (session.created_by !== principal) throw new HttpError(403, "retrospective_closer_required", "Only the administrator who created this retrospective can close it");
  if (session.status === "closed") {
    if (session.close_idempotency_key !== idempotencyKey || (session.close_request_digest !== requestDigest && session.close_request_digest !== legacyRequestDigest)) {
      throw new HttpError(409, "idempotency_key_conflict", "The retrospective was already closed with another result set");
    }
    const existing = await env.OPEN_BRAIN_DB.prepare(
      "SELECT id, session_id, item_id, decision, source_digest, finalized_by, finalized_at FROM retrospective_results WHERE tenant_id=? AND session_id=? ORDER BY item_id"
    ).bind(tenantId, id).all<Record<string, unknown>>();
    return { session_id: id, status: "closed", results: existing.results.map((row) => retrospectiveResultSchema.parse(row)) };
  }
  if (session.status !== "open") throw new HttpError(409, "retrospective_not_open", "Only open retrospectives can be closed");
  const items = await env.OPEN_BRAIN_DB.prepare(
    "SELECT * FROM retrospective_items WHERE tenant_id=? AND session_id=? ORDER BY ordinal"
  ).bind(tenantId, id).all<Record<string, unknown>>();
  if (items.results.length !== normalizedItems.length || items.results.some((item) => !normalizedItems.some((requested) => requested.item_id === item.id))) {
    throw new HttpError(409, "retrospective_results_incomplete", "An explicit result is required for every retrospective item");
  }
  const counts = await env.OPEN_BRAIN_DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM retrospective_item_eligible_participants eligible
        WHERE eligible.tenant_id=? AND eligible.session_id=? AND NOT EXISTS(
          SELECT 1 FROM retrospective_responses response
          WHERE response.tenant_id=eligible.tenant_id AND response.session_id=eligible.session_id
            AND response.item_id=eligible.item_id AND response.principal=eligible.principal
        )) AS unanswered_count`
  ).bind(tenantId, id).first<{ unanswered_count: number }>();
  const unansweredCount = Number(counts?.unanswered_count ?? 0);
  if (unansweredCount > 0 && !body.acknowledge_unanswered) {
    throw new HttpError(409, "retrospective_unanswered_ack_required", "Acknowledge unanswered responses before closing this retrospective");
  }
  const now = Date.now();
  const results: Array<z.infer<typeof retrospectiveResultSchema>> = [];
  const closeOperationId = ulid();
  const statements: ReturnType<Env["OPEN_BRAIN_DB"]["prepare"]>[] = [];
  for (const item of items.results) {
    if (!await verifyRetrospectiveSource(env, tenantId, item)) {
      throw new HttpError(409, "retrospective_source_changed", `The source changed after the retrospective opened: ${String(item.id)}`);
    }
    const eligibleParticipants = await env.OPEN_BRAIN_DB.prepare(
      "SELECT principal FROM retrospective_item_eligible_participants WHERE tenant_id=? AND session_id=? AND item_id=? ORDER BY principal"
    ).bind(tenantId, id, item.id).all<{ principal: string }>();
    for (const participant of eligibleParticipants.results) {
      if (!await retrospectiveSourceReadable(
        env, tenantId, item.source_type, item.source_id, participant.principal, participant.principal === principal
      )) {
        throw new HttpError(409, "retrospective_eligibility_changed", `An eligible participant can no longer read the source: ${String(item.id)}`);
      }
    }
    const decision = normalizedItems.find((requested) => requested.item_id === item.id)!.decision;
    const result = retrospectiveResultSchema.parse({
      id: ulid(now + results.length), session_id: id, item_id: item.id, decision,
      source_digest: item.source_digest, finalized_by: principal, finalized_at: now
    });
    statements.push(env.OPEN_BRAIN_DB.prepare(
      `INSERT OR IGNORE INTO retrospective_results(id, tenant_id, session_id, item_id, decision, source_digest, finalized_by, finalized_at)
       SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(
         SELECT 1 FROM retrospective_sessions WHERE tenant_id=? AND id=? AND status='closed'
           AND close_operation_id=? AND close_request_digest=?
       )`
    ).bind(result.id, tenantId, id, item.id, decision, item.source_digest, principal, now,
      tenantId, id, closeOperationId, requestDigest));
    if (decision === "adopted" && item.source_type === "decision_memory") {
      const note = `Retrospective ${id}で採用`;
      statements.push(env.OPEN_BRAIN_DB.prepare(
        `UPDATE decision_memories SET confirmation_state='reviewed', confirmation_note=?, confirmed_at=?, updated_at=?
         WHERE tenant_id=? AND id=? AND status NOT IN ('retired','superseded')
           AND EXISTS(SELECT 1 FROM retrospective_sessions WHERE tenant_id=? AND id=? AND status='closed'
             AND close_operation_id=? AND close_request_digest=?)`
      ).bind(note, now, now, tenantId, item.source_id, tenantId, id, closeOperationId, requestDigest));
      statements.push(env.OPEN_BRAIN_DB.prepare(
        `INSERT INTO decision_memory_versions(
           id, decision_memory_id, tenant_id, operation, snapshot_json, actor_refs_json,
           reviewer_refs_json, note, created_at, business_category_id, work_type
         ) SELECT ?, id, tenant_id, 'confirm',
           json_object('id',id,'tenantId',tenant_id,'projectId',project_id,'title',title,
             'decision',decision,'rationale',rationale,'confirmationState','reviewed',
             'confirmationNote',?,'confirmedAt',?,'updatedAt',?),
           '[]', json_array(json_object('id',?)), ?, ?, business_category_id, work_type
         FROM decision_memories WHERE tenant_id=? AND id=?
           AND EXISTS(SELECT 1 FROM retrospective_sessions WHERE tenant_id=? AND id=? AND status='closed'
             AND close_operation_id=? AND close_request_digest=?)`
      ).bind(ulid(now + 100 + results.length), note, now, now, principal, note, now,
        tenantId, item.source_id, tenantId, id, closeOperationId, requestDigest));
    }
    results.push(result);
  }
  statements.unshift(env.OPEN_BRAIN_DB.prepare(
    `UPDATE retrospective_sessions SET status='closed', closed_at=?, close_idempotency_key=?, close_request_digest=?, close_operation_id=?,
       participant_count_at_close=(
         SELECT COUNT(*) FROM retrospective_participants participant
         WHERE participant.tenant_id=retrospective_sessions.tenant_id AND participant.session_id=retrospective_sessions.id
       ),
       unanswered_response_count_at_close=(
         SELECT COUNT(*) FROM retrospective_item_eligible_participants eligible
         WHERE eligible.tenant_id=retrospective_sessions.tenant_id AND eligible.session_id=retrospective_sessions.id
           AND NOT EXISTS(
             SELECT 1 FROM retrospective_responses response
             WHERE response.tenant_id=eligible.tenant_id AND response.session_id=eligible.session_id
               AND response.item_id=eligible.item_id AND response.principal=eligible.principal
           )
       ), updated_at=?
     WHERE tenant_id=? AND id=? AND status='open'
       AND NOT EXISTS(
         SELECT 1
         FROM retrospective_items item
         JOIN retrospective_item_eligible_participants eligible
           ON eligible.tenant_id=item.tenant_id AND eligible.session_id=item.session_id AND eligible.item_id=item.id
         LEFT JOIN decision_rationales rationale
           ON item.source_type='decision_rationale' AND rationale.tenant_id=item.tenant_id AND rationale.id=item.source_id
         LEFT JOIN decision_memories decision
           ON decision.tenant_id=item.tenant_id AND decision.id=COALESCE(item.parent_decision_id, rationale.memory_id)
         LEFT JOIN resource_access_policies policy
           ON policy.tenant_id=item.tenant_id AND policy.resource_type='decision_memory'
          AND policy.resource_id=COALESCE(item.parent_decision_id, rationale.memory_id)
         WHERE item.tenant_id=? AND item.session_id=? AND (
           (item.source_type IN ('decision_memory','projected_rule') AND (
             decision.id IS NULL OR decision.status IN ('retired','superseded') OR CAST(decision.updated_at AS TEXT)<>item.source_version
           ))
           OR (item.source_type='decision_rationale' AND (
             rationale.id IS NULL OR rationale.status IN ('retired','superseded') OR CAST(rationale.created_at AS TEXT)<>item.source_version
           ))
           OR COALESCE(policy.policy_version, -1)<>COALESCE(item.source_policy_version, -1)
           OR (eligible.principal<>retrospective_sessions.created_by AND decision.project_id IS NOT NULL AND NOT EXISTS(
             SELECT 1 FROM principal_role_assignments assignment
             WHERE assignment.tenant_id=item.tenant_id AND assignment.principal=eligible.principal
               AND (assignment.project_id IS NULL OR assignment.project_id=decision.project_id)
           ))
           OR (policy.id IS NOT NULL AND NOT (
             policy.owner_principal=eligible.principal OR policy.scope='tenant'
             OR (policy.scope='project' AND policy.project_id IS retrospective_sessions.project_id)
             OR (policy.scope IN ('group','restricted') AND EXISTS(
               SELECT 1 FROM group_members membership
               WHERE membership.tenant_id=item.tenant_id AND membership.principal=eligible.principal
                 AND (
                   membership.group_id IN (SELECT value FROM json_each(policy.group_ids_json))
                   OR membership.group_id IN (
                     SELECT json_extract(value, '$.subject_id') FROM json_each(policy.restricted_subjects_json)
                     WHERE json_extract(value, '$.subject_type')='group'
                   )
                 )
             ))
             OR (policy.scope='restricted' AND eligible.principal IN (
               SELECT json_extract(value, '$.subject_id') FROM json_each(policy.restricted_subjects_json)
               WHERE json_extract(value, '$.subject_type')='principal'
             ))
           ))
           OR (policy.id IS NULL AND decision.visibility='restricted' AND NOT (
             eligible.principal IN (SELECT value FROM json_each(decision.allowed_principals_json))
             OR eligible.principal IN (
               SELECT CASE WHEN type='text' THEN value ELSE json_extract(value, '$.id') END
               FROM json_each(decision.owner_refs_json)
             )
             OR EXISTS(
               SELECT 1 FROM group_members membership
               WHERE membership.tenant_id=item.tenant_id AND membership.principal=eligible.principal
                 AND membership.group_id IN (SELECT value FROM json_each(decision.allowed_principals_json))
             )
           ))
         )
       )`
  ).bind(now, idempotencyKey, requestDigest, closeOperationId, now, tenantId, id, tenantId, id));
  const persisted = await env.OPEN_BRAIN_DB.batch(statements);
  if (!persisted[0]?.meta.changes) {
    const raced = await env.OPEN_BRAIN_DB.prepare(
      "SELECT status, close_idempotency_key, close_request_digest FROM retrospective_sessions WHERE tenant_id=? AND id=?"
    ).bind(tenantId, id).first<{ status: string; close_idempotency_key: string | null; close_request_digest: string | null }>();
    if (raced?.status === "closed" && raced.close_idempotency_key === idempotencyKey && raced.close_request_digest === requestDigest) {
      const existing = await env.OPEN_BRAIN_DB.prepare(
        "SELECT id, session_id, item_id, decision, source_digest, finalized_by, finalized_at FROM retrospective_results WHERE tenant_id=? AND session_id=? ORDER BY item_id"
      ).bind(tenantId, id).all<Record<string, unknown>>();
      return { session_id: id, status: "closed", results: existing.results.map((row) => retrospectiveResultSchema.parse(row)) };
    }
    throw new HttpError(409, "retrospective_close_conflict", "The retrospective changed while it was being closed");
  }
  return { session_id: id, status: "closed", results };
}

export async function cancelRetrospective(env: Env, tenantId: string, id: string) {
  assertKnowledgeLoopWritable(env, "RETROSPECTIVE_MODE", tenantId);
  const now = Date.now();
  const result = await env.OPEN_BRAIN_DB.prepare(
    "UPDATE retrospective_sessions SET status='cancelled', cancelled_at=?, updated_at=? WHERE tenant_id=? AND id=? AND status='open'"
  ).bind(now, now, tenantId, id).run();
  if (!result.meta.changes) throw new HttpError(409, "retrospective_not_open", "Only open retrospectives can be cancelled");
  return { id, status: "cancelled", cancelled_at: now };
}

export async function getRetrospectiveResults(env: Env, tenantId: string, id: string, principal: string, includeAll = false) {
  assertReadable(env, "RETROSPECTIVE_MODE");
  await assertParticipant(env, tenantId, id, principal, includeAll);
  const rows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT result.id, result.session_id, result.item_id, result.decision, result.source_digest,
            result.finalized_by, result.finalized_at, item.source_type, item.source_id
     FROM retrospective_results result
     JOIN retrospective_items item ON item.tenant_id=result.tenant_id AND item.session_id=result.session_id AND item.id=result.item_id
     JOIN retrospective_item_eligible_participants eligible
       ON eligible.tenant_id=result.tenant_id AND eligible.session_id=result.session_id
      AND eligible.item_id=result.item_id AND eligible.principal=?
     WHERE result.tenant_id=? AND result.session_id=? ORDER BY result.finalized_at, result.item_id`
  ).bind(principal, tenantId, id).all<Record<string, unknown>>();
  const readable = [];
  for (const row of rows.results) {
    if (await retrospectiveSourceReadable(env, tenantId, row.source_type, row.source_id, principal)) readable.push(row);
  }
  return readable.map((row) => retrospectiveResultSchema.parse({
    id: row.id, session_id: row.session_id, item_id: row.item_id, decision: row.decision,
    source_digest: row.source_digest, finalized_by: row.finalized_by, finalized_at: row.finalized_at
  }));
}

const actionCreateSchema = z.object({
  project_id: z.string().trim().min(1).max(128).nullable().default(null),
  retrospective_session_id: z.string().trim().min(1).max(128).nullable().default(null),
  retrospective_item_id: z.string().trim().min(1).max(128).nullable().default(null),
  goal_link_id: z.string().trim().min(1).max(128).nullable().default(null),
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(4_000).default(""),
  owner_principal: z.string().trim().min(1).max(128).nullable().default(null),
  due_at: z.number().int().nonnegative().nullable().default(null),
  external_issue_url: z.string().url().max(2_048).refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "must use http or https").nullable().default(null)
}).strict();
const actionPatchSchema = z.object({
  title: z.string().trim().min(1).max(240).optional(),
  description: z.string().trim().max(4_000).optional(),
  owner_principal: z.string().trim().min(1).max(128).nullable().optional(),
  due_at: z.number().int().nonnegative().nullable().optional(),
  external_issue_url: z.string().url().max(2_048).refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "must use http or https").nullable().optional(),
  status: z.enum(["open", "in_progress", "awaiting_verification", "completed", "cancelled"]).optional()
}).strict().refine((value) => Object.keys(value).length > 0, "at least one field is required");

function actionFromRow(row: Record<string, unknown>): ImprovementActionV1 {
  const { target_snapshot_json: _targetSnapshot, ...publicRow } = row;
  return improvementActionSchema.parse({ ...publicRow, contract_version: KNOWLEDGE_MEASUREMENT_LOOP_CONTRACT_VERSION });
}

async function actionViewFromRow(env: Env, row: Record<string, unknown>, principal: string, includeAll = false) {
  const action = actionFromRow(row);
  if (!action.goal_link_id || !action.baseline_snapshot_id) {
    return improvementActionViewSchema.parse({ ...action, measurement: null });
  }
  const scope = await env.OPEN_BRAIN_DB.prepare(
    "SELECT scope_type, scope_id FROM knowledge_pack_goal_links WHERE tenant_id=? AND id=?"
  ).bind(action.tenant_id, action.goal_link_id).first<{ scope_type: string; scope_id: string | null }>();
  if (!scope || (!includeAll && scope.scope_type === "project"
    && !await principalCanReadProject(env, action.tenant_id, principal, scope.scope_id))) {
    return improvementActionViewSchema.parse({ ...action, measurement: null });
  }
  const measurement = await env.OPEN_BRAIN_DB.prepare(
    `SELECT release.manifest_json, version.definition_json,
            target.direction, target.target_value, target.target_min, target.target_max,
            baseline.id AS baseline_id, baseline.value AS baseline_value, baseline.observed_at AS baseline_observed_at,
            current.id AS current_id, current.value AS current_value, current.state AS current_state,
            current.observed_at AS current_observed_at, current.expires_at AS current_expires_at
     FROM knowledge_pack_goal_links link
     JOIN domain_pack_installations installation
       ON installation.tenant_id=link.tenant_id AND installation.id=link.knowledge_pack_installation_id
     JOIN domain_pack_releases release ON release.id=installation.release_id
     JOIN metric_definitions definition ON definition.tenant_id=link.tenant_id AND definition.id=link.metric_definition_id
     JOIN metric_definition_versions version ON version.metric_definition_id=definition.id AND version.version=definition.current_version
     JOIN metric_targets target ON target.tenant_id=link.tenant_id AND target.id=link.metric_target_id
     JOIN metric_snapshots baseline ON baseline.tenant_id=link.tenant_id AND baseline.id=?
     LEFT JOIN metric_bindings binding ON binding.tenant_id=link.tenant_id AND binding.id=link.metric_binding_id
     LEFT JOIN metric_snapshots current ON current.id=(
       SELECT snapshot.id FROM metric_snapshots snapshot
       WHERE snapshot.tenant_id=link.tenant_id AND snapshot.metric_definition_id=link.metric_definition_id
         AND snapshot.binding_id IS link.metric_binding_id
         AND snapshot.dimensions_json=COALESCE(binding.dimensions_json, '{}')
       ORDER BY snapshot.observed_at DESC, snapshot.created_at DESC, snapshot.id DESC LIMIT 1
     )
     WHERE link.tenant_id=? AND link.id=?`
  ).bind(action.baseline_snapshot_id, action.tenant_id, action.goal_link_id).first<Record<string, unknown>>();
  if (!measurement || typeof measurement.baseline_value !== "number") {
    return improvementActionViewSchema.parse({ ...action, measurement: null });
  }
  const now = Date.now();
  const currentState = measurement.current_state === "measured" && Number(measurement.current_expires_at) < now
    ? "stale"
    : measurement.current_state === "measured" || measurement.current_state === "unknown" || measurement.current_state === "stale"
      ? measurement.current_state
      : "unknown";
  const definition = json(String(measurement.definition_json ?? "{}"), {}) as { label?: string; unit?: string };
  const manifest = json(String(measurement.manifest_json ?? "{}"), {}) as { title?: string };
  const verificationThreshold = Math.max(
    Number(action.implementation_completed_at ?? 0),
    Number(measurement.baseline_observed_at ?? 0)
  );
  const ready = action.status === "awaiting_verification" && currentState === "measured"
    && typeof measurement.current_observed_at === "number" && measurement.current_observed_at > verificationThreshold;
  return improvementActionViewSchema.parse({
    ...action,
    measurement: {
      pack_title: manifest.title ?? "Knowledge Pack",
      metric_label: definition.label ?? "Metric",
      unit: definition.unit ?? "count",
      target: { direction: measurement.direction, value: measurement.target_value, min: measurement.target_min, max: measurement.target_max },
      baseline: { snapshot_id: measurement.baseline_id, value: measurement.baseline_value, observed_at: measurement.baseline_observed_at },
      current: {
        snapshot_id: typeof measurement.current_id === "string" ? measurement.current_id : null,
        value: currentState === "measured" && typeof measurement.current_value === "number" ? measurement.current_value : null,
        state: currentState,
        observed_at: typeof measurement.current_observed_at === "number" ? measurement.current_observed_at : null,
        expires_at: typeof measurement.current_expires_at === "number" ? measurement.current_expires_at : null
      },
      verification_state: action.verification_snapshot_id ? "verified" : ready ? "ready" : "waiting_for_measurement"
    }
  });
}

async function baselineForGoal(env: Env, tenantId: string, goalLinkId: string | null) {
  if (!goalLinkId) return { snapshot_id: null, target_json: null };
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT s.id AS snapshot_id, t.direction, t.target_value, t.target_min, t.target_max
     FROM knowledge_pack_goal_links l
     JOIN metric_targets t ON t.id=l.metric_target_id
     LEFT JOIN metric_bindings b ON b.tenant_id=l.tenant_id AND b.id=l.metric_binding_id
     LEFT JOIN metric_snapshots s ON s.id=(
       SELECT s2.id FROM metric_snapshots s2 WHERE s2.tenant_id=l.tenant_id
       AND s2.metric_definition_id=l.metric_definition_id AND s2.binding_id IS l.metric_binding_id
       AND s2.dimensions_json=COALESCE(b.dimensions_json, '{}') AND s2.state='measured' AND s2.expires_at >= ?
       ORDER BY s2.observed_at DESC, s2.created_at DESC, s2.id DESC LIMIT 1
     ) WHERE l.tenant_id=? AND l.id=?`
  ).bind(Date.now(), tenantId, goalLinkId).first<Record<string, unknown>>();
  if (!row) throw new HttpError(404, "knowledge_pack_goal_not_found", "Knowledge Pack goal not found");
  if (typeof row.snapshot_id !== "string") {
    throw new HttpError(409, "fresh_baseline_required", "Record a fresh measured baseline before linking an improvement action");
  }
  return {
    snapshot_id: typeof row.snapshot_id === "string" ? row.snapshot_id : null,
    target_json: canonicalJson({ direction: row.direction, value: row.target_value, min: row.target_min, max: row.target_max })
  };
}

export async function createImprovementAction(env: Env, tenantId: string, principal: string, raw: unknown) {
  assertKnowledgeLoopWritable(env, "IMPROVEMENT_ACTIONS_MODE", tenantId);
  const body = parse(actionCreateSchema, transportBody(raw));
  if (body.retrospective_session_id || body.retrospective_item_id) {
    if (!body.retrospective_session_id || !body.retrospective_item_id) {
      throw new HttpError(400, "retrospective_reference_incomplete", "Both retrospective session and item are required");
    }
    const retrospectiveItem = await env.OPEN_BRAIN_DB.prepare(
      `SELECT 1 AS found FROM retrospective_items
       WHERE tenant_id=? AND session_id=? AND id=?`
    ).bind(tenantId, body.retrospective_session_id, body.retrospective_item_id).first();
    if (!retrospectiveItem) throw new HttpError(400, "retrospective_reference_invalid", "The retrospective item must belong to this tenant and session");
  }
  const baseline = await baselineForGoal(env, tenantId, body.goal_link_id);
  const now = Date.now();
  const result = improvementActionSchema.parse({
    contract_version: KNOWLEDGE_MEASUREMENT_LOOP_CONTRACT_VERSION,
    id: ulid(now), tenant_id: tenantId, ...body, status: "open",
    implementation_completed_at: null, baseline_snapshot_id: baseline.snapshot_id,
    verification_snapshot_id: null, comparator_version: null, verification_outcome: null,
    created_by: principal, created_at: now, updated_at: now
  });
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO improvement_actions(
       id, tenant_id, project_id, retrospective_session_id, retrospective_item_id, goal_link_id,
       title, description, owner_principal, due_at, status, external_issue_url,
       baseline_snapshot_id, target_snapshot_json, created_by, created_at, updated_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(result.id, tenantId, result.project_id, result.retrospective_session_id, result.retrospective_item_id,
    result.goal_link_id, result.title, result.description, result.owner_principal, result.due_at, result.status,
    result.external_issue_url, result.baseline_snapshot_id, baseline.target_json, principal, now, now).run();
  return result;
}

export async function listImprovementActions(env: Env, tenantId: string, query: {
  status?: string;
  owner?: string;
  principal: string;
  includeAll?: boolean;
}) {
  assertReadable(env, "IMPROVEMENT_ACTIONS_MODE");
  const where = ["tenant_id=?"];
  const bindings: unknown[] = [tenantId];
  if (!query.includeAll) { where.push("owner_principal=?"); bindings.push(query.principal); }
  if (query.status) { where.push("status=?"); bindings.push(query.status); }
  if (query.owner) {
    if (!query.includeAll && query.owner !== query.principal) throw new HttpError(403, "improvement_action_owner_required", "Only your own actions can be listed");
    where.push("owner_principal=?"); bindings.push(query.owner);
  }
  const rows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT * FROM improvement_actions WHERE ${where.join(" AND ")} ORDER BY due_at IS NULL, due_at, created_at DESC LIMIT 200`
  ).bind(...bindings).all<Record<string, unknown>>();
  return Promise.all(rows.results.map((row) => actionViewFromRow(env, row, query.principal, query.includeAll)));
}

export async function updateImprovementAction(env: Env, tenantId: string, id: string, principal: string, adminAllowed: boolean, raw: unknown) {
  assertKnowledgeLoopWritable(env, "IMPROVEMENT_ACTIONS_MODE", tenantId);
  const body = parse(actionPatchSchema, transportBody(raw));
  const current = await env.OPEN_BRAIN_DB.prepare("SELECT * FROM improvement_actions WHERE tenant_id=? AND id=?")
    .bind(tenantId, id).first<Record<string, unknown>>();
  if (!current) throw new HttpError(404, "improvement_action_not_found", "Improvement action not found");
  if (!adminAllowed && current.owner_principal !== principal) throw new HttpError(403, "improvement_action_owner_required", "Only the owner can update this action");
  if (!adminAllowed) {
    const keys = Object.keys(body);
    if (keys.some((key) => key !== "status")) throw new HttpError(403, "improvement_action_admin_required", "Only administrators can change action metadata or assignment");
    if (body.status && !["in_progress", "awaiting_verification"].includes(body.status)) {
      throw new HttpError(403, "improvement_action_admin_required", "Only administrators can cancel or directly complete actions");
    }
  }
  if (["completed", "cancelled"].includes(String(current.status))) throw new HttpError(409, "improvement_action_terminal", "Completed or cancelled actions cannot be changed");
  const currentStatus = String(current.status);
  const requestedStatus = body.status ?? currentStatus;
  const allowed: Record<string, string[]> = {
    open: ["open", "in_progress", "cancelled"],
    in_progress: ["in_progress", "awaiting_verification", "completed", "cancelled"],
    awaiting_verification: ["awaiting_verification", "in_progress", "cancelled"]
  };
  if (!(allowed[currentStatus] ?? []).includes(requestedStatus)) throw new HttpError(409, "invalid_improvement_action_transition", "Invalid improvement action status transition");
  if (current.goal_link_id && requestedStatus === "completed") throw new HttpError(409, "improvement_action_verification_required", "Metric-linked actions require verification before completion");
  const now = Date.now();
  const next = {
    ...current, ...body, status: requestedStatus,
    implementation_completed_at: requestedStatus === "awaiting_verification" && !current.implementation_completed_at ? now : current.implementation_completed_at,
    updated_at: now
  };
  await env.OPEN_BRAIN_DB.prepare(
    `UPDATE improvement_actions SET title=?, description=?, owner_principal=?, due_at=?, status=?, external_issue_url=?,
     implementation_completed_at=?, updated_at=? WHERE tenant_id=? AND id=?`
  ).bind(next.title, next.description, next.owner_principal, next.due_at, next.status, next.external_issue_url,
    next.implementation_completed_at, now, tenantId, id).run();
  return actionFromRow(next);
}

export async function verifyImprovementAction(env: Env, tenantId: string, id: string, principal: string, adminAllowed: boolean) {
  assertKnowledgeLoopWritable(env, "IMPROVEMENT_ACTIONS_MODE", tenantId);
  const action = await env.OPEN_BRAIN_DB.prepare("SELECT * FROM improvement_actions WHERE tenant_id=? AND id=?")
    .bind(tenantId, id).first<Record<string, unknown>>();
  if (!action) throw new HttpError(404, "improvement_action_not_found", "Improvement action not found");
  if (!adminAllowed && action.owner_principal !== principal) throw new HttpError(403, "improvement_action_owner_required", "Only the owner can verify this action");
  if (action.status !== "awaiting_verification" || !action.goal_link_id || !action.baseline_snapshot_id || !action.implementation_completed_at) {
    throw new HttpError(409, "improvement_action_not_verifiable", "The action is not ready for metric verification");
  }
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT baseline.value AS baseline_value, baseline.observed_at AS baseline_observed_at,
            current.id AS verification_snapshot_id, current.value AS verification_value,
            current.observed_at AS verification_observed_at, current.expires_at AS verification_expires_at,
            l.metric_definition_id, l.metric_binding_id
     FROM knowledge_pack_goal_links l
     JOIN metric_snapshots baseline ON baseline.id=? AND baseline.tenant_id=l.tenant_id
       AND baseline.metric_definition_id=l.metric_definition_id AND baseline.binding_id IS l.metric_binding_id
     LEFT JOIN metric_snapshots current ON current.id=(
       SELECT s.id FROM metric_snapshots s WHERE s.tenant_id=l.tenant_id
       AND s.metric_definition_id=l.metric_definition_id AND s.binding_id IS l.metric_binding_id
       AND s.dimensions_json=baseline.dimensions_json
       AND s.state='measured' AND s.observed_at > MAX(?, baseline.observed_at) ORDER BY s.observed_at DESC LIMIT 1
     ) WHERE l.tenant_id=? AND l.id=?`
  ).bind(action.baseline_snapshot_id, action.implementation_completed_at, tenantId, action.goal_link_id).first<Record<string, unknown>>();
  if (!row || typeof row.baseline_value !== "number" || typeof row.verification_value !== "number" || typeof row.verification_snapshot_id !== "string") {
    throw new HttpError(409, "fresh_verification_snapshot_required", "Record a fresh measured value after implementation before verifying");
  }
  if (Number(row.verification_expires_at) < Date.now()) throw new HttpError(409, "fresh_verification_snapshot_required", "The verification value is stale");
  const target = json(String(action.target_snapshot_json ?? "{}"), {}) as MetricTarget;
  const baseline = row.baseline_value;
  const verification = row.verification_value;
  const trend = compareMetric(verification, baseline, target).trend;
  const outcome = trend === "improving" ? "improved" : trend === "regressing" ? "regressed" : "unchanged";
  const now = Date.now();
  await env.OPEN_BRAIN_DB.prepare(
    `UPDATE improvement_actions SET status='completed', verification_snapshot_id=?, comparator_version='metric-improvement/v1',
     verification_outcome=?, updated_at=? WHERE tenant_id=? AND id=? AND status='awaiting_verification'`
  ).bind(row.verification_snapshot_id, outcome, now, tenantId, id).run();
  return actionFromRow({
    ...action,
    status: "completed",
    verification_snapshot_id: row.verification_snapshot_id,
    comparator_version: "metric-improvement/v1",
    verification_outcome: outcome,
    updated_at: now
  });
}
