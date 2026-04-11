import {
  HttpError,
  MEMORY_EDGE_RELATIONS,
  MEMORY_KINDS,
  MEMORY_LIFECYCLE_STATES,
  MEMORY_OPERATIONS,
  MEMORY_SCOPE_TYPES,
  normalizeLifecycleState,
  normalizeMemoryKind,
  normalizeScopeType,
  ulid,
  type MemoryKind,
  type MemoryLifecycleState,
  type MemoryOperation,
  type MemoryScopeType
} from "@org-brain/shared";
import type { Env } from "./types";

type LifecycleWriteItem = {
  external_key?: string | null;
  content: string;
  summary?: string | null;
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

type StoredMemoryRow = {
  id: string;
  tenant_id: string;
  project_id: string | null;
  content: string;
  summary: string | null;
  tags_json: string | null;
  source: string;
  external_key: string | null;
  created_at: number;
  kind?: string | null;
  lifecycle_state?: string | null;
  scope_type?: string | null;
  scope_key?: string | null;
  actor_type?: string | null;
  actor_id?: string | null;
  confidence_score?: number | null;
  utility_score?: number | null;
  canonical_key?: string | null;
  root_memory_id?: string | null;
  current_version?: number | null;
  last_accessed_at?: number | null;
  suppressed_at?: number | null;
  consolidated_at?: number | null;
  promoted_at?: number | null;
  expires_at?: number | null;
  revised_at?: number | null;
};

export type LifecycleMutationResult = {
  tenant_id: string;
  memory_id: string;
  version: number;
  operation: MemoryOperation;
  created: boolean;
  kind: MemoryKind;
  lifecycle_state: MemoryLifecycleState;
};

function sanitizeTags(raw: string[] | undefined): string[] {
  return [...new Set((raw ?? []).filter((value) => typeof value === "string").map((value) => value.trim()).filter(Boolean))].slice(0, 16);
}

function ensureMemoryEnum<T extends readonly string[]>(value: string | undefined, fallback: T[number], allowed: T, field: string): T[number] {
  if (!value) return fallback;
  if (!allowed.includes(value)) {
    throw new HttpError(400, "invalid_payload", `${field} must be one of ${allowed.join(", ")}`);
  }
  return value as T[number];
}

function coerceNullableNumber(value: unknown, field: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpError(400, "invalid_payload", `${field} must be a finite number`);
  }
  return value;
}

function deriveScope(
  tenantId: string,
  projectId: string | null,
  item: LifecycleWriteItem
): { scopeType: MemoryScopeType; scopeKey: string | null } {
  const scopeType = ensureMemoryEnum(item.scope_type, projectId ? "project" : "tenant", MEMORY_SCOPE_TYPES, "scope_type");
  if (scopeType === "tenant") return { scopeType, scopeKey: tenantId };
  if (scopeType === "org") return { scopeType, scopeKey: item.scope_key?.trim() || tenantId };
  return { scopeType, scopeKey: item.scope_key?.trim() || projectId || tenantId };
}

function normalizeWriteItem(tenantId: string, source: string, item: LifecycleWriteItem): Required<Omit<LifecycleWriteItem, "external_key">> & {
  external_key: string | null;
  created_at: number;
  tags: string[];
  project_id: string | null;
  actor_type: string | null;
  actor_id: string | null;
  kind: MemoryKind;
  lifecycle_state: MemoryLifecycleState;
  scope_type: MemoryScopeType;
  scope_key: string | null;
  confidence_score: number | null;
  utility_score: number | null;
  canonical_key: string | null;
  expires_at: number | null;
} {
  const projectId = typeof item.project_id === "string" && item.project_id.trim() ? item.project_id.trim().slice(0, 128) : null;
  const { scopeType, scopeKey } = deriveScope(tenantId, projectId, item);
  return {
    external_key: typeof item.external_key === "string" && item.external_key.trim() ? item.external_key.trim().slice(0, 256) : null,
    content: item.content.slice(0, 20_000),
    summary: item.summary?.trim().slice(0, 1000) || null,
    tags: sanitizeTags(item.tags),
    created_at: typeof item.created_at === "number" && Number.isFinite(item.created_at) ? Math.floor(item.created_at) : Date.now(),
    project_id: projectId,
    actor_type: item.actor_type?.trim().slice(0, 64) || "system",
    actor_id: item.actor_id?.trim().slice(0, 128) || source,
    kind: ensureMemoryEnum(item.kind, normalizeMemoryKind(undefined), MEMORY_KINDS, "kind"),
    lifecycle_state: ensureMemoryEnum(
      item.lifecycle_state,
      normalizeLifecycleState(undefined),
      MEMORY_LIFECYCLE_STATES,
      "lifecycle_state"
    ),
    scope_type: scopeType,
    scope_key: scopeKey,
    confidence_score: coerceNullableNumber(item.confidence_score, "confidence_score") ?? null,
    utility_score: coerceNullableNumber(item.utility_score, "utility_score") ?? null,
    canonical_key: item.canonical_key?.trim().slice(0, 256) || null,
    expires_at: coerceNullableNumber(item.expires_at, "expires_at") ?? null
  };
}

