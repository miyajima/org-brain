import {
  HttpError,
  MEMORY_WORK_TYPES,
  memoryImpactUtcDay,
  rebuildMemoryImpactMetricsForDay,
  resolveMemoryTokenEstimate,
  validateAvoidedLookupCategories,
  shouldSampleMemoryEffectVerification,
  ulid,
  type AvoidedLookupCategory,
  type MemoryEffectOutcome,
  type MemoryEffectEvidenceLevel,
  type MemoryWorkType
} from "@org-brain/shared";
import type { Env } from "./types";
import { validateBusinessClassification } from "./business-category-service";

type UsageSourceType = "memory" | "decision_memory";
type UsageItemInput = {
  id?: string | null;
  source_type: UsageSourceType;
  source_id: string;
  source_version?: number | null;
  rank?: number | null;
  score?: number | null;
  reference_type?: "returned" | "injected" | "direct";
  used_state?: "used" | "not_used" | "unknown";
  injected_token_estimate?: number;
  quality_category_snapshot?: string | null;
};

async function firstResult<T>(statement: D1PreparedStatement): Promise<T | null> {
  if (typeof statement.first === "function") return statement.first<T>();
  const result = await statement.all<T>();
  return result.results[0] ?? null;
}

async function runStatements(db: D1Database, statements: D1PreparedStatement[]) {
  if (typeof db.batch === "function") {
    await db.batch(statements);
    return;
  }
  for (const statement of statements) await statement.run();
}

export type MemoryUsageInput = {
  id?: string;
  tenant_id: string;
  project_id?: string | null;
  task_id?: string | null;
  trace_id?: string | null;
  external_run_id?: string | null;
  capability?: string | null;
  access_path: "search" | "profile" | "context" | "direct";
  request_source: "api" | "mcp" | "cap_runner" | "local";
  query_hash?: string | null;
  requested_business_category_id?: string | null;
  requested_work_type?: MemoryWorkType | null;
  retrieval_generation_id?: string | null;
  ranking_profile_id?: string | null;
  items: UsageItemInput[];
  created_at?: number;
};

function normalizedIdentifier(value: unknown, field: string, required = false) {
  if (value === undefined || value === null) {
    if (required) throw new HttpError(400, `${field}_required`, `${field} is required`);
    return null;
  }
  if (typeof value !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(value.trim())) {
    throw new HttpError(400, `invalid_${field}`, `${field} must be a normalized identifier or hash`);
  }
  return value.trim();
}

function normalizedQueryHash(value: unknown) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value.trim())) {
    throw new HttpError(400, "invalid_query_hash", "query_hash must be a 64-character hexadecimal SHA-256 digest");
  }
  return value.trim().toLowerCase();
}

