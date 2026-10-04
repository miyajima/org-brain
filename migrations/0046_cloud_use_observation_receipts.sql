-- Private report acknowledgements only. Never accepted as verified-use evidence.
-- The existing ORGBRAIN_USE_COLLECT flag remains OFF unless separately enabled.
CREATE TABLE IF NOT EXISTS cloud_use_observation_receipts (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, principal TEXT NOT NULL,
 project_id TEXT NOT NULL, task_id TEXT NOT NULL, usage_item_id TEXT NOT NULL,
 observation_json TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cloud_use_receipt_scope
 ON cloud_use_observation_receipts(tenant_id, principal, project_id, task_id, expires_at);
