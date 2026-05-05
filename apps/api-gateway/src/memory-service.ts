import {
  HttpError,
  MEMORY_KINDS,
  MEMORY_LIFECYCLE_STATES,
  MEMORY_SCOPE_TYPES,
  buildTenantMemoryProfile,
  parseTagsJson,
  searchTenantMemories,
  type MemoryProfileResponse,
  type MemoryKind,
  type MemoryLifecycleState,
  type MemoryScopeType,
  type MemorySearchResponse,
  type MemorySearchMode
} from "@org-brain/shared";
import { captureMemoryItems, loadExistingMemoryIdsByExternalKeys, refreshMemory, reviseMemory, runBatchChunks, suppressMemory } from "./memory-lifecycle-service";
import { filterMemorySearchResults, parseSearchFilters } from "./rationale-service";
import type { Env } from "./types";

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
};

type UpsertMemoryRequest = {
  tenant_id?: string;
  source?: string;
  items: UpsertMemoryItem[];
};

type MemoryRow = {
  id: string;
  project_id: string | null;
  content: string;
  summary: string | null;
  tags_json: string | null;
  source: string;
  external_key: string | null;
  created_at: number;
  kind?: string | null;
  lifecycle_state?: string | null;
  current_version?: number | null;
  last_accessed_at?: number | null;
  confidence_score?: number | null;
  utility_score?: number | null;
};

type MemorySearchRequest = {
  tenant_id?: string;
  project_id?: string | null;
  q?: string;
  limit?: number;
  rewrite_query?: boolean;
  search_mode?: MemorySearchMode;
  include_history?: boolean;
};

type MemoryProfileRequest = {
  tenant_id?: string;
  project_id?: string | null;
  q?: string;
  limit_durable?: number;
  limit_recent?: number;
  rewrite_query?: boolean;
  search_mode?: MemorySearchMode;
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

type ListMemoriesOptions = {
  limit?: number;
  offset?: number;
  source?: string;
  projectId?: string | null;
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
  if (value !== "memories" && value !== "hybrid") {
    throw new HttpError(400, "invalid_payload", `${field} must be 'memories' or 'hybrid'`);
  }
  return value;
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
      expires_at: parseOptionalFiniteNumber((item as UpsertMemoryItem).expires_at, `items[${i}].expires_at`)
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
} {
  if (!raw || typeof raw !== "object") {
    throw new HttpError(400, "invalid_payload", "request body must be an object");
  }
  const body = raw as MemorySearchRequest;
  return {
    tenantId: body.tenant_id ? parseString(body.tenant_id, "tenant_id") : "default",
    projectId: parseOptionalString(body.project_id, "project_id", 128),
    q: parseString(body.q, "q").slice(0, 500),
    limit: parseOptionalInteger(body.limit, "limit", 5, 1, 20),
    rewriteQuery: parseOptionalBoolean(body.rewrite_query, "rewrite_query", false),
    searchMode: parseMemorySearchMode(body.search_mode, "search_mode", "memories"),
    includeHistory: parseOptionalBoolean(body.include_history, "include_history", false)
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
    searchMode: parseMemorySearchMode(body.search_mode, "search_mode", "memories")
  };
}

function buildMemoryListFilterSql(options: { source?: string; projectId?: string | null }) {
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

  clauses.push("(lifecycle_state IS NULL OR lifecycle_state != ?)");
  bindings.push("suppressed");
  const sql = clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "";
  return { sql, bindings };
}

export async function upsertMemories(env: Env, rawBody: unknown) {
  const { tenantId, source, items } = parseUpsertRequest(rawBody);
  return captureMemoryItems(env, { tenantId, source, items, operation: "capture" });
}

export async function listMemories(env: Env, tenantId: string, options: ListMemoriesOptions = {}) {
  const safeLimit = Math.max(1, Math.min(500, options.limit ?? 100));
  const safeOffset = Math.max(0, options.offset ?? 0);
  const filter = buildMemoryListFilterSql({ source: options.source, projectId: options.projectId });
  const result = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, project_id, content, summary, tags_json, source, external_key, created_at
     FROM memories
     WHERE tenant_id = ?${filter.sql}
     ORDER BY created_at DESC
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
      utility_score: row.utility_score ?? null
  }));
}

