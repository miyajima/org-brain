CREATE TABLE IF NOT EXISTS knowledge_pack_goal_links (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  onboarding_id TEXT REFERENCES knowledge_pack_onboarding_sessions(id),
  knowledge_pack_installation_id TEXT NOT NULL REFERENCES domain_pack_installations(id),
  template_pack_id TEXT NOT NULL,
  metric_definition_id TEXT NOT NULL REFERENCES metric_definitions(id),
  metric_binding_id TEXT REFERENCES metric_bindings(id),
  metric_target_id TEXT NOT NULL REFERENCES metric_targets(id),
  metric_source_binding_id TEXT REFERENCES metric_source_bindings(id),
  metric_key TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK(scope_type IN ('tenant', 'project')),
  scope_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(tenant_id, knowledge_pack_installation_id, metric_key)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_pack_goal_links_dashboard
  ON knowledge_pack_goal_links(tenant_id, knowledge_pack_installation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_pack_goal_reconciliations (
  onboarding_id TEXT PRIMARY KEY REFERENCES knowledge_pack_onboarding_sessions(id),
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('clean', 'error')),
  expected_count INTEGER NOT NULL,
  linked_count INTEGER NOT NULL,
  error_code TEXT,
  reconciled_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS metric_source_import_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  source_binding_id TEXT NOT NULL REFERENCES metric_source_bindings(id),
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'succeeded', 'failed')),
  attempt INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  snapshot_id TEXT REFERENCES metric_snapshots(id),
  queued_at INTEGER NOT NULL,
  started_at INTEGER,
  lease_expires_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_metric_source_import_runs_binding
  ON metric_source_import_runs(tenant_id, source_binding_id, queued_at DESC);

CREATE TABLE IF NOT EXISTS retrospective_schedules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  cadence_days INTEGER NOT NULL CHECK(cadence_days IN (7, 14)),
  status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'archived')),
  next_run_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS retrospective_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  schedule_id TEXT REFERENCES retrospective_schedules(id),
  status TEXT NOT NULL CHECK(status IN ('open', 'closed', 'cancelled')),
  title TEXT NOT NULL,
  created_by TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  cancelled_at INTEGER,
  close_idempotency_key TEXT,
  close_request_digest TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS retrospective_participants (
  session_id TEXT NOT NULL REFERENCES retrospective_sessions(id),
  tenant_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(session_id, principal)
);

CREATE TABLE IF NOT EXISTS retrospective_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES retrospective_sessions(id),
  ordinal INTEGER NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('decision_memory', 'decision_rationale', 'projected_rule')),
  source_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  title TEXT NOT NULL,
  statement TEXT NOT NULL,
  rationale TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  UNIQUE(session_id, source_type, source_id)
);

CREATE TABLE IF NOT EXISTS retrospective_item_viewers (
  item_id TEXT NOT NULL REFERENCES retrospective_items(id),
  tenant_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  viewed_at INTEGER NOT NULL,
  PRIMARY KEY(item_id, principal)
);

CREATE TABLE IF NOT EXISTS retrospective_responses (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES retrospective_sessions(id),
  item_id TEXT NOT NULL REFERENCES retrospective_items(id),
  principal TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('adopt', 'do_not_adopt', 'defer')),
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(session_id, item_id, principal)
);

