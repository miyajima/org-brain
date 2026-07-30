CREATE TABLE IF NOT EXISTS principal_role_assignments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  principal TEXT NOT NULL,
  role TEXT NOT NULL,
  created_by_principal TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_principal_role_identity
ON principal_role_assignments(
  tenant_id,
  COALESCE(project_id, ''),
  principal,
  role
);

CREATE INDEX IF NOT EXISTS idx_principal_role_lookup
ON principal_role_assignments(tenant_id, principal, project_id);

CREATE TABLE IF NOT EXISTS scoped_tokens (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  project_id TEXT,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  rotated_from_id TEXT,
  created_by_principal TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scoped_tokens_hash
ON scoped_tokens(token_hash);

CREATE INDEX IF NOT EXISTS idx_scoped_tokens_active
ON scoped_tokens(tenant_id, principal, expires_at, revoked_at);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  principal TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  outcome TEXT NOT NULL,
  request_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  previous_hash TEXT NOT NULL,
  entry_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_events_hash
ON audit_events(tenant_id, entry_hash);

CREATE INDEX IF NOT EXISTS idx_audit_events_created
ON audit_events(tenant_id, created_at, id);

CREATE TABLE IF NOT EXISTS retention_policies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  retention_days INTEGER NOT NULL,
  legal_hold INTEGER NOT NULL DEFAULT 0,
  updated_by_principal TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_retention_policy_scope
ON retention_policies(tenant_id, COALESCE(project_id, ''));
