import {
  KNOWLEDGE_PACK_ONBOARDING_CONTRACT_VERSION,
  KNOWLEDGE_PACK_ONBOARDING_STEPS,
  knowledgePackDataSourcesSchema,
  knowledgePackGoalsSchema,
  knowledgePackOnboardingAnswersSchema,
  knowledgePackOnboardingCompletionSchema,
  knowledgePackOnboardingPlanSchema,
  knowledgePackOnboardingSchema,
  knowledgePackPurposeSchema,
  knowledgePackScopeSchema,
  knowledgePackTemplateSchema,
  type DomainPackManifestV1,
  type KnowledgePackDataSourceV1,
  type KnowledgePackGoalV1,
  type KnowledgePackOnboardingAnswersV1,
  type KnowledgePackOnboardingPlanV1,
  type KnowledgePackOnboardingV1,
  type KnowledgePackScopeV1,
  type MetricDefinitionV1
} from "@org-brain/contracts";
import { canonicalJson, domainPackManifestDigest } from "@org-brain/core";
import { HttpError, sha256, ulid } from "@org-brain/shared";
import { z } from "zod";
import { createMetricSnapshot } from "./domain-metric-service";
import {
  installDomainPacks,
  listDomainPacks,
  planDomainPackInstallation,
  publishTenantOrganizationOverlay
} from "./domain-pack-service";
import type { Env } from "./types";

type OnboardingRow = {
  id: string;
  tenant_id: string;
  project_id: string | null;
  state: "in_progress" | "planned" | "completed";
  current_step: (typeof KNOWLEDGE_PACK_ONBOARDING_STEPS)[number];
  revision: number;
  answers_json: string;
  plan_digest: string | null;
  plan_json: string | null;
  completion_json: string | null;
  created_by_principal: string;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
};

type CatalogEntry = Awaited<ReturnType<typeof listDomainPacks>>[number];

const editableSteps = ["purpose", "template", "scope", "goals", "data_sources"] as const;
type EditableStep = (typeof editableSteps)[number];
const projectIdentifier = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

// Contracts and the gateway resolve separate Zod type identities, so bridge only
// the shared safeParse surface while preserving each schema's inferred output.
function parseSchema<S extends { parse(raw: unknown): unknown }>(schema: S, raw: unknown): ReturnType<S["parse"]> {
  const parsed = (schema as unknown as {
    safeParse(value: unknown):
      | { success: true; data: ReturnType<S["parse"]> }
      | { success: false; error: { issues: Array<{ path: Array<string | number>; message: string }> } };
  }).safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(
      400,
      "invalid_payload",
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
    );
  }
  return parsed.data;
}

function assertOnboardingEnabled(env: Env) {
  if (!env.KNOWLEDGE_PACK_ONBOARDING_MODE || env.KNOWLEDGE_PACK_ONBOARDING_MODE === "off") {
    throw new HttpError(404, "knowledge_pack_onboarding_disabled", "Knowledge Pack onboarding is disabled");
  }
}

function assertOnboardingCompletionEnabled(env: Env) {
  assertOnboardingEnabled(env);
  if (env.KNOWLEDGE_PACK_ONBOARDING_MODE !== "on") {
    throw new HttpError(409, "knowledge_pack_onboarding_preview", "Knowledge Pack onboarding is in preview-only mode");
  }
}

function rowToOnboarding(row: OnboardingRow): KnowledgePackOnboardingV1 {
  return knowledgePackOnboardingSchema.parse({
    contract_version: KNOWLEDGE_PACK_ONBOARDING_CONTRACT_VERSION,
    id: row.id,
    tenant_id: row.tenant_id,
    project_id: row.project_id,
    state: row.state,
    current_step: row.current_step,
    revision: Number(row.revision),
    answers: knowledgePackOnboardingAnswersSchema.parse(JSON.parse(row.answers_json)),
    plan_digest: row.plan_digest,
    plan: row.plan_json ? JSON.parse(row.plan_json) : null,
    completion: row.completion_json ? JSON.parse(row.completion_json) : null,
    created_by_principal: row.created_by_principal,
    completed_at: row.completed_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  });
}

