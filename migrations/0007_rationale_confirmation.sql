CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  aliases_json TEXT,
  external_ref TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entities_tenant_type_name
ON entities(tenant_id, entity_type, canonical_name);

CREATE TABLE IF NOT EXISTS memory_entities (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  role TEXT NOT NULL,
  confidence_score REAL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_entities_lookup
ON memory_entities(tenant_id, entity_id, role, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_entities_memory
ON memory_entities(tenant_id, memory_id, created_at DESC);

CREATE TABLE IF NOT EXISTS decision_rationales (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  project_id TEXT,
  decision_type TEXT NOT NULL,
  conclusion TEXT NOT NULL,
  reason_summary TEXT NOT NULL,
  status TEXT NOT NULL,
  confirmation_state TEXT NOT NULL,
  decider_entity_id TEXT,
  confidence_score REAL,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  superseded_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_decision_rationales_search
ON decision_rationales(tenant_id, project_id, decision_type, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_decision_rationales_memory
ON decision_rationales(tenant_id, memory_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_decision_rationales_confirmation
ON decision_rationales(tenant_id, confirmation_state, created_at DESC);

CREATE TABLE IF NOT EXISTS decision_evidence (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  rationale_id TEXT NOT NULL,
  evidence_type TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  relation TEXT NOT NULL,
  note TEXT,
  weight_score REAL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decision_evidence_rationale
ON decision_evidence(tenant_id, rationale_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_confirmations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  source TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_memory_confirmations_lookup
ON memory_confirmations(tenant_id, expires_at, consumed_at);
