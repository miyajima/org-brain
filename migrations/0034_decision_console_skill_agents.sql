CREATE TABLE IF NOT EXISTS resource_access_policies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK(resource_type IN (
    'memory', 'decision_memory', 'decision_rationale', 'knowledge_doc',
    'knowledge_resource', 'skill_asset', 'agent', 'agent_loadout'
  )),
  resource_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('private', 'project', 'group', 'tenant', 'restricted')),
  owner_principal TEXT NOT NULL,
  project_id TEXT,
  group_ids_json TEXT NOT NULL DEFAULT '[]',
  restricted_subjects_json TEXT NOT NULL DEFAULT '[]',
  storage_location TEXT NOT NULL DEFAULT 'd1' CHECK(storage_location IN ('d1', 'd1_r2', 'external')),
  policy_version INTEGER NOT NULL DEFAULT 1,
  created_by_principal TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id, resource_type, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_resource_access_policies_owner
ON resource_access_policies(tenant_id, owner_principal, resource_type, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_resource_access_policies_scope
ON resource_access_policies(tenant_id, scope, project_id, resource_type, updated_at DESC);

CREATE TABLE IF NOT EXISTS access_policy_shadow_diffs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  project_key TEXT NOT NULL DEFAULT '',
  policy_version INTEGER NOT NULL,
  unified_readable INTEGER NOT NULL CHECK(unified_readable IN (0, 1)),
  legacy_readable INTEGER NOT NULL CHECK(legacy_readable IN (0, 1)),
  sample_count INTEGER NOT NULL DEFAULT 1,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  resolved_at INTEGER,
  UNIQUE(tenant_id, resource_type, resource_id, principal, project_key)
);

