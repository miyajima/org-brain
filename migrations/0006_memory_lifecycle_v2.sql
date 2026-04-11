ALTER TABLE memories ADD COLUMN kind TEXT NOT NULL DEFAULT 'episodic';
ALTER TABLE memories ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'active';
ALTER TABLE memories ADD COLUMN scope_type TEXT NOT NULL DEFAULT 'project';
ALTER TABLE memories ADD COLUMN scope_key TEXT;
ALTER TABLE memories ADD COLUMN actor_type TEXT;
ALTER TABLE memories ADD COLUMN actor_id TEXT;
ALTER TABLE memories ADD COLUMN confidence_score REAL;
ALTER TABLE memories ADD COLUMN utility_score REAL;
ALTER TABLE memories ADD COLUMN canonical_key TEXT;
ALTER TABLE memories ADD COLUMN root_memory_id TEXT;
ALTER TABLE memories ADD COLUMN current_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE memories ADD COLUMN last_accessed_at INTEGER;
ALTER TABLE memories ADD COLUMN suppressed_at INTEGER;
ALTER TABLE memories ADD COLUMN consolidated_at INTEGER;
ALTER TABLE memories ADD COLUMN promoted_at INTEGER;
ALTER TABLE memories ADD COLUMN expires_at INTEGER;
ALTER TABLE memories ADD COLUMN revised_at INTEGER;

UPDATE memories
SET kind = CASE
      WHEN tags_json LIKE '%"canonical-memory"%' THEN 'semantic'
      WHEN tags_json LIKE '%"memory-digest"%' THEN 'semantic'
      WHEN tags_json LIKE '%"promoted"%' THEN 'semantic'
      ELSE 'episodic'
    END,
    lifecycle_state = CASE
      WHEN tags_json LIKE '%"compacted"%' THEN 'suppressed'
      ELSE 'active'
    END,
    scope_type = CASE
      WHEN project_id IS NULL THEN 'tenant'
      ELSE 'project'
    END,
    scope_key = CASE
      WHEN project_id IS NULL THEN tenant_id
      ELSE project_id
    END,
    actor_type = COALESCE(actor_type, 'system'),
    actor_id = COALESCE(actor_id, source),
    suppressed_at = CASE
      WHEN tags_json LIKE '%"compacted"%' THEN created_at
      ELSE suppressed_at
    END,
    revised_at = created_at;

CREATE INDEX IF NOT EXISTS idx_memories_lifecycle_created
ON memories(tenant_id, lifecycle_state, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memories_kind_created
ON memories(tenant_id, kind, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memories_scope_created
ON memories(tenant_id, scope_type, scope_key, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_versions (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  operation TEXT NOT NULL,
  content TEXT NOT NULL,
  summary TEXT,
  tags_json TEXT,
  kind TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_key TEXT,
  actor_type TEXT,
  actor_id TEXT,
  confidence_score REAL,
  utility_score REAL,
  canonical_key TEXT,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_versions_identity
ON memory_versions(tenant_id, memory_id, version);

CREATE INDEX IF NOT EXISTS idx_memory_versions_created
ON memory_versions(tenant_id, memory_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_edges (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  from_memory_id TEXT NOT NULL,
  to_memory_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_edges_from
ON memory_edges(tenant_id, from_memory_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_edges_to
ON memory_edges(tenant_id, to_memory_id, created_at DESC);

INSERT INTO memory_versions(
  id,
  memory_id,
  tenant_id,
  version,
  operation,
  content,
  summary,
  tags_json,
  kind,
  lifecycle_state,
  scope_type,
  scope_key,
  actor_type,
  actor_id,
  confidence_score,
  utility_score,
  canonical_key,
  created_at
)
SELECT
  'memver_init_' || id,
  id,
  tenant_id,
  1,
  'capture',
  content,
  summary,
  tags_json,
  kind,
  lifecycle_state,
  scope_type,
  scope_key,
  actor_type,
  actor_id,
  confidence_score,
  utility_score,
  canonical_key,
  created_at
FROM memories
WHERE NOT EXISTS (
  SELECT 1
  FROM memory_versions mv
  WHERE mv.tenant_id = memories.tenant_id
    AND mv.memory_id = memories.id
    AND mv.version = 1
);
