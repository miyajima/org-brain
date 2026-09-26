CREATE TABLE IF NOT EXISTS memory_quality_feedback (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  memory_version INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('stale', 'wrong')),
  reason TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  reporter_principal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reported' CHECK(status IN ('reported', 'confirmed', 'rejected')),
  reviewer_principal TEXT,
  reviewed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_quality_feedback_memory
  ON memory_quality_feedback(tenant_id, memory_id, memory_version, status);

CREATE TABLE IF NOT EXISTS memory_integrity_relations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  from_memory_id TEXT NOT NULL,
  from_version INTEGER NOT NULL,
  to_memory_id TEXT NOT NULL,
  to_version INTEGER NOT NULL,
  relation TEXT NOT NULL CHECK(relation IN ('contradicts', 'fixes')),
  evidence_json TEXT NOT NULL,
  proposer_principal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed', 'confirmed', 'rejected', 'resolved')),
  reviewer_principal TEXT,
  reviewed_at INTEGER,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_integrity_relations_pair
  ON memory_integrity_relations(tenant_id, from_memory_id, to_memory_id, status);
