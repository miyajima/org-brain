import { localUseFlags } from './local-memory-use.mjs';

// This is a native tool-call identifier handoff, never an attribution or proof.
// Stop still verifies the explicit observation against the actual turn transcript.
export async function memoryUseActionContext(store, { payload, tenantId, projectId, taskId,
  principal = process.env.ORGBRAIN_USE_PRINCIPAL || 'local' }) {
  if (!projectId || !taskId || /orgbrain_memory_observe$/u.test(String(payload.tool_name ?? ''))) return {};
  const ids = [...new Set([payload.tool_call_id, payload.call_id, payload.tool_use_id]
    .filter(value => typeof value === 'string' && value.length > 0))];
  if (ids.length !== 1 || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$/u.test(ids[0])) return {};
  await store.init();
  const db = store.open();
  try {
    if (!localUseFlags(db).collect) return {};
    const pending = db.prepare(`SELECT 1 FROM memory_usage_events e JOIN memory_usage_items i
      ON i.usage_event_id=e.id AND i.tenant_id=e.tenant_id
      WHERE e.tenant_id=? AND COALESCE(e.actor_principal,'local')=? AND e.project_id=? AND e.task_id=?
      AND i.used_state='unknown' LIMIT 1`).get(tenantId, principal, projectId, taskId);
    if (!pending) return {};
    return { action_call_id: ids[0], hookSpecificOutput: { hookEventName: 'PostToolUse',
      additionalContext: `OrgBrain action identifier: ${JSON.stringify({ action_call_id: ids[0], project_id: projectId, task_id: taskId })}. If a retrieved memory actually informed this action, use this native call ID in its explicit use_observation and print the returned use_receipt. This hint establishes neither memory use nor success. Mere citation is not use; do not rate benefit or infer not_used from a missing observation. Stop will verify retrieval, scope, version and actual action order.` } };
  } finally { db.close(); }
}
