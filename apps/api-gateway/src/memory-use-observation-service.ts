import { HttpError, memoryReadAccessSql, memoryUseFlags, normalizeUseContext, observeMemoryUse } from '@org-brain/shared';
import { authorizePermission } from './rbac-service';
import { screenMemoryReviewText } from './memory-screening-service';
import type { Env } from './types';

// An opaque receipt acknowledges a scoped report. It cannot be used as trusted
// action/delivery evidence by MemoryUseHistory and does not evaluate benefit.
export async function receiveCloudUseObservation(env: Env, tenantId: string, principal: string | null,
  input: Record<string, unknown>, fallbackRole?: import('@org-brain/contracts').OrgRole) {
  try {
    const accepted = observeMemoryUse(input);
    if (!memoryUseFlags(env as unknown as Record<string, unknown>).collect) return { ...accepted, persisted: false, receipt_persisted: false, tracking: 'disabled' };
    const projectId = input.project_id as string;
    if (!principal || !(await authorizePermission(env, { tenantId, projectId, principal, permission: 'write', fallbackRole })).allowed) {
      throw new HttpError(403, 'forbidden', 'Write permission required for the observation project');
    }
    const observation = Object.fromEntries(['usage_id', 'usage_item_id', 'source_id', 'source_version', 'project_id',
      'task_id', 'work_type', 'action_call_id', 'outcome_call_id'].filter(key => input[key] !== undefined).map(key => [key, input[key]]));
    const context = normalizeUseContext(input.context);
    for (const [key, value] of Object.entries(context)) {
      if (value) screenMemoryReviewText(value as string, `use_context.${key}`);
    }
    observation.context = context;
    for (const key of ['action_call_id', 'outcome_call_id']) {
      if (observation[key] !== undefined && !/^(?:call_|mcp:)[A-Za-z0-9._:-]{1,240}$/u.test(String(observation[key]))) throw new Error(`invalid_use_${key}`);
    }
    for (const key of ['work_type', 'outcome_call_id']) {
      if (observation[key] !== undefined) {
        if (typeof observation[key] !== 'string' || observation[key].length > 256) throw new Error(`invalid_use_${key}`);
        screenMemoryReviewText(observation[key], key);
      }
    }
    const item = await env.OPEN_BRAIN_DB.prepare(`SELECT i.source_id, i.source_version FROM memory_usage_items i
      JOIN memory_usage_events e ON e.id=i.usage_event_id AND e.tenant_id=i.tenant_id
      JOIN memories m ON m.id=i.source_id AND m.tenant_id=i.tenant_id
      WHERE e.tenant_id=? AND e.actor_principal=? AND e.project_id=? AND e.task_id=? AND e.id=? AND i.id=?
        AND i.source_type='memory' AND m.current_version=i.source_version AND m.project_id=e.project_id
        AND m.deleted_at IS NULL AND COALESCE(m.lifecycle_state,'active')='active'
        AND COALESCE(m.verification_state,'unverified')!='rejected'
        AND (m.valid_from IS NULL OR m.valid_from<=?) AND (m.valid_until IS NULL OR m.valid_until>?)
        AND (m.expires_at IS NULL OR m.expires_at>?) AND ${memoryReadAccessSql('m', { principal })}`)
      .bind(tenantId, principal, projectId, input.task_id, input.usage_id, input.usage_item_id, Date.now(), Date.now(), Date.now())
      .first<{ source_id: string; source_version: number }>();
    if (!item || item.source_id !== input.source_id || item.source_version !== input.source_version) {
      throw new HttpError(403, 'use_receipt_scope_mismatch', 'Observation does not match an accessible current retrieval item');
    }
    const id = `orgbrain-use-receipt:${crypto.randomUUID()}`, now = Date.now();
    await env.OPEN_BRAIN_DB.prepare(`INSERT INTO cloud_use_observation_receipts
      (id,tenant_id,principal,project_id,task_id,usage_item_id,observation_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .bind(id, tenantId, principal, projectId, input.task_id, input.usage_item_id, JSON.stringify(observation), now, now + 86_400_000).run();
    return { ...accepted, persisted: false, receipt_persisted: true, observation, use_receipt: id, tracking: 'pending_trusted_event_verification' };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'invalid_use_observation', error instanceof Error ? error.message : 'Invalid observation');
  }
}
