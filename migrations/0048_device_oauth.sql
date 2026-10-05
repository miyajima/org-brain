-- Device credentials are opaque; only SHA-256 hashes are retained.
CREATE TABLE oauth_device_requests (
  device_hash TEXT PRIMARY KEY, user_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL,
  resource TEXT NOT NULL, scopes TEXT NOT NULL, expires_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','denied','consumed')),
  interval_ms INTEGER NOT NULL DEFAULT 5000, poll_after INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 0, claim_id TEXT,
  principal TEXT, role TEXT, csrf_hash TEXT, csrf_expires_at INTEGER
);
CREATE INDEX oauth_device_expiry ON oauth_device_requests(expires_at);
CREATE TABLE oauth_device_families (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL, principal TEXT NOT NULL, role TEXT NOT NULL,
  resource TEXT NOT NULL, scopes TEXT NOT NULL, expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE oauth_device_tokens (
  hash TEXT PRIMARY KEY, family_id TEXT NOT NULL REFERENCES oauth_device_families(id),
  kind TEXT NOT NULL CHECK(kind IN ('access','refresh')), expires_at INTEGER NOT NULL,
  consumed_at INTEGER, claim_id TEXT
);
CREATE INDEX oauth_device_token_family ON oauth_device_tokens(family_id);
CREATE TABLE oauth_device_limits (
  key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
