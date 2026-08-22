import { HttpError, MEMORY_KINDS, MEMORY_LIFECYCLE_STATES, MEMORY_SCOPE_TYPES, parseTagsJson, type MemoryKind, type MemoryLifecycleState, type MemoryScopeType, type MemoryWorkType } from "@org-brain/shared";
import { captureMemoryItems, deleteMemory, loadExistingMemoryIdsByExternalKeys, refreshMemory, restoreSuppressedMemory, reviseMemory, runBatchChunks, suppressMemory } from "./memory-lifecycle-service";
import { removeMemoryIdsFromV3SemanticIndex, removeMemoryIdsFromV4SemanticIndex, removeMemoryIdsFromSemanticIndex, syncMemoryIdsToSemanticIndexes } from "./retrieval-index-service";
import { assertMemoryNotOnLegalHold } from "./retention-service";
import { screenMemoryCaptureText, screenMemoryWriteText } from "./memory-screening-service";
import type { Env } from "./types";
import { validateBusinessClassification } from "./business-category-service";
import { recordMemoryUsage } from "./memory-effect-service";
import { parseOptionalNullableString as parseOptionalString } from "./request-value-utils";
import { normalizeActorPrincipal, parseOptionalFiniteNumber, parseString } from "./memory-service-utils";
import type { MemoryRow, PrincipalActorOptions } from "./memory-service-types";
export { resolveRetrievalSearchMode, searchMemories, shouldRunRetrievalShadow, stableResultReadable } from "./memory-search-service";
export { getMemoryProfile, retrieveMemoryContext } from "./memory-context-service";

type UpsertMemoryItem = {
  external_key: string;
  content: string;
  summary?: string;
  tags?: string[];
  created_at?: number;
  project_id?: string | null;
  actor_type?: string | null;
  actor_id?: string | null;
  kind?: MemoryKind;
  lifecycle_state?: MemoryLifecycleState;
  scope_type?: MemoryScopeType;
  scope_key?: string | null;
  confidence_score?: number | null;
  utility_score?: number | null;
  canonical_key?: string | null;
  expires_at?: number | null;
  entities?: string[];
  source_references?: Array<Record<string, unknown>>;
  valid_from?: number | null;
  valid_until?: number | null;
  rationale?: string | null;
  reuse_rule?: string | null;
  evidence?: Array<Record<string, unknown>>;
  conflicts?: string[];
  permissions?: Array<Record<string, unknown>>;
  business_category_id?: string | null;
  work_type?: MemoryWorkType | null;
  permissions_json?: string | null;
  source_refs_json?: string | null;
  conflicts_json?: string | null;
  owner_principal?: string | null;
  created_by_principal?: string | null;
  deleted_at?: number | null;
  deleted_by_principal?: string | null;
  delete_reason?: string | null;
  updated_at?: number | null;
  reference_count?: number | null;
  used_count?: number | null;
  consumer_count?: number | null;
  net_saved_tokens?: number | null;
  injected_tokens?: number | null;
};

type UpsertMemoryRequest = {
  tenant_id?: string;
  source?: string;
  items: UpsertMemoryItem[];
};

type CaptureMemoryRequest = {
  tenant_id?: string;
  source?: string;
  actor_type?: string | null;
  actor_id?: string | null;
  items: UpsertMemoryItem[];
};

type ReviseMemoryRequest = {
  tenant_id?: string;
  memory_id?: string;
  content?: string;
  summary?: string | null;
  tags?: string[];
  confidence_score?: number | null;
  utility_score?: number | null;
  actor_type?: string | null;
  actor_id?: string | null;
  project_id?: string | null;
  owner_principal?: string | null;
  entities?: string[];
  source_references?: Array<Record<string, unknown>>;
  valid_from?: number | null;
  valid_until?: number | null;
  rationale?: string | null;
  reuse_rule?: string | null;
  evidence?: Array<Record<string, unknown>>;
  conflicts?: string[];
  permissions?: Array<Record<string, unknown>>;
  business_category_id?: string | null;
  work_type?: MemoryWorkType | null;
  kind?: MemoryKind;
  canonical_key?: string | null;
  expires_at?: number | null;
};

type RefreshMemoryRequest = {
  tenant_id?: string;
  memory_id?: string;
  confidence_delta?: number | null;
  actor_type?: string | null;
  actor_id?: string | null;
};

type SuppressMemoryRequest = {
  tenant_id?: string;
  memory_id?: string;
  reason?: string;
  actor_type?: string | null;
  actor_id?: string | null;
};

type TrashMemoryRequest = {
  tenant_id?: string;
  memory_id?: string;
  reason?: string;
};

type RestoreMemoryRequest = {
  tenant_id?: string;
  memory_id?: string;
};

type ListMemoriesOptions = {
  limit?: number;
  offset?: number;
  source?: string;
  projectId?: string | null;
  businessCategoryId?: string | null;
  workType?: MemoryWorkType | null;
  ownerPrincipal?: string | null;
  createdByPrincipal?: string | null;
  lifecycle?: "active" | "review" | "trash" | "all";
  includeTrashed?: boolean;
  from?: number | null;
  to?: number | null;
  sort?: "created" | "updated" | "usage";
};

type MemoryListView = "full" | "compact";

type MemoryListCursor = {
  createdAt: number;
  id: string;
};

export type MemoryListPage = {
  tenant_id: string;
  project_id: string | null;
  source: string | null;
  items: Array<{
    id: string;
    project_id: string | null;
    content: string;
    summary: string | null;
    tags: string[];
    source: string;
    external_key: string | null;
    created_at: number;
    kind: MemoryKind;
    lifecycle_state: MemoryLifecycleState;
    current_version: number;
    last_accessed_at: number | null;
    confidence_score: number | null;
    utility_score: number | null;
    business_category_id: string | null;
    work_type: MemoryWorkType | null;
    owner_principal: string | null;
    created_by_principal: string | null;
    deleted_at: number | null;
    deleted_by_principal: string | null;
    delete_reason: string | null;
    updated_at: number | null;
    reference_count: number;
    used_count: number;
    consumer_count: number;
    net_saved_tokens: number;
    injected_tokens: number;
  }>;
  meta: {
    limit: number;
    offset: number;
    total: number;
    has_next: boolean;
    has_prev: boolean;
    canonical_count: number;
    digest_count: number;
    compacted_count: number;
  };
};

export type MemoryCursorPage = {
  tenant_id: string;
  view: MemoryListView;
  items: Array<Record<string, unknown>>;
  next_cursor: string | null;
};

export type MemoryDetail = {
  tenant_id: string;
  memory_id: string;
  memory: {
    id: string;
    source: string;
    external_key: string | null;
    created_at: number;
    kind: string;
    current_version: number;
    last_accessed_at: number | null;
    confidence_score: number | null;
    utility_score: number | null;
    actor_type: string | null;
    actor_id: string | null;
    owner_principal: string | null;
    created_by_principal: string | null;
    deleted_at: number | null;
    deleted_by_principal: string | null;
    delete_reason: string | null;
    project_id: string | null;
    content: string;
    summary: string | null;
    tags: string[];
    lifecycle_state: string;
    updated_at: number | null;
    reference_count: number;
    used_count: number;
    consumer_count: number;
    net_saved_tokens: number;
    injected_tokens: number;
    reuse_rule: string | null;
    capture_origin: string;
    capture_route: string;
    capture_batch_id: string | null;
    verification_state: string;
    verified_at: number | null;
    learning: Record<string, unknown> | null;
    quality_dimensions: Record<string, number> | null;
  } | null;
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
  rationales: Array<{
    id: string;
    decision_type: string;
    conclusion: string;
    reason_summary: string;
    status: string;
    confirmation_state: string;
    confidence_score: number | null;
    created_at: number;
    confirmed_at: number | null;
    evidence: Array<{
      id: string;
      evidence_type: string;
      evidence_ref: string;
      relation: string;
      note: string | null;
      weight_score: number | null;
      content_hash: string | null;
      observed_at: number | null;
      attestation_ref: string | null;
    }>;
  }>;
  meta?: { usage_id: string; verification_sampled: boolean };
};

