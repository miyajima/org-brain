ALTER TABLE memories ADD COLUMN capture_route TEXT NOT NULL DEFAULT 'legacy'
  CHECK(capture_route IN ('realtime_hook', 'initial_import', 'manual', 'repair', 'legacy'));
ALTER TABLE memories ADD COLUMN capture_batch_id TEXT;

CREATE INDEX IF NOT EXISTS idx_memories_quality_route
  ON memories(tenant_id, project_id, capture_route, verification_state, lifecycle_state, created_at DESC);

ALTER TABLE memory_quality_runs ADD COLUMN input_source TEXT NOT NULL DEFAULT 'synthetic'
  CHECK(input_source IN ('synthetic', 'real'));
ALTER TABLE memory_quality_runs ADD COLUMN ground_truth_basis TEXT NOT NULL DEFAULT 'locked_oracle';
ALTER TABLE memory_quality_runs ADD COLUMN capture_routes_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE memory_quality_runs ADD COLUMN privacy_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE memory_quality_runs ADD COLUMN hard_violation_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS memory_quality_cases (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  case_hash TEXT NOT NULL,
  project_hash TEXT,
  session_hash TEXT,
  split TEXT NOT NULL CHECK(split IN ('development', 'validation', 'locked_test')),
  capture_route TEXT NOT NULL CHECK(capture_route IN ('realtime_hook', 'initial_import', 'manual', 'repair', 'legacy')),
  lesson_type TEXT,
  expected_route TEXT CHECK(expected_route IN ('active', 'quarantine', 'excluded')),
  actual_route TEXT NOT NULL CHECK(actual_route IN ('active', 'quarantine', 'excluded')),
  candidate_hash TEXT,
  memory_id TEXT,
  candidate_id TEXT,
  reason_codes_json TEXT NOT NULL DEFAULT '[]',
  hard_violation_count INTEGER NOT NULL DEFAULT 0,
  parity_mismatch INTEGER NOT NULL DEFAULT 0 CHECK(parity_mismatch IN (0, 1)),
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_quality_cases_run_case
  ON memory_quality_cases(run_id, case_hash);
CREATE INDEX IF NOT EXISTS idx_memory_quality_cases_filters
  ON memory_quality_cases(tenant_id, run_id, capture_route, actual_route, lesson_type, parity_mismatch, created_at DESC);
