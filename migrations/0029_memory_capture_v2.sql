ALTER TABLE memories ADD COLUMN reuse_rule TEXT;
ALTER TABLE memory_versions ADD COLUMN reuse_rule TEXT;

ALTER TABLE decision_memories ADD COLUMN origin_memory_id TEXT;
ALTER TABLE decision_memories ADD COLUMN origin_source TEXT;
ALTER TABLE decision_memories ADD COLUMN origin_external_key TEXT;
ALTER TABLE decision_memories ADD COLUMN auto_generated INTEGER NOT NULL DEFAULT 0
  CHECK(auto_generated IN (0, 1));

CREATE UNIQUE INDEX IF NOT EXISTS idx_decision_memories_auto_origin
ON decision_memories(tenant_id, origin_source, origin_external_key)
WHERE auto_generated = 1 AND origin_external_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_decision_memories_origin_memory
ON decision_memories(tenant_id, origin_memory_id)
WHERE origin_memory_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memories_active_canonical_lookup
ON memories(tenant_id, canonical_key, confidence_score DESC, utility_score DESC, updated_at DESC)
WHERE canonical_key IS NOT NULL AND (lifecycle_state IS NULL OR lifecycle_state != 'suppressed');

-- A partial unique index cannot be added until repair has suppressed legacy
-- duplicates. These guards still make every new active write atomic: SQLite
-- serializes the write statement and evaluates the duplicate check inside the
-- same transaction. After repair reaches zero duplicates, the invariant stays
-- true without making this additive migration fail on existing data.
CREATE TRIGGER IF NOT EXISTS memories_active_canonical_insert_guard
BEFORE INSERT ON memories
WHEN NEW.canonical_key IS NOT NULL
  AND COALESCE(NEW.lifecycle_state, 'active') != 'suppressed'
  AND EXISTS (
    SELECT 1
    FROM memories existing
    WHERE existing.tenant_id = NEW.tenant_id
      AND existing.canonical_key = NEW.canonical_key
      AND COALESCE(existing.lifecycle_state, 'active') != 'suppressed'
  )
BEGIN
  SELECT RAISE(ABORT, 'duplicate_canonical_key');
END;

CREATE TRIGGER IF NOT EXISTS memories_active_canonical_update_guard
BEFORE UPDATE OF tenant_id, canonical_key, lifecycle_state ON memories
WHEN NEW.canonical_key IS NOT NULL
  AND COALESCE(NEW.lifecycle_state, 'active') != 'suppressed'
  AND (
    NEW.tenant_id IS NOT OLD.tenant_id
    OR NEW.canonical_key IS NOT OLD.canonical_key
    OR COALESCE(OLD.lifecycle_state, 'active') = 'suppressed'
  )
  AND EXISTS (
    SELECT 1
    FROM memories existing
    WHERE existing.tenant_id = NEW.tenant_id
      AND existing.canonical_key = NEW.canonical_key
      AND existing.id != NEW.id
      AND COALESCE(existing.lifecycle_state, 'active') != 'suppressed'
  )
BEGIN
  SELECT RAISE(ABORT, 'duplicate_canonical_key');
END;

CREATE TABLE IF NOT EXISTS decision_retrieval_projection_backfills (
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL DEFAULT '',
  cursor TEXT NOT NULL DEFAULT '',
  processed_decisions INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'running'
    CHECK(state IN ('running', 'complete', 'failed')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(tenant_id, project_id)
);
