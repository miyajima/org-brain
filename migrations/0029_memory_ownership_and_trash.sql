-- Ownership and reversible trash for the memory management workspace.
-- Existing records are intentionally left nullable: production data must not
-- infer a human owner from an agent or service actor.
ALTER TABLE memories ADD COLUMN owner_principal TEXT;
ALTER TABLE memories ADD COLUMN created_by_principal TEXT;
ALTER TABLE memories ADD COLUMN deleted_at INTEGER;
ALTER TABLE memories ADD COLUMN deleted_by_principal TEXT;
ALTER TABLE memories ADD COLUMN delete_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_memories_owner_lifecycle
ON memories(tenant_id, owner_principal, deleted_at, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_memories_creator
ON memories(tenant_id, created_by_principal, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memories_deleted
ON memories(tenant_id, deleted_at DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS principal_owner_mappings (
  tenant_id TEXT NOT NULL,
  producer_principal TEXT NOT NULL,
  owner_principal TEXT NOT NULL,
  created_by_principal TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, producer_principal)
);

CREATE INDEX IF NOT EXISTS idx_principal_owner_mappings_owner
ON principal_owner_mappings(tenant_id, owner_principal);
