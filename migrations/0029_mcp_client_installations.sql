CREATE TABLE IF NOT EXISTS mcp_client_installations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_principal TEXT NOT NULL,
  client_type TEXT NOT NULL CHECK(client_type IN ('codex', 'claude', 'cursor')),
  device_label TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'hook' CHECK(purpose IN ('hook')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'active', 'revoked')),
  access_subject_hash TEXT,
  enrollment_token_hash TEXT,
  enrollment_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_client_installations_access_subject
ON mcp_client_installations(access_subject_hash)
WHERE access_subject_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_client_installations_enrollment
ON mcp_client_installations(enrollment_token_hash)
WHERE enrollment_token_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mcp_client_installations_owner
ON mcp_client_installations(tenant_id, owner_principal, status, created_at DESC);
