-- Autonomous ingestion never waits in a human review queue.  Keep the
-- historical `review` value readable for compatibility, but make newly
-- captured uncertain candidates durable in `quarantine` so the scheduled
-- evaluator can retry them without an operator.
DROP TRIGGER IF EXISTS memory_learning_candidate_verified_requires_consensus;
ALTER TABLE memory_learning_candidates RENAME TO memory_learning_candidates_legacy_autonomy;

CREATE TABLE memory_learning_candidates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  task_key TEXT,
  external_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('review', 'quarantine', 'verified', 'rejected', 'expired')),
  reason_codes_json TEXT NOT NULL DEFAULT '[]',
  prompt_contract_id TEXT,
  prompt_hash TEXT,
  verifier_version TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  UNIQUE(tenant_id, external_key)
);

INSERT INTO memory_learning_candidates(
  id, tenant_id, project_id, task_key, external_key, payload_json, status,
  reason_codes_json, prompt_contract_id, prompt_hash, verifier_version,
  created_at, updated_at, expires_at, reviewed_at
)
SELECT
  id, tenant_id, project_id, task_key, external_key, payload_json, status,
  reason_codes_json, prompt_contract_id, prompt_hash, verifier_version,
  created_at, updated_at, expires_at, reviewed_at
FROM memory_learning_candidates_legacy_autonomy;

DROP TABLE memory_learning_candidates_legacy_autonomy;

CREATE INDEX IF NOT EXISTS idx_memory_learning_candidates_review
  ON memory_learning_candidates(tenant_id, project_id, status, expires_at);

CREATE TRIGGER IF NOT EXISTS memory_learning_candidate_verified_requires_consensus
BEFORE UPDATE OF status ON memory_learning_candidates
WHEN NEW.status = 'verified' AND (
  SELECT COUNT(DISTINCT judge_name)
  FROM memory_learning_judgments
  WHERE tenant_id = NEW.tenant_id
    AND candidate_id = NEW.id
    AND verdict = 'pass'
) <> 3
BEGIN
  SELECT RAISE(ABORT, 'memory_learning_candidate_requires_three_passing_judges');
END;

-- Keep the independent council provenance without retaining model reasoning.
ALTER TABLE memory_learning_judgments ADD COLUMN model_version TEXT;
ALTER TABLE memory_learning_judgments ADD COLUMN candidate_hash TEXT;
ALTER TABLE memory_learning_judgments ADD COLUMN signature TEXT;
ALTER TABLE memory_learning_judgments ADD COLUMN public_key_fingerprint TEXT;
