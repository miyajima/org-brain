-- Cloud source invalidation. Local equivalents are installed by local-memory-use.mjs.
CREATE TRIGGER IF NOT EXISTS cloud_use_task_event_deleted AFTER DELETE ON task_events BEGIN
 UPDATE memory_use_contexts SET revoked_at=unixepoch()*1000 WHERE tenant_id=OLD.tenant_id AND id IN(SELECT context_id FROM memory_use_evidence WHERE tenant_id=OLD.tenant_id AND ref_type='task_event' AND ref_id=OLD.id);
END;
CREATE TRIGGER IF NOT EXISTS cloud_use_task_event_changed AFTER UPDATE OF payload ON task_events BEGIN
 UPDATE memory_use_contexts SET revoked_at=unixepoch()*1000 WHERE tenant_id=NEW.tenant_id AND id IN(SELECT context_id FROM memory_use_evidence WHERE tenant_id=NEW.tenant_id AND ref_type='task_event' AND ref_id=NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS cloud_use_decision_deleted AFTER DELETE ON decision_memories BEGIN
 UPDATE memory_use_contexts SET revoked_at=unixepoch()*1000 WHERE tenant_id=OLD.tenant_id AND source_type='decision_memory' AND source_id=OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS cloud_use_decision_changed AFTER UPDATE ON decision_memories BEGIN
 DELETE FROM memory_use_statistics WHERE tenant_id=NEW.tenant_id AND source_type='decision_memory' AND source_id=NEW.id;
 DELETE FROM memory_use_context_fts WHERE context_id IN(SELECT id FROM memory_use_contexts WHERE tenant_id=NEW.tenant_id AND source_type='decision_memory' AND source_id=NEW.id);
END;
-- Evidence-backed use history; default-off and additive.

CREATE TABLE IF NOT EXISTS memory_use_contexts (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, usage_item_id TEXT NOT NULL,
 source_type TEXT NOT NULL, source_id TEXT NOT NULL, source_version INTEGER,
 project_id TEXT NOT NULL, task_id TEXT NOT NULL, work_type TEXT NOT NULL,
 principal TEXT NOT NULL, context_json TEXT NOT NULL, request_hash TEXT NOT NULL,
 verification_state TEXT NOT NULL, supersedes_id TEXT, revoked_at INTEGER,
 created_at INTEGER NOT NULL, UNIQUE(tenant_id, supersedes_id)
);
CREATE INDEX IF NOT EXISTS idx_use_context_scope ON memory_use_contexts(tenant_id, principal, project_id, work_type, source_id, created_at);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_use_context_fts USING fts5(context_id UNINDEXED, text, tokenize='unicode61');
CREATE TABLE IF NOT EXISTS memory_use_evidence (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, context_id TEXT NOT NULL,
 role TEXT NOT NULL, ref_type TEXT NOT NULL, ref_id TEXT NOT NULL,
 span_start INTEGER NOT NULL, span_end INTEGER NOT NULL, content_hash TEXT NOT NULL,
 excerpt TEXT NOT NULL, verification_state TEXT NOT NULL, reason TEXT,
 created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_use_evidence_context ON memory_use_evidence(tenant_id, context_id);
CREATE INDEX IF NOT EXISTS idx_use_evidence_ref ON memory_use_evidence(tenant_id, ref_type, ref_id);
CREATE TABLE IF NOT EXISTS memory_use_evaluations (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, context_id TEXT NOT NULL,
 effect_event_id TEXT, assessment_json TEXT NOT NULL, outcome TEXT NOT NULL,
 verification_state TEXT NOT NULL, proof_id TEXT NOT NULL, request_hash TEXT NOT NULL,
 supersedes_id TEXT, created_at INTEGER NOT NULL,
 UNIQUE(tenant_id, supersedes_id)
);
CREATE INDEX IF NOT EXISTS idx_use_evaluation_context ON memory_use_evaluations(tenant_id, context_id, created_at);
CREATE TABLE IF NOT EXISTS memory_use_feedback (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, principal TEXT NOT NULL,
 project_id TEXT NOT NULL, task_id TEXT NOT NULL, source_id TEXT NOT NULL,
 usage_item_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'assessment',
 text TEXT NOT NULL, contribution TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_use_statistics (
 tenant_id TEXT NOT NULL, principal TEXT NOT NULL, project_id TEXT NOT NULL,
 work_type TEXT NOT NULL, source_type TEXT NOT NULL, source_id TEXT NOT NULL,
 source_version INTEGER NOT NULL, positive REAL NOT NULL, negative REAL NOT NULL,
 evaluation_count INTEGER NOT NULL, snapshot_id TEXT NOT NULL, as_of INTEGER NOT NULL, context_ids_json TEXT NOT NULL,
 constraints_key TEXT NOT NULL, conditions_key TEXT NOT NULL,
 PRIMARY KEY(tenant_id, principal, project_id, work_type, source_type, source_id, source_version, constraints_key, conditions_key)
);
CREATE TABLE IF NOT EXISTS memory_use_snapshots (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, principal TEXT NOT NULL,
 project_id TEXT NOT NULL, work_type TEXT NOT NULL, policy TEXT NOT NULL,
 as_of INTEGER NOT NULL, statistics_json TEXT NOT NULL, invalidated_at INTEGER
);
CREATE TABLE IF NOT EXISTS memory_use_outbox (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, payload_json TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', error TEXT, created_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS use_context_revoke AFTER UPDATE OF revoked_at ON memory_use_contexts
WHEN NEW.revoked_at IS NOT NULL BEGIN
 INSERT OR IGNORE INTO memory_use_outbox(id,tenant_id,payload_json,status,created_at)
 SELECT NEW.id||':revoke',NEW.tenant_id,json_object('operation','revoke','id',NEW.id),'pending',NEW.revoked_at
 WHERE EXISTS(SELECT 1 FROM memory_use_outbox WHERE id=NEW.id AND tenant_id=NEW.tenant_id);
 UPDATE memory_use_snapshots SET invalidated_at=COALESCE(invalidated_at,NEW.revoked_at) WHERE tenant_id=NEW.tenant_id AND principal=NEW.principal AND project_id=NEW.project_id AND work_type=NEW.work_type;
 DELETE FROM memory_use_context_fts WHERE context_id=NEW.id;
 DELETE FROM memory_use_statistics WHERE tenant_id=NEW.tenant_id AND source_id=NEW.source_id;
END;
CREATE TRIGGER IF NOT EXISTS use_context_inserted AFTER INSERT ON memory_use_contexts BEGIN
 UPDATE memory_use_snapshots SET invalidated_at=COALESCE(invalidated_at,NEW.created_at) WHERE tenant_id=NEW.tenant_id AND principal=NEW.principal AND project_id=NEW.project_id AND work_type=NEW.work_type;
END;
CREATE TRIGGER IF NOT EXISTS use_evaluation_inserted AFTER INSERT ON memory_use_evaluations BEGIN
 UPDATE memory_use_snapshots SET invalidated_at=COALESCE(invalidated_at,NEW.created_at) WHERE tenant_id=NEW.tenant_id AND EXISTS(SELECT 1 FROM memory_use_contexts c WHERE c.id=NEW.context_id AND c.tenant_id=NEW.tenant_id AND c.principal=memory_use_snapshots.principal AND c.project_id=memory_use_snapshots.project_id AND c.work_type=memory_use_snapshots.work_type);
END;
CREATE TRIGGER IF NOT EXISTS use_effect_superseded AFTER INSERT ON memory_effect_events WHEN NEW.supersedes_effect_id IS NOT NULL BEGIN
 UPDATE memory_use_snapshots SET invalidated_at=COALESCE(invalidated_at,NEW.created_at) WHERE tenant_id=NEW.tenant_id AND EXISTS(
 SELECT 1 FROM memory_use_contexts c JOIN memory_use_evaluations e ON e.context_id=c.id AND e.tenant_id=c.tenant_id WHERE e.effect_event_id=NEW.supersedes_effect_id AND e.tenant_id=NEW.tenant_id AND c.principal=memory_use_snapshots.principal AND c.project_id=memory_use_snapshots.project_id AND c.work_type=memory_use_snapshots.work_type);
 DELETE FROM memory_use_statistics WHERE tenant_id=NEW.tenant_id AND source_id IN (
 SELECT c.source_id FROM memory_use_contexts c JOIN memory_use_evaluations e ON e.context_id=c.id AND e.tenant_id=c.tenant_id WHERE e.effect_event_id=NEW.supersedes_effect_id AND e.tenant_id=NEW.tenant_id);
END;
CREATE TRIGGER IF NOT EXISTS use_effect_deleted AFTER DELETE ON memory_effect_events BEGIN
 UPDATE memory_use_snapshots SET invalidated_at=COALESCE(invalidated_at,unixepoch()*1000) WHERE tenant_id=OLD.tenant_id AND EXISTS(
 SELECT 1 FROM memory_use_contexts c JOIN memory_use_evaluations e ON e.context_id=c.id AND e.tenant_id=c.tenant_id WHERE e.effect_event_id=OLD.id AND e.tenant_id=OLD.tenant_id AND c.principal=memory_use_snapshots.principal AND c.project_id=memory_use_snapshots.project_id AND c.work_type=memory_use_snapshots.work_type);
 DELETE FROM memory_use_statistics WHERE tenant_id=OLD.tenant_id AND source_id IN (
 SELECT c.source_id FROM memory_use_contexts c JOIN memory_use_evaluations e ON e.context_id=c.id AND e.tenant_id=c.tenant_id WHERE e.effect_event_id=OLD.id AND e.tenant_id=OLD.tenant_id);
END;
CREATE TRIGGER IF NOT EXISTS use_feedback_deleted AFTER DELETE ON memory_use_feedback BEGIN
 UPDATE memory_use_contexts SET revoked_at=unixepoch()*1000 WHERE tenant_id=OLD.tenant_id AND id IN (SELECT context_id FROM memory_use_evidence WHERE tenant_id=OLD.tenant_id AND ref_type='use_feedback' AND ref_id=OLD.id);
END;
CREATE TRIGGER IF NOT EXISTS use_memory_deleted AFTER DELETE ON memories BEGIN
 UPDATE memory_use_contexts SET revoked_at=unixepoch()*1000 WHERE tenant_id=OLD.tenant_id AND source_type='memory' AND source_id=OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS use_memory_changed AFTER UPDATE OF permissions_json, current_version, lifecycle_state, valid_until ON memories BEGIN
 DELETE FROM memory_use_statistics WHERE tenant_id=NEW.tenant_id AND source_id=NEW.id;
 DELETE FROM memory_use_context_fts WHERE context_id IN(SELECT id FROM memory_use_contexts WHERE tenant_id=NEW.tenant_id AND source_id=NEW.id);
 UPDATE memory_use_snapshots SET invalidated_at=COALESCE(invalidated_at,unixepoch()*1000) WHERE tenant_id=NEW.tenant_id AND EXISTS(SELECT 1 FROM memory_use_contexts c WHERE c.tenant_id=NEW.tenant_id AND c.source_id=NEW.id AND c.principal=memory_use_snapshots.principal AND c.project_id=memory_use_snapshots.project_id AND c.work_type=memory_use_snapshots.work_type);
END;
