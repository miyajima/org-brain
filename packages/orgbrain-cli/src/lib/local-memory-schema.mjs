import { LOCAL_EMBEDDING_PROVIDER } from "./local-embedding.mjs";

import { randomUUID } from "node:crypto";
import { MEMORY_USE_SCHEMA_SQL } from "../../../shared/src/memory-use-history-runtime.mjs";
import { ATTEMPT_SCHEMA_SQL } from "../../../shared/src/attempt-history-runtime.mjs";
import { LOCAL_USE_SCHEMA } from "./local-memory-use.mjs";
import { MEMORY_USE_ASSESSMENT_SCHEMA_SQL } from "./memory-use-assessment.mjs";
import { AGENT_ACTIVITY_SCHEMA_SQL } from "./agent-activity.mjs";
import { hashContent, memoryFromRow } from "./local-memory-record.mjs";
import { rebuildFts, rebuildLocalEmbeddings, rebuildRetrievalUnits, rebuildRetrievalUnitsV4, rebuildStableRetrievalUnits } from "./local-memory-projections.mjs";

export const MEMORY_SCHEMA_VERSION = 33;

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
  owner_principal: "TEXT",
  created_by_principal: "TEXT",
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
  revised_at: "INTEGER",
  deleted_at: "INTEGER",
  deleted_by_principal: "TEXT",
  delete_reason: "TEXT",
  capture_origin: "TEXT NOT NULL DEFAULT 'legacy'",
  capture_route: "TEXT NOT NULL DEFAULT 'legacy'",
  capture_batch_id: "TEXT",
  verification_state: "TEXT NOT NULL DEFAULT 'unverified'",
  verified_at: "INTEGER",
  learning_json: "TEXT",
  quality_dimensions_json: "TEXT"
};

/** @param {import("node:sqlite").DatabaseSync} db */
export function hasTable(db, table) {
  return Boolean(
    db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(table)
  );
}

const LEGACY_FTS_TRIGGER_NAMES = [
  "memories_fts_ai",
  "memories_fts_ad",
  "memories_fts_au"
];

