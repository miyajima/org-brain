ALTER TABLE retrospective_schedules
  ADD COLUMN participant_group_id TEXT REFERENCES groups(id);

ALTER TABLE retrospective_sessions
  ADD COLUMN participant_group_id TEXT REFERENCES groups(id);

ALTER TABLE retrospective_sessions
  ADD COLUMN participant_count_at_close INTEGER;

ALTER TABLE retrospective_sessions
  ADD COLUMN unanswered_response_count_at_close INTEGER;

ALTER TABLE retrospective_sessions
  ADD COLUMN close_operation_id TEXT;

ALTER TABLE retrospective_items
  ADD COLUMN parent_decision_id TEXT;

ALTER TABLE retrospective_items
  ADD COLUMN source_policy_version INTEGER;

UPDATE retrospective_items
SET parent_decision_id = CASE
  WHEN source_type = 'decision_memory' THEN source_id
  WHEN source_type = 'decision_rationale' THEN (
    SELECT memory_id FROM decision_rationales rationale
    WHERE rationale.tenant_id = retrospective_items.tenant_id
      AND rationale.id = retrospective_items.source_id
  )
  WHEN source_type = 'projected_rule' THEN (
    SELECT decision.id FROM decision_memories decision
    WHERE decision.tenant_id = retrospective_items.tenant_id
      AND retrospective_items.source_id LIKE 'rule:' || decision.id || ':%'
    ORDER BY length(decision.id) DESC LIMIT 1
  )
END;

UPDATE retrospective_items
SET source_policy_version = (
  SELECT policy.policy_version FROM resource_access_policies policy
  WHERE policy.tenant_id = retrospective_items.tenant_id
    AND policy.resource_type = 'decision_memory'
    AND policy.resource_id = retrospective_items.parent_decision_id
);

CREATE TABLE IF NOT EXISTS retrospective_item_eligible_participants (
  tenant_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES retrospective_sessions(id),
  item_id TEXT NOT NULL REFERENCES retrospective_items(id),
  principal TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(item_id, principal)
);

CREATE INDEX IF NOT EXISTS idx_retrospective_eligible_session_principal
  ON retrospective_item_eligible_participants(tenant_id, session_id, principal, item_id);

-- Before this migration, retrospective candidates were restricted to sources
-- readable by every snapshotted participant. The cross product therefore
-- preserves the old eligibility semantics without broadening source access.
INSERT OR IGNORE INTO retrospective_item_eligible_participants(
  tenant_id, session_id, item_id, principal, created_at
)
SELECT i.tenant_id, i.session_id, i.id, p.principal, i.created_at
FROM retrospective_items i
JOIN retrospective_sessions s
  ON s.id = i.session_id AND s.tenant_id = i.tenant_id
JOIN retrospective_participants p
  ON p.session_id = i.session_id AND p.tenant_id = i.tenant_id;

UPDATE retrospective_sessions
SET participant_count_at_close = (
      SELECT COUNT(*)
      FROM retrospective_participants p
      WHERE p.tenant_id = retrospective_sessions.tenant_id
        AND p.session_id = retrospective_sessions.id
    ),
    unanswered_response_count_at_close = (
      SELECT COUNT(*)
      FROM retrospective_item_eligible_participants eligible
      WHERE eligible.tenant_id = retrospective_sessions.tenant_id
        AND eligible.session_id = retrospective_sessions.id
        AND NOT EXISTS (
          SELECT 1
          FROM retrospective_responses response
          WHERE response.tenant_id = eligible.tenant_id
            AND response.session_id = eligible.session_id
            AND response.item_id = eligible.item_id
            AND response.principal = eligible.principal
        )
    )
WHERE status = 'closed';