function parseTags(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new HttpError(400, "invalid_payload", "tags must be an array of strings");
  }
  const tags = raw
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
    .slice(0, 16);
  return [...new Set(tags)];
}

function parseObjectArray(raw: unknown, field: string): Array<Record<string, unknown>> {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((value) => !value || typeof value !== "object" || Array.isArray(value))) {
    throw new HttpError(400, "invalid_payload", `${field} must be an array of objects`);
  }
  return raw.slice(0, 64) as Array<Record<string, unknown>>;
}

function parseOptionalActorField(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_payload", `${field} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function parseOptionalEnum<T extends readonly string[]>(
  value: unknown,
  field: string,
  allowed: T
): T[number] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new HttpError(400, "invalid_payload", `${field} must be one of ${allowed.join(", ")}`);
  }
  return value as T[number];
}

async function assignMemoryOwnership(
  env: Env,
  tenantId: string,
  memoryIds: string[],
  creatorPrincipal: string | null
): Promise<void> {
  const normalizedCreator = normalizeActorPrincipal(creatorPrincipal);
  const mapping = normalizedCreator
    ? await env.OPEN_BRAIN_DB.prepare(
        `SELECT owner_principal FROM principal_owner_mappings
         WHERE tenant_id = ? AND producer_principal = ?`
      ).bind(tenantId, normalizedCreator).first<{ owner_principal: string }>()
    : null;
  const ownerPrincipal = mapping?.owner_principal ?? normalizedCreator;
  if (!ownerPrincipal && !normalizedCreator) return;
  const uniqueIds = [...new Set(memoryIds.filter(Boolean))];
  await runBatchChunks(env.OPEN_BRAIN_DB, uniqueIds.map((memoryId) => env.OPEN_BRAIN_DB.prepare(
    `UPDATE memories
     SET owner_principal = COALESCE(owner_principal, ?),
         created_by_principal = COALESCE(created_by_principal, ?)
     WHERE tenant_id = ? AND id = ?`
  ).bind(ownerPrincipal, normalizedCreator, tenantId, memoryId)));
}

type MemoryOwnershipRow = {
  owner_principal: string | null;
  deleted_at: number | null;
};

async function assertMemoryManageAccess(
  env: Env,
  tenantId: string,
  memoryId: string,
  options: PrincipalActorOptions
): Promise<MemoryOwnershipRow> {
  const row = await env.OPEN_BRAIN_DB.prepare(
    "SELECT owner_principal, deleted_at FROM memories WHERE tenant_id = ? AND id = ?"
  ).bind(tenantId, memoryId).first<MemoryOwnershipRow>();
  if (!row) throw new HttpError(404, "memory_not_found", "memory not found");
  if (options.canManageAll) return row;
  const principal = normalizeActorPrincipal(options.actorPrincipal);
  if (!principal || row.owner_principal !== principal) {
    throw new HttpError(403, "memory_owner_required", "Only the memory owner or a tenant admin can change this memory");
  }
  return row;
}

function withPrincipalActor(rawBody: unknown, principal: string | null | undefined): unknown {
  const actorId = normalizeActorPrincipal(principal);
  if (!actorId || !rawBody || typeof rawBody !== "object") return rawBody;
  const body = rawBody as Record<string, unknown>;
  const items = Array.isArray(body.items)
    ? body.items.map((item) =>
        item && typeof item === "object"
          ? {
              ...(item as Record<string, unknown>),
              actor_type: "principal",
              actor_id: actorId
            }
          : item
      )
    : body.items;
  return {
    ...body,
    actor_type: "principal",
    actor_id: actorId,
    items
  };
}

function screenPersistedValue(
  value: unknown,
  field: string,
  screen: (text: string, field: string) => string
): unknown {
  if (typeof value === "string") return screen(value, field);
  if (Array.isArray(value)) {
    return value.map((item, index) => screenPersistedValue(item, `${field}[${index}]`, screen));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        screenPersistedValue(item, `${field}.${key}`, screen)
      ])
    );
  }
  return value;
}

function memoryWriteScreener(env: Env) {
  return env.ORGBRAIN_MEMORY_CAPTURE_V2_MODE === "on"
    ? (value: string, field: string) => screenMemoryCaptureText(value, field)
    : screenMemoryWriteText;
}

