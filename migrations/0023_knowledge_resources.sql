CREATE TABLE IF NOT EXISTS knowledge_resources (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  resource_kind TEXT NOT NULL CHECK(resource_kind IN (
    'document', 'issue', 'pull_request', 'commit', 'design', 'runbook',
    'dashboard', 'dataset', 'report', 'test_result', 'build', 'release', 'other'
  )),
  canonical_uri TEXT NOT NULL,
  title TEXT NOT NULL,
  source_system TEXT NOT NULL,
  media_type TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'tenant' CHECK(visibility IN ('tenant', 'project', 'restricted')),
  permissions_json TEXT NOT NULL DEFAULT '[]',
  current_version_id TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle_state IN ('active', 'stale', 'retired')),
  created_by_principal TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id, id),
  FOREIGN KEY(tenant_id, id, current_version_id)
    REFERENCES knowledge_resource_versions(tenant_id, resource_id, id) DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_resources_canonical_uri
ON knowledge_resources(tenant_id, canonical_uri);

CREATE INDEX IF NOT EXISTS idx_knowledge_resources_scope
ON knowledge_resources(tenant_id, project_id, resource_kind, lifecycle_state, updated_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_resource_locations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  uri TEXT NOT NULL,
  normalized_uri TEXT NOT NULL,
  location_role TEXT NOT NULL CHECK(location_role IN ('canonical', 'mirror', 'source')),
  connector_id TEXT,
  fetch_enabled INTEGER NOT NULL DEFAULT 0 CHECK(fetch_enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id, id),
  FOREIGN KEY(tenant_id, resource_id) REFERENCES knowledge_resources(tenant_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_resource_locations_uri
ON knowledge_resource_locations(tenant_id, normalized_uri);

CREATE INDEX IF NOT EXISTS idx_knowledge_resource_locations_resource
ON knowledge_resource_locations(tenant_id, resource_id, location_role);

CREATE TABLE IF NOT EXISTS knowledge_resource_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  source_version TEXT,
  etag TEXT,
  last_modified TEXT,
  content_hash TEXT NOT NULL,
  snapshot_object_ref TEXT NOT NULL,
  extracted_text TEXT NOT NULL,
  extracted_text_hash TEXT NOT NULL,
  extraction_state TEXT NOT NULL CHECK(extraction_state IN ('pending', 'ready', 'degraded', 'failed')),
  captured_at INTEGER NOT NULL,
  created_by_principal TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(tenant_id, id),
  UNIQUE(tenant_id, resource_id, id),
  FOREIGN KEY(tenant_id, resource_id) REFERENCES knowledge_resources(tenant_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_resource_versions_digest
ON knowledge_resource_versions(tenant_id, resource_id, content_hash);

CREATE INDEX IF NOT EXISTS idx_knowledge_resource_versions_resource
ON knowledge_resource_versions(tenant_id, resource_id, captured_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_resource_versions_fts USING fts5(
  version_id UNINDEXED,
  tenant_id UNINDEXED,
  resource_id UNINDEXED,
  title,
  text,
  tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS knowledge_assertions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  assertion_type TEXT NOT NULL CHECK(assertion_type IN ('claim', 'relation')),
  subject_type TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object_type TEXT,
  object_ref TEXT,
  resource_id TEXT,
  object_value TEXT,
  context_json TEXT NOT NULL DEFAULT '{}',
  confidence REAL NOT NULL DEFAULT 1 CHECK(confidence >= 0 AND confidence <= 1),
  confirmation_state TEXT NOT NULL CHECK(confirmation_state IN ('proposal', 'confirmed', 'retired')),
  idempotency_key TEXT NOT NULL,
  valid_from INTEGER NOT NULL,
  valid_until INTEGER,
  actor_principal TEXT NOT NULL,
  reviewed_by_principal TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id, id),
  UNIQUE(tenant_id, id, resource_id),
  FOREIGN KEY(tenant_id, resource_id) REFERENCES knowledge_resources(tenant_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_assertions_idempotency
ON knowledge_assertions(tenant_id, idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_decision_resource_links_active
ON knowledge_assertions(tenant_id, subject_type, subject_ref, predicate, object_type, object_ref)
WHERE assertion_type = 'relation'
  AND subject_type IN ('decision_memory', 'decision_rationale')
  AND object_type = 'knowledge_resource'
  AND confirmation_state = 'confirmed'
  AND valid_until IS NULL;

CREATE INDEX IF NOT EXISTS idx_knowledge_assertions_subject
ON knowledge_assertions(tenant_id, subject_type, subject_ref, confirmation_state, valid_until);

CREATE INDEX IF NOT EXISTS idx_knowledge_assertions_object
ON knowledge_assertions(tenant_id, object_type, object_ref, confirmation_state, valid_until);

CREATE TABLE IF NOT EXISTS knowledge_assertion_evidence (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  assertion_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  resource_version_id TEXT NOT NULL,
  locator_json TEXT,
  excerpt_digest TEXT,
  note TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(tenant_id, id),
  FOREIGN KEY(tenant_id, assertion_id, resource_id) REFERENCES knowledge_assertions(tenant_id, id, resource_id),
  FOREIGN KEY(tenant_id, resource_id, resource_version_id) REFERENCES knowledge_resource_versions(tenant_id, resource_id, id)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_assertion_evidence_assertion
ON knowledge_assertion_evidence(tenant_id, assertion_id, created_at);

CREATE INDEX IF NOT EXISTS idx_knowledge_assertion_evidence_version
ON knowledge_assertion_evidence(tenant_id, resource_version_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_assertion_evidence_dedupe
ON knowledge_assertion_evidence(
  tenant_id,
  assertion_id,
  resource_version_id,
  COALESCE(locator_json, ''),
  COALESCE(excerpt_digest, ''),
  COALESCE(note, '')
);

CREATE VIEW IF NOT EXISTS confirmed_decision_resource_edges AS
SELECT
  a.tenant_id,
  a.project_id,
  a.id AS assertion_id,
  a.subject_type AS decision_source_type,
  a.subject_ref AS decision_source_id,
  a.predicate AS role,
  a.resource_id,
  e.resource_version_id,
  e.locator_json,
  a.valid_from,
  a.valid_until
FROM knowledge_assertions a
LEFT JOIN knowledge_assertion_evidence e
  ON e.tenant_id = a.tenant_id
 AND e.assertion_id = a.id
 AND e.resource_id = a.resource_id
WHERE a.assertion_type = 'relation'
  AND a.subject_type IN ('decision_memory', 'decision_rationale')
  AND a.object_type = 'knowledge_resource'
  AND a.confirmation_state = 'confirmed'
  AND a.valid_until IS NULL;

DROP INDEX IF EXISTS idx_retrieval_units_source;
DROP INDEX IF EXISTS idx_retrieval_units_business_work;
DROP INDEX IF EXISTS idx_retrieval_units_timeline;

ALTER TABLE retrieval_units RENAME TO retrieval_units_before_knowledge_resources;

CREATE TABLE retrieval_units (
  id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  source_type TEXT NOT NULL CHECK(source_type IN ('memory', 'decision_memory', 'knowledge_resource_version')),
  source_id TEXT NOT NULL,
  business_category_id TEXT,
  work_type TEXT,
  unit_type TEXT NOT NULL,
  text TEXT NOT NULL,
  speaker TEXT,
  event_at INTEGER,
  valid_from INTEGER,
  valid_until INTEGER,
  source_ref_json TEXT,
  source_span_start INTEGER,
  source_span_end INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  segment_id TEXT,
  content_hash TEXT NOT NULL,
  extractor_name TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  extraction_state TEXT NOT NULL DEFAULT 'degraded',
  degraded_reason TEXT,
  created_at INTEGER NOT NULL
);

INSERT INTO retrieval_units SELECT * FROM retrieval_units_before_knowledge_resources;
DROP TABLE retrieval_units_before_knowledge_resources;

CREATE INDEX idx_retrieval_units_source
ON retrieval_units(generation_id, tenant_id, source_type, source_id, unit_type);

CREATE INDEX idx_retrieval_units_business_work
ON retrieval_units(generation_id, tenant_id, business_category_id, work_type, unit_type);

CREATE INDEX idx_retrieval_units_timeline
ON retrieval_units(generation_id, tenant_id, unit_type, event_at DESC);
