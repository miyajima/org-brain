CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  capability TEXT NOT NULL,
  status TEXT NOT NULL,
  priority INTEGER DEFAULT 0,
  input_ref TEXT,
  output_ref TEXT,
  idempotency_key TEXT,
  trace_id TEXT,
  wait_event_type TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  locked_by TEXT,
  locked_until INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_idem
ON tasks(tenant_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_tasks_status
ON tasks(tenant_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_tasks_cap
ON tasks(tenant_id, capability, status, priority);

CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_events_task
ON task_events(tenant_id, task_id, created_at);

CREATE TABLE IF NOT EXISTS capabilities (
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  input_schema TEXT NOT NULL,
  output_schema TEXT NOT NULL,
  max_concurrency INTEGER DEFAULT 2,
  cost_limit_ms INTEGER DEFAULT 0,
  allowed_tools TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  content TEXT NOT NULL,
  summary TEXT,
  tags_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  memory_id UNINDEXED,
  tenant_id UNINDEXED,
  content
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  title TEXT,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
