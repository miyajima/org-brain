-- Additive hybrid_v4 projection. Canonical memories and the v3 projection are
-- intentionally retained for one-release rollback.
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

CREATE VIRTUAL TABLE IF NOT EXISTS memory_retrieval_units_v4_fts USING fts5(
  unit_id UNINDEXED,
  memory_id UNINDEXED,
  tenant_id UNINDEXED,
  text,
  tokenize = 'unicode61'
);

CREATE INDEX IF NOT EXISTS idx_retrieval_units_v4_parent
ON memory_retrieval_units_v4(tenant_id, memory_id, unit_type);

CREATE INDEX IF NOT EXISTS idx_retrieval_units_v4_segment
ON memory_retrieval_units_v4(tenant_id, project_id, segment_id);

CREATE INDEX IF NOT EXISTS idx_retrieval_units_v4_timeline
ON memory_retrieval_units_v4(tenant_id, unit_type, event_at);

CREATE TABLE IF NOT EXISTS retrieval_projection_v4_backfills (
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL DEFAULT '',
  cursor TEXT NOT NULL DEFAULT '',
  processed_memories INTEGER NOT NULL DEFAULT 0,
  projected_units INTEGER NOT NULL DEFAULT 0,
  record_digest TEXT,
  unit_digest TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(tenant_id, project_id)
);

CREATE TABLE IF NOT EXISTS retrieval_v4_shadow_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  query_hash TEXT NOT NULL,
  v3_result_count INTEGER NOT NULL,
  v4_result_count INTEGER NOT NULL,
  overlap_count INTEGER NOT NULL,
  empty INTEGER NOT NULL,
  degraded INTEGER NOT NULL,
  evidence_tokens INTEGER,
  projection_lag_ms INTEGER,
  latency_ms REAL NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_retrieval_v4_shadow_tenant_created
ON retrieval_v4_shadow_events(tenant_id, created_at DESC);
