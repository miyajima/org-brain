CREATE TABLE IF NOT EXISTS metric_source_bindings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  metric_definition_id TEXT NOT NULL REFERENCES metric_definitions(id),
  metric_binding_id TEXT REFERENCES metric_bindings(id),
  binding_key TEXT NOT NULL DEFAULT '__definition__',
  adapter_id TEXT NOT NULL,
  query_template TEXT NOT NULL,
  connection_ref TEXT,
  external_scope_ref TEXT,
  status TEXT NOT NULL DEFAULT 'unconfigured'
    CHECK(status IN ('unconfigured', 'configured', 'active', 'error', 'paused')),
  last_attempt_at INTEGER,
  last_success_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id, metric_definition_id, binding_key)
);

CREATE INDEX IF NOT EXISTS idx_metric_source_bindings_tenant_status
  ON metric_source_bindings(tenant_id, status, updated_at DESC);

ALTER TABLE metric_snapshots
  ADD COLUMN source_binding_id TEXT REFERENCES metric_source_bindings(id);

CREATE INDEX IF NOT EXISTS idx_metric_snapshots_source_binding
  ON metric_snapshots(tenant_id, source_binding_id, observed_at DESC);
