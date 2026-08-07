CREATE TABLE IF NOT EXISTS organizations (
  tenant_id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  allowed_email_domains_json TEXT NOT NULL DEFAULT '[]',
  email_self_registration_enabled INTEGER NOT NULL DEFAULT 0 CHECK(email_self_registration_enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

ALTER TABLE user_profiles ADD COLUMN full_name TEXT;
ALTER TABLE user_profiles ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK(status IN ('invited', 'active', 'suspended', 'deprovisioned'));
ALTER TABLE user_profiles ADD COLUMN provision_source TEXT NOT NULL DEFAULT 'legacy'
  CHECK(provision_source IN ('email', 'oidc', 'scim', 'legacy'));
ALTER TABLE user_profiles ADD COLUMN full_name_source TEXT NOT NULL DEFAULT 'legacy'
  CHECK(full_name_source IN ('email', 'oidc', 'scim', 'legacy'));
ALTER TABLE user_profiles ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0 CHECK(email_verified IN (0, 1));

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_profiles_email_identity
ON user_profiles(tenant_id, lower(email)) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_profiles_status
ON user_profiles(tenant_id, status, display_name);

CREATE TABLE IF NOT EXISTS user_identities (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  provider_type TEXT NOT NULL CHECK(provider_type IN ('email', 'oidc', 'scim')),
  issuer TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL,
  external_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id, provider_type, issuer, subject),
  UNIQUE(tenant_id, principal, provider_type, issuer)
);

CREATE TABLE IF NOT EXISTS email_auth_challenges (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  request_ip_hash TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_auth_challenges_lookup
ON email_auth_challenges(tenant_id, email, created_at DESC);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  auth_source TEXT NOT NULL CHECK(auth_source IN ('email', 'oidc')),
  csrf_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_principal
ON auth_sessions(tenant_id, principal, expires_at, revoked_at);

ALTER TABLE groups ADD COLUMN source TEXT NOT NULL DEFAULT 'local' CHECK(source IN ('local', 'scim'));
ALTER TABLE groups ADD COLUMN external_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_external_identity
ON groups(tenant_id, source, external_id) WHERE external_id IS NOT NULL;

ALTER TABLE group_members ADD COLUMN source TEXT NOT NULL DEFAULT 'local' CHECK(source IN ('local', 'scim'));

ALTER TABLE principal_role_assignments ADD COLUMN source TEXT NOT NULL DEFAULT 'local' CHECK(source IN ('local', 'scim'));
ALTER TABLE principal_role_assignments ADD COLUMN source_ref TEXT;
