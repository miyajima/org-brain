import {
  HttpError,
  MEMORY_EDGE_RELATIONS,
  MEMORY_KINDS,
  MEMORY_LIFECYCLE_STATES,
  MEMORY_OPERATIONS,
  MEMORY_SCOPE_TYPES,
  MEMORY_WORK_TYPES,
  assessMemoryUsefulness,
  buildRetrievalUnits,
  buildVerifiedLearningRetrievalUnits,
  normalizeLifecycleState,
  normalizeMemoryKind,
  normalizeScopeType,
  sha256,
  ulid,
  type MemoryKind,
  type MemoryLifecycleState,
  type MemoryOperation,
  type MemoryScopeType,
  type MemorySourceReference,
  type MemoryWorkType
} from "@org-brain/shared";
import type { Env } from "./types";
import { extractRetrievalUnitsV4 } from "./retrieval-v4-extraction-service";

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
  capture_origin?: "observed" | "synthetic" | "repair" | "legacy";
  verification_state?: "verified" | "partial" | "unverified" | "rejected";
  verified_at?: number | null;
  learning?: Record<string, unknown> | null;
  quality_dimensions?: Record<string, number> | null;
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
  entities_json?: string | null;
  source_refs_json?: string | null;
  updated_at?: number | null;
  valid_from?: number | null;
  valid_until?: number | null;
  content_hash?: string | null;
  rationale?: string | null;
  reuse_rule?: string | null;
  evidence_json?: string | null;
  conflicts_json?: string | null;
  permissions_json?: string | null;
  business_category_id?: string | null;
  work_type?: string | null;
  capture_origin?: string | null;
  verification_state?: string | null;
  verified_at?: number | null;
  learning_json?: string | null;
  quality_dimensions_json?: string | null;
};

export type LifecycleMutationResult = {
  tenant_id: string;
  memory_id: string;
  version: number;
  operation: MemoryOperation | "delete";
  created: boolean;
  kind: MemoryKind;
  lifecycle_state: MemoryLifecycleState;
  deduplicated?: boolean;
};

function sanitizeTags(raw: string[] | undefined): string[] {
  return [...new Set((raw ?? []).filter((value) => typeof value === "string").map((value) => value.trim()).filter(Boolean))].slice(0, 16);
}

function sanitizeObjects(raw: Array<Record<string, unknown>> | undefined): Array<Record<string, unknown>> {
  return (raw ?? []).filter((value) => value && typeof value === "object" && !Array.isArray(value)).slice(0, 64);
}

function parseStoredTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? sanitizeTags(parsed) : [];
  } catch {
    return [];
  }
}

function parseStoredObjects(raw: string | null | undefined): Array<Record<string, unknown>> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value))
      : [];
  } catch {
    return [];
  }
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
  entities: string[];
  source_references: Array<Record<string, unknown>>;
  valid_from: number | null;
  valid_until: number | null;
  rationale: string | null;
  reuse_rule: string | null;
  evidence: Array<Record<string, unknown>>;
  conflicts: string[];
  permissions: Array<Record<string, unknown>>;
  business_category_id: string | null;
  work_type: MemoryWorkType | null;
  capture_origin: "observed" | "synthetic" | "repair" | "legacy";
  verification_state: "verified" | "partial" | "unverified" | "rejected";
  verified_at: number | null;
  learning: Record<string, unknown> | null;
  quality_dimensions: Record<string, number> | null;
} {
  const projectId = typeof item.project_id === "string" && item.project_id.trim() ? item.project_id.trim().slice(0, 128) : null;
  const { scopeType, scopeKey } = deriveScope(tenantId, projectId, item);
  const tags = sanitizeTags(item.tags);
  const createdAt = typeof item.created_at === "number" && Number.isFinite(item.created_at) ? Math.floor(item.created_at) : Date.now();
  const content = item.content.slice(0, 20_000);
  const assessment = assessMemoryUsefulness({
    project_id: projectId,
    source,
    content,
    summary: item.summary,
    tags,
    created_at: createdAt,
    utility_score: item.utility_score,
    confidence_score: item.confidence_score,
    expires_at: item.expires_at
  });
  const captureV2Summary = tags.includes("capture-v2") && typeof item.summary === "string" && item.summary.trim()
    ? item.summary.trim().slice(0, 1_000)
    : null;
  const confidenceScore = coerceNullableNumber(item.confidence_score, "confidence_score");
  const utilityScore = coerceNullableNumber(item.utility_score, "utility_score");
  const expiresAt = coerceNullableNumber(item.expires_at, "expires_at");
  const validFrom = coerceNullableNumber(item.valid_from, "valid_from");
  const validUntil = coerceNullableNumber(item.valid_until, "valid_until");
  const captureOrigin = ensureMemoryEnum(item.capture_origin, "legacy", ["observed", "synthetic", "repair", "legacy"] as const, "capture_origin");
  const verificationState = ensureMemoryEnum(item.verification_state, "unverified", ["verified", "partial", "unverified", "rejected"] as const, "verification_state");
  if (verificationState === "verified" && captureOrigin !== "observed") {
    throw new HttpError(400, "invalid_verification_origin", "only observed learning may be verified");
  }
  const verifiedAt = coerceNullableNumber(item.verified_at, "verified_at");
  if (verificationState === "verified" && (!verifiedAt || !item.learning)) {
    throw new HttpError(400, "verified_learning_required", "verified_at and learning are required for verified memory");
  }
  const qualityDimensions = item.quality_dimensions && typeof item.quality_dimensions === "object"
    ? Object.fromEntries(Object.entries(item.quality_dimensions).map(([key, value]) => {
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        throw new HttpError(400, "invalid_quality_dimension", `quality dimension ${key} must be between 0 and 100`);
      }
      return [key.slice(0, 80), Number(value)];
    }))
    : null;
  return {
    external_key: typeof item.external_key === "string" && item.external_key.trim() ? item.external_key.trim().slice(0, 256) : null,
    content,
    // v2 already supplies the atomic conclusion as its summary. The legacy
    // quality prefix (for example "project | workaround | …") is useful for
    // old hook transcripts but obscures v2 kind/category metadata in the UI.
    summary: captureV2Summary ?? assessment.summary,
    tags,
    created_at: createdAt,
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
    confidence_score: confidenceScore ?? assessment.confidence_score,
    utility_score: utilityScore ?? assessment.utility_score,
    canonical_key: item.canonical_key?.trim().slice(0, 256) || null,
    expires_at: expiresAt ?? validUntil ?? assessment.expires_at,
    entities: sanitizeTags(item.entities).slice(0, 64),
    source_references: sanitizeObjects(item.source_references),
    valid_from: validFrom ?? null,
    valid_until: validUntil ?? expiresAt ?? assessment.expires_at,
    rationale: item.rationale?.trim().slice(0, 4000) || null,
    reuse_rule: item.reuse_rule?.trim().slice(0, 1000) || null,
    evidence: sanitizeObjects(item.evidence),
    conflicts: sanitizeTags(item.conflicts).slice(0, 64),
    permissions: sanitizeObjects(item.permissions)
    , business_category_id: item.business_category_id?.trim().slice(0, 128) || null
    , work_type: item.work_type
      ? ensureMemoryEnum(item.work_type, "other", MEMORY_WORK_TYPES, "work_type")
      : null
    , capture_origin: captureOrigin
    , verification_state: verificationState
    , verified_at: verificationState === "verified" ? verifiedAt ?? null : null
    , learning: item.learning && typeof item.learning === "object" ? item.learning : null
    , quality_dimensions: qualityDimensions
  };
}

