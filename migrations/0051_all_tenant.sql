-- Stop on a pre-existing tenant named all. Publishing its data requires explicit review.
CREATE TABLE all_tenant_migration_guard (existing_rows INTEGER CHECK (existing_rows = 0));
INSERT INTO all_tenant_migration_guard
SELECT EXISTS (SELECT 1 FROM organizations WHERE tenant_id = 'all')
    OR EXISTS (SELECT 1 FROM user_profiles WHERE tenant_id = 'all')
    OR EXISTS (SELECT 1 FROM memories WHERE tenant_id = 'all')
    OR EXISTS (SELECT 1 FROM decision_memories WHERE tenant_id = 'all')
    OR EXISTS (SELECT 1 FROM knowledge_docs WHERE tenant_id = 'all');
DROP TABLE all_tenant_migration_guard;

ALTER TABLE memory_usage_items ADD COLUMN source_tenant_id TEXT;

-- This index contains only the shared corpus. Ordinary writes do not index into it.
CREATE VIRTUAL TABLE all_knowledge_fts USING fts5(kind, source_id UNINDEXED, title, content);

CREATE TRIGGER all_memories_insert AFTER INSERT ON memories
WHEN NEW.tenant_id = 'all' BEGIN
  INSERT INTO all_knowledge_fts(rowid, kind, source_id, title, content)
  SELECT NEW.rowid * 3 + 0, 'memory', NEW.id, NEW.summary, NEW.content || ' ' || COALESCE(NEW.tags_json, '')
  WHERE NEW.tenant_id = 'all';
END;
CREATE TRIGGER all_memories_update AFTER UPDATE OF summary, content, tags_json, tenant_id ON memories
WHEN OLD.tenant_id = 'all' OR NEW.tenant_id = 'all' BEGIN
  DELETE FROM all_knowledge_fts WHERE rowid = OLD.rowid * 3 + 0 AND OLD.tenant_id = 'all';
  INSERT INTO all_knowledge_fts(rowid, kind, source_id, title, content)
  SELECT NEW.rowid * 3 + 0, 'memory', NEW.id, NEW.summary, NEW.content || ' ' || COALESCE(NEW.tags_json, '')
  WHERE NEW.tenant_id = 'all';
END;
CREATE TRIGGER all_memories_delete AFTER DELETE ON memories
WHEN OLD.tenant_id = 'all' BEGIN
  DELETE FROM all_knowledge_fts WHERE rowid = OLD.rowid * 3 + 0 AND OLD.tenant_id = 'all';
END;

CREATE TRIGGER all_decision_memories_insert AFTER INSERT ON decision_memories
WHEN NEW.tenant_id = 'all' BEGIN
  INSERT INTO all_knowledge_fts(rowid, kind, source_id, title, content)
  SELECT NEW.rowid * 3 + 1, 'decision_memory', NEW.id, NEW.title, NEW.decision || ' ' || NEW.rationale
  WHERE NEW.tenant_id = 'all';
END;
CREATE TRIGGER all_decision_memories_update AFTER UPDATE OF title, decision, rationale, tenant_id ON decision_memories
WHEN OLD.tenant_id = 'all' OR NEW.tenant_id = 'all' BEGIN
  DELETE FROM all_knowledge_fts WHERE rowid = OLD.rowid * 3 + 1 AND OLD.tenant_id = 'all';
  INSERT INTO all_knowledge_fts(rowid, kind, source_id, title, content)
  SELECT NEW.rowid * 3 + 1, 'decision_memory', NEW.id, NEW.title, NEW.decision || ' ' || NEW.rationale
  WHERE NEW.tenant_id = 'all';
END;
CREATE TRIGGER all_decision_memories_delete AFTER DELETE ON decision_memories
WHEN OLD.tenant_id = 'all' BEGIN
  DELETE FROM all_knowledge_fts WHERE rowid = OLD.rowid * 3 + 1 AND OLD.tenant_id = 'all';
END;

CREATE TRIGGER all_knowledge_docs_insert AFTER INSERT ON knowledge_docs
WHEN NEW.tenant_id = 'all' BEGIN
  INSERT INTO all_knowledge_fts(rowid, kind, source_id, title, content)
  SELECT NEW.rowid * 3 + 2, 'doc', NEW.id, NEW.title, COALESCE(NEW.summary, '') || ' ' || COALESCE(NEW.body_text, '') || ' ' || COALESCE(NEW.tags, '')
  WHERE NEW.tenant_id = 'all';
END;
CREATE TRIGGER all_knowledge_docs_update AFTER UPDATE OF title, summary, body_text, tags, tenant_id ON knowledge_docs
WHEN OLD.tenant_id = 'all' OR NEW.tenant_id = 'all' BEGIN
  DELETE FROM all_knowledge_fts WHERE rowid = OLD.rowid * 3 + 2 AND OLD.tenant_id = 'all';
  INSERT INTO all_knowledge_fts(rowid, kind, source_id, title, content)
  SELECT NEW.rowid * 3 + 2, 'doc', NEW.id, NEW.title, COALESCE(NEW.summary, '') || ' ' || COALESCE(NEW.body_text, '') || ' ' || COALESCE(NEW.tags, '')
  WHERE NEW.tenant_id = 'all';
END;
CREATE TRIGGER all_knowledge_docs_delete AFTER DELETE ON knowledge_docs
WHEN OLD.tenant_id = 'all' BEGIN
  DELETE FROM all_knowledge_fts WHERE rowid = OLD.rowid * 3 + 2 AND OLD.tenant_id = 'all';
END;
