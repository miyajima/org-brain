CREATE TABLE IF NOT EXISTS scheduled_job_runs (
  id TEXT PRIMARY KEY,
  job_name TEXT NOT NULL,
  scheduled_for INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  attempt INTEGER NOT NULL DEFAULT 1,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  result_json TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_job_runs_identity
ON scheduled_job_runs(job_name, scheduled_for);

CREATE INDEX IF NOT EXISTS idx_scheduled_job_runs_latest
ON scheduled_job_runs(job_name, scheduled_for DESC);

CREATE INDEX IF NOT EXISTS idx_scheduled_job_runs_status_updated
ON scheduled_job_runs(status, updated_at);

CREATE TABLE IF NOT EXISTS retention_deletion_queue (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  original_lifecycle_state TEXT NOT NULL,
  original_version INTEGER NOT NULL,
  suppressed_version INTEGER,
  effective_at INTEGER NOT NULL,
  detected_at INTEGER NOT NULL,
  delete_after INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'deleted', 'cancelled', 'failed', 'manual_review')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  deleted_at INTEGER,
  cancelled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_retention_deletion_queue_memory
ON retention_deletion_queue(tenant_id, memory_id);

CREATE INDEX IF NOT EXISTS idx_retention_deletion_queue_due
ON retention_deletion_queue(status, delete_after, tenant_id);

CREATE INDEX IF NOT EXISTS idx_retention_deletion_queue_tenant
ON retention_deletion_queue(tenant_id, status, detected_at DESC);

CREATE TABLE IF NOT EXISTS ops_alert_state (
  alert_key TEXT PRIMARY KEY,
  severity TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'firing', 'resolved')),
  fingerprint TEXT NOT NULL,
  observation_count INTEGER NOT NULL DEFAULT 1,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  last_notified_at INTEGER,
  resolved_at INTEGER,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ops_alert_state_status
ON ops_alert_state(status, last_seen_at);
