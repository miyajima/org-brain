import { randomUUID } from 'node:crypto';
import { normalizeUseContext, observeMemoryUse } from '../../../shared/src/memory-use-history-runtime.mjs';
import { localUseFlags } from './local-memory-use.mjs';

// The MCP handler issues this opaque receipt, never the transcript parser.
// It acknowledges an observation only: it proves neither use nor benefit.
// A compact declaration names only the delivered usage item, the action call
// and what the memory was used for. The retrieval, source version and task
// scope are read from the usage record this principal was actually given, so
// the caller cannot supply them wrongly. Fields the caller does supply are left
// untouched and must still pass the scope check below.
function expandCompactUseObservation(db, tenantId, principal, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.usage_item_id !== 'string' || !input.usage_item_id) return input;
  const delivered = db.prepare(`SELECT e.id AS usage_id, e.project_id, e.task_id, e.requested_work_type AS work_type, i.source_id, i.source_version
    FROM memory_usage_items i JOIN memory_usage_events e ON e.id=i.usage_event_id AND e.tenant_id=i.tenant_id
    WHERE e.tenant_id=? AND e.actor_principal=? AND i.id=?`).get(tenantId, principal, input.usage_item_id);
  if (!delivered) {
    if (input.usage_id === undefined) throw new Error('use_receipt_scope_mismatch');
    return input;
  }
  const expanded = { ...input };
  for (const key of ['usage_id', 'source_id', 'source_version', 'project_id', 'task_id', 'work_type']) {
    if (expanded[key] === undefined && delivered[key] !== null && delivered[key] !== undefined) expanded[key] = delivered[key];
  }
  if (expanded.context === undefined && (input.task !== undefined || input.target !== undefined)) {
    expanded.context = { task: input.task, target: input.target, constraints: input.constraints, conditions: input.conditions };
  }
  return expanded;
}

export async function receiveLocalUseObservation(store, tenantId, rawInput, principal = process.env.ORGBRAIN_USE_PRINCIPAL || 'local') {
  await store.init();
  const db = store.open();
  try {
    const input = expandCompactUseObservation(db, tenantId, principal, rawInput);
    const accepted = observeMemoryUse(input);
    const observation = Object.fromEntries(['usage_id', 'usage_item_id', 'source_id', 'source_version', 'project_id', 'task_id', 'work_type', 'action_call_id', 'outcome_call_id']
      .filter(key => input[key] !== undefined).map(key => [key, input[key]]));
    observation.context = normalizeUseContext(input.context);
    for (const key of ['work_type', 'outcome_call_id']) {
      if (observation[key] !== undefined && (typeof observation[key] !== 'string' || observation[key].length > 256)) throw new Error(`invalid_use_${key}`);
    }
    if (!localUseFlags(db).collect) return { ...accepted, observation, tracking: 'disabled' };
    const item = db.prepare(`SELECT i.source_id, i.source_version FROM memory_usage_items i
      JOIN memory_usage_events e ON e.id=i.usage_event_id AND e.tenant_id=i.tenant_id
      WHERE e.tenant_id=? AND e.actor_principal=? AND e.project_id=? AND e.task_id=? AND e.id=? AND i.id=?`)
      .get(tenantId, principal, input.project_id, input.task_id, input.usage_id, input.usage_item_id);
    if (!item || item.source_id !== input.source_id || item.source_version !== input.source_version) throw new Error('use_receipt_scope_mismatch');
    const id = `orgbrain-use-receipt:${randomUUID()}`, now = Date.now();
    db.prepare(`INSERT INTO local_use_observation_receipts
      (id,tenant_id,principal,project_id,task_id,usage_item_id,observation_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(id, tenantId, principal, input.project_id, input.task_id, input.usage_item_id, JSON.stringify(observation), now, now + 86_400_000);
    return { ...accepted, observation, use_receipt: id, tracking: 'pending_transcript_verification' };
  } finally { db.close(); }
}
