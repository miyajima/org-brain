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
  status TEXT NOT NULL CHECK(status IN ('building', 'shadow', 'active', 'fallback', 'retired', 'failed')),
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  retired_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_retrieval_generations_status
ON retrieval_generations(status, created_at DESC);

CREATE TABLE IF NOT EXISTS retrieval_generation_assignments (
  tenant_id TEXT NOT NULL,
  project_scope_key TEXT NOT NULL DEFAULT '*',
  active_generation_id TEXT NOT NULL,
  shadow_generation_id TEXT,
  shadow_sample_rate REAL NOT NULL DEFAULT 0 CHECK(shadow_sample_rate >= 0 AND shadow_sample_rate <= 1),
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
  state TEXT NOT NULL CHECK(state IN ('pending', 'running', 'completed', 'failed')),
  started_at INTEGER,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  error_code TEXT,
  UNIQUE(generation_id, tenant_id, project_id)
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
  baseline_empty INTEGER NOT NULL CHECK(baseline_empty IN (0, 1)),
  candidate_empty INTEGER NOT NULL CHECK(candidate_empty IN (0, 1)),
  candidate_degraded INTEGER NOT NULL CHECK(candidate_degraded IN (0, 1)),
  baseline_latency_ms REAL NOT NULL,
  candidate_latency_ms REAL NOT NULL,
  evidence_tokens INTEGER,
  projection_lag_ms INTEGER,
  error_code TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_retrieval_evaluation_tenant_created
ON retrieval_evaluation_events(tenant_id, created_at DESC);

INSERT INTO retrieval_ranking_profiles(
  id, name, algorithm, config_json, config_hash, created_at
) VALUES(
  'rank_default',
  'default',
  'reciprocal_rank_fusion',
  '{"rrf_constant":60,"semantic_weight":0.9,"atomic_weight":1.2,"profile_weight":1.35,"timeline_weight":1.35}',
  'builtin:rank_default:1',
  unixepoch('now') * 1000
) ON CONFLICT(id) DO NOTHING;

INSERT INTO retrieval_generations(
  id, label, unit_schema_version, extractor_name, extractor_version,
  embedding_profile_id, ranking_profile_id, config_hash,
  baseline_generation_id, status, created_at, activated_at
) VALUES(
  'gen_baseline_units', 'baseline_units', 1, 'retrieval-units', '1',
  NULL, 'rank_default', 'builtin:baseline_units:1',
  NULL, 'fallback', unixepoch('now') * 1000, NULL
) ON CONFLICT(id) DO NOTHING;

INSERT INTO retrieval_generations(
  id, label, unit_schema_version, extractor_name, extractor_version,
  embedding_profile_id, ranking_profile_id, config_hash,
  baseline_generation_id, status, created_at, activated_at
) VALUES(
  'gen_structured_context', 'structured_context', 2, 'retrieval-units', '4',
  NULL, 'rank_default', 'builtin:structured_context:1',
  'gen_baseline_units', 'shadow', unixepoch('now') * 1000, NULL
) ON CONFLICT(id) DO NOTHING;
