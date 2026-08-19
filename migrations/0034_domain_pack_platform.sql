CREATE TABLE IF NOT EXISTS domain_pack_releases (
  id TEXT PRIMARY KEY,
  owner_tenant_id TEXT,
  pack_id TEXT NOT NULL,
  version TEXT NOT NULL,
  classification TEXT NOT NULL CHECK(classification IN ('function', 'industry_overlay', 'organization_overlay')),
  visibility TEXT NOT NULL CHECK(visibility IN ('first_party', 'private', 'unlisted')),
  manifest_digest TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  publisher_id TEXT NOT NULL,
  license_id TEXT NOT NULL,
  archive_json TEXT,
  signature_json TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'revoked')),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_reason TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_pack_release_identity
  ON domain_pack_releases(COALESCE(owner_tenant_id, ''), pack_id, version);
CREATE INDEX IF NOT EXISTS idx_domain_pack_release_catalog
  ON domain_pack_releases(owner_tenant_id, visibility, status, pack_id, created_at DESC);

CREATE TABLE IF NOT EXISTS domain_pack_installations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  release_id TEXT NOT NULL REFERENCES domain_pack_releases(id),
  pack_id TEXT NOT NULL,
  version TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('installed', 'uninstalled')),
  installed_by TEXT NOT NULL,
  installed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  uninstalled_at INTEGER,
  previous_installation_id TEXT,
  UNIQUE(tenant_id, pack_id, manifest_digest)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_pack_active_installation
  ON domain_pack_installations(tenant_id, pack_id) WHERE state = 'installed';

CREATE TABLE IF NOT EXISTS domain_pack_install_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  installation_id TEXT NOT NULL REFERENCES domain_pack_installations(id),
  item_type TEXT NOT NULL CHECK(item_type IN ('managed_object_type', 'metric_definition', 'dashboard', 'asset', 'loadout')),
  item_key TEXT NOT NULL,
  entity_id TEXT,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE(installation_id, item_type, item_key)
);

CREATE TABLE IF NOT EXISTS managed_object_types (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  type_key TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  attribute_schema_json TEXT NOT NULL DEFAULT '{}',
  allowed_relations_json TEXT NOT NULL DEFAULT '[]',
  origin_type TEXT NOT NULL CHECK(origin_type IN ('pack', 'custom')),
  origin_pack_id TEXT,
  origin_pack_version TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id, type_key)
);

CREATE TABLE IF NOT EXISTS managed_objects (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  object_type_id TEXT NOT NULL REFERENCES managed_object_types(id),
  object_key TEXT NOT NULL,
  name TEXT NOT NULL,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  visibility TEXT NOT NULL DEFAULT 'tenant' CHECK(visibility IN ('tenant', 'project', 'restricted')),
  owner_principal TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id, object_type_id, object_key)
);

CREATE TABLE IF NOT EXISTS managed_object_relations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  source_object_id TEXT NOT NULL REFERENCES managed_objects(id),
  relation_type TEXT NOT NULL,
  target_object_id TEXT NOT NULL REFERENCES managed_objects(id),
  attributes_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(tenant_id, source_object_id, relation_type, target_object_id)
);

CREATE TABLE IF NOT EXISTS managed_object_external_refs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  managed_object_id TEXT NOT NULL REFERENCES managed_objects(id),
  adapter_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  url TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE(tenant_id, adapter_id, external_id)
);

CREATE TABLE IF NOT EXISTS metric_definitions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  metric_key TEXT NOT NULL,
  current_version INTEGER NOT NULL,
  origin_type TEXT NOT NULL CHECK(origin_type IN ('pack', 'custom')),
  origin_pack_id TEXT,
  origin_pack_version TEXT,
  promoted_release_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id, metric_key)
);

CREATE TABLE IF NOT EXISTS metric_definition_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  metric_definition_id TEXT NOT NULL REFERENCES metric_definitions(id),
  version INTEGER NOT NULL,
  definition_json TEXT NOT NULL,
  definition_digest TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(metric_definition_id, version)
);

CREATE TABLE IF NOT EXISTS metric_bindings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  metric_definition_id TEXT NOT NULL REFERENCES metric_definitions(id),
  scope_type TEXT NOT NULL CHECK(scope_type IN ('tenant', 'project', 'managed_object')),
  scope_id TEXT,
  dimensions_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(tenant_id, metric_definition_id, scope_type, scope_id, dimensions_json)
);

CREATE TABLE IF NOT EXISTS metric_targets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  metric_definition_id TEXT NOT NULL REFERENCES metric_definitions(id),
  binding_id TEXT REFERENCES metric_bindings(id),
  target_value REAL,
  target_min REAL,
  target_max REAL,
  direction TEXT NOT NULL CHECK(direction IN ('increase', 'decrease', 'range', 'maintain')),
  effective_from INTEGER NOT NULL,
  effective_to INTEGER,
  reason TEXT,
  set_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS metric_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  metric_definition_id TEXT NOT NULL REFERENCES metric_definitions(id),
  binding_id TEXT REFERENCES metric_bindings(id),
  value REAL,
  state TEXT NOT NULL CHECK(state IN ('measured', 'unknown', 'stale')),
  dimensions_json TEXT NOT NULL DEFAULT '{}',
  observed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  evidence_ref TEXT,
  query_digest TEXT,
  idempotency_key TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK((state = 'measured' AND value IS NOT NULL) OR (state IN ('unknown', 'stale') AND value IS NULL)),
  UNIQUE(tenant_id, metric_definition_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_metric_snapshots_query
  ON metric_snapshots(tenant_id, metric_definition_id, binding_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS domain_dashboards (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  dashboard_key TEXT NOT NULL,
  title TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  origin_type TEXT NOT NULL CHECK(origin_type IN ('pack', 'custom')),
  origin_pack_id TEXT,
  origin_pack_version TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id, dashboard_key)
);

CREATE TABLE IF NOT EXISTS dashboard_metric_widgets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  dashboard_id TEXT NOT NULL REFERENCES domain_dashboards(id),
  widget_key TEXT NOT NULL,
  metric_definition_id TEXT REFERENCES metric_definitions(id),
  widget_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(dashboard_id, widget_key)
);