async function loadMemoryById(env: Env, tenantId: string, memoryId: string): Promise<StoredMemoryRow> {
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, project_id, content, summary, tags_json, source, external_key, created_at,
            kind, lifecycle_state, scope_type, scope_key, actor_type, actor_id, confidence_score,
            utility_score, canonical_key, root_memory_id, current_version, last_accessed_at,
            suppressed_at, consolidated_at, promoted_at, expires_at, revised_at,
            entities_json, source_refs_json, updated_at, valid_from, valid_until, content_hash,
            rationale, evidence_json, conflicts_json, permissions_json,
            business_category_id, work_type, reuse_rule,
            capture_origin, verification_state, verified_at, learning_json, quality_dimensions_json
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

function v2FieldsFromStored(row: StoredMemoryRow): Pick<
  LifecycleWriteItem,
  | "entities"
  | "source_references"
  | "valid_from"
  | "valid_until"
  | "rationale"
  | "reuse_rule"
  | "evidence"
  | "conflicts"
  | "permissions"
  | "capture_origin"
  | "verification_state"
  | "verified_at"
  | "learning"
  | "quality_dimensions"
> {
  return {
    entities: parseStoredTags(row.entities_json),
    source_references: parseStoredObjects(row.source_refs_json),
    valid_from: row.valid_from ?? null,
    valid_until: row.valid_until ?? row.expires_at ?? null,
    rationale: row.rationale ?? null,
    reuse_rule: row.reuse_rule ?? null,
    evidence: parseStoredObjects(row.evidence_json),
    conflicts: parseStoredTags(row.conflicts_json),
    permissions: parseStoredObjects(row.permissions_json),
    capture_origin: row.capture_origin === "observed" || row.capture_origin === "synthetic" || row.capture_origin === "repair"
      ? row.capture_origin
      : "legacy",
    verification_state: row.verification_state === "verified" || row.verification_state === "partial" || row.verification_state === "rejected"
      ? row.verification_state
      : "unverified",
    verified_at: row.verified_at ?? null,
    learning: row.learning_json ? JSON.parse(row.learning_json) as Record<string, unknown> : null,
    quality_dimensions: row.quality_dimensions_json ? JSON.parse(row.quality_dimensions_json) as Record<string, number> : null
  };
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

export async function loadExistingMemoryIdsByCanonicalKeys(
  db: D1Database,
  tenantId: string,
  canonicalKeys: string[]
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  if (canonicalKeys.length === 0) return results;
  for (let index = 0; index < canonicalKeys.length; index += 100) {
    const chunk = canonicalKeys.slice(index, index + 100);
    const placeholders = chunk.map(() => "?").join(", ");
    const response = await db.prepare(
      `SELECT id, canonical_key
       FROM memories
       WHERE tenant_id = ?
         AND canonical_key IN (${placeholders})
         AND (lifecycle_state IS NULL OR lifecycle_state != 'suppressed')
       ORDER BY confidence_score DESC, utility_score DESC, updated_at DESC, id`
    ).bind(tenantId, ...chunk).all<{ id: string; canonical_key: string | null }>();
    for (const row of response.results) {
      if (row.canonical_key && !results.has(row.canonical_key)) results.set(row.canonical_key, row.id);
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

function isDuplicateCanonicalWrite(error: unknown): boolean {
  return error instanceof HttpError
    ? error.code === "duplicate_canonical_key"
    : String(error instanceof Error ? error.message : error).includes("duplicate_canonical_key");
}

async function canonicalDuplicateResult(
  env: Env,
  tenantId: string,
  canonicalKey: string,
  operation: MemoryOperation
): Promise<LifecycleMutationResult | null> {
  const matches = await loadExistingMemoryIdsByCanonicalKeys(
    env.OPEN_BRAIN_DB,
    tenantId,
    [canonicalKey]
  );
  const memoryId = matches.get(canonicalKey);
  if (!memoryId) return null;
  const existing = await loadMemoryById(env, tenantId, memoryId);
  return {
    tenant_id: tenantId,
    memory_id: existing.id,
    version: existing.current_version ?? 1,
    operation,
    created: false,
    kind: normalizeMemoryKind(existing.kind),
    lifecycle_state: normalizeLifecycleState(existing.lifecycle_state),
    deduplicated: true
  };
}

function buildVersionInsert(
  env: Env,
  args: {
    tenantId: string;
    memoryId: string;
    version: number;
    operation: MemoryOperation;
    snapshot: ReturnType<typeof normalizeWriteItem>;
    contentHash: string;
  }
) {
  const snapshot = args.snapshot;
  return env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO memory_versions(
      id, memory_id, tenant_id, version, operation, content, summary, tags_json, kind, lifecycle_state,
      scope_type, scope_key, actor_type, actor_id, confidence_score, utility_score, canonical_key, created_at,
      snapshot_json, content_hash, business_category_id, work_type, reuse_rule
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
    snapshot.created_at,
    JSON.stringify({
      tenant_id: args.tenantId,
      memory_id: args.memoryId,
      version: args.version,
      ...snapshot,
      content_hash: args.contentHash
    }),
    args.contentHash,
    snapshot.business_category_id,
    snapshot.work_type,
    snapshot.reuse_rule
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
  const updatedAt = Date.now();
  const contentHash = await sha256(snapshot.content);
  const retrievalUnits =
    lifecycleState === "suppressed"
      ? []
      : await buildRetrievalUnits({
          id: args.memoryId,
          tenant_id: args.tenantId,
          project_id: snapshot.project_id,
          content: snapshot.content,
          summary: snapshot.summary,
          created_at: snapshot.created_at,
          updated_at: updatedAt,
          valid_from: snapshot.valid_from,
          valid_until: snapshot.valid_until,
          source_references: snapshot.source_references as MemorySourceReference[]
        });
  const retrievalUnitsV4 =
    lifecycleState === "suppressed"
      ? []
      : await extractRetrievalUnitsV4(env, {
          id: args.memoryId,
          tenant_id: args.tenantId,
          project_id: snapshot.project_id,
          content: snapshot.content,
          summary: snapshot.summary,
          created_at: snapshot.created_at,
          updated_at: updatedAt,
          valid_from: snapshot.valid_from,
          valid_until: snapshot.valid_until,
          source_references: snapshot.source_references as MemorySourceReference[]
        });
  const learningUnits = lifecycleState === "suppressed"
    ? []
    : await buildVerifiedLearningRetrievalUnits({
        id: args.memoryId,
        tenant_id: args.tenantId,
        project_id: snapshot.project_id,
        content: snapshot.content,
        summary: snapshot.summary,
        created_at: snapshot.created_at,
        updated_at: updatedAt,
        valid_from: snapshot.valid_from,
        valid_until: snapshot.valid_until,
        source_references: snapshot.source_references as MemorySourceReference[],
        kind: snapshot.kind,
        capture_origin: snapshot.capture_origin,
        verification_state: snapshot.verification_state,
        verified_at: snapshot.verified_at,
        learning_json: snapshot.learning ? JSON.stringify(snapshot.learning) : null
      });
  const dynamicGenerations = (await env.OPEN_BRAIN_DB.prepare(
    `SELECT DISTINCT g.id, g.unit_schema_version, g.extractor_name, g.extractor_version
     FROM retrieval_generation_assignments a
     JOIN retrieval_generations g
       ON g.id = a.active_generation_id OR g.id = a.shadow_generation_id
     WHERE a.tenant_id = ? AND a.project_scope_key IN ('*', ?)
       AND g.id NOT IN ('gen_baseline_units', 'gen_structured_context')
       AND g.status IN ('building', 'shadow', 'active', 'fallback')`
  ).bind(args.tenantId, snapshot.project_id ?? "").all<{
    id: string;
    unit_schema_version: number;
    extractor_name: string;
    extractor_version: string;
  }>()).results;
  if (dynamicGenerations.some((generation) => ![1, 2, 3].includes(generation.unit_schema_version))) {
    throw new Error("unsupported_assigned_retrieval_unit_schema");
  }
  const statements: D1PreparedStatement[] = [];

  if (args.rowExists) {
    statements.push(
      env.OPEN_BRAIN_DB.prepare(
        `UPDATE memories
         SET project_id = ?, content = ?, summary = ?, tags_json = ?, source = ?, created_at = ?,
             kind = ?, lifecycle_state = ?, scope_type = ?, scope_key = ?, actor_type = ?, actor_id = ?,
             confidence_score = ?, utility_score = ?, canonical_key = ?, root_memory_id = ?, current_version = ?,
             suppressed_at = ?, expires_at = ?, revised_at = ?, entities_json = ?, source_refs_json = ?,
             updated_at = ?, valid_from = ?, valid_until = ?, content_hash = ?, rationale = ?,
             evidence_json = ?, conflicts_json = ?, permissions_json = ?,
             business_category_id = ?, work_type = ?, reuse_rule = ?,
             capture_origin = ?, verification_state = ?, verified_at = ?, learning_json = ?, quality_dimensions_json = ?
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
        JSON.stringify(snapshot.entities),
        JSON.stringify(snapshot.source_references),
        updatedAt,
        snapshot.valid_from,
        snapshot.valid_until,
        contentHash,
        snapshot.rationale,
        JSON.stringify(snapshot.evidence),
        JSON.stringify(snapshot.conflicts),
        JSON.stringify(snapshot.permissions),
        snapshot.business_category_id,
        snapshot.work_type,
        snapshot.reuse_rule,
        snapshot.capture_origin,
        snapshot.verification_state,
        snapshot.verified_at,
        snapshot.learning ? JSON.stringify(snapshot.learning) : null,
        snapshot.quality_dimensions ? JSON.stringify(snapshot.quality_dimensions) : null,
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
          canonical_key, root_memory_id, current_version, suppressed_at, expires_at, revised_at,
          entities_json, source_refs_json, updated_at, valid_from, valid_until, content_hash, rationale,
          evidence_json, conflicts_json, permissions_json, business_category_id, work_type, reuse_rule,
          capture_origin, verification_state, verified_at, learning_json, quality_dimensions_json
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
        revisedAt,
        JSON.stringify(snapshot.entities),
        JSON.stringify(snapshot.source_references),
        updatedAt,
        snapshot.valid_from,
        snapshot.valid_until,
        contentHash,
        snapshot.rationale,
        JSON.stringify(snapshot.evidence),
        JSON.stringify(snapshot.conflicts),
        JSON.stringify(snapshot.permissions),
        snapshot.business_category_id,
        snapshot.work_type,
        snapshot.reuse_rule,
        snapshot.capture_origin,
        snapshot.verification_state,
        snapshot.verified_at,
        snapshot.learning ? JSON.stringify(snapshot.learning) : null,
        snapshot.quality_dimensions ? JSON.stringify(snapshot.quality_dimensions) : null
      )
    );
  }

  statements.push(
    env.OPEN_BRAIN_DB.prepare("DELETE FROM memories_fts WHERE memory_id = ? AND tenant_id = ?").bind(args.memoryId, args.tenantId)
  );
  if (lifecycleState !== "suppressed") {
    statements.push(
      env.OPEN_BRAIN_DB.prepare("INSERT INTO memories_fts(memory_id, tenant_id, content) VALUES(?,?,?)").bind(
        args.memoryId,
        args.tenantId,
        `${snapshot.summary}\n${snapshot.content}`
      )
    );
  }
  statements.push(buildVersionInsert(env, {
    tenantId: args.tenantId,
    memoryId: args.memoryId,
    version: args.version,
    operation: "capture",
    snapshot,
    contentHash
  }));
  for (const generation of dynamicGenerations) {
    statements.push(
      env.OPEN_BRAIN_DB.prepare(
        `DELETE FROM retrieval_units_fts WHERE tenant_id = ? AND unit_id IN (
           SELECT id FROM retrieval_units
           WHERE tenant_id = ? AND generation_id = ? AND source_type = 'memory' AND source_id = ?
         )`
      ).bind(args.tenantId, args.tenantId, generation.id, args.memoryId),
      env.OPEN_BRAIN_DB.prepare(
        `DELETE FROM retrieval_units
         WHERE tenant_id = ? AND generation_id = ? AND source_type = 'memory' AND source_id = ?`
      ).bind(args.tenantId, generation.id, args.memoryId)
    );
  }
  statements.push(
    env.OPEN_BRAIN_DB.prepare(
      `DELETE FROM retrieval_units_fts
       WHERE tenant_id = ? AND unit_id IN (
         SELECT id FROM retrieval_units
         WHERE tenant_id = ? AND source_type = 'memory' AND source_id = ?
           AND generation_id IN ('gen_baseline_units', 'gen_structured_context')
       )`
    ).bind(args.tenantId, args.tenantId, args.memoryId),
    env.OPEN_BRAIN_DB.prepare(
      `DELETE FROM retrieval_units
       WHERE tenant_id = ? AND source_type = 'memory' AND source_id = ?
         AND generation_id IN ('gen_baseline_units', 'gen_structured_context')`
    ).bind(args.tenantId, args.memoryId),
    env.OPEN_BRAIN_DB.prepare(
      "DELETE FROM memory_retrieval_units_v4_fts WHERE memory_id = ? AND tenant_id = ?"
    ).bind(args.memoryId, args.tenantId),
    env.OPEN_BRAIN_DB.prepare(
      "DELETE FROM memory_retrieval_units_v4 WHERE memory_id = ? AND tenant_id = ?"
    ).bind(args.memoryId, args.tenantId)
  );
  statements.push(
    env.OPEN_BRAIN_DB.prepare(
      "DELETE FROM memory_retrieval_units_fts WHERE memory_id = ? AND tenant_id = ?"
    ).bind(args.memoryId, args.tenantId),
    env.OPEN_BRAIN_DB.prepare(
      "DELETE FROM memory_retrieval_units WHERE memory_id = ? AND tenant_id = ?"
    ).bind(args.memoryId, args.tenantId)
  );
  for (const unit of retrievalUnits) {
    statements.push(
      env.OPEN_BRAIN_DB.prepare(
        `INSERT INTO memory_retrieval_units(
          id, memory_id, tenant_id, project_id, unit_type, speaker, text,
          event_at, valid_from, valid_until, source_ref_json, source_span_start,
          source_span_end, content_hash, extractor, extractor_version,
          extraction_state, degraded_reason, created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        unit.id,
        unit.memory_id,
        unit.tenant_id,
        unit.project_id,
        unit.unit_type,
        unit.speaker,
        unit.text,
        unit.event_at,
        unit.valid_from,
        unit.valid_until,
        unit.source_ref_json,
        unit.source_span_start,
        unit.source_span_end,
        unit.content_hash,
        unit.extractor,
        unit.extractor_version,
        unit.extraction_state,
        unit.degraded_reason,
        unit.created_at
      ),
      env.OPEN_BRAIN_DB.prepare(
        "INSERT INTO memory_retrieval_units_fts(unit_id, memory_id, tenant_id, text) VALUES(?,?,?,?)"
      ).bind(unit.id, unit.memory_id, unit.tenant_id, unit.text),
      env.OPEN_BRAIN_DB.prepare(
        `INSERT INTO retrieval_units(
          id, generation_id, tenant_id, project_id, source_type, source_id,
          business_category_id, work_type, unit_type, text, speaker, event_at,
          valid_from, valid_until, source_ref_json, source_span_start, source_span_end,
          metadata_json, segment_id, content_hash, extractor_name, extractor_version,
          extraction_state, degraded_reason, created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        `stable_v3_${unit.id}`, "gen_baseline_units", unit.tenant_id, unit.project_id,
        "memory", unit.memory_id, snapshot.business_category_id, snapshot.work_type,
        unit.unit_type, unit.text, unit.speaker, unit.event_at, unit.valid_from,
        unit.valid_until, unit.source_ref_json, unit.source_span_start,
        unit.source_span_end, "{}", null, unit.content_hash, unit.extractor,
        unit.extractor_version, unit.extraction_state, unit.degraded_reason, unit.created_at
      ),
      env.OPEN_BRAIN_DB.prepare(
        "INSERT INTO retrieval_units_fts(unit_id, generation_id, tenant_id, text) VALUES(?,?,?,?)"
      ).bind(`stable_v3_${unit.id}`, "gen_baseline_units", unit.tenant_id, unit.text)
    );
  }
  for (const unit of retrievalUnitsV4) {
    statements.push(
      env.OPEN_BRAIN_DB.prepare(
        `INSERT INTO memory_retrieval_units_v4(
          id, memory_id, tenant_id, project_id, unit_type, speaker, text,
          event_at, valid_from, valid_until, source_ref_json, source_span_start,
          source_span_end, content_hash, metadata_json, segment_id, extractor,
          extractor_version, extraction_state, degraded_reason, created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        unit.id,
        unit.memory_id,
        unit.tenant_id,
        unit.project_id,
        unit.unit_type,
        unit.speaker,
        unit.text,
        unit.event_at,
        unit.valid_from,
        unit.valid_until,
        unit.source_ref_json,
        unit.source_span_start,
        unit.source_span_end,
        unit.content_hash,
        unit.metadata_json,
        unit.segment_id,
        unit.extractor,
        unit.extractor_version,
        unit.extraction_state,
        unit.degraded_reason,
        unit.created_at
      ),
      env.OPEN_BRAIN_DB.prepare(
        "INSERT INTO memory_retrieval_units_v4_fts(unit_id, memory_id, tenant_id, text) VALUES(?,?,?,?)"
      ).bind(unit.id, unit.memory_id, unit.tenant_id, unit.text),
      env.OPEN_BRAIN_DB.prepare(
        `INSERT INTO retrieval_units(
          id, generation_id, tenant_id, project_id, source_type, source_id,
          business_category_id, work_type, unit_type, text, speaker, event_at,
          valid_from, valid_until, source_ref_json, source_span_start, source_span_end,
          metadata_json, segment_id, content_hash, extractor_name, extractor_version,
          extraction_state, degraded_reason, created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        `stable_v4_${unit.id}`, "gen_structured_context", unit.tenant_id, unit.project_id,
        "memory", unit.memory_id, snapshot.business_category_id, snapshot.work_type,
        unit.unit_type, unit.text, unit.speaker, unit.event_at, unit.valid_from,
        unit.valid_until, unit.source_ref_json, unit.source_span_start,
        unit.source_span_end, unit.metadata_json, unit.segment_id, unit.content_hash,
        unit.extractor, unit.extractor_version, unit.extraction_state,
        unit.degraded_reason, unit.created_at
      ),
      env.OPEN_BRAIN_DB.prepare(
        "INSERT INTO retrieval_units_fts(unit_id, generation_id, tenant_id, text) VALUES(?,?,?,?)"
      ).bind(`stable_v4_${unit.id}`, "gen_structured_context", unit.tenant_id, unit.text)
    );
  }
  for (const generation of dynamicGenerations) {
    const units = generation.unit_schema_version === 1
      ? retrievalUnits
      : generation.unit_schema_version === 3
        ? learningUnits
        : retrievalUnitsV4;
    for (const unit of units) {
      const stableId = `stable_${generation.id}_${unit.id}`;
      const metadataJson = "metadata_json" in unit ? unit.metadata_json : "{}";
      const segmentId = "segment_id" in unit ? unit.segment_id : null;
      statements.push(
        env.OPEN_BRAIN_DB.prepare(
          `INSERT INTO retrieval_units(
             id, generation_id, tenant_id, project_id, source_type, source_id,
             business_category_id, work_type, unit_type, text, speaker, event_at,
             valid_from, valid_until, source_ref_json, source_span_start, source_span_end,
             metadata_json, segment_id, content_hash, extractor_name, extractor_version,
             extraction_state, degraded_reason, created_at
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(
          stableId, generation.id, unit.tenant_id, unit.project_id,
          "memory", unit.memory_id, snapshot.business_category_id, snapshot.work_type,
          unit.unit_type, unit.text, unit.speaker, unit.event_at, unit.valid_from,
          unit.valid_until, unit.source_ref_json, unit.source_span_start,
          unit.source_span_end, metadataJson, segmentId, unit.content_hash,
          generation.extractor_name, generation.extractor_version,
          unit.extraction_state, unit.degraded_reason, unit.created_at
        ),
        env.OPEN_BRAIN_DB.prepare(
          "INSERT INTO retrieval_units_fts(unit_id, generation_id, tenant_id, text) VALUES(?,?,?,?)"
        ).bind(stableId, generation.id, unit.tenant_id, unit.text)
      );
    }
  }

  try {
    await runBatchChunks(env.OPEN_BRAIN_DB, statements);
  } catch (error) {
    if (isDuplicateCanonicalWrite(error)) {
      throw new HttpError(
        409,
        "duplicate_canonical_key",
        "An active memory already owns this canonical_key"
      );
    }
    throw error;
  }
  if (
    lifecycleState !== "suppressed" &&
    env.RETRIEVAL_PROJECTION_QUEUE &&
    (env.HYBRID_V3_MODE === "canary" || env.HYBRID_V3_MODE === "on")
  ) {
    await env.RETRIEVAL_PROJECTION_QUEUE.send(
      {
        version: 1,
        tenant_id: args.tenantId,
        memory_id: args.memoryId,
        content_hash: contentHash,
        requested_at: Date.now()
      },
      { contentType: "json" }
    ).catch(() => {
      // The deterministic projection remains queryable and explicitly marked
      // degraded when asynchronous quality extraction is unavailable.
    });
  }
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
  const canonicalKeys = [...new Set(args.items
    .map((item) => typeof item.canonical_key === "string" ? item.canonical_key.trim() : "")
    .filter(Boolean))];
  const existingByCanonicalKey = await loadExistingMemoryIdsByCanonicalKeys(
    env.OPEN_BRAIN_DB,
    args.tenantId,
    canonicalKeys
  );
  const results: LifecycleMutationResult[] = [];
  let inserted = 0;
  let updated = 0;

  for (const [externalKey, rawItem] of dedupedByKey.entries()) {
    const item = normalizeWriteItem(args.tenantId, args.source, { ...rawItem, external_key: externalKey });
    const existingId = existingByKey.get(externalKey);
    const canonicalExistingId = item.canonical_key ? existingByCanonicalKey.get(item.canonical_key) : null;
    if (!existingId && canonicalExistingId && item.lifecycle_state !== "suppressed") {
      const canonicalExisting = await loadMemoryById(env, args.tenantId, canonicalExistingId);
      results.push({
        tenant_id: args.tenantId,
        memory_id: canonicalExisting.id,
        version: canonicalExisting.current_version ?? 1,
        operation: args.operation ?? "capture",
        created: false,
        kind: normalizeMemoryKind(canonicalExisting.kind),
        lifecycle_state: normalizeLifecycleState(canonicalExisting.lifecycle_state),
        deduplicated: true
      });
      continue;
    }
    const existing = existingId ? await loadMemoryById(env, args.tenantId, existingId) : null;
    const memoryId = existing?.id ?? ulid();
    const version = (existing?.current_version ?? 0) + 1;
    try {
      await saveCurrentSnapshot(env, {
        tenantId: args.tenantId,
        source: args.source,
        memoryId,
        rowExists: Boolean(existing),
        rootMemoryId: existing?.root_memory_id || memoryId,
        version,
        snapshot: item
      });
    } catch (error) {
      if (item.canonical_key && isDuplicateCanonicalWrite(error)) {
        const duplicate = await canonicalDuplicateResult(
          env,
          args.tenantId,
          item.canonical_key,
          args.operation ?? "capture"
        );
        if (duplicate) {
          results.push(duplicate);
          continue;
        }
      }
      throw error;
    }

    if (existing) updated += 1;
    else inserted += 1;
    if (item.canonical_key && item.lifecycle_state !== "suppressed") {
      existingByCanonicalKey.set(item.canonical_key, memoryId);
    }
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
    const canonicalExistingId = item.canonical_key ? existingByCanonicalKey.get(item.canonical_key) : null;
    if (canonicalExistingId && item.lifecycle_state !== "suppressed") {
      const canonicalExisting = await loadMemoryById(env, args.tenantId, canonicalExistingId);
      results.push({
        tenant_id: args.tenantId,
        memory_id: canonicalExisting.id,
        version: canonicalExisting.current_version ?? 1,
        operation: args.operation ?? "capture",
        created: false,
        kind: normalizeMemoryKind(canonicalExisting.kind),
        lifecycle_state: normalizeLifecycleState(canonicalExisting.lifecycle_state),
        deduplicated: true
      });
      continue;
    }
    const memoryId = ulid();
    try {
      await saveCurrentSnapshot(env, {
        tenantId: args.tenantId,
        source: args.source,
        memoryId,
        rowExists: false,
        rootMemoryId: memoryId,
        version: 1,
        snapshot: item
      });
    } catch (error) {
      if (item.canonical_key && isDuplicateCanonicalWrite(error)) {
        const duplicate = await canonicalDuplicateResult(
          env,
          args.tenantId,
          item.canonical_key,
          args.operation ?? "capture"
        );
        if (duplicate) {
          results.push(duplicate);
          continue;
        }
      }
      throw error;
    }
    inserted += 1;
    if (item.canonical_key && item.lifecycle_state !== "suppressed") {
      existingByCanonicalKey.set(item.canonical_key, memoryId);
    }
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
    projectId?: string | null;
    content?: string;
    summary?: string | null;
    tags?: string[];
    confidenceScore?: number | null;
    utilityScore?: number | null;
    entities?: string[];
    sourceReferences?: Array<Record<string, unknown>>;
    validFrom?: number | null;
    validUntil?: number | null;
    rationale?: string | null;
    reuseRule?: string | null;
    evidence?: Array<Record<string, unknown>>;
    conflicts?: string[];
    permissions?: Array<Record<string, unknown>>;
    businessCategoryId?: string | null;
    workType?: MemoryWorkType | null;
    kind?: MemoryKind;
    canonicalKey?: string | null;
    expiresAt?: number | null;
  }
): Promise<LifecycleMutationResult> {
  const existing = await loadMemoryById(env, args.tenantId, args.memoryId);
  const snapshot = normalizeWriteItem(args.tenantId, existing.source, {
    ...v2FieldsFromStored(existing),
    entities: args.entities ?? parseStoredTags(existing.entities_json),
    source_references: args.sourceReferences ?? parseStoredObjects(existing.source_refs_json),
    valid_from: args.validFrom ?? existing.valid_from,
    valid_until: args.validUntil ?? existing.valid_until,
    rationale: args.rationale ?? existing.rationale,
    reuse_rule: args.reuseRule === undefined ? existing.reuse_rule : args.reuseRule,
    evidence: args.evidence ?? parseStoredObjects(existing.evidence_json),
    conflicts: args.conflicts ?? parseStoredTags(existing.conflicts_json),
    permissions: args.permissions ?? parseStoredObjects(existing.permissions_json),
    business_category_id: args.businessCategoryId === undefined
      ? existing.business_category_id ?? null
      : args.businessCategoryId,
    work_type: args.workType === undefined
      ? MEMORY_WORK_TYPES.includes(existing.work_type as MemoryWorkType)
        ? existing.work_type as MemoryWorkType
        : null
      : args.workType,
    external_key: existing.external_key,
    content: args.content ?? existing.content,
    summary: args.summary ?? existing.summary,
    tags: args.tags ?? parseStoredTags(existing.tags_json),
    created_at: Date.now(),
    project_id: args.projectId === undefined ? existing.project_id : args.projectId,
    actor_type: args.actorType ?? existing.actor_type,
    actor_id: args.actorId ?? existing.actor_id,
    kind: args.kind ?? normalizeMemoryKind(existing.kind),
    lifecycle_state: normalizeLifecycleState(existing.lifecycle_state),
    scope_type: normalizeScopeType(existing.scope_type),
    scope_key: existing.scope_key,
    confidence_score: args.confidenceScore ?? existing.confidence_score ?? null,
    utility_score: args.utilityScore ?? existing.utility_score ?? null,
    canonical_key: args.canonicalKey === undefined ? existing.canonical_key : args.canonicalKey,
    expires_at: args.expiresAt === undefined ? existing.expires_at : args.expiresAt
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
  const contentHash = existing.content_hash || await sha256(existing.content);

  await runBatchChunks(env.OPEN_BRAIN_DB, [
    env.OPEN_BRAIN_DB.prepare(
      `UPDATE memories
       SET current_version = ?, last_accessed_at = ?, actor_type = ?, actor_id = ?, confidence_score = ?,
           revised_at = ?, updated_at = ?, content_hash = ?
       WHERE tenant_id = ? AND id = ?`
    ).bind(
      version,
      now,
      args.actorType ?? existing.actor_type,
      args.actorId ?? existing.actor_id,
      nextConfidence,
      now,
      now,
      contentHash,
      args.tenantId,
      existing.id
    ),
    buildVersionInsert(env, {
      tenantId: args.tenantId,
      memoryId: existing.id,
      version,
      operation: "refresh",
      snapshot: normalizeWriteItem(args.tenantId, existing.source, {
        ...v2FieldsFromStored(existing),
        external_key: existing.external_key,
        content: existing.content,
        summary: existing.summary,
        tags: parseStoredTags(existing.tags_json),
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
      }),
      contentHash
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
    ...v2FieldsFromStored(existing),
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

export async function restoreSuppressedMemory(
  env: Env,
  args: {
    tenantId: string;
    memoryId: string;
    restoreVersion?: number;
    actorType?: string | null;
    actorId?: string | null;
  }
): Promise<LifecycleMutationResult> {
  const existing = await loadMemoryById(env, args.tenantId, args.memoryId);
  if (normalizeLifecycleState(existing.lifecycle_state) !== "suppressed") {
    throw new HttpError(409, "memory_not_suppressed", "Only a suppressed memory can be restored");
  }
  const restorePoint = args.restoreVersion === undefined
    ? null
    : await env.OPEN_BRAIN_DB.prepare(
        `SELECT summary, tags_json FROM memory_versions
         WHERE tenant_id = ? AND memory_id = ? AND version = ?`
      ).bind(args.tenantId, args.memoryId, args.restoreVersion).first<{
        summary: string | null;
        tags_json: string | null;
      }>();
  if (args.restoreVersion !== undefined && !restorePoint) {
    throw new HttpError(409, "restore_point_missing", "The pre-suppression memory version is unavailable");
  }
  const tags = restorePoint
    ? parseStoredTags(restorePoint.tags_json)
    : parseStoredTags(existing.tags_json).filter((tag) => tag !== "compacted");
  const version = (existing.current_version ?? 0) + 1;
  const snapshot = normalizeWriteItem(args.tenantId, existing.source, {
    ...v2FieldsFromStored(existing),
    external_key: existing.external_key,
    content: existing.content,
    summary: restorePoint ? restorePoint.summary : existing.summary,
    tags,
    created_at: Date.now(),
    project_id: existing.project_id,
    actor_type: args.actorType ?? existing.actor_type,
    actor_id: args.actorId ?? existing.actor_id,
    kind: normalizeMemoryKind(existing.kind),
    lifecycle_state: "active",
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
  await env.OPEN_BRAIN_DB.prepare(
    "UPDATE memory_versions SET operation = ? WHERE tenant_id = ? AND memory_id = ? AND version = ?"
  ).bind("revise", args.tenantId, existing.id, version).run();

  return {
    tenant_id: args.tenantId,
    memory_id: existing.id,
    version,
    operation: "revise",
    created: false,
    kind: snapshot.kind,
    lifecycle_state: "active"
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

export async function deleteMemory(
  env: Env,
  args: {
    tenantId: string;
    memoryId: string;
    actorType?: string | null;
    actorId?: string | null;
  }
): Promise<LifecycleMutationResult> {
  const existing = await loadMemoryById(env, args.tenantId, args.memoryId);
  const version = (existing.current_version ?? 1) + 1;
  await runBatchChunks(env.OPEN_BRAIN_DB, [
    env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO memory_deletions(id, tenant_id, memory_id, actor_type, actor_id, deleted_at)
       VALUES(?,?,?,?,?,?)`
    ).bind(ulid(), args.tenantId, args.memoryId, args.actorType ?? null, args.actorId ?? null, Date.now()),
    env.OPEN_BRAIN_DB.prepare(
      `DELETE FROM decision_evidence
       WHERE tenant_id = ? AND rationale_id IN (
         SELECT id FROM decision_rationales WHERE tenant_id = ? AND memory_id = ?
       )`
    ).bind(args.tenantId, args.tenantId, args.memoryId),
    env.OPEN_BRAIN_DB.prepare("DELETE FROM decision_rationales WHERE tenant_id = ? AND memory_id = ?").bind(
      args.tenantId,
      args.memoryId
    ),
    env.OPEN_BRAIN_DB.prepare("DELETE FROM memory_entities WHERE tenant_id = ? AND memory_id = ?").bind(
      args.tenantId,
      args.memoryId
    ),
    env.OPEN_BRAIN_DB.prepare(
      "DELETE FROM memory_edges WHERE tenant_id = ? AND (from_memory_id = ? OR to_memory_id = ?)"
    ).bind(args.tenantId, args.memoryId, args.memoryId),
    env.OPEN_BRAIN_DB.prepare("DELETE FROM memories_fts WHERE tenant_id = ? AND memory_id = ?").bind(
      args.tenantId,
      args.memoryId
    ),
    env.OPEN_BRAIN_DB.prepare(
      "DELETE FROM memory_retrieval_units_fts WHERE tenant_id = ? AND memory_id = ?"
    ).bind(args.tenantId, args.memoryId),
    env.OPEN_BRAIN_DB.prepare(
      "DELETE FROM memory_retrieval_units WHERE tenant_id = ? AND memory_id = ?"
    ).bind(args.tenantId, args.memoryId),
    env.OPEN_BRAIN_DB.prepare(
      "DELETE FROM memory_retrieval_units_v4_fts WHERE tenant_id = ? AND memory_id = ?"
    ).bind(args.tenantId, args.memoryId),
    env.OPEN_BRAIN_DB.prepare(
      "DELETE FROM memory_retrieval_units_v4 WHERE tenant_id = ? AND memory_id = ?"
    ).bind(args.tenantId, args.memoryId),
    env.OPEN_BRAIN_DB.prepare(
      `DELETE FROM retrieval_units_fts WHERE tenant_id = ? AND unit_id IN (
         SELECT id FROM retrieval_units
         WHERE tenant_id = ? AND source_type = 'memory' AND source_id = ?
       )`
    ).bind(args.tenantId, args.tenantId, args.memoryId),
    env.OPEN_BRAIN_DB.prepare(
      "DELETE FROM retrieval_units WHERE tenant_id = ? AND source_type = 'memory' AND source_id = ?"
    ).bind(args.tenantId, args.memoryId),
    env.OPEN_BRAIN_DB.prepare(
      `DELETE FROM memory_effect_attributions WHERE tenant_id = ? AND usage_item_id IN (
         SELECT id FROM memory_usage_items
         WHERE tenant_id = ? AND source_type = 'memory' AND source_id = ?
       )`
    ).bind(args.tenantId, args.tenantId, args.memoryId),
    env.OPEN_BRAIN_DB.prepare(
      "DELETE FROM memory_usage_items WHERE tenant_id = ? AND source_type = 'memory' AND source_id = ?"
    ).bind(args.tenantId, args.memoryId),
    env.OPEN_BRAIN_DB.prepare(
      `DELETE FROM memory_effect_attributions
       WHERE tenant_id = ? AND effect_event_id IN (
         SELECT e.id FROM memory_effect_events e
         WHERE e.tenant_id = ? AND NOT EXISTS (
           SELECT 1 FROM memory_usage_items ui
           WHERE ui.tenant_id = e.tenant_id AND ui.usage_event_id = e.usage_event_id
         )
       )`
    ).bind(args.tenantId, args.tenantId),
    env.OPEN_BRAIN_DB.prepare(
      `DELETE FROM memory_effect_events
       WHERE tenant_id = ? AND NOT EXISTS (
         SELECT 1 FROM memory_usage_items ui
         WHERE ui.tenant_id = memory_effect_events.tenant_id
           AND ui.usage_event_id = memory_effect_events.usage_event_id
       )`
    ).bind(args.tenantId),
    env.OPEN_BRAIN_DB.prepare(
      `DELETE FROM memory_usage_events
       WHERE tenant_id = ? AND NOT EXISTS (
         SELECT 1 FROM memory_usage_items ui
         WHERE ui.tenant_id = memory_usage_events.tenant_id
           AND ui.usage_event_id = memory_usage_events.id
       )`
    ).bind(args.tenantId),
    env.OPEN_BRAIN_DB.prepare(
      "DELETE FROM memory_effect_daily_metrics WHERE tenant_id = ? AND source_type = 'memory' AND source_id = ?"
    ).bind(args.tenantId, args.memoryId),
    env.OPEN_BRAIN_DB.prepare("DELETE FROM memory_versions WHERE tenant_id = ? AND memory_id = ?").bind(
      args.tenantId,
      args.memoryId
    ),
    env.OPEN_BRAIN_DB.prepare("DELETE FROM memories WHERE tenant_id = ? AND id = ?").bind(
      args.tenantId,
      args.memoryId
    )
  ]);
  return {
    tenant_id: args.tenantId,
    memory_id: args.memoryId,
    version,
    operation: "delete",
    created: false,
    kind: normalizeMemoryKind(existing.kind),
    lifecycle_state: normalizeLifecycleState(existing.lifecycle_state)
  };
}
