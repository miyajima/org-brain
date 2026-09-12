-- Human feedback is separate from active memory and from a save receipt.
-- A confirmation is immutable; a later correction creates a new revision.
CREATE TABLE IF NOT EXISTS memory_confirmation_reviews (
  confirmation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  owner_principal TEXT,
  candidate_id TEXT,
  candidate_hash TEXT,
  original_json TEXT NOT NULL,
  source_refs_json TEXT NOT NULL,
  answer_label TEXT NOT NULL CHECK(answer_label IN ('accepted','corrected','not_needed','incorrect','not_decided','deferred','unknown')),
  answer_text TEXT NOT NULL,
  corrected_json TEXT,
  assessment_json TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  save_state TEXT NOT NULL CHECK(save_state IN ('processing','saved','not_requested','failed')),
  memory_id TEXT,
  rationale_id TEXT,
  response_json TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_confirmation_reviews_owner
  ON memory_confirmation_reviews(tenant_id, owner_principal, project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_confirmation_reviews_candidate
  ON memory_confirmation_reviews(tenant_id, candidate_hash, created_at DESC);

ALTER TABLE domain_recall_feedback ADD COLUMN usefulness_json TEXT;
