CREATE TABLE team_knowledge_tenants (
  tenant_id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL CHECK(length(company_id) > 0)
);
CREATE INDEX team_knowledge_company ON team_knowledge_tenants(company_id, tenant_id);

CREATE TABLE team_knowledge_roles (
  tenant_id TEXT NOT NULL REFERENCES team_knowledge_tenants(tenant_id),
  principal TEXT NOT NULL,
  rank INTEGER NOT NULL CHECK(rank BETWEEN 1 AND 3),
  PRIMARY KEY (tenant_id, principal)
);
CREATE TABLE team_knowledge_admins (
  company_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES team_knowledge_tenants(tenant_id),
  principal TEXT NOT NULL,
  PRIMARY KEY (company_id, tenant_id, principal)
);

CREATE TABLE team_knowledge_shares (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  source_tenant_id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK(resource_type IN ('memory','decision_memory','knowledge_doc','knowledge_resource')),
  resource_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('role','all')),
  policy_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  minimum_rank INTEGER NOT NULL CHECK(minimum_rank BETWEEN 1 AND 3),
  target_tenants TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(target_tenants)),
  expires_at INTEGER,
  publication_id TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE (source_tenant_id, resource_type, resource_id, kind)
);
CREATE INDEX team_knowledge_shares_company ON team_knowledge_shares(company_id, updated_at DESC, id);

CREATE TRIGGER team_knowledge_policy_changed AFTER UPDATE OF policy_version ON resource_access_policies
WHEN NEW.policy_version != OLD.policy_version
BEGIN
  DELETE FROM team_knowledge_shares WHERE policy_id = OLD.id AND policy_version = OLD.policy_version;
END;

CREATE TRIGGER team_knowledge_policy_deleted AFTER DELETE ON resource_access_policies
BEGIN
  DELETE FROM team_knowledge_shares WHERE policy_id = OLD.id;
END;

CREATE TABLE team_knowledge_publications (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  source_tenant_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  source_revision TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  approved_by TEXT,
  approved_at INTEGER
);
CREATE INDEX team_knowledge_publication_review ON team_knowledge_publications(company_id, approved_at, requested_at DESC);

CREATE TRIGGER team_knowledge_memory_trashed AFTER UPDATE OF deleted_at ON memories
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
BEGIN
  DELETE FROM team_knowledge_shares WHERE source_tenant_id = NEW.tenant_id AND resource_type = 'memory' AND resource_id = NEW.id;
END;

-- One row per shared result actually returned to a viewer, for reuse measurement. share_id has no foreign key so
-- deliveries survive revocation and replacement; the source identity is kept for the same reason. Query text and
-- content are never stored, only a SHA-256 of the trimmed, lowercased query.
CREATE TABLE team_knowledge_deliveries (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  source_tenant_id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK(resource_type IN ('memory','decision_memory','knowledge_doc','knowledge_resource')),
  resource_id TEXT NOT NULL,
  revision TEXT,
  viewer_tenant_id TEXT NOT NULL,
  viewer_principal TEXT NOT NULL,
  access_path TEXT NOT NULL CHECK(access_path IN ('memory_search_api','memory_search_mcp','direct_search')),
  rank INTEGER NOT NULL CHECK(rank >= 1),
  injected_token_estimate INTEGER NOT NULL CHECK(injected_token_estimate >= 0),
  query_hash TEXT NOT NULL CHECK(length(query_hash) = 64),
  created_at INTEGER NOT NULL
);
CREATE INDEX team_knowledge_deliveries_share ON team_knowledge_deliveries(company_id, share_id, created_at DESC);
CREATE INDEX team_knowledge_deliveries_viewer ON team_knowledge_deliveries(viewer_tenant_id, viewer_principal, created_at DESC);
CREATE INDEX team_knowledge_deliveries_source ON team_knowledge_deliveries(source_tenant_id, resource_type, resource_id);

CREATE TRIGGER team_knowledge_memory_deleted AFTER DELETE ON memories
BEGIN
  DELETE FROM team_knowledge_shares WHERE source_tenant_id = OLD.tenant_id AND resource_type = 'memory' AND resource_id = OLD.id;
  DELETE FROM team_knowledge_publications WHERE source_tenant_id = OLD.tenant_id AND resource_type = 'memory' AND resource_id = OLD.id;
  DELETE FROM team_knowledge_deliveries WHERE source_tenant_id = OLD.tenant_id AND resource_type = 'memory' AND resource_id = OLD.id;
END;

CREATE TRIGGER team_knowledge_decision_deleted AFTER DELETE ON decision_memories
BEGIN
  DELETE FROM team_knowledge_shares WHERE source_tenant_id = OLD.tenant_id AND resource_type = 'decision_memory' AND resource_id = OLD.id;
  DELETE FROM team_knowledge_publications WHERE source_tenant_id = OLD.tenant_id AND resource_type = 'decision_memory' AND resource_id = OLD.id;
  DELETE FROM team_knowledge_deliveries WHERE source_tenant_id = OLD.tenant_id AND resource_type = 'decision_memory' AND resource_id = OLD.id;
END;

CREATE TRIGGER team_knowledge_doc_deleted AFTER DELETE ON knowledge_docs
BEGIN
  DELETE FROM team_knowledge_shares WHERE source_tenant_id = OLD.tenant_id AND resource_type = 'knowledge_doc' AND resource_id = OLD.id;
  DELETE FROM team_knowledge_publications WHERE source_tenant_id = OLD.tenant_id AND resource_type = 'knowledge_doc' AND resource_id = OLD.id;
  DELETE FROM team_knowledge_deliveries WHERE source_tenant_id = OLD.tenant_id AND resource_type = 'knowledge_doc' AND resource_id = OLD.id;