async function loadMemoryById(env: Env, tenantId: string, memoryId: string): Promise<StoredMemoryRow> {
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, project_id, content, summary, tags_json, source, external_key, created_at,
            kind, lifecycle_state, scope_type, scope_key, actor_type, actor_id, confidence_score,
            utility_score, canonical_key, root_memory_id, current_version, last_accessed_at,
            suppressed_at, consolidated_at, promoted_at, expires_at, revised_at
     FROM memories
     WHERE tenant_id = ? AND id = ?`
  )
    .bind(tenantId, memoryId)
    .first<StoredMemoryRow>();

  if (!row) {
    throw new HttpError(404, "memory_not_found", "Memory not found");
  }
  return row;
}

export async function loadExistingMemoryIdsByExternalKeys(
  db: D1Database,
  tenantId: string,
  externalKeys: string[]
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  if (externalKeys.length === 0) return results;

  for (let index = 0; index < externalKeys.length; index += 100) {
    const chunk = externalKeys.slice(index, index + 100);
    const placeholders = chunk.map(() => "?").join(", ");
    const response = await db.prepare(
      `SELECT id, external_key
       FROM memories
       WHERE tenant_id = ?
         AND external_key IN (${placeholders})`
    )
      .bind(tenantId, ...chunk)
      .all<{ id: string; external_key: string | null }>();

    for (const row of response.results) {
      if (row.external_key) results.set(row.external_key, row.id);
    }
  }

  return results;
}

export async function runBatchChunks(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  if (statements.length === 0) return;
  for (let index = 0; index < statements.length; index += 100) {
    await db.batch(statements.slice(index, index + 100));
  }
}

function buildVersionInsert(
  env: Env,
  args: {
    tenantId: string;
    memoryId: string;
    version: number;
    operation: MemoryOperation;
    snapshot: ReturnType<typeof normalizeWriteItem>;
  }
) {
  const snapshot = args.snapshot;
  return env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO memory_versions(
      id, memory_id, tenant_id, version, operation, content, summary, tags_json, kind, lifecycle_state,
      scope_type, scope_key, actor_type, actor_id, confidence_score, utility_score, canonical_key, created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    ulid(),
    args.memoryId,
    args.tenantId,
    args.version,
    args.operation,
    snapshot.content,
    snapshot.summary,
    JSON.stringify(snapshot.tags),
    snapshot.kind,
    snapshot.lifecycle_state,
    snapshot.scope_type,
    snapshot.scope_key,
    snapshot.actor_type,
    snapshot.actor_id,
    snapshot.confidence_score,
    snapshot.utility_score,
    snapshot.canonical_key,
    snapshot.created_at
  );
}

function buildEdgeInsert(
  env: Env,
  tenantId: string,
  fromMemoryId: string,
  toMemoryId: string,
  relation: "derived_from"
) {
  if (!MEMORY_EDGE_RELATIONS.includes(relation)) {
    throw new Error(`unsupported relation: ${relation}`);
  }
  return env.OPEN_BRAIN_DB.prepare(
    "INSERT INTO memory_edges(id, tenant_id, from_memory_id, to_memory_id, relation, created_at) VALUES(?,?,?,?,?,?)"
  ).bind(ulid(), tenantId, fromMemoryId, toMemoryId, relation, Date.now());
}

async function saveCurrentSnapshot(
  env: Env,
  args: {
    tenantId: string;
    source: string;
    memoryId: string;
    rowExists: boolean;
    rootMemoryId: string;
    version: number;
    snapshot: ReturnType<typeof normalizeWriteItem>;
  }
) {
  const snapshot = args.snapshot;
  const tagsJson = JSON.stringify(snapshot.tags);
  const lifecycleState = normalizeLifecycleState(snapshot.lifecycle_state);
  const revisedAt =
    lifecycleState === "suppressed" ? Date.now() : snapshot.created_at;
  const statements: D1PreparedStatement[] = [];

  if (args.rowExists) {
    statements.push(
      env.OPEN_BRAIN_DB.prepare(
        `UPDATE memories
         SET project_id = ?, content = ?, summary = ?, tags_json = ?, source = ?, created_at = ?,
             kind = ?, lifecycle_state = ?, scope_type = ?, scope_key = ?, actor_type = ?, actor_id = ?,
             confidence_score = ?, utility_score = ?, canonical_key = ?, root_memory_id = ?, current_version = ?,
             suppressed_at = ?, expires_at = ?, revised_at = ?
         WHERE tenant_id = ? AND id = ?`
      ).bind(
        snapshot.project_id,
        snapshot.content,
        snapshot.summary,
        tagsJson,
        args.source,
        snapshot.created_at,
        snapshot.kind,
        lifecycleState,
        snapshot.scope_type,
        snapshot.scope_key,
        snapshot.actor_type,
        snapshot.actor_id,
        snapshot.confidence_score,
        snapshot.utility_score,
        snapshot.canonical_key,
        args.rootMemoryId,
        args.version,
        lifecycleState === "suppressed" ? Date.now() : null,
        snapshot.expires_at,
        revisedAt,
        args.tenantId,
        args.memoryId
      )
    );
  } else {
    statements.push(
      env.OPEN_BRAIN_DB.prepare(
        `INSERT INTO memories(
          id, tenant_id, project_id, content, summary, tags_json, source, external_key, created_at, kind,
          lifecycle_state, scope_type, scope_key, actor_type, actor_id, confidence_score, utility_score,
          canonical_key, root_memory_id, current_version, suppressed_at, expires_at, revised_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        args.memoryId,
        args.tenantId,
        snapshot.project_id,
        snapshot.content,
        snapshot.summary,
        tagsJson,
        args.source,
        snapshot.external_key,
        snapshot.created_at,
        snapshot.kind,
        lifecycleState,
        snapshot.scope_type,
        snapshot.scope_key,
        snapshot.actor_type,
        snapshot.actor_id,
        snapshot.confidence_score,
        snapshot.utility_score,
        snapshot.canonical_key,
        args.rootMemoryId,
        args.version,
        lifecycleState === "suppressed" ? Date.now() : null,
        snapshot.expires_at,
        revisedAt
      )
    );
  }

  statements.push(
    env.OPEN_BRAIN_DB.prepare("DELETE FROM memories_fts WHERE memory_id = ? AND tenant_id = ?").bind(args.memoryId, args.tenantId),
    env.OPEN_BRAIN_DB.prepare("INSERT INTO memories_fts(memory_id, tenant_id, content) VALUES(?,?,?)").bind(
      args.memoryId,
      args.tenantId,
      snapshot.content
    ),
    buildVersionInsert(env, {
      tenantId: args.tenantId,
      memoryId: args.memoryId,
      version: args.version,
      operation: "capture",
      snapshot
    })
  );

  await runBatchChunks(env.OPEN_BRAIN_DB, statements);
}

