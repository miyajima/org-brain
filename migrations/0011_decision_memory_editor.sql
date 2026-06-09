ALTER TABLE decision_memories ADD COLUMN reviewer_refs_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE decision_memories ADD COLUMN confirmation_state TEXT NOT NULL DEFAULT 'inferred_unconfirmed';
ALTER TABLE decision_memories ADD COLUMN confirmation_note TEXT;
ALTER TABLE decision_memories ADD COLUMN confirmed_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_decision_memories_confirmation
ON decision_memories(tenant_id, confirmation_state, updated_at DESC);

CREATE TABLE IF NOT EXISTS decision_memory_versions (
  id TEXT PRIMARY KEY,
  decision_memory_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  actor_refs_json TEXT NOT NULL DEFAULT '[]',
  reviewer_refs_json TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decision_memory_versions_created
ON decision_memory_versions(tenant_id, decision_memory_id, created_at DESC);

INSERT INTO decision_memory_versions(
  id,
  decision_memory_id,
  tenant_id,
  operation,
  snapshot_json,
  actor_refs_json,
  reviewer_refs_json,
  note,
  created_at
)
SELECT
  'dmver_init_' || id,
  id,
  tenant_id,
  'create',
  json_object(
    'id', id,
    'tenantId', tenant_id,
    'projectId', project_id,
    'domain', domain,
    'title', title,
    'decision', decision,
    'rationale', rationale,
    'rejectedAlternatives', json(rejected_alternatives_json),
    'constraints', json(constraints_json),
    'knownPitfalls', json(known_pitfalls_json),
    'sourceRefs', json(source_refs_json),
    'ownerRefs', json(owner_refs_json),
    'reviewerRefs', json(reviewer_refs_json),
    'validFrom', valid_from,
    'validUntil', valid_until,
    'status', status,
    'supersededBy', superseded_by,
    'confidence', confidence,
    'visibility', visibility,
    'allowedPrincipals', json(allowed_principals_json),
    'confirmationState', confirmation_state,
    'confirmationNote', confirmation_note,
    'confirmedAt', confirmed_at,
    'createdAt', created_at,
    'updatedAt', updated_at
  ),
  owner_refs_json,
  reviewer_refs_json,
  confirmation_note,
  created_at
FROM decision_memories
WHERE NOT EXISTS (
  SELECT 1
  FROM decision_memory_versions version
  WHERE version.tenant_id = decision_memories.tenant_id
    AND version.decision_memory_id = decision_memories.id
);
