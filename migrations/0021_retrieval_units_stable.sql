CREATE TABLE IF NOT EXISTS retrieval_units (
  id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  source_type TEXT NOT NULL CHECK(source_type IN ('memory', 'decision_memory')),
  source_id TEXT NOT NULL,
  business_category_id TEXT,
  work_type TEXT,
  unit_type TEXT NOT NULL,
  text TEXT NOT NULL,
  speaker TEXT,
  event_at INTEGER,
  valid_from INTEGER,
  valid_until INTEGER,
  source_ref_json TEXT,
  source_span_start INTEGER,
  source_span_end INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  segment_id TEXT,
  content_hash TEXT NOT NULL,
  extractor_name TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  extraction_state TEXT NOT NULL DEFAULT 'degraded',
  degraded_reason TEXT,
  created_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS retrieval_units_fts USING fts5(
  unit_id UNINDEXED,
  generation_id UNINDEXED,
  tenant_id UNINDEXED,
  text,
  tokenize = 'unicode61'
);

CREATE INDEX IF NOT EXISTS idx_retrieval_units_source
ON retrieval_units(generation_id, tenant_id, source_type, source_id, unit_type);

CREATE INDEX IF NOT EXISTS idx_retrieval_units_business_work
ON retrieval_units(generation_id, tenant_id, business_category_id, work_type, unit_type);

CREATE INDEX IF NOT EXISTS idx_retrieval_units_timeline
ON retrieval_units(generation_id, tenant_id, unit_type, event_at DESC);

INSERT OR IGNORE INTO retrieval_units(
  id, generation_id, tenant_id, project_id, source_type, source_id,
  business_category_id, work_type, unit_type, text, speaker, event_at,
  valid_from, valid_until, source_ref_json, source_span_start, source_span_end,
  metadata_json, segment_id, content_hash, extractor_name, extractor_version,
  extraction_state, degraded_reason, created_at
)
SELECT
  'stable_v3_' || u.id, 'gen_baseline_units', u.tenant_id, u.project_id,
  'memory', u.memory_id, m.business_category_id, m.work_type,
  u.unit_type, u.text, u.speaker, u.event_at, u.valid_from, u.valid_until,
  u.source_ref_json, u.source_span_start, u.source_span_end,
  '{}', NULL, u.content_hash, u.extractor, u.extractor_version,
  u.extraction_state, u.degraded_reason, u.created_at
FROM memory_retrieval_units u
JOIN memories m ON m.tenant_id = u.tenant_id AND m.id = u.memory_id;

INSERT OR IGNORE INTO retrieval_units(
  id, generation_id, tenant_id, project_id, source_type, source_id,
  business_category_id, work_type, unit_type, text, speaker, event_at,
  valid_from, valid_until, source_ref_json, source_span_start, source_span_end,
  metadata_json, segment_id, content_hash, extractor_name, extractor_version,
  extraction_state, degraded_reason, created_at
)
SELECT
  'stable_v4_' || u.id, 'gen_structured_context', u.tenant_id, u.project_id,
  'memory', u.memory_id, m.business_category_id, m.work_type,
  u.unit_type, u.text, u.speaker, u.event_at, u.valid_from, u.valid_until,
  u.source_ref_json, u.source_span_start, u.source_span_end,
  u.metadata_json, u.segment_id, u.content_hash, u.extractor, u.extractor_version,
  u.extraction_state, u.degraded_reason, u.created_at
FROM memory_retrieval_units_v4 u
JOIN memories m ON m.tenant_id = u.tenant_id AND m.id = u.memory_id;

INSERT OR IGNORE INTO retrieval_units(
  id, generation_id, tenant_id, project_id, source_type, source_id,
  business_category_id, work_type, unit_type, text, speaker, event_at,
  valid_from, valid_until, source_ref_json, source_span_start, source_span_end,
  metadata_json, segment_id, content_hash, extractor_name, extractor_version,
  extraction_state, degraded_reason, created_at
)
SELECT
  'stable_decision_' || d.id,
  'gen_structured_context', d.tenant_id, d.project_id,
  'decision_memory', d.id, d.business_category_id, d.work_type,
  'decision',
  d.title || char(10) || d.decision || char(10) || d.rationale || char(10) ||
    d.constraints_json || char(10) || d.known_pitfalls_json,
  NULL, d.updated_at, d.valid_from, d.valid_until,
  d.source_refs_json, NULL, NULL,
  json_object(
    'domain', d.domain,
    'status', d.status,
    'confirmation_state', d.confirmation_state,
    'confidence', d.confidence
  ),
  NULL,
  lower(hex(d.id || ':' || d.updated_at)),
  'decision-memory-projector', '1', 'ready', NULL, d.updated_at
FROM decision_memories d;

INSERT OR IGNORE INTO retrieval_units(
  id, generation_id, tenant_id, project_id, source_type, source_id,
  business_category_id, work_type, unit_type, text, speaker, event_at,
  valid_from, valid_until, source_ref_json, source_span_start, source_span_end,
  metadata_json, segment_id, content_hash, extractor_name, extractor_version,
  extraction_state, degraded_reason, created_at
)
SELECT
  'stable_decision_v3_' || d.id,
  'gen_baseline_units', d.tenant_id, d.project_id,
  'decision_memory', d.id, d.business_category_id, d.work_type,
  'decision',
  d.title || char(10) || d.decision || char(10) || d.rationale || char(10) ||
    d.constraints_json || char(10) || d.known_pitfalls_json,
  NULL, d.updated_at, d.valid_from, d.valid_until,
  d.source_refs_json, NULL, NULL,
  json_object(
    'domain', d.domain,
    'status', d.status,
    'confirmation_state', d.confirmation_state,
    'confidence', d.confidence
  ),
  NULL,
  lower(hex(d.id || ':' || d.updated_at)),
  'decision-memory-projector', '1', 'ready', NULL, d.updated_at
FROM decision_memories d;

DELETE FROM retrieval_units_fts;

INSERT INTO retrieval_units_fts(unit_id, generation_id, tenant_id, text)
SELECT id, generation_id, tenant_id, text
FROM retrieval_units;
