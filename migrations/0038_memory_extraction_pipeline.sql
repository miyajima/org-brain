-- Review-only high-recall memory extraction. Applying this migration is a
-- separate production side effect from shipping the worker code.
CREATE TABLE IF NOT EXISTS memory_extraction_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  installation_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  execution_status TEXT NOT NULL CHECK(execution_status IN (
    'planned', 'reserved', 'running', 'settled'
  )),
  outcome TEXT CHECK(outcome IN (
    'succeeded', 'no_candidate', 'hard_excluded', 'model_unavailable',
    'budget_exhausted', 'provider_failed', 'outcome_unknown', 'expired'
  )),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  packet_hash TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  key_version TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  contract_hash TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  redaction_version TEXT NOT NULL,
  prefilter_version TEXT NOT NULL,
  reserved_tokens INTEGER NOT NULL DEFAULT 0 CHECK(reserved_tokens BETWEEN 0 AND 2800),
  actual_input_tokens INTEGER,
  actual_output_tokens INTEGER,
  charged_tokens INTEGER NOT NULL DEFAULT 0 CHECK(charged_tokens >= 0),
  cache_hit INTEGER NOT NULL DEFAULT 0 CHECK(cache_hit IN (0, 1)),
  staging_r2_key TEXT NOT NULL,
  capsule_r2_key TEXT,
  result_r2_key TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  settled_at INTEGER,
  staging_expires_at INTEGER NOT NULL,
  capsule_expires_at INTEGER NOT NULL,
  tombstoned_at INTEGER,
  UNIQUE(tenant_id, task_id),
  UNIQUE(tenant_id, cache_key)
);

CREATE INDEX IF NOT EXISTS idx_memory_extraction_runs_project
ON memory_extraction_runs(tenant_id, project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_extraction_runs_execution
ON memory_extraction_runs(tenant_id, execution_status, outcome, updated_at);

CREATE INDEX IF NOT EXISTS idx_memory_extraction_runs_expiry
ON memory_extraction_runs(staging_expires_at, capsule_expires_at, tombstoned_at);

CREATE TABLE IF NOT EXISTS memory_extraction_token_buckets (
  tenant_id TEXT NOT NULL,
  utc_month TEXT NOT NULL,
  tier TEXT NOT NULL CHECK(tier IN ('tier2', 'tier3')),
  token_limit INTEGER NOT NULL CHECK(token_limit >= 0),
  reserved_tokens INTEGER NOT NULL DEFAULT 0 CHECK(reserved_tokens >= 0),
  consumed_tokens INTEGER NOT NULL DEFAULT 0 CHECK(consumed_tokens >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(tenant_id, utc_month, tier)
);

CREATE TABLE IF NOT EXISTS memory_extraction_token_reservations (
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  utc_month TEXT NOT NULL,
  tier TEXT NOT NULL CHECK(tier IN ('tier2', 'tier3')),
  reserved_tokens INTEGER NOT NULL CHECK(reserved_tokens BETWEEN 0 AND 2800),
  charged_tokens INTEGER,
  applied INTEGER NOT NULL DEFAULT 0 CHECK(applied IN (0, 1)),
  settled INTEGER NOT NULL DEFAULT 0 CHECK(settled IN (0, 1)),
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  PRIMARY KEY(tenant_id, run_id),
  FOREIGN KEY(run_id) REFERENCES memory_extraction_runs(id)
);

CREATE TABLE IF NOT EXISTS memory_extraction_outbox (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'sending', 'sent', 'failed', 'canceled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  available_at INTEGER NOT NULL,
  claimed_at INTEGER,
  sent_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id, run_id),
  FOREIGN KEY(run_id) REFERENCES memory_extraction_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_memory_extraction_outbox_dispatch
ON memory_extraction_outbox(state, available_at, created_at);

INSERT INTO capabilities(
  tenant_id, name, version, input_schema, output_schema,
  max_concurrency, cost_limit_ms, allowed_tools, updated_at
)
VALUES(
  'default',
  'memory_extraction',
  1,
  '{"type":"object","required":["input_ref"],"properties":{"input_ref":{"type":"string"}}}',
  '{"type":"object","required":["output_ref"],"properties":{"output_ref":{"type":"string"}}}',
  2,
  30000,
  '["turn_evidence.read","provider.generate","memory_review.write","r2.write"]',
  unixepoch('now') * 1000
)
ON CONFLICT(tenant_id, name) DO UPDATE SET
  version = excluded.version,
  input_schema = excluded.input_schema,
  output_schema = excluded.output_schema,
  max_concurrency = excluded.max_concurrency,
  cost_limit_ms = excluded.cost_limit_ms,
  allowed_tools = excluded.allowed_tools,
  updated_at = excluded.updated_at;
