import {
  HttpError,
  MEMORY_KINDS,
  MEMORY_LIFECYCLE_STATES,
  MEMORY_SCOPE_TYPES,
  buildTenantMemoryProfile,
  parseTagsJson,
  searchTenantMemories,
  searchTenantRetrievalUnitsV3,
  type MemoryProfileResponse,
  type MemoryKind,
  type MemoryLifecycleState,
  type MemoryScopeType,
  type MemorySearchResponse,
  type MemorySearchMode
} from "@org-brain/shared";
import {
  captureMemoryItems,
  deleteMemory,
  loadExistingMemoryIdsByExternalKeys,
  refreshMemory,
  reviseMemory,
  runBatchChunks,
  suppressMemory
} from "./memory-lifecycle-service";
import { filterMemorySearchResults, parseSearchFilters } from "./rationale-service";
import {
  removeMemoryIdsFromV3SemanticIndex,
  removeMemoryIdsFromSemanticIndex,
  rerankV3MemoryCandidates,
  searchSemanticIndex,
  searchV3SemanticIndex,
  syncMemoryIdsToSemanticIndex,
  syncMemoryIdsToV3SemanticIndex
} from "./retrieval-index-service";
import { assertMemoryNotOnLegalHold } from "./retention-service";
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
  entities?: string[];
  source_references?: Array<Record<string, unknown>>;
  valid_from?: number | null;
  valid_until?: number | null;
  rationale?: string | null;
  evidence?: Array<Record<string, unknown>>;
  conflicts?: string[];
  permissions?: Array<Record<string, unknown>>;
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
  entities?: string[];
  source_references?: Array<Record<string, unknown>>;
  valid_from?: number | null;
  valid_until?: number | null;
  rationale?: string | null;
  evidence?: Array<Record<string, unknown>>;
  conflicts?: string[];
  permissions?: Array<Record<string, unknown>>;
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

type PrincipalActorOptions = {
  actorPrincipal?: string | null;
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

export type MemoryDetail = {
  tenant_id: string;
  memory_id: string;
  memory: {
    actor_type: string | null;
    actor_id: string | null;
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
    }>;
  }>;
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
  if (value !== "memories" && value !== "hybrid" && value !== "hybrid_v2" && value !== "hybrid_v3") {
    throw new HttpError(
      400,
      "invalid_payload",
      `${field} must be 'memories', 'hybrid', 'hybrid_v2', or 'hybrid_v3'`
    );
  }
  return value;
}

