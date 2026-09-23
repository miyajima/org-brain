CREATE TABLE IF NOT EXISTS action_attempts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  action_key TEXT NOT NULL,
  action_label TEXT NOT NULL,
  attempt_type TEXT NOT NULL CHECK(attempt_type IN ('intervention','tool_result')),
  target TEXT NOT NULL,
  conditions_json TEXT NOT NULL,
  conditions_hash TEXT,
  outcome TEXT NOT NULL CHECK(outcome IN ('success','failure','inconclusive')),
  result_summary TEXT NOT NULL,
  change_hypothesis TEXT,
  failure_kind TEXT CHECK(failure_kind IN ('deterministic','transient','unknown')),
  performed_at INTEGER NOT NULL,
  requested_by TEXT,
  executed_by_type TEXT NOT NULL CHECK(executed_by_type IN ('principal','agent','unknown')),
  executed_by TEXT,
  evidence_json TEXT NOT NULL,
  verification_state TEXT NOT NULL CHECK(verification_state IN ('verified','reported')),
  source TEXT NOT NULL,
  source_key TEXT NOT NULL,
  supersedes_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(tenant_id, source_key)
);
CREATE INDEX IF NOT EXISTS idx_action_attempts_lookup
  ON action_attempts(tenant_id, project_id, action_key, performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_attempts_project
  ON action_attempts(tenant_id, project_id, performed_at DESC);
CREATE TABLE IF NOT EXISTS action_hook_coverage (
  day TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  coverage TEXT NOT NULL CHECK(coverage IN ('checked','opaque','recorded','blocked')),
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day,tenant_id,project_id,tool_name,coverage)
);
CREATE TABLE IF NOT EXISTS action_attempt_use_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  task_id TEXT,
  stage TEXT NOT NULL CHECK(stage IN ('returned','injected','adopted','executed','result_checked')),
  verification_state TEXT NOT NULL CHECK(verification_state IN ('observed','reported','verified')),
  evidence_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_action_attempt_use_task
  ON action_attempt_use_events(tenant_id,project_id,task_id,stage,created_at DESC);
CREATE TABLE IF NOT EXISTS action_attempt_pattern_links (
  tenant_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  pattern_id TEXT NOT NULL,
  PRIMARY KEY(tenant_id,attempt_id,pattern_id)
);
CREATE TABLE IF NOT EXISTS action_attempt_metric_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('context_query','preflight','feedback')),
  source TEXT NOT NULL,
  action_key TEXT,
  conditions_hash TEXT,
  decision TEXT,
  reason TEXT,
  matched_attempt_id TEXT,
  related_event_id TEXT,
  feedback_verdict TEXT CHECK(feedback_verdict IN ('false_block','correct_block')),
  returned_count INTEGER,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  verification_state TEXT NOT NULL CHECK(verification_state IN ('observed','reported','verified')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_action_attempt_metric_project
  ON action_attempt_metric_events(tenant_id,project_id,kind,created_at DESC);
