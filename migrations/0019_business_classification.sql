CREATE TABLE IF NOT EXISTS business_categories (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_business_categories_tenant_active
ON business_categories(tenant_id, is_active, label);

ALTER TABLE memories ADD COLUMN business_category_id TEXT;
ALTER TABLE memories ADD COLUMN work_type TEXT
  CHECK(work_type IS NULL OR work_type IN (
    'implementation', 'review', 'debug', 'proposal',
    'support', 'research', 'operations', 'other'
  ));

ALTER TABLE memory_versions ADD COLUMN business_category_id TEXT;
ALTER TABLE memory_versions ADD COLUMN work_type TEXT
  CHECK(work_type IS NULL OR work_type IN (
    'implementation', 'review', 'debug', 'proposal',
    'support', 'research', 'operations', 'other'
  ));

ALTER TABLE decision_memories ADD COLUMN business_category_id TEXT;
ALTER TABLE decision_memories ADD COLUMN work_type TEXT
  CHECK(work_type IS NULL OR work_type IN (
    'implementation', 'review', 'debug', 'proposal',
    'support', 'research', 'operations', 'other'
  ));

ALTER TABLE decision_memory_versions ADD COLUMN business_category_id TEXT;
ALTER TABLE decision_memory_versions ADD COLUMN work_type TEXT
  CHECK(work_type IS NULL OR work_type IN (
    'implementation', 'review', 'debug', 'proposal',
    'support', 'research', 'operations', 'other'
  ));

CREATE INDEX IF NOT EXISTS idx_memories_business_work
ON memories(tenant_id, business_category_id, work_type, lifecycle_state, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_decision_memories_business_work
ON decision_memories(tenant_id, business_category_id, work_type, status, updated_at DESC);