export async function listMemoriesPage(env: Env, tenantId: string, options: ListMemoriesOptions = {}): Promise<MemoryListPage> {
  const safeLimit = Math.max(1, Math.min(100, options.limit ?? 24));
  const safeOffset = Math.max(0, options.offset ?? 0);
  const filter = buildMemoryListFilterSql({ source: options.source, projectId: options.projectId });
  const items = await listMemories(env, tenantId, {
    limit: safeLimit,
    offset: safeOffset,
    source: options.source,
    projectId: options.projectId
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

export async function searchMemories(env: Env, rawBody: unknown): Promise<MemorySearchResponse> {
  const request = parseSearchRequest(rawBody);
  const widenedLimit = Math.max(request.limit, 20);
  const base = await searchTenantMemories(env.OPEN_BRAIN_DB, { ...request, limit: widenedLimit });
  const filters = parseSearchFilters(rawBody);
  const allowedIds = await filterMemorySearchResults(
    env,
    request.tenantId,
    base.results.filter((item) => item.kind === "memory").map((item) => item.id),
    filters
  );
  const hasFilters = Object.values(filters).some(Boolean);
  if (!hasFilters) {
    const response = { ...base, results: base.results.slice(0, request.limit) };
    await bestEffortRefreshMemoryResults(env, request.tenantId, response.results.map((item) => item.id), "api-memory-search");
    return response;
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
  await bestEffortRefreshMemoryResults(env, request.tenantId, filteredResults.map((item) => item.id), "api-memory-search");
  return response;
}

export async function getMemoryProfile(env: Env, rawBody: unknown): Promise<MemoryProfileResponse> {
  const request = parseProfileRequest(rawBody);
  const profile = await buildTenantMemoryProfile(env.OPEN_BRAIN_DB, request);
  await bestEffortRefreshMemoryResults(
    env,
    request.tenantId,
    [
      ...profile.durable.map((item) => item.id),
      ...profile.recent.map((item) => item.id),
      ...profile.search_results.filter((item) => item.kind === "memory").map((item) => item.id)
    ],
    "api-memory-profile"
  );
  return profile;
}

async function bestEffortRefreshMemoryResults(env: Env, tenantId: string, ids: string[], actorId: string): Promise<void> {
  const uniqueMemoryIds = [...new Set(ids.filter(Boolean))].slice(0, 8);
  for (const memoryId of uniqueMemoryIds) {
    try {
      await refreshMemory(env, {
        tenantId,
        memoryId,
        actorType: "system",
        actorId
      });
    } catch {
      // Retrieval must remain best-effort; failed refreshes should not break reads.
    }
  }
}

export async function captureMemories(env: Env, rawBody: unknown) {
  if (!rawBody || typeof rawBody !== "object") {
    throw new HttpError(400, "invalid_payload", "request body must be an object");
  }
  const body = rawBody as CaptureMemoryRequest;
  const tenantId = body.tenant_id ? parseString(body.tenant_id, "tenant_id") : "default";
  const source = body.source ? parseString(body.source, "source").slice(0, 64) : "org-brain";
  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw new HttpError(400, "invalid_payload", "items must be a non-empty array");
  }
  return captureMemoryItems(env, { tenantId, source, items: body.items, operation: "capture" });
}

export async function reviseMemoryByRequest(env: Env, rawBody: unknown) {
  if (!rawBody || typeof rawBody !== "object") {
    throw new HttpError(400, "invalid_payload", "request body must be an object");
  }
  const body = rawBody as ReviseMemoryRequest;
  const tenantId = body.tenant_id ? parseString(body.tenant_id, "tenant_id") : "default";
  const memoryId = parseString(body.memory_id, "memory_id");
  return reviseMemory(env, {
    tenantId,
    memoryId,
    actorType: parseOptionalActorField(body.actor_type, "actor_type", 64),
    actorId: parseOptionalActorField(body.actor_id, "actor_id", 128),
    content: typeof body.content === "string" ? body.content.slice(0, 20_000) : undefined,
    summary: parseOptionalString(body.summary, "summary", 1000),
    tags: body.tags ? parseTags(body.tags) : undefined,
    confidenceScore: parseOptionalFiniteNumber(body.confidence_score, "confidence_score"),
    utilityScore: parseOptionalFiniteNumber(body.utility_score, "utility_score")
  });
}

export async function refreshMemoryByRequest(env: Env, rawBody: unknown) {
  if (!rawBody || typeof rawBody !== "object") {
    throw new HttpError(400, "invalid_payload", "request body must be an object");
  }
  const body = rawBody as RefreshMemoryRequest;
  const tenantId = body.tenant_id ? parseString(body.tenant_id, "tenant_id") : "default";
  return refreshMemory(env, {
    tenantId,
    memoryId: parseString(body.memory_id, "memory_id"),
    actorType: parseOptionalActorField(body.actor_type, "actor_type", 64),
    actorId: parseOptionalActorField(body.actor_id, "actor_id", 128),
    confidenceDelta: parseOptionalFiniteNumber(body.confidence_delta, "confidence_delta")
  });
}

export async function suppressMemoryByRequest(env: Env, rawBody: unknown) {
  if (!rawBody || typeof rawBody !== "object") {
    throw new HttpError(400, "invalid_payload", "request body must be an object");
  }
  const body = rawBody as SuppressMemoryRequest;
  const tenantId = body.tenant_id ? parseString(body.tenant_id, "tenant_id") : "default";
  return suppressMemory(env, {
    tenantId,
    memoryId: parseString(body.memory_id, "memory_id"),
    reason: parseString(body.reason, "reason").slice(0, 500),
    actorType: parseOptionalActorField(body.actor_type, "actor_type", 64),
    actorId: parseOptionalActorField(body.actor_id, "actor_id", 128)
  });
}