function parseUpsertRequest(raw: unknown): { tenantId: string; source: string; actorType: string | null; actorId: string | null; items: UpsertMemoryItem[] } {
  if (!raw || typeof raw !== "object") {
    throw new HttpError(400, "invalid_payload", "request body must be an object");
  }
  const body = raw as UpsertMemoryRequest;
  const tenantId = body.tenant_id ? parseString(body.tenant_id, "tenant_id") : "default";
  const source = body.source ? parseString(body.source, "source").slice(0, 64) : "openclaw";
  const actorType = parseOptionalActorField((body as CaptureMemoryRequest).actor_type, "actor_type", 64);
  const actorId = parseOptionalActorField((body as CaptureMemoryRequest).actor_id, "actor_id", 128);
  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw new HttpError(400, "invalid_payload", "items must be a non-empty array");
  }
  if (body.items.length > 200) {
    throw new HttpError(400, "invalid_payload", "items must be <= 200");
  }

  const items = body.items.map((item, i) => {
    if (!item || typeof item !== "object") {
      throw new HttpError(400, "invalid_payload", `items[${i}] must be an object`);
    }
    const key = parseString((item as UpsertMemoryItem).external_key, `items[${i}].external_key`).slice(0, 256);
    const content = parseString((item as UpsertMemoryItem).content, `items[${i}].content`);
    const summaryRaw = (item as UpsertMemoryItem).summary;
    const summary = typeof summaryRaw === "string" ? summaryRaw.trim().slice(0, 1000) : undefined;
    const createdAtRaw = (item as UpsertMemoryItem).created_at;
    const createdAt =
      typeof createdAtRaw === "number" && Number.isFinite(createdAtRaw) ? Math.floor(createdAtRaw) : undefined;
    const projectRaw = (item as UpsertMemoryItem).project_id;
    const projectId = typeof projectRaw === "string" ? projectRaw.trim().slice(0, 128) : null;
    const tags = parseTags((item as UpsertMemoryItem).tags);
    const actorTypeItem = parseOptionalActorField((item as UpsertMemoryItem).actor_type, `items[${i}].actor_type`, 64);
    const actorIdItem = parseOptionalActorField((item as UpsertMemoryItem).actor_id, `items[${i}].actor_id`, 128);
    return {
      external_key: key,
      content: content.slice(0, 20_000),
      summary,
      created_at: createdAt,
      project_id: projectId,
      tags,
      actor_type: actorTypeItem ?? actorType,
      actor_id: actorIdItem ?? actorId,
      kind: parseOptionalEnum((item as UpsertMemoryItem).kind, `items[${i}].kind`, MEMORY_KINDS),
      lifecycle_state: parseOptionalEnum(
        (item as UpsertMemoryItem).lifecycle_state,
        `items[${i}].lifecycle_state`,
        MEMORY_LIFECYCLE_STATES
      ),
      scope_type: parseOptionalEnum((item as UpsertMemoryItem).scope_type, `items[${i}].scope_type`, MEMORY_SCOPE_TYPES),
      scope_key: parseOptionalString((item as UpsertMemoryItem).scope_key, `items[${i}].scope_key`, 128),
      confidence_score: parseOptionalFiniteNumber((item as UpsertMemoryItem).confidence_score, `items[${i}].confidence_score`),
      utility_score: parseOptionalFiniteNumber((item as UpsertMemoryItem).utility_score, `items[${i}].utility_score`),
      canonical_key: parseOptionalString((item as UpsertMemoryItem).canonical_key, `items[${i}].canonical_key`, 256),
      expires_at: parseOptionalFiniteNumber((item as UpsertMemoryItem).expires_at, `items[${i}].expires_at`),
      entities: parseTags((item as UpsertMemoryItem).entities),
      source_references: parseObjectArray(
        (item as UpsertMemoryItem).source_references,
        `items[${i}].source_references`
      ),
      valid_from: parseOptionalFiniteNumber((item as UpsertMemoryItem).valid_from, `items[${i}].valid_from`),
      valid_until: parseOptionalFiniteNumber((item as UpsertMemoryItem).valid_until, `items[${i}].valid_until`),
      rationale: parseOptionalString((item as UpsertMemoryItem).rationale, `items[${i}].rationale`, 4000),
      reuse_rule: parseOptionalString((item as UpsertMemoryItem).reuse_rule, `items[${i}].reuse_rule`, 1000),
      evidence: parseObjectArray((item as UpsertMemoryItem).evidence, `items[${i}].evidence`),
      conflicts: parseTags((item as UpsertMemoryItem).conflicts),
      permissions: parseObjectArray((item as UpsertMemoryItem).permissions, `items[${i}].permissions`),
      business_category_id: parseOptionalString(
        (item as UpsertMemoryItem).business_category_id,
        `items[${i}].business_category_id`,
        128
      ),
      work_type: (item as UpsertMemoryItem).work_type
    };
  });

  return { tenantId, source, actorType, actorId, items };
}

async function validateWriteClassifications<
  T extends { business_category_id?: string | null; work_type?: MemoryWorkType | null }