export async function captureMemoryItems(
  env: Env,
  args: {
    tenantId: string;
    source: string;
    items: LifecycleWriteItem[];
    operation?: MemoryOperation;
  }
): Promise<{ tenant_id: string; source: string; inserted: number; updated: number; items: LifecycleMutationResult[] }> {
  const dedupedByKey = new Map<string, LifecycleWriteItem>();
  const anonymousItems: LifecycleWriteItem[] = [];
  for (const item of args.items) {
    if (typeof item.external_key === "string" && item.external_key.trim()) {
      dedupedByKey.set(item.external_key.trim(), item);
    } else {
      anonymousItems.push(item);
    }
  }

  const existingByKey = await loadExistingMemoryIdsByExternalKeys(env.OPEN_BRAIN_DB, args.tenantId, [...dedupedByKey.keys()]);
  const results: LifecycleMutationResult[] = [];
  let inserted = 0;
  let updated = 0;

  for (const [externalKey, rawItem] of dedupedByKey.entries()) {
    const item = normalizeWriteItem(args.tenantId, args.source, { ...rawItem, external_key: externalKey });
    const existingId = existingByKey.get(externalKey);
    const existing = existingId ? await loadMemoryById(env, args.tenantId, existingId) : null;
    const memoryId = existing?.id ?? ulid();
    const version = (existing?.current_version ?? 0) + 1;
    await saveCurrentSnapshot(env, {
      tenantId: args.tenantId,
      source: args.source,
      memoryId,
      rowExists: Boolean(existing),
      rootMemoryId: existing?.root_memory_id || memoryId,
      version,
      snapshot: item
    });

    if (existing) updated += 1;
    else inserted += 1;
    results.push({
      tenant_id: args.tenantId,
      memory_id: memoryId,
      version,
      operation: args.operation ?? "capture",
      created: !existing,
      kind: item.kind,
      lifecycle_state: item.lifecycle_state
    });
  }

  for (const rawItem of anonymousItems) {
    const item = normalizeWriteItem(args.tenantId, args.source, rawItem);
    const memoryId = ulid();
    await saveCurrentSnapshot(env, {
      tenantId: args.tenantId,
      source: args.source,
      memoryId,
      rowExists: false,
      rootMemoryId: memoryId,
      version: 1,
      snapshot: item
    });
    inserted += 1;
    results.push({
      tenant_id: args.tenantId,
      memory_id: memoryId,
      version: 1,
      operation: args.operation ?? "capture",
      created: true,
      kind: item.kind,
      lifecycle_state: item.lifecycle_state
    });
  }

  return {
    tenant_id: args.tenantId,
    source: args.source,
    inserted,
    updated,
    items: results
  };
}

