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
  cosineSimilarity,
  decodeFloat32Vector,
  encodeFloat32Vector,
  localDenseEmbeddingProviderFromEnvironment
} from "./local-dense-embedding.mjs";
import {
  analyzeRetrievalIntent,
  buildRetrievalUnits,
  buildRetrievalUnitsV4,
  buildVerifiedLearningRetrievalUnits,
  retrievalQueryTokens,
  retrievalSubjectQueryTokens,
  retrievalUnitLexicalSpecificity,
  retrievalUnitIntentBoost
} from "./retrieval-units.mjs";

export const MEMORY_SCHEMA_VERSION = 23;
export const DEFAULT_LOCAL_DB = join(homedir(), ".org-brain", "memory.sqlite");

const WORK_TYPES = new Set([
  "implementation", "review", "debug", "proposal",
  "support", "research", "operations", "other"
]);
const AVOIDED_LOOKUP_CATEGORIES = new Set(["source_search", "web_search", "past_context", "none"]);

function classificationRequired() {
  return (process.env.MEMORY_CLASSIFICATION_MODE ?? process.env.ORGBRAIN_CLASSIFICATION_MODE) === "require";
}

function cloudTelemetryEnabled() {
  return ["1", "true", "yes", "on"].includes(
    String(process.env.ORGBRAIN_ENABLE_CLOUD_MEMORY ?? "").trim().toLowerCase()
  );
}

const TOKEN_ESTIMATION_PRIORITY = [
  ["paired_control", "paired_control_tokens"],
  ["safe_replay", "safe_replay_tokens"],
  ["avoided_source_or_context_size", "avoided_source_tokens"],
  ["failure_pattern_historical_median", "failure_pattern_median_tokens"],
  ["business_category_calibrated_median", "category_median_tokens"],
  ["text_size_heuristic", "text_size_heuristic_tokens"]
];

function resolveLocalTokenEstimate(input) {
  if (input.gross_saved_tokens_estimate !== undefined) {
    const value = Number(input.gross_saved_tokens_estimate);
    if (!Number.isFinite(value) || value < 0) throw new Error("invalid_token_estimate");
    return {
      gross: Math.round(value),
      method: nullableString(input.estimation_method, 128) || "reported"
    };
  }
  const candidates = input.token_estimation_candidates;
  if (candidates && typeof candidates === "object" && !Array.isArray(candidates)) {
    for (const [method, field] of TOKEN_ESTIMATION_PRIORITY) {
      const value = Number(candidates[field]);
      if (Number.isFinite(value) && value >= 0) return { gross: Math.round(value), method };
    }
  }
  throw new Error("gross_saved_tokens_estimate_required");
}

function median(values) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

export function verificationSampled(tenantId, usageId) {
  let hash = 2166136261;
  const input = `${tenantId}\0${usageId}`;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 100 < 10;
}

function validateBusinessClassification(db, tenantId, businessCategoryId, workType) {
  if (classificationRequired() && !businessCategoryId) throw new Error("business_category_required");
  if (classificationRequired() && !workType) throw new Error("work_type_required");
  if (workType && !WORK_TYPES.has(workType)) throw new Error("invalid_work_type");
  if (!businessCategoryId) return;
  const category = db.prepare(
    "SELECT id FROM business_categories WHERE tenant_id = ? AND id = ? AND is_active = 1"
  ).get(tenantId, businessCategoryId);
  if (!category) throw new Error("business_category_not_found_or_inactive");
}

function normalizedIdentifier(value, field, required = false) {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${field}_required`);
    return null;
  }
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(normalized)) throw new Error(`invalid_${field}`);
  return normalized;
}

function normalizedQueryHash(value) {
  if (value === undefined || value === null) return null;
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^[a-f0-9]{64}$/i.test(normalized)) throw new Error("invalid_query_hash");
  return normalized.toLowerCase();
}

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
  business_category_id: "TEXT",
  work_type: "TEXT",
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
  reuse_rule: "TEXT",
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
  , capture_origin: "TEXT NOT NULL DEFAULT 'legacy'"
  , verification_state: "TEXT NOT NULL DEFAULT 'unverified'"
  , verified_at: "INTEGER"
  , learning_json: "TEXT"
  , quality_dimensions_json: "TEXT"
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

function parseJsonObject(raw, fallback = null) {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
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
    business_category_id: row.business_category_id ?? null,
    work_type: row.work_type ?? null,
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
    reuse_rule: row.reuse_rule,
    evidence: parseJson(row.evidence_json),
    conflicts: parseJson(row.conflicts_json),
    permissions: parseJson(row.permissions_json)
    , capture_origin: row.capture_origin || "legacy"
    , verification_state: row.verification_state || "unverified"
    , verified_at: row.verified_at
    , learning: parseJsonObject(row.learning_json)
    , quality_dimensions: parseJsonObject(row.quality_dimensions_json)
  };
}

function memoryAuthority(memory) {
  const kindAuthority = ["decision", "constraint", "org_knowledge"].includes(memory.kind)
    ? 1
    : ["fact", "episodic"].includes(memory.kind)
      ? 0.5
      : 0.75;
  // A free-form policy tag is a useful signal, but cannot by itself confer the
  // same authority as a canonical decision/constraint record.
  const policyAuthority = memory.tags.includes("policy") ? 0.75 : 0;
  return Math.max(
    0,
    Math.min(
      1,
      Number(memory.confidence_score ?? 0.5) * 0.7 +
        Math.max(kindAuthority, policyAuthority) * 0.3
    )
  );
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

const LEGACY_FTS_TRIGGER_NAMES = [
  "memories_fts_ai",
  "memories_fts_ad",
  "memories_fts_au"
];

function hasLegacyFtsTriggers(db) {
  const placeholders = LEGACY_FTS_TRIGGER_NAMES.map(() => "?").join(",");
  return Boolean(
    db.prepare(
      `SELECT 1 AS found FROM sqlite_master
       WHERE type = 'trigger' AND name IN (${placeholders})
       LIMIT 1`
    ).get(...LEGACY_FTS_TRIGGER_NAMES)
  );
}

function dropLegacyFtsTriggers(db) {
  for (const name of LEGACY_FTS_TRIGGER_NAMES) {
    db.exec(`DROP TRIGGER IF EXISTS "${name}"`);
  }
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
      business_category_id TEXT,
      work_type TEXT,
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
      reuse_rule TEXT,
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
      , capture_origin TEXT NOT NULL DEFAULT 'legacy'
      , verification_state TEXT NOT NULL DEFAULT 'unverified'
      , verified_at INTEGER
      , learning_json TEXT
      , quality_dimensions_json TEXT
    );
    CREATE TABLE IF NOT EXISTS memory_versions (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      operation TEXT NOT NULL,
      content TEXT NOT NULL,
      summary TEXT,
      tags_json TEXT,
      kind TEXT NOT NULL,
      lifecycle_state TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      scope_key TEXT,
      actor_type TEXT,
      actor_id TEXT,
      confidence_score REAL,
      utility_score REAL,
      canonical_key TEXT,
      business_category_id TEXT,
      work_type TEXT,
      reuse_rule TEXT,
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
    CREATE TABLE IF NOT EXISTS memory_retrieval_units_v4 (
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
      metadata_json TEXT NOT NULL DEFAULT '{}',
      segment_id TEXT,
      extractor TEXT NOT NULL,
      extractor_version TEXT NOT NULL,
      extraction_state TEXT NOT NULL DEFAULT 'degraded',
      degraded_reason TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_retrieval_unit_features_v4 (
      unit_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      feature_hash INTEGER NOT NULL,
      weight REAL NOT NULL,
      PRIMARY KEY(tenant_id, unit_id, feature_hash)
    );
    CREATE TABLE IF NOT EXISTS memory_retrieval_unit_feature_stats_v4 (
      tenant_id TEXT NOT NULL,
      feature_hash INTEGER NOT NULL,
      document_count INTEGER NOT NULL,
      PRIMARY KEY(tenant_id, feature_hash)
    );
    CREATE TABLE IF NOT EXISTS memory_retrieval_unit_embeddings_v4 (
      unit_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      feature_count INTEGER NOT NULL,
      vector_format TEXT NOT NULL DEFAULT 'sparse-fallback',
      vector_blob BLOB,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(tenant_id, unit_id)
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

function createCurrentTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_impact_events (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      project_id TEXT,
      task_id TEXT,
      trace_id TEXT,
      external_run_id TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN ('eligible', 'assessed', 'failed')),
      memory_used INTEGER,
      avoided_lookup TEXT CHECK (avoided_lookup IN ('source_search', 'web_search', 'past_context', 'none')),
      memory_basis_ids_json TEXT NOT NULL DEFAULT '[]',
      confidence TEXT CHECK (confidence IN ('low', 'medium', 'high')),
      failure_category TEXT,
      reporter_principal TEXT NOT NULL,
      agent_name TEXT,
      model TEXT,
      idempotency_key TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_impact_daily_metrics (
      day TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL DEFAULT '',
      eligible_runs INTEGER NOT NULL DEFAULT 0,
      assessed_runs INTEGER NOT NULL DEFAULT 0,
      failed_runs INTEGER NOT NULL DEFAULT 0,
      memory_used_runs INTEGER NOT NULL DEFAULT 0,
      avoided_runs INTEGER NOT NULL DEFAULT 0,
      reporting_rate REAL CHECK (reporting_rate IS NULL OR reporting_rate BETWEEN 0 AND 1),
      memory_usage_rate REAL CHECK (memory_usage_rate IS NULL OR memory_usage_rate BETWEEN 0 AND 1),
      avoided_lookup_rate REAL CHECK (avoided_lookup_rate IS NULL OR avoided_lookup_rate BETWEEN 0 AND 1),
      source_search_count INTEGER NOT NULL DEFAULT 0,
      web_search_count INTEGER NOT NULL DEFAULT 0,
      past_context_count INTEGER NOT NULL DEFAULT 0,
      none_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (day, tenant_id, project_id)
    );
    CREATE TABLE IF NOT EXISTS business_categories (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      label TEXT NOT NULL,
      description TEXT,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(tenant_id, slug)
    );
    CREATE TABLE IF NOT EXISTS organizations (
      tenant_id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      allowed_email_domains_json TEXT NOT NULL DEFAULT '[]',
      email_self_registration_enabled INTEGER NOT NULL DEFAULT 0 CHECK(email_self_registration_enabled IN (0, 1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_profiles (
      tenant_id TEXT NOT NULL,
      principal TEXT NOT NULL,
      display_name TEXT NOT NULL,
      full_name TEXT,
      email TEXT,
      email_verified INTEGER NOT NULL DEFAULT 0 CHECK(email_verified IN (0, 1)),
      company_name TEXT,
      organization_name TEXT,
      avatar_url TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('invited', 'active', 'suspended', 'deprovisioned')),
      provision_source TEXT NOT NULL DEFAULT 'legacy' CHECK(provision_source IN ('email', 'oidc', 'scim', 'legacy')),
      full_name_source TEXT NOT NULL DEFAULT 'legacy' CHECK(full_name_source IN ('email', 'oidc', 'scim', 'legacy')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(tenant_id, principal)
    );
    CREATE TABLE IF NOT EXISTS user_identities (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      principal TEXT NOT NULL,
      provider_type TEXT NOT NULL CHECK(provider_type IN ('email', 'oidc', 'scim')),
      issuer TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL,
      external_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(tenant_id, provider_type, issuer, subject)
    );
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      source TEXT NOT NULL DEFAULT 'local' CHECK(source IN ('local', 'scim')),
      external_id TEXT,
      created_by_principal TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      UNIQUE(tenant_id, slug)
    );
    CREATE TABLE IF NOT EXISTS group_members (
      tenant_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      principal TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner', 'admin', 'member')),
      source TEXT NOT NULL DEFAULT 'local' CHECK(source IN ('local', 'scim')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(tenant_id, group_id, principal)
    );
    CREATE TABLE IF NOT EXISTS principal_role_assignments (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      project_id TEXT,
      principal TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('reader', 'contributor', 'tenant_admin', 'auditor', 'service_agent')),
      source TEXT NOT NULL DEFAULT 'local' CHECK(source IN ('local', 'scim')),
      source_ref TEXT,
      created_by_principal TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_failure_patterns (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      project_id TEXT,
      business_category_id TEXT,
      work_type TEXT,
      pattern_key TEXT NOT NULL,
      label TEXT NOT NULL,
      action_fingerprint TEXT,
      failure_fingerprint TEXT,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(tenant_id, pattern_key)
    );
    CREATE TABLE IF NOT EXISTS memory_usage_events (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      project_id TEXT,
      task_id TEXT,
      trace_id TEXT,
      external_run_id TEXT,
      capability TEXT,
      access_path TEXT NOT NULL,
      request_source TEXT NOT NULL,
      query_hash TEXT,
      requested_business_category_id TEXT,
      requested_work_type TEXT,
      retrieval_generation_id TEXT,
      ranking_profile_id TEXT,
      actor_principal TEXT,
      verification_sampled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_usage_items (
      id TEXT PRIMARY KEY,
      usage_event_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_version INTEGER,
      rank INTEGER,
      score REAL,
      reference_type TEXT NOT NULL,
      used_state TEXT NOT NULL DEFAULT 'unknown',
      used_state_source TEXT NOT NULL DEFAULT 'reported',
      injected_token_estimate INTEGER NOT NULL DEFAULT 0,
      business_category_id_snapshot TEXT,
      work_type_snapshot TEXT,
      quality_category_snapshot TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(tenant_id, usage_event_id, source_type, source_id)
    );
    CREATE TABLE IF NOT EXISTS memory_effect_events (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      usage_event_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      evidence_level TEXT NOT NULL,
      supersedes_effect_id TEXT,
      effect_outcome TEXT NOT NULL,
      avoided_lookup_categories_json TEXT NOT NULL DEFAULT '[]',
      gross_saved_tokens_estimate INTEGER NOT NULL DEFAULT 0,
      injected_tokens INTEGER NOT NULL DEFAULT 0,
      net_saved_tokens_estimate INTEGER NOT NULL DEFAULT 0,
      estimate_lower_bound INTEGER,
      estimate_upper_bound INTEGER,
      estimation_method TEXT,
      estimator_version TEXT,
      estimate_confidence REAL,
      failure_pattern_id TEXT,
      failure_opportunity_state TEXT NOT NULL DEFAULT 'unknown',
      action_changed INTEGER NOT NULL DEFAULT 0,
      alternative_executed INTEGER NOT NULL DEFAULT 0,
      failure_avoided INTEGER NOT NULL DEFAULT 0,
      failure_saved_tokens_estimate INTEGER NOT NULL DEFAULT 0,
      verification_ref_type TEXT,
      verification_ref_id TEXT,
      estimated_tool_calls_saved REAL,
      estimated_seconds_saved REAL,
      created_at INTEGER NOT NULL,
      UNIQUE(tenant_id, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS memory_effect_attributions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      effect_event_id TEXT NOT NULL,
      usage_item_id TEXT NOT NULL,
      attribution_weight REAL NOT NULL,
      gross_saved_tokens INTEGER NOT NULL DEFAULT 0,
      net_saved_tokens INTEGER NOT NULL DEFAULT 0,
      failure_saved_tokens INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE(tenant_id, effect_event_id, usage_item_id)
    );
    CREATE TABLE IF NOT EXISTS memory_effect_daily_metrics (
      id TEXT PRIMARY KEY,
      day TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      project_id_snapshot TEXT,
      business_category_id_snapshot TEXT,
      work_type_snapshot TEXT,
      quality_category_snapshot TEXT,
      reference_count INTEGER NOT NULL DEFAULT 0,
      used_count INTEGER NOT NULL DEFAULT 0,
      effect_reported_count INTEGER NOT NULL DEFAULT 0,
      positive_count INTEGER NOT NULL DEFAULT 0,
      neutral_count INTEGER NOT NULL DEFAULT 0,
      negative_count INTEGER NOT NULL DEFAULT 0,
      unknown_count INTEGER NOT NULL DEFAULT 0,
      avoided_source_search_count INTEGER NOT NULL DEFAULT 0,
      avoided_web_search_count INTEGER NOT NULL DEFAULT 0,
      avoided_past_context_count INTEGER NOT NULL DEFAULT 0,
      avoided_none_count INTEGER NOT NULL DEFAULT 0,
      gross_saved_tokens INTEGER NOT NULL DEFAULT 0,
      injected_tokens INTEGER NOT NULL DEFAULT 0,
      net_saved_tokens INTEGER NOT NULL DEFAULT 0,
      failure_opportunity_count INTEGER NOT NULL DEFAULT 0,
      failure_avoided_count INTEGER NOT NULL DEFAULT 0,
      failure_saved_tokens INTEGER NOT NULL DEFAULT 0,
      verification_sampled_count INTEGER NOT NULL DEFAULT 0,
      verified_count INTEGER NOT NULL DEFAULT 0,
      estimator_absolute_error_sum REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_telemetry_outbox (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER,
      last_error_code TEXT,
      created_at INTEGER NOT NULL,
      sent_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS retrieval_ranking_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      algorithm TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      config_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      retired_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS retrieval_generations (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      unit_schema_version INTEGER NOT NULL,
      extractor_name TEXT NOT NULL,
      extractor_version TEXT NOT NULL,
      embedding_profile_id TEXT,
      ranking_profile_id TEXT NOT NULL,
      config_hash TEXT NOT NULL,
      baseline_generation_id TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      activated_at INTEGER,
      retired_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS retrieval_generation_assignments (
      tenant_id TEXT NOT NULL,
      project_scope_key TEXT NOT NULL DEFAULT '*',
      active_generation_id TEXT NOT NULL,
      shadow_generation_id TEXT,
      shadow_sample_rate REAL NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(tenant_id, project_scope_key)
    );
    CREATE TABLE IF NOT EXISTS retrieval_projection_jobs (
      id TEXT PRIMARY KEY,
      generation_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      project_id TEXT,
      cursor TEXT NOT NULL DEFAULT '',
      processed_sources INTEGER NOT NULL DEFAULT 0,
      projected_units INTEGER NOT NULL DEFAULT 0,
      record_digest TEXT,
      unit_digest TEXT,
      state TEXT NOT NULL,
      started_at INTEGER,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      error_code TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_retrieval_projection_jobs_scope
    ON retrieval_projection_jobs(generation_id, tenant_id, IFNULL(project_id, ''));
    CREATE TABLE IF NOT EXISTS retrieval_evaluation_events (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      project_id TEXT,
      query_hash TEXT NOT NULL,
      baseline_generation_id TEXT NOT NULL,
      candidate_generation_id TEXT NOT NULL,
      baseline_result_count INTEGER NOT NULL,
      candidate_result_count INTEGER NOT NULL,
      overlap_count INTEGER NOT NULL,
      baseline_empty INTEGER NOT NULL,
      candidate_empty INTEGER NOT NULL,
      candidate_degraded INTEGER NOT NULL,
      baseline_latency_ms REAL NOT NULL,
      candidate_latency_ms REAL NOT NULL,
      evidence_tokens INTEGER,
      projection_lag_ms INTEGER,
      error_code TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS retrieval_units (
      id TEXT PRIMARY KEY,
      generation_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      project_id TEXT,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      business_category_id TEXT,
      work_type TEXT,
      unit_type TEXT NOT NULL,
      text TEXT NOT NULL,
      speaker TEXT,
      event_at INTEGER,
      valid_from INTEGER,
      valid_until INTEGER,
      source_ref_json TEXT,
      source_span_start INTEGER,
      source_span_end INTEGER,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      segment_id TEXT,
      content_hash TEXT NOT NULL,
      extractor_name TEXT NOT NULL,
      extractor_version TEXT NOT NULL,
      extraction_state TEXT NOT NULL DEFAULT 'degraded',
      degraded_reason TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS retrieval_unit_embeddings (
      unit_id TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      feature_count INTEGER NOT NULL,
      vector_format TEXT NOT NULL DEFAULT 'sparse-fallback',
      vector_blob BLOB,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(tenant_id, generation_id, unit_id)
    );
    CREATE TABLE IF NOT EXISTS retrieval_unit_features (
      unit_id TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      feature_hash INTEGER NOT NULL,
      weight REAL NOT NULL,
      PRIMARY KEY(tenant_id, generation_id, unit_id, feature_hash)
    );
    CREATE TABLE IF NOT EXISTS retrieval_unit_feature_stats (
      generation_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      feature_hash INTEGER NOT NULL,
      document_count INTEGER NOT NULL,
      PRIMARY KEY(tenant_id, generation_id, feature_hash)
    );
  `);
  db.prepare(
    `INSERT OR IGNORE INTO retrieval_ranking_profiles(
       id, name, algorithm, config_json, config_hash, created_at
     ) VALUES(?,?,?,?,?,?)`
  ).run(
    "rank_default",
    "default",
    "reciprocal_rank_fusion",
    JSON.stringify({ rrf_constant: 60, semantic_weight: 0.9, atomic_weight: 1.2, profile_weight: 1.35, timeline_weight: 1.35 }),
    "builtin:rank_default:1",
    Date.now()
  );
  db.prepare(
    `INSERT OR IGNORE INTO retrieval_generations(
       id, label, unit_schema_version, extractor_name, extractor_version,
       embedding_profile_id, ranking_profile_id, config_hash,
       baseline_generation_id, status, created_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    "gen_baseline_units", "baseline_units", 1, "retrieval-units", "1",
    null, "rank_default", "builtin:baseline_units:1", null, "fallback", Date.now()
  );
  db.prepare(
    `INSERT OR IGNORE INTO retrieval_generations(
       id, label, unit_schema_version, extractor_name, extractor_version,
       embedding_profile_id, ranking_profile_id, config_hash,
       baseline_generation_id, status, created_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    "gen_structured_context", "structured_context", 2, "retrieval-units", "4",
    null, "rank_default", "builtin:structured_context:1", "gen_baseline_units", "shadow", Date.now()
  );
  db.prepare(
    `INSERT OR IGNORE INTO retrieval_generations(
       id, label, unit_schema_version, extractor_name, extractor_version,
       embedding_profile_id, ranking_profile_id, config_hash,
       baseline_generation_id, status, created_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    "gen_verified_learning", "verified_learning", 3, "verified-learning", "1",
    LOCAL_EMBEDDING_PROVIDER, "rank_default", "builtin:verified-learning:1", "gen_structured_context", "shadow", Date.now()
  );
  db.prepare(
    `UPDATE retrieval_generations
     SET embedding_profile_id = ?
     WHERE id = 'gen_verified_learning'
       AND embedding_profile_id = 'qwen3-embedding-0.6b'`
  ).run(LOCAL_EMBEDDING_PROVIDER);
}

function upgradeLegacyMemoryVersions(db) {
  const columns = tableColumns(db, "memory_versions");
  const definitions = {
    content: "TEXT NOT NULL DEFAULT ''",
    summary: "TEXT",
    tags_json: "TEXT",
    kind: "TEXT NOT NULL DEFAULT 'episodic'",
    lifecycle_state: "TEXT NOT NULL DEFAULT 'active'",
    scope_type: "TEXT NOT NULL DEFAULT 'tenant'",
    scope_key: "TEXT",
    actor_type: "TEXT",
    actor_id: "TEXT",
    confidence_score: "REAL",
    utility_score: "REAL",
    canonical_key: "TEXT",
    business_category_id: "TEXT",
    work_type: "TEXT",
    reuse_rule: "TEXT",
    snapshot_json: "TEXT",
    content_hash: "TEXT NOT NULL DEFAULT ''"
  };
  for (const [name, definition] of Object.entries(definitions)) {
    if (!columns.has(name)) db.exec(`ALTER TABLE memory_versions ADD COLUMN "${name}" ${definition}`);
  }
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
         capture_origin = COALESCE(NULLIF(capture_origin, ''), 'legacy'),
         verification_state = COALESCE(NULLIF(verification_state, ''), 'unverified'),
         created_at = CASE WHEN created_at = 0 THEN ? ELSE created_at END,
         updated_at = CASE WHEN updated_at = 0 THEN created_at ELSE updated_at END,
         root_memory_id = COALESCE(root_memory_id, id),
         revised_at = COALESCE(revised_at, created_at)`
  ).run(now);

  const missingHashes = db.prepare("SELECT id, content FROM memories WHERE content_hash = ''").all();
  const updateHash = db.prepare("UPDATE memories SET content_hash = ? WHERE id = ?");
  for (const row of missingHashes) updateHash.run(hashContent(row.content), row.id);
}