>(env: Env, tenantId: string, items: T[]) {
  const warnings = new Set<string>();
  const validated = await Promise.all(items.map(async (item) => {
    const classification = await validateBusinessClassification(
      env,
      tenantId,
      item.business_category_id,
      item.work_type,
      { required: env.MEMORY_CLASSIFICATION_MODE === "require" }
    );
    for (const warning of classification.classification_warning ?? []) warnings.add(warning);
    return { ...item, ...classification };
  }));
  return { items: validated, classification_warning: [...warnings] };
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function buildMemoryListFilterSql(options: {
  source?: string;
  projectId?: string | null;
  businessCategoryId?: string | null;
  workType?: MemoryWorkType | null;
  ownerPrincipal?: string | null;
  createdByPrincipal?: string | null;
  lifecycle?: "active" | "review" | "trash" | "all";
  includeTrashed?: boolean;
  from?: number | null;
  to?: number | null;
}) {
  const clauses: string[] = [];
  const bindings: unknown[] = [];

  if (typeof options.source === "string" && options.source.trim().length > 0) {
    clauses.push("source = ?");
    bindings.push(options.source.trim());
  }

  if (typeof options.projectId === "string" && options.projectId.trim().length > 0) {
    clauses.push("project_id = ?");
    bindings.push(options.projectId.trim());
  }
  if (options.businessCategoryId) {
    clauses.push("business_category_id = ?");
    bindings.push(options.businessCategoryId);
  }
  if (options.workType) {
    clauses.push("work_type = ?");
    bindings.push(options.workType);
  }

  if (typeof options.ownerPrincipal === "string" && options.ownerPrincipal.trim()) {
    clauses.push("owner_principal = ?");
    bindings.push(options.ownerPrincipal.trim());
  }
  if (typeof options.createdByPrincipal === "string" && options.createdByPrincipal.trim()) {
    clauses.push("created_by_principal = ?");
    bindings.push(options.createdByPrincipal.trim());
  }
  if (options.from !== undefined && options.from !== null) {
    clauses.push("COALESCE(updated_at, created_at) >= ?");
    bindings.push(options.from);
  }
  if (options.to !== undefined && options.to !== null) {
    clauses.push("COALESCE(updated_at, created_at) <= ?");
    bindings.push(options.to);
  }

  if (options.lifecycle === "trash") {
    clauses.push("deleted_at IS NOT NULL");
  } else if (options.lifecycle === "all") {
    if (!options.includeTrashed) clauses.push("deleted_at IS NULL");
  } else {
    clauses.push("deleted_at IS NULL");
    clauses.push("(lifecycle_state IS NULL OR lifecycle_state != ?)");
    bindings.push("suppressed");
    if (options.lifecycle === "review") {
      clauses.push("(confidence_score IS NULL OR confidence_score < 0.6 OR utility_score IS NULL OR utility_score < 0.4 OR last_accessed_at IS NULL)");
    }
  }

  const sql = clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "";
  return { sql, bindings };
}

export async function upsertMemories(env: Env, rawBody: unknown, options: PrincipalActorOptions = {}) {
  const { tenantId, source, items: parsedItems } = parseUpsertRequest(withPrincipalActor(rawBody, options.actorPrincipal));
  const screen = memoryWriteScreener(env);
  const screenedItems = parsedItems.map((item, index) => ({
    ...item,
    content: screen(item.content, `items[${index}].content`),
    summary: item.summary == null ? undefined : screen(item.summary, `items[${index}].summary`),
    tags: item.tags?.map((tag, tagIndex) => screen(tag, `items[${index}].tags[${tagIndex}]`)),
    entities: item.entities?.map((entity, entityIndex) => screen(entity, `items[${index}].entities[${entityIndex}]`)),
    rationale: item.rationale == null ? item.rationale : screen(item.rationale, `items[${index}].rationale`),
    reuse_rule: item.reuse_rule == null ? item.reuse_rule : screen(item.reuse_rule, `items[${index}].reuse_rule`),
    source_references: item.source_references?.map((entry, entryIndex) =>
      screenPersistedValue(entry, `items[${index}].source_references[${entryIndex}]`, screen) as Record<string, unknown>
    ),
    evidence: item.evidence?.map((entry, entryIndex) =>
      screenPersistedValue(entry, `items[${index}].evidence[${entryIndex}]`, screen) as Record<string, unknown>
    ),
    conflicts: item.conflicts?.map((conflict, conflictIndex) =>
      screen(conflict, `items[${index}].conflicts[${conflictIndex}]`)
    )
  }));
  const classification = await validateWriteClassifications(env, tenantId, screenedItems);
  const items = classification.items;
  const existingByKey = await loadExistingMemoryIdsByExternalKeys(
    env.OPEN_BRAIN_DB,
    tenantId,
    items.map((item) => item.external_key)
  );
  const previousV3Projection = await removeMemoryIdsFromV3SemanticIndex(
    env,
    tenantId,
    [...existingByKey.values()]
  );
  const previousV4Projection = await removeMemoryIdsFromV4SemanticIndex(
    env,
    tenantId,
    [...existingByKey.values()]
  );
  if (previousV3Projection.error || previousV4Projection.error) {
    throw new HttpError(
      503,
      "retrieval_projection_failed",
      previousV3Projection.error ?? previousV4Projection.error ?? "retrieval projection failed"
    );
  }
  const result = await captureMemoryItems(env, { tenantId, source, items, operation: "capture" });
  await assignMemoryOwnership(
    env,
    tenantId,
    result.items.map((item) => item.memory_id),
    options.actorPrincipal ?? null
  );
  const retrievalProjections = await syncMemoryIdsToSemanticIndexes(
    env,
    tenantId,
    result.items.map((item) => item.memory_id)
  );
  return {
    ...result,
    ...retrievalProjections,
    ...(classification.classification_warning.length
      ? { classification_warning: classification.classification_warning }
      : {})
  };
}

export async function listMemories(env: Env, tenantId: string, options: ListMemoriesOptions = {}) {
  await validateBusinessClassification(
    env,
    tenantId,
    options.businessCategoryId,
    options.workType,
    { required: false }
  );
  const safeLimit = Math.max(1, Math.min(500, options.limit ?? 100));
  const safeOffset = Math.max(0, options.offset ?? 0);
  const filter = buildMemoryListFilterSql(options);
  const orderBy = options.sort === "usage"
    ? "reference_count DESC, COALESCE(updated_at, created_at) DESC"
    : options.sort === "updated"
      ? "COALESCE(updated_at, created_at) DESC"
      : "created_at DESC";
  const result = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, project_id, content, summary, tags_json, source, external_key, created_at,
            kind, lifecycle_state, current_version, last_accessed_at,
            confidence_score, utility_score, business_category_id, work_type,
            owner_principal, created_by_principal, deleted_at, deleted_by_principal, delete_reason,
            updated_at,
            (SELECT COUNT(*) FROM memory_usage_items ui
             WHERE ui.tenant_id = memories.tenant_id AND ui.source_type = 'memory' AND ui.source_id = memories.id) AS reference_count,
            (SELECT COUNT(*) FROM memory_usage_items ui
             WHERE ui.tenant_id = memories.tenant_id AND ui.source_type = 'memory' AND ui.source_id = memories.id
               AND ui.used_state = 'used') AS used_count,
            (SELECT COUNT(DISTINCT ue.actor_principal) FROM memory_usage_items ui
             JOIN memory_usage_events ue ON ue.tenant_id = ui.tenant_id AND ue.id = ui.usage_event_id
             WHERE ui.tenant_id = memories.tenant_id AND ui.source_type = 'memory' AND ui.source_id = memories.id
               AND ue.actor_principal IS NOT NULL) AS consumer_count,
            (SELECT COALESCE(SUM(ea.net_saved_tokens), 0) FROM memory_effect_attributions ea
             JOIN memory_usage_items ui ON ui.tenant_id = ea.tenant_id AND ui.id = ea.usage_item_id
             WHERE ea.tenant_id = memories.tenant_id AND ui.source_type = 'memory' AND ui.source_id = memories.id) AS net_saved_tokens,
            (SELECT COALESCE(SUM(ea.gross_saved_tokens - ea.net_saved_tokens), 0) FROM memory_effect_attributions ea
             JOIN memory_usage_items ui ON ui.tenant_id = ea.tenant_id AND ui.id = ea.usage_item_id
             WHERE ea.tenant_id = memories.tenant_id AND ui.source_type = 'memory' AND ui.source_id = memories.id) AS injected_tokens,
            reuse_rule, capture_origin, capture_route, capture_batch_id, verification_state
     FROM memories
     WHERE tenant_id = ?${filter.sql}
     ORDER BY ${orderBy}
     LIMIT ?
     OFFSET ?`
  )
    .bind(tenantId, ...filter.bindings, safeLimit, safeOffset)
    .all<MemoryRow>();

  return result.results.map((row) => ({
    id: row.id,
    project_id: row.project_id,
    content: row.content,
    summary: row.summary,
    tags: parseTagsJson(row.tags_json),
     source: row.source,
     external_key: row.external_key,
      created_at: row.created_at,
      kind: (row.kind as MemoryKind | null) ?? "episodic",
      lifecycle_state: (row.lifecycle_state as MemoryLifecycleState | null) ?? "active",
      current_version: Number(row.current_version ?? 1),
      last_accessed_at: row.last_accessed_at ?? null,
      confidence_score: row.confidence_score ?? null,
      utility_score: row.utility_score ?? null,
      business_category_id: row.business_category_id ?? null,
      work_type: row.work_type ?? null,
      owner_principal: row.owner_principal ?? null,
      created_by_principal: row.created_by_principal ?? null,
      deleted_at: row.deleted_at ?? null,
      deleted_by_principal: row.deleted_by_principal ?? null,
      delete_reason: row.delete_reason ?? null,
      updated_at: row.updated_at ?? null,
      reference_count: Number(row.reference_count ?? 0),
      used_count: Number(row.used_count ?? 0),
      consumer_count: Number(row.consumer_count ?? 0),
      net_saved_tokens: Number(row.net_saved_tokens ?? 0),
      injected_tokens: Number(row.injected_tokens ?? 0)
      , capture_origin: row.capture_origin ?? "legacy"
      , capture_route: row.capture_route ?? "legacy"
      , capture_batch_id: row.capture_batch_id ?? null
      , verification_state: row.verification_state ?? "unverified"
  }));
}

function encodeMemoryListCursor(cursor: MemoryListCursor): string {
  return btoa(JSON.stringify([cursor.createdAt, cursor.id]))
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
}

function decodeMemoryListCursor(raw: string | null | undefined): MemoryListCursor | null {
  if (!raw) return null;
  try {
    const normalized = raw.replace(/-/gu, "+").replace(/_/gu, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const parsed = JSON.parse(atob(padded)) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2 ||
        typeof parsed[0] !== "number" || !Number.isFinite(parsed[0]) ||
        typeof parsed[1] !== "string" || !parsed[1]) {
      throw new Error("invalid cursor payload");
    }
    return { createdAt: Math.floor(parsed[0]), id: parsed[1].slice(0, 128) };
  } catch {
    throw new HttpError(400, "invalid_cursor", "cursor is invalid");
  }
}

export async function listMemoriesCursorPage(
  env: Env,
  tenantId: string,
  options: ListMemoriesOptions & { cursor?: string | null; view?: MemoryListView } = {}
): Promise<MemoryCursorPage> {
  await validateBusinessClassification(
    env,
    tenantId,
    options.businessCategoryId,
    options.workType,
    { required: false }
  );
  const view = options.view ?? "full";
  if (view !== "full" && view !== "compact") {
    throw new HttpError(400, "invalid_view", "view must be full or compact");
  }
  const maximum = view === "compact" ? 500 : 100;
  const safeLimit = Math.max(1, Math.min(maximum, options.limit ?? (view === "compact" ? 500 : 100)));
  const cursor = decodeMemoryListCursor(options.cursor);
  const filter = buildMemoryListFilterSql(options);
  const cursorSql = cursor ? " AND (created_at < ? OR (created_at = ? AND id < ?))" : "";
  const cursorBindings = cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : [];
  const result = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, project_id, content, summary, tags_json, source, external_key, created_at,
            kind, lifecycle_state, current_version, last_accessed_at,
            confidence_score, utility_score, business_category_id, work_type
     FROM memories
     WHERE tenant_id = ?${filter.sql}${cursorSql}
     ORDER BY created_at DESC, id DESC
     LIMIT ?`
  ).bind(tenantId, ...filter.bindings, ...cursorBindings, safeLimit + 1).all<MemoryRow>();
  const hasNext = result.results.length > safeLimit;
  const rows = result.results.slice(0, safeLimit);
  const items = rows.map((row) => {
    const common = {
      id: row.id,
      project_id: row.project_id,
      summary: row.summary,
      source: row.source,
      created_at: row.created_at,
      kind: (row.kind as MemoryKind | null) ?? "episodic",
      lifecycle_state: (row.lifecycle_state as MemoryLifecycleState | null) ?? "active",
      confidence_score: row.confidence_score ?? null,
      utility_score: row.utility_score ?? null,
      business_category_id: row.business_category_id ?? null,
      work_type: row.work_type ?? null
    };
    if (view === "compact") return common;
    return {
      ...common,
      content: row.content,
      tags: parseTagsJson(row.tags_json),
      external_key: row.external_key,
      current_version: Number(row.current_version ?? 1),
      last_accessed_at: row.last_accessed_at ?? null,
      reuse_rule: row.reuse_rule ?? null
    };
  });
  const last = rows.at(-1);
  return {
    tenant_id: tenantId,
    view,
    items,
    next_cursor: hasNext && last
      ? encodeMemoryListCursor({ createdAt: last.created_at, id: last.id })
      : null
  };
}