export async function reviseMemory(
  env: Env,
  args: {
    tenantId: string;
    memoryId: string;
    actorType?: string | null;
    actorId?: string | null;
    content?: string;
    summary?: string | null;
    tags?: string[];
    confidenceScore?: number | null;
    utilityScore?: number | null;
  }
): Promise<LifecycleMutationResult> {
  const existing = await loadMemoryById(env, args.tenantId, args.memoryId);
  const snapshot = normalizeWriteItem(args.tenantId, existing.source, {
    external_key: existing.external_key,
    content: args.content ?? existing.content,
    summary: args.summary ?? existing.summary,
    tags: args.tags ?? [],
    created_at: Date.now(),
    project_id: existing.project_id,
    actor_type: args.actorType ?? existing.actor_type,
    actor_id: args.actorId ?? existing.actor_id,
    kind: normalizeMemoryKind(existing.kind),
    lifecycle_state: normalizeLifecycleState(existing.lifecycle_state),
    scope_type: normalizeScopeType(existing.scope_type),
    scope_key: existing.scope_key,
    confidence_score: args.confidenceScore ?? existing.confidence_score ?? null,
    utility_score: args.utilityScore ?? existing.utility_score ?? null,
    canonical_key: existing.canonical_key,
    expires_at: existing.expires_at
  });

  const version = (existing.current_version ?? 0) + 1;
  await saveCurrentSnapshot(env, {
    tenantId: args.tenantId,
    source: existing.source,
    memoryId: existing.id,
    rowExists: true,
    rootMemoryId: existing.root_memory_id || existing.id,
    version,
    snapshot
  });

  await runBatchChunks(env.OPEN_BRAIN_DB, [
    env.OPEN_BRAIN_DB.prepare("UPDATE memory_versions SET operation = ? WHERE tenant_id = ? AND memory_id = ? AND version = ?").bind(
      "revise",
      args.tenantId,
      existing.id,
      version
    )
  ]);

  return {
    tenant_id: args.tenantId,
    memory_id: existing.id,
    version,
    operation: "revise",
    created: false,
    kind: snapshot.kind,
    lifecycle_state: snapshot.lifecycle_state
  };
}

