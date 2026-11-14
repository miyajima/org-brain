-- Private AMP storage. Every primary key includes tenant, authenticated owner and project.
-- Pages use compare-and-swap hashes; source versions are append-only through the API.
CREATE TABLE amp_pages (
  tenant_id TEXT NOT NULL,
  owner_principal TEXT NOT NULL,
  project_id TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  markdown TEXT NOT NULL,
  search_text TEXT NOT NULL,
  hash TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, owner_principal, project_id, path)
);

CREATE TABLE amp_sources (
  tenant_id TEXT NOT NULL,
  owner_principal TEXT NOT NULL,
  project_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  search_text TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, owner_principal, project_id, source_id, version)
);
