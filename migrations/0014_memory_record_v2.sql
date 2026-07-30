-- MemoryRecord v2 authoritative fields. Retrieval indexes remain rebuildable
-- projections and must not become an independent source of truth.
ALTER TABLE memories ADD COLUMN entities_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE memories ADD COLUMN source_refs_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE memories ADD COLUMN updated_at INTEGER;
ALTER TABLE memories ADD COLUMN valid_from INTEGER;
ALTER TABLE memories ADD COLUMN valid_until INTEGER;
ALTER TABLE memories ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE memories ADD COLUMN rationale TEXT;
ALTER TABLE memories ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE memories ADD COLUMN conflicts_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE memories ADD COLUMN permissions_json TEXT NOT NULL DEFAULT '[]';

UPDATE memories
SET updated_at = COALESCE(updated_at, revised_at, created_at),
    valid_until = COALESCE(valid_until, expires_at);

ALTER TABLE memory_versions ADD COLUMN snapshot_json TEXT;
ALTER TABLE memory_versions ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_memories_validity
ON memories(tenant_id, lifecycle_state, valid_from, valid_until);

CREATE INDEX IF NOT EXISTS idx_memories_updated
ON memories(tenant_id, project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS memory_deletions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  actor_type TEXT,
  actor_id TEXT,
  deleted_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_deletions_memory
ON memory_deletions(tenant_id, memory_id, deleted_at DESC);