export async function refreshMemory(
  env: Env,
  args: {
    tenantId: string;
    memoryId: string;
    actorType?: string | null;
    actorId?: string | null;
    confidenceDelta?: number | null;
  }
): Promise<LifecycleMutationResult> {
  const existing = await loadMemoryById(env, args.tenantId, args.memoryId);
  const nextConfidence =
    args.confidenceDelta === undefined || args.confidenceDelta === null
      ? existing.confidence_score ?? null
      : Number(((existing.confidence_score ?? 0) + args.confidenceDelta).toFixed(6));
  const now = Date.now();
  const version = (existing.current_version ?? 0) + 1;

  await runBatchChunks(env.OPEN_BRAIN_DB, [
    env.OPEN_BRAIN_DB.prepare(
      `UPDATE memories
       SET current_version = ?, last_accessed_at = ?, actor_type = ?, actor_id = ?, confidence_score = ?, revised_at = ?
       WHERE tenant_id = ? AND id = ?`
    ).bind(
      version,
      now,
      args.actorType ?? existing.actor_type,
      args.actorId ?? existing.actor_id,
      nextConfidence,
      now,
      args.tenantId,
      existing.id
    ),
    buildVersionInsert(env, {
      tenantId: args.tenantId,
      memoryId: existing.id,
      version,
      operation: "refresh",
      snapshot: normalizeWriteItem(args.tenantId, existing.source, {
        external_key: existing.external_key,
        content: existing.content,
        summary: existing.summary,
        tags: [],
        created_at: now,
        project_id: existing.project_id,
        actor_type: args.actorType ?? existing.actor_type,
        actor_id: args.actorId ?? existing.actor_id,
        kind: normalizeMemoryKind(existing.kind),
        lifecycle_state: normalizeLifecycleState(existing.lifecycle_state),
        scope_type: normalizeScopeType(existing.scope_type),
        scope_key: existing.scope_key,
        confidence_score: nextConfidence,
        utility_score: existing.utility_score ?? null,
        canonical_key: existing.canonical_key,
        expires_at: existing.expires_at
      })
    })
  ]);

  return {
    tenant_id: args.tenantId,
    memory_id: existing.id,
    version,
    operation: "refresh",
    created: false,
    kind: normalizeMemoryKind(existing.kind),
    lifecycle_state: normalizeLifecycleState(existing.lifecycle_state)
  };
}

export async function suppressMemory(
  env: Env,
  args: {
    tenantId: string;
    memoryId: string;
    reason: string;
    actorType?: string | null;
    actorId?: string | null;
  }
): Promise<LifecycleMutationResult> {
  const existing = await loadMemoryById(env, args.tenantId, args.memoryId);
  const now = Date.now();
  const tags = sanitizeTags([...JSON.parse(existing.tags_json ?? "[]"), "compacted"]);
  const version = (existing.current_version ?? 0) + 1;
  const snapshot = normalizeWriteItem(args.tenantId, existing.source, {
    external_key: existing.external_key,
    content: existing.content,
    summary: existing.summary ?? args.reason,
    tags,
    created_at: now,
    project_id: existing.project_id,
    actor_type: args.actorType ?? existing.actor_type,
    actor_id: args.actorId ?? existing.actor_id,
    kind: normalizeMemoryKind(existing.kind),
    lifecycle_state: "suppressed",
    scope_type: normalizeScopeType(existing.scope_type),
    scope_key: existing.scope_key,
    confidence_score: existing.confidence_score ?? null,
    utility_score: existing.utility_score ?? null,
    canonical_key: existing.canonical_key,
    expires_at: existing.expires_at
  });

  await saveCurrentSnapshot(env, {
    tenantId: args.tenantId,
    source: existing.source,
    memoryId: existing.id,
    rowExists: true,
    rootMemoryId: existing.root_memory_id || existing.id,
    version,
    snapshot
  });

  return {
    tenant_id: args.tenantId,
    memory_id: existing.id,
    version,
    operation: "suppress",
    created: false,
    kind: snapshot.kind,
    lifecycle_state: "suppressed"
  };
}

export async function deriveMemoryEdge(
  env: Env,
  tenantId: string,
  fromMemoryId: string,
  toMemoryId: string
): Promise<void> {
  await runBatchChunks(env.OPEN_BRAIN_DB, [buildEdgeInsert(env, tenantId, fromMemoryId, toMemoryId, "derived_from")]);
}
