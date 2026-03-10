ALTER TABLE memories ADD COLUMN source TEXT NOT NULL DEFAULT 'org-brain';
ALTER TABLE memories ADD COLUMN external_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_external_key
ON memories(tenant_id, external_key)
WHERE external_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memories_source_created
ON memories(tenant_id, source, created_at DESC);