async function sessionRow(env: Env, tenantId: string, id: string): Promise<OnboardingRow> {
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, project_id, state, current_step, revision, answers_json,
            plan_digest, plan_json, completion_json, created_by_principal,
            completed_at, created_at, updated_at
     FROM knowledge_pack_onboarding_sessions
     WHERE tenant_id = ? AND id = ?`
  ).bind(tenantId, id).first<OnboardingRow>();
  if (!row) throw new HttpError(404, "knowledge_pack_onboarding_not_found", "Knowledge Pack onboarding session not found");
  return row;
}

async function onboardingSession(env: Env, tenantId: string, id: string): Promise<KnowledgePackOnboardingV1> {
  return rowToOnboarding(await sessionRow(env, tenantId, id));
}

const createSessionSchema = z.object({
  tenant_id: z.string().optional(),
  project_id: projectIdentifier.nullable().default(null)
}).strict();

export async function createKnowledgePackOnboarding(
  env: Env,
  tenantId: string,
  principal: string,
  idempotencyKey: string,
  raw: unknown
) {
  assertOnboardingEnabled(env);
  const body = parseSchema(createSessionSchema, raw);
  const existingByKey = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, project_id, state, current_step, revision, answers_json,
            plan_digest, plan_json, completion_json, created_by_principal,
            completed_at, created_at, updated_at
     FROM knowledge_pack_onboarding_sessions
     WHERE tenant_id = ? AND create_idempotency_key = ?`
  ).bind(tenantId, idempotencyKey).first<OnboardingRow>();
  if (existingByKey) return rowToOnboarding(existingByKey);

  const resumable = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, project_id, state, current_step, revision, answers_json,
            plan_digest, plan_json, completion_json, created_by_principal,
            completed_at, created_at, updated_at
     FROM knowledge_pack_onboarding_sessions
     WHERE tenant_id = ? AND created_by_principal = ? AND project_id IS ?
       AND state IN ('in_progress', 'planned')
     ORDER BY updated_at DESC LIMIT 1`
  ).bind(tenantId, principal, body.project_id).first<OnboardingRow>();
  if (resumable) return rowToOnboarding(resumable);

  const now = Date.now();
  const id = ulid(now);
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO knowledge_pack_onboarding_sessions(
       id, tenant_id, project_id, state, current_step, revision, answers_json,
       plan_digest, plan_json, completion_json, create_idempotency_key,
       completion_idempotency_key, created_by_principal, completed_at,
       created_at, updated_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id,
    tenantId,
    body.project_id,
    "in_progress",
    "purpose",
    0,
    "{}",
    null,
    null,
    null,
    idempotencyKey,
    null,
    principal,
    null,
    now,
    now
  ).run();
  return onboardingSession(env, tenantId, id);
}

export async function getKnowledgePackOnboarding(
  env: Env,
  tenantId: string,
  id: string,
  projectId?: string | null
) {
  assertOnboardingEnabled(env);
  const session = await onboardingSession(env, tenantId, id);
  if (projectId && session.project_id !== projectId) {
    throw new HttpError(404, "knowledge_pack_onboarding_not_found", "Knowledge Pack onboarding session not found");
  }
  return session;
}

function editableStep(value: string): EditableStep {
  if (!editableSteps.includes(value as EditableStep)) {
    throw new HttpError(400, "knowledge_pack_onboarding_step_invalid", `Unsupported onboarding step: ${value}`);
  }
  return value as EditableStep;
}

function parseStepAnswer(step: EditableStep, raw: unknown): unknown {
  if (step === "purpose") return parseSchema(knowledgePackPurposeSchema, raw);
  if (step === "template") return parseSchema(knowledgePackTemplateSchema, raw);
  if (step === "scope") return parseSchema(knowledgePackScopeSchema, raw);
  if (step === "goals") return parseSchema(knowledgePackGoalsSchema, raw);
  return parseSchema(knowledgePackDataSourcesSchema, raw);
}

async function selectedCatalogEntries(
  env: Env,
  tenantId: string,
  answers: KnowledgePackOnboardingAnswersV1
): Promise<CatalogEntry[]> {
  const packIds = answers.template?.pack_ids;
  if (!packIds?.length) throw new HttpError(409, "knowledge_pack_template_required", "Select a Pack template first");
  const catalog = await listDomainPacks(env, tenantId);
  const byId = new Map(catalog.map((entry) => [entry.manifest.pack_id, entry]));
  const selected = packIds.map((packId) => byId.get(packId));
  const missingIndex = selected.findIndex((entry) => !entry);
  if (missingIndex >= 0) {
    throw new HttpError(404, "domain_pack_not_found", `Domain Pack not found: ${packIds[missingIndex]}`);
  }
  return selected as CatalogEntry[];
}

function metricDefinitions(entries: CatalogEntry[]): Map<string, MetricDefinitionV1> {
  const definitions = new Map<string, MetricDefinitionV1>();
  for (const entry of entries) {
    for (const metric of entry.manifest.metrics) definitions.set(metric.key, metric);
  }
  return definitions;
}

async function validateStepAnswer(
  env: Env,
  tenantId: string,
  step: EditableStep,
  answer: unknown,
  answers: KnowledgePackOnboardingAnswersV1
) {
  const candidate = { ...answers, [step]: answer } as KnowledgePackOnboardingAnswersV1;
  if (step === "template") await selectedCatalogEntries(env, tenantId, candidate);
  if (step === "goals") {
    const entries = await selectedCatalogEntries(env, tenantId, candidate);
    const definitions = metricDefinitions(entries);
    for (const goal of (answer as { goals: KnowledgePackGoalV1[] }).goals) {
      if (!definitions.has(goal.metric_key)) {
        throw new HttpError(400, "knowledge_pack_metric_not_in_template", `Metric is not provided by the selected Pack: ${goal.metric_key}`);
      }
      if (goal.due_at !== null && goal.due_at <= Date.now()) {
        throw new HttpError(400, "knowledge_pack_goal_due_at_past", `Goal deadline must be in the future: ${goal.metric_key}`);
      }
    }
  }
  if (step === "data_sources") {
    const entries = await selectedCatalogEntries(env, tenantId, candidate);
    const definitions = metricDefinitions(entries);
    const goalKeys = new Set(candidate.goals?.goals.map((goal) => goal.metric_key) ?? []);
    const sources = (answer as { sources: KnowledgePackDataSourceV1[] }).sources;
    const sourceKeys = new Set(sources.map((source) => source.metric_key));
    if (goalKeys.size !== sourceKeys.size || [...goalKeys].some((key) => !sourceKeys.has(key))) {
      throw new HttpError(400, "knowledge_pack_source_goal_mismatch", "Choose one data-source state for every goal metric");
    }
    for (const source of sources) {
      const definition = definitions.get(source.metric_key);
      if (!definition) {
        throw new HttpError(400, "knowledge_pack_metric_not_in_template", `Metric is not provided by the selected Pack: ${source.metric_key}`);
      }
      if (source.mode === "connector" && (definition.source_type !== "connector" || !definition.connector)) {
        throw new HttpError(400, "knowledge_pack_connector_unavailable", `Metric has no registered Connector template: ${source.metric_key}`);
      }
    }
  }
}

const patchStepSchema = z.object({
  tenant_id: z.string().optional(),
  project_id: projectIdentifier.nullable().optional(),
  revision: z.number().int().nonnegative(),
  answer: z.unknown()
}).strict();

export async function updateKnowledgePackOnboardingStep(
  env: Env,
  tenantId: string,
  id: string,
  stepValue: string,
  raw: unknown
) {
  assertOnboardingEnabled(env);
  const step = editableStep(stepValue);
  const body = parseSchema(patchStepSchema, raw);
  const current = await onboardingSession(env, tenantId, id);
  if (body.project_id !== undefined && body.project_id !== current.project_id) {
    throw new HttpError(404, "knowledge_pack_onboarding_not_found", "Knowledge Pack onboarding session not found");
  }
  if (current.state === "completed") {
    throw new HttpError(409, "knowledge_pack_onboarding_completed", "Completed onboarding sessions cannot be edited");
  }
  const currentStepIndex = KNOWLEDGE_PACK_ONBOARDING_STEPS.indexOf(current.current_step);
  const stepIndex = KNOWLEDGE_PACK_ONBOARDING_STEPS.indexOf(step);
  if (stepIndex > currentStepIndex) {
    throw new HttpError(409, "knowledge_pack_step_out_of_order", "Complete the current onboarding step first");
  }
  const answer = parseStepAnswer(step, body.answer);
  await validateStepAnswer(env, tenantId, step, answer, current.answers);
  const currentAnswer = current.answers[step];
  if (currentAnswer && canonicalJson(currentAnswer) === canonicalJson(answer)) return current;
  if (current.revision !== body.revision) {
    throw new HttpError(409, "knowledge_pack_onboarding_revision_conflict", "The onboarding session changed; reload it before saving");
  }

  const nextAnswers: Record<string, unknown> = {};
  for (let index = 0; index <= stepIndex; index += 1) {
    const answerStep = editableSteps[index];
    if (!answerStep) continue;
    if (answerStep === step) nextAnswers[answerStep] = answer;
    else if (current.answers[answerStep]) nextAnswers[answerStep] = current.answers[answerStep];
  }
  const parsedAnswers = knowledgePackOnboardingAnswersSchema.parse(nextAnswers);
  const nextStep = KNOWLEDGE_PACK_ONBOARDING_STEPS[stepIndex + 1] ?? "review";
  const projectId = step === "scope"
    ? ((answer as KnowledgePackScopeV1).scope_type === "project"
      ? (answer as KnowledgePackScopeV1).project_id
      : null)
    : current.project_id;
  const now = Date.now();
  const result = await env.OPEN_BRAIN_DB.prepare(
    `UPDATE knowledge_pack_onboarding_sessions
     SET project_id = ?, state = 'in_progress', current_step = ?, revision = revision + 1,
         answers_json = ?, plan_digest = NULL, plan_json = NULL, updated_at = ?
     WHERE tenant_id = ? AND id = ? AND revision = ? AND state != 'completed'`
  ).bind(projectId, nextStep, canonicalJson(parsedAnswers), now, tenantId, id, body.revision).run();
  if (!result.meta.changes) {
    throw new HttpError(409, "knowledge_pack_onboarding_revision_conflict", "The onboarding session changed; reload it before saving");
  }
  return onboardingSession(env, tenantId, id);
}

function completeAnswers(session: KnowledgePackOnboardingV1) {
  const { purpose, template, scope, goals, data_sources: dataSources } = session.answers;
  if (!purpose || !template || !scope || !goals || !dataSources) {
    throw new HttpError(409, "knowledge_pack_onboarding_incomplete", "Complete every onboarding step before creating a plan");
  }
  return { purpose, template, scope, goals, dataSources };
}

async function buildKnowledgePackPlan(
  env: Env,
  tenantId: string,
  session: KnowledgePackOnboardingV1
): Promise<KnowledgePackOnboardingPlanV1> {
  const answers = completeAnswers(session);
  if (answers.scope.project_id !== session.project_id) {
    throw new HttpError(409, "knowledge_pack_scope_changed", "The saved goal scope no longer matches this onboarding session");
  }
  for (const goal of answers.goals.goals) {
    if (goal.due_at !== null && goal.due_at <= Date.now()) {
      throw new HttpError(409, "knowledge_pack_goal_due_at_past", `Goal deadline has passed: ${goal.metric_key}`);
    }
  }
  const entries = await selectedCatalogEntries(env, tenantId, session.answers);
  const overlayHash = await sha256(`${tenantId}:${session.id}`);
  const manifest: DomainPackManifestV1 = {
    contract_version: "domain-pack/v1",
    pack_id: `knowledge.${overlayHash.slice(0, 24)}`,
    version: "1.0.0",
    classification: "organization_overlay",
    title: answers.purpose.name,
    description: answers.purpose.objective,
    language: "ja",
    min_orgbrain_version: "0.2.0",
    dependencies: entries.map((entry) => ({
      pack_id: entry.manifest.pack_id,
      version: entry.manifest.version
    })),
    object_types: [],
    metrics: [],
    dashboards: [],
    connectors: [],
    assets: [],
    loadout_templates: [],
    example_refs: []
  };
  const [manifestDigest, installation] = await Promise.all([
    domainPackManifestDigest(manifest),
    planDomainPackInstallation(env, tenantId, { pack_ids: answers.template.pack_ids })
  ]);
  const warnings = [
    ...installation.warnings,
    ...answers.dataSources.sources
      .filter((source) => source.mode === "unknown")
      .map((source) => `metric_unknown:${source.metric_key}`)
  ];
  const planDigest = await sha256(canonicalJson({
    manifest_digest: manifestDigest,
    installation_plan_digest: installation.plan_digest,
    scope: answers.scope,
    goals: answers.goals.goals,
    data_sources: answers.dataSources.sources
  }));
  return knowledgePackOnboardingPlanSchema.parse({
    plan_digest: planDigest,
    knowledge_pack: { manifest, digest: manifestDigest },
    installation,
    goals: answers.goals.goals,
    data_sources: answers.dataSources.sources,
    warnings
  });
}

const planSessionSchema = z.object({
  tenant_id: z.string().optional(),
  project_id: projectIdentifier.nullable().optional(),
  revision: z.number().int().nonnegative()
}).strict();

export async function planKnowledgePackOnboarding(env: Env, tenantId: string, id: string, raw: unknown) {
  assertOnboardingEnabled(env);
  const body = parseSchema(planSessionSchema, raw);
  const current = await onboardingSession(env, tenantId, id);
  if (body.project_id !== undefined && body.project_id !== current.project_id) {
    throw new HttpError(404, "knowledge_pack_onboarding_not_found", "Knowledge Pack onboarding session not found");
  }
  if (current.state === "completed") {
    throw new HttpError(409, "knowledge_pack_onboarding_completed", "The Knowledge Pack has already been created");
  }
  const plan = await buildKnowledgePackPlan(env, tenantId, current);
  if (current.plan_digest === plan.plan_digest && current.plan) return { onboarding: current, plan: current.plan };
  if (current.revision !== body.revision) {
    throw new HttpError(409, "knowledge_pack_onboarding_revision_conflict", "The onboarding session changed; reload it before planning");
  }
  const now = Date.now();
  const result = await env.OPEN_BRAIN_DB.prepare(
    `UPDATE knowledge_pack_onboarding_sessions
     SET state = 'planned', current_step = 'review', revision = revision + 1,
         plan_digest = ?, plan_json = ?, updated_at = ?
     WHERE tenant_id = ? AND id = ? AND revision = ? AND state != 'completed'`
  ).bind(plan.plan_digest, canonicalJson(plan), now, tenantId, id, body.revision).run();
  if (!result.meta.changes) {
    throw new HttpError(409, "knowledge_pack_onboarding_revision_conflict", "The onboarding session changed; reload it before planning");
  }
  return { onboarding: await onboardingSession(env, tenantId, id), plan };
}

async function stableId(prefix: string, ...parts: string[]) {
  return `${prefix}:${(await sha256(parts.join(":"))).slice(0, 26)}`;
}

async function metricBinding(
  env: Env,
  tenantId: string,
  principal: string,
  definitionId: string,
  projectId: string | null
): Promise<string | null> {
  if (!projectId) return null;
  const existing = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id FROM metric_bindings
     WHERE tenant_id = ? AND metric_definition_id = ? AND scope_type = 'project'
       AND scope_id = ? AND dimensions_json = '{}'`
  ).bind(tenantId, definitionId, projectId).first<{ id: string }>();
  if (existing) return existing.id;
  const id = await stableId("kp-binding", tenantId, definitionId, projectId);
  const now = Date.now();
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT OR IGNORE INTO metric_bindings(
       id, tenant_id, metric_definition_id, scope_type, scope_id,
       dimensions_json, created_by, created_at
     ) VALUES(?,?,?,?,?,?,?,?)`
  ).bind(id, tenantId, definitionId, "project", projectId, "{}", principal, now).run();
  return id;
}

async function createTarget(
  env: Env,
  tenantId: string,
  principal: string,
  session: KnowledgePackOnboardingV1,
  definitionId: string,
  bindingId: string | null,
  goal: KnowledgePackGoalV1,
  planDigest: string
) {
  const id = await stableId("kp-target", session.id, goal.metric_key, planDigest);
  const now = Date.now();
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT OR IGNORE INTO metric_targets(
       id, tenant_id, metric_definition_id, binding_id, target_value, target_min,
       target_max, direction, effective_from, effective_to, reason, set_by, created_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id,
    tenantId,
    definitionId,
    bindingId,
    goal.target_value,
    goal.target_min,
    goal.target_max,
    goal.direction,
    now,
    goal.due_at,
    goal.reason,
    principal,
    now
  ).run();
  return id;
}

async function createInitialSnapshot(
  env: Env,
  tenantId: string,
  principal: string,
  session: KnowledgePackOnboardingV1,
  definitionId: string,
  definition: MetricDefinitionV1,
  bindingId: string | null,
  source: KnowledgePackDataSourceV1,
  planDigest: string
) {
  const keyHash = await sha256(`${session.id}:${source.metric_key}:${planDigest}`);
  const idempotencyKey = `kp-snapshot-${keyHash.slice(0, 24)}`;
  const existing = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id FROM metric_snapshots
     WHERE tenant_id = ? AND metric_definition_id = ? AND idempotency_key = ?`
  ).bind(tenantId, definitionId, idempotencyKey).first<{ id: string }>();
  if (existing) return existing.id;
  const observedAt = source.observed_at ?? Date.now();
  try {
    const snapshot = await createMetricSnapshot(env, tenantId, principal, {
      metric_key: source.metric_key,
      binding_id: bindingId,
      scope_type: session.project_id ? "project" : "tenant",
      scope_id: session.project_id,
      value: source.initial_value,
      state: "measured",
      dimensions: {},
      observed_at: observedAt,
      expires_at: observedAt + definition.freshness_seconds * 1_000,
      evidence_ref: source.evidence_ref,
      query_digest: null,
      source_binding_id: null,
      idempotency_key: idempotencyKey
    });
    return snapshot.id as string;
  } catch (error) {
    if (!(error instanceof HttpError) || error.code !== "metric_snapshot_duplicate") throw error;
    const concurrent = await env.OPEN_BRAIN_DB.prepare(
      `SELECT id FROM metric_snapshots
       WHERE tenant_id = ? AND metric_definition_id = ? AND idempotency_key = ?`
    ).bind(tenantId, definitionId, idempotencyKey).first<{ id: string }>();
    if (!concurrent) throw error;
    return concurrent.id;
  }
}

