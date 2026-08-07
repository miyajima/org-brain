CREATE TABLE IF NOT EXISTS memory_failure_patterns (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  business_category_id TEXT,
  work_type TEXT CHECK(work_type IS NULL OR work_type IN (
    'implementation', 'review', 'debug', 'proposal',
    'support', 'research', 'operations', 'other'
  )),
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
  capability TEXT,
  access_path TEXT NOT NULL CHECK(access_path IN ('search', 'profile', 'context', 'direct')),
  request_source TEXT NOT NULL CHECK(request_source IN ('api', 'mcp', 'cap_runner', 'local')),
  query_hash TEXT,
  requested_business_category_id TEXT,
  requested_work_type TEXT CHECK(requested_work_type IS NULL OR requested_work_type IN (
    'implementation', 'review', 'debug', 'proposal',
    'support', 'research', 'operations', 'other'
  )),
  retrieval_generation_id TEXT,
  ranking_profile_id TEXT,
  verification_sampled INTEGER NOT NULL DEFAULT 0 CHECK(verification_sampled IN (0, 1)),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_usage_events_tenant_created
ON memory_usage_events(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_usage_events_task
ON memory_usage_events(tenant_id, task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_usage_items (
  id TEXT PRIMARY KEY,
  usage_event_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('memory', 'decision_memory')),
  source_id TEXT NOT NULL,
  source_version INTEGER,
  rank INTEGER,
  score REAL,
  reference_type TEXT NOT NULL CHECK(reference_type IN ('returned', 'injected', 'direct')),
  used_state TEXT NOT NULL DEFAULT 'unknown' CHECK(used_state IN ('used', 'not_used', 'unknown')),
  used_state_source TEXT NOT NULL DEFAULT 'reported' CHECK(used_state_source IN ('reported', 'effect')),
  injected_token_estimate INTEGER NOT NULL DEFAULT 0 CHECK(injected_token_estimate >= 0),
  business_category_id_snapshot TEXT,
  work_type_snapshot TEXT,
  quality_category_snapshot TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(tenant_id, usage_event_id, source_type, source_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_usage_items_source
ON memory_usage_items(tenant_id, source_type, source_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_effect_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  usage_event_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  evidence_level TEXT NOT NULL CHECK(evidence_level IN ('reported', 'estimated', 'verified', 'unverifiable')),
  supersedes_effect_id TEXT,
  effect_outcome TEXT NOT NULL CHECK(effect_outcome IN ('positive', 'neutral', 'negative', 'unknown')),
  avoided_lookup_categories_json TEXT NOT NULL DEFAULT '[]',
  gross_saved_tokens_estimate INTEGER NOT NULL DEFAULT 0,
  injected_tokens INTEGER NOT NULL DEFAULT 0 CHECK(injected_tokens >= 0),
  net_saved_tokens_estimate INTEGER NOT NULL DEFAULT 0,
  estimate_lower_bound INTEGER,
  estimate_upper_bound INTEGER,
  estimation_method TEXT,
  estimator_version TEXT,
  estimate_confidence REAL CHECK(estimate_confidence IS NULL OR (estimate_confidence >= 0 AND estimate_confidence <= 1)),
  failure_pattern_id TEXT,
  failure_opportunity_state TEXT NOT NULL DEFAULT 'unknown'
    CHECK(failure_opportunity_state IN ('applicable', 'not_applicable', 'unknown')),
  action_changed INTEGER NOT NULL DEFAULT 0 CHECK(action_changed IN (0, 1)),
  alternative_executed INTEGER NOT NULL DEFAULT 0 CHECK(alternative_executed IN (0, 1)),
  failure_avoided INTEGER NOT NULL DEFAULT 0 CHECK(failure_avoided IN (0, 1)),
  failure_saved_tokens_estimate INTEGER NOT NULL DEFAULT 0,
  verification_ref_type TEXT,
  verification_ref_id TEXT,
  estimated_tool_calls_saved REAL,
  estimated_seconds_saved REAL,
  created_at INTEGER NOT NULL,
  UNIQUE(tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_memory_effect_events_usage
ON memory_effect_events(tenant_id, usage_event_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_effect_events_root
ON memory_effect_events(tenant_id, usage_event_id)
WHERE supersedes_effect_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_effect_events_supersedes
ON memory_effect_events(tenant_id, supersedes_effect_id)
WHERE supersedes_effect_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS memory_effect_attributions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  effect_event_id TEXT NOT NULL,
  usage_item_id TEXT NOT NULL,
  attribution_weight REAL NOT NULL CHECK(attribution_weight > 0 AND attribution_weight <= 1),
  gross_saved_tokens INTEGER NOT NULL DEFAULT 0,
  net_saved_tokens INTEGER NOT NULL DEFAULT 0,
  failure_saved_tokens INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(tenant_id, effect_event_id, usage_item_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_effect_attributions_item
ON memory_effect_attributions(tenant_id, usage_item_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_effect_daily_metrics (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('memory', 'decision_memory')),
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_effect_daily_dimensions
ON memory_effect_daily_metrics(
  day, tenant_id, source_type, source_id,
  IFNULL(project_id_snapshot, ''),
  IFNULL(business_category_id_snapshot, ''),
  IFNULL(work_type_snapshot, ''),
  IFNULL(quality_category_snapshot, '')
);

CREATE INDEX IF NOT EXISTS idx_memory_effect_daily_business
ON memory_effect_daily_metrics(tenant_id, day DESC, business_category_id_snapshot, work_type_snapshot);
