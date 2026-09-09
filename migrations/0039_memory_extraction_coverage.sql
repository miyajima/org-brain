-- Optional coverage/v1 execution. The profile remains disabled unless both the
-- packet and the exact tenant/project/installation allowlist opt in.
ALTER TABLE memory_extraction_outbox RENAME TO memory_extraction_outbox_v1;
ALTER TABLE memory_extraction_token_reservations RENAME TO memory_extraction_token_reservations_v1;
ALTER TABLE memory_extraction_runs RENAME TO memory_extraction_runs_v1;

DROP INDEX IF EXISTS idx_memory_extraction_outbox_dispatch;
DROP INDEX IF EXISTS idx_memory_extraction_runs_project;
DROP INDEX IF EXISTS idx_memory_extraction_runs_execution;
DROP INDEX IF EXISTS idx_memory_extraction_runs_expiry;

CREATE TABLE memory_extraction_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  installation_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  execution_status TEXT NOT NULL CHECK(execution_status IN ('planned', 'reserved', 'running', 'settled')),
  outcome TEXT CHECK(outcome IN ('succeeded', 'no_candidate', 'hard_excluded', 'model_unavailable', 'budget_exhausted', 'provider_failed', 'outcome_unknown', 'expired')),
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
  extraction_profile TEXT CHECK(extraction_profile IS NULL OR extraction_profile = 'coverage/v1'),
  prompt_policy_hash TEXT NOT NULL DEFAULT '',
  verifier_policy_hash TEXT NOT NULL DEFAULT '',
  execution_policy_hash TEXT NOT NULL DEFAULT '',
  coverage_status TEXT,
  reserved_tokens INTEGER NOT NULL DEFAULT 0 CHECK(reserved_tokens BETWEEN 0 AND 5600),
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

INSERT INTO memory_extraction_runs(
  id, tenant_id, project_id, installation_id, task_id, execution_status, outcome,
  provider, model, packet_hash, cache_key, key_version, schema_version, contract_hash,
  prompt_version, redaction_version, prefilter_version, reserved_tokens,
  actual_input_tokens, actual_output_tokens, charged_tokens, cache_hit, staging_r2_key,
  capsule_r2_key, result_r2_key, error_code, created_at, updated_at, started_at,
  settled_at, staging_expires_at, capsule_expires_at, tombstoned_at
)
SELECT id, tenant_id, project_id, installation_id, task_id, execution_status, outcome,
  provider, model, packet_hash, cache_key, key_version, schema_version, contract_hash,
  prompt_version, redaction_version, prefilter_version, reserved_tokens,
  actual_input_tokens, actual_output_tokens, charged_tokens, cache_hit, staging_r2_key,
  capsule_r2_key, result_r2_key, error_code, created_at, updated_at, started_at,
  settled_at, staging_expires_at, capsule_expires_at, tombstoned_at
FROM memory_extraction_runs_v1;

CREATE INDEX idx_memory_extraction_runs_project ON memory_extraction_runs(tenant_id, project_id, created_at DESC);
CREATE INDEX idx_memory_extraction_runs_execution ON memory_extraction_runs(tenant_id, execution_status, outcome, updated_at);
CREATE INDEX idx_memory_extraction_runs_expiry ON memory_extraction_runs(staging_expires_at, capsule_expires_at, tombstoned_at);

CREATE TABLE memory_extraction_token_reservations (
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  utc_month TEXT NOT NULL,
  tier TEXT NOT NULL CHECK(tier IN ('tier2', 'tier3')),
  reserved_tokens INTEGER NOT NULL CHECK(reserved_tokens BETWEEN 0 AND 5600),
  charged_tokens INTEGER,
  applied INTEGER NOT NULL DEFAULT 0 CHECK(applied IN (0, 1)),
  settled INTEGER NOT NULL DEFAULT 0 CHECK(settled IN (0, 1)),
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  PRIMARY KEY(tenant_id, run_id),
  FOREIGN KEY(run_id) REFERENCES memory_extraction_runs(id)
);

INSERT INTO memory_extraction_token_reservations
SELECT * FROM memory_extraction_token_reservations_v1;

CREATE TABLE memory_extraction_outbox (
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

INSERT INTO memory_extraction_outbox SELECT * FROM memory_extraction_outbox_v1;
CREATE INDEX idx_memory_extraction_outbox_dispatch ON memory_extraction_outbox(state, available_at, created_at);

CREATE TABLE memory_extraction_passes (
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  pass_no INTEGER NOT NULL CHECK(pass_no IN (1, 2)),
  state TEXT NOT NULL CHECK(state IN ('planned', 'running', 'succeeded', 'failed', 'outcome_unknown', 'skipped')),
  request_hash TEXT,
  result_r2_key TEXT,
  actual_input_tokens INTEGER,
  actual_output_tokens INTEGER,
  charged_tokens INTEGER NOT NULL DEFAULT 0 CHECK(charged_tokens >= 0),
  error_code TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(tenant_id, run_id, pass_no),
  FOREIGN KEY(run_id) REFERENCES memory_extraction_runs(id)
);

CREATE INDEX idx_memory_extraction_passes_state ON memory_extraction_passes(tenant_id, state, updated_at);

DROP TABLE memory_extraction_outbox_v1;
DROP TABLE memory_extraction_token_reservations_v1;
DROP TABLE memory_extraction_runs_v1;

UPDATE capabilities
SET cost_limit_ms = 90000, version = MAX(version, 2), updated_at = unixepoch('now') * 1000
WHERE name = 'memory_extraction';