async function configureConnector(
  env: Env,
  tenantId: string,
  session: KnowledgePackOnboardingV1,
  definitionId: string,
  definition: MetricDefinitionV1,
  bindingId: string | null,
  source: KnowledgePackDataSourceV1
) {
  if (!definition.connector || !source.connection_ref) {
    throw new HttpError(409, "knowledge_pack_connector_unavailable", `Metric has no registered Connector template: ${source.metric_key}`);
  }
  const id = await stableId("kp-source", session.id, source.metric_key);
  const now = Date.now();
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO metric_source_bindings(
       id, tenant_id, metric_definition_id, metric_binding_id, binding_key,
       adapter_id, query_template, connection_ref, external_scope_ref, status,
       last_attempt_at, last_success_at, last_error_code, created_at, updated_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(tenant_id, metric_definition_id, binding_key) DO UPDATE SET
       metric_binding_id = excluded.metric_binding_id,
       adapter_id = excluded.adapter_id,
       query_template = excluded.query_template,
       connection_ref = excluded.connection_ref,
       external_scope_ref = excluded.external_scope_ref,
       status = 'configured',
       updated_at = excluded.updated_at`
  ).bind(
    id,
    tenantId,
    definitionId,
    bindingId,
    `knowledge:${session.id}`,
    definition.connector.adapter_id,
    definition.connector.query_template,
    source.connection_ref,
    session.project_id,
    "configured",
    null,
    null,
    null,
    now,
    now
  ).run();
  return id;
}

const completeSessionSchema = z.object({
  tenant_id: z.string().optional(),
  project_id: projectIdentifier.nullable().optional(),
  plan_digest: z.string().regex(/^[0-9a-f]{64}$/u)
}).strict();
const completionClaimLeaseMs = 5 * 60_000;

export async function completeKnowledgePackOnboarding(
  env: Env,
  tenantId: string,
  principal: string,
  id: string,
  idempotencyKey: string,
  raw: unknown
) {
  assertOnboardingCompletionEnabled(env);
  const body = parseSchema(completeSessionSchema, raw);
  const current = await onboardingSession(env, tenantId, id);
  if (body.project_id !== undefined && body.project_id !== current.project_id) {
    throw new HttpError(404, "knowledge_pack_onboarding_not_found", "Knowledge Pack onboarding session not found");
  }
  if (current.state === "completed") {
    if (current.plan_digest !== body.plan_digest) {
      throw new HttpError(409, "knowledge_pack_plan_changed", "The completed Knowledge Pack used a different plan");
    }
    return current;
  }
  if (current.state !== "planned" || !current.plan_digest || !current.plan) {
    throw new HttpError(409, "knowledge_pack_plan_required", "Create and review an installation plan first");
  }
  const plan = await buildKnowledgePackPlan(env, tenantId, current);
  if (body.plan_digest !== current.plan_digest || plan.plan_digest !== current.plan_digest) {
    throw new HttpError(409, "knowledge_pack_plan_changed", "The Knowledge Pack plan changed; preview it again");
  }

  const claimedAt = Date.now();
  try {
    const claimed = await env.OPEN_BRAIN_DB.prepare(
      `UPDATE knowledge_pack_onboarding_sessions
       SET completion_idempotency_key = ?, completion_claimed_at = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ? AND state = 'planned' AND plan_digest = ?
         AND (
           completion_idempotency_key IS NULL
           OR COALESCE(completion_claimed_at, 0) <= ?
         )`
    ).bind(
      idempotencyKey,
      claimedAt,
      claimedAt,
      tenantId,
      id,
      plan.plan_digest,
      claimedAt - completionClaimLeaseMs
    ).run();
    if (!claimed.meta.changes) {
      const latest = await onboardingSession(env, tenantId, id);
      if (latest.state === "completed" && latest.plan_digest === plan.plan_digest) return latest;
      const claim = await env.OPEN_BRAIN_DB.prepare(
        `SELECT completion_idempotency_key FROM knowledge_pack_onboarding_sessions
         WHERE tenant_id = ? AND id = ?`
      ).bind(tenantId, id).first<{ completion_idempotency_key: string | null }>();
      if (claim?.completion_idempotency_key === idempotencyKey) {
        throw new HttpError(409, "knowledge_pack_completion_in_progress", "Knowledge Pack completion is already in progress");
      }
      throw new HttpError(409, "idempotency_key_conflict", "The completion is already claimed by another request");
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (String(error).includes("UNIQUE")) {
      throw new HttpError(409, "idempotency_key_conflict", "The idempotency key was already used for another Knowledge Pack operation");
    }
    throw error;
  }

  try {
  const published = await publishTenantOrganizationOverlay(
    env,
    tenantId,
    principal,
    plan.knowledge_pack.manifest
  );
  const installPlan = await planDomainPackInstallation(env, tenantId, {
    pack_ids: [published.manifest.pack_id]
  });
  const installed = await installDomainPacks(env, tenantId, principal, {
    pack_ids: [published.manifest.pack_id],
    plan_digest: installPlan.plan_digest
  });
  const overlayInstallation = installed.installations.find((item) => item.pack_id === published.manifest.pack_id);
  if (!overlayInstallation) {
    throw new HttpError(500, "knowledge_pack_installation_missing", "The Knowledge Pack installation did not return its overlay");
  }

  const metricKeys = plan.goals.map((goal) => goal.metric_key);
  const placeholders = metricKeys.map(() => "?").join(",");
  const metricRows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT d.id, d.metric_key, v.definition_json
     FROM metric_definitions d
     JOIN metric_definition_versions v
       ON v.metric_definition_id = d.id AND v.version = d.current_version
     WHERE d.tenant_id = ? AND d.metric_key IN (${placeholders})`
  ).bind(tenantId, ...metricKeys).all<{ id: string; metric_key: string; definition_json: string }>();
  const metrics = new Map(metricRows.results.map((row) => [row.metric_key, row]));
  if (metrics.size !== metricKeys.length) {
    throw new HttpError(500, "knowledge_pack_metric_install_incomplete", "One or more goal metrics were not installed");
  }

  const targets: Array<{ metric_key: string; target_id: string }> = [];
  const snapshots: Array<{ metric_key: string; snapshot_id: string }> = [];
  const sources: Array<{
    metric_key: string;
    source_binding_id: string | null;
    state: "unknown" | "measured" | "configured";
  }> = [];
  const sourceByMetric = new Map(plan.data_sources.map((source) => [source.metric_key, source]));
  for (const goal of plan.goals) {
    const row = metrics.get(goal.metric_key)!;
    const definition = JSON.parse(row.definition_json) as MetricDefinitionV1;
    const bindingId = await metricBinding(env, tenantId, principal, row.id, current.project_id);
    targets.push({
      metric_key: goal.metric_key,
      target_id: await createTarget(env, tenantId, principal, current, row.id, bindingId, goal, plan.plan_digest)
    });
    const source = sourceByMetric.get(goal.metric_key)!;
    if (source.mode === "manual") {
      snapshots.push({
        metric_key: goal.metric_key,
        snapshot_id: await createInitialSnapshot(
          env,
          tenantId,
          principal,
          current,
          row.id,
          definition,
          bindingId,
          source,
          plan.plan_digest
        )
      });
      sources.push({ metric_key: goal.metric_key, source_binding_id: null, state: "measured" });
    } else if (source.mode === "connector") {
      sources.push({
        metric_key: goal.metric_key,
        source_binding_id: await configureConnector(env, tenantId, current, row.id, definition, bindingId, source),
        state: "configured"
      });
    } else {
      sources.push({ metric_key: goal.metric_key, source_binding_id: null, state: "unknown" });
    }
  }

  const createdAt = Date.now();
  const goalLinkStatements: ReturnType<Env["OPEN_BRAIN_DB"]["prepare"]>[] = [];
  for (const goal of plan.goals) {
    const metric = metrics.get(goal.metric_key)!;
    const target = targets.find((item) => item.metric_key === goal.metric_key)!;
    const source = sources.find((item) => item.metric_key === goal.metric_key)!;
    const binding = await env.OPEN_BRAIN_DB.prepare(
      `SELECT id FROM metric_bindings
       WHERE tenant_id = ? AND metric_definition_id = ? AND scope_type = ? AND scope_id IS ?
       ORDER BY created_at DESC LIMIT 1`
    ).bind(
      tenantId,
      metric.id,
      current.project_id ? "project" : "tenant",
      current.project_id
    ).first<{ id: string }>();
    if (current.project_id && !binding) throw new HttpError(500, "knowledge_pack_metric_binding_missing", `Metric binding is missing for ${goal.metric_key}`);
    goalLinkStatements.push(env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO knowledge_pack_goal_links(
         id, tenant_id, onboarding_id, knowledge_pack_installation_id, template_pack_id,
         metric_definition_id, metric_binding_id, metric_target_id, metric_source_binding_id,
         metric_key, scope_type, scope_id, created_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      await stableId("kp-goal", overlayInstallation.installation_id, goal.metric_key),
      tenantId,
      current.id,
      overlayInstallation.installation_id,
      current.answers.template!.pack_ids[0]!,
      metric.id,
      binding?.id ?? null,
      target.target_id,
      source.source_binding_id,
      goal.metric_key,
      current.project_id ? "project" : "tenant",
      current.project_id,
      createdAt
    ));
  }

  const completion = knowledgePackOnboardingCompletionSchema.parse({
    knowledge_pack: {
      pack_id: published.manifest.pack_id,
      release_id: published.release_id,
      installation_id: overlayInstallation.installation_id
    },
    installations: installed.installations,
    targets,
    snapshots,
    sources,
    workspace_href: `/domain-workspaces/${encodeURIComponent(current.answers.template!.pack_ids[0]!)}`
  });
  const now = Date.now();
  const reconciliationStatement = env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO knowledge_pack_goal_reconciliations(
       onboarding_id, tenant_id, status, expected_count, linked_count, error_code, reconciled_at
     ) VALUES(?,?,?,?,?,?,?)`
  ).bind(current.id, tenantId, "clean", plan.goals.length, plan.goals.length, null, now);
  const completionStatement = env.OPEN_BRAIN_DB.prepare(
    `UPDATE knowledge_pack_onboarding_sessions
     SET state = 'completed', current_step = 'completed', revision = revision + 1,
         completion_json = ?, completed_at = ?, updated_at = ?
     WHERE tenant_id = ? AND id = ? AND state = 'planned' AND plan_digest = ?
       AND completion_idempotency_key = ?`
  ).bind(canonicalJson(completion), now, now, tenantId, id, plan.plan_digest, idempotencyKey);
  const batchResults = await env.OPEN_BRAIN_DB.batch([...goalLinkStatements, reconciliationStatement, completionStatement]);
  const result = batchResults.at(-1)!;
  if (!result.meta.changes) {
    const latest = await onboardingSession(env, tenantId, id);
    if (latest.state === "completed" && latest.plan_digest === plan.plan_digest) return latest;
    throw new HttpError(409, "knowledge_pack_onboarding_revision_conflict", "The onboarding session changed during completion");
  }
  return onboardingSession(env, tenantId, id);
  } catch (error) {
    await env.OPEN_BRAIN_DB.prepare(
      `UPDATE knowledge_pack_onboarding_sessions
       SET completion_claimed_at = 0, updated_at = ?
       WHERE tenant_id = ? AND id = ? AND state = 'planned'
         AND completion_idempotency_key = ?`
    ).bind(Date.now(), tenantId, id, idempotencyKey).run();
    throw error;
  }
}
