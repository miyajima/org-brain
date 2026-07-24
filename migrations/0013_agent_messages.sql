CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  thread_id TEXT NOT NULL,
  reply_to_message_id TEXT,
  sender_principal TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('principal', 'agent', 'project', 'channel')),
  target_key TEXT NOT NULL,
  subject TEXT,
  body TEXT NOT NULL,
  metadata_json TEXT,
  idempotency_key TEXT,
  status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'read', 'acked', 'archived')),
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  acked_at INTEGER,
  archived_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_messages_idem
ON agent_messages(tenant_id, idempotency_key)
WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_messages_inbox
ON agent_messages(tenant_id, target_type, target_key, status, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_messages_thread
ON agent_messages(tenant_id, thread_id, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_messages_project
ON agent_messages(tenant_id, project_id, created_at);
