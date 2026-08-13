import {
  HttpError,
  MEMORY_KINDS,
  MEMORY_LIFECYCLE_STATES,
  MEMORY_SCOPE_TYPES,
  buildTenantMemoryProfile,
  parseTagsJson,
  searchTenantMemories,
  searchTenantRetrievalUnitsV3,
  searchTenantRetrievalUnitsV4,
  type MemoryProfileResponse,
  type MemoryKind,
  type MemoryLifecycleState,
  type MemoryScopeType,
  type MemorySearchResponse,
  type MemorySearchMode,
  type MemorySourceReference,
  type MemoryWorkType
} from "@org-brain/shared";
import {
  captureMemoryItems,
  deleteMemory,
  loadExistingMemoryIdsByExternalKeys,
  refreshMemory,
  restoreSuppressedMemory,
  reviseMemory,
  runBatchChunks,
  suppressMemory
} from "./memory-lifecycle-service";
import { filterMemorySearchResults, parseSearchFilters } from "./rationale-service";
import {
  removeMemoryIdsFromV3SemanticIndex,
  removeMemoryIdsFromV4SemanticIndex,
  removeMemoryIdsFromSemanticIndex,
  rerankV3MemoryCandidates,
  searchRetrievalGenerationSemanticIndex,
  searchSemanticIndex,
  searchV3SemanticIndex,
  searchV4SemanticIndex,
  syncMemoryIdsToSemanticIndex,
  syncMemoryIdsToV3SemanticIndex,
  syncMemoryIdsToV4SemanticIndex
} from "./retrieval-index-service";
import { assertMemoryNotOnLegalHold } from "./retention-service";
import {
  screenMemoryCaptureText,
  screenMemoryWriteText
} from "./memory-screening-service";
import type { Env } from "./types";
import { validateBusinessClassification } from "./business-category-service";
import { recordMemoryUsage } from "./memory-effect-service";
import { resolveRetrievalGenerationAssignment } from "./retrieval-generation-service";

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

function shadowSampleRate(raw: string | undefined): number {
  if (!raw?.trim()) return 1;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : 0;
}

export function shouldRunRetrievalShadow(rawRate: string | undefined, sampleKey: string): boolean {
  const rate = shadowSampleRate(rawRate);
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  let hash = 2166136261;
  for (let index = 0; index < sampleKey.length; index += 1) {
    hash ^= sampleKey.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0x1_0000_0000 < rate;
}

export function resolveRetrievalSearchMode(
  requested: MemorySearchMode,
  env: Pick<Env,
    | "HYBRID_V3_MODE"
    | "HYBRID_V4_MODE"
    | "HYBRID_V3_CANARY_SAMPLE_RATE"
    | "HYBRID_V4_CANARY_SAMPLE_RATE">,
  sampleKey: string
): MemorySearchMode {
  if (requested !== "memories") return requested;
  if (env.HYBRID_V4_MODE === "on") return "hybrid_v4";
  if (
    env.HYBRID_V4_MODE === "canary" &&
    shouldRunRetrievalShadow(env.HYBRID_V4_CANARY_SAMPLE_RATE ?? "0.05", sampleKey)
  ) return "hybrid_v4";
  if (env.HYBRID_V3_MODE === "on") return "hybrid_v3";
  if (
    env.HYBRID_V3_MODE === "canary" &&
    shouldRunRetrievalShadow(env.HYBRID_V3_CANARY_SAMPLE_RATE ?? "0.05", sampleKey)
  ) return "hybrid_v3";
  return requested;
}

type MemoryRow = {
  id: string;
  project_id: string | null;
  content: string;
  summary: string | null;
  tags_json: string | null;
  source: string;
  external_key: string | null;
  created_at: number;
  actor_type?: string | null;
  actor_id?: string | null;
  kind?: string | null;
  lifecycle_state?: string | null;
  current_version?: number | null;
  last_accessed_at?: number | null;
  confidence_score?: number | null;
  utility_score?: number | null;
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
  reuse_rule?: string | null;
  capture_origin?: string | null;
  verification_state?: string | null;
  verified_at?: number | null;
  learning_json?: string | null;
  quality_dimensions_json?: string | null;
};

type RetrievalGenerationRow = {
  id: string;
  unit_schema_version: number;
  extractor_name: string;
  extractor_version: string;
  embedding_profile_id: string | null;
  ranking_profile_id: string;
  ranking_algorithm: string;
  ranking_config_json: string;
};

type MemorySearchRequest = {
  tenant_id?: string;
  project_id?: string | null;
  q?: string;
  limit?: number;
  rewrite_query?: boolean;
  search_mode?: MemorySearchMode;
  include_history?: boolean;
  include_suppressed?: boolean;
  at?: number;
  business_category_id?: string | null;
  work_type?: MemoryWorkType | null;
  retrieval_profile?: "default" | "lexical" | "hybrid" | "structured";
  generation_id?: string;
  ranking_profile_id?: string;
  task_id?: string | null;
  trace_id?: string | null;
  external_run_id?: string | null;
};

type MemoryProfileRequest = {
  tenant_id?: string;
  project_id?: string | null;
  q?: string;
  limit_durable?: number;
  limit_recent?: number;
  rewrite_query?: boolean;
  search_mode?: MemorySearchMode;
  business_category_id?: string | null;
  work_type?: MemoryWorkType | null;
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

type PrincipalActorOptions = {
  actorPrincipal?: string | null;
  recordUsage?: boolean;
  canManageAll?: boolean;
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

function parseString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_payload", `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new HttpError(400, "invalid_payload", `${field} must not be empty`);
  }
  return trimmed;
}

function parseOptionalString(value: unknown, field: string, maxLength = 256): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_payload", `${field} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function parseOptionalBoolean(value: unknown, field: string, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new HttpError(400, "invalid_payload", `${field} must be a boolean`);
  }
  return value;
}

function parseOptionalInteger(
  value: unknown,
  field: string,
  fallback: number,
  min: number,
  max: number
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new HttpError(400, "invalid_payload", `${field} must be an integer`);
  }
  if (value < min || value > max) {
    throw new HttpError(400, "invalid_payload", `${field} must be between ${min} and ${max}`);
  }
  return value;
}

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

function parseOptionalFiniteNumber(value: unknown, field: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpError(400, "invalid_payload", `${field} must be a finite number`);
  }
  return value;
}

function parseMemorySearchMode(value: unknown, field: string, fallback: MemorySearchMode): MemorySearchMode {
  if (value === undefined) return fallback;
  if (
    value !== "memories" &&
    value !== "hybrid" &&
    value !== "hybrid_v2" &&
    value !== "hybrid_v3" &&
    value !== "hybrid_v4"
  ) {
    throw new HttpError(
      400,
      "invalid_payload",
      `${field} must be 'memories', 'hybrid', 'hybrid_v2', 'hybrid_v3', or 'hybrid_v4'`
    );
  }
  return value;
}

