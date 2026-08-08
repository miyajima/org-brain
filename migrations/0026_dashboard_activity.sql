-- Add authenticated actor attribution for dashboard activity. Historical rows
-- intentionally remain NULL and are displayed as System / Unknown.
ALTER TABLE memory_usage_events ADD COLUMN actor_principal TEXT;
ALTER TABLE tasks ADD COLUMN created_by_principal TEXT;

CREATE INDEX IF NOT EXISTS idx_memory_usage_events_dashboard
ON memory_usage_events(tenant_id, project_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_memory_usage_events_actor
ON memory_usage_events(tenant_id, actor_principal, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_tasks_dashboard
ON tasks(tenant_id, project_id, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_task_events_dashboard
ON task_events(tenant_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_memory_versions_dashboard
ON memory_versions(tenant_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_decision_memory_versions_dashboard
ON decision_memory_versions(tenant_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_agent_messages_dashboard
ON agent_messages(tenant_id, created_at DESC, id DESC);