END;

CREATE TRIGGER team_knowledge_resource_deleted AFTER DELETE ON knowledge_resources
BEGIN
  DELETE FROM team_knowledge_shares WHERE source_tenant_id = OLD.tenant_id AND resource_type = 'knowledge_resource' AND resource_id = OLD.id;
  DELETE FROM team_knowledge_publications WHERE source_tenant_id = OLD.tenant_id AND resource_type = 'knowledge_resource' AND resource_id = OLD.id;
  DELETE FROM team_knowledge_deliveries WHERE source_tenant_id = OLD.tenant_id AND resource_type = 'knowledge_resource' AND resource_id = OLD.id;
END;

CREATE VIEW team_knowledge_sources AS
SELECT tenant_id, 'memory' AS resource_type, id AS resource_id,
       COALESCE(NULLIF(summary,''), substr(content,1,160)) AS title, content,
       CAST(current_version AS TEXT) AS revision,
       CASE WHEN expires_at IS NULL THEN valid_until WHEN valid_until IS NULL THEN expires_at ELSE MIN(expires_at, valid_until) END AS expires_at,
       valid_from,
       CASE WHEN scope_type = 'user' AND scope_key = owner_principal AND json_array_length(COALESCE(permissions_json,'[]')) = 0 THEN 1 ELSE 0 END AS legacy_private
  FROM memories WHERE lifecycle_state = 'active' AND deleted_at IS NULL
UNION ALL
SELECT tenant_id, 'decision_memory', id, title, decision || char(10) || rationale,
       CAST(updated_at AS TEXT), valid_until, valid_from,
       CASE WHEN visibility = 'restricted' AND json_array_length(allowed_principals_json) = 0 THEN 1 ELSE 0 END
  FROM decision_memories WHERE status = 'active'
UNION ALL
SELECT tenant_id, 'knowledge_doc', id, title, COALESCE(body_text,summary,''),
       CAST(updated_at AS TEXT), NULL, NULL, CASE WHEN visibility = 'restricted' THEN 1 ELSE 0 END
  FROM knowledge_docs WHERE deleted_at IS NULL
UNION ALL
SELECT r.tenant_id, 'knowledge_resource', r.id, r.title, v.extracted_text, v.id, NULL, NULL,
       CASE WHEN r.visibility = 'restricted' AND json_array_length(r.permissions_json) = 0 THEN 1 ELSE 0 END
  FROM knowledge_resources r JOIN knowledge_resource_versions v
    ON v.tenant_id = r.tenant_id AND v.resource_id = r.id AND v.id = r.current_version_id
  WHERE r.lifecycle_state = 'active' AND v.extraction_state = 'ready';

CREATE TABLE team_knowledge_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_tenant_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  version TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('edited','published')),
  created_at INTEGER NOT NULL,
  UNIQUE(source_tenant_id, resource_id, version, kind)
);
CREATE INDEX team_knowledge_event_source ON team_knowledge_events(source_tenant_id, resource_id, kind, id DESC);

CREATE TRIGGER team_knowledge_memory_edited AFTER UPDATE OF current_version ON memories
WHEN NEW.current_version > OLD.current_version AND NEW.lifecycle_state = 'active'
 AND (NEW.content IS NOT OLD.content OR NEW.summary IS NOT OLD.summary
      OR NEW.tags_json IS NOT OLD.tags_json OR NEW.rationale IS NOT OLD.rationale
      OR NEW.reuse_rule IS NOT OLD.reuse_rule)
 AND (EXISTS (SELECT 1 FROM team_knowledge_tenants WHERE tenant_id = NEW.tenant_id))
BEGIN
  INSERT OR IGNORE INTO team_knowledge_events(source_tenant_id, resource_id, version, kind, created_at)
  VALUES(NEW.tenant_id, NEW.id, NEW.current_version, 'edited', unixepoch() * 1000);
END;

CREATE TRIGGER team_knowledge_memory_published AFTER UPDATE OF approved_at ON team_knowledge_publications
WHEN OLD.approved_at IS NULL AND NEW.approved_at IS NOT NULL AND NEW.resource_type = 'memory'
BEGIN
  INSERT OR IGNORE INTO team_knowledge_events(source_tenant_id, resource_id, version, kind, created_at)
  VALUES(NEW.source_tenant_id, NEW.resource_id, NEW.id, 'published', NEW.approved_at);
END;

CREATE TABLE team_knowledge_watches (
  tenant_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  ref TEXT NOT NULL,
  source_tenant_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK(event_kind IN ('edited','published')),
  after_event INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, principal, ref)
);
CREATE TABLE team_knowledge_receipts (
  tenant_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  event_id INTEGER NOT NULL REFERENCES team_knowledge_events(id),
  PRIMARY KEY(tenant_id, principal, event_id)
);

CREATE TRIGGER team_knowledge_share_revoked AFTER DELETE ON team_knowledge_shares
BEGIN
  DELETE FROM team_knowledge_watches WHERE ref = OLD.id;
END;

CREATE TRIGGER team_knowledge_share_replaced AFTER UPDATE OF id ON team_knowledge_shares
WHEN NEW.id != OLD.id
BEGIN
  DELETE FROM team_knowledge_watches WHERE ref = OLD.id;
END;
