-- OAuth security-v2 is opt-in. Apply before enabling its source flag.
-- Only credential hashes are stored here; SDK token/grant encryption stays in KV.
CREATE TABLE oauth_device_clients (
  client_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL
);
CREATE TABLE oauth_device_requests (
  device_hash TEXT PRIMARY KEY, user_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES oauth_device_clients(client_id),
  resource TEXT NOT NULL, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL,
  principal TEXT NOT NULL, default_role TEXT,
  identity_issuer TEXT, identity_subject TEXT, identity_email TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','approved','denied','consumed')),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  interval_seconds INTEGER NOT NULL DEFAULT 5, next_poll_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, csrf_hash TEXT, csrf_principal TEXT
);
CREATE INDEX oauth_device_expiry ON oauth_device_requests(expires_at);
CREATE TABLE oauth_grant_families (
  family_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, grant_id TEXT NOT NULL,
  client_id TEXT NOT NULL, resource TEXT NOT NULL,
  tenant_id TEXT NOT NULL, principal TEXT NOT NULL, project_id TEXT,
  identity_issuer TEXT NOT NULL, identity_subject TEXT NOT NULL, identity_email TEXT, scopes_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE oauth_refresh_tokens (
  token_hash TEXT PRIMARY KEY, family_id TEXT NOT NULL REFERENCES oauth_grant_families(family_id),
  state TEXT NOT NULL CHECK(state IN ('active','used')), created_at INTEGER NOT NULL
);
CREATE INDEX oauth_refresh_family ON oauth_refresh_tokens(family_id);
CREATE UNIQUE INDEX oauth_refresh_one_active ON oauth_refresh_tokens(family_id) WHERE state='active';
CREATE TABLE oauth_attempt_buckets (
  bucket_hash TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