function upgradeMemoryUsageItems(db) {
  const columns = tableColumns(db, "memory_usage_items");
  if (!columns.has("used_state_source")) {
    db.exec("ALTER TABLE memory_usage_items ADD COLUMN used_state_source TEXT NOT NULL DEFAULT 'reported'");
  }
}

function upgradeMemoryUsageEvents(db) {
  const columns = tableColumns(db, "memory_usage_events");
  if (!columns.has("external_run_id")) {
    db.exec("ALTER TABLE memory_usage_events ADD COLUMN external_run_id TEXT");
  }
  if (!columns.has("actor_principal")) {
    db.exec("ALTER TABLE memory_usage_events ADD COLUMN actor_principal TEXT");
  }
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

function upgradeIdentityTables(db) {
  const roleColumns = tableColumns(db, "principal_role_assignments");
  if (!roleColumns.has("source")) {
    db.exec("ALTER TABLE principal_role_assignments ADD COLUMN source TEXT NOT NULL DEFAULT 'local'");
  }
  if (!roleColumns.has("source_ref")) {
    db.exec("ALTER TABLE principal_role_assignments ADD COLUMN source_ref TEXT");
  }
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

function rebuildRetrievalUnitsV4Fts(db) {
  db.exec("DROP TABLE IF EXISTS memory_retrieval_units_v4_fts");
  db.exec(`
    CREATE VIRTUAL TABLE memory_retrieval_units_v4_fts USING fts5(
      unit_id UNINDEXED,
      memory_id UNINDEXED,
      tenant_id UNINDEXED,
      text,
      tokenize = 'unicode61'
    )
  `);
  db.exec(`
    INSERT INTO memory_retrieval_units_v4_fts(unit_id, memory_id, tenant_id, text)
    SELECT id, memory_id, tenant_id, text
    FROM memory_retrieval_units_v4
  `);
}

function rebuildStableRetrievalUnitsFts(db) {
  db.exec("DROP TABLE IF EXISTS retrieval_units_fts");
  db.exec(`
    CREATE VIRTUAL TABLE retrieval_units_fts USING fts5(
      unit_id UNINDEXED,
      generation_id UNINDEXED,
      tenant_id UNINDEXED,
      text,
      tokenize = 'unicode61'
    )
  `);
  db.exec(`
    INSERT INTO retrieval_units_fts(unit_id, generation_id, tenant_id, text)
    SELECT id, generation_id, tenant_id, text
    FROM retrieval_units
  `);
}

function rebuildStableRetrievalFeatureStats(db) {
  db.prepare("DELETE FROM retrieval_unit_feature_stats").run();
  db.exec(`
    INSERT INTO retrieval_unit_feature_stats(generation_id, tenant_id, feature_hash, document_count)
    SELECT generation_id, tenant_id, feature_hash, COUNT(DISTINCT unit_id)
    FROM retrieval_unit_features
    GROUP BY generation_id, tenant_id, feature_hash
  `);
}

function deleteStableRetrievalUnits(db, tenantId, sourceId) {
  const units = db.prepare(
    "SELECT id, generation_id FROM retrieval_units WHERE tenant_id = ? AND source_type = 'memory' AND source_id = ?"
  ).all(tenantId, sourceId);
  for (const unit of units) {
    db.prepare("DELETE FROM retrieval_unit_features WHERE tenant_id = ? AND generation_id = ? AND unit_id = ?")
      .run(tenantId, unit.generation_id, unit.id);
    db.prepare("DELETE FROM retrieval_unit_embeddings WHERE tenant_id = ? AND generation_id = ? AND unit_id = ?")
      .run(tenantId, unit.generation_id, unit.id);
  }
  db.prepare("DELETE FROM retrieval_units_fts WHERE tenant_id = ? AND unit_id IN (SELECT id FROM retrieval_units WHERE tenant_id = ? AND source_type = 'memory' AND source_id = ?)")
    .run(tenantId, tenantId, sourceId);
  db.prepare("DELETE FROM retrieval_units WHERE tenant_id = ? AND source_type = 'memory' AND source_id = ?")
    .run(tenantId, sourceId);
}

function writeStableRetrievalUnits(db, record, writeFts = true, deleteExisting = true, updateFeatureStats = true) {
  if (deleteExisting) deleteStableRetrievalUnits(db, record.tenant_id, record.id);
  if (record.lifecycle_state === "suppressed") return;
  const generations = [
    {
      id: "gen_baseline_units",
      units: "memory_retrieval_units",
      features: "memory_retrieval_unit_features",
      embeddings: "memory_retrieval_unit_embeddings",
      metadata: "'{}'",
      segment: "NULL",
      vectorFormat: "'sparse-fallback'",
      vectorBlob: "NULL"
    },
    {
      id: "gen_structured_context",
      units: "memory_retrieval_units_v4",
      features: "memory_retrieval_unit_features_v4",
      embeddings: "memory_retrieval_unit_embeddings_v4",
      metadata: "u.metadata_json",
      segment: "u.segment_id",
      vectorFormat: "e.vector_format",
      vectorBlob: "e.vector_blob"
    }
  ];
  for (const generation of generations) {
    db.prepare(
      `INSERT INTO retrieval_units(
         id, generation_id, tenant_id, project_id, source_type, source_id,
         business_category_id, work_type, unit_type, text, speaker, event_at,
         valid_from, valid_until, source_ref_json, source_span_start, source_span_end,
         metadata_json, segment_id, content_hash, extractor_name, extractor_version,
         extraction_state, degraded_reason, created_at
       )
       SELECT ? || ':' || u.id, ?, u.tenant_id, u.project_id, 'memory', u.memory_id,
              ?, ?, u.unit_type, u.text, u.speaker, u.event_at,
              u.valid_from, u.valid_until, u.source_ref_json, u.source_span_start,
              u.source_span_end, ${generation.metadata}, ${generation.segment},
              u.content_hash, u.extractor, u.extractor_version,
              u.extraction_state, u.degraded_reason, u.created_at
       FROM ${generation.units} u
       WHERE u.tenant_id = ? AND u.memory_id = ?`
    ).run(
      generation.id,
      generation.id,
      record.business_category_id ?? null,
      record.work_type ?? null,
      record.tenant_id,
      record.id
    );
    db.prepare(
      `INSERT INTO retrieval_unit_features(unit_id, generation_id, tenant_id, feature_hash, weight)
       SELECT ? || ':' || f.unit_id, ?, f.tenant_id, f.feature_hash, f.weight
       FROM ${generation.features} f
       JOIN ${generation.units} u ON u.tenant_id = f.tenant_id AND u.id = f.unit_id
       WHERE u.tenant_id = ? AND u.memory_id = ?`
    ).run(generation.id, generation.id, record.tenant_id, record.id);
    db.prepare(
      `INSERT INTO retrieval_unit_embeddings(
         unit_id, generation_id, tenant_id, provider, feature_count,
         vector_format, vector_blob, updated_at
       )
       SELECT ? || ':' || e.unit_id, ?, e.tenant_id, e.provider, e.feature_count,
              ${generation.vectorFormat}, ${generation.vectorBlob}, e.updated_at
       FROM ${generation.embeddings} e
       JOIN ${generation.units} u ON u.tenant_id = e.tenant_id AND u.id = e.unit_id
       WHERE u.tenant_id = ? AND u.memory_id = ?`
    ).run(generation.id, generation.id, record.tenant_id, record.id);
    if (writeFts) {
      db.prepare(
        `INSERT INTO retrieval_units_fts(unit_id, generation_id, tenant_id, text)
         SELECT id, generation_id, tenant_id, text
         FROM retrieval_units
         WHERE generation_id = ? AND tenant_id = ? AND source_type = 'memory' AND source_id = ?`
      ).run(generation.id, record.tenant_id, record.id);
    }
  }
  for (const unit of buildVerifiedLearningRetrievalUnits({
    ...record,
    learning_json: record.learning ? json(record.learning) : null
  })) {
    const unitId = `gen_verified_learning:${unit.id}`;
    db.prepare(
      `INSERT INTO retrieval_units(
         id, generation_id, tenant_id, project_id, source_type, source_id,
         business_category_id, work_type, unit_type, text, speaker, event_at,
         valid_from, valid_until, source_ref_json, source_span_start, source_span_end,
         metadata_json, segment_id, content_hash, extractor_name, extractor_version,
         extraction_state, degraded_reason, created_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      unitId, "gen_verified_learning", unit.tenant_id, unit.project_id, "memory", unit.memory_id,
      record.business_category_id ?? null, record.work_type ?? null, unit.unit_type, unit.text, unit.speaker,
      unit.event_at, unit.valid_from, unit.valid_until, unit.source_ref_json, unit.source_span_start,
      unit.source_span_end, unit.metadata_json, unit.segment_id, unit.content_hash, unit.extractor,
      unit.extractor_version, unit.extraction_state, unit.degraded_reason, unit.created_at
    );
    const features = embedLocalText(unit.text);
    for (const feature of features) {
      db.prepare(
        "INSERT INTO retrieval_unit_features(unit_id, generation_id, tenant_id, feature_hash, weight) VALUES(?,?,?,?,?)"
      ).run(unitId, "gen_verified_learning", unit.tenant_id, feature.feature_hash, feature.weight);
    }
    db.prepare(
      `INSERT INTO retrieval_unit_embeddings(
         unit_id, generation_id, tenant_id, provider, feature_count, vector_format, vector_blob, updated_at
       ) VALUES(?,?,?,?,?,?,?,?)`
    ).run(unitId, "gen_verified_learning", unit.tenant_id, LOCAL_EMBEDDING_PROVIDER, features.length, "sparse-fallback", null, unit.created_at);
    if (writeFts) db.prepare(
      "INSERT INTO retrieval_units_fts(unit_id, generation_id, tenant_id, text) VALUES(?,?,?,?)"
    ).run(unitId, "gen_verified_learning", unit.tenant_id, unit.text);
  }
  if (updateFeatureStats) rebuildStableRetrievalFeatureStats(db);
}

function rebuildStableRetrievalUnits(db) {
  db.prepare(
    `DELETE FROM retrieval_unit_features WHERE unit_id IN (
       SELECT id FROM retrieval_units WHERE source_type = 'memory'
     )`
  ).run();
  db.prepare(
    `DELETE FROM retrieval_unit_embeddings WHERE unit_id IN (
       SELECT id FROM retrieval_units WHERE source_type = 'memory'
     )`
  ).run();
  db.prepare("DELETE FROM retrieval_unit_feature_stats").run();
  db.prepare("DELETE FROM retrieval_units WHERE source_type = 'memory'").run();
  const rows = db.prepare("SELECT * FROM memories WHERE lifecycle_state != 'suppressed'").all();
  for (const row of rows) writeStableRetrievalUnits(db, memoryFromRow(row), false, false, false);
  rebuildStableRetrievalUnitsFts(db);
  rebuildStableRetrievalFeatureStats(db);
}

function deleteLocalEmbedding(db, tenantId, memoryId, updateFeatureStats = true) {
  const oldFeatures = updateFeatureStats
    ? db.prepare(
        "SELECT feature_hash FROM memory_embedding_features WHERE tenant_id = ? AND memory_id = ?"
      ).all(tenantId, memoryId)
    : [];
  db.prepare("DELETE FROM memory_embedding_features WHERE tenant_id = ? AND memory_id = ?")
    .run(tenantId, memoryId);
  db.prepare("DELETE FROM memory_embeddings WHERE tenant_id = ? AND memory_id = ?")
    .run(tenantId, memoryId);
  if (!updateFeatureStats) return;
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

function writeLocalEmbedding(db, record, updateFeatureStats = true) {
  deleteLocalEmbedding(db, record.tenant_id, record.id, updateFeatureStats);
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
    if (updateFeatureStats) incrementFeatureCount.run(record.tenant_id, feature.feature_hash);
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
  for (const row of rows) writeLocalEmbedding(db, memoryFromRow(row), false);
  db.exec(`
    INSERT INTO memory_embedding_feature_stats(tenant_id, feature_hash, document_count)
    SELECT tenant_id, feature_hash, COUNT(*)
    FROM memory_embedding_features
    GROUP BY tenant_id, feature_hash
  `);
}

function deleteRetrievalUnitEmbedding(db, tenantId, unitId, updateFeatureStats = true) {
  const oldFeatures = updateFeatureStats
    ? db.prepare(
        "SELECT feature_hash FROM memory_retrieval_unit_features WHERE tenant_id = ? AND unit_id = ?"
      ).all(tenantId, unitId)
    : [];
  db.prepare("DELETE FROM memory_retrieval_unit_features WHERE tenant_id = ? AND unit_id = ?")
    .run(tenantId, unitId);
  db.prepare("DELETE FROM memory_retrieval_unit_embeddings WHERE tenant_id = ? AND unit_id = ?")
    .run(tenantId, unitId);
  if (!updateFeatureStats) return;
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

function writeRetrievalUnitEmbedding(db, unit, updateFeatureStats = true) {
  deleteRetrievalUnitEmbedding(db, unit.tenant_id, unit.id, updateFeatureStats);
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
    if (updateFeatureStats) incrementFeatureCount.run(unit.tenant_id, feature.feature_hash);
  }
  db.prepare(
    `INSERT INTO memory_retrieval_unit_embeddings(unit_id, tenant_id, provider, feature_count, updated_at)
     VALUES(?,?,?,?,?)`
  ).run(unit.id, unit.tenant_id, LOCAL_EMBEDDING_PROVIDER, features.length, unit.created_at);
}

function deleteRetrievalUnits(db, tenantId, memoryId, updateFeatureStats = true) {
  const units = db.prepare(
    "SELECT id FROM memory_retrieval_units WHERE tenant_id = ? AND memory_id = ?"
  ).all(tenantId, memoryId);
  for (const unit of units) deleteRetrievalUnitEmbedding(db, tenantId, unit.id, updateFeatureStats);
  db.prepare("DELETE FROM memory_retrieval_units_fts WHERE tenant_id = ? AND memory_id = ?")
    .run(tenantId, memoryId);
  db.prepare("DELETE FROM memory_retrieval_units WHERE tenant_id = ? AND memory_id = ?")
    .run(tenantId, memoryId);
}

function writeRetrievalUnits(
  db,
  record,
  updateFeatureStats = true,
  writeFts = true,
  deleteExisting = true
) {
  if (deleteExisting) deleteRetrievalUnits(db, record.tenant_id, record.id, updateFeatureStats);
  if (record.lifecycle_state === "suppressed") return;
  const units = buildRetrievalUnits(record);
  const insertUnit = db.prepare(
    `INSERT INTO memory_retrieval_units(
      id, memory_id, tenant_id, project_id, unit_type, speaker, text, event_at,
      valid_from, valid_until, source_ref_json, source_span_start, source_span_end,
      content_hash, extractor, extractor_version, extraction_state, degraded_reason, created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const insertFts = writeFts
    ? db.prepare(
        `INSERT INTO memory_retrieval_units_fts(unit_id, memory_id, tenant_id, text)
         VALUES(?,?,?,?)`
      )
    : null;
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
    if (insertFts) insertFts.run(unit.id, unit.memory_id, unit.tenant_id, unit.text);
    writeRetrievalUnitEmbedding(db, unit, updateFeatureStats);
  }
}

function rebuildRetrievalUnits(db) {
  db.prepare("DELETE FROM memory_retrieval_unit_features").run();
  db.prepare("DELETE FROM memory_retrieval_unit_embeddings").run();
  db.prepare("DELETE FROM memory_retrieval_unit_feature_stats").run();
  db.prepare("DELETE FROM memory_retrieval_units").run();
  const rows = db.prepare("SELECT * FROM memories WHERE lifecycle_state != 'suppressed'").all();
  for (const row of rows) writeRetrievalUnits(db, memoryFromRow(row), false, false, false);
  rebuildRetrievalUnitsFts(db);
  db.exec(`
    INSERT INTO memory_retrieval_unit_feature_stats(tenant_id, feature_hash, document_count)
    SELECT tenant_id, feature_hash, COUNT(*)
    FROM memory_retrieval_unit_features
    GROUP BY tenant_id, feature_hash
  `);
}

function deleteRetrievalUnitsV4(db, tenantId, memoryId) {
  const ids = db.prepare(
    "SELECT id FROM memory_retrieval_units_v4 WHERE tenant_id = ? AND memory_id = ?"
  ).all(tenantId, memoryId).map((row) => row.id);
  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(
      `DELETE FROM memory_retrieval_unit_features_v4
       WHERE tenant_id = ? AND unit_id IN (${placeholders})`
    ).run(tenantId, ...ids);
    db.prepare(
      `DELETE FROM memory_retrieval_unit_embeddings_v4
       WHERE tenant_id = ? AND unit_id IN (${placeholders})`
    ).run(tenantId, ...ids);
  }
  db.prepare("DELETE FROM memory_retrieval_units_v4_fts WHERE tenant_id = ? AND memory_id = ?")
    .run(tenantId, memoryId);
  db.prepare("DELETE FROM memory_retrieval_units_v4 WHERE tenant_id = ? AND memory_id = ?")
    .run(tenantId, memoryId);
}

function wipeMemoryProjections(db, tenantId, memoryId) {
  db.prepare("DELETE FROM memories_fts WHERE tenant_id = ? AND memory_id = ?").run(tenantId, memoryId);
  deleteLocalEmbedding(db, tenantId, memoryId);
  deleteRetrievalUnits(db, tenantId, memoryId);
  deleteRetrievalUnitsV4(db, tenantId, memoryId);
  deleteStableRetrievalUnits(db, tenantId, memoryId);
  rebuildStableRetrievalFeatureStats(db);
}

function writeRetrievalUnitsV4(db, record, writeFts = true, deleteExisting = true) {
  if (deleteExisting) deleteRetrievalUnitsV4(db, record.tenant_id, record.id);
  if (record.lifecycle_state === "suppressed") return;
  const insertUnit = db.prepare(
    `INSERT INTO memory_retrieval_units_v4(
      id, memory_id, tenant_id, project_id, unit_type, speaker, text, event_at,
      valid_from, valid_until, source_ref_json, source_span_start, source_span_end,
      content_hash, metadata_json, segment_id, extractor, extractor_version,
      extraction_state, degraded_reason, created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const insertFts = writeFts
    ? db.prepare(
        `INSERT INTO memory_retrieval_units_v4_fts(unit_id, memory_id, tenant_id, text)
         VALUES(?,?,?,?)`
      )
    : null;
  const insertFeature = db.prepare(
    `INSERT INTO memory_retrieval_unit_features_v4(unit_id, tenant_id, feature_hash, weight)
     VALUES(?,?,?,?)`
  );
  const insertEmbedding = db.prepare(
    `INSERT INTO memory_retrieval_unit_embeddings_v4(
       unit_id, tenant_id, provider, feature_count, vector_format, vector_blob, updated_at
     ) VALUES(?,?,?,?,?,?,?)`
  );
  for (const unit of buildRetrievalUnitsV4(record)) {
    insertUnit.run(
      unit.id, unit.memory_id, unit.tenant_id, unit.project_id, unit.unit_type,
      unit.speaker, unit.text, unit.event_at, unit.valid_from, unit.valid_until,
      unit.source_ref_json, unit.source_span_start, unit.source_span_end,
      unit.content_hash, unit.metadata_json, unit.segment_id, unit.extractor,
      unit.extractor_version, unit.extraction_state, unit.degraded_reason, unit.created_at
    );
    if (insertFts) insertFts.run(unit.id, unit.memory_id, unit.tenant_id, unit.text);
    const features = embedLocalText(unit.text);
    for (const feature of features) {
      insertFeature.run(unit.id, unit.tenant_id, feature.feature_hash, feature.weight);
    }
    insertEmbedding.run(
      unit.id,
      unit.tenant_id,
      LOCAL_EMBEDDING_PROVIDER,
      features.length,
      "sparse-fallback",
      null,
      unit.created_at
    );
  }
}

function rebuildRetrievalUnitsV4(db) {
  db.prepare("DELETE FROM memory_retrieval_unit_features_v4").run();
  db.prepare("DELETE FROM memory_retrieval_unit_embeddings_v4").run();
  db.prepare("DELETE FROM memory_retrieval_unit_feature_stats_v4").run();
  db.prepare("DELETE FROM memory_retrieval_units_v4").run();
  const rows = db.prepare("SELECT * FROM memories WHERE lifecycle_state != 'suppressed'").all();
  for (const row of rows) writeRetrievalUnitsV4(db, memoryFromRow(row), false, false);
  rebuildRetrievalUnitsV4Fts(db);
  db.exec(`
    INSERT INTO memory_retrieval_unit_feature_stats_v4(tenant_id, feature_hash, document_count)
    SELECT tenant_id, feature_hash, COUNT(*)
    FROM memory_retrieval_unit_features_v4
    GROUP BY tenant_id, feature_hash
  `);
}

function addIndexes(db) {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_impact_idempotency
      ON memory_impact_events(tenant_id, reporter_principal, idempotency_key);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_impact_run_event
      ON memory_impact_events(tenant_id, external_run_id, event_type);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_impact_run_terminal
      ON memory_impact_events(tenant_id, external_run_id)
      WHERE event_type IN ('assessed', 'failed');
    CREATE INDEX IF NOT EXISTS idx_memory_impact_tenant_created
      ON memory_impact_events(tenant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_impact_project_created
      ON memory_impact_events(tenant_id, project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_impact_category_created
      ON memory_impact_events(tenant_id, avoided_lookup, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_impact_daily_tenant_day
      ON memory_impact_daily_metrics(tenant_id, day DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_external_key_v2
      ON memories(tenant_id, source, external_key)
      WHERE external_key IS NOT NULL AND external_key != '';
    CREATE INDEX IF NOT EXISTS idx_memories_tenant_project_updated
      ON memories(tenant_id, project_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_business_work
      ON memories(tenant_id, business_category_id, work_type, lifecycle_state, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_lifecycle_updated
      ON memories(tenant_id, lifecycle_state, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_learning_origin_state
      ON memories(tenant_id, capture_origin, verification_state, lifecycle_state, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_learning_scope
      ON memories(tenant_id, project_id, business_category_id, work_type, verification_state, valid_until);
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
    CREATE INDEX IF NOT EXISTS idx_retrieval_units_v4_parent
      ON memory_retrieval_units_v4(tenant_id, memory_id, unit_type);
    CREATE INDEX IF NOT EXISTS idx_retrieval_units_v4_segment
      ON memory_retrieval_units_v4(tenant_id, project_id, segment_id);
    CREATE INDEX IF NOT EXISTS idx_retrieval_units_v4_timeline
      ON memory_retrieval_units_v4(tenant_id, unit_type, event_at);
    CREATE INDEX IF NOT EXISTS idx_retrieval_unit_feature_v4_lookup
      ON memory_retrieval_unit_features_v4(tenant_id, feature_hash, unit_id);
    CREATE INDEX IF NOT EXISTS idx_business_categories_tenant_active
      ON business_categories(tenant_id, is_active, label);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_local_user_email
      ON user_profiles(tenant_id, lower(email)) WHERE email IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_local_users_status
      ON user_profiles(tenant_id, status, display_name);
    CREATE INDEX IF NOT EXISTS idx_local_group_members_principal
      ON group_members(tenant_id, principal);
    CREATE INDEX IF NOT EXISTS idx_memory_usage_events_tenant_created
      ON memory_usage_events(tenant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_usage_events_external_run
      ON memory_usage_events(tenant_id, external_run_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_usage_events_actor
      ON memory_usage_events(tenant_id, actor_principal, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_usage_items_source
      ON memory_usage_items(tenant_id, source_type, source_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_effect_events_usage
    ON memory_effect_events(tenant_id, usage_event_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_effect_events_root
    ON memory_effect_events(tenant_id, usage_event_id)
    WHERE supersedes_effect_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_effect_events_supersedes
    ON memory_effect_events(tenant_id, supersedes_effect_id)
    WHERE supersedes_effect_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_retrieval_units_source
      ON retrieval_units(generation_id, tenant_id, source_type, source_id, unit_type);
    CREATE INDEX IF NOT EXISTS idx_retrieval_units_business_work
      ON retrieval_units(generation_id, tenant_id, business_category_id, work_type, unit_type);
    CREATE INDEX IF NOT EXISTS idx_retrieval_unit_feature_lookup_stable
      ON retrieval_unit_features(tenant_id, generation_id, feature_hash, unit_id);
  `);
}

function dropRebuildIndexes(db) {
  db.exec(`
    DROP INDEX IF EXISTS idx_memory_embedding_lookup;
    DROP INDEX IF EXISTS idx_retrieval_units_parent;
    DROP INDEX IF EXISTS idx_retrieval_units_project;
    DROP INDEX IF EXISTS idx_retrieval_unit_feature_lookup;
    DROP INDEX IF EXISTS idx_retrieval_units_v4_parent;
    DROP INDEX IF EXISTS idx_retrieval_units_v4_segment;
    DROP INDEX IF EXISTS idx_retrieval_units_v4_timeline;
    DROP INDEX IF EXISTS idx_retrieval_unit_feature_v4_lookup;
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
      id, memory_id, tenant_id, version, operation, content, summary, tags_json,
      kind, lifecycle_state, scope_type, scope_key, actor_type, actor_id,
      confidence_score, utility_score, canonical_key, snapshot_json, content_hash, created_at
      , business_category_id, work_type, reuse_rule
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  for (const row of rows) {
    const memory = memoryFromRow(row);
    insert.run(
      randomUUID(), row.id, row.tenant_id, row.current_version || 1, "capture",
      row.content, row.summary, row.tags_json, row.kind, row.lifecycle_state,
      row.scope_type, row.scope_key, row.actor_type, row.actor_id,
      row.confidence_score, row.utility_score, row.canonical_key,
      JSON.stringify(memory), row.content_hash, row.updated_at,
      row.business_category_id ?? null, row.work_type ?? null, row.reuse_rule ?? null
    );
  }
}

function migrateSchema(db) {
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
  db.exec("BEGIN IMMEDIATE");
  try {
    // Databases upgraded through older releases may retain content-only FTS
    // triggers. Current writes maintain the richer FTS projection explicitly,
    // so keeping both writers creates orphan rows and eventually colliding FTS
    // rowids.
    dropLegacyFtsTriggers(db);
    createCanonicalTables(db);
    upgradeLegacyMemories(db);
    upgradeLegacyMemoryVersions(db);
    createCurrentTables(db);
    upgradeIdentityTables(db);
    upgradeMemoryUsageEvents(db);
    upgradeMemoryUsageItems(db);
    addIndexes(db);
    rebuildFts(db);
    rebuildLocalEmbeddings(db);
    rebuildRetrievalUnits(db);
    rebuildRetrievalUnitsV4(db);
    rebuildStableRetrievalUnits(db);
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

function buildFtsQueryFromTokens(inputTokens, operator = "AND") {
  const tokens = inputTokens
    .map((token) => token.replaceAll('"', ""))
    .slice(0, 16);
  return tokens.map((token) => `"${token}"*`).join(` ${operator} `);
}

function buildFtsQuery(query, operator = "AND") {
  return buildFtsQueryFromTokens(retrievalQueryTokens(query), operator);
}

function buildFtsQueryVariants(query) {
  return [...new Set([
    buildFtsQuery(query, "AND"),
    buildFtsQuery(query, "OR")
  ].filter(Boolean))];
}

function buildFtsTokenQueryVariants(tokens) {
  return [...new Set([
    buildFtsQueryFromTokens(tokens, "AND"),
    buildFtsQueryFromTokens(tokens, "OR")
  ].filter(Boolean))];
}

function runFtsCandidates(queryVariants, execute) {
  let rows = [];
  for (const query of queryVariants) {
    rows = execute(query);
    if (rows.length > 0) return rows;
  }
  return rows;
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
  minimumTotalScore,
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
  const ftsQueries = buildFtsQueryVariants(query);
  const subjectFtsQueries = buildFtsTokenQueryVariants(retrievalSubjectQueryTokens(query));
  const loadLexicalRows = (queryVariants) => runFtsCandidates(queryVariants, (ftsQuery) =>
    db.prepare(
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
  );
  const lexicalRows = loadLexicalRows(ftsQueries);
  const subjectLexicalRows =
    ftsQueries.length === subjectFtsQueries.length &&
    ftsQueries.every((ftsQuery, index) => ftsQuery === subjectFtsQueries[index])
      ? lexicalRows
      : loadLexicalRows(subjectFtsQueries);
  const relativeWindowMs =
    relativeAgeMs === null
      ? null
      : intent.relative_weekday !== null
        ? 24 * 60 * 60 * 1000
        : Math.max(24 * 60 * 60 * 1000, Math.min(30 * 24 * 60 * 60 * 1000, relativeAgeMs * 0.5));
  const loadTemporalLexicalRows = (queryVariants, orderBy) =>
    runFtsCandidates(queryVariants, (ftsQuery) =>
      db.prepare(
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
         ORDER BY ${orderBy}
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
    );
  const temporalLexicalRows =
    subjectFtsQueries.length > 0 && relativeTargetAt !== null && relativeWindowMs !== null
      ? loadTemporalLexicalRows(
        subjectFtsQueries,
        `ABS(COALESCE(u.event_at, u.created_at) - ?) ASC,
         bm25(memory_retrieval_units_fts) ASC,
         u.content_hash ASC,
         COALESCE(u.event_at, u.created_at) ASC`
      )
      : [];
  const temporalRelevanceRows =
    subjectFtsQueries.length > 0 && relativeTargetAt !== null && relativeWindowMs !== null
      ? loadTemporalLexicalRows(
        subjectFtsQueries,
        `bm25(memory_retrieval_units_fts) ASC,
         ABS(COALESCE(u.event_at, u.created_at) - ?) ASC,
         u.content_hash ASC,
         COALESCE(u.event_at, u.created_at) ASC`
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
  const intentCandidateTypes = intent.unit_types.filter(
    (unitType) => unitType === "instruction"
  );
  const intentRows = intentCandidateTypes.length === 0
    ? []
    : db.prepare(
      `SELECT u.*, NULL AS raw_rank
       FROM memory_retrieval_units u
       JOIN memories m
         ON m.id = u.memory_id
        AND m.tenant_id = u.tenant_id
       WHERE u.tenant_id = ?
         AND u.unit_type IN (${intentCandidateTypes.map(() => "?").join(",")})
         AND (u.speaker IS NULL OR u.speaker IN ('user', 'unknown'))
         AND (? IS NULL OR u.project_id = ?)
         AND (? = 1 OR m.lifecycle_state != 'suppressed')
         AND (u.valid_from IS NULL OR u.valid_from <= ?)
         AND (u.valid_until IS NULL OR u.valid_until > ?)
       ORDER BY COALESCE(u.event_at, u.created_at) DESC, u.content_hash ASC
       LIMIT ?`
    ).all(
      tenantId,
      ...intentCandidateTypes,
      projectId,
      projectId,
      includeSuppressed ? 1 : 0,
      at,
      at,
      candidateLimit
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
  const semanticRows = queryFeatures.length === 0
    ? []
    : db.prepare(
      `WITH query_features(feature_hash, query_weight) AS (
         VALUES ${queryFeatures.map(() => "(?, ?)").join(",")}
       )
       SELECT f.unit_id AS unitId,
              SUM(f.weight * q.query_weight) AS score
       FROM query_features q
       CROSS JOIN memory_retrieval_unit_features f INDEXED BY idx_retrieval_unit_feature_lookup
         ON f.feature_hash = q.feature_hash
       JOIN memory_retrieval_units u
         ON u.id = f.unit_id
        AND u.tenant_id = f.tenant_id
       WHERE f.tenant_id = ?
       GROUP BY f.unit_id
       ORDER BY score DESC, u.content_hash, u.unit_type,
                COALESCE(u.event_at, u.created_at), u.text
       LIMIT ?`
    ).all(
      ...queryFeatures.flatMap((feature) => [feature.feature_hash, feature.weight]),
      tenantId,
      candidateLimit
    ).map((row) => ({ unitId: row.unitId, score: Number(row.score) }));
  const unitById = new Map(lexicalRows.map((row) => [row.id, row]));
  for (const row of subjectLexicalRows) unitById.set(row.id, row);
  for (const row of temporalLexicalRows) unitById.set(row.id, row);
  for (const row of temporalRelevanceRows) unitById.set(row.id, row);
  for (const row of temporalRows) unitById.set(row.id, row);
  for (const row of intentRows) unitById.set(row.id, row);
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
  subjectLexicalRows.forEach((row, index) => {
    fusedByUnit.set(row.id, (fusedByUnit.get(row.id) ?? 0) + 1.25 / (60 + index + 1));
  });
  temporalLexicalRows.forEach((row, index) => {
    fusedByUnit.set(row.id, (fusedByUnit.get(row.id) ?? 0) + 1 / (60 + index + 1));
  });
  temporalRelevanceRows.forEach((row, index) => {
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
  intentRows.forEach((row, index) => {
    fusedByUnit.set(row.id, (fusedByUnit.get(row.id) ?? 0) + 0.8 / (60 + index + 1));
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
          lexical:
            lexicalRows.some((unit) => unit.memory_id === memoryId) ||
            subjectLexicalRows.some((unit) => unit.memory_id === memoryId)
              ? 1
              : 0,
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
    )
    .filter((entry) => minimumTotalScore === null || entry.score.total >= minimumTotalScore);
  const selected = ranked.slice(0, limit);
  if (relativeTargetAt !== null) {
    const reservedMemoryIds = [...new Set(
      [
        ...temporalLexicalRows.slice(0, 2).map((row) => row.memory_id),
        ...temporalRelevanceRows.slice(0, 2).map((row) => row.memory_id),
        ...temporalRows.map((row) => row.memory_id)
      ]
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

function searchRetrievalUnitsV4(db, options) {
  const {
    tenantId,
    projectId,
    query,
    limit,
    minimumTotalScore,
    includeSuppressed,
    principalId,
    at,
    denseQueryVector = null,
    denseProvider = null
  } = options;
  const intent = analyzeRetrievalIntent(query);
  const ftsQueries = buildFtsQueryVariants(query);
  if (ftsQueries.length === 0) throw new Error("search requires a query");
  const base = searchRetrievalUnitsV3(db, { ...options, limit: 50 });
  const exactFtsQuery = buildFtsQuery(query, "AND");
  const exactRows = exactFtsQuery
    ? db.prepare(
      `SELECT m.id AS memory_id, bm25(memories_fts) AS raw_rank
       FROM memories_fts
       JOIN memories m
         ON m.id = memories_fts.memory_id
        AND m.tenant_id = memories_fts.tenant_id
       WHERE memories_fts.tenant_id = ?
         AND memories_fts MATCH ?
         AND (? IS NULL OR m.project_id = ?)
         AND (? = 1 OR m.lifecycle_state != 'suppressed')
         AND (m.valid_from IS NULL OR m.valid_from <= ?)
         AND (m.valid_until IS NULL OR m.valid_until > ?)
       ORDER BY bm25(memories_fts), m.content_hash
       LIMIT 50`
    ).all(
      tenantId,
      exactFtsQuery,
      projectId,
      projectId,
      includeSuppressed ? 1 : 0,
      at,
      at
    )
    : [];
  const channel = (unitTypes, channelLimit = 50, queryVariants = ftsQueries) => {
    const placeholders = unitTypes.map(() => "?").join(",");
    return runFtsCandidates(queryVariants, (ftsQuery) =>
      db.prepare(
        `SELECT u.memory_id, u.id AS unit_id, u.unit_type, u.event_at,
                u.metadata_json, bm25(memory_retrieval_units_v4_fts) AS raw_rank
         FROM memory_retrieval_units_v4_fts
         JOIN memory_retrieval_units_v4 u
           ON u.id = memory_retrieval_units_v4_fts.unit_id
          AND u.tenant_id = memory_retrieval_units_v4_fts.tenant_id
         JOIN memories m
           ON m.id = u.memory_id
          AND m.tenant_id = u.tenant_id
         WHERE memory_retrieval_units_v4_fts.tenant_id = ?
           AND memory_retrieval_units_v4_fts MATCH ?
           AND u.unit_type IN (${placeholders})
           AND (? IS NULL OR u.project_id = ?)
           AND (? = 1 OR m.lifecycle_state != 'suppressed')
           AND (u.valid_from IS NULL OR u.valid_from <= ?)
           AND (u.valid_until IS NULL OR u.valid_until > ?)
         ORDER BY bm25(memory_retrieval_units_v4_fts), u.content_hash
         LIMIT ?`
      ).all(
        tenantId,
        ftsQuery,
        ...unitTypes,
        projectId,
        projectId,
        includeSuppressed ? 1 : 0,
        at,
        at,
        channelLimit
      )
    );
  };
  const strictFtsQueries = ftsQueries.slice(0, 1);
  let lexicalRows = channel(["atomic"], 50, strictFtsQueries);
  let profileRows = channel(["profile", "ledger"], 50, strictFtsQueries);
  let timelineRows = channel(["timeline"], 50, strictFtsQueries);
  let segmentRows = channel(["segment"], 24, strictFtsQueries);
  if (
    ftsQueries.length > strictFtsQueries.length &&
    [lexicalRows, profileRows, timelineRows, segmentRows].every((rows) => rows.length === 0)
  ) {
    lexicalRows = channel(["atomic"], 50);
    profileRows = channel(["profile", "ledger"], 50);
    timelineRows = channel(["timeline"], 50);
    segmentRows = channel(["segment"], 24);
  }
  const queryFeatures = embedLocalText(query).slice(0, 24);
  const segmentMemoryIds = [...new Set(segmentRows.map((row) => row.memory_id))];
  const sparseRows = queryFeatures.length === 0
    ? []
    : db.prepare(
      `WITH query_features(feature_hash, query_weight) AS (
         VALUES ${queryFeatures.map(() => "(?, ?)").join(",")}
       )
       SELECT u.memory_id, SUM(f.weight * q.query_weight) AS sparse_score
       FROM memory_retrieval_unit_features_v4 f
       JOIN query_features q ON q.feature_hash = f.feature_hash
       JOIN memory_retrieval_units_v4 u
         ON u.id = f.unit_id
        AND u.tenant_id = f.tenant_id
       JOIN memories m
         ON m.id = u.memory_id
        AND m.tenant_id = u.tenant_id
       WHERE f.tenant_id = ?
         AND (? IS NULL OR u.project_id = ?)
         AND (? = 1 OR m.lifecycle_state != 'suppressed')
         AND (u.valid_from IS NULL OR u.valid_from <= ?)
         AND (u.valid_until IS NULL OR u.valid_until > ?)
         ${segmentMemoryIds.length > 0
           ? `AND u.memory_id IN (${segmentMemoryIds.map(() => "?").join(",")})`
           : ""}
       GROUP BY u.memory_id
       ORDER BY sparse_score DESC, u.memory_id
       LIMIT 50`
    ).all(
      ...queryFeatures.flatMap((feature) => [feature.feature_hash, feature.weight]),
      tenantId,
      projectId,
      projectId,
      includeSuppressed ? 1 : 0,
      at,
      at,
      ...segmentMemoryIds
    );
  const denseRows = !denseQueryVector || !denseProvider
    ? []
    : (() => {
      const rows = db.prepare(
        `SELECT u.memory_id, e.unit_id, e.feature_count, e.vector_blob
         FROM memory_retrieval_unit_embeddings_v4 e
         JOIN memory_retrieval_units_v4 u
           ON u.id = e.unit_id
          AND u.tenant_id = e.tenant_id
         JOIN memories m
           ON m.id = u.memory_id
          AND m.tenant_id = u.tenant_id
         WHERE e.tenant_id = ?
           AND e.provider = ?
           AND e.vector_format = 'dense-f32'
           AND e.vector_blob IS NOT NULL
           AND u.unit_type = 'segment'
           AND (? IS NULL OR u.project_id = ?)
           AND (? = 1 OR m.lifecycle_state != 'suppressed')
           AND (u.valid_from IS NULL OR u.valid_from <= ?)
           AND (u.valid_until IS NULL OR u.valid_until > ?)`
      ).all(
        tenantId,
        denseProvider,
        projectId,
        projectId,
        includeSuppressed ? 1 : 0,
        at,
        at
      );
      const bestByMemory = new Map();
      for (const row of rows) {
        const vector = decodeFloat32Vector(row.vector_blob, Number(row.feature_count));
        const score = cosineSimilarity(denseQueryVector, vector);
        const current = bestByMemory.get(row.memory_id);
        if (!current || score > current.dense_score) {
          bestByMemory.set(row.memory_id, { memory_id: row.memory_id, dense_score: score });
        }
      }
      return [...bestByMemory.values()]
        .sort((left, right) => right.dense_score - left.dense_score || left.memory_id.localeCompare(right.memory_id))
        .slice(0, 50);
    })();
  const scores = new Map();
  const addRrf = (rows, weight) => {
    rows.forEach((row, index) => {
      const memoryId = row.memory_id ?? row.memory?.id;
      if (!memoryId) return;
      scores.set(memoryId, (scores.get(memoryId) ?? 0) + weight / (60 + index + 1));
    });
  };
  addRrf(base, 1);
  addRrf(exactRows, 3);
  addRrf(sparseRows, 0.9);
  addRrf(denseRows, 1.2);
  addRrf(segmentRows, 0.65);
  for (const row of denseRows) {
    const normalized = Math.max(0, Math.min(1, (row.dense_score + 1) / 2));
    scores.set(row.memory_id, (scores.get(row.memory_id) ?? 0) + normalized * 0.5);
  }
  const structuralScores = new Map();
  const addStructuralRrf = (rows, weight) => {
    rows.forEach((row, index) => {
      const contribution = weight / (60 + index + 1);
      structuralScores.set(
        row.memory_id,
        Math.max(structuralScores.get(row.memory_id) ?? 0, contribution)
      );
    });
  };
  addStructuralRrf(lexicalRows, 1.2);
  if (intent.unit_types.some((type) =>
    ["preference", "instruction", "update", "fact"].includes(type)
  )) {
    addStructuralRrf(profileRows, 1.35);
  }
  if (intent.temporal_direction || intent.relative_age_ms !== null || intent.relative_weekday !== null) {
    addStructuralRrf(timelineRows, 1.35);
  }
  for (const [memoryId, contribution] of structuralScores) {
    scores.set(memoryId, (scores.get(memoryId) ?? 0) + contribution);
  }

  const baseById = new Map(base.map((entry) => [entry.memory.id, {
    ...entry,
    score: { ...entry.score, authority: memoryAuthority(entry.memory) }
  }]));
  const candidateIds = [...scores.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 50)
    .map(([id]) => id);
  const missingIds = candidateIds.filter((id) => !baseById.has(id));
  if (missingIds.length > 0) {
    const placeholders = missingIds.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT * FROM memories WHERE tenant_id = ? AND id IN (${placeholders})`
    ).all(tenantId, ...missingIds);
    for (const row of rows) {
      const memory = memoryFromRow(row);
      if (!memory || !canReadMemory(memory, principalId)) continue;
      baseById.set(memory.id, {
        memory,
        score: {
          total: 0,
          lexical: 0,
          semantic: 0,
          graph: 0,
          time: 0,
          authority: memoryAuthority(memory),
          utility: Number(memory.utility_score ?? 0.5)
        }
      });
    }
  }
  const ranked = candidateIds.flatMap((id) => {
    const entry = baseById.get(id);
    if (!entry) return [];
    const total = scores.get(id) ?? 0;
    const denseMatch = denseRows.find((row) => row.memory_id === id);
    if (minimumTotalScore !== null && total < minimumTotalScore) return [];
    return [{
      memory: entry.memory,
      score: {
        ...entry.score,
        total: Number(total.toFixed(6)),
        lexical: lexicalRows.some((row) => row.memory_id === id) ? 1 : entry.score.lexical,
        semantic: denseMatch
          ? Number(Math.max(0, Math.min(1, (denseMatch.dense_score + 1) / 2)).toFixed(6))
          : sparseRows.some((row) => row.memory_id === id)
            ? 1
            : entry.score.semantic,
        time: timelineRows.some((row) => row.memory_id === id) ? 1 : entry.score.time
      }
    }];
  }).sort((left, right) => {
    const relevanceDelta = right.score.total - left.score.total;
    if (Math.abs(relevanceDelta) > 0.002) return relevanceDelta;
    return right.score.authority - left.score.authority ||
      relevanceDelta ||
      left.memory.id.localeCompare(right.memory.id);
  });

  const multiEvidence = /\b(?:and|compare|both|between|combined|together|how many)\b|(?:かつ|両方|比較|合計|複数)/iu.test(query);
  if (!multiEvidence) return ranked.slice(0, limit);
  const selected = [];
  const sources = new Set();
  for (const entry of ranked) {
    const source = String(entry.memory.source_references[0]?.ref ?? entry.memory.id);
    if (selected.length < Math.min(3, limit) && sources.has(source)) continue;
    selected.push(entry);
    sources.add(source);
    if (selected.length === limit) break;
  }
  for (const entry of ranked) {
    if (selected.length === limit) break;
    if (!selected.some((item) => item.memory.id === entry.memory.id)) selected.push(entry);
  }
  return selected;
}

function readMode(path) {
  return stat(path).then((info) => info.mode & 0o777);
}

function utcDay(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function dayBounds(day) {
  const start = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(start)) throw new Error("day must be YYYY-MM-DD");
  return { start, end: start + 86_400_000 };
}

function rebuildMemoryImpactDay(db, tenantId, day) {
  const { start, end } = dayBounds(day);
  const rows = db.prepare(
    `SELECT
       ui.*, ue.project_id AS usage_project_id, ue.verification_sampled,
       ee.id AS effect_id, ee.evidence_level, ee.effect_outcome,
       ee.avoided_lookup_categories_json, ee.failure_opportunity_state,
       ee.failure_avoided,
       previous_attribution.gross_saved_tokens AS previous_gross_saved_tokens,
       ea.gross_saved_tokens AS attributed_gross_saved_tokens,
       ea.net_saved_tokens AS attributed_net_saved_tokens,
       ea.failure_saved_tokens AS attributed_failure_saved_tokens
     FROM memory_usage_items ui
     JOIN memory_usage_events ue
       ON ue.tenant_id = ui.tenant_id AND ue.id = ui.usage_event_id
     LEFT JOIN memory_effect_events ee
       ON ee.tenant_id = ui.tenant_id
      AND ee.id = (
        SELECT candidate.id
        FROM memory_effect_events candidate
        WHERE candidate.tenant_id = ui.tenant_id
          AND candidate.usage_event_id = ui.usage_event_id
          AND NOT EXISTS (
            SELECT 1 FROM memory_effect_events child
            WHERE child.tenant_id = candidate.tenant_id
              AND child.supersedes_effect_id = candidate.id
          )
        ORDER BY candidate.created_at DESC, candidate.id DESC
        LIMIT 1
      )
     LEFT JOIN memory_effect_attributions ea
       ON ea.tenant_id = ui.tenant_id
      AND ea.effect_event_id = ee.id
      AND ea.usage_item_id = ui.id
     LEFT JOIN memory_effect_events previous
       ON previous.tenant_id = ee.tenant_id
      AND previous.id = ee.supersedes_effect_id
     LEFT JOIN memory_effect_attributions previous_attribution
       ON previous_attribution.tenant_id = previous.tenant_id
      AND previous_attribution.effect_event_id = previous.id
      AND previous_attribution.usage_item_id = ui.id
     WHERE ui.tenant_id = ? AND ui.created_at >= ? AND ui.created_at < ?`
  ).all(tenantId, start, end);
  const groups = new Map();
  for (const row of rows) {
    const dimensions = [
      row.source_type,
      row.source_id,
      row.usage_project_id ?? "",
      row.business_category_id_snapshot ?? "",
      row.work_type_snapshot ?? "",
      row.quality_category_snapshot ?? ""
    ];
    const key = dimensions.join("\0");
    const metric = groups.get(key) ?? {
      source_type: row.source_type,
      source_id: row.source_id,
      project_id_snapshot: row.usage_project_id ?? null,
      business_category_id_snapshot: row.business_category_id_snapshot ?? null,
      work_type_snapshot: row.work_type_snapshot ?? null,
      quality_category_snapshot: row.quality_category_snapshot ?? null,
      reference_count: 0,
      used_count: 0,
      effect_reported_count: 0,
      positive_count: 0,
      neutral_count: 0,
      negative_count: 0,
      unknown_count: 0,
      avoided_source_search_count: 0,
      avoided_web_search_count: 0,
      avoided_past_context_count: 0,
      avoided_none_count: 0,
      gross_saved_tokens: 0,
      injected_tokens: 0,
      net_saved_tokens: 0,
      failure_opportunity_count: 0,
      failure_avoided_count: 0,
      failure_saved_tokens: 0,
      verification_sampled_count: 0,
      verified_count: 0,
      estimator_absolute_error_sum: 0
    };
    metric.reference_count += 1;
    metric.used_count += row.used_state === "used" ? 1 : 0;
    metric.verification_sampled_count += Number(row.verification_sampled ?? 0);
    if (row.effect_id && row.attributed_gross_saved_tokens !== null) {
      metric.effect_reported_count += 1;
      metric[`${row.effect_outcome}_count`] += 1;
      metric.verified_count += row.evidence_level === "verified" && Number(row.verification_sampled ?? 0) === 1 ? 1 : 0;
      const avoided = parseJson(row.avoided_lookup_categories_json);
      for (const category of avoided) {
        const field = `avoided_${category}_count`;
        if (Object.hasOwn(metric, field)) metric[field] += 1;
      }
      metric.gross_saved_tokens += Number(row.attributed_gross_saved_tokens ?? 0);
      metric.net_saved_tokens += Number(row.attributed_net_saved_tokens ?? 0);
      metric.injected_tokens += Number(row.attributed_gross_saved_tokens ?? 0) -
        Number(row.attributed_net_saved_tokens ?? 0);
      metric.failure_opportunity_count += row.failure_opportunity_state === "applicable" ? 1 : 0;
      metric.failure_avoided_count += Number(row.failure_avoided ?? 0);
      metric.failure_saved_tokens += Number(row.attributed_failure_saved_tokens ?? 0);
      if (row.evidence_level === "verified" && row.previous_gross_saved_tokens !== null) {
        metric.estimator_absolute_error_sum += Math.abs(
          Number(row.attributed_gross_saved_tokens ?? 0) -
          Number(row.previous_gross_saved_tokens ?? 0)
        );
      }
    }
    groups.set(key, metric);
  }
  db.prepare("DELETE FROM memory_effect_daily_metrics WHERE tenant_id = ? AND day = ?").run(tenantId, day);
  const insert = db.prepare(
    `INSERT INTO memory_effect_daily_metrics(
       id, day, tenant_id, source_type, source_id, project_id_snapshot,
       business_category_id_snapshot, work_type_snapshot, quality_category_snapshot,
       reference_count, used_count, effect_reported_count,
       positive_count, neutral_count, negative_count, unknown_count,
       avoided_source_search_count, avoided_web_search_count,
       avoided_past_context_count, avoided_none_count,
       gross_saved_tokens, injected_tokens, net_saved_tokens,
       failure_opportunity_count, failure_avoided_count, failure_saved_tokens,
       verification_sampled_count, verified_count, estimator_absolute_error_sum,
       created_at, updated_at
     ) VALUES(${Array.from({ length: 31 }, () => "?").join(",")})`
  );
  const now = Date.now();
  for (const [key, metric] of groups) {
    const id = createHash("sha256").update(`${day}\0${tenantId}\0${key}`).digest("hex");
    insert.run(
      id, day, tenantId, metric.source_type, metric.source_id,
      metric.project_id_snapshot, metric.business_category_id_snapshot,
      metric.work_type_snapshot, metric.quality_category_snapshot,
      metric.reference_count, metric.used_count, metric.effect_reported_count,
      metric.positive_count, metric.neutral_count, metric.negative_count, metric.unknown_count,
      metric.avoided_source_search_count, metric.avoided_web_search_count,
      metric.avoided_past_context_count, metric.avoided_none_count,
      metric.gross_saved_tokens, metric.injected_tokens, metric.net_saved_tokens,
      metric.failure_opportunity_count, metric.failure_avoided_count, metric.failure_saved_tokens,
      metric.verification_sampled_count, metric.verified_count,
      metric.estimator_absolute_error_sum, now, now
    );
  }
  return { day, row_count: groups.size };
}

function summarizeExecutionImpact(events) {
  const runs = new Map();
  for (const event of events) {
    const run = runs.get(event.external_run_id) ?? {
      eligible: false,
      assessed: false,
      failed: false,
      memoryUsed: false,
      avoidedLookup: "none"
    };
    if (event.event_type === "eligible") run.eligible = true;
    if (event.event_type === "failed") run.failed = true;
    if (event.event_type === "assessed") {
      run.assessed = true;
      run.memoryUsed = event.memory_used === 1;
      run.avoidedLookup = event.avoided_lookup ?? "none";
    }
    runs.set(event.external_run_id, run);
  }
  const values = [...runs.values()];
  const eligibleRuns = values.filter((run) => run.eligible).length;
  const assessedRuns = values.filter((run) => run.assessed).length;
  const failedRuns = values.filter((run) => run.failed).length;
  const memoryUsedRuns = values.filter((run) => run.assessed && run.memoryUsed).length;
  const avoidedRuns = values.filter((run) => run.assessed && run.memoryUsed && run.avoidedLookup !== "none").length;
  const byAvoidedLookup = { source_search: 0, web_search: 0, past_context: 0, none: 0 };
  for (const run of values.filter((item) => item.assessed)) byAvoidedLookup[run.avoidedLookup] += 1;
  const ratio = (numerator, denominator) => denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null;
  return {
    eligible_runs: eligibleRuns,
    assessed_runs: assessedRuns,
    failed_runs: failedRuns,
    memory_used_runs: memoryUsedRuns,
    avoided_runs: avoidedRuns,
    reporting_rate: ratio(assessedRuns + failedRuns, eligibleRuns),
    memory_usage_rate: ratio(memoryUsedRuns, assessedRuns),
    avoided_lookup_rate: ratio(avoidedRuns, memoryUsedRuns),
    by_avoided_lookup: byAvoidedLookup
  };
}

function rebuildExecutionImpactDay(db, tenantId, projectId, day) {
  const { start, end } = dayBounds(day);
  const projectKey = projectId ?? "";
  const events = db.prepare(
    `SELECT event_type, external_run_id, memory_used, avoided_lookup
     FROM memory_impact_events
     WHERE tenant_id = ? AND COALESCE(project_id, '') = ?
       AND occurred_at >= ? AND occurred_at < ?`
  ).all(tenantId, projectKey, start, end);
  const summary = summarizeExecutionImpact(events);
  const now = Date.now();
  db.prepare(
    `INSERT INTO memory_impact_daily_metrics(
       day, tenant_id, project_id, eligible_runs, assessed_runs, failed_runs,
       memory_used_runs, avoided_runs, reporting_rate, memory_usage_rate,
       avoided_lookup_rate, source_search_count, web_search_count,
       past_context_count, none_count, created_at, updated_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(day, tenant_id, project_id) DO UPDATE SET
       eligible_runs = excluded.eligible_runs,
       assessed_runs = excluded.assessed_runs,
       failed_runs = excluded.failed_runs,
       memory_used_runs = excluded.memory_used_runs,
       avoided_runs = excluded.avoided_runs,
       reporting_rate = excluded.reporting_rate,
       memory_usage_rate = excluded.memory_usage_rate,
       avoided_lookup_rate = excluded.avoided_lookup_rate,
       source_search_count = excluded.source_search_count,
       web_search_count = excluded.web_search_count,
       past_context_count = excluded.past_context_count,
       none_count = excluded.none_count,
       updated_at = excluded.updated_at`
  ).run(
    day, tenantId, projectKey, summary.eligible_runs, summary.assessed_runs,
    summary.failed_runs, summary.memory_used_runs, summary.avoided_runs,
    summary.reporting_rate, summary.memory_usage_rate, summary.avoided_lookup_rate,
    summary.by_avoided_lookup.source_search, summary.by_avoided_lookup.web_search,
    summary.by_avoided_lookup.past_context, summary.by_avoided_lookup.none, now, now
  );
  return summary;
}

export class LocalMemoryStore {
  constructor(dbPath = DEFAULT_LOCAL_DB, options = {}) {
    this.dbPath = resolve(dbPath);
    this.initialization = null;
    this.denseEmbeddingProvider = options.denseEmbeddingProvider === undefined
      ? localDenseEmbeddingProviderFromEnvironment()
      : options.denseEmbeddingProvider;
  }

  async init() {
    if (!this.initialization) {
      this.initialization = this.initialize().catch((error) => {
        this.initialization = null;
        throw error;
      });
    }
    await this.initialization;
    return this;
  }

  async initialize() {
    await enforcePrivatePermissions(this.dbPath);
    const existed = existsSync(this.dbPath);
    if (existed) {
      const probe = new DatabaseSync(this.dbPath);
      try {
        const currentVersion = Number(probe.prepare("PRAGMA user_version").get().user_version);
        const needsLegacyFtsRepair = hasLegacyFtsTriggers(probe);
        if (
          (currentVersion < MEMORY_SCHEMA_VERSION || needsLegacyFtsRepair) &&
          hasTable(probe, "memories")
        ) {
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
        hasLegacyFtsTriggers(db) ||
        !hasTable(db, "memory_versions") ||
        !hasTable(db, "memories_fts") ||
        !hasTable(db, "memory_embeddings") ||
        !hasTable(db, "memory_embedding_features") ||
        !hasTable(db, "memory_embedding_feature_stats") ||
        !hasTable(db, "memory_retrieval_units") ||
        !hasTable(db, "memory_retrieval_units_fts") ||
        !hasTable(db, "memory_retrieval_unit_embeddings") ||
        !hasTable(db, "memory_retrieval_unit_features") ||
        !hasTable(db, "memory_retrieval_unit_feature_stats") ||
        !hasTable(db, "memory_retrieval_units_v4") ||
        !hasTable(db, "memory_retrieval_units_v4_fts") ||
        !hasTable(db, "memory_retrieval_unit_embeddings_v4") ||
        !hasTable(db, "memory_retrieval_unit_features_v4") ||
        !hasTable(db, "memory_retrieval_unit_feature_stats_v4") ||
        !hasTable(db, "business_categories") ||
        !hasTable(db, "organizations") ||
        !hasTable(db, "user_profiles") ||
        !hasTable(db, "groups") ||
        !hasTable(db, "group_members") ||
        !hasTable(db, "memory_impact_events") ||
        !hasTable(db, "memory_impact_daily_metrics") ||
        !hasTable(db, "memory_usage_events") ||
        !hasTable(db, "memory_effect_events") ||
        !hasTable(db, "retrieval_generations") ||
        !hasTable(db, "retrieval_units") ||
        !hasTable(db, "retrieval_units_fts")
      ) {
        migrateSchema(db);
      } else {
        db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
      }
    } finally {
      db.close();
    }
    await enforcePrivatePermissions(this.dbPath);
  }

  open({ readOnly = false } = {}) {
    return new DatabaseSync(this.dbPath, { readOnly });
  }

  async startMemoryImpact(tenantId, input, principal = "local") {
    await this.init();
    const externalRunId = nullableString(input.external_run_id, 256);
    const idempotencyKey = nullableString(input.idempotency_key, 256);
    if (!externalRunId) throw new Error("external_run_id_required");
    if (!idempotencyKey) throw new Error("idempotency_key_required");
    return this.insertExecutionImpactEvent({
      tenantId,
      projectId: nullableString(input.project_id, 256),
      taskId: nullableString(input.task_id, 256),
      traceId: nullableString(input.trace_id, 256),
      externalRunId,
      eventType: "eligible",
      principal,
      agentName: nullableString(input.agent_name, 256),
      model: nullableString(input.model, 256),
      idempotencyKey,
      occurredAt: finiteNumber(input.occurred_at) ?? Date.now()
    });
  }

  async reportMemoryImpactExecution(tenantId, externalRunIdInput, input, principal = "local") {
    await this.init();
    const externalRunId = nullableString(externalRunIdInput, 256);
    const idempotencyKey = nullableString(input.idempotency_key, 256);
    if (!externalRunId) throw new Error("external_run_id_required");
    if (!idempotencyKey) throw new Error("idempotency_key_required");
    const outcome = input.outcome === "failed" ? "failed" : "assessed";
    const db = this.open({ readOnly: true });
    let eligible;
    try {
      eligible = db.prepare(
        `SELECT * FROM memory_impact_events
         WHERE tenant_id = ? AND external_run_id = ? AND event_type = 'eligible'`
      ).get(tenantId, externalRunId);
    } finally {
      db.close();
    }
    if (!eligible) {
      await this.startMemoryImpact(tenantId, {
        external_run_id: externalRunId,
        idempotency_key: `${idempotencyKey}:auto-start`,
        occurred_at: input.occurred_at
      }, principal);
      const reopened = this.open({ readOnly: true });
      try {
        eligible = reopened.prepare(
          `SELECT * FROM memory_impact_events
           WHERE tenant_id = ? AND external_run_id = ? AND event_type = 'eligible'`
        ).get(tenantId, externalRunId);
      } finally {
        reopened.close();
      }
    }
    if (outcome === "failed") {
      const failureCategory = ["agent_error", "tool_error", "cancelled", "unknown"].includes(input.failure_category)
        ? input.failure_category
        : "unknown";
      return this.insertExecutionImpactEvent({
        tenantId,
        projectId: eligible?.project_id ?? null,
        taskId: eligible?.task_id ?? null,
        traceId: eligible?.trace_id ?? null,
        externalRunId,
        eventType: "failed",
        failureCategory,
        principal,
        agentName: eligible?.agent_name ?? null,
        model: eligible?.model ?? null,
        idempotencyKey,
        occurredAt: finiteNumber(input.occurred_at) ?? Date.now()
      });
    }
    if (typeof input.memory_used !== "boolean") throw new Error("memory_used_required");
    const avoidedLookup = input.avoided_lookup;
    if (!["source_search", "web_search", "past_context", "none"].includes(avoidedLookup)) {
      throw new Error("invalid_avoided_lookup");
    }
    const memoryBasisIds = Array.isArray(input.memory_basis_ids)
      ? [...new Set(input.memory_basis_ids.map((id) => nullableString(id, 256)).filter(Boolean))]
      : [];
    const confidence = input.confidence == null ? null : input.confidence;
    if (!input.memory_used && (avoidedLookup !== "none" || memoryBasisIds.length > 0 || confidence !== null)) {
      throw new Error("invalid_unused_memory_impact");
    }
    if (input.memory_used && (memoryBasisIds.length === 0 || !["low", "medium", "high"].includes(confidence))) {
      throw new Error("memory_basis_and_confidence_required");
    }
    if (memoryBasisIds.length > 20) throw new Error("too_many_memory_basis_ids");
    if (memoryBasisIds.length > 0) {
      const basisDb = this.open({ readOnly: true });
      try {
        const placeholders = memoryBasisIds.map(() => "?").join(",");
        const rows = basisDb.prepare(
          `SELECT id FROM memories WHERE tenant_id = ? AND id IN (${placeholders})`
        ).all(tenantId, ...memoryBasisIds);
        if (new Set(rows.map((row) => row.id)).size !== memoryBasisIds.length) {
          throw new Error("invalid_memory_basis");
        }
      } finally {
        basisDb.close();
      }
    }
    return this.insertExecutionImpactEvent({
      tenantId,
      projectId: eligible?.project_id ?? null,
      taskId: eligible?.task_id ?? null,
      traceId: eligible?.trace_id ?? null,
      externalRunId,
      eventType: "assessed",
      memoryUsed: input.memory_used,
      avoidedLookup,
      memoryBasisIds,
      confidence,
      principal,
      agentName: eligible?.agent_name ?? null,
      model: eligible?.model ?? null,
      idempotencyKey,
      occurredAt: finiteNumber(input.occurred_at) ?? Date.now()
    });
  }

  async insertExecutionImpactEvent(input) {
    const hashable = { ...input };
    delete hashable.occurredAt;
    const payloadHash = hashContent(JSON.stringify(hashable));
    const db = this.open();
    try {
      const existing = db.prepare(
        `SELECT * FROM memory_impact_events
         WHERE tenant_id = ? AND reporter_principal = ? AND idempotency_key = ?`
      ).get(input.tenantId, input.principal, input.idempotencyKey);
      if (existing) {
        if (existing.payload_hash !== payloadHash) throw new Error("idempotency_conflict");
        return { event: existing, deduped: true };
      }
      const sameType = db.prepare(
        `SELECT id FROM memory_impact_events
         WHERE tenant_id = ? AND external_run_id = ? AND event_type = ?`
      ).get(input.tenantId, input.externalRunId, input.eventType);
      if (sameType) throw new Error("event_conflict");
      if (input.eventType !== "eligible") {
        const terminal = db.prepare(
          `SELECT id FROM memory_impact_events
           WHERE tenant_id = ? AND external_run_id = ? AND event_type IN ('assessed', 'failed')`
        ).get(input.tenantId, input.externalRunId);
        if (terminal) throw new Error("event_conflict");
      }
      const now = Date.now();
      const id = randomUUID();
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          `INSERT INTO memory_impact_events(
             id, tenant_id, project_id, task_id, trace_id, external_run_id, event_type,
             memory_used, avoided_lookup, memory_basis_ids_json, confidence, failure_category,
             reporter_principal, agent_name, model, idempotency_key, payload_hash,
             occurred_at, created_at
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(
          id, input.tenantId, input.projectId ?? null, input.taskId ?? null,
          input.traceId ?? null, input.externalRunId, input.eventType,
          input.memoryUsed == null ? null : input.memoryUsed ? 1 : 0,
          input.avoidedLookup ?? null, JSON.stringify(input.memoryBasisIds ?? []),
          input.confidence ?? null, input.failureCategory ?? null, input.principal,
          input.agentName ?? null, input.model ?? null, input.idempotencyKey,
          payloadHash, input.occurredAt, now
        );
        rebuildExecutionImpactDay(db, input.tenantId, input.projectId ?? null, utcDay(input.occurredAt));
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      const event = db.prepare("SELECT * FROM memory_impact_events WHERE id = ?").get(id);
      return { event, deduped: false };
    } finally {
      db.close();
    }
  }

  async getMemoryImpactExecution(tenantId, externalRunId) {
    await this.init();
    const db = this.open({ readOnly: true });
    try {
      const events = db.prepare(
        `SELECT * FROM memory_impact_events
         WHERE tenant_id = ? AND external_run_id = ? ORDER BY created_at, id`
      ).all(tenantId, externalRunId);
      if (events.length === 0) throw new Error("impact_run_not_found");
      return { external_run_id: externalRunId, events };
    } finally {
      db.close();
    }
  }

  async memoryImpactSummary(tenantId, filters = {}) {
    await this.init();
    const from = finiteNumber(filters.from) ?? Date.now() - 30 * 86_400_000;
    const to = finiteNumber(filters.to) ?? Date.now();
    if (from > to) throw new Error("invalid_range");
    const projectId = nullableString(filters.project_id, 256);
    const db = this.open({ readOnly: true });
    try {
      const events = projectId
        ? db.prepare(
          `SELECT event_type, external_run_id, memory_used, avoided_lookup
           FROM memory_impact_events
           WHERE tenant_id = ? AND occurred_at >= ? AND occurred_at <= ? AND project_id = ?`
        ).all(tenantId, from, to, projectId)
        : db.prepare(
          `SELECT event_type, external_run_id, memory_used, avoided_lookup
           FROM memory_impact_events
           WHERE tenant_id = ? AND occurred_at >= ? AND occurred_at <= ?`
        ).all(tenantId, from, to);
      return summarizeExecutionImpact(events);
    } finally {
      db.close();
    }
  }

  async getProfile(tenantId, principal = "user:local") {
    await this.init();
    const db = this.open({ readOnly: true });
    try {
      return db.prepare(
        `SELECT tenant_id, principal, display_name, full_name, email, email_verified,
                avatar_url, status, provision_source, full_name_source, created_at, updated_at
         FROM user_profiles WHERE tenant_id = ? AND principal = ?`
      ).get(tenantId, principal) ?? null;
    } finally {
      db.close();
    }
  }

  async updateProfile(tenantId, principal, input) {
    await this.init();
    const current = await this.getProfile(tenantId, principal);
    const displayName = nullableString(input.display_name, 120) ?? current?.display_name;
    if (!displayName) throw new Error("display_name_required");
    const fullName = input.full_name === undefined ? current?.full_name ?? null : nullableString(input.full_name, 200);
    const email = input.email === undefined ? current?.email ?? null : nullableString(input.email, 254)?.toLowerCase() ?? null;
    const avatarUrl = input.avatar_url === undefined ? current?.avatar_url ?? null : nullableString(input.avatar_url, 2048);
    const now = Date.now();
    const db = this.open();
    try {
      db.prepare(
        `INSERT INTO user_profiles(tenant_id, principal, display_name, full_name, email,
          email_verified, avatar_url, status, provision_source, full_name_source, created_at, updated_at)
         VALUES(?,?,?,?,?,0,?,'active','legacy','legacy',?,?)
         ON CONFLICT(tenant_id, principal) DO UPDATE SET
           display_name=excluded.display_name, full_name=excluded.full_name, email=excluded.email,
           avatar_url=excluded.avatar_url, updated_at=excluded.updated_at`
      ).run(tenantId, principal, displayName, fullName, email, avatarUrl, current?.created_at ?? now, now);
    } finally {
      db.close();
    }
    return this.getProfile(tenantId, principal);
  }

  async getOrganization(tenantId) {
    await this.init();
    const db = this.open({ readOnly: true });
    try {
      const row = db.prepare("SELECT * FROM organizations WHERE tenant_id = ?").get(tenantId);
      return row ? {
        ...row,
        allowed_email_domains: JSON.parse(row.allowed_email_domains_json),
        email_self_registration_enabled: Boolean(row.email_self_registration_enabled)
      } : {
        tenant_id: tenantId,
        slug: tenantId.toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "default",
        display_name: tenantId,
        allowed_email_domains: [],
        email_self_registration_enabled: false,
        configured: false
      };
    } finally {
      db.close();
    }
  }

  async updateOrganization(tenantId, input) {
    await this.init();
    const current = await this.getOrganization(tenantId);
    const slug = (nullableString(input.slug, 80) ?? current.slug).toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(slug)) throw new Error("invalid_organization_slug");
    const displayName = nullableString(input.display_name, 160) ?? current.display_name;
    const domains = input.allowed_email_domains === undefined
      ? current.allowed_email_domains
      : [...new Set(input.allowed_email_domains.map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
    const selfRegistration = input.email_self_registration_enabled === undefined
      ? current.email_self_registration_enabled
      : Boolean(input.email_self_registration_enabled);
    const now = Date.now();
    const db = this.open();
    try {
      db.prepare(
        `INSERT INTO organizations(tenant_id, slug, display_name, allowed_email_domains_json,
          email_self_registration_enabled, created_at, updated_at) VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(tenant_id) DO UPDATE SET slug=excluded.slug, display_name=excluded.display_name,
          allowed_email_domains_json=excluded.allowed_email_domains_json,
          email_self_registration_enabled=excluded.email_self_registration_enabled, updated_at=excluded.updated_at`
      ).run(tenantId, slug, displayName, JSON.stringify(domains), selfRegistration ? 1 : 0, current.created_at ?? now, now);
    } finally {
      db.close();
    }
    return this.getOrganization(tenantId);
  }

  async listUsers(tenantId) {
    await this.init();
    const db = this.open({ readOnly: true });
    try {
      return db.prepare(
        `SELECT tenant_id, principal, display_name, full_name, email, email_verified,
                avatar_url, status, provision_source, full_name_source, created_at, updated_at
         FROM user_profiles WHERE tenant_id = ? ORDER BY status, display_name, principal`
      ).all(tenantId);
    } finally {
      db.close();
    }
  }

  async createUser(tenantId, input, actorPrincipal = "user:local") {
    const email = nullableString(input.email, 254)?.toLowerCase() ?? null;
    const displayName = nullableString(input.display_name, 120);
    if (!displayName) throw new Error("display_name_required");
    const role = ["reader", "contributor", "tenant_admin", "auditor"].includes(input.role) ? input.role : "reader";
    const principal = nullableString(input.principal, 128) ?? `user:${randomUUID()}`;
    const now = Date.now();
    await this.init();
    const db = this.open();
    try {
      db.exec("BEGIN IMMEDIATE");
      db.prepare(
        `INSERT INTO user_profiles(tenant_id, principal, display_name, full_name, email,
          email_verified, avatar_url, status, provision_source, full_name_source, created_at, updated_at)
         VALUES(?,?,?,?,?,0,NULL,'invited','email','email',?,?)`
      ).run(tenantId, principal, displayName, nullableString(input.full_name, 200), email, now, now);
      db.prepare(
        `INSERT INTO principal_role_assignments(id, tenant_id, project_id, principal, role,
          source, source_ref, created_by_principal, created_at, updated_at)
         VALUES(?,?,NULL,?,?,'local',NULL,?,?,?)`
      ).run(randomUUID(), tenantId, principal, role, actorPrincipal, now, now);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    } finally {
      db.close();
    }
    return this.getProfile(tenantId, principal);
  }

  async updateUser(tenantId, principal, input) {
    await this.init();
    const allowedStatuses = new Set(["invited", "active", "suspended", "deprovisioned"]);
    const current = await this.getProfile(tenantId, principal);
    if (!current) throw new Error("user_not_found");
    const status = input.status === undefined ? current.status : String(input.status);
    if (!allowedStatuses.has(status)) throw new Error("invalid_user_status");
    const db = this.open();
    try {
      db.prepare(
        `UPDATE user_profiles SET display_name=?, full_name=?, status=?, updated_at=?
         WHERE tenant_id=? AND principal=?`
      ).run(
        nullableString(input.display_name, 120) ?? current.display_name,
        input.full_name === undefined ? current.full_name : nullableString(input.full_name, 200),
        status,
        Date.now(),
        tenantId,
        principal
      );
    } finally {
      db.close();
    }
    return this.getProfile(tenantId, principal);
  }

  async listGroups(tenantId) {
    await this.init();
    const db = this.open({ readOnly: true });
    try {
      return db.prepare("SELECT * FROM groups WHERE tenant_id=? AND deleted_at IS NULL ORDER BY name").all(tenantId);
    } finally {
      db.close();
    }
  }

  async createGroup(tenantId, input, actorPrincipal = "user:local") {
    await this.init();
    const name = nullableString(input.name, 120);
    if (!name) throw new Error("group_name_required");
    const slug = (nullableString(input.slug, 80) ?? name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")).replace(/^-+|-+$/g, "");
    if (!slug) throw new Error("invalid_group_slug");
    const now = Date.now();
    const id = randomUUID();
    const db = this.open();
    try {
      db.exec("BEGIN IMMEDIATE");
      db.prepare(
        `INSERT INTO groups(id, tenant_id, slug, name, description, source, external_id,
          created_by_principal, created_at, updated_at, deleted_at)
         VALUES(?,?,?,?,?,'local',NULL,?,?,?,NULL)`
      ).run(id, tenantId, slug, name, nullableString(input.description, 500), actorPrincipal, now, now);
      db.prepare(
        `INSERT INTO group_members(tenant_id, group_id, principal, role, source, created_at, updated_at)
         VALUES(?,?,?,'owner','local',?,?)`
      ).run(tenantId, id, actorPrincipal, now, now);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    } finally {
      db.close();
    }
    return { id, tenant_id: tenantId, slug, name, source: "local" };
  }

  async addGroupMember(tenantId, groupId, principal, role = "member") {
    await this.init();
    if (!["owner", "admin", "member"].includes(role)) throw new Error("invalid_group_role");
    const now = Date.now();
    const db = this.open();
    try {
      const group = db.prepare("SELECT source FROM groups WHERE tenant_id=? AND id=? AND deleted_at IS NULL").get(tenantId, groupId);
      if (!group) throw new Error("group_not_found");
      if (group.source === "scim") throw new Error("scim_managed");
      db.prepare(
        `INSERT INTO group_members(tenant_id, group_id, principal, role, source, created_at, updated_at)
         VALUES(?,?,?,?,'local',?,?) ON CONFLICT(tenant_id, group_id, principal)
         DO UPDATE SET role=excluded.role, updated_at=excluded.updated_at`
      ).run(tenantId, groupId, principal, role, now, now);
      return db.prepare("SELECT * FROM group_members WHERE tenant_id=? AND group_id=? ORDER BY role, principal").all(tenantId, groupId);
    } finally {
      db.close();
    }
  }

  async archiveGroup(tenantId, groupId) {
    await this.init();
    const db = this.open();
    try {
      const result = db.prepare(
        "UPDATE groups SET deleted_at=?, updated_at=? WHERE tenant_id=? AND id=? AND source='local' AND deleted_at IS NULL"
      ).run(Date.now(), Date.now(), tenantId, groupId);
      if (!result.changes) throw new Error("group_not_found_or_scim_managed");
      return { archived: true, group_id: groupId };
    } finally {
      db.close();
    }
  }

  async listBusinessCategories(tenantId, { includeInactive = false } = {}) {
    await this.init();
    const db = this.open({ readOnly: true });
    try {
      return db.prepare(
        `SELECT id, tenant_id, slug, label, description, is_active, created_at, updated_at
         FROM business_categories
         WHERE tenant_id = ? AND (? = 1 OR is_active = 1)
         ORDER BY label, slug`
      ).all(tenantId, includeInactive ? 1 : 0);
    } finally {
      db.close();
    }
  }

  async createBusinessCategory(tenantId, input) {
    await this.init();
    const slug = nullableString(input.slug, 64)?.toLowerCase();
    const label = nullableString(input.label, 160);
    if (!slug || !/^[a-z0-9][a-z0-9_-]*$/.test(slug)) throw new Error("invalid_business_category_slug");
    if (!label) throw new Error("business_category_label_required");
    const now = Date.now();
    const category = {
      id: nullableString(input.id, 128) || randomUUID(),
      tenant_id: tenantId,
      slug,
      label,
      description: nullableString(input.description, 1000),
      is_active: input.is_active === false ? 0 : 1,
      created_at: now,
      updated_at: now
    };
    const db = this.open();
    try {
      db.prepare(
        `INSERT INTO business_categories(
           id, tenant_id, slug, label, description, is_active, created_at, updated_at
         ) VALUES(?,?,?,?,?,?,?,?)`
      ).run(...Object.values(category));
      return category;
    } finally {
      db.close();
    }
  }

  async updateBusinessCategory(tenantId, categoryId, input) {
    await this.init();
    const db = this.open();
    try {
      const current = db.prepare(
        "SELECT * FROM business_categories WHERE tenant_id = ? AND id = ?"
      ).get(tenantId, categoryId);
      if (!current) throw new Error("business_category_not_found");
      const slug = input.slug === undefined ? current.slug : nullableString(input.slug, 64)?.toLowerCase();
      const label = input.label === undefined ? current.label : nullableString(input.label, 160);
      if (!slug || !/^[a-z0-9][a-z0-9_-]*$/.test(slug)) throw new Error("invalid_business_category_slug");
      if (!label) throw new Error("business_category_label_required");
      const updated = {
        ...current,
        slug,
        label,
        description: input.description === undefined ? current.description : nullableString(input.description, 1000),
        is_active: input.is_active === undefined ? current.is_active : input.is_active ? 1 : 0,
        updated_at: Date.now()
      };
      db.prepare(
        `UPDATE business_categories
         SET slug = ?, label = ?, description = ?, is_active = ?, updated_at = ?
         WHERE tenant_id = ? AND id = ?`
      ).run(updated.slug, updated.label, updated.description, updated.is_active, updated.updated_at, tenantId, categoryId);
      return updated;
    } finally {
      db.close();
    }
  }

  async listFailurePatterns(tenantId, { projectId = null } = {}) {
    await this.init();
    const db = this.open();
    try {
      return db.prepare(
        `SELECT id, tenant_id, project_id, business_category_id, work_type,
                pattern_key, label, action_fingerprint, failure_fingerprint,
                is_active, created_at, updated_at
         FROM memory_failure_patterns
         WHERE tenant_id = ? AND (? IS NULL OR project_id = ? OR project_id IS NULL)
         ORDER BY is_active DESC, updated_at DESC`
      ).all(tenantId, projectId, projectId);
    } finally {
      db.close();
    }
  }

  async createFailurePattern(tenantId, input) {
    await this.init();
    const db = this.open();
    try {
      const patternKey = normalizedIdentifier(input.pattern_key, "pattern_key", true);
      const label = nullableString(input.label, 240);
      if (!label) throw new Error("label_required");
      const businessCategoryId = nullableString(input.business_category_id, 128);
      const workType = input.work_type ?? null;
      validateBusinessClassification(db, tenantId, businessCategoryId, workType);
      const now = Date.now();
      const pattern = {
        id: nullableString(input.id, 128) || randomUUID(),
        tenant_id: tenantId,
        project_id: nullableString(input.project_id, 128),
        business_category_id: businessCategoryId,
        work_type: workType,
        pattern_key: patternKey,
        label,
        action_fingerprint: normalizedIdentifier(input.action_fingerprint, "action_fingerprint"),
        failure_fingerprint: normalizedIdentifier(input.failure_fingerprint, "failure_fingerprint"),
        is_active: input.is_active === false ? 0 : 1,
        created_at: now,
        updated_at: now
      };
      db.prepare(
        `INSERT INTO memory_failure_patterns(
           id, tenant_id, project_id, business_category_id, work_type,
           pattern_key, label, action_fingerprint, failure_fingerprint,
           is_active, created_at, updated_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(...Object.values(pattern));
      return pattern;
    } finally {
      db.close();
    }
  }

  async updateFailurePattern(tenantId, patternId, input) {
    await this.init();
    const db = this.open();
    try {
      const current = db.prepare(
        "SELECT * FROM memory_failure_patterns WHERE tenant_id = ? AND id = ?"
      ).get(tenantId, patternId);
      if (!current) throw new Error("memory_failure_pattern_not_found");
      const businessCategoryId = input.business_category_id === undefined
        ? current.business_category_id
        : nullableString(input.business_category_id, 128);
      const workType = input.work_type === undefined ? current.work_type : input.work_type;
      validateBusinessClassification(db, tenantId, businessCategoryId, workType);
      const label = input.label === undefined ? current.label : nullableString(input.label, 240);
      if (!label) throw new Error("invalid_label");
      const updated = {
        project_id: input.project_id === undefined ? current.project_id : nullableString(input.project_id, 128),
        business_category_id: businessCategoryId,
        work_type: workType,
        pattern_key: input.pattern_key === undefined ? current.pattern_key : normalizedIdentifier(input.pattern_key, "pattern_key", true),
        label,
        action_fingerprint: input.action_fingerprint === undefined ? current.action_fingerprint : normalizedIdentifier(input.action_fingerprint, "action_fingerprint"),
        failure_fingerprint: input.failure_fingerprint === undefined ? current.failure_fingerprint : normalizedIdentifier(input.failure_fingerprint, "failure_fingerprint"),
        is_active: input.is_active === undefined ? current.is_active : input.is_active ? 1 : 0,
        updated_at: Date.now()
      };
      db.prepare(
        `UPDATE memory_failure_patterns SET
           project_id = ?, business_category_id = ?, work_type = ?, pattern_key = ?,
           label = ?, action_fingerprint = ?, failure_fingerprint = ?, is_active = ?, updated_at = ?
         WHERE tenant_id = ? AND id = ?`
      ).run(...Object.values(updated), tenantId, patternId);
      return { ...current, ...updated };
    } finally {
      db.close();
    }
  }

  async updateUsageStates(tenantId, input) {
    await this.init();
    const usageEventId = nullableString(input.usage_event_id, 128);
    if (!usageEventId) throw new Error("usage_event_id_required");
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 128) {
      throw new Error("usage_state_items_required");
    }
    const updates = input.items.map((item) => {
      const usageItemId = nullableString(item.usage_item_id, 128);
      if (!usageItemId) throw new Error("usage_item_id_required");
      if (!["used", "not_used", "unknown"].includes(item.used_state)) throw new Error("invalid_used_state");
      return { usageItemId, usedState: item.used_state };
    });
    if (new Set(updates.map((item) => item.usageItemId)).size !== updates.length) throw new Error("duplicate_usage_item");
    const db = this.open();
    try {
      const event = db.prepare("SELECT created_at FROM memory_usage_events WHERE tenant_id = ? AND id = ?").get(tenantId, usageEventId);
      if (!event) throw new Error("memory_usage_event_not_found");
      db.exec("BEGIN IMMEDIATE");
      try {
        const update = db.prepare(
          "UPDATE memory_usage_items SET used_state = ?, used_state_source = 'reported' WHERE tenant_id = ? AND usage_event_id = ? AND id = ?"
        );
        for (const item of updates) {
          const result = update.run(item.usedState, tenantId, usageEventId, item.usageItemId);
          if (result.changes !== 1) throw new Error("memory_usage_item_not_found");
        }
        rebuildMemoryImpactDay(db, tenantId, utcDay(event.created_at));
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return { usage_event_id: usageEventId, updated_count: updates.length };
    } finally {
      db.close();
    }
  }

  async recordUsage(input) {
    await this.init();
    const tenantId = nullableString(input.tenant_id, 128) || "default";
    const usageId = nullableString(input.id, 128) || randomUUID();
    const accessPath = ["search", "profile", "context", "direct"].includes(input.access_path)
      ? input.access_path
      : "search";
    const requestSource = ["api", "mcp", "cap_runner", "local"].includes(input.request_source)
      ? input.request_source
      : "local";
    const uniqueItems = new Map();
    for (const item of Array.isArray(input.items) ? input.items : []) {
      const key = `${item.source_type}:${item.source_id}`;
      if (!uniqueItems.has(key)) uniqueItems.set(key, item);
    }
    const items = [...uniqueItems.values()];
    const createdAt = finiteNumber(input.created_at) || Date.now();
    const db = this.open();
    try {
      const existing = db.prepare(
        "SELECT id, verification_sampled FROM memory_usage_events WHERE tenant_id = ? AND id = ?"
      ).get(tenantId, usageId);
      if (existing) {
        const existingItems = db.prepare(
          "SELECT id FROM memory_usage_items WHERE tenant_id = ? AND usage_event_id = ? ORDER BY rank, id"
        ).all(tenantId, usageId);
        return {
          usage_id: usageId,
          usage_item_ids: existingItems.map((item) => item.id),
          verification_sampled: Boolean(existing.verification_sampled),
          created: false
        };
      }
      const externalRunId = nullableString(input.external_run_id, 256);
      let linkedProjectId = nullableString(input.project_id, 128);
      let linkedTaskId = nullableString(input.task_id, 128);
      let linkedTraceId = nullableString(input.trace_id, 128);
      if (externalRunId) {
        const execution = db.prepare(
          `SELECT external_run_id, project_id, task_id, trace_id FROM memory_impact_events
           WHERE tenant_id = ? AND external_run_id = ? AND event_type = 'eligible'`
        ).get(tenantId, externalRunId);
        if (!execution) throw new Error("memory_impact_execution_not_found");
        for (const [field, supplied, expected] of [
          ["project_id", linkedProjectId, execution.project_id],
          ["task_id", linkedTaskId, execution.task_id],
          ["trace_id", linkedTraceId, execution.trace_id]
        ]) {
          if (supplied !== null && supplied !== expected) {
            throw new Error(`memory_impact_context_mismatch:${field}`);
          }
        }
        linkedProjectId ??= execution.project_id;
        linkedTaskId ??= execution.task_id;
        linkedTraceId ??= execution.trace_id;
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          `INSERT INTO memory_usage_events(
             id, tenant_id, project_id, task_id, trace_id, external_run_id, capability,
             access_path, request_source, query_hash,
             requested_business_category_id, requested_work_type,
             retrieval_generation_id, ranking_profile_id,
             actor_principal, verification_sampled, created_at
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(
          usageId, tenantId, linkedProjectId,
          linkedTaskId, linkedTraceId,
          externalRunId, nullableString(input.capability, 128), accessPath, requestSource,
          normalizedQueryHash(input.query_hash), nullableString(input.requested_business_category_id, 128),
          WORK_TYPES.has(input.requested_work_type) ? input.requested_work_type : null,
          nullableString(input.retrieval_generation_id, 128),
          nullableString(input.ranking_profile_id, 128),
          "local",
          verificationSampled(tenantId, usageId) ? 1 : 0, createdAt
        );
        const insert = db.prepare(
          `INSERT INTO memory_usage_items(
             id, usage_event_id, tenant_id, source_type, source_id, source_version,
             rank, score, reference_type, used_state, used_state_source, injected_token_estimate,
             business_category_id_snapshot, work_type_snapshot, quality_category_snapshot,
             created_at
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        );
        const itemIds = [];
        for (let index = 0; index < items.length; index += 1) {
          const item = items[index];
          if (!["memory", "decision_memory"].includes(item.source_type)) {
            throw new Error("local_unknown_memory_source_type");
          }
          if (item.injected_token_estimate !== undefined && (!Number.isFinite(Number(item.injected_token_estimate)) || Number(item.injected_token_estimate) < 0)) {
            throw new Error("invalid_injected_token_estimate");
          }
          const memory = item.source_type === "memory"
            ? db.prepare(
              "SELECT id, current_version, business_category_id, work_type FROM memories WHERE tenant_id = ? AND id = ?"
            ).get(tenantId, item.source_id)
            : db.prepare(
              `SELECT source_id AS id, NULL AS current_version,
                      business_category_id, work_type
               FROM retrieval_units
               WHERE tenant_id = ? AND source_type = 'decision_memory' AND source_id = ?
               ORDER BY created_at DESC LIMIT 1`
            ).get(tenantId, item.source_id);
          if (!memory) throw new Error("memory_source_not_found");
          const itemId = nullableString(item.id, 128) || randomUUID();
          itemIds.push(itemId);
          insert.run(
            itemId, usageId, tenantId, item.source_type, memory.id,
            item.source_version ?? memory.current_version ?? null,
            Number.isInteger(item.rank) ? item.rank : index + 1,
            finiteNumber(item.score),
            ["returned", "injected", "direct"].includes(item.reference_type) ? item.reference_type : "returned",
            ["used", "not_used", "unknown"].includes(item.used_state) ? item.used_state : "unknown",
            "reported",
            Math.max(0, Number(item.injected_token_estimate ?? 0)),
            memory.business_category_id ?? null, memory.work_type ?? null,
            nullableString(item.quality_category_snapshot, 128), createdAt
          );
        }
        if (input.enqueue_sync === true || cloudTelemetryEnabled()) {
          const payload = {
            id: usageId,
            tenant_id: tenantId,
            project_id: linkedProjectId,
            task_id: linkedTaskId,
            trace_id: linkedTraceId,
            external_run_id: externalRunId,
            capability: nullableString(input.capability, 128),
            access_path: input.access_path,
            request_source: input.request_source,
            query_hash: normalizedQueryHash(input.query_hash),
            requested_business_category_id: nullableString(input.requested_business_category_id, 128),
            requested_work_type: input.requested_work_type ?? null,
            retrieval_generation_id: nullableString(input.retrieval_generation_id, 128),
            ranking_profile_id: nullableString(input.ranking_profile_id, 128),
            items: items.map((item, index) => ({
              id: itemIds[index],
              source_type: item.source_type,
              source_id: item.source_id,
              source_version: finiteNumber(item.source_version),
              rank: finiteNumber(item.rank),
              score: finiteNumber(item.score),
              reference_type: item.reference_type,
              used_state: item.used_state,
              injected_token_estimate: Math.max(0, Number(item.injected_token_estimate ?? 0)),
              quality_category_snapshot: nullableString(item.quality_category_snapshot, 128)
            })),
            created_at: createdAt
          };
          db.prepare(
            `INSERT INTO memory_telemetry_outbox(
               id, tenant_id, event_type, aggregate_id, payload_json,
               idempotency_key, created_at
             ) VALUES(?,?,?,?,?,?,?)`
          ).run(randomUUID(), tenantId, "memory_usage", usageId, JSON.stringify(payload), `usage:${tenantId}:${usageId}`, createdAt);
        }
        rebuildMemoryImpactDay(db, tenantId, utcDay(createdAt));
        db.exec("COMMIT");
        return {
          usage_id: usageId,
          usage_item_ids: itemIds,
          verification_sampled: verificationSampled(tenantId, usageId),
          created: true
        };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.close();
    }
  }

  async recordEffect(input) {
    await this.init();
    const tenantId = nullableString(input.tenant_id, 128) || "default";
    const usageId = nullableString(input.usage_event_id, 128);
    const idempotencyKey = nullableString(input.idempotency_key, 256);
    if (!usageId) throw new Error("usage_event_id_required");
    if (!idempotencyKey) throw new Error("idempotency_key_required");
    const avoided = [...new Set(Array.isArray(input.avoided_lookup_categories) ? input.avoided_lookup_categories : [])];
    if (input.avoided_lookup_categories !== undefined && !Array.isArray(input.avoided_lookup_categories)) throw new Error("invalid_avoided_lookup_categories");
    if (avoided.some((value) => !AVOIDED_LOOKUP_CATEGORIES.has(value))) throw new Error("invalid_avoided_lookup_category");
    if (avoided.includes("none") && avoided.length > 1) throw new Error("avoided_lookup_none_is_exclusive");
    if (input.evidence_level !== undefined && !["reported", "estimated", "verified", "unverifiable"].includes(input.evidence_level)) throw new Error("invalid_evidence_level");
    const evidenceLevel = input.evidence_level ?? "reported";
    if (input.effect_outcome === undefined) throw new Error("effect_outcome_required");
    if (!["positive", "neutral", "negative", "unknown"].includes(input.effect_outcome)) throw new Error("invalid_effect_outcome");
    const outcome = input.effect_outcome;
    if (input.failure_opportunity_state !== undefined && !["applicable", "not_applicable", "unknown"].includes(input.failure_opportunity_state)) throw new Error("invalid_failure_opportunity_state");
    const opportunity = input.failure_opportunity_state ?? "unknown";
    const actionChanged = Boolean(input.action_changed);
    const alternativeExecuted = Boolean(input.alternative_executed);
    const failureAvoided = Boolean(input.failure_avoided);
    if (failureAvoided && !(opportunity === "applicable" && actionChanged && alternativeExecuted)) {
      throw new Error("invalid_failure_avoidance_evidence");
    }
    const supersedesEffectId = nullableString(input.supersedes_effect_id, 128);
    const failurePatternId = nullableString(input.failure_pattern_id, 128);
    if (evidenceLevel === "verified" && !(input.verification_ref_type && input.verification_ref_id)) {
      throw new Error("verification_reference_required");
    }
    const createdAt = finiteNumber(input.created_at) || Date.now();
    const effectId = nullableString(input.id, 128) || randomUUID();
    const db = this.open();
    try {
      const existing = db.prepare(
        "SELECT id FROM memory_effect_events WHERE tenant_id = ? AND idempotency_key = ?"
      ).get(tenantId, idempotencyKey);
      if (existing) return { effect_id: existing.id, created: false };
      const usage = db.prepare(
        "SELECT id, created_at FROM memory_usage_events WHERE tenant_id = ? AND id = ?"
      ).get(tenantId, usageId);
      if (!usage) throw new Error("memory_usage_event_not_found");
      if (supersedesEffectId) {
        const superseded = db.prepare(
          `SELECT id FROM memory_effect_events
           WHERE tenant_id = ? AND usage_event_id = ? AND id = ?`
        ).get(tenantId, usageId, supersedesEffectId);
        if (!superseded) throw new Error("invalid_supersedes_effect_id");
      }
      const currentEffect = db.prepare(
        `SELECT e.id FROM memory_effect_events e
         WHERE e.tenant_id = ? AND e.usage_event_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM memory_effect_events child
             WHERE child.tenant_id = e.tenant_id AND child.supersedes_effect_id = e.id
           )
         ORDER BY e.created_at DESC, e.id DESC LIMIT 1`
      ).get(tenantId, usageId);
      if (currentEffect && supersedesEffectId !== currentEffect.id) throw new Error("effect_supersedes_latest_required");
      if (!currentEffect && supersedesEffectId) throw new Error("effect_supersedes_latest_required");
      if (failurePatternId) {
        const pattern = db.prepare(
          "SELECT id FROM memory_failure_patterns WHERE tenant_id = ? AND id = ? AND is_active = 1"
        ).get(tenantId, failurePatternId);
        if (!pattern) throw new Error("invalid_failure_pattern_id");
      }
      if (opportunity === "applicable" && !failurePatternId) throw new Error("failure_pattern_id_required");
      const failureSavedTokens = Number(input.failure_saved_tokens_estimate ?? 0);
      if (!Number.isFinite(failureSavedTokens) || failureSavedTokens < 0) {
        throw new Error("invalid_failure_saved_tokens_estimate");
      }
      if (failureSavedTokens !== 0 && !failureAvoided) {
        throw new Error("failure_saved_tokens_without_avoidance");
      }
      const usageItems = db.prepare(
        `SELECT id, source_type, source_id, business_category_id_snapshot, injected_token_estimate FROM memory_usage_items
         WHERE tenant_id = ? AND usage_event_id = ? ORDER BY rank, id`
      ).all(tenantId, usageId);
      if (usageItems.length === 0) throw new Error("memory_usage_items_required");
      const requestedAttributions = Array.isArray(input.attributions) ? input.attributions : [];
      const usageItemIds = new Set(usageItems.map((item) => item.id));
      const attributionById = new Map();
      for (const item of requestedAttributions) {
        if (!usageItemIds.has(item.usage_item_id)) throw new Error("invalid_usage_item_attribution");
        const weight = Number(item.attribution_weight);
        if (!Number.isFinite(weight) || weight <= 0 || weight > 1) throw new Error("invalid_attribution_weight");
        if (attributionById.has(item.usage_item_id)) throw new Error("duplicate_usage_item_attribution");
        attributionById.set(item.usage_item_id, weight);
      }
      const attributions = usageItems.map((item) => ({
        usage_item_id: item.id,
        attribution_weight: attributionById.size > 0
          ? attributionById.get(item.id) ?? 0
          : 1 / usageItems.length
      })).filter((item) => item.attribution_weight > 0);
      const weightTotal = attributions.reduce((sum, item) => sum + item.attribution_weight, 0);
      if (Math.abs(weightTotal - 1) > 0.000001) throw new Error("attribution_weights_must_sum_to_one");
      const estimationCandidates = input.token_estimation_candidates && typeof input.token_estimation_candidates === "object" && !Array.isArray(input.token_estimation_candidates)
        ? { ...input.token_estimation_candidates }
        : {};
      if (input.gross_saved_tokens_estimate === undefined) {
        let sourceCharacters = 0;
        for (const item of usageItems) {
          const row = item.source_type === "memory"
            ? db.prepare("SELECT length(content) AS chars FROM memories WHERE tenant_id = ? AND id = ?").get(tenantId, item.source_id)
            : db.prepare("SELECT length(text) AS chars FROM retrieval_units WHERE tenant_id = ? AND source_type = 'decision_memory' AND source_id = ? ORDER BY created_at DESC LIMIT 1").get(tenantId, item.source_id);
          sourceCharacters += Math.max(0, Number(row?.chars ?? 0));
        }
        const sourceTokens = Math.max(1, Math.ceil(sourceCharacters / 4));
        estimationCandidates.text_size_heuristic_tokens ??= sourceTokens;
        if (avoided.some((category) => category === "source_search" || category === "past_context")) {
          estimationCandidates.avoided_source_tokens ??= sourceTokens;
        }
        if (failurePatternId && estimationCandidates.failure_pattern_median_tokens === undefined) {
          const rows = db.prepare(
            `SELECT e.gross_saved_tokens_estimate AS value FROM memory_effect_events e
             WHERE e.tenant_id = ? AND e.failure_pattern_id = ? AND e.evidence_level IN ('estimated', 'verified')
               AND NOT EXISTS (
                 SELECT 1 FROM memory_effect_events child
                 WHERE child.tenant_id = e.tenant_id AND child.supersedes_effect_id = e.id
               )
             ORDER BY e.created_at DESC LIMIT 101`
          ).all(tenantId, failurePatternId);
          const value = median(rows.map((row) => Number(row.value)).filter(Number.isFinite));
          if (value !== undefined) estimationCandidates.failure_pattern_median_tokens = value;
        }
        const categoryIds = [...new Set(usageItems.map((item) => item.business_category_id_snapshot).filter(Boolean))];
        if (categoryIds.length && estimationCandidates.category_median_tokens === undefined) {
          const rows = db.prepare(
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
          ).all(tenantId, ...categoryIds);
          const value = median(rows.map((row) => Number(row.value)).filter(Number.isFinite));
          if (value !== undefined) estimationCandidates.category_median_tokens = value;
        }
      }
      const tokenEstimate = resolveLocalTokenEstimate({ ...input, token_estimation_candidates: estimationCandidates });
      const gross = tokenEstimate.gross;
      const attributedIds = new Set(attributions.map((item) => item.usage_item_id));
      if (input.injected_tokens !== undefined && (!Number.isFinite(Number(input.injected_tokens)) || Number(input.injected_tokens) < 0)) {
        throw new Error("invalid_injected_tokens");
      }
      const injected = input.injected_tokens === undefined
        ? usageItems
          .filter((item) => attributedIds.has(item.id))
          .reduce((sum, item) => sum + Math.max(0, Math.round(Number(item.injected_token_estimate ?? 0))), 0)
        : Math.max(0, Math.round(Number(input.injected_tokens)));
      const net = gross - injected;
      if (input.net_saved_tokens_estimate !== undefined && Math.round(Number(input.net_saved_tokens_estimate)) !== net) {
        throw new Error("net_saved_tokens_mismatch");
      }
      if (![gross, injected, net].every(Number.isFinite)) throw new Error("invalid_token_estimate");
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          `INSERT INTO memory_effect_events(
             id, tenant_id, usage_event_id, idempotency_key, evidence_level,
             supersedes_effect_id, effect_outcome, avoided_lookup_categories_json,
             gross_saved_tokens_estimate, injected_tokens, net_saved_tokens_estimate,
             estimate_lower_bound, estimate_upper_bound, estimation_method,
             estimator_version, estimate_confidence, failure_pattern_id,
             failure_opportunity_state, action_changed, alternative_executed,
             failure_avoided, failure_saved_tokens_estimate,
             verification_ref_type, verification_ref_id,
             estimated_tool_calls_saved, estimated_seconds_saved, created_at
           ) VALUES(${Array.from({ length: 27 }, () => "?").join(",")})`
        ).run(
          effectId, tenantId, usageId, idempotencyKey, evidenceLevel,
          supersedesEffectId, outcome, JSON.stringify(avoided),
          gross, injected, net, finiteNumber(input.estimate_lower_bound),
          finiteNumber(input.estimate_upper_bound), tokenEstimate.method,
          nullableString(input.estimator_version, 64), finiteNumber(input.estimate_confidence),
          failurePatternId, opportunity,
          actionChanged ? 1 : 0, alternativeExecuted ? 1 : 0,
          failureAvoided ? 1 : 0, failureSavedTokens,
          nullableString(input.verification_ref_type, 64), nullableString(input.verification_ref_id, 256),
          finiteNumber(input.estimated_tool_calls_saved), finiteNumber(input.estimated_seconds_saved), createdAt
        );
        const insertAttribution = db.prepare(
          `INSERT INTO memory_effect_attributions(
             id, tenant_id, effect_event_id, usage_item_id, attribution_weight,
             gross_saved_tokens, net_saved_tokens, failure_saved_tokens, created_at
           ) VALUES(?,?,?,?,?,?,?,?,?)`
        );
        let allocatedGross = 0;
        let allocatedNet = 0;
        let allocatedFailure = 0;
        for (let index = 0; index < attributions.length; index += 1) {
          const attribution = attributions[index];
          const last = index === attributions.length - 1;
          const attributedGross = last ? gross - allocatedGross : Math.round(gross * attribution.attribution_weight);
          const attributedNet = last ? net - allocatedNet : Math.round(net * attribution.attribution_weight);
          const failureSaved = failureSavedTokens;
          const attributedFailure = last ? failureSaved - allocatedFailure : Math.round(failureSaved * attribution.attribution_weight);
          allocatedGross += attributedGross;
          allocatedNet += attributedNet;
          allocatedFailure += attributedFailure;
          insertAttribution.run(
            randomUUID(), tenantId, effectId, attribution.usage_item_id,
            attribution.attribution_weight, attributedGross, attributedNet,
            attributedFailure, createdAt
          );
        }
        if (supersedesEffectId) {
          db.prepare(
            `UPDATE memory_usage_items SET used_state = 'unknown', used_state_source = 'reported'
             WHERE tenant_id = ? AND usage_event_id = ? AND used_state_source = 'effect'
               AND id IN (
                 SELECT usage_item_id FROM memory_effect_attributions
                 WHERE tenant_id = ? AND effect_event_id = ?
               )`
          ).run(tenantId, usageId, tenantId, supersedesEffectId);
        }
        if (input.used_state === "used" || outcome !== "unknown") {
          db.prepare(
            `UPDATE memory_usage_items SET used_state = 'used', used_state_source = 'effect'
             WHERE tenant_id = ? AND usage_event_id = ?
               AND (used_state_source = 'effect' OR used_state = 'unknown')
               AND id IN (${attributions.map(() => "?").join(",")})`
          ).run(tenantId, usageId, ...attributions.map((item) => item.usage_item_id));
        }
        if (input.enqueue_sync === true || cloudTelemetryEnabled()) {
          const payload = {
            id: effectId,
            tenant_id: tenantId,
            usage_event_id: usageId,
            idempotency_key: idempotencyKey,
            evidence_level: evidenceLevel,
            supersedes_effect_id: supersedesEffectId,
            effect_outcome: outcome,
            avoided_lookup_categories: avoided,
            gross_saved_tokens_estimate: gross,
            injected_tokens: injected,
            net_saved_tokens_estimate: net,
            estimate_lower_bound: finiteNumber(input.estimate_lower_bound),
            estimate_upper_bound: finiteNumber(input.estimate_upper_bound),
            estimation_method: nullableString(input.estimation_method, 128),
            estimator_version: nullableString(input.estimator_version, 64),
            estimate_confidence: finiteNumber(input.estimate_confidence),
            failure_pattern_id: failurePatternId,
            failure_opportunity_state: opportunity,
            action_changed: actionChanged,
            alternative_executed: alternativeExecuted,
            failure_avoided: failureAvoided,
            failure_saved_tokens_estimate: failureSavedTokens,
            verification_ref_type: nullableString(input.verification_ref_type, 64),
            verification_ref_id: nullableString(input.verification_ref_id, 256),
            estimated_tool_calls_saved: finiteNumber(input.estimated_tool_calls_saved),
            estimated_seconds_saved: finiteNumber(input.estimated_seconds_saved),
            attributions,
            created_at: createdAt
          };
          db.prepare(
            `INSERT INTO memory_telemetry_outbox(
               id, tenant_id, event_type, aggregate_id, payload_json,
               idempotency_key, created_at
             ) VALUES(?,?,?,?,?,?,?)`
          ).run(randomUUID(), tenantId, "memory_effect", effectId, JSON.stringify(payload), `effect:${tenantId}:${idempotencyKey}`, createdAt);
        }
        rebuildMemoryImpactDay(db, tenantId, utcDay(usage.created_at));
        db.exec("COMMIT");
        return { effect_id: effectId, created: true, net_saved_tokens_estimate: net };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.close();
    }
  }

  async rebuildMemoryImpact(tenantId, day = utcDay(Date.now())) {
    await this.init();
    const db = this.open();
    try {
      return rebuildMemoryImpactDay(db, tenantId, day);
    } finally {
      db.close();
    }
  }

  async syncTelemetryOutbox({ apiBase, apiKey, limit = 100, fetchImpl = fetch } = {}) {
    await this.init();
    if (!cloudTelemetryEnabled()) throw new Error("cloud_memory_sync_not_enabled");
    const base = nullableString(apiBase, 2048)?.replace(/\/+$/u, "");
    const key = nullableString(apiKey, 2048);
    if (!base) throw new Error("ORGBRAIN_API_URL_required");
    if (!key) throw new Error("ORGBRAIN_API_KEY_required");
    const db = this.open();
    const now = Date.now();
    const rows = db.prepare(
      `SELECT id, event_type, payload_json, attempt_count
       FROM memory_telemetry_outbox
       WHERE sent_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY CASE event_type WHEN 'memory_usage' THEN 0 ELSE 1 END, created_at, id
       LIMIT ?`
    ).all(now, Math.max(1, Math.min(1000, Number(limit) || 100)));
    let sent = 0;
    let failed = 0;
    try {
      for (const row of rows) {
        const endpoint = row.event_type === "memory_usage"
          ? "/v1/memory-usages"
          : row.event_type === "memory_effect"
            ? "/v1/memory-effects"
            : null;
        if (!endpoint) {
          failed += 1;
          db.prepare(
            `UPDATE memory_telemetry_outbox
             SET attempt_count = attempt_count + 1, next_attempt_at = ?, last_error_code = ?
             WHERE id = ?`
          ).run(now + 86_400_000, "unsupported_event_type", row.id);
          continue;
        }
        let errorCode = "network_error";
        try {
          const response = await fetchImpl(`${base}${endpoint}`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": key },
            body: row.payload_json
          });
          if (!response.ok) {
            errorCode = `http_${response.status}`;
            throw new Error(errorCode);
          }
          db.prepare(
            `UPDATE memory_telemetry_outbox
             SET sent_at = ?, next_attempt_at = NULL, last_error_code = NULL
             WHERE id = ?`
          ).run(Date.now(), row.id);
          sent += 1;
        } catch (error) {
          failed += 1;
          const attempts = Number(row.attempt_count ?? 0) + 1;
          const delay = Math.min(86_400_000, 1000 * (2 ** Math.min(attempts, 16)));
          db.prepare(
            `UPDATE memory_telemetry_outbox
             SET attempt_count = ?, next_attempt_at = ?, last_error_code = ?
             WHERE id = ?`
          ).run(
            attempts,
            Date.now() + delay,
            errorCode === "network_error" && error instanceof Error && error.message.startsWith("http_")
              ? error.message.slice(0, 64)
              : errorCode,
            row.id
          );
        }
      }
      const pending = db.prepare(
        "SELECT COUNT(*) AS count FROM memory_telemetry_outbox WHERE sent_at IS NULL"
      ).get().count;
      return { attempted: rows.length, sent, failed, pending: Number(pending) };
    } finally {
      db.close();
    }
  }

  async memoryImpactReport(tenantId, filters = {}) {
    await this.init();
    const db = this.open({ readOnly: true });
    try {
      const groupColumns = {
        memory: "ui.source_type || ':' || ui.source_id",
        business_category: "COALESCE(ui.business_category_id_snapshot, 'unclassified')",
        work_type: "COALESCE(ui.work_type_snapshot, 'unclassified')",
        project: "COALESCE(ue.project_id, 'unclassified')",
        day: "date(ui.created_at / 1000, 'unixepoch')"
      };
      const groupBy = Object.hasOwn(groupColumns, filters.group_by) ? filters.group_by : "memory";
      const clauses = ["ui.tenant_id = ?"];
      const bindings = [tenantId];
      if (groupBy === "business_category") clauses.push("ui.business_category_id_snapshot IS NOT NULL");
      for (const [field, value] of [
        ["ui.source_type", filters.source_type],
        ["ui.source_id", filters.source_id],
        ["ui.business_category_id_snapshot", filters.business_category_id],
        ["ui.work_type_snapshot", filters.work_type],
        ["date(ui.created_at / 1000, 'unixepoch')", filters.day]
      ]) {
        if (value) {
          clauses.push(`${field} = ?`);
          bindings.push(value);
        }
      }
      const rows = db.prepare(
        `WITH latest_effect AS (
           SELECT e.* FROM memory_effect_events e
           WHERE e.tenant_id = ? AND NOT EXISTS (
             SELECT 1 FROM memory_effect_events child
             WHERE child.tenant_id = e.tenant_id
               AND child.supersedes_effect_id = e.id
           )
         )
         SELECT ${groupColumns[groupBy]} AS group_key,
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
         WHERE ${clauses.join(" AND ")}
         GROUP BY group_key, CASE WHEN ea.usage_item_id IS NOT NULL THEN le.evidence_level ELSE 'unreported' END
         ORDER BY group_key, evidence_level`
      ).all(tenantId, ...bindings);
      const rankRows = db.prepare(
        `SELECT rank, COUNT(DISTINCT usage_event_id) AS reference_count,
                COUNT(DISTINCT CASE WHEN used_state = 'used' THEN usage_event_id END) AS used_count,
                COUNT(DISTINCT CASE WHEN used_state = 'not_used' THEN usage_event_id END) AS not_used_count,
                COUNT(DISTINCT CASE WHEN used_state = 'unknown' THEN usage_event_id END) AS usage_unknown_count
         FROM memory_usage_items
         WHERE tenant_id = ? AND rank IS NOT NULL
         GROUP BY rank ORDER BY rank`
      ).all(tenantId);
      return {
        tenant_id: tenantId,
        group_by: groupBy,
        unclassified_excluded: groupBy === "business_category",
        groups: rows.map((row) => ({
          ...row,
          utilization_rate: row.reference_count ? row.used_count / row.reference_count : null,
          positive_effect_rate: row.used_count ? row.positive_count / row.used_count : null,
          negative_effect_rate: row.used_count ? row.negative_count / row.used_count : null,
          failure_avoidance_rate: row.failure_opportunity_count
            ? row.failure_avoided_count / row.failure_opportunity_count
            : null,
          verification_coverage: row.verification_sampled_count
            ? row.verified_count / row.verification_sampled_count
            : null,
          net_saved_tokens_per_1000_injected: row.injected_tokens
            ? row.net_saved_tokens * 1000 / row.injected_tokens
            : null
        })),
        rank_utilization: rankRows.map((row) => ({
          ...row,
          utilization_rate: row.reference_count ? row.used_count / row.reference_count : null
        }))
      };
    } finally {
      db.close();
    }
  }

  async capture(input) {
    await this.init();
    const db = this.open();
    let result;
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        result = this.captureIntoDatabase(db, input);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.close();
      await enforcePrivatePermissions(this.dbPath);
    }
    return this.attachDenseProjection(result, nullableString(input.tenant_id, 128) || "default");
  }

  async captureBatch(inputs) {
    if (!Array.isArray(inputs)) throw new Error("captureBatch inputs must be an array");
    if (inputs.length === 0) return [];
    await this.init();
    const db = this.open();
    let results;
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        results = inputs.map((input) =>
          this.captureIntoDatabase(db, input, {
            updateFeatureStats: false,
            writeProjections: false
          })
        );
        rebuildFts(db);
        rebuildLocalEmbeddings(db);
        rebuildRetrievalUnits(db);
        rebuildRetrievalUnitsV4(db);
        rebuildStableRetrievalUnits(db);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.close();
      await enforcePrivatePermissions(this.dbPath);
    }
    if (!this.denseEmbeddingProvider) return results;
    const byTenant = new Map();
    results.forEach((result, index) => {
      const tenantId = nullableString(inputs[index].tenant_id, 128) || "default";
      byTenant.set(tenantId, [...(byTenant.get(tenantId) ?? []), { result, index }]);
    });
    const augmented = [...results];
    for (const [tenantId, entries] of byTenant) {
      try {
        const projection = await this.rebuildDenseEmbeddings({
          tenant_id: tenantId,
          memory_ids: [...new Set(entries.map((entry) => entry.result.memory_id))]
        });
        for (const entry of entries) {
          augmented[entry.index] = {
            ...entry.result,
            embedding_projection: { state: "indexed", ...projection }
          };
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        for (const entry of entries) {
          augmented[entry.index] = {
            ...entry.result,
            embedding_projection: { state: "failed", reason }
          };
        }
      }
    }
    return augmented;
  }

  async attachDenseProjection(result, tenantId) {
    if (!this.denseEmbeddingProvider) return result;
    try {
      const projection = await this.rebuildDenseEmbeddings({
        tenant_id: tenantId,
        memory_ids: [result.memory_id]
      });
      return { ...result, embedding_projection: { state: "indexed", ...projection } };
    } catch (error) {
      return {
        ...result,
        embedding_projection: {
          state: "failed",
          reason: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  captureIntoDatabase(
    db,
    input,
    { updateFeatureStats = true, writeProjections = true } = {}
  ) {
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
    validateBusinessClassification(db, tenantId, record.business_category_id, record.work_type);
    if (record.canonical_key && record.lifecycle_state !== "suppressed") {
      const canonicalExisting = db.prepare(
        `SELECT id, current_version
         FROM memories
         WHERE tenant_id = ? AND canonical_key = ?
           AND id != ?
           AND (lifecycle_state IS NULL OR lifecycle_state != 'suppressed')
         ORDER BY confidence_score DESC, utility_score DESC, updated_at DESC, id
         LIMIT 1`
      ).get(tenantId, record.canonical_key, record.id);
      if (canonicalExisting) {
        return {
          memory_id: canonicalExisting.id,
          version: Number(canonicalExisting.current_version ?? 1),
          operation: "capture",
          created: false,
          deduplicated: true
        };
      }
    }
    this.writeRecord(db, record, Boolean(existing), updateFeatureStats, writeProjections);
    this.writeVersion(db, record, "capture");
    return {
      memory_id: record.id,
      version: record.current_version,
      operation: "capture",
      created: !existing
    };
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
      const affectedUsageIds = db.prepare(
        "SELECT DISTINCT usage_event_id FROM memory_usage_items WHERE tenant_id = ? AND source_type = 'memory' AND source_id = ?"
      ).all(tenantId, memoryId).map((row) => row.usage_event_id);
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          "INSERT INTO memory_deletions(id, tenant_id, memory_id, actor_type, actor_id, deleted_at) VALUES(?,?,?,?,?,?)"
        ).run(randomUUID(), tenantId, memoryId, actor.actor_type ?? null, actor.actor_id ?? null, Date.now());
        wipeMemoryProjections(db, tenantId, memoryId);
        db.prepare(
          `DELETE FROM memory_effect_attributions WHERE tenant_id = ? AND usage_item_id IN (
             SELECT id FROM memory_usage_items
             WHERE tenant_id = ? AND source_type = 'memory' AND source_id = ?
           )`
        ).run(tenantId, tenantId, memoryId);
        db.prepare(
          "DELETE FROM memory_usage_items WHERE tenant_id = ? AND source_type = 'memory' AND source_id = ?"
        ).run(tenantId, memoryId);
        for (const usageId of affectedUsageIds) {
          db.prepare(
            "DELETE FROM memory_telemetry_outbox WHERE tenant_id = ? AND (aggregate_id = ? OR json_extract(payload_json, '$.usage_event_id') = ?)"
          ).run(tenantId, usageId, usageId);
          const remaining = db.prepare(
            "SELECT 1 FROM memory_usage_items WHERE tenant_id = ? AND usage_event_id = ? LIMIT 1"
          ).get(tenantId, usageId);
          if (!remaining) {
            db.prepare(
              `DELETE FROM memory_effect_attributions WHERE tenant_id = ? AND effect_event_id IN (
                 SELECT id FROM memory_effect_events WHERE tenant_id = ? AND usage_event_id = ?
               )`
            ).run(tenantId, tenantId, usageId);
            db.prepare("DELETE FROM memory_effect_events WHERE tenant_id = ? AND usage_event_id = ?").run(tenantId, usageId);
            db.prepare("DELETE FROM memory_usage_events WHERE tenant_id = ? AND id = ?").run(tenantId, usageId);
          }
        }
        db.prepare(
          "DELETE FROM memory_effect_daily_metrics WHERE tenant_id = ? AND source_type = 'memory' AND source_id = ?"
        ).run(tenantId, memoryId);
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
      validateBusinessClassification(db, tenantId, record.business_category_id, record.work_type);
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
    const businessCategoryId = nullableString(input.business_category_id, 128) ?? fallback?.business_category_id ?? null;
    const workType = WORK_TYPES.has(input.work_type)
      ? input.work_type
      : fallback?.work_type ?? null;
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
    const captureOrigin = ["observed", "synthetic", "repair", "legacy"].includes(input.capture_origin)
      ? input.capture_origin
      : fallback?.capture_origin ?? "legacy";
    const verificationState = ["verified", "partial", "unverified", "rejected"].includes(input.verification_state)
      ? input.verification_state
      : fallback?.verification_state ?? "unverified";
    const learning = input.learning && typeof input.learning === "object" && !Array.isArray(input.learning)
      ? input.learning
      : fallback?.learning ?? null;
    const qualityDimensions = input.quality_dimensions && typeof input.quality_dimensions === "object" && !Array.isArray(input.quality_dimensions)
      ? Object.fromEntries(Object.entries(input.quality_dimensions).map(([key, raw]) => {
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error("invalid_quality_dimension");
        return [key.slice(0, 80), value];
      }))
      : fallback?.quality_dimensions ?? null;
    const verifiedAt = finiteNumber(input.verified_at) ?? fallback?.verified_at ?? null;
    if (verificationState === "verified" && (captureOrigin !== "observed" || !learning || !verifiedAt)) {
      throw new Error("invalid_verified_learning");
    }
    const now = Date.now();
    return {
      id: nullableString(input.id, 128) || fallback?.id || randomUUID(),
      tenant_id: tenantId,
      project_id: projectId,
      business_category_id: businessCategoryId,
      work_type: workType,
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
      reuse_rule: nullableString(input.reuse_rule, 1000),
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
      , capture_origin: captureOrigin
      , verification_state: verificationState
      , verified_at: verificationState === "verified" ? verifiedAt : null
      , learning
      , quality_dimensions: qualityDimensions
    };
  }

  writeRecord(db, record, exists, updateFeatureStats = true, writeProjections = true) {
    const columns = [
      "id", "tenant_id", "project_id", "business_category_id", "work_type", "kind", "lifecycle_state", "scope_type", "scope_key", "content",
      "summary", "tags_json", "entities_json", "source", "source_refs_json", "external_key", "actor_type",
      "actor_id", "created_at", "updated_at", "valid_from", "valid_until", "confidence_score", "utility_score",
      "content_hash", "current_version", "rationale", "evidence_json", "conflicts_json", "permissions_json",
      "canonical_key", "root_memory_id", "last_accessed_at", "suppressed_at", "consolidated_at", "promoted_at",
      "expires_at", "revised_at", "reuse_rule", "capture_origin", "verification_state", "verified_at",
      "learning_json", "quality_dimensions_json"
    ];
    const values = {
      ...record,
      tags_json: json(record.tags),
      entities_json: json(record.entities),
      source_refs_json: json(record.source_references),
      evidence_json: json(record.evidence),
      conflicts_json: json(record.conflicts),
      permissions_json: json(record.permissions)
      , learning_json: record.learning ? json(record.learning) : null
      , quality_dimensions_json: record.quality_dimensions ? json(record.quality_dimensions) : null
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
    if (writeProjections) {
      db.prepare("DELETE FROM memories_fts WHERE tenant_id = ? AND memory_id = ?").run(record.tenant_id, record.id);
      if (record.lifecycle_state !== "suppressed") {
        db.prepare(
          "INSERT INTO memories_fts(memory_id, tenant_id, content, summary, tags, entities) VALUES(?,?,?,?,?,?)"
        ).run(record.id, record.tenant_id, record.content, record.summary || "", json(record.tags), json(record.entities));
      }
      writeLocalEmbedding(db, record, updateFeatureStats);
      writeRetrievalUnits(db, record, updateFeatureStats);
      writeRetrievalUnitsV4(db, record);
      writeStableRetrievalUnits(db, record, true, true, updateFeatureStats);
    }
  }

  writeVersion(db, record, operation) {
    db.prepare(
      `INSERT INTO memory_versions(
        id, memory_id, tenant_id, version, operation, content, summary, tags_json,
        kind, lifecycle_state, scope_type, scope_key, actor_type, actor_id,
        confidence_score, utility_score, canonical_key, snapshot_json, content_hash, created_at
        , business_category_id, work_type, reuse_rule
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      randomUUID(),
      record.id,
      record.tenant_id,
      record.current_version,
      operation,
      record.content,
      record.summary,
      json(record.tags),
      record.kind,
      record.lifecycle_state,
      record.scope_type,
      record.scope_key,
      record.actor_type,
      record.actor_id,
      record.confidence_score,
      record.utility_score,
      record.canonical_key,
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
      record.updated_at,
      record.business_category_id,
      record.work_type,
      record.reuse_rule
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
    business_category_id: businessCategoryId = null,
    work_type: workType = null,
    query,
    limit = 10,
    minimum_total_score: minimumTotalScoreInput = null,
    include_suppressed = false,
    principal_id: principalId = null,
    search_mode: searchMode = "memories",
    at = Date.now()
  }) {
    await this.init();
    if (searchMode === "hybrid_v3" || searchMode === "hybrid_v4") {
      const denseQueryVector = searchMode === "hybrid_v4" && this.denseEmbeddingProvider
        ? await this.denseEmbeddingProvider.embedQuery(query)
        : null;
      const db = this.open({ readOnly: true });
      try {
        const safeLimit = Math.max(1, Math.min(100, Number(limit) || 10));
        const parsedMinimumTotalScore =
          minimumTotalScoreInput === null || minimumTotalScoreInput === undefined
            ? null
            : Number(minimumTotalScoreInput);
        if (
          parsedMinimumTotalScore !== null &&
          (!Number.isFinite(parsedMinimumTotalScore) || parsedMinimumTotalScore < 0)
        ) {
          throw new Error("minimum_total_score must be a non-negative finite number");
        }
        const results = (searchMode === "hybrid_v4" ? searchRetrievalUnitsV4 : searchRetrievalUnitsV3)(db, {
          tenantId,
          projectId,
          query,
          limit: safeLimit,
          minimumTotalScore: parsedMinimumTotalScore,
          includeSuppressed: include_suppressed,
          principalId,
          at,
          denseQueryVector,
          denseProvider: this.denseEmbeddingProvider?.provider ?? null
        });
        return results.filter(({ memory }) =>
          (businessCategoryId === null || memory.business_category_id === businessCategoryId) &&
          (workType === null || memory.work_type === workType)
        );
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
          (businessCategoryId === null || row.business_category_id === businessCategoryId) &&
          (workType === null || row.work_type === workType) &&
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

  async retrieveContext({
    tenant_id: tenantId,
    project_id: projectId = null,
    business_category_id: businessCategoryId = null,
    work_type: workType = null,
    query,
    limit = 50,
    top_k = 5,
    token_budget = 8_000,
    principal_id: principalId = null,
    at = Date.now(),
    search_mode: searchMode = "hybrid_v4"
  }) {
    const safeTokenBudget = Math.max(512, Math.min(16_000, Number(token_budget) || 8_000));
    const safeTopK = Math.max(1, Math.min(50, Number(top_k) || 5));
    const results = await this.search({
      tenant_id: tenantId,
      project_id: projectId,
      business_category_id: businessCategoryId,
      work_type: workType,
      query,
      limit: Math.max(safeTopK, Math.min(50, Number(limit) || 50)),
      principal_id: principalId,
      at,
      search_mode: searchMode
    });
    await this.init();
    const db = this.open({ readOnly: true });
    try {
      const selected = results.slice(0, safeTopK);
      const charBudget = safeTokenBudget * 4;
      let usedChars = 0;
      const evidence = [];
      const timeline = [];
      const state = [];
      const conflicts = [];
      for (const result of selected) {
        if (usedChars >= charBudget) break;
        const memory = result.memory;
        const units = db.prepare(
          `SELECT unit_type, speaker, text, event_at, source_ref_json,
                  source_span_start, source_span_end, metadata_json, extraction_state
           FROM retrieval_units
           WHERE generation_id = 'gen_structured_context'
             AND tenant_id = ? AND source_type = 'memory' AND source_id = ?
           ORDER BY
             CASE unit_type
               WHEN 'atomic' THEN 0 WHEN 'profile' THEN 1 WHEN 'timeline' THEN 2
               WHEN 'ledger' THEN 3 ELSE 4
             END,
             event_at DESC
           LIMIT 8`
        ).all(tenantId, memory.id);
        const versions = db.prepare(
          `SELECT version, operation, snapshot_json, created_at
           FROM memory_versions
           WHERE tenant_id = ? AND memory_id = ?
           ORDER BY version DESC
           LIMIT 4`
        ).all(tenantId, memory.id);
        const chosen = units.find((unit) =>
          retrievalSubjectQueryTokens(query).some((token) =>
            retrievalQueryTokens(unit.text).includes(token)
          )
        ) ?? units[0];
        const remaining = Math.max(0, charBudget - usedChars);
        const span = String(chosen?.text ?? memory.content).slice(0, Math.min(remaining, 4_000));
        usedChars += span.length;
        let sourceReference = memory.source_references[0] ?? null;
        try {
          sourceReference = chosen?.source_ref_json ? JSON.parse(chosen.source_ref_json) : sourceReference;
        } catch {
          // Preserve the canonical source reference when a projection row is malformed.
        }
        evidence.push({
          memory_id: memory.id,
          text: span,
          speaker: chosen?.speaker ?? null,
          session_date: chosen?.event_at ?? sourceReference?.captured_at ?? memory.created_at,
          source_reference: sourceReference,
          source_span: {
            start: chosen?.source_span_start ?? null,
            end: chosen?.source_span_end ?? null
          },
          score: result.score.total,
          extraction_state: chosen?.extraction_state ?? "degraded"
        });
        for (const unit of units) {
          let metadata = {};
          try {
            metadata = JSON.parse(unit.metadata_json || "{}");
          } catch {
            metadata = {};
          }
          if (unit.unit_type === "timeline") {
            timeline.push({
              memory_id: memory.id,
              event_at: unit.event_at,
              delta_from_question_ms: unit.event_at === null ? null : at - unit.event_at,
              ...metadata
            });
          }
          if (unit.unit_type === "profile" || unit.unit_type === "ledger") {
            state.push({
              memory_id: memory.id,
              current: unit.text,
              previous_values: versions.slice(1).flatMap((version) => {
                try {
                  const snapshot = JSON.parse(version.snapshot_json);
                  return snapshot?.content ? [snapshot.content] : [];
                } catch {
                  return [];
                }
              }),
              ...metadata
            });
          }
        }
        for (const conflict of memory.conflicts) {
          conflicts.push({ memory_id: memory.id, conflict });
        }
      }
      const multiEvidence = /\b(?:and|compare|both|between|combined|together|how many)\b|(?:かつ|両方|比較|合計|複数)/iu.test(query);
      const missingEvidence = [];
      if (evidence.length === 0) missingEvidence.push("no_relevant_evidence");
      if (multiEvidence && new Set(evidence.map((item) => item.source_reference?.ref ?? item.memory_id)).size < 2) {
        missingEvidence.push("insufficient_independent_sessions");
      }
      if (evidence.some((item) => item.extraction_state === "degraded")) {
        missingEvidence.push("structured_extractor_degraded");
      }
      const template =
        missingEvidence.length > 0 || conflicts.length > 0
          ? "abstention"
          : timeline.length > 0
            ? "timeline"
            : state.length > 0
              ? "profile"
              : multiEvidence
                ? "multi_session"
                : "evidence";
      const usage = await this.recordUsage({
        tenant_id: tenantId,
        project_id: projectId,
        capability: "memory_retrieve_context",
        access_path: "context",
        request_source: "local",
        requested_business_category_id: businessCategoryId,
        requested_work_type: workType,
        items: evidence.map((item, index) => ({
          source_type: "memory",
          source_id: item.memory_id,
          rank: index + 1,
          score: item.score,
          reference_type: "injected",
          used_state: "unknown",
          injected_token_estimate: Math.ceil(item.text.length / 4)
        }))
      });
      return {
        results,
        meta: {
          usage_id: usage.usage_id,
          verification_sampled: usage.verification_sampled,
          retrieval: {
            generation_id: "gen_structured_context",
            unit_schema_version: "2",
            extractor_name: "local-structured-projector",
            extractor_version: "4",
            ranking_profile_id: "rank_default",
            embedding_profile_id: "local-sparse-v1"
          }
        },
        evidence_bundle: {
          query_at: at,
          token_budget: safeTokenBudget,
          estimated_tokens: Math.ceil(usedChars / 4),
          answer_template: template,
          evidence,
          current_state: state,
          timeline,
          conflicts,
          missing_evidence: missingEvidence,
          abstention_recommended: missingEvidence.length > 0 || conflicts.length > 0,
          degraded_reasons: [
            "onnx_embedding_not_configured",
            "cross_encoder_not_configured",
            ...(evidence.some((item) => item.extraction_state === "degraded")
              ? ["gemini_structured_extractor_not_configured"]
              : [])
          ]
        }
      };
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

  async rebuildIndex({ includeLegacyV3 = true } = {}) {
    // Isolated v4 scale runs may skip rebuilding the additive legacy projection;
    // normal maintenance keeps v3 and v4 available for rollback.
    await this.init();
    const db = this.open();
    try {
      db.exec("BEGIN IMMEDIATE");
      dropRebuildIndexes(db);
      rebuildFts(db);
      rebuildLocalEmbeddings(db);
      if (includeLegacyV3) rebuildRetrievalUnits(db);
      rebuildRetrievalUnitsV4(db);
      addIndexes(db);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    } finally {
      db.close();
      await enforcePrivatePermissions(this.dbPath);
    }
  }

  async rebuildDenseEmbeddings({
    tenant_id: tenantId = "default",
    project_id: projectId = null,
    memory_ids: memoryIds = null
  } = {}) {
    await this.init();
    if (!this.denseEmbeddingProvider) throw new Error("local_dense_embedding_not_configured");
    const uniqueMemoryIds = Array.isArray(memoryIds)
      ? [...new Set(memoryIds.map((value) => nullableString(value, 128)).filter(Boolean))]
      : null;
    if (Array.isArray(memoryIds) && uniqueMemoryIds.length === 0) {
      return {
        provider: this.denseEmbeddingProvider.provider,
        dimensions: this.denseEmbeddingProvider.dimensions,
        indexed: 0,
        tenant_id: tenantId,
        project_id: projectId
      };
    }
    const db = this.open();
    try {
      const rows = db.prepare(
        `SELECT u.id, u.text
         FROM memory_retrieval_units_v4 u
         JOIN memories m ON m.id = u.memory_id AND m.tenant_id = u.tenant_id
         WHERE u.tenant_id = ?
           AND (? IS NULL OR u.project_id = ?)
           AND m.lifecycle_state != 'suppressed'
           ${uniqueMemoryIds ? `AND u.memory_id IN (${uniqueMemoryIds.map(() => "?").join(",")})` : ""}
         ORDER BY u.id`
      ).all(tenantId, projectId, projectId, ...(uniqueMemoryIds ?? []));
      let indexed = 0;
      for (let offset = 0; offset < rows.length; offset += 16) {
        const batch = rows.slice(offset, offset + 16);
        const vectors = await this.denseEmbeddingProvider.embedDocuments(batch.map((row) => row.text));
        db.exec("BEGIN IMMEDIATE");
        try {
          const upsert = db.prepare(
            `INSERT INTO memory_retrieval_unit_embeddings_v4(
               unit_id, tenant_id, provider, feature_count, vector_format, vector_blob, updated_at
             ) VALUES(?,?,?,?,?,?,?)
             ON CONFLICT(tenant_id, unit_id) DO UPDATE SET
               provider = excluded.provider,
               feature_count = excluded.feature_count,
               vector_format = excluded.vector_format,
               vector_blob = excluded.vector_blob,
               updated_at = excluded.updated_at`
          );
          for (let index = 0; index < batch.length; index += 1) {
            upsert.run(
              batch[index].id,
              tenantId,
              this.denseEmbeddingProvider.provider,
              vectors[index].length,
              "dense-f32",
              encodeFloat32Vector(vectors[index]),
              Date.now()
            );
            indexed += 1;
          }
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }
      return {
        provider: this.denseEmbeddingProvider.provider,
        dimensions: this.denseEmbeddingProvider.dimensions,
        indexed,
        tenant_id: tenantId,
        project_id: projectId
      };
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
      const retrievalUnitsV4 = db.prepare(
        `SELECT id, text, content_hash
         FROM memory_retrieval_units_v4
         ORDER BY id`
      ).all();
      for (const unit of retrievalUnitsV4) {
        if (hashContent(unit.text) !== unit.content_hash) {
          errors.push(`retrieval v4 unit content hash mismatch: ${unit.id}`);
        }
      }
      const retrievalUnitV4Count = retrievalUnitsV4.length;
      const retrievalUnitV4FtsCount = Number(
        db.prepare("SELECT COUNT(*) AS count FROM memory_retrieval_units_v4_fts").get().count
      );
      const retrievalUnitV4EmbeddingCount = Number(
        db.prepare("SELECT COUNT(*) AS count FROM memory_retrieval_unit_embeddings_v4").get().count
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
      if (retrievalUnitV4FtsCount !== retrievalUnitV4Count) {
        errors.push(
          `retrieval v4 unit FTS count ${retrievalUnitV4FtsCount} != retrieval v4 unit count ${retrievalUnitV4Count}`
        );
      }
      if (retrievalUnitV4EmbeddingCount !== retrievalUnitV4Count) {
        errors.push(
          `retrieval v4 unit embedding count ${retrievalUnitV4EmbeddingCount} != retrieval v4 unit count ${retrievalUnitV4Count}`
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
        retrieval_unit_v4_count: retrievalUnitV4Count,
        retrieval_unit_v4_fts_count: retrievalUnitV4FtsCount,
        retrieval_unit_v4_embedding_count: retrievalUnitV4EmbeddingCount,
        retrieval_unit_v4_digest: stableDigest(retrievalUnitsV4),
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
          wipeMemoryProjections(restored, deletion.tenant_id, deletion.memory_id);
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
          reuse_rule: columns.has("reuse_rule") ? row.reuse_rule : null,
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
