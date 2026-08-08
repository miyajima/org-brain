CREATE INDEX IF NOT EXISTS idx_knowledge_assertions_dashboard
ON knowledge_assertions(tenant_id, project_id, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_knowledge_resource_versions_dashboard
ON knowledge_resource_versions(tenant_id, captured_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_knowledge_resources_dashboard
ON knowledge_resources(tenant_id, project_id, updated_at DESC, id DESC);
