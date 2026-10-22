import { useHash } from '../../../shared/src/memory-use-history-runtime.mjs';
import { localUseService } from './local-memory-use.mjs';

export const MEMORY_USE_ASSESSMENT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS local_memory_use_assessments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  usage_event_id TEXT NOT NULL,
  usage_item_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_version INTEGER,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  used_state TEXT NOT NULL CHECK (used_state IN ('used','not_used','unknown')),
  reason_code TEXT NOT NULL,
  action_context_id TEXT,
  supersedes_id TEXT,
  request_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (tenant_id, supersedes_id)
);
CREATE INDEX IF NOT EXISTS idx_local_memory_use_assessments_item
  ON local_memory_use_assessments(tenant_id, principal, usage_item_id, created_at DESC, id DESC);
CREATE TRIGGER IF NOT EXISTS local_memory_use_assessment_update_block
BEFORE UPDATE ON local_memory_use_assessments
BEGIN
  SELECT RAISE(ABORT, 'memory_use_assessment_append_only');
END;
`;

export const MEMORY_USE_ASSESSMENT_REASON_CODES = Object.freeze({
  used: ['verified_action_context'],
  not_used: ['not_consulted', 'not_relevant', 'redundant', 'already_known', 'other_explicit'],
  unknown: ['delivery_not_confirmed', 'action_evidence_missing', 'source_version_unknown',
    'source_version_stale', 'source_unavailable', 'conflicting_use', 'outcome_not_established']
});

const STATES = new Set(['used', 'not_used', 'unknown']);
const NON_USE_REASONS = new Set(MEMORY_USE_ASSESSMENT_REASON_CODES.not_used);
const UNKNOWN_REASONS = new Set(MEMORY_USE_ASSESSMENT_REASON_CODES.unknown);

function requiredText(value, field, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`use_assessment_${field}_required`);
  return value.trim();
}

function normalizeInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('use_assessment_input_required');
  const state = raw.state;
  if (!STATES.has(state)) throw new Error('use_assessment_state_invalid');
  const reasonCode = requiredText(raw.reasonCode, 'reason_code', 80);
  if (state === 'used' && reasonCode !== 'verified_action_context') throw new Error('use_assessment_reason_invalid');
  if (state === 'not_used' && !NON_USE_REASONS.has(reasonCode)) throw new Error('use_assessment_explicit_nonuse_reason_required');
  if (state === 'unknown' && !UNKNOWN_REASONS.has(reasonCode)) throw new Error('use_assessment_unknown_reason_required');
  const sourceVersion = raw.sourceVersion === null ? null : raw.sourceVersion;
  if (sourceVersion !== null && (!Number.isSafeInteger(sourceVersion) || sourceVersion < 1)) throw new Error('use_assessment_source_version_invalid');
  if (sourceVersion === null && (state !== 'unknown' || reasonCode !== 'source_version_unknown')) {
    throw new Error('use_assessment_source_version_required');
  }
  if (sourceVersion !== null && reasonCode === 'source_version_unknown') throw new Error('use_assessment_reason_mismatch');
  return {
    id: requiredText(raw.id, 'id', 128),
    tenantId: requiredText(raw.tenantId, 'tenant_id', 128),
    principal: requiredText(raw.principal, 'principal', 128),
    projectId: requiredText(raw.projectId, 'project_id', 128),
    taskId: requiredText(raw.taskId, 'task_id', 256),
    usageEventId: requiredText(raw.usageEventId, 'usage_event_id', 128),
    usageItemId: requiredText(raw.usageItemId, 'usage_item_id', 128),
    sourceVersion,
    state,
    reasonCode,
    actionContextId: raw.actionContextId == null ? null : requiredText(raw.actionContextId, 'action_context_id', 128),
    supersedesId: raw.supersedesId == null ? null : requiredText(raw.supersedesId, 'supersedes_id', 128)
  };
}

function assessmentRow(row) {
  if (!row) return null;
  return {
    id: row.id, tenant_id: row.tenant_id, principal: row.principal, usage_event_id: row.usage_event_id,
    usage_item_id: row.usage_item_id, source_type: row.source_type, source_id: row.source_id,
    source_version: row.source_version, project_id: row.project_id, task_id: row.task_id,
    state: row.used_state, reason_code: row.reason_code, action_context_id: row.action_context_id,
    supersedes_id: row.supersedes_id, created_at: row.created_at
  };
}

export function initLocalMemoryUseAssessment(db) {
  db.exec(MEMORY_USE_ASSESSMENT_SCHEMA_SQL);
}

function latestRows(db, { tenantId, principal, projectId = null, taskId = null, usageItemId = null }) {
  return db.prepare(`SELECT a.* FROM local_memory_use_assessments a
    WHERE a.tenant_id=? AND a.principal=?
      AND (? IS NULL OR a.project_id=?) AND (? IS NULL OR a.task_id=?) AND (? IS NULL OR a.usage_item_id=?)
      AND NOT EXISTS(SELECT 1 FROM local_memory_use_assessments n
        WHERE n.tenant_id=a.tenant_id AND n.supersedes_id=a.id)
    ORDER BY a.created_at DESC,a.id DESC`).all(tenantId, principal, projectId, projectId, taskId, taskId, usageItemId, usageItemId);
}

export function readLocalMemoryUseAssessments(db, { tenantId, principal, projectId = null, taskId = null } = {}) {
  const tenant = requiredText(tenantId, 'tenant_id', 128);
  const actor = requiredText(principal, 'principal', 128);
  return latestRows(db, { tenantId: tenant, principal: actor, projectId, taskId }).map(assessmentRow);
}

export function latestLocalMemoryUseAssessment(db, { tenantId, principal, usageItemId }) {
  const tenant = requiredText(tenantId, 'tenant_id', 128);
  const actor = requiredText(principal, 'principal', 128);
  const item = requiredText(usageItemId, 'usage_item_id', 128);
  return assessmentRow(latestRows(db, { tenantId: tenant, principal: actor, usageItemId: item })[0]);
}

function storedItem(db, input) {
  return db.prepare(`SELECT i.*,e.project_id AS event_project_id,e.task_id AS event_task_id,
      COALESCE(e.actor_principal,'local') AS event_principal,e.id AS event_id
    FROM memory_usage_items i JOIN memory_usage_events e ON e.tenant_id=i.tenant_id AND e.id=i.usage_event_id
    WHERE i.tenant_id=? AND e.id=? AND i.id=?`)
    .get(input.tenantId, input.usageEventId, input.usageItemId);
}

async function hasLiveUse(db, service, item, { tenantId, principal, projectId, taskId, now }) {
  const contexts = db.prepare(`SELECT c.* FROM memory_use_contexts c
    WHERE c.tenant_id=? AND c.principal=? AND c.usage_item_id=? AND c.source_type=? AND c.source_id=?
      AND c.source_version=? AND c.project_id=? AND c.task_id=? AND c.verification_state='verified' AND c.revoked_at IS NULL`)
    .all(tenantId, principal, item.id, item.source_type, item.source_id, item.source_version, projectId, taskId);
  for (const context of contexts) {
    if (await service.live({ ...context, at: now })) return true;
  }
  return false;
}

async function hasLiveActionContext(db, service, item, { tenantId, principal, projectId, taskId, now }) {
  const contexts = db.prepare(`SELECT c.* FROM memory_use_contexts c
    WHERE c.tenant_id=? AND c.principal=? AND c.usage_item_id=? AND c.source_type=? AND c.source_id=?
      AND c.source_version=? AND c.project_id=? AND c.task_id=? AND c.verification_state='verified' AND c.revoked_at IS NULL
      AND EXISTS(SELECT 1 FROM memory_use_evidence e WHERE e.tenant_id=c.tenant_id AND e.context_id=c.id
        AND e.role='action' AND e.verification_state='verified')`)
    .all(tenantId, principal, item.id, item.source_type, item.source_id, item.source_version, projectId, taskId);
  for (const context of contexts) {
    if (await service.live({ ...context, at: now })) return true;
  }
  return false;
}

async function requireLiveActionContext(db, service, item, input, now) {
  if (!input.actionContextId) throw new Error('use_verified_action_context_required');
  const context = db.prepare(`SELECT c.* FROM memory_use_contexts c
    WHERE c.tenant_id=? AND c.principal=? AND c.id=? AND c.usage_item_id=? AND c.source_type=?
      AND c.source_id=? AND c.source_version=? AND c.project_id=? AND c.task_id=?
      AND c.verification_state='verified' AND c.revoked_at IS NULL`)
    .get(input.tenantId, input.principal, input.actionContextId, item.id, item.source_type, item.source_id,
      item.source_version, input.projectId, input.taskId);
  if (!context) throw new Error('use_verified_action_context_required');
  const action = db.prepare(`SELECT 1 FROM memory_use_evidence
    WHERE tenant_id=? AND context_id=? AND role='action' AND verification_state='verified' LIMIT 1`)
    .get(input.tenantId, context.id);
  if (!action || !await service.live({ ...context, at: now })) throw new Error('use_verified_action_context_required');
  return context;
}

export async function recordLocalMemoryUseAssessment(db, raw) {
  const input = normalizeInput(raw);
  const now = raw.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('use_assessment_time_invalid');
  const requestHash = await useHash(input);
  let inTransaction = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    inTransaction = true;
    const existing = db.prepare('SELECT * FROM local_memory_use_assessments WHERE tenant_id=? AND id=?').get(input.tenantId, input.id);
    if (existing) {
      if (existing.request_hash !== requestHash) throw new Error('use_assessment_idempotency_conflict');
      db.exec('COMMIT');
      inTransaction = false;
      return { assessment: assessmentRow(existing), created: false };
    }

    const item = storedItem(db, input);
    if (!item) throw new Error('use_assessment_item_not_found');
    if (item.event_principal !== input.principal || item.event_project_id !== input.projectId || item.event_task_id !== input.taskId) {
      throw new Error('use_assessment_scope_mismatch');
    }
    if (item.source_version !== input.sourceVersion) throw new Error('use_assessment_version_mismatch');

    const service = localUseService(db, input.tenantId, input.principal, () => now);
    const source = item.source_version === null ? null : await service.resolveSource(item.source_type, item.source_id);
    const sourceIsLive = Boolean(source && source.current_version === item.source_version);
    if (item.source_version === null && (input.state !== 'unknown' || input.reasonCode !== 'source_version_unknown')) {
      throw new Error('use_assessment_source_version_required');
    }
    if (input.reasonCode === 'source_version_unknown' && item.source_version !== null) throw new Error('use_assessment_reason_mismatch');
    if (input.state !== 'unknown' && !sourceIsLive) throw new Error('use_assessment_source_version_not_live');
    if (input.state === 'unknown' && input.reasonCode === 'source_version_stale' && (item.source_version === null || sourceIsLive)) {
      throw new Error('use_assessment_reason_mismatch');
    }
    if (input.state === 'unknown' && input.reasonCode === 'source_version_stale' && !source) throw new Error('use_assessment_reason_mismatch');
    if (input.state === 'unknown' && input.reasonCode === 'source_unavailable' && source) throw new Error('use_assessment_reason_mismatch');

    const delivery = db.prepare(`SELECT confirmed_at FROM local_use_deliveries
      WHERE tenant_id=? AND usage_item_id=? AND principal=? AND task_id=? AND project_id=?`)
      .get(input.tenantId, item.id, input.principal, input.taskId, input.projectId);
    const deliveryConfirmed = Boolean(delivery && Number.isSafeInteger(delivery.confirmed_at) && delivery.confirmed_at <= now);
    const liveUse = input.state === 'not_used' || (input.state === 'unknown' && input.reasonCode === 'conflicting_use')
      ? await hasLiveUse(db, service, item, { ...input, now }) : false;
    const liveAction = input.state === 'unknown' && input.reasonCode === 'action_evidence_missing'
      ? await hasLiveActionContext(db, service, item, { ...input, now }) : false;
    if (input.state === 'not_used') {
      if (!NON_USE_REASONS.has(input.reasonCode)) throw new Error('use_explicit_nonuse_reason_required');
      if (!deliveryConfirmed) throw new Error('use_delivery_not_confirmed');
      if (liveUse) throw new Error('use_conflicting_verified_use');
    }
    if (input.state === 'unknown' && input.reasonCode === 'delivery_not_confirmed' && deliveryConfirmed) throw new Error('use_assessment_reason_mismatch');
    if (input.state === 'unknown' && input.reasonCode === 'action_evidence_missing' && liveAction) throw new Error('use_assessment_reason_mismatch');
    if (input.state === 'unknown' && input.reasonCode === 'conflicting_use' && !liveUse) throw new Error('use_assessment_reason_mismatch');
    const actionContext = input.state === 'used'
      ? await requireLiveActionContext(db, service, item, input, now) : null;
    if (input.state === 'used' && input.reasonCode !== 'verified_action_context') throw new Error('use_assessment_reason_invalid');
    if (input.state === 'unknown' && !UNKNOWN_REASONS.has(input.reasonCode)) throw new Error('use_assessment_unknown_reason_required');

    const latest = latestRows(db, { tenantId: input.tenantId, principal: input.principal, usageItemId: item.id })[0] ?? null;
    if ((latest?.id ?? null) !== input.supersedesId) throw new Error('use_assessment_supersedes_latest_required');
    const row = {
      id: input.id, tenant_id: input.tenantId, principal: input.principal, usage_event_id: item.usage_event_id,
      usage_item_id: item.id, source_type: item.source_type, source_id: item.source_id, source_version: item.source_version,
      project_id: item.event_project_id, task_id: item.event_task_id, used_state: input.state, reason_code: input.reasonCode,
      action_context_id: actionContext?.id ?? null, supersedes_id: latest?.id ?? null, request_hash: requestHash, created_at: now
    };
    db.prepare(`INSERT INTO local_memory_use_assessments
      (id,tenant_id,principal,usage_event_id,usage_item_id,source_type,source_id,source_version,project_id,task_id,
       used_state,reason_code,action_context_id,supersedes_id,request_hash,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(row.id,row.tenant_id,row.principal,row.usage_event_id,row.usage_item_id,row.source_type,row.source_id,row.source_version,
        row.project_id,row.task_id,row.used_state,row.reason_code,row.action_context_id,row.supersedes_id,row.request_hash,row.created_at);
    const updated = db.prepare(`UPDATE memory_usage_items SET used_state=?,used_state_source='assessed'
      WHERE tenant_id=? AND usage_event_id=? AND id=?`).run(input.state, input.tenantId, item.usage_event_id, item.id);
    if (updated.changes !== 1) throw new Error('use_assessment_item_not_found');
    db.exec('COMMIT');
    inTransaction = false;
    return { assessment: assessmentRow(row), created: true };
  } catch (error) {
    if (inTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