function normalizeActorPrincipal(principal: string | null | undefined): string | null {
  const trimmed = principal?.trim();
  return trimmed ? trimmed.slice(0, 128) : null;
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

function parseSearchRequest(raw: unknown): {
  tenantId: string;
  projectId: string | null;
  q: string;
  limit: number;
  rewriteQuery: boolean;
  searchMode: MemorySearchMode;
  includeHistory: boolean;
  includeSuppressed: boolean;
  at: number;
  businessCategoryId: string | null;
  workType: MemoryWorkType | null;
  generationId: string | null;
  rankingProfileId: string | null;
  taskId: string | null;
  traceId: string | null;
  externalRunId: string | null;
} {
  if (!raw || typeof raw !== "object") {
    throw new HttpError(400, "invalid_payload", "request body must be an object");
  }
  const body = raw as MemorySearchRequest;
  return {
    tenantId: body.tenant_id ? parseString(body.tenant_id, "tenant_id") : "default",
    projectId: parseOptionalString(body.project_id, "project_id", 128),
    q: parseString(body.q, "q").slice(0, 500),
    limit: parseOptionalInteger(body.limit, "limit", 5, 1, 50),
    rewriteQuery: parseOptionalBoolean(body.rewrite_query, "rewrite_query", false),
    searchMode: parseMemorySearchMode(
      body.search_mode ?? ({
        default: "memories",
        lexical: "hybrid_v3",
        hybrid: "hybrid_v4",
        structured: "hybrid_v4"
      } as const)[body.retrieval_profile ?? "default"],
      "search_mode",
      "memories"
    ),
    includeHistory: parseOptionalBoolean(body.include_history, "include_history", false),
    includeSuppressed: parseOptionalBoolean(body.include_suppressed, "include_suppressed", false),
    at: parseOptionalFiniteNumber(body.at, "at") ?? Date.now(),
    businessCategoryId: parseOptionalString(body.business_category_id, "business_category_id", 128),
    workType: body.work_type ?? null,
    generationId: parseOptionalString(body.generation_id, "generation_id", 128),
    rankingProfileId: parseOptionalString(body.ranking_profile_id, "ranking_profile_id", 128),
    taskId: parseOptionalString(body.task_id, "task_id", 128),
    traceId: parseOptionalString(body.trace_id, "trace_id", 128),
    externalRunId: parseOptionalString(body.external_run_id, "external_run_id", 256)
  };
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

export function stableResultReadable(permissionsJson: string | null | undefined, principalId: string | null) {
  if (!permissionsJson) return true;
  try {
    const grants = JSON.parse(permissionsJson) as Array<{
      principal_type?: string;
      principal_id?: string;
      permissions?: string[];
    }>;
    if (!Array.isArray(grants) || grants.length === 0) return true;
    return Boolean(principalId) && grants.some((grant) =>
      grant.principal_type === "principal" &&
      grant.principal_id === principalId &&
      grant.permissions?.includes("read")
    );
  } catch {
    return false;
  }
}

function parseJsonStringArray(raw: string | null | undefined): string[] {
  try {
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
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

function parseSourceReferences(raw: string | null | undefined): MemorySourceReference[] {
  try {
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((value): value is MemorySourceReference =>
        Boolean(value) &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        typeof (value as Record<string, unknown>).type === "string" &&
        typeof (value as Record<string, unknown>).ref === "string"
      )
      : [];
  } catch {
    return [];
  }
}

async function searchStableRetrievalUnits(
  env: Env,
  request: ReturnType<typeof parseSearchRequest>,
  generation: {
    id: string;
    unit_schema_version: number;
    extractor_name: string;
    extractor_version: string;
    embedding_profile_id: string | null;
    ranking_profile_id: string;
    ranking_algorithm: string;
    ranking_config_json: string;
  },
  principalId: string | null
): Promise<MemorySearchResponse> {
  const tokens = [...new Set(request.q.toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((token) => token.trim().replaceAll('"', ""))
    .filter((token) => token.length >= 2))].slice(0, 16);
  const categorySql = request.businessCategoryId ? " AND u.business_category_id = ?" : "";
  const workSql = request.workType ? " AND u.work_type = ?" : "";
  const projectSql = request.projectId ? " AND (u.project_id = ? OR u.project_id IS NULL)" : "";
  const bindings: unknown[] = [generation.id, request.tenantId];
  type StableUnitCandidate = {
    id: string;
    source_id: string;
    unit_type: string;
    text: string;
    raw_rank: number | null;
  };
  let unitRows: StableUnitCandidate[];
  if (tokens.length) {
    const ftsQuery = tokens.map((token) => `"${token}"*`).join(" AND ");
    bindings.push(ftsQuery);
    if (request.projectId) bindings.push(request.projectId);
    if (request.businessCategoryId) bindings.push(request.businessCategoryId);
    if (request.workType) bindings.push(request.workType);
    unitRows = (await env.OPEN_BRAIN_DB.prepare(
      `SELECT u.id, u.source_id, u.unit_type, u.text, bm25(retrieval_units_fts) AS raw_rank
       FROM retrieval_units_fts
       JOIN retrieval_units u
         ON u.id = retrieval_units_fts.unit_id
        AND u.generation_id = retrieval_units_fts.generation_id
        AND u.tenant_id = retrieval_units_fts.tenant_id
       WHERE u.generation_id = ? AND u.tenant_id = ?
         AND u.source_type = 'memory' AND retrieval_units_fts MATCH ?
         ${projectSql}${categorySql}${workSql}
       ORDER BY bm25(retrieval_units_fts), u.created_at DESC
       LIMIT 200`
    ).bind(...bindings).all<StableUnitCandidate>()).results;
  } else {
    if (request.projectId) bindings.push(request.projectId);
    if (request.businessCategoryId) bindings.push(request.businessCategoryId);
    if (request.workType) bindings.push(request.workType);
    unitRows = (await env.OPEN_BRAIN_DB.prepare(
      `SELECT u.id, u.source_id, u.unit_type, u.text, NULL AS raw_rank
       FROM retrieval_units u
       WHERE u.generation_id = ? AND u.tenant_id = ? AND u.source_type = 'memory'
         ${projectSql}${categorySql}${workSql}
       ORDER BY u.created_at DESC LIMIT 200`
    ).bind(...bindings).all<StableUnitCandidate>()).results;
  }
  let rankingConfig: Record<string, unknown> = {};
  try {
    rankingConfig = JSON.parse(generation.ranking_config_json) as Record<string, unknown>;
  } catch {
    rankingConfig = {};
  }
  const rrfConstant = Number.isFinite(Number(rankingConfig.rrf_constant))
    ? Math.max(1, Number(rankingConfig.rrf_constant))
    : 60;
  const semanticWeight = Number.isFinite(Number(rankingConfig.semantic_weight))
    ? Math.max(0, Number(rankingConfig.semantic_weight))
    : 0.9;
  const rerankerWeight = Number.isFinite(Number(rankingConfig.reranker_weight))
    ? Math.max(0, Number(rankingConfig.reranker_weight))
    : 1;
  const degradedReasons: string[] = [];
  let semantic: Awaited<ReturnType<typeof searchRetrievalGenerationSemanticIndex>> = null;
  if (generation.embedding_profile_id) {
    try {
      semantic = await searchRetrievalGenerationSemanticIndex(env, generation.id, {
        tenant_id: request.tenantId,
        project_id: request.projectId,
        query: request.q,
        limit: 50
      });
      if (!semantic) degradedReasons.push("semantic_provider_unavailable");
    } catch {
      degradedReasons.push("semantic_provider_unavailable");
    }
  }
  const semanticHits = semantic?.hits ?? [];
  const semanticRows: StableUnitCandidate[] = [];
  for (let offset = 0; offset < semanticHits.length; offset += 100) {
    const chunk = semanticHits.slice(offset, offset + 100);
    if (chunk.length === 0) continue;
    const rows = (await env.OPEN_BRAIN_DB.prepare(
      `SELECT id, source_id, unit_type, text, NULL AS raw_rank
       FROM retrieval_units
       WHERE generation_id = ? AND tenant_id = ? AND id IN (${chunk.map(() => "?").join(",")})
         AND source_type = 'memory'`
    ).bind(generation.id, request.tenantId, ...chunk.map((item) => item.id)).all<StableUnitCandidate>()).results;
    semanticRows.push(...rows);
  }
  const allUnits = new Map<string, StableUnitCandidate>();
  for (const unit of [...unitRows, ...semanticRows]) allUnits.set(unit.id, unit);
  const scoreById = new Map<string, number>();
  unitRows.forEach((unit, index) => {
    const configuredWeight = Number(rankingConfig[`${unit.unit_type}_weight`]);
    const weight = Number.isFinite(configuredWeight) ? Math.max(0, configuredWeight) : 1;
    const score = generation.ranking_algorithm === "reciprocal_rank_fusion"
      ? weight / (rrfConstant + index + 1)
      : weight / (1 + Math.abs(unit.raw_rank ?? index));
    scoreById.set(unit.source_id, (scoreById.get(unit.source_id) ?? 0) + score);
  });
  semanticHits.forEach((hit, index) => {
    const unit = allUnits.get(hit.id);
    if (!unit) return;
    const configuredWeight = Number(rankingConfig[`${unit.unit_type}_weight`]);
    const channelWeight = Number.isFinite(configuredWeight) ? Math.max(0, configuredWeight) : 1;
    const score = semanticWeight * channelWeight / (rrfConstant + index + 1);
    scoreById.set(unit.source_id, (scoreById.get(unit.source_id) ?? 0) + score);
  });
  const candidateTextByMemory = new Map<string, string[]>();
  for (const unit of allUnits.values()) {
    const values = candidateTextByMemory.get(unit.source_id) ?? [];
    if (!values.includes(unit.text)) values.push(unit.text);
    candidateTextByMemory.set(unit.source_id, values.slice(0, 5));
  }
  let reranker: Awaited<ReturnType<typeof rerankV3MemoryCandidates>> = null;
  try {
    reranker = await rerankV3MemoryCandidates(env, request.q, [...candidateTextByMemory.entries()].map(([id, texts]) => ({
      id,
      text: texts.join("\n")
    })));
    if (!reranker) degradedReasons.push("reranker_unavailable");
  } catch {
    degradedReasons.push("reranker_unavailable");
  }
  [...(reranker?.scores.entries() ?? [])]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .forEach(([memoryId], index) => {
      scoreById.set(memoryId, (scoreById.get(memoryId) ?? 0) + rerankerWeight / (rrfConstant + index + 1));
    });
  const ids = [...scoreById.keys()].sort((left, right) =>
    (scoreById.get(right) ?? 0) - (scoreById.get(left) ?? 0) || left.localeCompare(right)
  );
  const memoryRows = ids.length
    ? (await env.OPEN_BRAIN_DB.prepare(
      `SELECT id, project_id, content, summary, tags_json, source, external_key,
              created_at, kind, lifecycle_state, current_version, confidence_score,
              utility_score, permissions_json, source_refs_json, conflicts_json,
              business_category_id, work_type
       FROM memories WHERE tenant_id = ? AND id IN (${ids.map(() => "?").join(",")})
         AND (lifecycle_state IS NULL OR lifecycle_state != 'suppressed')
         AND (valid_from IS NULL OR valid_from <= ?)
         AND (valid_until IS NULL OR valid_until > ?)`
    ).bind(request.tenantId, ...ids, request.at, request.at).all<MemoryRow>()).results
    : [];
  const byId = new Map(memoryRows.map((row) => [row.id, row]));
  const results = ids.flatMap((id) => {
    const row = byId.get(id);
    if (!row || !stableResultReadable(row.permissions_json, principalId)) return [];
    if (request.projectId && row.project_id !== null && row.project_id !== request.projectId) return [];
    if (request.businessCategoryId && row.business_category_id !== request.businessCategoryId) return [];
    if (request.workType && row.work_type !== request.workType) return [];
    const score = scoreById.get(id) ?? null;
    return [{
      kind: "memory" as const,
      id: row.id,
      summary: row.summary,
      content_preview: row.content.slice(0, 1000),
      score,
      source: row.source,
      created_at: row.created_at,
      memory_kind: (row.kind as MemoryKind | null) ?? "episodic",
      lifecycle_state: (row.lifecycle_state as MemoryLifecycleState | null) ?? "active",
      current_version: Number(row.current_version ?? 1),
      source_references: parseSourceReferences(row.source_refs_json),
      conflicts: parseJsonStringArray(row.conflicts_json),
      permission_decision: { allowed: true, principal_id: principalId }
    }];
  }).slice(0, request.limit);
  return {
    tenant_id: request.tenantId,
    project_id: request.projectId,
    q: request.q,
    rewrite_query: request.rewriteQuery,
    search_mode: generation.unit_schema_version === 1 ? "hybrid_v3" : "hybrid_v4",
    include_history: request.includeHistory,
    results,
    meta: {
      search_strategy: generation.unit_schema_version === 1 ? "hybrid_v3" : "hybrid_v4",
      matched_count: results.length,
      returned_count: results.length,
      fallback_used: false,
      variant_count: 1,
      lexical_result_count: results.length,
      doc_result_count: 0,
      history_result_count: 0,
      top_result_ids: results.map((item) => item.id),
      top_result_ranks: results.map((item) => item.score),
      retrieval: {
        semantic: { available: Boolean(semantic), provider: semantic?.provider ?? null },
        graph: { available: false, provider: "none" },
        degraded: degradedReasons.length > 0,
        degraded_reasons: [...new Set(degradedReasons)],
        lexical_candidate_count: unitRows.length,
        semantic_candidate_count: semanticHits.length,
        parent_candidate_count: scoreById.size,
        channel_candidate_counts: Object.fromEntries(
          ["atomic", "profile", "ledger", "timeline", "segment"].map((channel) => [
            channel,
            [...allUnits.values()].filter((unit) => unit.unit_type === channel).length
          ])
        ),
        reranker_version: reranker?.provider ?? null,
        generation_id: generation.id,
        unit_schema_version: String(generation.unit_schema_version),
        extractor_name: generation.extractor_name,
        extractor_version: generation.extractor_version,
        ranking_profile_id: request.rankingProfileId ?? generation.ranking_profile_id,
        embedding_profile_id: generation.embedding_profile_id
      }
    }
  };
}

function parseProfileRequest(raw: unknown): {
  tenantId: string;
  projectId: string | null;
  q?: string;
  limitDurable: number;
  limitRecent: number;
  rewriteQuery: boolean;
  searchMode: MemorySearchMode;
  businessCategoryId: string | null;
  workType: MemoryWorkType | null;
} {
  if (!raw || typeof raw !== "object") {
    throw new HttpError(400, "invalid_payload", "request body must be an object");
  }
  const body = raw as MemoryProfileRequest;
  const q = typeof body.q === "string" && body.q.trim() ? body.q.trim().slice(0, 500) : undefined;
  return {
    tenantId: body.tenant_id ? parseString(body.tenant_id, "tenant_id") : "default",
    projectId: parseOptionalString(body.project_id, "project_id", 128),
    q,
    limitDurable: parseOptionalInteger(body.limit_durable, "limit_durable", 8, 1, 16),
    limitRecent: parseOptionalInteger(body.limit_recent, "limit_recent", 8, 1, 16),
    rewriteQuery: parseOptionalBoolean(body.rewrite_query, "rewrite_query", false),
    searchMode: parseMemorySearchMode(body.search_mode, "search_mode", "memories"),
    businessCategoryId: parseOptionalString(body.business_category_id, "business_category_id", 128),
    workType: body.work_type ?? null
  };
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
  const retrieval_projection = await syncMemoryIdsToSemanticIndex(
    env,
    tenantId,
    result.items.map((item) => item.memory_id)
  );
  const retrieval_projection_v3 = await syncMemoryIdsToV3SemanticIndex(
    env,
    tenantId,
    result.items.map((item) => item.memory_id)
  );
  const retrieval_projection_v4 = await syncMemoryIdsToV4SemanticIndex(
    env,
    tenantId,
    result.items.map((item) => item.memory_id)
  );
  return {
    ...result,
    retrieval_projection,
    retrieval_projection_v3,
    retrieval_projection_v4,
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
            reuse_rule
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

export async function searchMemories(
  env: Env,
  rawBody: unknown,
  options: PrincipalActorOptions = {}
): Promise<MemorySearchResponse> {
  const parsedRequest = parseSearchRequest(rawBody);
  await validateBusinessClassification(
    env,
    parsedRequest.tenantId,
    parsedRequest.businessCategoryId,
    parsedRequest.workType,
    { required: false }
  );
  const explicitGenerationRequested = Boolean(parsedRequest.generationId);
  let selectedGeneration: RetrievalGenerationRow | null = null;
  let selectedAssignment: Awaited<ReturnType<typeof resolveRetrievalGenerationAssignment>> | null = null;
  if (parsedRequest.generationId) {
    const assignment = await resolveRetrievalGenerationAssignment(
      env,
      parsedRequest.tenantId,
      parsedRequest.projectId
    );
    selectedAssignment = assignment;
    if (
      parsedRequest.generationId !== assignment.active_generation_id &&
      parsedRequest.generationId !== assignment.shadow_generation_id
    ) {
      throw new HttpError(403, "generation_not_assigned", "requested generation is not assigned to tenant/project");
    }
    const generation = (await env.OPEN_BRAIN_DB.prepare(
      `SELECT g.id, g.unit_schema_version, g.extractor_name, g.extractor_version,
              g.embedding_profile_id, g.ranking_profile_id,
              r.algorithm AS ranking_algorithm, r.config_json AS ranking_config_json
       FROM retrieval_generations g
       JOIN retrieval_ranking_profiles r ON r.id = g.ranking_profile_id
       WHERE g.id = ? AND r.retired_at IS NULL`
    ).bind(parsedRequest.generationId).all<RetrievalGenerationRow>()).results[0];
    if (!generation) throw new HttpError(404, "retrieval_generation_not_found", "generation not found");
    selectedGeneration = generation;
    parsedRequest.searchMode = generation.unit_schema_version === 1 ? "hybrid_v3" : "hybrid_v4";
  } else if (env.RETRIEVAL_GENERATION_ROUTING && env.RETRIEVAL_GENERATION_ROUTING !== "legacy") {
    try {
      const assignment = await resolveRetrievalGenerationAssignment(
        env,
        parsedRequest.tenantId,
        parsedRequest.projectId
      );
      selectedAssignment = assignment;
      const generation = (await env.OPEN_BRAIN_DB.prepare(
        `SELECT g.id, g.unit_schema_version, g.extractor_name, g.extractor_version,
                g.embedding_profile_id, g.ranking_profile_id,
                r.algorithm AS ranking_algorithm, r.config_json AS ranking_config_json
         FROM retrieval_generations g
         JOIN retrieval_ranking_profiles r ON r.id = g.ranking_profile_id
         WHERE g.id = ? AND r.retired_at IS NULL`
      ).bind(assignment.active_generation_id).all<RetrievalGenerationRow>()).results[0];
      if (!generation) {
        throw new HttpError(503, "retrieval_generation_not_found", "assigned generation not found");
      }
      selectedGeneration = generation;
      parsedRequest.generationId = generation.id;
      parsedRequest.searchMode = generation.unit_schema_version === 1 ? "hybrid_v3" : "hybrid_v4";
    } catch (error) {
      if (env.RETRIEVAL_GENERATION_ROUTING === "enforce") throw error;
      // Observe mode preserves legacy search until assignments and stable projections are ready.
    }
  }
  if (parsedRequest.rankingProfileId) {
    if (!selectedGeneration) {
      const assignment = await resolveRetrievalGenerationAssignment(
        env,
        parsedRequest.tenantId,
        parsedRequest.projectId
      );
      selectedAssignment = assignment;
      selectedGeneration = (await env.OPEN_BRAIN_DB.prepare(
        `SELECT g.id, g.unit_schema_version, g.extractor_name, g.extractor_version,
                g.embedding_profile_id, g.ranking_profile_id,
                r.algorithm AS ranking_algorithm, r.config_json AS ranking_config_json
         FROM retrieval_generations g
         JOIN retrieval_ranking_profiles r ON r.id = g.ranking_profile_id
         WHERE g.id = ? AND r.retired_at IS NULL`
      ).bind(assignment.active_generation_id).all<RetrievalGenerationRow>()).results[0] ?? null;
      if (!selectedGeneration) throw new HttpError(404, "retrieval_generation_not_found", "assigned generation not found");
      parsedRequest.generationId = selectedGeneration.id;
      parsedRequest.searchMode = selectedGeneration.unit_schema_version === 1 ? "hybrid_v3" : "hybrid_v4";
    }
    const ranking = (await env.OPEN_BRAIN_DB.prepare(
      `SELECT id, algorithm, config_json FROM retrieval_ranking_profiles
       WHERE id = ? AND retired_at IS NULL`
    ).bind(parsedRequest.rankingProfileId).all<{
      id: string;
      algorithm: string;
      config_json: string;
    }>()).results[0];
    if (!ranking) throw new HttpError(404, "retrieval_ranking_profile_not_found", "ranking profile not found or retired");
    selectedGeneration = {
      ...selectedGeneration,
      ranking_profile_id: ranking.id,
      ranking_algorithm: ranking.algorithm,
      ranking_config_json: ranking.config_json
    };
  }
  const shadowSampleKey = `${parsedRequest.tenantId}\0${parsedRequest.projectId ?? ""}\0${parsedRequest.q}`;
  const request = {
    ...parsedRequest,
    searchMode: resolveRetrievalSearchMode(parsedRequest.searchMode, env, shadowSampleKey)
  };
  const attachUsage = async (response: MemorySearchResponse): Promise<MemorySearchResponse> => {
    if (options.recordUsage === false) return response;
    const queryHash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(request.q)
    ).then((digest) => [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(""));
    const usage = await recordMemoryUsage(env, {
      tenant_id: request.tenantId,
      project_id: request.projectId ?? undefined,
      task_id: request.taskId ?? undefined,
      trace_id: request.traceId ?? undefined,
      external_run_id: request.externalRunId ?? undefined,
      capability: "memory_search",
      access_path: "search",
      request_source: "api",
      query_hash: queryHash,
      requested_business_category_id: request.businessCategoryId,
      requested_work_type: request.workType,
      retrieval_generation_id: request.generationId ?? (request.searchMode === "hybrid_v3"
        ? "gen_baseline_units"
        : request.searchMode === "hybrid_v4"
          ? "gen_structured_context"
          : null),
      ranking_profile_id: request.rankingProfileId ?? "rank_default",
      actor_principal: options.actorPrincipal ?? null,
      items: response.results
        .filter((item) => item.kind === "memory")
        .map((item, index) => ({
          source_type: "memory" as const,
          source_id: item.id,
          source_version: item.current_version ?? null,
          rank: index + 1,
          score: item.score,
          reference_type: "returned" as const,
          used_state: "unknown" as const
        }))
    });
    const body = rawBody as Record<string, unknown>;
    return {
      ...response,
      meta: {
        ...response.meta,
        usage_id: usage.usage_id,
        verification_sampled: usage.verification_sampled,
        ...(["hybrid_v3", "hybrid_v4"].includes(String(body.search_mode))
          ? { deprecation_warnings: [`${String(body.search_mode)} is deprecated; use retrieval_profile`] }
          : {}),
        retrieval: {
          semantic: response.meta.retrieval?.semantic ?? { available: false, provider: null },
          graph: response.meta.retrieval?.graph ?? { available: false, provider: "none" },
          degraded: response.meta.retrieval?.degraded ?? false,
          ...response.meta.retrieval,
          generation_id: response.meta.retrieval?.generation_id ?? null,
          unit_schema_version: response.meta.retrieval?.unit_schema_version ?? null,
          extractor_name: response.meta.retrieval?.extractor_name ?? null,
          ranking_profile_id: response.meta.retrieval?.ranking_profile_id ?? null,
          embedding_profile_id: response.meta.retrieval?.embedding_profile_id ?? null
        }
      }
    };
  };
  if (selectedGeneration) {
    if (request.includeHistory || request.includeSuppressed) {
      throw new HttpError(
        400,
        "stable_generation_filter_unsupported",
        "stable generation search does not support history or suppressed records"
      );
    }
    const startedAt = performance.now();
    let response = await searchStableRetrievalUnits(
      env,
      request,
      selectedGeneration,
      normalizeActorPrincipal(options.actorPrincipal)
    );
    const stableFilters = parseSearchFilters(rawBody);
    if (Object.values(stableFilters).some(Boolean)) {
      const allowedIds = await filterMemorySearchResults(
        env,
        request.tenantId,
        response.results.map((item) => item.id),
        stableFilters
      );
      const results = response.results.filter((item) => allowedIds.has(item.id));
      response = {
        ...response,
        results,
        meta: {
          ...response.meta,
          matched_count: results.length,
          returned_count: results.length,
          top_result_ids: results.map((item) => item.id),
          top_result_ranks: results.map((item) => item.score)
        }
      };
    }
    const primaryLatency = performance.now() - startedAt;
    if (
      !explicitGenerationRequested &&
      selectedAssignment?.shadow_generation_id &&
      selectedAssignment.shadow_generation_id !== selectedGeneration.id &&
      shouldRunRetrievalShadow(String(selectedAssignment.shadow_sample_rate), shadowSampleKey)
    ) {
      const shadowStartedAt = performance.now();
      let shadow: MemorySearchResponse | null = null;
      let shadowError: string | null = null;
      try {
        const generation = (await env.OPEN_BRAIN_DB.prepare(
          `SELECT g.id, g.unit_schema_version, g.extractor_name, g.extractor_version,
                  g.embedding_profile_id, g.ranking_profile_id,
                  r.algorithm AS ranking_algorithm, r.config_json AS ranking_config_json
           FROM retrieval_generations g
           JOIN retrieval_ranking_profiles r ON r.id = g.ranking_profile_id
           WHERE g.id = ? AND r.retired_at IS NULL`
        ).bind(selectedAssignment.shadow_generation_id).all<RetrievalGenerationRow>()).results[0];
        if (!generation) throw new Error("shadow generation not found");
        shadow = await searchStableRetrievalUnits(
          env,
          { ...request, generationId: generation.id },
          generation,
          normalizeActorPrincipal(options.actorPrincipal)
        );
        if (Object.values(stableFilters).some(Boolean)) {
          const allowedIds = await filterMemorySearchResults(
            env,
            request.tenantId,
            shadow.results.map((item) => item.id),
            stableFilters
          );
          const results = shadow.results.filter((item) => allowedIds.has(item.id));
          shadow = {
            ...shadow,
            results,
            meta: {
              ...shadow.meta,
              matched_count: results.length,
              returned_count: results.length,
              top_result_ids: results.map((item) => item.id),
              top_result_ranks: results.map((item) => item.score)
            }
          };
        }
      } catch (error) {
        shadowError = error instanceof Error ? error.message.slice(0, 200) : "shadow retrieval failed";
      }
      const queryHash = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(request.q)
      ).then((digest) => [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""));
      const primaryIds = new Set(response.results.map((item) => item.id));
      const shadowIds = shadow?.results.map((item) => item.id) ?? [];
      await env.OPEN_BRAIN_DB.prepare(
        `INSERT INTO retrieval_evaluation_events(
           id, tenant_id, project_id, query_hash, baseline_generation_id,
           candidate_generation_id, baseline_result_count, candidate_result_count,
           overlap_count, baseline_empty, candidate_empty, candidate_degraded,
           baseline_latency_ms, candidate_latency_ms, evidence_tokens,
           projection_lag_ms, error_code, created_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        crypto.randomUUID(), request.tenantId, request.projectId, queryHash,
        selectedGeneration.id, selectedAssignment.shadow_generation_id,
        response.results.length, shadowIds.length,
        shadowIds.filter((id) => primaryIds.has(id)).length,
        response.results.length === 0 ? 1 : 0, shadowIds.length === 0 ? 1 : 0,
        shadow?.meta.retrieval?.degraded ? 1 : 0,
        Number(primaryLatency.toFixed(3)),
        Number((performance.now() - shadowStartedAt).toFixed(3)),
        null, shadow?.meta.retrieval?.projection_lag_ms ?? null,
        shadowError, Date.now()
      ).run().catch(() => {
        // Shadow telemetry is best-effort and never breaks active retrieval.
      });
    }
    await bestEffortMarkMemoryResultsAccessed(
      env,
      request.tenantId,
      response.results.map((item) => item.id)
    );
    return attachUsage(response);
  }
  const widenedLimit = Math.max(request.limit, 20);
  const semantic =
    request.searchMode === "hybrid_v2"
      ? await searchSemanticIndex(env, {
          tenant_id: request.tenantId,
          project_id: request.projectId,
          query: request.q,
          limit: widenedLimit
        })
      : request.searchMode === "hybrid_v3" || request.searchMode === "hybrid_v4"
        ? await (request.searchMode === "hybrid_v4"
          ? searchV4SemanticIndex
          : searchV3SemanticIndex)(env, {
            tenant_id: request.tenantId,
            project_id: request.projectId,
            query: request.q,
            limit: 50
          })
        : null;
  const principalId = normalizeActorPrincipal(options.actorPrincipal);
  let base: MemorySearchResponse;
  if (request.searchMode === "hybrid_v3" || request.searchMode === "hybrid_v4") {
    const preliminary = await searchTenantRetrievalUnitsV3(env.OPEN_BRAIN_DB, {
      ...request,
      limit: 20,
      principalId,
      semanticHits: semantic?.hits,
      semanticProvider: semantic?.provider
    });
    let rerankerCandidates: Array<{ id: string; text: string }> = [];
    if (preliminary.results.length > 0) {
      const ids = preliminary.results.map((result) => result.id);
      const placeholders = ids.map(() => "?").join(",");
      const rows = await env.OPEN_BRAIN_DB.prepare(
        `SELECT id, content, summary FROM memories
         WHERE tenant_id = ? AND id IN (${placeholders})`
      ).bind(request.tenantId, ...ids).all<{ id: string; content: string; summary: string | null }>();
      const rowById = new Map(rows.results.map((row) => [row.id, row]));
      rerankerCandidates = ids.flatMap((id) => {
        const row = rowById.get(id);
        return row ? [{ id, text: `${row.summary ?? ""}\n${row.content}`.trim() }] : [];
      });
    }
    let reranker: Awaited<ReturnType<typeof rerankV3MemoryCandidates>> = null;
    try {
      reranker = await rerankV3MemoryCandidates(env, request.q, rerankerCandidates);
    } catch {
      reranker = null;
    }
    const searchUnits =
      request.searchMode === "hybrid_v4"
        ? searchTenantRetrievalUnitsV4
        : searchTenantRetrievalUnitsV3;
    base = await searchUnits(env.OPEN_BRAIN_DB, {
      ...request,
      limit: widenedLimit,
      principalId,
      semanticHits: semantic?.hits,
      semanticProvider: semantic?.provider,
      rerankerScores: reranker?.scores,
      rerankerProvider: reranker?.provider
    });
  } else {
    base = await searchTenantMemories(env.OPEN_BRAIN_DB, {
      ...request,
      limit: widenedLimit,
      principalId,
      semanticHits: semantic?.hits,
      semanticProvider: semantic?.provider
    });
  }
  if (
    env.HYBRID_V3_MODE === "shadow" &&
    request.searchMode !== "hybrid_v3" &&
    shouldRunRetrievalShadow(env.HYBRID_V3_SHADOW_SAMPLE_RATE, shadowSampleKey)
  ) {
    const shadowStartedAt = performance.now();
    let shadowError: string | null = null;
    let shadow: MemorySearchResponse | null = null;
    try {
      const shadowSemantic = await searchV3SemanticIndex(env, {
        tenant_id: request.tenantId,
        project_id: request.projectId,
        query: request.q,
        limit: 50
      });
      shadow = await searchTenantRetrievalUnitsV3(env.OPEN_BRAIN_DB, {
        ...request,
        searchMode: "hybrid_v3",
        limit: request.limit,
        principalId,
        semanticHits: shadowSemantic?.hits,
        semanticProvider: shadowSemantic?.provider
      });
    } catch (error) {
      shadowError = error instanceof Error ? error.message.slice(0, 500) : "shadow retrieval failed";
    }
    const legacyIds = new Set(base.results.map((result) => result.id));
    const shadowIds = shadow?.results.map((result) => result.id) ?? [];
    const queryHash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(request.q)
    ).then((digest) =>
      [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
    );
    await env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO retrieval_v3_shadow_events(
         id, tenant_id, project_id, query_hash, legacy_result_count,
         v3_result_count, overlap_count, empty, degraded, latency_ms, error, created_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      crypto.randomUUID(),
      request.tenantId,
      request.projectId,
      queryHash,
      base.results.length,
      shadowIds.length,
      shadowIds.filter((id) => legacyIds.has(id)).length,
      shadowIds.length === 0 ? 1 : 0,
      shadow?.meta.retrieval?.degraded ? 1 : 0,
      Number((performance.now() - shadowStartedAt).toFixed(3)),
      shadowError,
      Date.now()
    ).run().catch(() => {
      // Shadow observability must never break the primary retrieval response.
    });
  }
  if (
    env.HYBRID_V4_MODE === "shadow" &&
    request.searchMode !== "hybrid_v4" &&
    shouldRunRetrievalShadow(env.HYBRID_V4_SHADOW_SAMPLE_RATE, shadowSampleKey)
  ) {
    const shadowStartedAt = performance.now();
    let shadowError: string | null = null;
    let shadow: MemorySearchResponse | null = null;
    try {
      const shadowSemantic = await searchV4SemanticIndex(env, {
        tenant_id: request.tenantId,
        project_id: request.projectId,
        query: request.q,
        limit: 50
      });
      shadow = await searchTenantRetrievalUnitsV4(env.OPEN_BRAIN_DB, {
        ...request,
        searchMode: "hybrid_v4",
        limit: request.limit,
        principalId,
        semanticHits: shadowSemantic?.hits,
        semanticProvider: shadowSemantic?.provider
      });
    } catch (error) {
      shadowError = error instanceof Error ? error.message.slice(0, 500) : "v4 shadow retrieval failed";
    }
    const v3Ids = new Set(base.results.map((result) => result.id));
    const v4Ids = shadow?.results.map((result) => result.id) ?? [];
    const queryHash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(request.q)
    ).then((digest) =>
      [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
    );
    await env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO retrieval_v4_shadow_events(
         id, tenant_id, project_id, query_hash, v3_result_count, v4_result_count,
         overlap_count, empty, degraded, evidence_tokens, projection_lag_ms,
         latency_ms, error, created_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      crypto.randomUUID(),
      request.tenantId,
      request.projectId,
      queryHash,
      base.results.length,
      v4Ids.length,
      v4Ids.filter((id) => v3Ids.has(id)).length,
      v4Ids.length === 0 ? 1 : 0,
      shadow?.meta.retrieval?.degraded ? 1 : 0,
      null,
      shadow?.meta.retrieval?.projection_lag_ms ?? null,
      Number((performance.now() - shadowStartedAt).toFixed(3)),
      shadowError,
      Date.now()
    ).run().catch(() => {
      // Shadow observability must never break the primary retrieval response.
    });
  }
  if (request.businessCategoryId || request.workType) {
    const memoryIds = base.results.filter((item) => item.kind === "memory").map((item) => item.id);
    const allowed = new Set<string>();
    if (memoryIds.length) {
      const clauses = ["tenant_id = ?", `id IN (${memoryIds.map(() => "?").join(",")})`];
      const bindings: unknown[] = [request.tenantId, ...memoryIds];
      if (request.businessCategoryId) {
        clauses.push("business_category_id = ?");
        bindings.push(request.businessCategoryId);
      }
      if (request.workType) {
        clauses.push("work_type = ?");
        bindings.push(request.workType);
      }
      const rows = await env.OPEN_BRAIN_DB.prepare(
        `SELECT id FROM memories WHERE ${clauses.join(" AND ")}`
      ).bind(...bindings).all<{ id: string }>();
      for (const row of rows.results) allowed.add(row.id);
    }
    base = { ...base, results: base.results.filter((item) => item.kind === "memory" && allowed.has(item.id)) };
  }
  const filters = parseSearchFilters(rawBody);
  const allowedIds = await filterMemorySearchResults(
    env,
    request.tenantId,
    base.results.filter((item) => item.kind === "memory").map((item) => item.id),
    filters
  );
  const hasFilters = Object.values(filters).some(Boolean);
  if (!hasFilters) {
    const results = base.results.slice(0, request.limit);
    const response = {
      ...base,
      results,
      meta: {
        ...base.meta,
        returned_count: results.length,
        top_result_ids: results.map((item) => item.id),
        top_result_ranks: results.map((item) => item.score)
      }
    };
    await bestEffortMarkMemoryResultsAccessed(env, request.tenantId, response.results.map((item) => item.id));
    return attachUsage(response);
  }

  const filteredResults = base.results.filter((item) => item.kind !== "memory" || allowedIds.has(item.id)).slice(0, request.limit);
  const response = {
    ...base,
    results: filteredResults,
    meta: {
      ...base.meta,
      matched_count: filteredResults.length,
      returned_count: filteredResults.length,
      top_result_ids: filteredResults.map((item) => item.id),
      top_result_ranks: filteredResults.map((item) => item.score)
    }
  };
  await bestEffortMarkMemoryResultsAccessed(env, request.tenantId, filteredResults.map((item) => item.id));
  return attachUsage(response);
}

export async function retrieveMemoryContext(
  env: Env,
  rawBody: unknown,
  options: PrincipalActorOptions = {}
) {
  if (!rawBody || typeof rawBody !== "object") {
    throw new HttpError(400, "invalid_payload", "request body must be an object");
  }
  const body = rawBody as Record<string, unknown>;
  const tenantId = body.tenant_id ? parseString(body.tenant_id, "tenant_id") : "default";
  const topK = parseOptionalInteger(body.top_k, "top_k", 5, 1, 50);
  const tokenBudget = parseOptionalInteger(body.token_budget, "token_budget", 8_000, 512, 16_000);
  const queryAt =
    typeof body.at === "number" && Number.isFinite(body.at)
      ? body.at
      : Date.now();
  const search = await searchMemories(
    env,
    {
      ...body,
      tenant_id: tenantId,
      limit: Math.max(topK, Number(body.limit) || 50),
      search_mode: body.search_mode ?? "hybrid_v4"
    },
    { ...options, recordUsage: false }
  );
  const selected = search.results.filter((result) => result.kind === "memory").slice(0, topK);
  const ids = selected.map((result) => result.id);
  const selectedGenerationId = search.meta.retrieval?.generation_id ?? null;
  const unitRows = ids.length === 0
    ? { results: [] as Array<{
        memory_id: string;
        unit_type: string;
        speaker: string | null;
        text: string;
        event_at: number | null;
        source_ref_json: string | null;
        source_span_start: number | null;
        source_span_end: number | null;
        metadata_json: string;
        extraction_state: string;
      }> }
    : selectedGenerationId
      ? await env.OPEN_BRAIN_DB.prepare(
        `SELECT source_id AS memory_id, unit_type, speaker, text, event_at,
                source_ref_json, source_span_start, source_span_end,
                metadata_json, extraction_state
         FROM retrieval_units
         WHERE generation_id = ? AND tenant_id = ? AND source_type = 'memory'
           AND source_id IN (${ids.map(() => "?").join(",")})
         ORDER BY source_id,
           CASE unit_type
             WHEN 'atomic' THEN 0 WHEN 'profile' THEN 1 WHEN 'timeline' THEN 2
             WHEN 'ledger' THEN 3 ELSE 4
           END,
           event_at DESC`
      ).bind(selectedGenerationId, tenantId, ...ids).all<{
        memory_id: string;
        unit_type: string;
        speaker: string | null;
        text: string;
        event_at: number | null;
        source_ref_json: string | null;
        source_span_start: number | null;
        source_span_end: number | null;
        metadata_json: string;
        extraction_state: string;
      }>()
      : await env.OPEN_BRAIN_DB.prepare(
        `SELECT memory_id, unit_type, speaker, text, event_at, source_ref_json,
                source_span_start, source_span_end, metadata_json, extraction_state
         FROM memory_retrieval_units_v4
         WHERE tenant_id = ? AND memory_id IN (${ids.map(() => "?").join(",")})
         ORDER BY memory_id,
           CASE unit_type
             WHEN 'atomic' THEN 0 WHEN 'profile' THEN 1 WHEN 'timeline' THEN 2
             WHEN 'ledger' THEN 3 ELSE 4
           END,
           event_at DESC`
      ).bind(tenantId, ...ids).all<{
        memory_id: string;
        unit_type: string;
        speaker: string | null;
        text: string;
        event_at: number | null;
        source_ref_json: string | null;
        source_span_start: number | null;
        source_span_end: number | null;
        metadata_json: string;
        extraction_state: string;
      }>();
  const grouped = new Map<string, typeof unitRows.results>();
  for (const unit of unitRows.results) {
    const rows = grouped.get(unit.memory_id) ?? [];
    if (rows.length < 8) rows.push(unit);
    grouped.set(unit.memory_id, rows);
  }
  const versionRows = ids.length === 0
    ? { results: [] as Array<{ memory_id: string; version: number; snapshot_json: string }> }
    : await env.OPEN_BRAIN_DB.prepare(
        `SELECT memory_id, version, snapshot_json
         FROM memory_versions
         WHERE tenant_id = ? AND memory_id IN (${ids.map(() => "?").join(",")})
         ORDER BY memory_id, version DESC`
      ).bind(tenantId, ...ids).all<{
        memory_id: string;
        version: number;
        snapshot_json: string;
      }>();
  const previousValues = new Map<string, string[]>();
  for (const version of versionRows.results) {
    const values = previousValues.get(version.memory_id) ?? [];
    if (values.length >= 3) continue;
    try {
      const snapshot = JSON.parse(version.snapshot_json) as { content?: unknown };
      if (typeof snapshot.content === "string" && snapshot.content.trim()) {
        values.push(snapshot.content);
        previousValues.set(version.memory_id, values);
      }
    } catch {
      // Version snapshots are canonical but may predate the current JSON shape.
    }
  }
  const charBudget = tokenBudget * 4;
  let usedChars = 0;
  const evidence: Array<Record<string, unknown>> = [];
  const currentState: Array<Record<string, unknown>> = [];
  const timeline: Array<Record<string, unknown>> = [];
  const conflicts: Array<{ memory_id: string; conflict: string }> = [];
  for (const result of selected) {
    if (usedChars >= charBudget) break;
    const units = grouped.get(result.id) ?? [];
    const unit = units[0];
    const remaining = charBudget - usedChars;
    const text = String(unit?.text ?? result.content_preview).slice(0, Math.min(4_000, remaining));
    usedChars += text.length;
    let sourceReference = result.source_references?.[0] ?? null;
    try {
      sourceReference = unit?.source_ref_json ? JSON.parse(unit.source_ref_json) : sourceReference;
    } catch {
      // Keep canonical response provenance if a rebuildable projection is malformed.
    }
    evidence.push({
      memory_id: result.id,
      text,
      speaker: unit?.speaker ?? null,
      session_date: unit?.event_at ?? sourceReference?.captured_at ?? result.created_at,
      source_reference: sourceReference,
      source_span: {
        start: unit?.source_span_start ?? null,
        end: unit?.source_span_end ?? null
      },
      score: result.score,
      extraction_state: unit?.extraction_state ?? "degraded"
    });
    for (const candidate of units) {
      let metadata: Record<string, unknown> = {};
      try {
        metadata = JSON.parse(candidate.metadata_json || "{}") as Record<string, unknown>;
      } catch {
        metadata = {};
      }
      if (candidate.unit_type === "profile" || candidate.unit_type === "ledger") {
        currentState.push({
          memory_id: result.id,
          current: candidate.text,
          previous_values: (previousValues.get(result.id) ?? []).slice(1),
          ...metadata
        });
      }
      if (candidate.unit_type === "timeline") {
        timeline.push({
          memory_id: result.id,
          event_at: candidate.event_at,
          delta_from_question_ms: candidate.event_at === null ? null : queryAt - candidate.event_at,
          ...metadata
        });
      }
    }
    for (const conflict of result.conflicts ?? []) conflicts.push({ memory_id: result.id, conflict });
  }
  const query = parseString(body.q, "q");
  const multiSession = /\b(?:and|compare|both|between|combined|together|how many)\b|(?:かつ|両方|比較|合計|複数)/iu.test(query);
  const missingEvidence: string[] = [];
  if (evidence.length === 0) missingEvidence.push("no_relevant_evidence");
  if (
    multiSession &&
    new Set(evidence.map((item) =>
      (item.source_reference as { ref?: string } | null)?.ref ?? String(item.memory_id)
    )).size < 2
  ) {
    missingEvidence.push("insufficient_independent_sessions");
  }
  if (evidence.some((item) => item.extraction_state !== "ready")) {
    missingEvidence.push("structured_extractor_degraded");
  }
  const answerTemplate =
    missingEvidence.length > 0 || conflicts.length > 0
      ? "abstention"
      : timeline.length > 0
        ? "timeline"
        : currentState.length > 0
          ? "profile"
          : multiSession
            ? "multi_session"
            : "evidence";
  const contextUsage = await recordMemoryUsage(env, {
    tenant_id: tenantId,
    project_id: typeof body.project_id === "string" ? body.project_id : null,
    capability: "memory_retrieve_context",
    access_path: "context",
    request_source: "api",
    requested_business_category_id: typeof body.business_category_id === "string"
      ? body.business_category_id
      : null,
    requested_work_type: typeof body.work_type === "string"
      ? body.work_type as MemoryWorkType
      : null,
    retrieval_generation_id: selectedGenerationId,
    ranking_profile_id: search.meta.retrieval?.ranking_profile_id ?? null,
    actor_principal: options.actorPrincipal ?? null,
    items: evidence.map((item, index) => ({
      source_type: "memory" as const,
      source_id: String(item.memory_id),
      rank: index + 1,
      score: typeof item.score === "number" ? item.score : null,
      reference_type: "injected" as const,
      used_state: "unknown" as const,
      injected_token_estimate: Math.ceil(String(item.text ?? "").length / 4)
    }))
  });
  return {
    ...search,
    meta: {
      ...search.meta,
      usage_id: contextUsage.usage_id,
      verification_sampled: contextUsage.verification_sampled
    },
    evidence_bundle: {
      query_at: queryAt,
      token_budget: tokenBudget,
      estimated_tokens: Math.ceil(usedChars / 4),
      answer_template: answerTemplate,
      evidence,
      current_state: currentState,
      timeline,
      conflicts,
      missing_evidence: missingEvidence,
      abstention_recommended: missingEvidence.length > 0 || conflicts.length > 0,
      degraded_reasons: [
        ...(search.meta.retrieval?.degraded_reasons ?? []),
        ...(evidence.some((item) => item.extraction_state !== "ready")
          ? ["gemini_structured_extractor_not_configured"]
          : [])
      ]
    }
  };
}

export async function getMemoryProfile(
  env: Env,
  rawBody: unknown,
  options: PrincipalActorOptions = {}
): Promise<MemoryProfileResponse> {
  const request = parseProfileRequest(rawBody);
  await validateBusinessClassification(env, request.tenantId, request.businessCategoryId, request.workType, { required: false });
  let profile = await buildTenantMemoryProfile(env.OPEN_BRAIN_DB, request);
  if (request.businessCategoryId || request.workType) {
    const ids = [...new Set([
      ...profile.durable.map((item) => item.id),
      ...profile.recent.map((item) => item.id),
      ...profile.search_results.filter((item) => item.kind === "memory").map((item) => item.id)
    ])];
    const allowed = new Set<string>();
    if (ids.length) {
      const clauses = ["tenant_id = ?", `id IN (${ids.map(() => "?").join(",")})`];
      const bindings: unknown[] = [request.tenantId, ...ids];
      if (request.businessCategoryId) {
        clauses.push("business_category_id = ?");
        bindings.push(request.businessCategoryId);
      }
      if (request.workType) {
        clauses.push("work_type = ?");
        bindings.push(request.workType);
      }
      const rows = await env.OPEN_BRAIN_DB.prepare(
        `SELECT id FROM memories WHERE ${clauses.join(" AND ")}`
      ).bind(...bindings).all<{ id: string }>();
      for (const row of rows.results) allowed.add(row.id);
    }
    profile = {
      ...profile,
      durable: profile.durable.filter((item) => allowed.has(item.id)),
      recent: profile.recent.filter((item) => allowed.has(item.id)),
      search_results: profile.search_results.filter((item) => item.kind === "memory" && allowed.has(item.id))
    };
  }
  await bestEffortMarkMemoryResultsAccessed(
    env,
    request.tenantId,
    [
      ...profile.durable.map((item) => item.id),
      ...profile.recent.map((item) => item.id),
      ...profile.search_results.filter((item) => item.kind === "memory").map((item) => item.id)
    ]
  );
  const ids = [...new Set([
    ...profile.durable.map((item) => item.id),
    ...profile.recent.map((item) => item.id),
    ...profile.search_results.filter((item) => item.kind === "memory").map((item) => item.id)
  ])];
  const usage = await recordMemoryUsage(env, {
    tenant_id: request.tenantId,
    project_id: request.projectId,
    capability: "memory_profile",
    access_path: "profile",
    request_source: "api",
    requested_business_category_id: request.businessCategoryId,
    requested_work_type: request.workType,
    actor_principal: options.actorPrincipal ?? null,
    items: ids.map((id, index) => ({
      source_type: "memory" as const,
      source_id: id,
      rank: index + 1,
      reference_type: "returned" as const,
      used_state: "unknown" as const
    }))
  });
  return {
    ...profile,
    meta: {
      ...profile.meta,
      usage_id: usage.usage_id,
      verification_sampled: usage.verification_sampled
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
            reuse_rule, capture_origin, verification_state, verified_at, learning_json, quality_dimensions_json
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

  const usage = memory ? await recordMemoryUsage(env, {
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

async function bestEffortMarkMemoryResultsAccessed(env: Env, tenantId: string, ids: string[]): Promise<void> {
  const uniqueMemoryIds = [...new Set(ids.filter(Boolean))].slice(0, 8);
  const accessedAt = Date.now();
  for (const memoryId of uniqueMemoryIds) {
    try {
      await env.OPEN_BRAIN_DB.prepare(
        `UPDATE memories
         SET last_accessed_at = ?
         WHERE tenant_id = ? AND id = ?`
      ).bind(accessedAt, tenantId, memoryId).run();
    } catch {
      // Retrieval access telemetry is best-effort and must not break reads.
    }
  }
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
  const retrieval_projection = await syncMemoryIdsToSemanticIndex(
    env,
    tenantId,
    result.items.map((item) => item.memory_id)
  );
  const retrieval_projection_v3 = await syncMemoryIdsToV3SemanticIndex(
    env,
    tenantId,
    result.items.map((item) => item.memory_id)
  );
  const retrieval_projection_v4 = await syncMemoryIdsToV4SemanticIndex(
    env,
    tenantId,
    result.items.map((item) => item.memory_id)
  );
  return {
    ...result,
    retrieval_projection,
    retrieval_projection_v3,
    retrieval_projection_v4,
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
    retrieval_projection: await syncMemoryIdsToSemanticIndex(env, tenantId, [memoryId]),
    retrieval_projection_v3: await syncMemoryIdsToV3SemanticIndex(env, tenantId, [memoryId]),
    retrieval_projection_v4: await syncMemoryIdsToV4SemanticIndex(env, tenantId, [memoryId]),
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
  const retrievalProjection = await syncMemoryIdsToSemanticIndex(env, tenantId, [memoryId]);
  const retrievalProjectionV3 = await syncMemoryIdsToV3SemanticIndex(env, tenantId, [memoryId]);
  const retrievalProjectionV4 = await syncMemoryIdsToV4SemanticIndex(env, tenantId, [memoryId]);
  return {
    ...result,
    operation: "restore" as const,
    lifecycle_state: "active" as const,
    retrieval_projection: retrievalProjection,
    retrieval_projection_v3: retrievalProjectionV3,
    retrieval_projection_v4: retrievalProjectionV4
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