function normalizeActorPrincipal(principal: string | null | undefined): string | null {
  const trimmed = principal?.trim();
  return trimmed ? trimmed.slice(0, 128) : null;
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
      evidence: parseObjectArray((item as UpsertMemoryItem).evidence, `items[${i}].evidence`),
      conflicts: parseTags((item as UpsertMemoryItem).conflicts),
      permissions: parseObjectArray((item as UpsertMemoryItem).permissions, `items[${i}].permissions`)
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

export async function upsertMemories(env: Env, rawBody: unknown, options: PrincipalActorOptions = {}) {
  const { tenantId, source, items } = parseUpsertRequest(withPrincipalActor(rawBody, options.actorPrincipal));
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
  if (previousV3Projection.error) {
    throw new HttpError(503, "retrieval_projection_failed", previousV3Projection.error);
  }
  const result = await captureMemoryItems(env, { tenantId, source, items, operation: "capture" });
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
  return { ...result, retrieval_projection, retrieval_projection_v3 };
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

export async function searchMemories(
  env: Env,
  rawBody: unknown,
  options: PrincipalActorOptions = {}
): Promise<MemorySearchResponse> {
  const request = parseSearchRequest(rawBody);
  const widenedLimit = Math.max(request.limit, 20);
  const semantic =
    request.searchMode === "hybrid_v2"
      ? await searchSemanticIndex(env, {
          tenant_id: request.tenantId,
          project_id: request.projectId,
          query: request.q,
          limit: widenedLimit
        })
      : request.searchMode === "hybrid_v3"
        ? await searchV3SemanticIndex(env, {
            tenant_id: request.tenantId,
            project_id: request.projectId,
            query: request.q,
            limit: 50
          })
        : null;
  const principalId = normalizeActorPrincipal(options.actorPrincipal);
  let base: MemorySearchResponse;
  if (request.searchMode === "hybrid_v3") {
    const preliminary = await searchTenantRetrievalUnitsV3(env.OPEN_BRAIN_DB, {
      ...request,
      limit: 20,
      principalId,
      semanticHits: semantic?.hits,
      semanticProvider: semantic?.provider
    });
    let reranker: Awaited<ReturnType<typeof rerankV3MemoryCandidates>> = null;
    if (preliminary.results.length > 0) {
      const ids = preliminary.results.map((result) => result.id);
      const placeholders = ids.map(() => "?").join(",");
      const rows = await env.OPEN_BRAIN_DB.prepare(
        `SELECT id, content, summary FROM memories
         WHERE tenant_id = ? AND id IN (${placeholders})`
      ).bind(request.tenantId, ...ids).all<{ id: string; content: string; summary: string | null }>();
      const rowById = new Map(rows.results.map((row) => [row.id, row]));
      try {
        reranker = await rerankV3MemoryCandidates(
          env,
          request.q,
          ids.flatMap((id) => {
            const row = rowById.get(id);
            return row ? [{ id, text: `${row.summary ?? ""}\n${row.content}`.trim() }] : [];
          })
        );
      } catch {
        reranker = null;
      }
    }
    base = await searchTenantRetrievalUnitsV3(env.OPEN_BRAIN_DB, {
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
  if (env.HYBRID_V3_MODE === "shadow" && request.searchMode !== "hybrid_v3") {
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

export async function getMemoryDetails(env: Env, tenantId: string, memoryId: string): Promise<MemoryDetail> {
  const memory = await env.OPEN_BRAIN_DB.prepare(
    `SELECT actor_type, actor_id
     FROM memories
     WHERE tenant_id = ? AND id = ?`
  )
    .bind(tenantId, memoryId)
    .first<{ actor_type: string | null; actor_id: string | null }>();

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
      `SELECT id, rationale_id, evidence_type, evidence_ref, relation, note, weight_score
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
      }>();
    for (const row of evidenceRows.results) {
      const list = evidenceByRationale.get(row.rationale_id) ?? [];
      list.push({
        id: row.id,
        evidence_type: row.evidence_type,
        evidence_ref: row.evidence_ref,
        relation: row.relation,
        note: row.note,
        weight_score: row.weight_score
      });
      evidenceByRationale.set(row.rationale_id, list);
    }
  }

  return {
    tenant_id: tenantId,
    memory_id: memoryId,
    memory: memory
      ? {
          actor_type: memory.actor_type,
          actor_id: memory.actor_id
        }
      : null,
    versions: versions.results,
    rationales: rationaleRows.results.map((row) => ({
      ...row,
      evidence: evidenceByRationale.get(row.id) ?? []
    }))
  };
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
  if (previousV3Projection.error) {
    throw new HttpError(503, "retrieval_projection_failed", previousV3Projection.error);
  }
  const result = await captureMemoryItems(env, { tenantId, source, items: body.items, operation: "capture" });
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
  return { ...result, retrieval_projection, retrieval_projection_v3 };
}

export async function reviseMemoryByRequest(env: Env, rawBody: unknown, options: PrincipalActorOptions = {}) {
  if (!rawBody || typeof rawBody !== "object") {
    throw new HttpError(400, "invalid_payload", "request body must be an object");
  }
  const body = rawBody as ReviseMemoryRequest;
  const tenantId = body.tenant_id ? parseString(body.tenant_id, "tenant_id") : "default";
  const memoryId = parseString(body.memory_id, "memory_id");
  const actorPrincipal = normalizeActorPrincipal(options.actorPrincipal);
  const previousV3Projection = await removeMemoryIdsFromV3SemanticIndex(env, tenantId, [memoryId]);
  if (previousV3Projection.error) {
    throw new HttpError(503, "retrieval_projection_failed", previousV3Projection.error);
  }
  const result = await reviseMemory(env, {
    tenantId,
    memoryId,
    actorType: actorPrincipal ? "principal" : parseOptionalActorField(body.actor_type, "actor_type", 64),
    actorId: actorPrincipal ?? parseOptionalActorField(body.actor_id, "actor_id", 128),
    content: typeof body.content === "string" ? body.content.slice(0, 20_000) : undefined,
    summary: parseOptionalString(body.summary, "summary", 1000),
    tags: body.tags ? parseTags(body.tags) : undefined,
    confidenceScore: parseOptionalFiniteNumber(body.confidence_score, "confidence_score"),
    utilityScore: parseOptionalFiniteNumber(body.utility_score, "utility_score"),
    entities: body.entities ? parseTags(body.entities) : undefined,
    sourceReferences: body.source_references
      ? parseObjectArray(body.source_references, "source_references")
      : undefined,
    validFrom: parseOptionalFiniteNumber(body.valid_from, "valid_from"),
    validUntil: parseOptionalFiniteNumber(body.valid_until, "valid_until"),
    rationale: parseOptionalString(body.rationale, "rationale", 4000),
    evidence: body.evidence ? parseObjectArray(body.evidence, "evidence") : undefined,
    conflicts: body.conflicts ? parseTags(body.conflicts) : undefined,
    permissions: body.permissions ? parseObjectArray(body.permissions, "permissions") : undefined
  });
  return {
    ...result,
    retrieval_projection: await syncMemoryIdsToSemanticIndex(env, tenantId, [memoryId]),
    retrieval_projection_v3: await syncMemoryIdsToV3SemanticIndex(env, tenantId, [memoryId])
  };
}

export async function refreshMemoryByRequest(env: Env, rawBody: unknown, options: PrincipalActorOptions = {}) {
  if (!rawBody || typeof rawBody !== "object") {
    throw new HttpError(400, "invalid_payload", "request body must be an object");
  }
  const body = rawBody as RefreshMemoryRequest;
  const tenantId = body.tenant_id ? parseString(body.tenant_id, "tenant_id") : "default";
  const actorPrincipal = normalizeActorPrincipal(options.actorPrincipal);
  return refreshMemory(env, {
    tenantId,
    memoryId: parseString(body.memory_id, "memory_id"),
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
  const retrievalProjectionV3 = await removeMemoryIdsFromV3SemanticIndex(env, tenantId, [memoryId]);
  const retrievalProjection = await removeMemoryIdsFromSemanticIndex(env, tenantId, [memoryId]);
  if (retrievalProjection.error || retrievalProjectionV3.error) {
    throw new HttpError(
      503,
      "retrieval_projection_failed",
      retrievalProjection.error ?? retrievalProjectionV3.error ?? "retrieval projection failed"
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
    retrieval_projection_v3: retrievalProjectionV3
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
  await assertMemoryNotOnLegalHold(env, normalizedTenantId, normalizedMemoryId);
  const retrievalProjectionV3 = await removeMemoryIdsFromV3SemanticIndex(
    env,
    normalizedTenantId,
    [normalizedMemoryId]
  );
  const retrievalProjection = await removeMemoryIdsFromSemanticIndex(
    env,
    normalizedTenantId,
    [normalizedMemoryId]
  );
  if (retrievalProjection.error || retrievalProjectionV3.error) {
    throw new HttpError(
      503,
      "retrieval_projection_failed",
      retrievalProjection.error ?? retrievalProjectionV3.error ?? "retrieval projection failed"
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
    retrieval_projection_v3: retrievalProjectionV3
  };
}
