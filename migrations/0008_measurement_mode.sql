CREATE TABLE IF NOT EXISTS measurement_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  capability TEXT NOT NULL,
  input_ref TEXT NOT NULL,
  reference_model TEXT NOT NULL,
  pair_key TEXT NOT NULL,
  measurement_session_id TEXT,
  measurement_unit TEXT NOT NULL DEFAULT 'task',
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_measurement_runs_pair
ON measurement_runs(tenant_id, pair_key);

CREATE INDEX IF NOT EXISTS idx_measurement_runs_created
ON measurement_runs(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_measurement_runs_session
ON measurement_runs(tenant_id, measurement_session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS measurement_variants (
  run_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  variant TEXT NOT NULL,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL,
  memory_enabled INTEGER NOT NULL DEFAULT 0,
  memory_write_enabled INTEGER NOT NULL DEFAULT 0,
  output_ref TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  input_cost_usd REAL,
  total_cost_usd REAL,
  duration_ms INTEGER,
  retrieval_count INTEGER,
  retrieved_ids_json TEXT,
  error_json TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY (run_id, variant)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_measurement_variants_task
ON measurement_variants(tenant_id, task_id);

CREATE INDEX IF NOT EXISTS idx_measurement_variants_run
ON measurement_variants(tenant_id, run_id);

CREATE TABLE IF NOT EXISTS measurement_comparisons (
  run_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  control_task_id TEXT NOT NULL,
  treatment_task_id TEXT NOT NULL,
  input_tokens_saved INTEGER NOT NULL,
  input_savings_rate REAL NOT NULL,
  input_cost_saved_usd REAL NOT NULL,
  total_cost_delta_usd REAL NOT NULL,
  duration_delta_ms INTEGER NOT NULL,
  quality_verdict TEXT NOT NULL,
  quality_passed INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_measurement_comparisons_tenant_created
ON measurement_comparisons(tenant_id, created_at DESC);
