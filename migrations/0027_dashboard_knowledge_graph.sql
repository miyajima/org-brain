CREATE INDEX IF NOT EXISTS idx_memories_dashboard_root
ON memories(tenant_id, root_memory_id, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_decision_memories_dashboard_supersession
ON decision_memories(tenant_id, superseded_by, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_memory_edges_dashboard_relation
ON memory_edges(tenant_id, relation, from_memory_id, to_memory_id);
