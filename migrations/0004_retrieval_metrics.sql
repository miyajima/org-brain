CREATE TABLE IF NOT EXISTS retrieval_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  task_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  search_strategy TEXT NOT NULL,
  query_text TEXT NOT NULL,
  query_hash TEXT NOT NULL,
  matched_count INTEGER NOT NULL DEFAULT 0,
  returned_count INTEGER NOT NULL DEFAULT 0,
  fallback_used INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  top_memory_ids_json TEXT NOT NULL,
  top_scores_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_retrieval_events_tenant_created
ON retrieval_events(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_retrieval_events_task
ON retrieval_events(tenant_id, task_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_retrieval_events_cap_created
ON retrieval_events(tenant_id, capability, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_retrieval_events_strategy_created
ON retrieval_events(tenant_id, search_strategy, created_at DESC);

CREATE TABLE IF NOT EXISTS retrieval_daily_metrics (
  day TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  search_strategy TEXT NOT NULL,
  search_count INTEGER NOT NULL DEFAULT 0,
  task_count INTEGER NOT NULL DEFAULT 0,
  hit_rate REAL NOT NULL DEFAULT 0,
  fallback_rate REAL NOT NULL DEFAULT 0,
  avg_matched_count REAL NOT NULL DEFAULT 0,
  avg_returned_count REAL NOT NULL DEFAULT 0,
  avg_latency_ms REAL NOT NULL DEFAULT 0,
  p95_latency_ms REAL,
  success_rate REAL NOT NULL DEFAULT 0,
  avg_task_duration_ms REAL,
  failed_task_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (day, tenant_id, capability, search_strategy)
);

CREATE INDEX IF NOT EXISTS idx_retrieval_daily_metrics_tenant_day
ON retrieval_daily_metrics(tenant_id, day DESC);

CREATE INDEX IF NOT EXISTS idx_retrieval_daily_metrics_cap_day
ON retrieval_daily_metrics(tenant_id, capability, day DESC);
