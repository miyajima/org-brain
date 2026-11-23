-- A shared project index contains only explicitly selected, self-contained entries.
CREATE TABLE project_common_indexes (
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  entries_json TEXT NOT NULL,
  hash TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (tenant_id, project_id)
);

-- A failed guard aborts the complete D1 batch, including every page write.
CREATE TABLE project_index_write_guards (
  id TEXT PRIMARY KEY,
  ok INTEGER NOT NULL CHECK (ok = 1)
);
