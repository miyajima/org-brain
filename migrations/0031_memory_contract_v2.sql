CREATE TABLE IF NOT EXISTS task_commitments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  task_key TEXT NOT NULL,
  decision_key TEXT NOT NULL,
  question_fingerprint TEXT NOT NULL,
  question TEXT NOT NULL,
  answer_json TEXT NOT NULL,
  authority TEXT NOT NULL CHECK(authority = 'explicit_user'),
  confirmation_state TEXT NOT NULL CHECK(confirmation_state IN ('user_confirmed', 'user_corrected')),
  ask_policy TEXT NOT NULL CHECK(ask_policy = 'reuse_until_superseded'),
  evidence_type TEXT NOT NULL,
  evidence_digest TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER,
  superseded_at INTEGER,
  UNIQUE(tenant_id, task_key, decision_key, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_commitments_active
  ON task_commitments(tenant_id, task_key, decision_key)
  WHERE superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_task_commitments_context
  ON task_commitments(tenant_id, project_id, task_key, expires_at);

CREATE TABLE IF NOT EXISTS task_commitment_semantic_aliases (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  task_key TEXT NOT NULL,
  decision_key TEXT NOT NULL,
  commitment_id TEXT NOT NULL,
  alias_fingerprint TEXT NOT NULL,
  alias_question TEXT NOT NULL,
  certification TEXT NOT NULL CHECK(certification = 'ai_consensus_certified'),
  prompt_hash TEXT NOT NULL,
  verifier_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE(tenant_id, task_key, decision_key, alias_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_task_commitment_aliases_context
  ON task_commitment_semantic_aliases(tenant_id, project_id, task_key, expires_at);

CREATE TABLE IF NOT EXISTS task_context_checkpoints (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  task_key TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_learning_candidates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  task_key TEXT,
  external_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('review', 'verified', 'rejected', 'expired')),
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

CREATE INDEX IF NOT EXISTS idx_memory_learning_candidates_review
  ON memory_learning_candidates(tenant_id, project_id, status, expires_at);

CREATE TABLE IF NOT EXISTS memory_learning_candidate_evidence (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  evidence_type TEXT NOT NULL,
  evidence_ref TEXT,
  digest TEXT,
  diff_hash TEXT,
  supports_json TEXT NOT NULL DEFAULT '[]',
  verification_state TEXT NOT NULL DEFAULT 'unverified',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_learning_candidate_evidence
  ON memory_learning_candidate_evidence(tenant_id, candidate_id, created_at);

CREATE TABLE IF NOT EXISTS memory_learning_judgments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  judge_name TEXT NOT NULL,
  judge_model TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK(verdict IN ('pass', 'fail', 'disagree', 'error')),
  reason_codes_json TEXT NOT NULL DEFAULT '[]',
  support_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_learning_judgments_candidate
  ON memory_learning_judgments(tenant_id, candidate_id, created_at);

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

CREATE TABLE IF NOT EXISTS memory_quality_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  corpus_id TEXT NOT NULL,
  prompt_contract_id TEXT NOT NULL,
  verifier_version TEXT NOT NULL,
  judge_profile_id TEXT,
  manifest_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running', 'passed', 'failed', 'insufficient_evidence')),
  started_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS memory_quality_measurements (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  axis TEXT NOT NULL,
  cohort TEXT NOT NULL,
  numerator INTEGER NOT NULL,
  denominator INTEGER NOT NULL,
  point_estimate REAL,
  wilson_lower REAL,
  wilson_upper REAL,
  hard_violation_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_quality_measurements_run
  ON memory_quality_measurements(run_id, axis, cohort);