CREATE TABLE IF NOT EXISTS retrospective_results (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES retrospective_sessions(id),
  item_id TEXT NOT NULL REFERENCES retrospective_items(id),
  decision TEXT NOT NULL CHECK(decision IN ('adopted', 'not_adopted', 'deferred')),
  source_digest TEXT NOT NULL,
  finalized_by TEXT NOT NULL,
  finalized_at INTEGER NOT NULL,
  UNIQUE(session_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_retrospective_sessions_list
  ON retrospective_sessions(tenant_id, status, opened_at DESC);

CREATE TABLE IF NOT EXISTS improvement_actions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  retrospective_session_id TEXT REFERENCES retrospective_sessions(id),
  retrospective_item_id TEXT REFERENCES retrospective_items(id),
  goal_link_id TEXT REFERENCES knowledge_pack_goal_links(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_principal TEXT,
  due_at INTEGER,
  status TEXT NOT NULL CHECK(status IN ('open', 'in_progress', 'awaiting_verification', 'completed', 'cancelled')),
  external_issue_url TEXT,
  implementation_completed_at INTEGER,
  baseline_snapshot_id TEXT REFERENCES metric_snapshots(id),
  verification_snapshot_id TEXT REFERENCES metric_snapshots(id),
  target_snapshot_json TEXT,
  comparator_version TEXT,
  verification_outcome TEXT CHECK(verification_outcome IS NULL OR verification_outcome IN ('improved', 'unchanged', 'regressed')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_improvement_actions_list
  ON improvement_actions(tenant_id, status, due_at, created_at DESC);

-- Forward-only compatibility for Knowledge Packs completed before this
-- measurement loop shipped. It links canonical targets and bindings without
-- copying values into a dashboard-specific table.
INSERT OR IGNORE INTO knowledge_pack_goal_links(
  id, tenant_id, onboarding_id, knowledge_pack_installation_id, template_pack_id,
  metric_definition_id, metric_binding_id, metric_target_id, metric_source_binding_id,
  metric_key, scope_type, scope_id, created_at
)
SELECT
  'kp-goal-backfill:' || s.id || ':' || json_extract(target.value, '$.metric_key'),
  s.tenant_id,
  s.id,
  json_extract(s.completion_json, '$.knowledge_pack.installation_id'),
  json_extract(s.answers_json, '$.template.pack_ids[0]'),
  d.id,
  (
    SELECT b.id FROM metric_bindings b
    WHERE b.tenant_id = s.tenant_id AND b.metric_definition_id = d.id
      AND b.scope_type = CASE WHEN s.project_id IS NULL THEN 'tenant' ELSE 'project' END
      AND b.scope_id IS s.project_id
    ORDER BY b.created_at DESC LIMIT 1
  ),
  json_extract(target.value, '$.target_id'),
  (
    SELECT json_extract(source.value, '$.source_binding_id')
    FROM json_each(s.completion_json, '$.sources') source
    WHERE json_extract(source.value, '$.metric_key') = json_extract(target.value, '$.metric_key')
    LIMIT 1
  ),
  json_extract(target.value, '$.metric_key'),
  CASE WHEN s.project_id IS NULL THEN 'tenant' ELSE 'project' END,
  s.project_id,
  COALESCE(s.completed_at, s.updated_at)
FROM knowledge_pack_onboarding_sessions s
JOIN json_each(s.completion_json, '$.targets') target
JOIN metric_definitions d
  ON d.tenant_id = s.tenant_id
 AND d.metric_key = json_extract(target.value, '$.metric_key')
WHERE s.state = 'completed'
  AND s.completion_json IS NOT NULL
  AND json_extract(s.completion_json, '$.knowledge_pack.installation_id') IS NOT NULL
  AND EXISTS(
    SELECT 1 FROM domain_pack_installations installation
    WHERE installation.id=json_extract(s.completion_json, '$.knowledge_pack.installation_id')
      AND installation.tenant_id=s.tenant_id
      AND installation.pack_id=json_extract(s.completion_json, '$.knowledge_pack.pack_id')
      AND installation.release_id=json_extract(s.completion_json, '$.knowledge_pack.release_id')
      AND installation.state='installed'
  )
  AND EXISTS(
    SELECT 1 FROM metric_targets target_row
    WHERE target_row.id=json_extract(target.value, '$.target_id')
      AND target_row.tenant_id=s.tenant_id
      AND target_row.metric_definition_id=d.id
      AND (
        (s.project_id IS NULL AND target_row.binding_id IS NULL)
        OR EXISTS(
          SELECT 1 FROM metric_bindings binding_row
          WHERE binding_row.id=target_row.binding_id
            AND binding_row.tenant_id=s.tenant_id
            AND binding_row.metric_definition_id=d.id
            AND binding_row.scope_type='project'
            AND binding_row.scope_id=s.project_id
            AND binding_row.dimensions_json='{}'
        )
      )
  )
  AND (
    (SELECT json_extract(source.value, '$.source_binding_id')
     FROM json_each(s.completion_json, '$.sources') source
     WHERE json_extract(source.value, '$.metric_key')=json_extract(target.value, '$.metric_key') LIMIT 1) IS NULL
    OR EXISTS(
      SELECT 1 FROM metric_source_bindings source_row
      WHERE source_row.id=(
        SELECT json_extract(source.value, '$.source_binding_id')
        FROM json_each(s.completion_json, '$.sources') source
        WHERE json_extract(source.value, '$.metric_key')=json_extract(target.value, '$.metric_key') LIMIT 1
      )
        AND source_row.tenant_id=s.tenant_id
        AND source_row.metric_definition_id=d.id
    )
  );

INSERT OR REPLACE INTO knowledge_pack_goal_reconciliations(
  onboarding_id, tenant_id, status, expected_count, linked_count, error_code, reconciled_at
)
SELECT
  s.id,
  s.tenant_id,
  CASE
    WHEN json_array_length(json_extract(s.completion_json, '$.targets')) > 0
     AND COUNT(l.id) = json_array_length(json_extract(s.completion_json, '$.targets'))
    THEN 'clean' ELSE 'error'
  END,
  COALESCE(json_array_length(json_extract(s.completion_json, '$.targets')), 0),
  COUNT(l.id),
  CASE
    WHEN json_array_length(json_extract(s.completion_json, '$.targets')) > 0
     AND COUNT(l.id) = json_array_length(json_extract(s.completion_json, '$.targets'))
    THEN NULL ELSE 'goal_link_reconciliation_incomplete'
  END,
  CAST(strftime('%s','now') AS INTEGER) * 1000
FROM knowledge_pack_onboarding_sessions s
LEFT JOIN knowledge_pack_goal_links l
  ON l.tenant_id=s.tenant_id AND l.onboarding_id=s.id
WHERE s.state='completed'
GROUP BY s.id, s.tenant_id, s.completion_json;

-- Do not expose a partially reconstructed Knowledge Pack. Operators can inspect
-- the reconciliation row, correct the source records, and rerun a controlled
-- reconciliation before enabling the dashboard.
DELETE FROM knowledge_pack_goal_links
WHERE onboarding_id IN (
  SELECT onboarding_id FROM knowledge_pack_goal_reconciliations WHERE status='error'
);