export async function listMemoryFailurePatterns(env: Env, tenantId: string, projectId?: string | null) {
  return (await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, project_id, business_category_id, work_type,
            pattern_key, label, action_fingerprint, failure_fingerprint,
            is_active, created_at, updated_at
     FROM memory_failure_patterns
     WHERE tenant_id = ? AND (? IS NULL OR project_id = ? OR project_id IS NULL)
     ORDER BY is_active DESC, updated_at DESC`
  ).bind(tenantId, projectId ?? null, projectId ?? null).all<Record<string, unknown>>()).results;
}

export async function createMemoryFailurePattern(env: Env, tenantId: string, raw: unknown) {
  const body = asObject(raw);
  const patternKey = normalizedIdentifier(body.pattern_key, "pattern_key", true)!;
  if (typeof body.label !== "string" || !body.label.trim()) {
    throw new HttpError(400, "label_required", "label is required");
  }
  const workType = typeof body.work_type === "string" ? body.work_type : null;
  const businessCategoryId = typeof body.business_category_id === "string" ? body.business_category_id : null;
  await validateBusinessClassification(env, tenantId, businessCategoryId, workType, { required: false });
  const now = Date.now();
  const pattern = {
    id: typeof body.id === "string" && body.id.trim() ? body.id.trim().slice(0, 128) : ulid(now),
    tenant_id: tenantId,
    project_id: typeof body.project_id === "string" ? body.project_id.slice(0, 128) : null,
    business_category_id: businessCategoryId,
    work_type: workType,
    pattern_key: patternKey,
    label: body.label.trim().slice(0, 240),
    action_fingerprint: normalizedIdentifier(body.action_fingerprint, "action_fingerprint"),
    failure_fingerprint: normalizedIdentifier(body.failure_fingerprint, "failure_fingerprint"),
    is_active: body.is_active === false ? 0 : 1,
    created_at: now,
    updated_at: now
  };
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO memory_failure_patterns(
       id, tenant_id, project_id, business_category_id, work_type,
       pattern_key, label, action_fingerprint, failure_fingerprint,
       is_active, created_at, updated_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(...Object.values(pattern)).run();
  return pattern;
}

export async function updateMemoryFailurePattern(
  env: Env,
  tenantId: string,
  patternId: string,
  raw: unknown
) {
  const body = asObject(raw);
  const current = await firstResult<Record<string, unknown>>(env.OPEN_BRAIN_DB.prepare(
    "SELECT * FROM memory_failure_patterns WHERE tenant_id = ? AND id = ?"
  ).bind(tenantId, patternId));
  if (!current) throw new HttpError(404, "memory_failure_pattern_not_found", "failure pattern not found");
  const businessCategoryId = body.business_category_id === undefined
    ? current.business_category_id as string | null
    : typeof body.business_category_id === "string" ? body.business_category_id : null;
  const workType = body.work_type === undefined
    ? current.work_type as string | null
    : typeof body.work_type === "string" ? body.work_type : null;
  await validateBusinessClassification(env, tenantId, businessCategoryId, workType, { required: false });
  let label = current.label;
  if (body.label !== undefined) {
    if (typeof body.label !== "string" || !body.label.trim()) {
      throw new HttpError(400, "invalid_label", "label must be non-empty");
    }
    label = body.label.trim().slice(0, 240);
  }
  const updated = {
    ...current,
    project_id: body.project_id === undefined ? current.project_id : typeof body.project_id === "string" ? body.project_id.slice(0, 128) : null,
    business_category_id: businessCategoryId,
    work_type: workType,
    pattern_key: body.pattern_key === undefined ? current.pattern_key : normalizedIdentifier(body.pattern_key, "pattern_key", true),
    label,
    action_fingerprint: body.action_fingerprint === undefined
      ? current.action_fingerprint
      : normalizedIdentifier(body.action_fingerprint, "action_fingerprint"),
    failure_fingerprint: body.failure_fingerprint === undefined
      ? current.failure_fingerprint
      : normalizedIdentifier(body.failure_fingerprint, "failure_fingerprint"),
    is_active: body.is_active === undefined ? current.is_active : body.is_active ? 1 : 0,
    updated_at: Date.now()
  };
  await env.OPEN_BRAIN_DB.prepare(
    `UPDATE memory_failure_patterns SET
       project_id = ?, business_category_id = ?, work_type = ?, pattern_key = ?,
       label = ?, action_fingerprint = ?, failure_fingerprint = ?, is_active = ?, updated_at = ?
     WHERE tenant_id = ? AND id = ?`
  ).bind(
    updated.project_id, updated.business_category_id, updated.work_type,
    updated.pattern_key, updated.label, updated.action_fingerprint,
    updated.failure_fingerprint, updated.is_active, updated.updated_at,
    tenantId, patternId
  ).run();
  return updated;
}

export async function updateMemoryUsageStates(env: Pick<Env, "OPEN_BRAIN_DB">, tenantId: string, raw: unknown) {
  const body = asObject(raw);
  const usageEventId = typeof body.usage_event_id === "string" ? body.usage_event_id.trim() : "";
  if (!usageEventId) throw new HttpError(400, "usage_event_id_required", "usage_event_id is required");
  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 128) {
    throw new HttpError(400, "usage_state_items_required", "items must contain 1 to 128 usage state updates");
  }
  const event = await firstResult<{ id: string; created_at: number }>(env.OPEN_BRAIN_DB.prepare(
    "SELECT id, created_at FROM memory_usage_events WHERE tenant_id = ? AND id = ?"
  ).bind(tenantId, usageEventId));
  if (!event) throw new HttpError(404, "memory_usage_event_not_found", "usage event not found");
  const updates = body.items.map((rawItem) => {
    const item = asObject(rawItem);
    const usageItemId = typeof item.usage_item_id === "string" ? item.usage_item_id.trim() : "";
    if (!usageItemId) throw new HttpError(400, "usage_item_id_required", "usage_item_id is required");
    const usedState = typeof item.used_state === "string" ? item.used_state : "";
    if (!(["used", "not_used", "unknown"] as const).includes(usedState as "used" | "not_used" | "unknown")) {
      throw new HttpError(400, "invalid_used_state", "used_state must be used, not_used, or unknown");
    }
    return { usageItemId, usedState };
  });
  if (new Set(updates.map((item) => item.usageItemId)).size !== updates.length) {
    throw new HttpError(400, "duplicate_usage_item", "usage_item_id values must be unique");
  }
  for (const update of updates) {
    const item = await firstResult<{ id: string }>(env.OPEN_BRAIN_DB.prepare(
      "SELECT id FROM memory_usage_items WHERE tenant_id = ? AND usage_event_id = ? AND id = ?"
    ).bind(tenantId, usageEventId, update.usageItemId));
    if (!item) throw new HttpError(404, "memory_usage_item_not_found", "usage item not found in event");
  }
  await runStatements(env.OPEN_BRAIN_DB, updates.map((update) => env.OPEN_BRAIN_DB.prepare(
    "UPDATE memory_usage_items SET used_state = ?, used_state_source = 'reported' WHERE tenant_id = ? AND usage_event_id = ? AND id = ?"
  ).bind(update.usedState, tenantId, usageEventId, update.usageItemId)));
  await rebuildMemoryImpactMetricsForDay(
    env.OPEN_BRAIN_DB,
    memoryImpactUtcDay(Number(event.created_at ?? Date.now()))
  );
  return { usage_event_id: usageEventId, updated_count: updates.length };
}

function asObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpError(400, "invalid_payload", "request body must be an object");
  }
  return raw as Record<string, unknown>;
}

function median(values: number[]) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

async function sourceSnapshot(env: Env, tenantId: string, item: UsageItemInput) {
  if (!item.source_id?.trim()) throw new HttpError(400, "source_id_required", "source_id is required");
  const table = item.source_type === "decision_memory" ? "decision_memories" : "memories";
  const versionExpression = item.source_type === "decision_memory" ? "NULL" : "current_version";
  const row = await firstResult<{
    id: string;
    source_version: number | null;
    business_category_id: string | null;
    work_type: MemoryWorkType | null;
  }>(env.OPEN_BRAIN_DB.prepare(
    `SELECT id, ${versionExpression} AS source_version, business_category_id, work_type
     FROM ${table} WHERE tenant_id = ? AND id = ?`
  ).bind(tenantId, item.source_id));
  if (!row) throw new HttpError(404, "memory_source_not_found", "memory source not found in tenant");
  if (item.source_type === "decision_memory" && item.source_version === undefined) {
    const versions = await env.OPEN_BRAIN_DB.prepare(
      `SELECT id FROM decision_memory_versions
       WHERE tenant_id = ? AND decision_memory_id = ?`
    ).bind(tenantId, item.source_id).all<{ id: string }>();
    row.source_version = versions.results.length;
  }
  return row;
}

export async function recordMemoryUsage(env: Env, input: MemoryUsageInput) {
  const usageId = input.id?.trim() || ulid();
  const existing = await firstResult<{ id: string }>(env.OPEN_BRAIN_DB.prepare(
    "SELECT id FROM memory_usage_events WHERE tenant_id = ? AND id = ?"
  ).bind(input.tenant_id, usageId));
  if (existing) {
    const items = await env.OPEN_BRAIN_DB.prepare(
      "SELECT id FROM memory_usage_items WHERE tenant_id = ? AND usage_event_id = ? ORDER BY rank, id"
    ).bind(input.tenant_id, usageId).all<{ id: string }>();
    return {
      usage_id: usageId,
      usage_item_ids: items.results.map((item) => item.id),
      verification_sampled: shouldSampleMemoryEffectVerification(input.tenant_id, usageId),
      created: false
    };
  }
  let linkedProjectId = input.project_id;
  let linkedTaskId = input.task_id;
  let linkedTraceId = input.trace_id;
  if (input.external_run_id) {
    const execution = await firstResult<{
      external_run_id: string;
      project_id: string | null;
      task_id: string | null;
      trace_id: string | null;
    }>(env.OPEN_BRAIN_DB.prepare(
      `SELECT external_run_id, project_id, task_id, trace_id FROM memory_impact_events
       WHERE tenant_id = ? AND external_run_id = ? AND event_type = 'eligible'`
    ).bind(input.tenant_id, input.external_run_id));
    if (!execution) {
      throw new HttpError(404, "memory_impact_execution_not_found", "eligible memory impact execution not found");
    }
    for (const [field, supplied, expected] of [
      ["project_id", input.project_id, execution.project_id],
      ["task_id", input.task_id, execution.task_id],
      ["trace_id", input.trace_id, execution.trace_id]
    ] as const) {
      if (supplied !== undefined && supplied !== expected) {
        throw new HttpError(409, "memory_impact_context_mismatch", `${field} does not match eligible memory impact execution`);
      }
    }
    linkedProjectId = input.project_id === undefined ? execution.project_id : input.project_id;
    linkedTaskId = input.task_id === undefined ? execution.task_id : input.task_id;
    linkedTraceId = input.trace_id === undefined ? execution.trace_id : input.trace_id;
  }
  const createdAt = Number.isFinite(input.created_at) ? Number(input.created_at) : Date.now();
  const unique = new Map<string, UsageItemInput>();
  for (const item of input.items ?? []) {
    const key = `${item.source_type}:${item.source_id}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  const statements: D1PreparedStatement[] = [
    env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO memory_usage_events(
         id, tenant_id, project_id, task_id, trace_id, external_run_id, capability, access_path,
         request_source, query_hash, requested_business_category_id,
         requested_work_type, retrieval_generation_id, ranking_profile_id,
         verification_sampled, created_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      usageId, input.tenant_id, linkedProjectId ?? null, linkedTaskId ?? null,
      linkedTraceId ?? null, input.external_run_id ?? null, input.capability ?? null, input.access_path,
      input.request_source, input.query_hash ?? null,
      input.requested_business_category_id ?? null, input.requested_work_type ?? null,
      input.retrieval_generation_id ?? null, input.ranking_profile_id ?? null,
      shouldSampleMemoryEffectVerification(input.tenant_id, usageId) ? 1 : 0, createdAt
    )
  ];
  const itemIds: string[] = [];
  let index = 0;
  for (const item of unique.values()) {
    const snapshot = await sourceSnapshot(env, input.tenant_id, item);
    const itemId = item.id?.trim() || ulid();
    itemIds.push(itemId);
    statements.push(env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO memory_usage_items(
         id, usage_event_id, tenant_id, source_type, source_id, source_version,
         rank, score, reference_type, used_state, used_state_source, injected_token_estimate,
         business_category_id_snapshot, work_type_snapshot,
         quality_category_snapshot, created_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      itemId, usageId, input.tenant_id, item.source_type, snapshot.id,
      item.source_version ?? snapshot.source_version, item.rank ?? ++index,
      item.score ?? null, item.reference_type ?? "returned", item.used_state ?? "unknown", "reported",
      Math.max(0, Math.round(item.injected_token_estimate ?? 0)),
      snapshot.business_category_id, snapshot.work_type,
      item.quality_category_snapshot ?? null, createdAt
    ));
  }
  await runStatements(env.OPEN_BRAIN_DB, statements);
  return {
    usage_id: usageId,
    usage_item_ids: itemIds,
    verification_sampled: shouldSampleMemoryEffectVerification(input.tenant_id, usageId),
    created: true
  };
}

export async function recordMemoryUsageFromRequest(env: Env, tenantId: string, raw: unknown) {
  const body = asObject(raw);
  if (!["search", "profile", "context", "direct"].includes(String(body.access_path))) {
    throw new HttpError(400, "invalid_access_path", "access_path is invalid");
  }
  if (!["api", "mcp", "cap_runner", "local"].includes(String(body.request_source))) {
    throw new HttpError(400, "invalid_request_source", "request_source is invalid");
  }
  if (!Array.isArray(body.items)) throw new HttpError(400, "memory_usage_items_required", "items must be an array");
  if (
    body.requested_work_type !== undefined &&
    body.requested_work_type !== null &&
    !MEMORY_WORK_TYPES.includes(body.requested_work_type as MemoryWorkType)
  ) {
    throw new HttpError(400, "invalid_work_type", "requested_work_type is invalid");
  }
  await validateBusinessClassification(
    env,
    tenantId,
    typeof body.requested_business_category_id === "string" ? body.requested_business_category_id : null,
    typeof body.requested_work_type === "string" ? body.requested_work_type : null,
    { required: false }
  );
  const items = body.items.map((rawItem) => {
    const item = asObject(rawItem);
    if (!["memory", "decision_memory"].includes(String(item.source_type))) {
      throw new HttpError(400, "invalid_memory_source_type", "source_type is invalid");
    }
    if (typeof item.source_id !== "string" || !item.source_id.trim()) {
      throw new HttpError(400, "source_id_required", "source_id is required");
    }
    if (item.injected_token_estimate !== undefined && (
      typeof item.injected_token_estimate !== "number" ||
      !Number.isFinite(item.injected_token_estimate) ||
      item.injected_token_estimate < 0
    )) {
      throw new HttpError(400, "invalid_injected_token_estimate", "injected_token_estimate must be non-negative and finite");
    }
    return {
      id: typeof item.id === "string" ? item.id.slice(0, 128) : null,
      source_type: item.source_type as UsageSourceType,
      source_id: item.source_id.trim(),
      source_version: typeof item.source_version === "number" ? item.source_version : null,
      rank: typeof item.rank === "number" ? item.rank : null,
      score: typeof item.score === "number" ? item.score : null,
      reference_type: ["returned", "injected", "direct"].includes(String(item.reference_type))
        ? item.reference_type as UsageItemInput["reference_type"]
        : "returned",
      used_state: ["used", "not_used", "unknown"].includes(String(item.used_state))
        ? item.used_state as UsageItemInput["used_state"]
        : "unknown",
      injected_token_estimate: typeof item.injected_token_estimate === "number" ? item.injected_token_estimate : 0,
      quality_category_snapshot: typeof item.quality_category_snapshot === "string"
        ? item.quality_category_snapshot.slice(0, 128)
        : null
    };
  });
  return recordMemoryUsage(env, {
    id: typeof body.id === "string" ? body.id : undefined,
    tenant_id: tenantId,
    project_id: typeof body.project_id === "string" ? body.project_id : null,
    task_id: typeof body.task_id === "string" ? body.task_id : null,
    trace_id: typeof body.trace_id === "string" ? body.trace_id : null,
    external_run_id: typeof body.external_run_id === "string" && body.external_run_id.trim()
      ? body.external_run_id.trim().slice(0, 256)
      : null,
    capability: typeof body.capability === "string" ? body.capability : null,
    access_path: body.access_path as MemoryUsageInput["access_path"],
    request_source: body.request_source as MemoryUsageInput["request_source"],
    query_hash: normalizedQueryHash(body.query_hash),
    requested_business_category_id: typeof body.requested_business_category_id === "string"
      ? body.requested_business_category_id
      : null,
    requested_work_type: MEMORY_WORK_TYPES.includes(body.requested_work_type as MemoryWorkType)
      ? body.requested_work_type as MemoryWorkType
      : null,
    retrieval_generation_id: typeof body.retrieval_generation_id === "string" ? body.retrieval_generation_id : null,
    ranking_profile_id: typeof body.ranking_profile_id === "string" ? body.ranking_profile_id : null,
    items,
    created_at: typeof body.created_at === "number" ? body.created_at : undefined
  });
}

export async function recordMemoryEffect(env: Pick<Env, "OPEN_BRAIN_DB">, tenantId: string, raw: unknown) {
  const body = asObject(raw);
  const usageId = typeof body.usage_event_id === "string" ? body.usage_event_id.trim() : "";
  const idempotencyKey = typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
  if (!usageId) throw new HttpError(400, "usage_event_id_required", "usage_event_id is required");
  if (!idempotencyKey) throw new HttpError(400, "idempotency_key_required", "idempotency_key is required");
  const existing = await firstResult<{ id: string; usage_created_at: number }>(env.OPEN_BRAIN_DB.prepare(
    `SELECT e.id, u.created_at AS usage_created_at
     FROM memory_effect_events e
     JOIN memory_usage_events u ON u.tenant_id = e.tenant_id AND u.id = e.usage_event_id
     WHERE e.tenant_id = ? AND e.idempotency_key = ?`
  ).bind(tenantId, idempotencyKey));
  if (existing) {
    await rebuildMemoryImpactMetricsForDay(
      env.OPEN_BRAIN_DB,
      memoryImpactUtcDay(Number(existing.usage_created_at))
    );
    return { effect_id: existing.id, created: false };
  }
  const usage = await firstResult<{ id: string; created_at: number }>(env.OPEN_BRAIN_DB.prepare(
    "SELECT id, created_at FROM memory_usage_events WHERE tenant_id = ? AND id = ?"
  ).bind(tenantId, usageId));
  if (!usage) throw new HttpError(404, "memory_usage_event_not_found", "usage event not found");
  const usageItems = (await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, source_type, source_id, business_category_id_snapshot, injected_token_estimate FROM memory_usage_items
     WHERE tenant_id = ? AND usage_event_id = ? ORDER BY rank, id`
  ).bind(tenantId, usageId).all<{
    id: string; source_type: UsageSourceType; source_id: string;
    business_category_id_snapshot: string | null; injected_token_estimate: number;
  }>()).results;
  if (!usageItems.length) throw new HttpError(400, "memory_usage_items_required", "usage event has no referenced memories");

  if (body.avoided_lookup_categories !== undefined && !Array.isArray(body.avoided_lookup_categories)) {
    throw new HttpError(400, "invalid_avoided_lookup_categories", "avoided_lookup_categories must be an array");
  }
  const rawAvoided = Array.isArray(body.avoided_lookup_categories) ? body.avoided_lookup_categories : [];
  if (rawAvoided.some((value) => typeof value !== "string")) {
    throw new HttpError(400, "invalid_avoided_lookup_categories", "avoided lookup categories must be strings");
  }
  const avoided = rawAvoided as AvoidedLookupCategory[];
  try {
    validateAvoidedLookupCategories(avoided);
  } catch (error) {
    throw new HttpError(400, "invalid_avoided_lookup_categories", error instanceof Error ? error.message : String(error));
  }
  if (body.evidence_level !== undefined && !["reported", "estimated", "verified", "unverifiable"].includes(String(body.evidence_level))) {
    throw new HttpError(400, "invalid_evidence_level", "evidence_level is invalid");
  }
  const evidenceLevel = (body.evidence_level ?? "reported") as MemoryEffectEvidenceLevel;
  if (body.effect_outcome === undefined) throw new HttpError(400, "effect_outcome_required", "effect_outcome is required");
  if (!["positive", "neutral", "negative", "unknown"].includes(String(body.effect_outcome))) {
    throw new HttpError(400, "invalid_effect_outcome", "effect_outcome is invalid");
  }
  const outcome = body.effect_outcome as MemoryEffectOutcome;
  if (body.failure_opportunity_state !== undefined && !["applicable", "not_applicable", "unknown"].includes(String(body.failure_opportunity_state))) {
    throw new HttpError(400, "invalid_failure_opportunity_state", "failure_opportunity_state is invalid");
  }
  const opportunity = String(body.failure_opportunity_state ?? "unknown");
  const actionChanged = body.action_changed === true;
  const alternativeExecuted = body.alternative_executed === true;
  const failureAvoided = body.failure_avoided === true;
  if (failureAvoided && !(opportunity === "applicable" && actionChanged && alternativeExecuted)) {
    throw new HttpError(400, "invalid_failure_avoidance_evidence", "failure avoidance requires applicable opportunity, action change, and executed alternative");
  }
  const supersedesEffectId = typeof body.supersedes_effect_id === "string" && body.supersedes_effect_id.trim()
    ? body.supersedes_effect_id.trim()
    : null;
  if (supersedesEffectId) {
    const superseded = await firstResult<{ id: string }>(env.OPEN_BRAIN_DB.prepare(
      `SELECT id FROM memory_effect_events
       WHERE tenant_id = ? AND usage_event_id = ? AND id = ?`
    ).bind(tenantId, usageId, supersedesEffectId));
    if (!superseded) {
      throw new HttpError(400, "invalid_supersedes_effect_id", "superseded effect must belong to the same tenant and usage event");
    }
  }
  const currentEffect = await firstResult<{ id: string }>(env.OPEN_BRAIN_DB.prepare(
    `SELECT e.id FROM memory_effect_events e
     WHERE e.tenant_id = ? AND e.usage_event_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM memory_effect_events child
         WHERE child.tenant_id = e.tenant_id AND child.supersedes_effect_id = e.id
       )
     ORDER BY e.created_at DESC, e.id DESC LIMIT 1`
  ).bind(tenantId, usageId));
  if (currentEffect && supersedesEffectId !== currentEffect.id) {
    throw new HttpError(409, "effect_supersedes_latest_required", "a later effect must supersede the current effect");
  }
  if (!currentEffect && supersedesEffectId) {
    throw new HttpError(409, "effect_supersedes_latest_required", "superseded effect is not current");
  }
  const failurePatternId = typeof body.failure_pattern_id === "string" && body.failure_pattern_id.trim()
    ? body.failure_pattern_id.trim()
    : null;
  if (failurePatternId) {
    const pattern = await firstResult<{ id: string }>(env.OPEN_BRAIN_DB.prepare(
      "SELECT id FROM memory_failure_patterns WHERE tenant_id = ? AND id = ? AND is_active = 1"
    ).bind(tenantId, failurePatternId));
    if (!pattern) throw new HttpError(400, "invalid_failure_pattern_id", "failure pattern is not active in tenant");
  }
  if (opportunity === "applicable" && !failurePatternId) {
    throw new HttpError(400, "failure_pattern_id_required", "an applicable failure opportunity requires an explicit failure pattern");
  }
  if (evidenceLevel === "verified" && !(body.verification_ref_type && body.verification_ref_id)) {
    throw new HttpError(400, "verification_reference_required", "verified effects require a verification reference");
  }
  const requested = Array.isArray(body.attributions) ? body.attributions : [];
  const weights = new Map<string, number>();
  const usageItemIds = new Set(usageItems.map((item) => item.id));
  for (const rawAttribution of requested) {
    if (!rawAttribution || typeof rawAttribution !== "object") continue;
    const item = rawAttribution as Record<string, unknown>;
    if (typeof item.usage_item_id === "string") {
      if (!usageItemIds.has(item.usage_item_id)) {
        throw new HttpError(400, "invalid_usage_item_attribution", "attribution item must belong to the usage event");
      }
      const weight = Number(item.attribution_weight);
      if (!Number.isFinite(weight) || weight <= 0 || weight > 1) {
        throw new HttpError(400, "invalid_attribution_weight", "attribution weight must be greater than 0 and at most 1");
      }
      if (weights.has(item.usage_item_id)) {
        throw new HttpError(400, "duplicate_usage_item_attribution", "each usage item may be attributed only once");
      }
      weights.set(item.usage_item_id, weight);
    }
  }
  const attributions = usageItems.map((item) => ({
    usage_item_id: item.id,
    attribution_weight: weights.size ? weights.get(item.id) ?? 0 : 1 / usageItems.length
  })).filter((item) => item.attribution_weight > 0);
  const weightTotal = attributions.reduce((sum, item) => sum + item.attribution_weight, 0);
  if (Math.abs(weightTotal - 1) > 0.000001) {
    throw new HttpError(400, "attribution_weights_must_sum_to_one", "attribution weights must sum to 1.0");
  }
  const estimationCandidates = body.token_estimation_candidates && typeof body.token_estimation_candidates === "object" && !Array.isArray(body.token_estimation_candidates)
    ? { ...(body.token_estimation_candidates as Record<string, unknown>) }
    : {};
  if (body.gross_saved_tokens_estimate === undefined) {
    let sourceCharacters = 0;
    for (const item of usageItems) {
      const row = item.source_type === "memory"
        ? await firstResult<{ chars: number }>(env.OPEN_BRAIN_DB.prepare(
          "SELECT length(content) AS chars FROM memories WHERE tenant_id = ? AND id = ?"
        ).bind(tenantId, item.source_id))
        : await firstResult<{ chars: number }>(env.OPEN_BRAIN_DB.prepare(
          `SELECT length(title || char(10) || decision || char(10) || rationale || char(10) || constraints_json || char(10) || known_pitfalls_json) AS chars
           FROM decision_memories WHERE tenant_id = ? AND id = ?`
        ).bind(tenantId, item.source_id));
      sourceCharacters += Math.max(0, Number(row?.chars ?? 0));
    }
    const sourceTokens = Math.max(1, Math.ceil(sourceCharacters / 4));
    if (estimationCandidates.text_size_heuristic_tokens === undefined) {
      estimationCandidates.text_size_heuristic_tokens = sourceTokens;
    }
    if (
      estimationCandidates.avoided_source_tokens === undefined &&
      avoided.some((category) => category === "source_search" || category === "past_context")
    ) {
      estimationCandidates.avoided_source_tokens = sourceTokens;
    }
    if (failurePatternId && estimationCandidates.failure_pattern_median_tokens === undefined) {
      const historical = (await env.OPEN_BRAIN_DB.prepare(
        `SELECT e.gross_saved_tokens_estimate AS value FROM memory_effect_events e
         WHERE e.tenant_id = ? AND e.failure_pattern_id = ? AND e.evidence_level IN ('estimated', 'verified')
           AND NOT EXISTS (
             SELECT 1 FROM memory_effect_events child
             WHERE child.tenant_id = e.tenant_id AND child.supersedes_effect_id = e.id
           )
         ORDER BY e.created_at DESC LIMIT 101`
      ).bind(tenantId, failurePatternId).all<{ value: number }>()).results;
      const value = median(historical.map((row) => Number(row.value)).filter(Number.isFinite));
      if (value !== undefined) estimationCandidates.failure_pattern_median_tokens = value;
    }
    const categoryIds = [...new Set(usageItems.map((item) => item.business_category_id_snapshot).filter(Boolean))] as string[];
    if (categoryIds.length && estimationCandidates.category_median_tokens === undefined) {
      const historical = (await env.OPEN_BRAIN_DB.prepare(
        `SELECT ea.gross_saved_tokens AS value
         FROM memory_effect_attributions ea
         JOIN memory_effect_events e ON e.tenant_id = ea.tenant_id AND e.id = ea.effect_event_id
         JOIN memory_usage_items ui ON ui.tenant_id = ea.tenant_id AND ui.id = ea.usage_item_id
         WHERE ea.tenant_id = ? AND e.evidence_level IN ('estimated', 'verified')
           AND ui.business_category_id_snapshot IN (${categoryIds.map(() => "?").join(",")})
           AND NOT EXISTS (
             SELECT 1 FROM memory_effect_events child
             WHERE child.tenant_id = e.tenant_id AND child.supersedes_effect_id = e.id
           )
         ORDER BY ea.created_at DESC LIMIT 101`
      ).bind(tenantId, ...categoryIds).all<{ value: number }>()).results;
      const value = median(historical.map((row) => Number(row.value)).filter(Number.isFinite));
      if (value !== undefined) estimationCandidates.category_median_tokens = value;
    }
  }
  let tokenEstimate: ReturnType<typeof resolveMemoryTokenEstimate>;
  try {
    tokenEstimate = resolveMemoryTokenEstimate({ ...body, token_estimation_candidates: estimationCandidates });
  } catch (error) {
    const code = error instanceof Error ? error.message : "invalid_token_estimate";
    throw new HttpError(400, code, code);
  }
  const gross = tokenEstimate.gross_saved_tokens_estimate;
  const attributedIds = new Set(attributions.map((item) => item.usage_item_id));
  if (body.injected_tokens !== undefined && (!Number.isFinite(Number(body.injected_tokens)) || Number(body.injected_tokens) < 0)) {
    throw new HttpError(400, "invalid_injected_tokens", "injected_tokens must be a non-negative finite number");
  }
  const injected = body.injected_tokens === undefined
    ? usageItems
      .filter((item) => attributedIds.has(item.id))
      .reduce((sum, item) => sum + Math.max(0, Math.round(Number(item.injected_token_estimate ?? 0))), 0)
    : Math.max(0, Math.round(Number(body.injected_tokens)));
  const net = gross - injected;
  if (body.net_saved_tokens_estimate !== undefined && Math.round(Number(body.net_saved_tokens_estimate)) !== net) {
    throw new HttpError(400, "net_saved_tokens_mismatch", "net saved tokens must equal gross saved tokens minus injected tokens");
  }
  if (![gross, injected, net].every(Number.isFinite)) {
    throw new HttpError(400, "invalid_token_estimate", "token estimates must be finite numbers");
  }
  const effectId = ulid();
  const createdAt = Date.now();
  const failureSaved = Math.round(Number(body.failure_saved_tokens_estimate ?? 0));
  if (!Number.isFinite(failureSaved) || failureSaved < 0) {
    throw new HttpError(400, "invalid_failure_saved_tokens_estimate", "failure saved tokens must be a non-negative finite number");
  }
  if (failureSaved !== 0 && !failureAvoided) {
    throw new HttpError(400, "failure_saved_tokens_without_avoidance", "failure token savings require a confirmed failure avoidance");
  }
  const statements: D1PreparedStatement[] = [env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO memory_effect_events(
       id, tenant_id, usage_event_id, idempotency_key, evidence_level,
       supersedes_effect_id, effect_outcome, avoided_lookup_categories_json,
       gross_saved_tokens_estimate, injected_tokens, net_saved_tokens_estimate,
       estimate_lower_bound, estimate_upper_bound, estimation_method,
       estimator_version, estimate_confidence, failure_pattern_id,
       failure_opportunity_state, action_changed, alternative_executed,
       failure_avoided, failure_saved_tokens_estimate, verification_ref_type,
       verification_ref_id, estimated_tool_calls_saved, estimated_seconds_saved,
       created_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    effectId, tenantId, usageId, idempotencyKey, evidenceLevel,
    supersedesEffectId, outcome, JSON.stringify(avoided), gross,
    injected, net, body.estimate_lower_bound ?? null, body.estimate_upper_bound ?? null,
    tokenEstimate.estimation_method, body.estimator_version ?? null,
    body.estimate_confidence ?? null, failurePatternId, opportunity,
    actionChanged ? 1 : 0, alternativeExecuted ? 1 : 0, failureAvoided ? 1 : 0,
    failureSaved, body.verification_ref_type ?? null, body.verification_ref_id ?? null,
    body.estimated_tool_calls_saved ?? null, body.estimated_seconds_saved ?? null, createdAt
  )];
  let allocatedGross = 0;
  let allocatedNet = 0;
  let allocatedFailure = 0;
  attributions.forEach((attribution, index) => {
    const last = index === attributions.length - 1;
    const itemGross = last ? gross - allocatedGross : Math.round(gross * attribution.attribution_weight);
    const itemNet = last ? net - allocatedNet : Math.round(net * attribution.attribution_weight);
    const itemFailure = last ? failureSaved - allocatedFailure : Math.round(failureSaved * attribution.attribution_weight);
    allocatedGross += itemGross;
    allocatedNet += itemNet;
    allocatedFailure += itemFailure;
    statements.push(env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO memory_effect_attributions(
         id, tenant_id, effect_event_id, usage_item_id, attribution_weight,
         gross_saved_tokens, net_saved_tokens, failure_saved_tokens, created_at
       ) VALUES(?,?,?,?,?,?,?,?,?)`
    ).bind(ulid(), tenantId, effectId, attribution.usage_item_id, attribution.attribution_weight,
      itemGross, itemNet, itemFailure, createdAt));
  });
  if (supersedesEffectId) {
    statements.push(env.OPEN_BRAIN_DB.prepare(
      `UPDATE memory_usage_items SET used_state = 'unknown', used_state_source = 'reported'
       WHERE tenant_id = ? AND usage_event_id = ? AND used_state_source = 'effect'
         AND id IN (
           SELECT usage_item_id FROM memory_effect_attributions
           WHERE tenant_id = ? AND effect_event_id = ?
         )`
    ).bind(tenantId, usageId, tenantId, supersedesEffectId));
  }
  if (outcome !== "unknown") {
    const attributedItemIds = attributions.map((attribution) => attribution.usage_item_id);
    statements.push(env.OPEN_BRAIN_DB.prepare(
      `UPDATE memory_usage_items SET used_state = 'used', used_state_source = 'effect'
       WHERE tenant_id = ? AND usage_event_id = ?
         AND (used_state_source = 'effect' OR used_state = 'unknown')
         AND id IN (${attributedItemIds.map(() => "?").join(",")})`
    ).bind(tenantId, usageId, ...attributedItemIds));
  }
  await runStatements(env.OPEN_BRAIN_DB, statements);
  await rebuildMemoryImpactMetricsForDay(
    env.OPEN_BRAIN_DB,
    memoryImpactUtcDay(Number(usage.created_at ?? createdAt))
  );
  return { effect_id: effectId, created: true, net_saved_tokens_estimate: net };
}

