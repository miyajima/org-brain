CREATE TABLE mcp_client_installations_v2 (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_principal TEXT NOT NULL,
  client_type TEXT NOT NULL CHECK(client_type IN ('codex', 'claude', 'cursor')),
  device_label TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'capture' CHECK(purpose IN ('capture', 'recall')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'active', 'revoked')),
  access_subject_hash TEXT,
  enrollment_token_hash TEXT,
  enrollment_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  last_used_at INTEGER,
  revoked_at INTEGER
);

INSERT INTO mcp_client_installations_v2(
  id, tenant_id, owner_principal, client_type, device_label, purpose, status,
  access_subject_hash, enrollment_token_hash, enrollment_expires_at, created_at,
  activated_at, last_used_at, revoked_at
)
SELECT id, tenant_id, owner_principal, client_type, device_label,
  CASE WHEN purpose = 'hook' THEN 'capture' ELSE purpose END,
  status, access_subject_hash, enrollment_token_hash, enrollment_expires_at,
  created_at, activated_at, last_used_at, revoked_at
FROM mcp_client_installations;

DROP TABLE mcp_client_installations;
ALTER TABLE mcp_client_installations_v2 RENAME TO mcp_client_installations;

CREATE UNIQUE INDEX idx_mcp_client_installations_access_subject
  ON mcp_client_installations(access_subject_hash) WHERE access_subject_hash IS NOT NULL;
CREATE UNIQUE INDEX idx_mcp_client_installations_enrollment
  ON mcp_client_installations(enrollment_token_hash) WHERE enrollment_token_hash IS NOT NULL;
CREATE INDEX idx_mcp_client_installations_owner
  ON mcp_client_installations(tenant_id, owner_principal, status, created_at DESC);
CREATE INDEX idx_mcp_client_installations_purpose
  ON mcp_client_installations(tenant_id, purpose, status, created_at DESC);

CREATE TABLE domain_recall_units (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  pack_id TEXT NOT NULL,
  object_type_key TEXT NOT NULL,
  object_id TEXT,
  intent_aliases_json TEXT NOT NULL DEFAULT '[]',
  scope_json TEXT NOT NULL DEFAULT '{}',
  relation TEXT NOT NULL CHECK(relation IN ('primary', 'supporting', 'conflict')),
  decision_json TEXT NOT NULL,
  metrics_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  workflow TEXT,
  follow_up TEXT,
  evidence_verified INTEGER NOT NULL DEFAULT 0,
  metric_fresh INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'tenant' CHECK(visibility IN ('tenant', 'project', 'restricted')),
  owner_principal TEXT,
  allowed_principals_json TEXT NOT NULL DEFAULT '[]',
  valid_until INTEGER,
  search_text TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_domain_recall_units_scope
  ON domain_recall_units(tenant_id, project_id, object_type_key, object_id, updated_at DESC);

CREATE VIRTUAL TABLE domain_recall_units_fts USING fts5(
  unit_id UNINDEXED,
  tenant_id UNINDEXED,
  search_text,
  tokenize = 'unicode61'
);

CREATE TABLE domain_recall_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  owner_principal TEXT,
  runtime_actor TEXT,
  client_installation_id TEXT,
  client_name TEXT,
  query_hash TEXT NOT NULL,
  candidate_count INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('shadow', 'on')),
  bundle_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_domain_recall_events_tenant_created
  ON domain_recall_events(tenant_id, created_at DESC, id DESC);

CREATE TABLE domain_recall_event_candidates (
  recall_id TEXT NOT NULL REFERENCES domain_recall_events(id),
  tenant_id TEXT NOT NULL,
  recall_unit_id TEXT NOT NULL,
  pack_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('primary', 'supporting', 'conflict')),
  rank INTEGER NOT NULL,
  score REAL NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(recall_id, recall_unit_id)
);
CREATE INDEX idx_domain_recall_event_candidates_pack
  ON domain_recall_event_candidates(tenant_id, pack_id, created_at DESC, recall_id);

CREATE TABLE domain_recall_feedback (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  recall_id TEXT NOT NULL REFERENCES domain_recall_events(id),
  candidate_id TEXT,
  owner_principal TEXT NOT NULL,
  runtime_actor TEXT NOT NULL,
  client_installation_id TEXT,
  session_id TEXT,
  feedback TEXT NOT NULL CHECK(feedback IN ('useful', 'not_relevant', 'wrong_scope', 'outdated', 'incorrect_relation', 'dismiss_for_session')),
  effect TEXT NOT NULL CHECK(effect IN ('none', 'session_suppression', 'personal_suppression', 'team_review_proposal')),
  note TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE domain_recall_preferences (
  tenant_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('suppressed', 'active')),
  reason TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(tenant_id, principal, candidate_id)
);

CREATE TABLE domain_recall_review_proposals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  recall_id TEXT NOT NULL,
  candidate_id TEXT,
  proposal_type TEXT NOT NULL CHECK(proposal_type IN ('outdated', 'incorrect_relation')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'confirmed', 'rejected')),
  proposed_by_principal TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER
);

CREATE TABLE portable_imports (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_principal TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('uploading', 'planned', 'applied', 'rejected')),
  expected_digest TEXT,
  record_count INTEGER,
  plan_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  applied_at INTEGER
);

CREATE TABLE portable_import_chunks (
  import_id TEXT NOT NULL REFERENCES portable_imports(id),
  tenant_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  chunk_text TEXT NOT NULL,
  chunk_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(import_id, sequence)
);

CREATE TABLE portable_import_records (
  import_id TEXT NOT NULL REFERENCES portable_imports(id),
  tenant_id TEXT NOT NULL,
  section TEXT NOT NULL,
  record_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  PRIMARY KEY(import_id, section, record_id)
);

CREATE TABLE domain_authority_state (
  tenant_id TEXT PRIMARY KEY,
  authority TEXT NOT NULL CHECK(authority IN ('local', 'cloud')),
  archive_digest TEXT,
  updated_at INTEGER NOT NULL
);