export async function listMemoriesPage(env: Env, tenantId: string, options: ListMemoriesOptions = {}): Promise<MemoryListPage> {
  const safeLimit = Math.max(1, Math.min(100, options.limit ?? 24));
  const safeOffset = Math.max(0, options.offset ?? 0);
  const filter = buildMemoryListFilterSql(options);
  const items = await listMemories(env, tenantId, {
    limit: safeLimit,
    offset: safeOffset,
    source: options.source,
    projectId: options.projectId,
    businessCategoryId: options.businessCategoryId,
    workType: options.workType,
    ownerPrincipal: options.ownerPrincipal,
    createdByPrincipal: options.createdByPrincipal,
    lifecycle: options.lifecycle,
    includeTrashed: options.includeTrashed,
    from: options.from,
    to: options.to,
    sort: options.sort
  });

  const countRows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN tags_json LIKE '%"canonical-memory"%' THEN 1 ELSE 0 END) AS canonical_count,
       SUM(CASE WHEN tags_json LIKE '%"memory-digest"%' THEN 1 ELSE 0 END) AS digest_count,
       SUM(CASE WHEN tags_json LIKE '%"compacted"%' THEN 1 ELSE 0 END) AS compacted_count
     FROM memories
     WHERE tenant_id = ?${filter.sql}`
  )
    .bind(tenantId, ...filter.bindings)
    .all<{
      total: number | null;
      canonical_count: number | null;
      digest_count: number | null;
      compacted_count: number | null;
    }>();

  const countResult = countRows.results[0];

  const total = Number(countResult?.total ?? 0);

  return {
    tenant_id: tenantId,
    project_id: options.projectId?.trim() || null,
    source: options.source?.trim() || null,
    items,
    meta: {
      limit: safeLimit,
      offset: safeOffset,
      total,
      has_next: safeOffset + items.length < total,
      has_prev: safeOffset > 0,
      canonical_count: Number(countResult?.canonical_count ?? 0),
      digest_count: Number(countResult?.digest_count ?? 0),
      compacted_count: Number(countResult?.compacted_count ?? 0)
    }
  };
}

export async function getMemoryDetails(
  env: Env,
  tenantId: string,
  memoryId: string,
  options: PrincipalActorOptions = {}
): Promise<MemoryDetail> {
  const memory = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, source, external_key, created_at, kind, current_version, last_accessed_at,
            confidence_score, utility_score,
            actor_type, actor_id, owner_principal, created_by_principal,
            deleted_at, deleted_by_principal, delete_reason,
            project_id, content, summary, tags_json, lifecycle_state, updated_at,
            (SELECT COUNT(*) FROM memory_usage_items ui
             WHERE ui.tenant_id = memories.tenant_id AND ui.source_type = 'memory' AND ui.source_id = memories.id) AS reference_count,
            (SELECT COUNT(*) FROM memory_usage_items ui
             WHERE ui.tenant_id = memories.tenant_id AND ui.source_type = 'memory' AND ui.source_id = memories.id
               AND ui.used_state = 'used') AS used_count,
            (SELECT COUNT(DISTINCT ue.actor_principal) FROM memory_usage_items ui
             JOIN memory_usage_events ue ON ue.tenant_id = ui.tenant_id AND ue.id = ui.usage_event_id
             WHERE ui.tenant_id = memories.tenant_id AND ui.source_type = 'memory' AND ui.source_id = memories.id
               AND ue.actor_principal IS NOT NULL) AS consumer_count,
            (SELECT COALESCE(SUM(ea.net_saved_tokens), 0) FROM memory_effect_attributions ea
             JOIN memory_usage_items ui ON ui.tenant_id = ea.tenant_id AND ui.id = ea.usage_item_id
             WHERE ea.tenant_id = memories.tenant_id AND ui.source_type = 'memory' AND ui.source_id = memories.id) AS net_saved_tokens,
            (SELECT COALESCE(SUM(ea.gross_saved_tokens - ea.net_saved_tokens), 0) FROM memory_effect_attributions ea
             JOIN memory_usage_items ui ON ui.tenant_id = ea.tenant_id AND ui.id = ea.usage_item_id
             WHERE ea.tenant_id = memories.tenant_id AND ui.source_type = 'memory' AND ui.source_id = memories.id) AS injected_tokens,
            reuse_rule, capture_origin, capture_route, capture_batch_id, verification_state, verified_at, learning_json, quality_dimensions_json
     FROM memories
     WHERE tenant_id = ? AND id = ?`
  )
    .bind(tenantId, memoryId)
    .first<MemoryRow>();

  const versions = await env.OPEN_BRAIN_DB.prepare(
    `SELECT version, operation, summary, kind, lifecycle_state, actor_type, actor_id, created_at
     FROM memory_versions
     WHERE tenant_id = ? AND memory_id = ?
     ORDER BY version DESC
     LIMIT 20`
  )
    .bind(tenantId, memoryId)
    .all<{
      version: number;
      operation: string;
      summary: string | null;
      kind: string;
      lifecycle_state: string;
      actor_type: string | null;
      actor_id: string | null;
      created_at: number;
    }>();

  const rationaleRows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, decision_type, conclusion, reason_summary, status, confirmation_state, confidence_score, created_at, confirmed_at
     FROM decision_rationales
     WHERE tenant_id = ? AND memory_id = ?
     ORDER BY created_at DESC
     LIMIT 20`
  )
    .bind(tenantId, memoryId)
    .all<{
      id: string;
      decision_type: string;
      conclusion: string;
      reason_summary: string;
      status: string;
      confirmation_state: string;
      confidence_score: number | null;
      created_at: number;
      confirmed_at: number | null;
    }>();

  const rationaleIds = rationaleRows.results.map((row) => row.id);
  const evidenceByRationale = new Map<string, MemoryDetail["rationales"][number]["evidence"]>();
  if (rationaleIds.length > 0) {
    const placeholders = rationaleIds.map(() => "?").join(", ");
    const evidenceRows = await env.OPEN_BRAIN_DB.prepare(
      `SELECT id, rationale_id, evidence_type, evidence_ref, relation, note, weight_score,
              content_hash, observed_at, attestation_ref
       FROM decision_evidence
       WHERE tenant_id = ? AND rationale_id IN (${placeholders})
       ORDER BY created_at DESC
       LIMIT 100`
    )
      .bind(tenantId, ...rationaleIds)
      .all<{
        id: string;
        rationale_id: string;
        evidence_type: string;
        evidence_ref: string;
        relation: string;
        note: string | null;
        weight_score: number | null;
        content_hash: string | null;
        observed_at: number | null;
        attestation_ref: string | null;
      }>();
    for (const row of evidenceRows.results) {
      const list = evidenceByRationale.get(row.rationale_id) ?? [];
      list.push({
        id: row.id,
        evidence_type: row.evidence_type,
        evidence_ref: row.evidence_ref,
        relation: row.relation,
        note: row.note,
        weight_score: row.weight_score,
        content_hash: row.content_hash,
        observed_at: row.observed_at,
        attestation_ref: row.attestation_ref
      });
      evidenceByRationale.set(row.rationale_id, list);
    }
  }

  const usage = memory && options.recordUsage !== false ? await recordMemoryUsage(env, {
    tenant_id: tenantId,
    capability: "memory_details",
    access_path: "direct",
    request_source: "api",
    actor_principal: options.actorPrincipal ?? null,
    items: [{
      source_type: "memory",
      source_id: memoryId,
      source_version: memory.current_version,
      rank: 1,
      reference_type: "direct",
      used_state: "unknown"
    }]
  }) : null;
  return {
    tenant_id: tenantId,
    memory_id: memoryId,
    memory: memory
      ? {
          id: memory.id,
          source: memory.source,
          external_key: memory.external_key ?? null,
          created_at: memory.created_at,
          kind: memory.kind ?? "episodic",
          current_version: Number(memory.current_version ?? 1),
          last_accessed_at: memory.last_accessed_at ?? null,
          confidence_score: memory.confidence_score ?? null,
          utility_score: memory.utility_score ?? null,
          actor_type: memory.actor_type ?? null,
          actor_id: memory.actor_id ?? null,
          owner_principal: memory.owner_principal ?? null,
          created_by_principal: memory.created_by_principal ?? null,
          deleted_at: memory.deleted_at ?? null,
          deleted_by_principal: memory.deleted_by_principal ?? null,
          delete_reason: memory.delete_reason ?? null,
          project_id: memory.project_id,
          content: memory.content,
          summary: memory.summary,
          tags: parseTagsJson(memory.tags_json),
          lifecycle_state: memory.lifecycle_state ?? "active",
          updated_at: memory.updated_at ?? null,
          reference_count: Number(memory.reference_count ?? 0),
          used_count: Number(memory.used_count ?? 0),
          consumer_count: Number(memory.consumer_count ?? 0),
          net_saved_tokens: Number(memory.net_saved_tokens ?? 0),
          injected_tokens: Number(memory.injected_tokens ?? 0),
          reuse_rule: memory.reuse_rule ?? null,
          capture_origin: memory.capture_origin ?? "legacy",
          capture_route: memory.capture_route ?? "legacy",
          capture_batch_id: memory.capture_batch_id ?? null,
          verification_state: memory.verification_state ?? "unverified",
          verified_at: memory.verified_at ?? null,
          learning: parseJsonObject(memory.learning_json),
          quality_dimensions: parseJsonObject(memory.quality_dimensions_json) as Record<string, number> | null
        }
      : null,
    versions: versions.results,
    rationales: rationaleRows.results.map((row) => ({
      ...row,
      evidence: evidenceByRationale.get(row.id) ?? []
    })),
    ...(usage ? { meta: { usage_id: usage.usage_id, verification_sampled: usage.verification_sampled } } : {})
  };
}

export async function captureMemories(env: Env, rawBody: unknown, options: PrincipalActorOptions = {}) {
  rawBody = withPrincipalActor(rawBody, options.actorPrincipal);
  if (!rawBody || typeof rawBody !== "object") {
    throw new HttpError(400, "invalid_payload", "request body must be an object");
  }
  const body = rawBody as CaptureMemoryRequest;
  const tenantId = body.tenant_id ? parseString(body.tenant_id, "tenant_id") : "default";
  const source = body.source ? parseString(body.source, "source").slice(0, 64) : "org-brain";
  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw new HttpError(400, "invalid_payload", "items must be a non-empty array");
  }
  const classification = await validateWriteClassifications(env, tenantId, body.items);
  const externalKeys = body.items.flatMap((item) =>
    typeof item.external_key === "string" && item.external_key.trim()
      ? [item.external_key.trim()]
      : []
  );
  const existingByKey = await loadExistingMemoryIdsByExternalKeys(
    env.OPEN_BRAIN_DB,
    tenantId,
    externalKeys
  );
  const previousV3Projection = await removeMemoryIdsFromV3SemanticIndex(
    env,
    tenantId,
    [...existingByKey.values()]
  );
  const previousV4Projection = await removeMemoryIdsFromV4SemanticIndex(
    env,
    tenantId,
    [...existingByKey.values()]
  );
  if (previousV3Projection.error || previousV4Projection.error) {
    throw new HttpError(
      503,
      "retrieval_projection_failed",
      previousV3Projection.error ?? previousV4Projection.error ?? "retrieval projection failed"
    );
  }
  const result = await captureMemoryItems(env, {
    tenantId,
    source,
    items: classification.items,
    operation: "capture"
  });
  await assignMemoryOwnership(
    env,
    tenantId,
    result.items.map((item) => item.memory_id),
    options.actorPrincipal ?? null
  );
  const retrievalProjections = await syncMemoryIdsToSemanticIndexes(
    env,
    tenantId,
    result.items.map((item) => item.memory_id)
  );
  return {
    ...result,
    ...retrievalProjections,
    ...(classification.classification_warning.length
      ? { classification_warning: classification.classification_warning }
      : {})
  };
}

export async function reviseMemoryByRequest(env: Env, rawBody: unknown, options: PrincipalActorOptions = {}) {
  if (!rawBody || typeof rawBody !== "object") {
    throw new HttpError(400, "invalid_payload", "request body must be an object");
  }
  const body = rawBody as ReviseMemoryRequest;
  const tenantId = body.tenant_id ? parseString(body.tenant_id, "tenant_id") : "default";
  const memoryId = parseString(body.memory_id, "memory_id");
  const classification = await validateBusinessClassification(
    env,
    tenantId,
    body.business_category_id,
    body.work_type,
    { required: env.MEMORY_CLASSIFICATION_MODE === "require" }
  );
  const actorPrincipal = normalizeActorPrincipal(options.actorPrincipal);
  const requestedOwner = body.owner_principal === undefined
    ? undefined
    : parseOptionalActorField(body.owner_principal, "owner_principal", 128);
  if (requestedOwner !== undefined && !options.canManageAll) {
    throw new HttpError(403, "owner_change_requires_admin", "Only a tenant admin can change memory ownership");
  }
  await assertMemoryManageAccess(env, tenantId, memoryId, options);
  const screen = memoryWriteScreener(env);
  const rawSummary = parseOptionalString(body.summary, "summary", 1000);
  const rawRationale = parseOptionalString(body.rationale, "rationale", 4000);
  const rawReuseRule = parseOptionalString(body.reuse_rule, "reuse_rule", 1000);
  const rawTags = body.tags ? parseTags(body.tags) : undefined;
  const rawEntities = body.entities ? parseTags(body.entities) : undefined;
  const rawSourceReferences = body.source_references
    ? parseObjectArray(body.source_references, "source_references")
    : undefined;
  const rawEvidence = body.evidence ? parseObjectArray(body.evidence, "evidence") : undefined;
  const rawConflicts = body.conflicts ? parseTags(body.conflicts) : undefined;
  const screenedContent = typeof body.content === "string"
    ? screen(body.content.slice(0, 20_000), "content")
    : undefined;
  const screenedSummary = rawSummary == null ? rawSummary : screen(rawSummary, "summary");
  const screenedRationale = rawRationale == null ? rawRationale : screen(rawRationale, "rationale");
  const screenedReuseRule = rawReuseRule == null ? rawReuseRule : screen(rawReuseRule, "reuse_rule");
  const screenedTags = rawTags?.map((tag, index) => screen(tag, `tags[${index}]`));
  const screenedEntities = rawEntities?.map((entity, index) => screen(entity, `entities[${index}]`));
  const screenedSourceReferences = rawSourceReferences?.map((entry, index) =>
    screenPersistedValue(entry, `source_references[${index}]`, screen) as Record<string, unknown>
  );
  const screenedEvidence = rawEvidence?.map((entry, index) =>
    screenPersistedValue(entry, `evidence[${index}]`, screen) as Record<string, unknown>
  );
  const screenedConflicts = rawConflicts?.map((conflict, index) => screen(conflict, `conflicts[${index}]`));
  const previousV3Projection = await removeMemoryIdsFromV3SemanticIndex(env, tenantId, [memoryId]);
  const previousV4Projection = await removeMemoryIdsFromV4SemanticIndex(env, tenantId, [memoryId]);
  if (previousV3Projection.error || previousV4Projection.error) {
    throw new HttpError(
      503,
      "retrieval_projection_failed",
      previousV3Projection.error ?? previousV4Projection.error ?? "retrieval projection failed"
    );
  }
  const result = await reviseMemory(env, {
    tenantId,
    memoryId,
    projectId: body.project_id === undefined
      ? undefined
      : parseOptionalString(body.project_id, "project_id", 128),
    actorType: actorPrincipal ? "principal" : parseOptionalActorField(body.actor_type, "actor_type", 64),
    actorId: actorPrincipal ?? parseOptionalActorField(body.actor_id, "actor_id", 128),
    content: screenedContent,
    summary: screenedSummary,
    tags: screenedTags,
    confidenceScore: parseOptionalFiniteNumber(body.confidence_score, "confidence_score"),
    utilityScore: parseOptionalFiniteNumber(body.utility_score, "utility_score"),
    entities: screenedEntities,
    sourceReferences: screenedSourceReferences,
    validFrom: parseOptionalFiniteNumber(body.valid_from, "valid_from"),
    validUntil: parseOptionalFiniteNumber(body.valid_until, "valid_until"),
    rationale: screenedRationale,
    reuseRule: screenedReuseRule,
    evidence: screenedEvidence,
    conflicts: screenedConflicts,
    permissions: body.permissions ? parseObjectArray(body.permissions, "permissions") : undefined,
    businessCategoryId: body.business_category_id === undefined
      ? undefined
      : classification.business_category_id,
    workType: body.work_type === undefined ? undefined : classification.work_type,
    kind: body.kind === undefined ? undefined : parseOptionalEnum(body.kind, "kind", MEMORY_KINDS) ?? undefined,
    canonicalKey: body.canonical_key === undefined
      ? undefined
      : parseOptionalString(body.canonical_key, "canonical_key", 256),
    expiresAt: body.expires_at === undefined
      ? undefined
      : parseOptionalFiniteNumber(body.expires_at, "expires_at")
  });
  if (requestedOwner !== undefined) {
    await env.OPEN_BRAIN_DB.prepare(
      "UPDATE memories SET owner_principal = ?, updated_at = ? WHERE tenant_id = ? AND id = ?"
    ).bind(requestedOwner, Date.now(), tenantId, memoryId).run();
  }
  return {
    ...result,
    ...await syncMemoryIdsToSemanticIndexes(env, tenantId, [memoryId]),
    ...(classification.classification_warning
      ? { classification_warning: classification.classification_warning }
      : {})
  };
}

export async function refreshMemoryByRequest(env: Env, rawBody: unknown, options: PrincipalActorOptions = {}) {
  if (!rawBody || typeof rawBody !== "object") {
    throw new HttpError(400, "invalid_payload", "request body must be an object");
  }
  const body = rawBody as RefreshMemoryRequest;
  const tenantId = body.tenant_id ? parseString(body.tenant_id, "tenant_id") : "default";
  const actorPrincipal = normalizeActorPrincipal(options.actorPrincipal);
  const memoryId = parseString(body.memory_id, "memory_id");
  const ownership = await assertMemoryManageAccess(env, tenantId, memoryId, options);
  if (ownership.deleted_at !== null) {
    throw new HttpError(409, "memory_in_trash", "Restore the memory before refreshing it");
  }
  return refreshMemory(env, {
    tenantId,
    memoryId,
    actorType: actorPrincipal ? "principal" : parseOptionalActorField(body.actor_type, "actor_type", 64),
    actorId: actorPrincipal ?? parseOptionalActorField(body.actor_id, "actor_id", 128),
    confidenceDelta: parseOptionalFiniteNumber(body.confidence_delta, "confidence_delta")
  });
}

export async function suppressMemoryByRequest(env: Env, rawBody: unknown, options: PrincipalActorOptions = {}) {
  if (!rawBody || typeof rawBody !== "object") {
    throw new HttpError(400, "invalid_payload", "request body must be an object");
  }
  const body = rawBody as SuppressMemoryRequest;
  const tenantId = body.tenant_id ? parseString(body.tenant_id, "tenant_id") : "default";
  const actorPrincipal = normalizeActorPrincipal(options.actorPrincipal);
  const memoryId = parseString(body.memory_id, "memory_id");
  const ownership = await assertMemoryManageAccess(env, tenantId, memoryId, options);
  if (ownership.deleted_at !== null) {
    throw new HttpError(409, "memory_in_trash", "Restore the memory before suppressing it");
  }
  const retrievalProjectionV3 = await removeMemoryIdsFromV3SemanticIndex(env, tenantId, [memoryId]);
  const retrievalProjectionV4 = await removeMemoryIdsFromV4SemanticIndex(env, tenantId, [memoryId]);
  const retrievalProjection = await removeMemoryIdsFromSemanticIndex(env, tenantId, [memoryId]);
  if (retrievalProjection.error || retrievalProjectionV3.error || retrievalProjectionV4.error) {
    throw new HttpError(
      503,
      "retrieval_projection_failed",
      retrievalProjection.error ??
        retrievalProjectionV3.error ??
        retrievalProjectionV4.error ??
        "retrieval projection failed"
    );
  }
  const result = await suppressMemory(env, {
    tenantId,
    memoryId,
    reason: parseString(body.reason, "reason").slice(0, 500),
    actorType: actorPrincipal ? "principal" : parseOptionalActorField(body.actor_type, "actor_type", 64),
    actorId: actorPrincipal ?? parseOptionalActorField(body.actor_id, "actor_id", 128)
  });
  return {
    ...result,
    retrieval_projection: retrievalProjection,
    retrieval_projection_v3: retrievalProjectionV3,
    retrieval_projection_v4: retrievalProjectionV4
  };
}

export async function trashMemoryByRequest(env: Env, rawBody: unknown, options: PrincipalActorOptions = {}) {
  if (!rawBody || typeof rawBody !== "object") {
    throw new HttpError(400, "invalid_payload", "request body must be an object");
  }
  const body = rawBody as TrashMemoryRequest;
  const tenantId = body.tenant_id ? parseString(body.tenant_id, "tenant_id") : "default";
  const memoryId = parseString(body.memory_id, "memory_id");
  const ownership = await assertMemoryManageAccess(env, tenantId, memoryId, options);
  if (ownership.deleted_at !== null) {
    throw new HttpError(409, "memory_already_trashed", "memory is already in the trash");
  }
  const actorPrincipal = normalizeActorPrincipal(options.actorPrincipal);
  const reason = typeof body.reason === "string" && body.reason.trim()
    ? body.reason.trim().slice(0, 500)
    : "moved to trash from memory library";
  const retrievalProjectionV3 = await removeMemoryIdsFromV3SemanticIndex(env, tenantId, [memoryId]);
  const retrievalProjectionV4 = await removeMemoryIdsFromV4SemanticIndex(env, tenantId, [memoryId]);
  const retrievalProjection = await removeMemoryIdsFromSemanticIndex(env, tenantId, [memoryId]);
  if (retrievalProjection.error || retrievalProjectionV3.error || retrievalProjectionV4.error) {
    throw new HttpError(
      503,
      "retrieval_projection_failed",
      retrievalProjection.error ?? retrievalProjectionV3.error ?? retrievalProjectionV4.error ?? "retrieval projection failed"
    );
  }
  const result = await suppressMemory(env, {
    tenantId,
    memoryId,
    reason,
    actorType: actorPrincipal ? "principal" : null,
    actorId: actorPrincipal
  });
  const deletedAt = Date.now();
  await env.OPEN_BRAIN_DB.prepare(
    `UPDATE memories
     SET deleted_at = ?, deleted_by_principal = ?, delete_reason = ?, updated_at = ?
     WHERE tenant_id = ? AND id = ?`
  ).bind(deletedAt, actorPrincipal, reason, deletedAt, tenantId, memoryId).run();
  return {
    ...result,
    operation: "trash" as const,
    deleted_at: deletedAt,
    deleted_by_principal: actorPrincipal,
    delete_reason: reason,
    retrieval_projection: retrievalProjection,
    retrieval_projection_v3: retrievalProjectionV3,
    retrieval_projection_v4: retrievalProjectionV4
  };
}

export async function restoreMemoryByRequest(env: Env, rawBody: unknown, options: PrincipalActorOptions = {}) {
  if (!rawBody || typeof rawBody !== "object") {
    throw new HttpError(400, "invalid_payload", "request body must be an object");
  }
  const body = rawBody as RestoreMemoryRequest;
  const tenantId = body.tenant_id ? parseString(body.tenant_id, "tenant_id") : "default";
  const memoryId = parseString(body.memory_id, "memory_id");
  const ownership = await assertMemoryManageAccess(env, tenantId, memoryId, options);
  if (ownership.deleted_at === null) {
    throw new HttpError(409, "memory_not_in_trash", "Only a trashed memory can be restored");
  }
  const actorPrincipal = normalizeActorPrincipal(options.actorPrincipal);
  const result = await restoreSuppressedMemory(env, {
    tenantId,
    memoryId,
    actorType: actorPrincipal ? "principal" : null,
    actorId: actorPrincipal
  });
  await env.OPEN_BRAIN_DB.prepare(
    `UPDATE memories
     SET deleted_at = NULL, deleted_by_principal = NULL, delete_reason = NULL, updated_at = ?
     WHERE tenant_id = ? AND id = ?`
  ).bind(Date.now(), tenantId, memoryId).run();
  const retrievalProjections = await syncMemoryIdsToSemanticIndexes(env, tenantId, [memoryId]);
  return {
    ...result,
    operation: "restore" as const,
    lifecycle_state: "active" as const,
    ...retrievalProjections
  };
}

export async function deleteMemoryById(
  env: Env,
  tenantId: string,
  memoryId: string,
  options: PrincipalActorOptions = {}
) {
  const actorPrincipal = normalizeActorPrincipal(options.actorPrincipal);
  const normalizedTenantId = parseString(tenantId, "tenant_id");
  const normalizedMemoryId = parseString(memoryId, "memory_id");
  // The HTTP route always passes an explicit authorization result. Keep the
  // service's historical direct-call behavior for internal callers while
  // making an explicit non-admin decision authoritative at the boundary.
  const enforceTrashLifecycle = typeof options.canManageAll === "boolean";
  if (enforceTrashLifecycle && options.canManageAll !== true) {
    throw new HttpError(403, "tenant_admin_required", "Only a tenant admin can permanently delete a memory");
  }
  if (enforceTrashLifecycle) {
    const row = await env.OPEN_BRAIN_DB.prepare(
      "SELECT deleted_at FROM memories WHERE tenant_id = ? AND id = ?"
    ).bind(normalizedTenantId, normalizedMemoryId).first<{ deleted_at: number | null }>();
    if (!row) throw new HttpError(404, "memory_not_found", "memory not found");
    if (row.deleted_at === null) {
      throw new HttpError(409, "memory_must_be_trashed", "Move the memory to the trash before permanently deleting it");
    }
  }
  await assertMemoryNotOnLegalHold(env, normalizedTenantId, normalizedMemoryId);
  const retrievalProjectionV3 = await removeMemoryIdsFromV3SemanticIndex(
    env,
    normalizedTenantId,
    [normalizedMemoryId]
  );
  const retrievalProjectionV4 = await removeMemoryIdsFromV4SemanticIndex(
    env,
    normalizedTenantId,
    [normalizedMemoryId]
  );
  const retrievalProjection = await removeMemoryIdsFromSemanticIndex(
    env,
    normalizedTenantId,
    [normalizedMemoryId]
  );
  if (retrievalProjection.error || retrievalProjectionV3.error || retrievalProjectionV4.error) {
    throw new HttpError(
      503,
      "retrieval_projection_failed",
      retrievalProjection.error ??
        retrievalProjectionV3.error ??
        retrievalProjectionV4.error ??
        "retrieval projection failed"
    );
  }
  const result = await deleteMemory(env, {
    tenantId: normalizedTenantId,
    memoryId: normalizedMemoryId,
    actorType: actorPrincipal ? "principal" : null,
    actorId: actorPrincipal
  });
  return {
    ...result,
    retrieval_projection: retrievalProjection,
    retrieval_projection_v3: retrievalProjectionV3,
    retrieval_projection_v4: retrievalProjectionV4
  };
}
