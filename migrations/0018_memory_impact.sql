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

CREATE INDEX IF NOT EXISTS idx_memory_impact_daily_tenant_day
ON memory_impact_daily_metrics(tenant_id, day DESC);
