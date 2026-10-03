-- Additive, preserves old tokens/payloads/answers. Old callers remain compatible;
-- newly staged or explicitly revised conversation proposals require hash/revision.
ALTER TABLE memory_confirmations ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1);
ALTER TABLE memory_confirmations ADD COLUMN candidate_hash TEXT;
ALTER TABLE memory_confirmations ADD COLUMN managed_review INTEGER NOT NULL DEFAULT 0 CHECK(managed_review IN (0,1));
ALTER TABLE memory_confirmations ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'pending'
  CHECK(lifecycle_state IN ('pending','processing','saved','declined','consumed','superseded','cancelled'));
ALTER TABLE memory_confirmations ADD COLUMN previous_confirmation_id TEXT;
ALTER TABLE memory_confirmations ADD COLUMN superseded_by TEXT;
ALTER TABLE memory_confirmations ADD COLUMN lifecycle_updated_at INTEGER;
ALTER TABLE memory_confirmations ADD COLUMN cancellation_reason TEXT;
UPDATE memory_confirmations SET candidate_hash = CASE WHEN json_valid(payload_json)
  THEN json_extract(payload_json, '$.review_context.candidate_hash') ELSE NULL END,
  lifecycle_updated_at = created_at,
  lifecycle_state = CASE
    WHEN EXISTS(SELECT 1 FROM memory_confirmation_reviews r WHERE r.confirmation_id=memory_confirmations.id AND r.save_state='saved') THEN 'saved'
    WHEN EXISTS(SELECT 1 FROM memory_confirmation_reviews r WHERE r.confirmation_id=memory_confirmations.id AND r.save_state='not_requested') THEN 'declined'
    WHEN EXISTS(SELECT 1 FROM memory_confirmation_reviews r WHERE r.confirmation_id=memory_confirmations.id AND r.save_state IN ('processing','failed')) THEN 'processing'
    WHEN consumed_at IS NOT NULL THEN 'consumed' ELSE 'pending' END;
CREATE INDEX idx_memory_confirmation_predecessor ON memory_confirmations(tenant_id, previous_confirmation_id);
CREATE UNIQUE INDEX idx_memory_confirmation_single_successor ON memory_confirmations(previous_confirmation_id)
  WHERE previous_confirmation_id IS NOT NULL;
