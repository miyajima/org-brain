import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  embedLocalText,
  LOCAL_EMBEDDING_PROVIDER,
  localEmbeddingText
} from "./local-embedding.mjs";
import {
  analyzeRetrievalIntent,
  buildRetrievalUnits,
  retrievalQueryTokens,
  retrievalUnitLexicalSpecificity,
  retrievalUnitIntentBoost
} from "./retrieval-units.mjs";

export const MEMORY_SCHEMA_VERSION = 16;
export const DEFAULT_LOCAL_DB = join(homedir(), ".org-brain", "memory.sqlite");

const JSON_COLUMNS = [
  "tags_json",
  "entities_json",
  "source_refs_json",
  "evidence_json",
  "conflicts_json",
  "permissions_json"
];

const MEMORY_COLUMNS = {
  tenant_id: "TEXT NOT NULL DEFAULT 'default'",
  project_id: "TEXT",
  kind: "TEXT NOT NULL DEFAULT 'episodic'",
  lifecycle_state: "TEXT NOT NULL DEFAULT 'active'",
  scope_type: "TEXT NOT NULL DEFAULT 'project'",
  scope_key: "TEXT",
  content: "TEXT NOT NULL DEFAULT ''",
  summary: "TEXT",
  tags_json: "TEXT NOT NULL DEFAULT '[]'",
  entities_json: "TEXT NOT NULL DEFAULT '[]'",
  source: "TEXT NOT NULL DEFAULT 'local'",
  source_refs_json: "TEXT NOT NULL DEFAULT '[]'",
  external_key: "TEXT",
  actor_type: "TEXT",
  actor_id: "TEXT",
  created_at: "INTEGER NOT NULL DEFAULT 0",
  updated_at: "INTEGER NOT NULL DEFAULT 0",
  valid_from: "INTEGER",
  valid_until: "INTEGER",
  confidence_score: "REAL",
  utility_score: "REAL",
  content_hash: "TEXT NOT NULL DEFAULT ''",
  current_version: "INTEGER NOT NULL DEFAULT 1",
  rationale: "TEXT",
  evidence_json: "TEXT NOT NULL DEFAULT '[]'",
  conflicts_json: "TEXT NOT NULL DEFAULT '[]'",
  permissions_json: "TEXT NOT NULL DEFAULT '[]'",
  canonical_key: "TEXT",
  root_memory_id: "TEXT",
  last_accessed_at: "INTEGER",
  suppressed_at: "INTEGER",
  consolidated_at: "INTEGER",
  promoted_at: "INTEGER",
  expires_at: "INTEGER",
  revised_at: "INTEGER"
};

function hashContent(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function stableDigest(rows) {
  const hash = createHash("sha256");
  for (const row of rows) {
    hash.update(`${row.id}\0${row.content_hash || hashContent(row.content)}\0`);
  }
  return hash.digest("hex");
}

function parseJson(raw, fallback = []) {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function normalizeStrings(value, limit = 64) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))].slice(0, limit);
}

function normalizeObjects(value, limit = 64) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item === "object" && !Array.isArray(item)).slice(0, limit);
}

function json(value) {
  return JSON.stringify(value ?? []);
}

function nullableString(value, maxLength = 20_000) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function memoryFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    project_id: row.project_id,
    kind: row.kind,
    lifecycle_state: row.lifecycle_state,
    scope_type: row.scope_type,
    scope_key: row.scope_key,
    content: row.content,
    summary: row.summary,
    tags: parseJson(row.tags_json),
    entities: parseJson(row.entities_json),
    source: row.source,
    source_references: parseJson(row.source_refs_json),
    external_key: row.external_key,
    actor_type: row.actor_type,
    actor_id: row.actor_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    valid_from: row.valid_from,
    valid_until: row.valid_until,
    confidence_score: row.confidence_score,
    utility_score: row.utility_score,
    content_hash: row.content_hash,
    current_version: row.current_version,
    rationale: row.rationale,
    evidence: parseJson(row.evidence_json),
    conflicts: parseJson(row.conflicts_json),
    permissions: parseJson(row.permissions_json)
  };
}

function canReadMemory(record, principalId) {
  if (!principalId || record.permissions.length === 0) return true;
  return record.permissions.some(
    (entry) =>
      entry.principal_id === principalId &&
      Array.isArray(entry.permissions) &&
      (entry.permissions.includes("read") || entry.permissions.includes("admin"))
  );
}

async function enforcePrivatePermissions(dbPath) {
  const directory = dirname(dbPath);
  const directoryExisted = existsSync(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!directoryExisted) await chmod(directory, 0o700);
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(path)) await chmod(path, 0o600);
  }
}

function hasTable(db, table) {
  return Boolean(
    db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(table)
  );
}

function tableColumns(db, table) {
  if (!hasTable(db, table)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((row) => row.name));
}

function createCanonicalTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      project_id TEXT,
      kind TEXT NOT NULL DEFAULT 'episodic',
      lifecycle_state TEXT NOT NULL DEFAULT 'active',
      scope_type TEXT NOT NULL DEFAULT 'project',
      scope_key TEXT,
      content TEXT NOT NULL,
      summary TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      entities_json TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'local',
      source_refs_json TEXT NOT NULL DEFAULT '[]',
      external_key TEXT,
      actor_type TEXT,
      actor_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      valid_from INTEGER,
      valid_until INTEGER,
      confidence_score REAL,
      utility_score REAL,
      content_hash TEXT NOT NULL,
      current_version INTEGER NOT NULL DEFAULT 1,
      rationale TEXT,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      conflicts_json TEXT NOT NULL DEFAULT '[]',
      permissions_json TEXT NOT NULL DEFAULT '[]',
      canonical_key TEXT,
      root_memory_id TEXT,
      last_accessed_at INTEGER,
      suppressed_at INTEGER,
      consolidated_at INTEGER,
      promoted_at INTEGER,
      expires_at INTEGER,
      revised_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS memory_versions (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      operation TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(tenant_id, memory_id, version)
    );
    CREATE TABLE IF NOT EXISTS memory_edges (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      from_memory_id TEXT NOT NULL,
      to_memory_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_deletions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      actor_type TEXT,
      actor_id TEXT,
      deleted_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_embeddings (
      memory_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      feature_count INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(tenant_id, memory_id)
    );
    CREATE TABLE IF NOT EXISTS memory_embedding_features (
      memory_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      feature_hash INTEGER NOT NULL,
      weight REAL NOT NULL,
      PRIMARY KEY(tenant_id, memory_id, feature_hash)
    );
    CREATE TABLE IF NOT EXISTS memory_embedding_feature_stats (
      tenant_id TEXT NOT NULL,
      feature_hash INTEGER NOT NULL,
      document_count INTEGER NOT NULL,
      PRIMARY KEY(tenant_id, feature_hash)
    );
    CREATE TABLE IF NOT EXISTS memory_retrieval_units (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      project_id TEXT,
      unit_type TEXT NOT NULL,
      speaker TEXT,
      text TEXT NOT NULL,
      event_at INTEGER,
      valid_from INTEGER,
      valid_until INTEGER,
      source_ref_json TEXT,
      source_span_start INTEGER,
      source_span_end INTEGER,
      content_hash TEXT NOT NULL,
      extractor TEXT NOT NULL,
      extractor_version TEXT NOT NULL,
      extraction_state TEXT NOT NULL DEFAULT 'degraded',
      degraded_reason TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_retrieval_unit_embeddings (
      unit_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      feature_count INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(tenant_id, unit_id)
    );
    CREATE TABLE IF NOT EXISTS memory_retrieval_unit_features (
      unit_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      feature_hash INTEGER NOT NULL,
      weight REAL NOT NULL,
      PRIMARY KEY(tenant_id, unit_id, feature_hash)
    );
    CREATE TABLE IF NOT EXISTS memory_retrieval_unit_feature_stats (
      tenant_id TEXT NOT NULL,
      feature_hash INTEGER NOT NULL,
      document_count INTEGER NOT NULL,
      PRIMARY KEY(tenant_id, feature_hash)
    );
    CREATE TABLE IF NOT EXISTS principal_role_assignments (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      project_id TEXT,
      principal TEXT NOT NULL,
      role TEXT NOT NULL,
      created_by_principal TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scoped_tokens (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      principal TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      scopes_json TEXT NOT NULL,
      project_id TEXT,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER,
      rotated_from_id TEXT,
      created_by_principal TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      project_id TEXT,
      principal TEXT NOT NULL,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      outcome TEXT NOT NULL,
      request_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      previous_hash TEXT NOT NULL,
      entry_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS retention_policies (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      project_id TEXT,
      retention_days INTEGER NOT NULL,
      legal_hold INTEGER NOT NULL DEFAULT 0,
      updated_by_principal TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
}

function upgradeLegacyMemories(db) {
  const columns = tableColumns(db, "memories");
  for (const [name, definition] of Object.entries(MEMORY_COLUMNS)) {
    if (!columns.has(name)) db.exec(`ALTER TABLE memories ADD COLUMN "${name}" ${definition}`);
  }

  const now = Date.now();
  db.prepare(
    `UPDATE memories
     SET tenant_id = COALESCE(NULLIF(tenant_id, ''), 'default'),
         kind = COALESCE(NULLIF(kind, ''), 'episodic'),
         lifecycle_state = COALESCE(NULLIF(lifecycle_state, ''), 'active'),
         scope_type = COALESCE(NULLIF(scope_type, ''), CASE WHEN project_id IS NULL THEN 'tenant' ELSE 'project' END),
         scope_key = COALESCE(scope_key, project_id, tenant_id),
         tags_json = COALESCE(NULLIF(tags_json, ''), '[]'),
         entities_json = COALESCE(NULLIF(entities_json, ''), '[]'),
         source_refs_json = COALESCE(NULLIF(source_refs_json, ''), '[]'),
         evidence_json = COALESCE(NULLIF(evidence_json, ''), '[]'),
         conflicts_json = COALESCE(NULLIF(conflicts_json, ''), '[]'),
         permissions_json = COALESCE(NULLIF(permissions_json, ''), '[]'),
         created_at = CASE WHEN created_at = 0 THEN ? ELSE created_at END,
         updated_at = CASE WHEN updated_at = 0 THEN created_at ELSE updated_at END,
         root_memory_id = COALESCE(root_memory_id, id),
         revised_at = COALESCE(revised_at, created_at)`
  ).run(now);

  const missingHashes = db.prepare("SELECT id, content FROM memories WHERE content_hash = ''").all();
  const updateHash = db.prepare("UPDATE memories SET content_hash = ? WHERE id = ?");
  for (const row of missingHashes) updateHash.run(hashContent(row.content), row.id);
}

function rebuildFts(db) {
  db.exec("DROP TABLE IF EXISTS memories_fts");
  db.exec(`
    CREATE VIRTUAL TABLE memories_fts USING fts5(
      memory_id UNINDEXED,
      tenant_id UNINDEXED,
      content,
      summary,
      tags,
      entities,
      tokenize = 'unicode61'
    )
  `);
  db.exec(`
    INSERT INTO memories_fts(memory_id, tenant_id, content, summary, tags, entities)
    SELECT id, tenant_id, content, COALESCE(summary, ''), tags_json, entities_json
    FROM memories
    WHERE lifecycle_state != 'suppressed'
  `);
}

function rebuildRetrievalUnitsFts(db) {
  db.exec("DROP TABLE IF EXISTS memory_retrieval_units_fts");
  db.exec(`
    CREATE VIRTUAL TABLE memory_retrieval_units_fts USING fts5(
      unit_id UNINDEXED,
      memory_id UNINDEXED,
      tenant_id UNINDEXED,
      text,
      tokenize = 'unicode61'
    )
  `);
  db.exec(`
    INSERT INTO memory_retrieval_units_fts(unit_id, memory_id, tenant_id, text)
    SELECT id, memory_id, tenant_id, text
    FROM memory_retrieval_units
  `);
}

function deleteLocalEmbedding(db, tenantId, memoryId) {
  const oldFeatures = db.prepare(
    "SELECT feature_hash FROM memory_embedding_features WHERE tenant_id = ? AND memory_id = ?"
  ).all(tenantId, memoryId);
  db.prepare("DELETE FROM memory_embedding_features WHERE tenant_id = ? AND memory_id = ?")
    .run(tenantId, memoryId);
  db.prepare("DELETE FROM memory_embeddings WHERE tenant_id = ? AND memory_id = ?")
    .run(tenantId, memoryId);
  const decrement = db.prepare(
    `UPDATE memory_embedding_feature_stats
     SET document_count = document_count - 1
     WHERE tenant_id = ? AND feature_hash = ?`
  );
  const removeEmpty = db.prepare(
    `DELETE FROM memory_embedding_feature_stats
     WHERE tenant_id = ? AND feature_hash = ? AND document_count <= 0`
  );
  for (const feature of oldFeatures) {
    decrement.run(tenantId, feature.feature_hash);
    removeEmpty.run(tenantId, feature.feature_hash);
  }
}

function writeLocalEmbedding(db, record) {
  deleteLocalEmbedding(db, record.tenant_id, record.id);
  if (record.lifecycle_state === "suppressed") return;
  const features = embedLocalText(localEmbeddingText(record));
  const insertFeature = db.prepare(
    "INSERT INTO memory_embedding_features(memory_id, tenant_id, feature_hash, weight) VALUES(?,?,?,?)"
  );
  const incrementFeatureCount = db.prepare(
    `INSERT INTO memory_embedding_feature_stats(tenant_id, feature_hash, document_count)
     VALUES(?,?,1)
     ON CONFLICT(tenant_id, feature_hash)
     DO UPDATE SET document_count = document_count + 1`
  );
  for (const feature of features) {
    insertFeature.run(record.id, record.tenant_id, feature.feature_hash, feature.weight);
    incrementFeatureCount.run(record.tenant_id, feature.feature_hash);
  }
  db.prepare(
    `INSERT INTO memory_embeddings(memory_id, tenant_id, provider, feature_count, updated_at)
     VALUES(?,?,?,?,?)`
  ).run(record.id, record.tenant_id, LOCAL_EMBEDDING_PROVIDER, features.length, record.updated_at);
}

function rebuildLocalEmbeddings(db) {
  db.prepare("DELETE FROM memory_embedding_features").run();
  db.prepare("DELETE FROM memory_embeddings").run();
  db.prepare("DELETE FROM memory_embedding_feature_stats").run();
  const rows = db.prepare("SELECT * FROM memories WHERE lifecycle_state != 'suppressed'").all();
  for (const row of rows) writeLocalEmbedding(db, memoryFromRow(row));
}

function deleteRetrievalUnitEmbedding(db, tenantId, unitId) {
  const oldFeatures = db.prepare(
    "SELECT feature_hash FROM memory_retrieval_unit_features WHERE tenant_id = ? AND unit_id = ?"
  ).all(tenantId, unitId);
  db.prepare("DELETE FROM memory_retrieval_unit_features WHERE tenant_id = ? AND unit_id = ?")
    .run(tenantId, unitId);
  db.prepare("DELETE FROM memory_retrieval_unit_embeddings WHERE tenant_id = ? AND unit_id = ?")
    .run(tenantId, unitId);
  const decrement = db.prepare(
    `UPDATE memory_retrieval_unit_feature_stats
     SET document_count = document_count - 1
     WHERE tenant_id = ? AND feature_hash = ?`
  );
  const removeEmpty = db.prepare(
    `DELETE FROM memory_retrieval_unit_feature_stats
     WHERE tenant_id = ? AND feature_hash = ? AND document_count <= 0`
  );
  for (const feature of oldFeatures) {
    decrement.run(tenantId, feature.feature_hash);
    removeEmpty.run(tenantId, feature.feature_hash);
  }
}

function writeRetrievalUnitEmbedding(db, unit) {
  deleteRetrievalUnitEmbedding(db, unit.tenant_id, unit.id);
  const features = embedLocalText(unit.text);
  const insertFeature = db.prepare(
    `INSERT INTO memory_retrieval_unit_features(unit_id, tenant_id, feature_hash, weight)
     VALUES(?,?,?,?)`
  );
  const incrementFeatureCount = db.prepare(
    `INSERT INTO memory_retrieval_unit_feature_stats(tenant_id, feature_hash, document_count)
     VALUES(?,?,1)
     ON CONFLICT(tenant_id, feature_hash)
     DO UPDATE SET document_count = document_count + 1`
  );
  for (const feature of features) {
    insertFeature.run(unit.id, unit.tenant_id, feature.feature_hash, feature.weight);
    incrementFeatureCount.run(unit.tenant_id, feature.feature_hash);
  }
  db.prepare(
    `INSERT INTO memory_retrieval_unit_embeddings(unit_id, tenant_id, provider, feature_count, updated_at)
     VALUES(?,?,?,?,?)`
  ).run(unit.id, unit.tenant_id, LOCAL_EMBEDDING_PROVIDER, features.length, unit.created_at);
}

function deleteRetrievalUnits(db, tenantId, memoryId) {
  const units = db.prepare(
    "SELECT id FROM memory_retrieval_units WHERE tenant_id = ? AND memory_id = ?"
  ).all(tenantId, memoryId);
  for (const unit of units) deleteRetrievalUnitEmbedding(db, tenantId, unit.id);
  db.prepare("DELETE FROM memory_retrieval_units_fts WHERE tenant_id = ? AND memory_id = ?")
    .run(tenantId, memoryId);
  db.prepare("DELETE FROM memory_retrieval_units WHERE tenant_id = ? AND memory_id = ?")
    .run(tenantId, memoryId);
}

function writeRetrievalUnits(db, record) {
  deleteRetrievalUnits(db, record.tenant_id, record.id);
  if (record.lifecycle_state === "suppressed") return;
  const units = buildRetrievalUnits(record);
  const insertUnit = db.prepare(
    `INSERT INTO memory_retrieval_units(
      id, memory_id, tenant_id, project_id, unit_type, speaker, text, event_at,
      valid_from, valid_until, source_ref_json, source_span_start, source_span_end,
      content_hash, extractor, extractor_version, extraction_state, degraded_reason, created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const insertFts = db.prepare(
    `INSERT INTO memory_retrieval_units_fts(unit_id, memory_id, tenant_id, text)
     VALUES(?,?,?,?)`
  );
  for (const unit of units) {
    insertUnit.run(
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
    );
    insertFts.run(unit.id, unit.memory_id, unit.tenant_id, unit.text);
    writeRetrievalUnitEmbedding(db, unit);
  }
}

function rebuildRetrievalUnits(db) {
  db.prepare("DELETE FROM memory_retrieval_unit_features").run();
  db.prepare("DELETE FROM memory_retrieval_unit_embeddings").run();
  db.prepare("DELETE FROM memory_retrieval_unit_feature_stats").run();
  db.prepare("DELETE FROM memory_retrieval_units").run();
  rebuildRetrievalUnitsFts(db);
  const rows = db.prepare("SELECT * FROM memories WHERE lifecycle_state != 'suppressed'").all();
  for (const row of rows) writeRetrievalUnits(db, memoryFromRow(row));
}

function addIndexes(db) {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_external_key_v2
      ON memories(tenant_id, source, external_key)
      WHERE external_key IS NOT NULL AND external_key != '';
    CREATE INDEX IF NOT EXISTS idx_memories_tenant_project_updated
      ON memories(tenant_id, project_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_lifecycle_updated
      ON memories(tenant_id, lifecycle_state, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_versions_created_v2
      ON memory_versions(tenant_id, memory_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_edges_from_v2
      ON memory_edges(tenant_id, from_memory_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_deletions_memory
      ON memory_deletions(tenant_id, memory_id, deleted_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_principal_role_identity
      ON principal_role_assignments(tenant_id, COALESCE(project_id, ''), principal, role);
    CREATE INDEX IF NOT EXISTS idx_principal_role_lookup
      ON principal_role_assignments(tenant_id, principal, project_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_scoped_tokens_hash
      ON scoped_tokens(token_hash);
    CREATE INDEX IF NOT EXISTS idx_scoped_tokens_active
      ON scoped_tokens(tenant_id, principal, expires_at, revoked_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_events_hash
      ON audit_events(tenant_id, entry_hash);
    CREATE INDEX IF NOT EXISTS idx_audit_events_created
      ON audit_events(tenant_id, created_at, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_retention_policy_scope
      ON retention_policies(tenant_id, COALESCE(project_id, ''));
    CREATE INDEX IF NOT EXISTS idx_memory_embedding_lookup
      ON memory_embedding_features(tenant_id, feature_hash, memory_id);
    CREATE INDEX IF NOT EXISTS idx_retrieval_units_parent
      ON memory_retrieval_units(tenant_id, memory_id, unit_type);
    CREATE INDEX IF NOT EXISTS idx_retrieval_units_project
      ON memory_retrieval_units(tenant_id, project_id, unit_type);
    CREATE INDEX IF NOT EXISTS idx_retrieval_unit_feature_lookup
      ON memory_retrieval_unit_features(tenant_id, feature_hash, unit_id);
  `);
}

function initializeVersionHistory(db) {
  const rows = db.prepare(
    `SELECT m.*
     FROM memories m
     WHERE NOT EXISTS (
       SELECT 1 FROM memory_versions v
       WHERE v.tenant_id = m.tenant_id AND v.memory_id = m.id
     )`
  ).all();
  const insert = db.prepare(
    `INSERT INTO memory_versions(
      id, memory_id, tenant_id, version, operation, snapshot_json, content_hash, created_at
    ) VALUES(?,?,?,?,?,?,?,?)`
  );
  for (const row of rows) {
    const memory = memoryFromRow(row);
    insert.run(randomUUID(), row.id, row.tenant_id, row.current_version || 1, "capture", JSON.stringify(memory), row.content_hash, row.updated_at);
  }
}

function migrateSchema(db) {
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
  db.exec("BEGIN IMMEDIATE");
  try {
    createCanonicalTables(db);
    upgradeLegacyMemories(db);
    addIndexes(db);
    rebuildFts(db);
    rebuildLocalEmbeddings(db);
    rebuildRetrievalUnits(db);
    initializeVersionHistory(db);
    db.prepare("INSERT OR REPLACE INTO schema_migrations(version, applied_at) VALUES(?,?)").run(
      MEMORY_SCHEMA_VERSION,
      Date.now()
    );
    db.exec(`PRAGMA user_version = ${MEMORY_SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function buildFtsQuery(query, operator = "AND") {
  const tokens = retrievalQueryTokens(query)
    .map((token) => token.replaceAll('"', ""))
    .slice(0, 16);
  return tokens.map((token) => `"${token}"*`).join(` ${operator} `);
}

function relativeWeekdayAgeMs(referenceAt, weekday) {
  if (!Number.isInteger(weekday)) return null;
  const deltaDays = (new Date(referenceAt).getUTCDay() - weekday + 7) % 7 || 7;
  return deltaDays * 24 * 60 * 60 * 1000;
}

function searchRetrievalUnitsV3(db, {
  tenantId,
  projectId,
  query,
  limit,
  includeSuppressed,
  principalId,
  at
}) {
  const candidateLimit = 50;
  const temporalCandidateLimit = 200;
  const intent = analyzeRetrievalIntent(query);
  const relativeAgeMs =
    intent.relative_age_ms ?? relativeWeekdayAgeMs(at, intent.relative_weekday);
  const relativeTargetAt = relativeAgeMs === null ? null : at - relativeAgeMs;
  const ftsQuery = buildFtsQuery(query, "OR");
  const lexicalRows = ftsQuery
    ? db.prepare(
      `SELECT u.*, bm25(memory_retrieval_units_fts) AS raw_rank
       FROM memory_retrieval_units_fts
       JOIN memory_retrieval_units u
         ON u.id = memory_retrieval_units_fts.unit_id
        AND u.tenant_id = memory_retrieval_units_fts.tenant_id
       JOIN memories m
         ON m.id = u.memory_id
        AND m.tenant_id = u.tenant_id
       WHERE memory_retrieval_units_fts.tenant_id = ?
         AND memory_retrieval_units_fts MATCH ?
         AND (? IS NULL OR u.project_id = ?)
         AND (? = 1 OR m.lifecycle_state != 'suppressed')
         AND (u.valid_from IS NULL OR u.valid_from <= ?)
         AND (u.valid_until IS NULL OR u.valid_until > ?)
       ORDER BY bm25(memory_retrieval_units_fts) ASC,
                u.content_hash ASC,
                COALESCE(u.event_at, u.created_at) ASC
       LIMIT ?`
    ).all(
      tenantId,
      ftsQuery,
      projectId,
      projectId,
      includeSuppressed ? 1 : 0,
      at,
      at,
      candidateLimit
    )
    : [];
  const relativeWindowMs =
    relativeAgeMs === null
      ? null
      : intent.relative_weekday !== null
        ? 24 * 60 * 60 * 1000
        : Math.max(24 * 60 * 60 * 1000, Math.min(30 * 24 * 60 * 60 * 1000, relativeAgeMs * 0.5));
  const temporalLexicalRows =
    ftsQuery && relativeTargetAt !== null && relativeWindowMs !== null
      ? db.prepare(
        `SELECT u.*, bm25(memory_retrieval_units_fts) AS raw_rank
         FROM memory_retrieval_units_fts
         JOIN memory_retrieval_units u
           ON u.id = memory_retrieval_units_fts.unit_id
          AND u.tenant_id = memory_retrieval_units_fts.tenant_id
         JOIN memories m
           ON m.id = u.memory_id
          AND m.tenant_id = u.tenant_id
         WHERE memory_retrieval_units_fts.tenant_id = ?
           AND memory_retrieval_units_fts MATCH ?
           AND (? IS NULL OR u.project_id = ?)
           AND (? = 1 OR m.lifecycle_state != 'suppressed')
           AND (u.valid_from IS NULL OR u.valid_from <= ?)
           AND (u.valid_until IS NULL OR u.valid_until > ?)
           AND ABS(COALESCE(u.event_at, u.created_at) - ?) <= ?
         ORDER BY ABS(COALESCE(u.event_at, u.created_at) - ?) ASC,
                  bm25(memory_retrieval_units_fts) ASC,
                  u.content_hash ASC,
                  COALESCE(u.event_at, u.created_at) ASC
         LIMIT ?`
      ).all(
        tenantId,
        ftsQuery,
        projectId,
        projectId,
        includeSuppressed ? 1 : 0,
        at,
        at,
        relativeTargetAt,
        relativeWindowMs,
        relativeTargetAt,
        candidateLimit
      )
      : [];

  const temporalRows = relativeTargetAt === null
    ? []
    : db.prepare(
      `SELECT u.*, NULL AS raw_rank
       FROM memory_retrieval_units u
       JOIN memories m
         ON m.id = u.memory_id
        AND m.tenant_id = u.tenant_id
       WHERE u.tenant_id = ?
         AND u.unit_type = 'session'
         AND (? IS NULL OR u.project_id = ?)
         AND (? = 1 OR m.lifecycle_state != 'suppressed')
         AND (u.valid_from IS NULL OR u.valid_from <= ?)
         AND (u.valid_until IS NULL OR u.valid_until > ?)
       ORDER BY ABS(COALESCE(u.event_at, u.created_at) - ?) ASC
       LIMIT ?`
    ).all(
      tenantId,
      projectId,
      projectId,
      includeSuppressed ? 1 : 0,
      at,
      at,
      relativeTargetAt,
      temporalCandidateLimit
    );

  const rawQueryFeatures = embedLocalText(query);
  let queryFeatures = rawQueryFeatures;
  if (rawQueryFeatures.length > 0) {
    const placeholders = rawQueryFeatures.map(() => "?").join(",");
    const counts = db.prepare(
      `SELECT feature_hash, document_count
       FROM memory_retrieval_unit_feature_stats
       WHERE tenant_id = ? AND feature_hash IN (${placeholders})`
    ).all(tenantId, ...rawQueryFeatures.map((feature) => feature.feature_hash));
    const countByHash = new Map(counts.map((row) => [row.feature_hash, Number(row.document_count)]));
    queryFeatures = rawQueryFeatures
      .filter((feature) => countByHash.has(feature.feature_hash))
      .sort(
        (left, right) =>
          (countByHash.get(left.feature_hash) ?? Infinity) -
          (countByHash.get(right.feature_hash) ?? Infinity)
      )
      .slice(0, 12);
  }
  const semanticScores = new Map();
  const semanticOrderKeys = new Map();
  const featureLookup = db.prepare(
    `SELECT f.unit_id, f.weight, u.content_hash, u.unit_type, u.event_at, u.text
     FROM memory_retrieval_unit_features f
     JOIN memory_retrieval_units u
       ON u.id = f.unit_id
      AND u.tenant_id = f.tenant_id
     WHERE f.tenant_id = ? AND f.feature_hash = ?
     ORDER BY u.content_hash, u.unit_type, COALESCE(u.event_at, u.created_at), u.text
     LIMIT ?`
  );
  for (const feature of queryFeatures) {
    for (const match of featureLookup.all(tenantId, feature.feature_hash, candidateLimit * 20)) {
      semanticOrderKeys.set(
        match.unit_id,
        `${match.content_hash}\0${match.unit_type}\0${match.event_at ?? 0}\0${match.text}`
      );
      semanticScores.set(
        match.unit_id,
        (semanticScores.get(match.unit_id) ?? 0) + Number(match.weight) * feature.weight
      );
    }
  }
  const semanticRows = [...semanticScores.entries()]
    .map(([unitId, score]) => ({ unitId, score }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        String(semanticOrderKeys.get(left.unitId)).localeCompare(String(semanticOrderKeys.get(right.unitId)))
    )
    .slice(0, candidateLimit);
  const unitById = new Map(lexicalRows.map((row) => [row.id, row]));
  for (const row of temporalLexicalRows) unitById.set(row.id, row);
  for (const row of temporalRows) unitById.set(row.id, row);
  const missingUnitIds = semanticRows.map((row) => row.unitId).filter((id) => !unitById.has(id));
  if (missingUnitIds.length > 0) {
    const placeholders = missingUnitIds.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT u.*
       FROM memory_retrieval_units u
       JOIN memories m ON m.id = u.memory_id AND m.tenant_id = u.tenant_id
       WHERE u.tenant_id = ? AND u.id IN (${placeholders})
         AND (? IS NULL OR u.project_id = ?)
         AND (? = 1 OR m.lifecycle_state != 'suppressed')
         AND (u.valid_from IS NULL OR u.valid_from <= ?)
         AND (u.valid_until IS NULL OR u.valid_until > ?)`
    ).all(
      tenantId,
      ...missingUnitIds,
      projectId,
      projectId,
      includeSuppressed ? 1 : 0,
      at,
      at
    );
    for (const row of rows) unitById.set(row.id, row);
  }

  const localSemanticRrfWeight = intent.speaker === "assistant" ? 0.6 : 0.35;
  const fusedByUnit = new Map();
  lexicalRows.forEach((row, index) => {
    fusedByUnit.set(row.id, (fusedByUnit.get(row.id) ?? 0) + 1 / (60 + index + 1));
  });
  temporalLexicalRows.forEach((row, index) => {
    fusedByUnit.set(row.id, (fusedByUnit.get(row.id) ?? 0) + 1 / (60 + index + 1));
  });
  semanticRows.forEach((row, index) => {
    if (!unitById.has(row.unitId)) return;
    fusedByUnit.set(
      row.unitId,
      (fusedByUnit.get(row.unitId) ?? 0) + localSemanticRrfWeight / (60 + index + 1)
    );
  });
  temporalRows.forEach((row, index) => {
    fusedByUnit.set(row.id, (fusedByUnit.get(row.id) ?? 0) + 0.75 / (60 + index + 1));
  });
  const lexicalSpecificity = retrievalUnitLexicalSpecificity([...unitById.values()], query);
  const parentScores = new Map();
  for (const [unitId, baseScore] of fusedByUnit) {
    const unit = unitById.get(unitId);
    if (!unit) continue;
    const current = parentScores.get(unit.memory_id) ?? [];
    current.push({
      unit,
      score: baseScore,
      intentBoost: retrievalUnitIntentBoost(unit, intent),
      lexicalSpecificity: lexicalSpecificity.get(unitId) ?? 0
    });
    parentScores.set(unit.memory_id, current);
  }
  if (parentScores.size === 0) return [];

  const parentIds = [...parentScores.keys()];
  const placeholders = parentIds.map(() => "?").join(",");
  const memories = db.prepare(
    `SELECT * FROM memories WHERE tenant_id = ? AND id IN (${placeholders})`
  ).all(tenantId, ...parentIds);
  const memoryById = new Map(memories.map((row) => [row.id, row]));
  const dated = [...parentScores.entries()].map(([memoryId, units]) => ({
    memoryId,
    eventAt: Math.max(...units.map((entry) => Number(entry.unit.event_at ?? 0)))
  }));
  const minEventAt = Math.min(...dated.map((entry) => entry.eventAt).filter((value) => value > 0));
  const maxEventAt = Math.max(...dated.map((entry) => entry.eventAt));
  const eventRange = Math.max(1, maxEventAt - (Number.isFinite(minEventAt) ? minEventAt : maxEventAt));
  const relativeDistances = relativeTargetAt === null
    ? []
    : dated
      .map((entry) => Math.abs(entry.eventAt - relativeTargetAt))
      .filter(Number.isFinite);
  const minRelativeDistance = relativeDistances.length > 0 ? Math.min(...relativeDistances) : 0;
  const maxRelativeDistance = relativeDistances.length > 0 ? Math.max(...relativeDistances) : 0;
  const relativeDistanceRange = Math.max(1, maxRelativeDistance - minRelativeDistance);

  const ranked = [...parentScores.entries()]
    .flatMap(([memoryId, unitScores]) => {
      const row = memoryById.get(memoryId);
      if (!row) return [];
      const memory = memoryFromRow(row);
      if (!canReadMemory(memory, principalId)) return [];
      const sorted = unitScores.sort((left, right) => right.score - left.score);
      let total = (sorted[0]?.score ?? 0) + (sorted[1]?.score ?? 0) * 0.25 + (sorted[2]?.score ?? 0) * 0.1;
      total += Math.max(0, ...sorted.map((entry) => entry.intentBoost));
      total += Math.max(0, ...sorted.map((entry) => entry.lexicalSpecificity)) * 0.02;
      const eventAt = Math.max(...sorted.map((entry) => Number(entry.unit.event_at ?? 0)));
      if (relativeTargetAt !== null && eventAt > 0) {
        const distance = Math.abs(eventAt - relativeTargetAt);
        total += (1 - (distance - minRelativeDistance) / relativeDistanceRange) * 0.02;
      } else if (intent.temporal_direction && eventAt > 0 && Number.isFinite(minEventAt)) {
        const relative = (eventAt - minEventAt) / eventRange;
        total += intent.temporal_direction === "latest" ? relative * 0.006 : (1 - relative) * 0.006;
      }
      return [{
        memory,
        score: {
          total: Number(total.toFixed(6)),
          lexical: lexicalRows.some((unit) => unit.memory_id === memoryId) ? 1 : 0,
          semantic: semanticRows.some((unit) => unitById.get(unit.unitId)?.memory_id === memoryId) ? 1 : 0,
          graph: 0,
          time: intent.temporal_direction || relativeTargetAt !== null ? 1 : 0,
          authority: Number(memory.confidence_score ?? 0.5),
          utility: Number(memory.utility_score ?? 0.5)
        }
      }];
    })
    .sort(
      (left, right) =>
        right.score.total - left.score.total ||
        right.memory.updated_at - left.memory.updated_at ||
        String(left.memory.source_references[0]?.ref ?? "").localeCompare(
          String(right.memory.source_references[0]?.ref ?? "")
        )
    );
  const selected = ranked.slice(0, limit);
  if (relativeTargetAt !== null) {
    const reservedMemoryIds = [...new Set(
      [
        ...temporalLexicalRows,
        ...temporalRows
      ].map((row) => row.memory_id)
    )].slice(0, 4);
    let replacementIndex = selected.length - 1;
    for (const memoryId of reservedMemoryIds) {
      if (selected.some((entry) => entry.memory.id === memoryId)) continue;
      const reserved = ranked.find((entry) => entry.memory.id === memoryId);
      if (!reserved) continue;
      selected.splice(Math.max(0, replacementIndex), 1, reserved);
      replacementIndex -= 1;
    }
    selected.sort(
      (left, right) =>
        right.score.total - left.score.total ||
        right.memory.updated_at - left.memory.updated_at ||
        String(left.memory.source_references[0]?.ref ?? "").localeCompare(
          String(right.memory.source_references[0]?.ref ?? "")
        )
    );
  }
  return selected;
}

function readMode(path) {
  return stat(path).then((info) => info.mode & 0o777);
}

export class LocalMemoryStore {
  constructor(dbPath = DEFAULT_LOCAL_DB) {
    this.dbPath = resolve(dbPath);
  }

  async init() {
    await enforcePrivatePermissions(this.dbPath);
    const existed = existsSync(this.dbPath);
    if (existed) {
      const probe = new DatabaseSync(this.dbPath);
      try {
        const currentVersion = Number(probe.prepare("PRAGMA user_version").get().user_version);
        if (currentVersion < MEMORY_SCHEMA_VERSION && hasTable(probe, "memories")) {
          const backupDirectory = join(dirname(this.dbPath), "backups");
          await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
          await chmod(backupDirectory, 0o700);
          const backupPath = join(
            backupDirectory,
            `pre-v${MEMORY_SCHEMA_VERSION}-${new Date().toISOString().replaceAll(":", "-")}.sqlite`
          );
          probe.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
          await chmod(backupPath, 0o600);
        }
      } finally {
        probe.close();
      }
    }
    const db = new DatabaseSync(this.dbPath);
    try {
      const currentVersion = Number(db.prepare("PRAGMA user_version").get().user_version);
      if (
        currentVersion !== MEMORY_SCHEMA_VERSION ||
        !hasTable(db, "memory_versions") ||
        !hasTable(db, "memories_fts") ||
        !hasTable(db, "memory_embeddings") ||
        !hasTable(db, "memory_embedding_features") ||
        !hasTable(db, "memory_embedding_feature_stats") ||
        !hasTable(db, "memory_retrieval_units") ||
        !hasTable(db, "memory_retrieval_units_fts") ||
        !hasTable(db, "memory_retrieval_unit_embeddings") ||
        !hasTable(db, "memory_retrieval_unit_features") ||
        !hasTable(db, "memory_retrieval_unit_feature_stats")
      ) {
        migrateSchema(db);
      } else {
        db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
      }
    } finally {
      db.close();
    }
    await enforcePrivatePermissions(this.dbPath);
    return this;
  }

  open({ readOnly = false } = {}) {
    return new DatabaseSync(this.dbPath, { readOnly });
  }

  async capture(input) {
    await this.init();
    const db = this.open();
    try {
      const now = Date.now();
      const tenantId = nullableString(input.tenant_id, 128) || "default";
      const source = nullableString(input.source, 64) || "local";
      const externalKey = nullableString(input.external_key, 256);
      const existing = externalKey
        ? db.prepare("SELECT * FROM memories WHERE tenant_id = ? AND source = ? AND external_key = ?").get(
            tenantId,
            source,
            externalKey
          )
        : null;
      const id = existing?.id || nullableString(input.id, 128) || randomUUID();
      const createdAt = existing?.created_at || finiteNumber(input.created_at) || now;
      const record = this.normalizeRecord(
        {
          ...input,
          id,
          tenant_id: tenantId,
          source,
          external_key: externalKey,
          created_at: createdAt,
          updated_at: finiteNumber(input.updated_at) || now,
          current_version: Number(existing?.current_version || 0) + 1
        },
        existing ? memoryFromRow(existing) : null
      );
      db.exec("BEGIN IMMEDIATE");
      try {
        this.writeRecord(db, record, Boolean(existing));
        this.writeVersion(db, record, "capture");
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return {
        memory_id: record.id,
        version: record.current_version,
        operation: "capture",
        created: !existing
      };
    } finally {
      db.close();
      await enforcePrivatePermissions(this.dbPath);
    }
  }

  async revise(tenantId, memoryId, input) {
    return this.mutate(tenantId, memoryId, "revise", (current) => ({
      ...current,
      ...input,
      id: current.id,
      tenant_id: current.tenant_id,
      source: current.source,
      external_key: current.external_key,
      created_at: current.created_at,
      lifecycle_state: current.lifecycle_state
    }));
  }

  async suppress(tenantId, memoryId, reason, actor = {}) {
    return this.mutate(tenantId, memoryId, "suppress", (current) => ({
      ...current,
      lifecycle_state: "suppressed",
      summary: current.summary || nullableString(reason, 1000),
      tags: normalizeStrings([...current.tags, "compacted"]),
      actor_type: actor.actor_type ?? current.actor_type,
      actor_id: actor.actor_id ?? current.actor_id
    }));
  }

  async delete(tenantId, memoryId, actor = {}) {
    await this.init();
    const db = this.open();
    try {
      const current = db.prepare("SELECT * FROM memories WHERE tenant_id = ? AND id = ?").get(tenantId, memoryId);
      if (!current) throw new Error(`memory not found: ${memoryId}`);
      const version = Number(current.current_version || 1) + 1;
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          "INSERT INTO memory_deletions(id, tenant_id, memory_id, actor_type, actor_id, deleted_at) VALUES(?,?,?,?,?,?)"
        ).run(randomUUID(), tenantId, memoryId, actor.actor_type ?? null, actor.actor_id ?? null, Date.now());
        db.prepare("DELETE FROM memories_fts WHERE tenant_id = ? AND memory_id = ?").run(tenantId, memoryId);
        deleteLocalEmbedding(db, tenantId, memoryId);
        deleteRetrievalUnits(db, tenantId, memoryId);
        db.prepare(
          "DELETE FROM memory_edges WHERE tenant_id = ? AND (from_memory_id = ? OR to_memory_id = ?)"
        ).run(tenantId, memoryId, memoryId);
        db.prepare("DELETE FROM memory_versions WHERE tenant_id = ? AND memory_id = ?").run(tenantId, memoryId);
        db.prepare("DELETE FROM memories WHERE tenant_id = ? AND id = ?").run(tenantId, memoryId);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return { memory_id: memoryId, version, operation: "delete", created: false };
    } finally {
      db.close();
      await enforcePrivatePermissions(this.dbPath);
    }
  }

  async mutate(tenantId, memoryId, operation, transform) {
    await this.init();
    const db = this.open();
    try {
      const row = db.prepare("SELECT * FROM memories WHERE tenant_id = ? AND id = ?").get(tenantId, memoryId);
      if (!row) throw new Error(`memory not found: ${memoryId}`);
      const current = memoryFromRow(row);
      const record = this.normalizeRecord(
        {
          ...transform(current),
          updated_at: Date.now(),
          current_version: current.current_version + 1
        },
        current
      );
      db.exec("BEGIN IMMEDIATE");
      try {
        this.writeRecord(db, record, true);
        this.writeVersion(db, record, operation);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return { memory_id: memoryId, version: record.current_version, operation, created: false };
    } finally {
      db.close();
      await enforcePrivatePermissions(this.dbPath);
    }
  }

  normalizeRecord(input, fallback = null) {
    const content = nullableString(input.content, 20_000);
    if (!content) throw new Error("content must not be empty");
    const tenantId = nullableString(input.tenant_id, 128) || "default";
    const projectId = nullableString(input.project_id, 128);
    const kind = [
      "episodic",
      "semantic",
      "org_knowledge",
      "fact",
      "decision",
      "constraint",
      "pitfall",
      "preference"
    ].includes(input.kind)
      ? input.kind
      : "episodic";
    const lifecycleState = ["active", "suppressed", "consolidated", "promoted"].includes(input.lifecycle_state)
      ? input.lifecycle_state
      : "active";
    const scopeType = ["tenant", "project", "org"].includes(input.scope_type)
      ? input.scope_type
      : projectId
        ? "project"
        : "tenant";
    const now = Date.now();
    return {
      id: nullableString(input.id, 128) || fallback?.id || randomUUID(),
      tenant_id: tenantId,
      project_id: projectId,
      kind,
      lifecycle_state: lifecycleState,
      scope_type: scopeType,
      scope_key: nullableString(input.scope_key, 128) || projectId || tenantId,
      content,
      summary: nullableString(input.summary, 1000),
      tags: normalizeStrings(input.tags),
      entities: normalizeStrings(input.entities),
      source: nullableString(input.source, 64) || "local",
      source_references: normalizeObjects(input.source_references),
      external_key: nullableString(input.external_key, 256),
      actor_type: nullableString(input.actor_type, 64),
      actor_id: nullableString(input.actor_id, 128),
      created_at: finiteNumber(input.created_at) || fallback?.created_at || now,
      updated_at: finiteNumber(input.updated_at) || now,
      valid_from: finiteNumber(input.valid_from),
      valid_until: finiteNumber(input.valid_until),
      confidence_score: finiteNumber(input.confidence_score),
      utility_score: finiteNumber(input.utility_score),
      content_hash: hashContent(content),
      current_version: Math.max(1, Number(input.current_version || fallback?.current_version || 1)),
      rationale: nullableString(input.rationale, 4000),
      evidence: normalizeObjects(input.evidence),
      conflicts: normalizeStrings(input.conflicts),
      permissions: normalizeObjects(input.permissions),
      canonical_key: nullableString(input.canonical_key, 256),
      root_memory_id: nullableString(input.root_memory_id, 128) || fallback?.root_memory_id || input.id,
      last_accessed_at: finiteNumber(input.last_accessed_at),
      suppressed_at: lifecycleState === "suppressed" ? now : finiteNumber(input.suppressed_at),
      consolidated_at: finiteNumber(input.consolidated_at),
      promoted_at: finiteNumber(input.promoted_at),
      expires_at: finiteNumber(input.expires_at) ?? finiteNumber(input.valid_until),
      revised_at: finiteNumber(input.revised_at) || now
    };
  }

  writeRecord(db, record, exists) {
    const columns = [
      "id", "tenant_id", "project_id", "kind", "lifecycle_state", "scope_type", "scope_key", "content",
      "summary", "tags_json", "entities_json", "source", "source_refs_json", "external_key", "actor_type",
      "actor_id", "created_at", "updated_at", "valid_from", "valid_until", "confidence_score", "utility_score",
      "content_hash", "current_version", "rationale", "evidence_json", "conflicts_json", "permissions_json",
      "canonical_key", "root_memory_id", "last_accessed_at", "suppressed_at", "consolidated_at", "promoted_at",
      "expires_at", "revised_at"
    ];
    const values = {
      ...record,
      tags_json: json(record.tags),
      entities_json: json(record.entities),
      source_refs_json: json(record.source_references),
      evidence_json: json(record.evidence),
      conflicts_json: json(record.conflicts),
      permissions_json: json(record.permissions)
    };
    if (exists) {
      const mutable = columns.filter((column) => column !== "id" && column !== "tenant_id");
      db.prepare(
        `UPDATE memories SET ${mutable.map((column) => `"${column}" = ?`).join(", ")}
         WHERE tenant_id = ? AND id = ?`
      ).run(...mutable.map((column) => values[column]), record.tenant_id, record.id);
    } else {
      db.prepare(
        `INSERT INTO memories(${columns.map((column) => `"${column}"`).join(",")})
         VALUES(${columns.map(() => "?").join(",")})`
      ).run(...columns.map((column) => values[column]));
    }
    db.prepare("DELETE FROM memories_fts WHERE tenant_id = ? AND memory_id = ?").run(record.tenant_id, record.id);
    if (record.lifecycle_state !== "suppressed") {
      db.prepare(
        "INSERT INTO memories_fts(memory_id, tenant_id, content, summary, tags, entities) VALUES(?,?,?,?,?,?)"
      ).run(record.id, record.tenant_id, record.content, record.summary || "", json(record.tags), json(record.entities));
    }
    writeLocalEmbedding(db, record);
    writeRetrievalUnits(db, record);
  }

  writeVersion(db, record, operation) {
    db.prepare(
      `INSERT INTO memory_versions(
        id, memory_id, tenant_id, version, operation, snapshot_json, content_hash, created_at
      ) VALUES(?,?,?,?,?,?,?,?)`
    ).run(
      randomUUID(),
      record.id,
      record.tenant_id,
      record.current_version,
      operation,
      JSON.stringify(memoryFromRow({
        ...record,
        tags_json: json(record.tags),
        entities_json: json(record.entities),
        source_refs_json: json(record.source_references),
        evidence_json: json(record.evidence),
        conflicts_json: json(record.conflicts),
        permissions_json: json(record.permissions)
      })),
      record.content_hash,
      record.updated_at
    );
  }

  async get(tenantId, memoryId) {
    await this.init();
    const db = this.open({ readOnly: true });
    try {
      return memoryFromRow(db.prepare("SELECT * FROM memories WHERE tenant_id = ? AND id = ?").get(tenantId, memoryId));
    } finally {
      db.close();
    }
  }

  async search({
    tenant_id: tenantId,
    project_id: projectId = null,
    query,
    limit = 10,
    include_suppressed = false,
    principal_id: principalId = null,
    search_mode: searchMode = "memories",
    at = Date.now()
  }) {
    await this.init();
    if (searchMode === "hybrid_v3") {
      const db = this.open({ readOnly: true });
      try {
        const safeLimit = Math.max(1, Math.min(100, Number(limit) || 10));
        return searchRetrievalUnitsV3(db, {
          tenantId,
          projectId,
          query,
          limit: safeLimit,
          includeSuppressed: include_suppressed,
          principalId,
          at
        });
      } finally {
        db.close();
      }
    }
    const ftsQuery = buildFtsQuery(query, "AND");
    if (!ftsQuery) throw new Error("search requires a query");
    const db = this.open({ readOnly: true });
    try {
      const safeLimit = Math.max(1, Math.min(100, Number(limit) || 10));
      const statement = db.prepare(
        `SELECT m.*, bm25(memories_fts) AS raw_rank
         FROM memories_fts
         JOIN memories m ON m.id = memories_fts.memory_id AND m.tenant_id = memories_fts.tenant_id
         WHERE memories_fts.tenant_id = ?
           AND memories_fts MATCH ?
           AND (? IS NULL OR m.project_id = ?)
           AND (? = 1 OR m.lifecycle_state != 'suppressed')
           AND (m.valid_from IS NULL OR m.valid_from <= ?)
           AND (m.valid_until IS NULL OR m.valid_until > ?)
         ORDER BY bm25(memories_fts) ASC, m.updated_at DESC
         LIMIT ?`
      );
      let lexicalRows = statement.all(
        tenantId,
        ftsQuery,
        projectId,
        projectId,
        include_suppressed ? 1 : 0,
        at,
        at,
        safeLimit * 5
      );
      if (lexicalRows.length === 0) {
        lexicalRows = statement.all(
          tenantId,
          buildFtsQuery(query, "OR"),
          projectId,
          projectId,
          include_suppressed ? 1 : 0,
          at,
          at,
          safeLimit * 5
        );
      }
      const rawQueryFeatures = embedLocalText(query);
      let queryFeatures = rawQueryFeatures;
      if (rawQueryFeatures.length > 0) {
        const placeholders = rawQueryFeatures.map(() => "?").join(",");
        const featureCounts = db.prepare(
          `SELECT feature_hash, document_count AS matches
           FROM memory_embedding_feature_stats
           WHERE tenant_id = ? AND feature_hash IN (${placeholders})
           ORDER BY document_count ASC
           LIMIT 8`
        ).all(tenantId, ...rawQueryFeatures.map((feature) => feature.feature_hash));
        const countByHash = new Map(
          featureCounts.map((row) => [row.feature_hash, Number(row.matches)])
        );
        const minimumCount = Math.min(...countByHash.values());
        const maximumUsefulCount = minimumCount * 4;
        queryFeatures = rawQueryFeatures
          .filter((feature) => (countByHash.get(feature.feature_hash) ?? Infinity) <= maximumUsefulCount)
          .sort(
            (left, right) =>
              (countByHash.get(left.feature_hash) ?? Infinity) -
              (countByHash.get(right.feature_hash) ?? Infinity)
          )
          .slice(0, 4);
      }
      let semanticRows = [];
      if (queryFeatures.length > 0) {
        const semanticScores = new Map();
        const featureLookup = db.prepare(
          `SELECT memory_id, weight
           FROM memory_embedding_features
           WHERE tenant_id = ? AND feature_hash = ?
           LIMIT ?`
        );
        for (const feature of queryFeatures) {
          const matches = featureLookup.all(tenantId, feature.feature_hash, safeLimit * 20);
          for (const match of matches) {
            semanticScores.set(
              match.memory_id,
              (semanticScores.get(match.memory_id) ?? 0) + Number(match.weight) * feature.weight
            );
          }
        }
        semanticRows = [...semanticScores.entries()]
          .map(([memory_id, semantic_score]) => ({ memory_id, semantic_score }))
          .sort((left, right) => right.semantic_score - left.semantic_score)
          .slice(0, safeLimit * 5);
      }
      const lexicalById = new Map(
        lexicalRows.map((row) => [
          row.id,
          0.5 + 0.5 * Math.max(0, 1 / (1 + Math.abs(Number(row.raw_rank || 0))))
        ])
      );
      const semanticById = new Map(
        semanticRows.map((row) => [row.memory_id, Math.max(0, Math.min(1, Number(row.semantic_score || 0)))])
      );
      const candidateIds = [...new Set([
        ...lexicalRows.map((row) => row.id),
        ...semanticRows.map((row) => row.memory_id)
      ])];
      if (candidateIds.length === 0) return [];
      const graphRaw = new Map();
      if (candidateIds.length > 0) {
        const placeholders = candidateIds.map(() => "?").join(",");
        const edges = db.prepare(
          `SELECT from_memory_id, to_memory_id
           FROM memory_edges
           WHERE tenant_id = ?
             AND (from_memory_id IN (${placeholders}) OR to_memory_id IN (${placeholders}))
           LIMIT ?`
        ).all(tenantId, ...candidateIds, ...candidateIds, safeLimit * 20);
        const seedIds = new Set(candidateIds);
        const candidateLookup = new Set(candidateIds);
        for (const edge of edges) {
          const fromSeed = seedIds.has(edge.from_memory_id);
          const toSeed = seedIds.has(edge.to_memory_id);
          if (fromSeed) {
            graphRaw.set(edge.to_memory_id, (graphRaw.get(edge.to_memory_id) ?? 0) + 1);
            if (!candidateLookup.has(edge.to_memory_id)) {
              candidateIds.push(edge.to_memory_id);
              candidateLookup.add(edge.to_memory_id);
            }
          }
          if (toSeed) {
            graphRaw.set(edge.from_memory_id, (graphRaw.get(edge.from_memory_id) ?? 0) + 1);
            if (!candidateLookup.has(edge.from_memory_id)) {
              candidateIds.push(edge.from_memory_id);
              candidateLookup.add(edge.from_memory_id);
            }
          }
        }
      }
      const maxGraph = Math.max(0, ...graphRaw.values());
      const rowsById = new Map(lexicalRows.map((row) => [row.id, row]));
      const missingIds = candidateIds.filter((id) => !rowsById.has(id));
      if (missingIds.length > 0) {
        const placeholders = missingIds.map(() => "?").join(",");
        const fetched = db.prepare(
          `SELECT * FROM memories
           WHERE tenant_id = ? AND id IN (${placeholders})`
        ).all(tenantId, ...missingIds);
        for (const row of fetched) rowsById.set(row.id, row);
      }
      return [...rowsById.values()]
        .filter((row) =>
          (projectId === null || row.project_id === projectId) &&
          (include_suppressed || row.lifecycle_state !== "suppressed") &&
          (row.valid_from === null || row.valid_from <= at) &&
          (row.valid_until === null || row.valid_until > at)
        )
        .map((row) => {
        const lexical = lexicalById.get(row.id) ?? 0;
        const semantic = semanticById.get(row.id) ?? 0;
        const graph = maxGraph > 0 ? (graphRaw.get(row.id) ?? 0) / maxGraph : 0;
        const ageDays = Math.max(0, (at - row.updated_at) / 86_400_000);
        const time = 1 / (1 + ageDays / 30);
        const tags = parseJson(row.tags_json);
        const kindAuthority = ["decision", "constraint", "org_knowledge"].includes(row.kind)
          ? 1
          : row.kind === "fact" || row.kind === "episodic"
            ? 0.5
            : 0.75;
        const authority = Math.max(
          0,
          Math.min(
            1,
            Number(row.confidence_score ?? 0.5) * 0.7 +
              Math.max(kindAuthority, tags.includes("policy") ? 1 : 0) * 0.3
          )
        );
        const utility = Math.max(0, Math.min(1, Number(row.utility_score ?? 0.5)));
        const hasLexicalMatch = lexical > 0;
        const weights = hasLexicalMatch
          ? { lexical: 0.35, semantic: 0.05, graph: 0.1, time: 0.1, authority: 0.3, utility: 0.1 }
          : { lexical: 0, semantic: 0.45, graph: 0.15, time: 0.1, authority: 0.2, utility: 0.1 };
        return {
          memory: memoryFromRow(row),
          score: {
            total: Number(
              (
                lexical * weights.lexical +
                semantic * weights.semantic +
                graph * weights.graph +
                time * weights.time +
                authority * weights.authority +
                utility * weights.utility
              )
                .toFixed(6)
            ),
            lexical: Number(lexical.toFixed(6)),
            semantic: Number(semantic.toFixed(6)),
            graph: Number(graph.toFixed(6)),
            time: Number(time.toFixed(6)),
            authority: Number(authority.toFixed(6)),
            utility: Number(utility.toFixed(6))
          }
        };
      }).filter((result) => canReadMemory(result.memory, principalId))
        .sort((left, right) => right.score.total - left.score.total || right.memory.updated_at - left.memory.updated_at)
        .slice(0, safeLimit);
    } finally {
      db.close();
    }
  }

  async versions(tenantId, memoryId) {
    await this.init();
    const db = this.open({ readOnly: true });
    try {
      return db.prepare(
        "SELECT snapshot_json FROM memory_versions WHERE tenant_id = ? AND memory_id = ? ORDER BY version ASC"
      ).all(tenantId, memoryId).map((row) => JSON.parse(row.snapshot_json));
    } finally {
      db.close();
    }
  }

  async *export(tenantId = "default", projectId = null) {
    await this.init();
    const db = this.open({ readOnly: true });
    try {
      const rows = db.prepare(
        `SELECT * FROM memories
         WHERE tenant_id = ? AND (? IS NULL OR project_id = ?)
         ORDER BY updated_at DESC, id ASC`
      ).all(tenantId, projectId, projectId);
      for (const row of rows) yield memoryFromRow(row);
    } finally {
      db.close();
    }
  }

  async rebuildIndex() {
    await this.init();
    const db = this.open();
    try {
      db.exec("BEGIN IMMEDIATE");
      rebuildFts(db);
      rebuildLocalEmbeddings(db);
      rebuildRetrievalUnits(db);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    } finally {
      db.close();
      await enforcePrivatePermissions(this.dbPath);
    }
  }

  async verify() {
    await this.init();
    const db = this.open({ readOnly: true });
    try {
      const errors = [];
      const quickCheck = db.prepare("PRAGMA quick_check").all().map((row) => Object.values(row)[0]);
      if (quickCheck.length !== 1 || quickCheck[0] !== "ok") errors.push(`quick_check: ${quickCheck.join(", ")}`);
      const rows = db.prepare("SELECT id, content, content_hash FROM memories ORDER BY id").all();
      for (const row of rows) {
        if (hashContent(row.content) !== row.content_hash) errors.push(`content hash mismatch: ${row.id}`);
      }
      const recordCount = rows.length;
      const versionCount = Number(db.prepare("SELECT COUNT(*) AS count FROM memory_versions").get().count);
      const ftsCount = Number(db.prepare("SELECT COUNT(*) AS count FROM memories_fts").get().count);
      const searchableCount = Number(
        db.prepare("SELECT COUNT(*) AS count FROM memories WHERE lifecycle_state != 'suppressed'").get().count
      );
      if (ftsCount !== searchableCount) errors.push(`FTS count ${ftsCount} != searchable record count ${searchableCount}`);
      const embeddingCount = Number(db.prepare("SELECT COUNT(*) AS count FROM memory_embeddings").get().count);
      if (embeddingCount !== searchableCount) {
        errors.push(`embedding count ${embeddingCount} != searchable record count ${searchableCount}`);
      }
      const retrievalUnits = db.prepare(
        `SELECT id, text, content_hash
         FROM memory_retrieval_units
         ORDER BY id`
      ).all();
      for (const unit of retrievalUnits) {
        if (hashContent(unit.text) !== unit.content_hash) {
          errors.push(`retrieval unit content hash mismatch: ${unit.id}`);
        }
      }
      const retrievalUnitCount = retrievalUnits.length;
      const retrievalUnitFtsCount = Number(
        db.prepare("SELECT COUNT(*) AS count FROM memory_retrieval_units_fts").get().count
      );
      const retrievalUnitEmbeddingCount = Number(
        db.prepare("SELECT COUNT(*) AS count FROM memory_retrieval_unit_embeddings").get().count
      );
      if (retrievalUnitFtsCount !== retrievalUnitCount) {
        errors.push(
          `retrieval unit FTS count ${retrievalUnitFtsCount} != retrieval unit count ${retrievalUnitCount}`
        );
      }
      if (retrievalUnitEmbeddingCount !== retrievalUnitCount) {
        errors.push(
          `retrieval unit embedding count ${retrievalUnitEmbeddingCount} != retrieval unit count ${retrievalUnitCount}`
        );
      }
      const userVersion = Number(db.prepare("PRAGMA user_version").get().user_version);
      if (userVersion !== MEMORY_SCHEMA_VERSION) errors.push(`schema version ${userVersion} != ${MEMORY_SCHEMA_VERSION}`);
      return {
        ok: errors.length === 0,
        schema_version: userVersion,
        record_count: recordCount,
        version_count: versionCount,
        fts_count: ftsCount,
        embedding_count: embeddingCount,
        embedding_provider: LOCAL_EMBEDDING_PROVIDER,
        retrieval_unit_count: retrievalUnitCount,
        retrieval_unit_fts_count: retrievalUnitFtsCount,
        retrieval_unit_embedding_count: retrievalUnitEmbeddingCount,
        retrieval_unit_digest: stableDigest(retrievalUnits),
        content_digest: stableDigest(rows),
        errors
      };
    } finally {
      db.close();
    }
  }

  async createBackup(destination) {
    await this.init();
    const target = resolve(destination);
    const targetDirectory = dirname(target);
    const targetDirectoryExisted = existsSync(targetDirectory);
    await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
    if (!targetDirectoryExisted) await chmod(targetDirectory, 0o700);
    const db = this.open();
    try {
      db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
    } finally {
      db.close();
    }
    await chmod(target, 0o600);
    return { path: target, ...(await this.verifyBackup(target)) };
  }

  async verifyBackup(path) {
    const target = resolve(path);
    const db = new DatabaseSync(target, { readOnly: true });
    try {
      const check = db.prepare("PRAGMA quick_check").all().map((row) => Object.values(row)[0]);
      const schemaVersion = Number(db.prepare("PRAGMA user_version").get().user_version);
      const rows = hasTable(db, "memories")
        ? db.prepare("SELECT id, content, content_hash FROM memories ORDER BY id").all()
        : [];
      const errors = [];
      for (const row of rows) {
        if (hashContent(row.content) !== row.content_hash) errors.push(`content hash mismatch: ${row.id}`);
      }
      const recordCount = rows.length;
      const ftsCount = hasTable(db, "memories_fts")
        ? Number(db.prepare("SELECT COUNT(*) AS count FROM memories_fts").get().count)
        : 0;
      const searchableCount = hasTable(db, "memories")
        ? Number(db.prepare("SELECT COUNT(*) AS count FROM memories WHERE lifecycle_state != 'suppressed'").get().count)
        : 0;
      if (ftsCount !== searchableCount) errors.push(`FTS count ${ftsCount} != searchable record count ${searchableCount}`);
      const embeddingCount = hasTable(db, "memory_embeddings")
        ? Number(db.prepare("SELECT COUNT(*) AS count FROM memory_embeddings").get().count)
        : 0;
      if (embeddingCount !== searchableCount) {
        errors.push(`embedding count ${embeddingCount} != searchable record count ${searchableCount}`);
      }
      const retrievalUnits = hasTable(db, "memory_retrieval_units")
        ? db.prepare("SELECT id, text, content_hash FROM memory_retrieval_units ORDER BY id").all()
        : [];
      for (const unit of retrievalUnits) {
        if (hashContent(unit.text) !== unit.content_hash) {
          errors.push(`retrieval unit content hash mismatch: ${unit.id}`);
        }
      }
      const retrievalUnitCount = retrievalUnits.length;
      const retrievalUnitFtsCount = hasTable(db, "memory_retrieval_units_fts")
        ? Number(db.prepare("SELECT COUNT(*) AS count FROM memory_retrieval_units_fts").get().count)
        : 0;
      const retrievalUnitEmbeddingCount = hasTable(db, "memory_retrieval_unit_embeddings")
        ? Number(db.prepare("SELECT COUNT(*) AS count FROM memory_retrieval_unit_embeddings").get().count)
        : 0;
      if (retrievalUnitFtsCount !== retrievalUnitCount) {
        errors.push(
          `retrieval unit FTS count ${retrievalUnitFtsCount} != retrieval unit count ${retrievalUnitCount}`
        );
      }
      if (retrievalUnitEmbeddingCount !== retrievalUnitCount) {
        errors.push(
          `retrieval unit embedding count ${retrievalUnitEmbeddingCount} != retrieval unit count ${retrievalUnitCount}`
        );
      }
      return {
        ok:
          check.length === 1 &&
          check[0] === "ok" &&
          schemaVersion === MEMORY_SCHEMA_VERSION &&
          errors.length === 0,
        schema_version: schemaVersion,
        record_count: recordCount,
        fts_count: ftsCount,
        embedding_count: embeddingCount,
        embedding_provider: LOCAL_EMBEDDING_PROVIDER,
        retrieval_unit_count: retrievalUnitCount,
        retrieval_unit_fts_count: retrievalUnitFtsCount,
        retrieval_unit_embedding_count: retrievalUnitEmbeddingCount,
        retrieval_unit_digest: stableDigest(retrievalUnits),
        content_digest: stableDigest(rows),
        errors
      };
    } finally {
      db.close();
    }
  }

  async restoreBackup(path) {
    const source = resolve(path);
    const verification = await this.verifyBackup(source);
    if (!verification.ok) throw new Error("backup verification failed");
    const safetyBackup = `${this.dbPath}.pre-restore-${Date.now()}`;
    let deletionLedger = [];
    if (existsSync(this.dbPath)) {
      const current = this.open();
      try {
        if (hasTable(current, "memory_deletions")) {
          deletionLedger = current.prepare(
            `SELECT id, tenant_id, memory_id, actor_type, actor_id, deleted_at
             FROM memory_deletions
             ORDER BY deleted_at, id`
          ).all();
        }
        current.exec(`VACUUM INTO '${safetyBackup.replaceAll("'", "''")}'`);
      } finally {
        current.close();
      }
      await chmod(safetyBackup, 0o600);
    }
    const staged = `${this.dbPath}.restore-${randomUUID()}`;
    await copyFile(source, staged);
    await chmod(staged, 0o600);
    await rename(staged, this.dbPath);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(`${this.dbPath}${suffix}`)) await unlink(`${this.dbPath}${suffix}`);
    }
    await this.init();
    if (deletionLedger.length > 0) {
      const restored = this.open();
      try {
        restored.exec("BEGIN IMMEDIATE");
        const deleteFts = restored.prepare(
          "DELETE FROM memories_fts WHERE tenant_id = ? AND memory_id = ?"
        );
        const deleteVersions = restored.prepare(
          "DELETE FROM memory_versions WHERE tenant_id = ? AND memory_id = ?"
        );
        const deleteEdges = restored.prepare(
          "DELETE FROM memory_edges WHERE tenant_id = ? AND (from_memory_id = ? OR to_memory_id = ?)"
        );
        const deleteMemory = restored.prepare(
          "DELETE FROM memories WHERE tenant_id = ? AND id = ?"
        );
        const insertDeletion = restored.prepare(
          `INSERT OR IGNORE INTO memory_deletions(
            id, tenant_id, memory_id, actor_type, actor_id, deleted_at
          ) VALUES(?,?,?,?,?,?)`
        );
        for (const deletion of deletionLedger) {
          deleteFts.run(deletion.tenant_id, deletion.memory_id);
          deleteLocalEmbedding(restored, deletion.tenant_id, deletion.memory_id);
          deleteRetrievalUnits(restored, deletion.tenant_id, deletion.memory_id);
          deleteVersions.run(deletion.tenant_id, deletion.memory_id);
          deleteEdges.run(deletion.tenant_id, deletion.memory_id, deletion.memory_id);
          deleteMemory.run(deletion.tenant_id, deletion.memory_id);
          insertDeletion.run(
            deletion.id,
            deletion.tenant_id,
            deletion.memory_id,
            deletion.actor_type,
            deletion.actor_id,
            deletion.deleted_at
          );
        }
        restored.exec("COMMIT");
      } catch (error) {
        restored.exec("ROLLBACK");
        throw error;
      } finally {
        restored.close();
      }
    }
    return {
      restored: this.dbPath,
      safety_backup: existsSync(safetyBackup) ? safetyBackup : null,
      reapplied_deletions: deletionLedger.length
    };
  }

  async doctor() {
    const verification = await this.verify();
    const directoryMode = await readMode(dirname(this.dbPath));
    const dbMode = await readMode(this.dbPath);
    const errors = [...verification.errors];
    if (directoryMode !== 0o700) errors.push(`directory mode is ${directoryMode.toString(8)}, expected 700`);
    if (dbMode !== 0o600) errors.push(`database mode is ${dbMode.toString(8)}, expected 600`);
    return {
      ...verification,
      ok: errors.length === 0,
      db_path: this.dbPath,
      directory_mode: directoryMode.toString(8).padStart(3, "0"),
      database_mode: dbMode.toString(8).padStart(3, "0"),
      errors
    };
  }

  async importLegacy(sourcePath) {
    const source = resolve(sourcePath);
    const before = await this.verify();
    const legacy = new DatabaseSync(source, { readOnly: true });
    try {
      if (!hasTable(legacy, "memories")) throw new Error("source has no memories table");
      const columns = tableColumns(legacy, "memories");
      const rows = legacy.prepare("SELECT * FROM memories ORDER BY id").all();
      for (const row of rows) {
        await this.capture({
          id: row.id,
          tenant_id: columns.has("tenant_id") ? row.tenant_id : "default",
          project_id: row.project_id,
          kind: columns.has("kind") ? row.kind : "episodic",
          lifecycle_state: columns.has("lifecycle_state") ? row.lifecycle_state : "active",
          scope_type: columns.has("scope_type") ? row.scope_type : row.project_id ? "project" : "tenant",
          scope_key: columns.has("scope_key") ? row.scope_key : row.project_id || "default",
          content: row.content,
          summary: row.summary,
          tags: parseJson(row.tags_json),
          entities: columns.has("entities_json") ? parseJson(row.entities_json) : [],
          source: row.source || "legacy",
          source_references: columns.has("source_refs_json") ? parseJson(row.source_refs_json) : [],
          external_key: row.external_key || `legacy:${row.id}`,
          actor_type: columns.has("actor_type") ? row.actor_type : "migration",
          actor_id: columns.has("actor_id") ? row.actor_id : source,
          created_at: row.created_at,
          updated_at: columns.has("updated_at") ? row.updated_at : row.created_at,
          valid_from: columns.has("valid_from") ? row.valid_from : null,
          valid_until: columns.has("valid_until") ? row.valid_until : null,
          confidence_score: columns.has("confidence_score") ? row.confidence_score : null,
          utility_score: columns.has("utility_score") ? row.utility_score : null,
          rationale: columns.has("rationale") ? row.rationale : null,
          evidence: columns.has("evidence_json") ? parseJson(row.evidence_json) : [],
          conflicts: columns.has("conflicts_json") ? parseJson(row.conflicts_json) : [],
          permissions: columns.has("permissions_json") ? parseJson(row.permissions_json) : []
        });
      }
      const after = await this.verify();
      return {
        source,
        source_count: rows.length,
        before,
        after,
        imported: Math.max(0, after.record_count - before.record_count)
      };
    } finally {
      legacy.close();
    }
  }
}

export async function readJsonFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