CREATE INDEX IF NOT EXISTS idx_access_policy_shadow_open
ON access_policy_shadow_diffs(tenant_id, resolved_at, last_seen_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_decision_memories_tenant_id
ON decision_memories(tenant_id, id);

ALTER TABLE knowledge_docs ADD COLUMN project_id TEXT;

CREATE TABLE IF NOT EXISTS skill_assets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'published', 'retired')),
  current_version_id TEXT,
  published_version_id TEXT,
  source_decision_id TEXT,
  owner_principal TEXT NOT NULL,
  valid_until INTEGER,
  generation_task_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER,
  retired_at INTEGER,
  UNIQUE(tenant_id, id),
  UNIQUE(tenant_id, generation_task_id),
  FOREIGN KEY(tenant_id, source_decision_id) REFERENCES decision_memories(tenant_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_assets_name_active
ON skill_assets(tenant_id, COALESCE(project_id, ''), lower(name))
WHERE status <> 'retired';

CREATE INDEX IF NOT EXISTS idx_skill_assets_search
ON skill_assets(tenant_id, project_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS skill_asset_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  skill_asset_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  manifest_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  validation_json TEXT NOT NULL DEFAULT '{}',
  generation_provider TEXT,
  generation_model TEXT,
  generation_prompt_version TEXT,
  source_digest TEXT,
  created_by_principal TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(tenant_id, id),
  UNIQUE(tenant_id, skill_asset_id, version),
  UNIQUE(tenant_id, skill_asset_id, content_hash),
  FOREIGN KEY(tenant_id, skill_asset_id) REFERENCES skill_assets(tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_skill_asset_versions_asset
ON skill_asset_versions(tenant_id, skill_asset_id, version DESC);

CREATE TRIGGER IF NOT EXISTS trg_skill_asset_versions_immutable_update
BEFORE UPDATE ON skill_asset_versions
BEGIN
  SELECT RAISE(ABORT, 'skill_asset_versions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_skill_asset_versions_immutable_delete
BEFORE DELETE ON skill_asset_versions
BEGIN
  SELECT RAISE(ABORT, 'skill_asset_versions are immutable');
END;

CREATE TABLE IF NOT EXISTS skill_asset_files (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  skill_asset_id TEXT NOT NULL,
  skill_asset_version_id TEXT NOT NULL,
  path TEXT NOT NULL,
  media_type TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0 AND size_bytes <= 1048576),
  r2_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(tenant_id, id),
  UNIQUE(tenant_id, skill_asset_version_id, path),
  UNIQUE(tenant_id, r2_key),
  FOREIGN KEY(tenant_id, skill_asset_id) REFERENCES skill_assets(tenant_id, id),
  FOREIGN KEY(tenant_id, skill_asset_version_id) REFERENCES skill_asset_versions(tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_skill_asset_files_version
ON skill_asset_files(tenant_id, skill_asset_version_id, path);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  agent_key TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'retired')),
  current_loadout_id TEXT,
  source_decision_id TEXT,
  owner_principal TEXT NOT NULL,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id, id),
  UNIQUE(tenant_id, agent_key),
  FOREIGN KEY(tenant_id, source_decision_id) REFERENCES decision_memories(tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_agents_project
ON agents(tenant_id, project_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_loadouts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
  owner_principal TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id, id),
  UNIQUE(tenant_id, agent_id, name),
  FOREIGN KEY(tenant_id, agent_id) REFERENCES agents(tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_agent_loadouts_agent
ON agent_loadouts(tenant_id, agent_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_loadout_bindings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  loadout_id TEXT NOT NULL,
  skill_asset_id TEXT NOT NULL,
  usage_mode TEXT NOT NULL CHECK(usage_mode IN ('always', 'auto', 'on_demand')),
  priority INTEGER NOT NULL DEFAULT 50 CHECK(priority >= 0 AND priority <= 100),
  version_policy TEXT NOT NULL CHECK(version_policy IN ('pinned', 'latest_published')),
  pinned_version_id TEXT,
  valid_until INTEGER,
  created_by_principal TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id, id),
  UNIQUE(tenant_id, loadout_id, skill_asset_id),
  FOREIGN KEY(tenant_id, loadout_id) REFERENCES agent_loadouts(tenant_id, id),
  FOREIGN KEY(tenant_id, skill_asset_id) REFERENCES skill_assets(tenant_id, id),
  FOREIGN KEY(tenant_id, pinned_version_id) REFERENCES skill_asset_versions(tenant_id, id),
  CHECK((version_policy = 'pinned' AND pinned_version_id IS NOT NULL) OR
        (version_policy = 'latest_published' AND pinned_version_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_agent_loadout_bindings_resolve
ON agent_loadout_bindings(tenant_id, loadout_id, priority DESC, usage_mode, updated_at DESC);

CREATE TABLE IF NOT EXISTS asset_usage_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  skill_asset_id TEXT NOT NULL,
  skill_asset_version_id TEXT NOT NULL,
  agent_id TEXT,
  agent_key TEXT,
  task_id TEXT,
  event_type TEXT NOT NULL CHECK(event_type IN ('previewed', 'resolved', 'injected', 'listed', 'fetched', 'outcome')),
  outcome TEXT,
  context_tokens INTEGER NOT NULL DEFAULT 0 CHECK(context_tokens >= 0),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE(tenant_id, id),
  FOREIGN KEY(tenant_id, skill_asset_id) REFERENCES skill_assets(tenant_id, id),
  FOREIGN KEY(tenant_id, skill_asset_version_id) REFERENCES skill_asset_versions(tenant_id, id),
  FOREIGN KEY(tenant_id, agent_id) REFERENCES agents(tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_asset_usage_events_asset
ON asset_usage_events(tenant_id, skill_asset_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_asset_usage_events_agent
ON asset_usage_events(tenant_id, agent_key, created_at DESC);

CREATE TABLE IF NOT EXISTS skill_generation_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  skill_asset_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('gemini', 'openai', 'anthropic')),
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_ref TEXT NOT NULL,
  source_refs_json TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  instruction_digest TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'succeeded', 'failed')),
  output_version_id TEXT,
  error_code TEXT,
  error_message TEXT,
  created_by_principal TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id, id),
  UNIQUE(tenant_id, task_id),
  UNIQUE(tenant_id, idempotency_key),
  FOREIGN KEY(tenant_id, skill_asset_id) REFERENCES skill_assets(tenant_id, id),
  FOREIGN KEY(tenant_id, output_version_id) REFERENCES skill_asset_versions(tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_skill_generation_runs_asset
ON skill_generation_runs(tenant_id, skill_asset_id, created_at DESC);

INSERT INTO resource_access_policies(
  id, tenant_id, resource_type, resource_id, scope, owner_principal, project_id,
  group_ids_json, restricted_subjects_json, storage_location, policy_version,
  created_by_principal, created_at, updated_at
)
SELECT
  'rap_decision_' || id,
  tenant_id,
  'decision_memory',
  id,
  CASE
    WHEN visibility = 'project' THEN 'project'
    WHEN visibility = 'restricted' AND json_array_length(CASE WHEN json_valid(decision_memories.allowed_principals_json) THEN decision_memories.allowed_principals_json ELSE '[]' END) > 0 THEN 'restricted'
    WHEN visibility = 'restricted' THEN 'private'
    ELSE 'tenant'
  END,
  COALESCE(NULLIF(json_extract(owner_refs_json, '$[0].id'), ''), 'system:migrated'),
  project_id,
  '[]',
  CASE WHEN visibility = 'restricted' THEN COALESCE((
    SELECT json_group_array(json_object(
      'subject_type', readable_subject.subject_type,
      'subject_id', readable_subject.subject_id
    ))
    FROM (
      SELECT 'principal' AS subject_type, principal.value AS subject_id
      FROM json_each(CASE WHEN json_valid(decision_memories.allowed_principals_json) THEN decision_memories.allowed_principals_json ELSE '[]' END) AS principal
      WHERE principal.type = 'text' AND principal.value <> ''
      UNION
      SELECT acl.subject_type, acl.subject_id
      FROM resource_acl AS acl
      WHERE acl.tenant_id = decision_memories.tenant_id
        AND acl.resource_type = 'decision_memory'
        AND acl.resource_id = decision_memories.id
        AND acl.permission = 'read'
        AND acl.subject_type IN ('principal', 'group')
    ) AS readable_subject
  ), '[]') ELSE '[]' END,
  'd1',
  1,
  COALESCE(NULLIF(json_extract(owner_refs_json, '$[0].id'), ''), 'system:migrated'),
  created_at,
  updated_at
FROM decision_memories
WHERE 1 = 1
ON CONFLICT(tenant_id, resource_type, resource_id) DO NOTHING;

INSERT INTO resource_access_policies(
  id, tenant_id, resource_type, resource_id, scope, owner_principal, project_id,
  group_ids_json, restricted_subjects_json, storage_location, policy_version,
  created_by_principal, created_at, updated_at
)
SELECT
  'rap_doc_' || id,
  tenant_id,
  'knowledge_doc',
  id,
  CASE
    WHEN visibility = 'project' THEN 'project'
    WHEN visibility = 'restricted' AND EXISTS (
      SELECT 1 FROM resource_acl AS acl
      WHERE acl.tenant_id = knowledge_docs.tenant_id
        AND acl.resource_type = 'knowledge_doc'
        AND acl.resource_id = knowledge_docs.id
        AND acl.permission = 'read'
        AND acl.subject_type IN ('principal', 'group')
    ) THEN 'restricted'
    WHEN visibility = 'restricted' THEN 'private'
    ELSE 'tenant'
  END,
  COALESCE(owner_principal, 'system:migrated'),
  project_id,
  CASE WHEN visibility = 'restricted' THEN COALESCE((
    SELECT json_group_array(acl.subject_id)
    FROM resource_acl AS acl
    WHERE acl.tenant_id = knowledge_docs.tenant_id
      AND acl.resource_type = 'knowledge_doc'
      AND acl.resource_id = knowledge_docs.id
      AND acl.permission = 'read'
      AND acl.subject_type = 'group'
  ), '[]') ELSE '[]' END,
  CASE WHEN visibility = 'restricted' THEN COALESCE((
    SELECT json_group_array(json_object(
      'subject_type', acl.subject_type,
      'subject_id', acl.subject_id
    ))
    FROM resource_acl AS acl
    WHERE acl.tenant_id = knowledge_docs.tenant_id
      AND acl.resource_type = 'knowledge_doc'
      AND acl.resource_id = knowledge_docs.id
      AND acl.permission = 'read'
      AND acl.subject_type IN ('principal', 'group')
  ), '[]') ELSE '[]' END,
  'd1',
  1,
  COALESCE(owner_principal, 'system:migrated'),
  created_at,
  updated_at
FROM knowledge_docs
WHERE deleted_at IS NULL
ON CONFLICT(tenant_id, resource_type, resource_id) DO NOTHING;

INSERT INTO resource_access_policies(
  id, tenant_id, resource_type, resource_id, scope, owner_principal, project_id,
  group_ids_json, restricted_subjects_json, storage_location, policy_version,
  created_by_principal, created_at, updated_at
)
SELECT
  'rap_resource_' || id,
  tenant_id,
  'knowledge_resource',
  id,
  CASE
    WHEN visibility = 'project' THEN 'project'
    WHEN visibility = 'restricted' AND (
      json_array_length(CASE WHEN json_valid(knowledge_resources.permissions_json) THEN knowledge_resources.permissions_json ELSE '[]' END) > 0
      OR EXISTS (
        SELECT 1 FROM resource_acl AS acl
        WHERE acl.tenant_id = knowledge_resources.tenant_id
          AND acl.resource_type = 'knowledge_resource'
          AND acl.resource_id = knowledge_resources.id
          AND acl.permission = 'read'
          AND acl.subject_type IN ('principal', 'group')
      )
    ) THEN 'restricted'
    WHEN visibility = 'restricted' THEN 'private'
    ELSE 'tenant'
  END,
  created_by_principal,
  project_id,
  '[]',
  CASE WHEN visibility = 'restricted' THEN COALESCE((
    SELECT json_group_array(json_object(
      'subject_type', readable_subject.subject_type,
      'subject_id', readable_subject.subject_id
    ))
    FROM (
      SELECT 'principal' AS subject_type, principal.value AS subject_id
      FROM json_each(CASE WHEN json_valid(knowledge_resources.permissions_json) THEN knowledge_resources.permissions_json ELSE '[]' END) AS principal
      WHERE principal.type = 'text' AND principal.value <> ''
      UNION
      SELECT acl.subject_type, acl.subject_id
      FROM resource_acl AS acl
      WHERE acl.tenant_id = knowledge_resources.tenant_id
        AND acl.resource_type = 'knowledge_resource'
        AND acl.resource_id = knowledge_resources.id
        AND acl.permission = 'read'
        AND acl.subject_type IN ('principal', 'group')
    ) AS readable_subject
  ), '[]') ELSE '[]' END,
  'd1_r2',
  1,
  created_by_principal,
  created_at,
  updated_at
FROM knowledge_resources
WHERE 1 = 1
ON CONFLICT(tenant_id, resource_type, resource_id) DO NOTHING;

INSERT INTO resource_access_policies(
  id, tenant_id, resource_type, resource_id, scope, owner_principal, project_id,
  group_ids_json, restricted_subjects_json, storage_location, policy_version,
  created_by_principal, created_at, updated_at
)
SELECT
  'rap_memory_' || id,
  tenant_id,
  'memory',
  id,
  CASE
    WHEN scope_type IN ('user', 'agent') THEN 'private'
    WHEN json_array_length(CASE WHEN json_valid(memories.permissions_json) THEN memories.permissions_json ELSE '[]' END) > 0 THEN 'restricted'
    WHEN scope_type = 'project' AND project_id IS NOT NULL THEN 'project'
    ELSE 'tenant'
  END,
  COALESCE(owner_principal, created_by_principal, 'system:migrated'),
  project_id,
  '[]',
  CASE WHEN json_array_length(CASE WHEN json_valid(memories.permissions_json) THEN memories.permissions_json ELSE '[]' END) > 0 THEN COALESCE((
    SELECT json_group_array(json_object(
      'subject_type', json_extract(grant_row.value, '$.principal_type'),
      'subject_id', json_extract(grant_row.value, '$.principal_id')
    ))
    FROM json_each(CASE WHEN json_valid(memories.permissions_json) THEN memories.permissions_json ELSE '[]' END) AS grant_row
    WHERE grant_row.type = 'object'
      AND json_extract(grant_row.value, '$.principal_type') IN ('principal', 'group')
      AND NULLIF(json_extract(grant_row.value, '$.principal_id'), '') IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM json_each(COALESCE(json_extract(grant_row.value, '$.permissions'), '[]')) AS permission
        WHERE permission.value = 'read'
      )
  ), '[]') ELSE '[]' END,
  'd1',
  1,
  COALESCE(created_by_principal, owner_principal, 'system:migrated'),
  created_at,
  COALESCE(updated_at, created_at)
FROM memories
WHERE deleted_at IS NULL
ON CONFLICT(tenant_id, resource_type, resource_id) DO NOTHING;

INSERT INTO capabilities(
  tenant_id, name, version, input_schema, output_schema,
  max_concurrency, cost_limit_ms, allowed_tools, updated_at
)
VALUES(
  'default',
  'skill_generation',
  1,
  '{"type":"object","required":["input_ref"],"properties":{"input_ref":{"type":"string"}}}',
  '{"type":"object","required":["output_ref"],"properties":{"output_ref":{"type":"string"}}}',
  2,
  120000,
  '["selected_decisions.read","selected_resources.read","provider.generate","r2.write"]',
  unixepoch('now') * 1000
)
ON CONFLICT(tenant_id, name) DO UPDATE SET
  version = excluded.version,
  input_schema = excluded.input_schema,
  output_schema = excluded.output_schema,
  max_concurrency = excluded.max_concurrency,
  cost_limit_ms = excluded.cost_limit_ms,
  allowed_tools = excluded.allowed_tools,
  updated_at = excluded.updated_at;
