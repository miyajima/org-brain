CREATE TABLE IF NOT EXISTS knowledge_pack_onboarding_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  state TEXT NOT NULL DEFAULT 'in_progress'
    CHECK(state IN ('in_progress', 'planned', 'completed')),
  current_step TEXT NOT NULL DEFAULT 'purpose'
    CHECK(current_step IN ('purpose', 'template', 'scope', 'goals', 'data_sources', 'review', 'completed')),
  revision INTEGER NOT NULL DEFAULT 0,
  answers_json TEXT NOT NULL DEFAULT '{}',
  plan_digest TEXT,
  plan_json TEXT,
  completion_json TEXT,
  create_idempotency_key TEXT NOT NULL,
  completion_idempotency_key TEXT,
  completion_claimed_at INTEGER,
  created_by_principal TEXT NOT NULL,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id, create_idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_pack_onboarding_resume
  ON knowledge_pack_onboarding_sessions(
    tenant_id,
    created_by_principal,
    state,
    updated_at DESC
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_pack_onboarding_completion_key
  ON knowledge_pack_onboarding_sessions(tenant_id, completion_idempotency_key)
  WHERE completion_idempotency_key IS NOT NULL;