const GROUP_COLUMNS = {
  memory: "ui.source_type || ':' || ui.source_id",
  business_category: "COALESCE(ui.business_category_id_snapshot, 'unclassified')",
  work_type: "COALESCE(ui.work_type_snapshot, 'unclassified')",
  project: "COALESCE(ue.project_id, 'unclassified')",
  day: "date(ui.created_at / 1000, 'unixepoch')"
} as const;

export async function memoryImpactReport(env: Env, tenantId: string, raw: unknown) {
  const body = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const groupBy = typeof body.group_by === "string" && body.group_by in GROUP_COLUMNS
    ? body.group_by as keyof typeof GROUP_COLUMNS
    : "memory";
  const dimension = GROUP_COLUMNS[groupBy];
  const result = await env.OPEN_BRAIN_DB.prepare(
    `WITH latest_effect AS (
       SELECT e.* FROM memory_effect_events e
       WHERE e.tenant_id = ? AND NOT EXISTS (
         SELECT 1 FROM memory_effect_events child
         WHERE child.tenant_id = e.tenant_id
           AND child.supersedes_effect_id = e.id
       )
     )
     SELECT ${dimension} AS group_key,
       CASE WHEN ea.usage_item_id IS NOT NULL THEN le.evidence_level ELSE 'unreported' END AS evidence_level,
       COUNT(DISTINCT ui.usage_event_id) AS reference_count,
       COUNT(DISTINCT CASE WHEN ui.used_state = 'used' THEN ui.usage_event_id END) AS used_count,
       COUNT(DISTINCT CASE WHEN ui.used_state = 'not_used' THEN ui.usage_event_id END) AS not_used_count,
       COUNT(DISTINCT CASE WHEN ui.used_state = 'unknown' THEN ui.usage_event_id END) AS usage_unknown_count,
       COUNT(DISTINCT CASE WHEN ea.usage_item_id IS NOT NULL THEN ui.usage_event_id END) AS effect_reported_count,
       COUNT(DISTINCT CASE WHEN ea.usage_item_id IS NOT NULL AND le.effect_outcome = 'positive' THEN ui.usage_event_id END) AS positive_count,
       COUNT(DISTINCT CASE WHEN ea.usage_item_id IS NOT NULL AND le.effect_outcome = 'neutral' THEN ui.usage_event_id END) AS neutral_count,
       COUNT(DISTINCT CASE WHEN ea.usage_item_id IS NOT NULL AND le.effect_outcome = 'negative' THEN ui.usage_event_id END) AS negative_count,
       COUNT(DISTINCT CASE WHEN ea.usage_item_id IS NOT NULL AND le.effect_outcome = 'unknown' THEN ui.usage_event_id END) AS unknown_count,
       COUNT(DISTINCT CASE WHEN ea.usage_item_id IS NOT NULL AND le.avoided_lookup_categories_json LIKE '%source_search%' THEN ui.usage_event_id END) AS avoided_source_search_count,
       COUNT(DISTINCT CASE WHEN ea.usage_item_id IS NOT NULL AND le.avoided_lookup_categories_json LIKE '%web_search%' THEN ui.usage_event_id END) AS avoided_web_search_count,
       COUNT(DISTINCT CASE WHEN ea.usage_item_id IS NOT NULL AND le.avoided_lookup_categories_json LIKE '%past_context%' THEN ui.usage_event_id END) AS avoided_past_context_count,
       COUNT(DISTINCT CASE WHEN ea.usage_item_id IS NOT NULL AND le.avoided_lookup_categories_json = '["none"]' THEN ui.usage_event_id END) AS avoided_none_count,
       COALESCE(SUM(ea.gross_saved_tokens), 0) AS gross_saved_tokens,
       COALESCE(SUM(ea.gross_saved_tokens - ea.net_saved_tokens), 0) AS injected_tokens,
       COALESCE(SUM(ea.net_saved_tokens), 0) AS net_saved_tokens,
       COUNT(DISTINCT CASE WHEN ea.usage_item_id IS NOT NULL AND le.failure_opportunity_state = 'applicable' THEN ui.usage_event_id END) AS failure_opportunity_count,
       COUNT(DISTINCT CASE WHEN ea.usage_item_id IS NOT NULL AND le.failure_avoided = 1 THEN ui.usage_event_id END) AS failure_avoided_count,
       COALESCE(SUM(ea.failure_saved_tokens), 0) AS failure_saved_tokens,
       COUNT(DISTINCT CASE WHEN ue.verification_sampled = 1 THEN ui.usage_event_id END) AS verification_sampled_count,
       COUNT(DISTINCT CASE WHEN ue.verification_sampled = 1 AND ea.usage_item_id IS NOT NULL AND le.evidence_level = 'verified' THEN ui.usage_event_id END) AS verified_count,
       SUM(le.estimated_tool_calls_saved * ea.attribution_weight) AS estimated_tool_calls_saved,
       SUM(le.estimated_seconds_saved * ea.attribution_weight) AS estimated_seconds_saved,
       COALESCE(SUM(CASE
         WHEN le.evidence_level = 'verified' AND previous.id IS NOT NULL
         THEN ABS(COALESCE(ea.gross_saved_tokens, 0) - COALESCE(previous_attribution.gross_saved_tokens, 0))
         ELSE 0 END), 0) AS estimator_absolute_error_sum
     FROM memory_usage_items ui
     JOIN memory_usage_events ue ON ue.tenant_id = ui.tenant_id AND ue.id = ui.usage_event_id
     LEFT JOIN latest_effect le ON le.tenant_id = ui.tenant_id AND le.usage_event_id = ui.usage_event_id
     LEFT JOIN memory_effect_attributions ea
       ON ea.tenant_id = ui.tenant_id AND ea.effect_event_id = le.id AND ea.usage_item_id = ui.id
     LEFT JOIN memory_effect_events previous
       ON previous.tenant_id = le.tenant_id AND previous.id = le.supersedes_effect_id
     LEFT JOIN memory_effect_attributions previous_attribution
       ON previous_attribution.tenant_id = previous.tenant_id
      AND previous_attribution.effect_event_id = previous.id
      AND previous_attribution.usage_item_id = ui.id
     WHERE ui.tenant_id = ?
       ${groupBy === "business_category" ? "AND ui.business_category_id_snapshot IS NOT NULL" : ""}
     GROUP BY group_key, CASE WHEN ea.usage_item_id IS NOT NULL THEN le.evidence_level ELSE 'unreported' END
     ORDER BY group_key, evidence_level`
  ).bind(tenantId, tenantId).all<Record<string, unknown>>();
  const rankResult = await env.OPEN_BRAIN_DB.prepare(
    `SELECT rank, COUNT(DISTINCT usage_event_id) AS reference_count,
            COUNT(DISTINCT CASE WHEN used_state = 'used' THEN usage_event_id END) AS used_count,
            COUNT(DISTINCT CASE WHEN used_state = 'not_used' THEN usage_event_id END) AS not_used_count,
            COUNT(DISTINCT CASE WHEN used_state = 'unknown' THEN usage_event_id END) AS usage_unknown_count
     FROM memory_usage_items
     WHERE tenant_id = ? AND rank IS NOT NULL
     GROUP BY rank ORDER BY rank`
  ).bind(tenantId).all<{
    rank: number;
    reference_count: number;
    used_count: number;
    not_used_count: number;
    usage_unknown_count: number;
  }>();
  return {
    tenant_id: tenantId,
    group_by: groupBy,
    unclassified_excluded: groupBy === "business_category",
    groups: result.results.map((row) => {
      const referenceCount = Number(row.reference_count ?? 0);
      const usedCount = Number(row.used_count ?? 0);
      const positiveCount = Number(row.positive_count ?? 0);
      const failureOpportunityCount = Number(row.failure_opportunity_count ?? 0);
      const verificationSampledCount = Number(row.verification_sampled_count ?? 0);
      const verifiedCount = Number(row.verified_count ?? 0);
      const injectedTokens = Number(row.injected_tokens ?? 0);
      const netSavedTokens = Number(row.net_saved_tokens ?? 0);
      return {
        ...row,
        utilization_rate: referenceCount ? usedCount / referenceCount : null,
        positive_effect_rate: usedCount ? positiveCount / usedCount : null,
        negative_effect_rate: usedCount ? Number(row.negative_count ?? 0) / usedCount : null,
        failure_avoidance_rate: failureOpportunityCount
          ? Number(row.failure_avoided_count ?? 0) / failureOpportunityCount
          : null,
        verification_coverage: verificationSampledCount ? verifiedCount / verificationSampledCount : null,
        net_saved_tokens_per_1000_injected: injectedTokens
          ? netSavedTokens * 1000 / injectedTokens
          : null
      };
    }),
    rank_utilization: rankResult.results.map((row) => ({
      ...row,
      utilization_rate: row.reference_count ? row.used_count / row.reference_count : null
    }))
  };
}
