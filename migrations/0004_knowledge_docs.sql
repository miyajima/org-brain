CREATE TABLE IF NOT EXISTS knowledge_docs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  summary TEXT,
  tags TEXT,
  frontmatter TEXT,
  body_text TEXT,
  artifact_ref TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_docs_slug
ON knowledge_docs(tenant_id, slug);

CREATE INDEX IF NOT EXISTS idx_knowledge_docs_scope
ON knowledge_docs(tenant_id, scope, kind);

CREATE TABLE IF NOT EXISTS knowledge_links (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  from_doc_id TEXT NOT NULL,
  to_doc_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_knowledge_links_from
ON knowledge_links(tenant_id, from_doc_id);

CREATE INDEX IF NOT EXISTS idx_knowledge_links_to
ON knowledge_links(tenant_id, to_doc_id);

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_docs_fts USING fts5(
  doc_id UNINDEXED,
  tenant_id UNINDEXED,
  title,
  summary,
  tags,
  body_text
);
