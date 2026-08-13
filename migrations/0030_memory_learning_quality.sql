ALTER TABLE memories ADD COLUMN capture_origin TEXT NOT NULL DEFAULT 'legacy'
  CHECK(capture_origin IN ('observed', 'synthetic', 'repair', 'legacy'));
ALTER TABLE memories ADD COLUMN verification_state TEXT NOT NULL DEFAULT 'unverified'
  CHECK(verification_state IN ('verified', 'partial', 'unverified', 'rejected'));
ALTER TABLE memories ADD COLUMN verified_at INTEGER;
ALTER TABLE memories ADD COLUMN learning_json TEXT;
ALTER TABLE memories ADD COLUMN quality_dimensions_json TEXT;

ALTER TABLE decision_evidence ADD COLUMN content_hash TEXT;
ALTER TABLE decision_evidence ADD COLUMN observed_at INTEGER;
ALTER TABLE decision_evidence ADD COLUMN attestation_ref TEXT;

CREATE INDEX IF NOT EXISTS idx_memories_learning_origin_state
ON memories(tenant_id, capture_origin, verification_state, lifecycle_state, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memories_learning_scope
ON memories(tenant_id, project_id, business_category_id, work_type, verification_state, valid_until);

CREATE INDEX IF NOT EXISTS idx_decision_evidence_attestation
ON decision_evidence(tenant_id, attestation_ref, observed_at DESC)
WHERE attestation_ref IS NOT NULL;

INSERT INTO retrieval_generations(
  id, label, unit_schema_version, extractor_name, extractor_version,
  embedding_profile_id, ranking_profile_id, config_hash,
  baseline_generation_id, status, created_at, activated_at
) VALUES(
  'gen_verified_learning', 'verified_learning', 3, 'verified-learning', '1',
  'qwen3-embedding-0.6b', 'rank_default', 'builtin:verified-learning:1',
  'gen_structured_context', 'shadow', unixepoch('now') * 1000, NULL
) ON CONFLICT(id) DO NOTHING;