/** @param {import("node:sqlite").DatabaseSync} db */
export function hasLegacyFtsTriggers(db) {
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

/** @param {import("node:sqlite").DatabaseSync} db */
export function tableColumns(db, table) {
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
      owner_principal TEXT,
      created_by_principal TEXT,
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
      revised_at INTEGER,
      deleted_at INTEGER,
      deleted_by_principal TEXT,
      delete_reason TEXT,
      capture_origin TEXT NOT NULL DEFAULT 'legacy',
      capture_route TEXT NOT NULL DEFAULT 'legacy',
      capture_batch_id TEXT,
      verification_state TEXT NOT NULL DEFAULT 'unverified',
      verified_at INTEGER,
      learning_json TEXT,
      quality_dimensions_json TEXT
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
    CREATE TABLE IF NOT EXISTS memory_quality_feedback (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      memory_version INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('stale', 'wrong')),
      reason TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      reporter_principal TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'reported' CHECK(status IN ('reported', 'confirmed', 'rejected')),
      reviewer_principal TEXT,
      reviewed_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_quality_feedback_memory
      ON memory_quality_feedback(tenant_id, memory_id, memory_version, status);
    CREATE TABLE IF NOT EXISTS memory_integrity_relations (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      from_memory_id TEXT NOT NULL,
      from_version INTEGER NOT NULL,
      to_memory_id TEXT NOT NULL,
      to_version INTEGER NOT NULL,
      relation TEXT NOT NULL CHECK(relation IN ('contradicts', 'fixes')),
      evidence_json TEXT NOT NULL,
      proposer_principal TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed', 'confirmed', 'rejected', 'resolved')),
      reviewer_principal TEXT,
      reviewed_at INTEGER,
      resolved_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_integrity_relations_pair
      ON memory_integrity_relations(tenant_id, from_memory_id, to_memory_id, status);
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
    CREATE TABLE IF NOT EXISTS local_mcp_confirmations (
      token_hash TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS local_mcp_confirmation_receipts (
      token_hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, request_hash TEXT NOT NULL,
      result_json TEXT NOT NULL, original_json TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_local_mcp_confirmations_expiry
      ON local_mcp_confirmations(expires_at);
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
    CREATE TABLE IF NOT EXISTS domain_pack_installations_local (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      pack_id TEXT NOT NULL,
      version TEXT NOT NULL,
      manifest_digest TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'installed' CHECK(state IN ('installed', 'revoked')),
      installed_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(tenant_id, pack_id)
    );
    CREATE TABLE IF NOT EXISTS managed_object_types_local (
      id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      pack_id TEXT,
      type_key TEXT NOT NULL,
      label TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      attribute_schema_json TEXT NOT NULL DEFAULT '{}',
      allowed_relations_json TEXT NOT NULL DEFAULT '[]',
      origin_type TEXT NOT NULL CHECK(origin_type IN ('pack', 'custom')),
      version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(tenant_id, id),
      UNIQUE(tenant_id, type_key)
    );
    CREATE TABLE IF NOT EXISTS managed_objects_local (
      id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      project_id TEXT,
      pack_id TEXT,
      object_type_key TEXT NOT NULL,
      name TEXT NOT NULL,
      attributes_json TEXT NOT NULL DEFAULT '{}',
      visibility TEXT NOT NULL DEFAULT 'tenant' CHECK(visibility IN ('tenant', 'project', 'restricted')),
      owner_principal TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(tenant_id, id)
    );
    CREATE TABLE IF NOT EXISTS managed_object_relations_local (
      id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      source_object_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      target_object_id TEXT NOT NULL,
      attributes_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      PRIMARY KEY(tenant_id, id),
      UNIQUE(tenant_id, source_object_id, relation_type, target_object_id)
    );
    CREATE TABLE IF NOT EXISTS managed_object_external_refs_local (
      id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      managed_object_id TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      url TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      PRIMARY KEY(tenant_id, id),
      UNIQUE(tenant_id, adapter_id, external_id)
    );
    CREATE TABLE IF NOT EXISTS metric_definitions_local (
      id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      pack_id TEXT,
      metric_key TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      origin_type TEXT NOT NULL CHECK(origin_type IN ('pack', 'custom')),
      version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(tenant_id, id),
      UNIQUE(tenant_id, metric_key)
    );
    CREATE TABLE IF NOT EXISTS metric_definition_versions_local (
      id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      metric_definition_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      definition_json TEXT NOT NULL,
      definition_digest TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(tenant_id, id),
      UNIQUE(tenant_id, metric_definition_id, version)
    );
    CREATE TABLE IF NOT EXISTS metric_bindings_local (
      id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      metric_definition_id TEXT NOT NULL,
      scope_type TEXT NOT NULL CHECK(scope_type IN ('tenant', 'project', 'managed_object')),
      scope_id TEXT,
      dimensions_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      PRIMARY KEY(tenant_id, id),
      UNIQUE(tenant_id, metric_definition_id, scope_type, scope_id, dimensions_json)
    );
    CREATE TABLE IF NOT EXISTS metric_targets_local (
      id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      metric_definition_id TEXT NOT NULL,
      binding_id TEXT,
      target_value REAL,
      target_min REAL,
      target_max REAL,
      direction TEXT NOT NULL CHECK(direction IN ('increase', 'decrease', 'range', 'maintain')),
      effective_from INTEGER NOT NULL,
      effective_to INTEGER,
      reason TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(tenant_id, id)
    );
    CREATE TABLE IF NOT EXISTS metric_snapshots_local (
      id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      project_id TEXT,
      metric_key TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      scope_id TEXT,
      value REAL,
      state TEXT NOT NULL CHECK(state IN ('measured', 'unknown', 'stale')),
      dimensions_json TEXT NOT NULL DEFAULT '{}',
      observed_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      evidence_ref TEXT,
      source_binding_id TEXT,
      idempotency_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(tenant_id, id),
      UNIQUE(tenant_id, idempotency_key),
      CHECK((state = 'measured' AND value IS NOT NULL) OR (state != 'measured' AND value IS NULL))
    );
    CREATE TABLE IF NOT EXISTS decision_domain_links_local (
      id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      decision_source_type TEXT NOT NULL,
      decision_source_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      object_type TEXT NOT NULL,
      object_id TEXT NOT NULL,
      confirmation_state TEXT NOT NULL,
      evidence_resource_id TEXT,
      evidence_resource_version_id TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(tenant_id, id)
    );
    CREATE TABLE IF NOT EXISTS decision_memories_local (
      id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      project_id TEXT,
      domain TEXT NOT NULL DEFAULT 'general',
      title TEXT NOT NULL,
      decision TEXT NOT NULL,
      rationale TEXT NOT NULL,
      rejected_alternatives_json TEXT NOT NULL DEFAULT '[]',
      constraints_json TEXT NOT NULL DEFAULT '[]',
      known_pitfalls_json TEXT NOT NULL DEFAULT '[]',
      source_refs_json TEXT NOT NULL DEFAULT '[]',
      owner_refs_json TEXT NOT NULL DEFAULT '[]',
      reviewer_refs_json TEXT NOT NULL DEFAULT '[]',
      valid_from INTEGER,
      valid_until INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      superseded_by TEXT,
      confidence REAL NOT NULL DEFAULT 0.5,
      visibility TEXT NOT NULL DEFAULT 'tenant',
      allowed_principals_json TEXT NOT NULL DEFAULT '[]',
      confirmation_state TEXT NOT NULL DEFAULT 'inferred_unconfirmed',
      confirmation_note TEXT,
      confirmed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(tenant_id, id)
    );
    CREATE TABLE IF NOT EXISTS decision_memory_versions_local (
      id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      decision_memory_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      actor_refs_json TEXT NOT NULL DEFAULT '[]',
      reviewer_refs_json TEXT NOT NULL DEFAULT '[]',
      note TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(tenant_id, id)
    );
    CREATE TABLE IF NOT EXISTS knowledge_resources_local (
      id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      project_id TEXT,
      resource_kind TEXT NOT NULL,
      canonical_uri TEXT NOT NULL,
      title TEXT NOT NULL,
      source_system TEXT NOT NULL,
      media_type TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'tenant',
      permissions_json TEXT NOT NULL DEFAULT '[]',
      lifecycle_state TEXT NOT NULL DEFAULT 'active',
      created_by_principal TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(tenant_id, id),
      UNIQUE(tenant_id, canonical_uri)
    );
    CREATE TABLE IF NOT EXISTS domain_recall_units (
      id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      project_id TEXT,
      pack_id TEXT NOT NULL,
      object_type_key TEXT NOT NULL,
      object_id TEXT,
      intent_aliases_json TEXT NOT NULL DEFAULT '[]',
      scope_json TEXT NOT NULL DEFAULT '{}',
      relation TEXT NOT NULL CHECK(relation IN ('primary', 'supporting', 'conflict')),
      decision_json TEXT NOT NULL,
      metrics_json TEXT NOT NULL DEFAULT '[]',
      evidence_json TEXT NOT NULL DEFAULT '[]',
      workflow TEXT,
      follow_up TEXT,
      evidence_verified INTEGER NOT NULL DEFAULT 0,
      metric_fresh INTEGER NOT NULL DEFAULT 0,
      visibility TEXT NOT NULL DEFAULT 'tenant' CHECK(visibility IN ('tenant', 'project', 'restricted')),
      owner_principal TEXT,
      allowed_principals_json TEXT NOT NULL DEFAULT '[]',
      valid_until INTEGER,
      search_text TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(tenant_id, id)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS domain_recall_units_fts USING fts5(
      unit_id UNINDEXED,
      tenant_id UNINDEXED,
      search_text,
      tokenize = 'unicode61'
    );
    CREATE TABLE IF NOT EXISTS domain_recall_events (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      project_id TEXT,
      actor_principal TEXT,
      session_id TEXT,
      query_hash TEXT NOT NULL,
      client_name TEXT,
      candidate_count INTEGER NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('shadow', 'on')),
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS domain_recall_event_candidates (
      recall_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      recall_unit_id TEXT NOT NULL,
      pack_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('primary', 'supporting', 'conflict')),
      rank INTEGER NOT NULL,
      score REAL NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(recall_id, recall_unit_id)
    );
    CREATE INDEX IF NOT EXISTS idx_domain_recall_event_candidates_pack
      ON domain_recall_event_candidates(tenant_id, pack_id, created_at DESC, recall_id);
    CREATE TABLE IF NOT EXISTS domain_recall_feedback (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      recall_id TEXT NOT NULL,
      candidate_id TEXT,
      actor_principal TEXT NOT NULL,
      session_id TEXT,
      feedback TEXT NOT NULL,
      effect TEXT NOT NULL,
      note TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS domain_recall_preferences (
      tenant_id TEXT NOT NULL,
      principal TEXT NOT NULL,
      candidate_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('suppressed', 'active')),
      reason TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(tenant_id, principal, candidate_id)
    );
    CREATE TABLE IF NOT EXISTS domain_recall_review_proposals (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      recall_id TEXT NOT NULL,
      candidate_id TEXT,
      proposal_type TEXT NOT NULL CHECK(proposal_type IN ('outdated', 'incorrect_relation')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'confirmed', 'rejected')),
      proposed_by_principal TEXT NOT NULL,
      note TEXT,
      created_at INTEGER NOT NULL,
      reviewed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS domain_authority_state (
      tenant_id TEXT PRIMARY KEY,
      authority TEXT NOT NULL CHECK(authority IN ('local', 'cloud')),
      cloud_archive_digest TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS domain_recall_cache (
      tenant_id TEXT NOT NULL,
      bundle_id TEXT NOT NULL,
      query_key TEXT,
      bundle_json TEXT NOT NULL,
      bundle_digest TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      synced_at INTEGER NOT NULL,
      PRIMARY KEY(tenant_id, bundle_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_recall_cache_query
      ON domain_recall_cache(tenant_id, query_key) WHERE query_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS domain_proposal_outbox (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      proposal_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_digest TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'sent', 'failed')),
      created_at INTEGER NOT NULL,
      sent_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS portable_import_records (
      archive_id TEXT NOT NULL,
      section TEXT NOT NULL,
      record_id TEXT NOT NULL,
      digest TEXT NOT NULL,
      applied_at INTEGER NOT NULL,
      PRIMARY KEY(archive_id, section, record_id)
    );
    CREATE INDEX IF NOT EXISTS idx_domain_recall_units_scope
      ON domain_recall_units(tenant_id, project_id, object_type_key, object_id);
    CREATE INDEX IF NOT EXISTS idx_domain_recall_feedback_recall
      ON domain_recall_feedback(tenant_id, recall_id, created_at DESC);
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
         capture_route = COALESCE(NULLIF(capture_route, ''), 'legacy'),
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
  if (!columns.has("usage_purpose")) {
    db.exec("ALTER TABLE memory_usage_events ADD COLUMN usage_purpose TEXT NOT NULL DEFAULT 'unclassified'");
  }
  if (!columns.has("external_run_id")) {
    db.exec("ALTER TABLE memory_usage_events ADD COLUMN external_run_id TEXT");
  }
  if (!columns.has("actor_principal")) {
    db.exec("ALTER TABLE memory_usage_events ADD COLUMN actor_principal TEXT");
  }
}

function upgradeDomainRecallTables(db) {
  const cacheColumns = tableColumns(db, "domain_recall_cache");
  if (cacheColumns.size && !cacheColumns.has("query_key")) {
    db.exec("ALTER TABLE domain_recall_cache ADD COLUMN query_key TEXT");
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_recall_cache_query ON domain_recall_cache(tenant_id, query_key) WHERE query_key IS NOT NULL");
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

/** @param {import("node:sqlite").DatabaseSync} db */
export function addIndexes(db) {
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
    CREATE INDEX IF NOT EXISTS idx_memories_quality_route
      ON memories(tenant_id, project_id, capture_route, verification_state, lifecycle_state, created_at DESC);
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

/** @param {import("node:sqlite").DatabaseSync} db */
export function dropRebuildIndexes(db) {
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

/** @param {import("node:sqlite").DatabaseSync} db */
export function migrateSchema(db) {
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
    upgradeDomainRecallTables(db);
    upgradeIdentityTables(db);
    upgradeMemoryUsageEvents(db);
    upgradeMemoryUsageItems(db);
    if (!tableColumns(db, "memory_usage_items").has("source_tenant_id")) {
      db.exec("ALTER TABLE memory_usage_items ADD COLUMN source_tenant_id TEXT");
    }
    if (!hasTable(db, "all_memories_fts")) {
      if (db.prepare("SELECT 1 FROM memories WHERE tenant_id = 'all' LIMIT 1").get() ||
          db.prepare("SELECT 1 FROM decision_memories_local WHERE tenant_id = 'all' LIMIT 1").get()) {
        throw new Error("all_tenant_already_exists: review existing records before enabling sharing");
      }
      db.exec(`
        CREATE VIRTUAL TABLE all_memories_fts USING fts5(summary, content);
        CREATE TRIGGER all_memories_insert AFTER INSERT ON memories WHEN NEW.tenant_id = 'all' BEGIN
          INSERT INTO all_memories_fts(rowid, summary, content) VALUES (NEW.rowid, NEW.summary, NEW.content);
        END;
        CREATE TRIGGER all_memories_update AFTER UPDATE OF summary, content, tenant_id ON memories
          WHEN NEW.tenant_id = 'all' OR OLD.tenant_id = 'all' BEGIN
          DELETE FROM all_memories_fts WHERE rowid = OLD.rowid AND OLD.tenant_id = 'all';
          INSERT INTO all_memories_fts(rowid, summary, content)
            SELECT NEW.rowid, NEW.summary, NEW.content WHERE NEW.tenant_id = 'all';
        END;
        CREATE TRIGGER all_memories_delete AFTER DELETE ON memories WHEN OLD.tenant_id = 'all' BEGIN
          DELETE FROM all_memories_fts WHERE rowid = OLD.rowid;
        END;
      `);
    }
    db.exec(MEMORY_USE_SCHEMA_SQL);
    db.exec(ATTEMPT_SCHEMA_SQL);
    db.exec(LOCAL_USE_SCHEMA);
    db.exec(MEMORY_USE_ASSESSMENT_SCHEMA_SQL);
    db.exec(AGENT_ACTIVITY_SCHEMA_SQL);
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

