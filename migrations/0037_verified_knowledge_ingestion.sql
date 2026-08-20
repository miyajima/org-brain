-- Evidence-chain manifests are an append-only audit layer.  Existing memory,
-- decision, resource, and AI-learning tables remain the system of record.
CREATE TABLE IF NOT EXISTS local_collector_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  public_key_json TEXT NOT NULL,
  algorithm TEXT NOT NULL CHECK(algorithm = 'ECDSA-P256-SHA256'),
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active', 'revoked')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  revoked_by_principal TEXT,
  UNIQUE(tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_local_collector_keys_principal
  ON local_collector_keys(tenant_id, principal, state, expires_at);

CREATE TABLE IF NOT EXISTS verified_ingestion_manifests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  bundle_key TEXT NOT NULL,
  bundle_digest TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  scene_key TEXT NOT NULL,
  collector_key_id TEXT NOT NULL,
  extraction_profile_id TEXT NOT NULL,
  extraction_profile_version INTEGER NOT NULL,
  extraction_profile_hash TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  verification_state TEXT NOT NULL CHECK(verification_state IN (
    'active', 'verified_draft', 'quarantined', 'duplicate', 'extractor_disagreement'
  )),
  verification_reasons_json TEXT NOT NULL DEFAULT '[]',
  missing_stages_json TEXT NOT NULL DEFAULT '[]',
  provenance_coverage REAL NOT NULL DEFAULT 0 CHECK(provenance_coverage >= 0 AND provenance_coverage <= 1),
  evidence_count INTEGER NOT NULL DEFAULT 0 CHECK(evidence_count >= 0),
  candidate_count INTEGER NOT NULL DEFAULT 0 CHECK(candidate_count >= 0),
  edge_count INTEGER NOT NULL DEFAULT 0 CHECK(edge_count >= 0),
  projected_decision_id TEXT,
  projected_memory_id TEXT,
  created_by_principal TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id, id),
  UNIQUE(tenant_id, bundle_key, bundle_digest)
);

CREATE INDEX IF NOT EXISTS idx_verified_ingestion_manifests_state
  ON verified_ingestion_manifests(tenant_id, verification_state, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_verified_ingestion_manifests_bundle
  ON verified_ingestion_manifests(tenant_id, bundle_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_verified_ingestion_manifests_collector
  ON verified_ingestion_manifests(tenant_id, collector_key_id, created_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_provenance_bindings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  manifest_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('memory', 'decision_memory', 'decision_rationale', 'knowledge_resource', 'knowledge_resource_version', 'edge')),
  entity_id TEXT NOT NULL,
  field_name TEXT,
  edge_relation TEXT,
  source_event_id TEXT NOT NULL,
  source_span_json TEXT,
  receipt_id TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(tenant_id, id),
  FOREIGN KEY(tenant_id, manifest_id) REFERENCES verified_ingestion_manifests(tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_provenance_bindings_entity
  ON knowledge_provenance_bindings(tenant_id, entity_type, entity_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_provenance_bindings_dedupe
  ON knowledge_provenance_bindings(
    tenant_id, manifest_id, entity_type, entity_id,
    COALESCE(field_name, ''), COALESCE(edge_relation, ''), receipt_id
  );

CREATE INDEX IF NOT EXISTS idx_knowledge_provenance_bindings_manifest
  ON knowledge_provenance_bindings(tenant_id, manifest_id, created_at);
