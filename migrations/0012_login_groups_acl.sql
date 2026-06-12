CREATE TABLE IF NOT EXISTS user_profiles (
  tenant_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  display_name TEXT,
  email TEXT,
  company_name TEXT,
  organization_name TEXT,
  avatar_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, principal)
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_email
ON user_profiles(tenant_id, email);

CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_by_principal TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_slug
ON groups(tenant_id, slug)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_groups_created
ON groups(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS group_members (
  tenant_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, group_id, principal)
);

CREATE INDEX IF NOT EXISTS idx_group_members_principal
ON group_members(tenant_id, principal);

CREATE TABLE IF NOT EXISTS resource_acl (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'read',
  created_by_principal TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_acl_identity
ON resource_acl(tenant_id, resource_type, resource_id, subject_type, subject_id, permission);

CREATE INDEX IF NOT EXISTS idx_resource_acl_resource
ON resource_acl(tenant_id, resource_type, resource_id);

CREATE INDEX IF NOT EXISTS idx_resource_acl_subject
ON resource_acl(tenant_id, subject_type, subject_id);

ALTER TABLE knowledge_docs ADD COLUMN visibility TEXT NOT NULL DEFAULT 'tenant';
ALTER TABLE knowledge_docs ADD COLUMN owner_principal TEXT;

CREATE INDEX IF NOT EXISTS idx_knowledge_docs_visibility
ON knowledge_docs(tenant_id, visibility, updated_at DESC);
