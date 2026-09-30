import { localUseService } from './local-memory-use.mjs';

export const USAGE_PURPOSES = ['task', 'audit', 'diagnostic', 'test', 'unclassified'];
export function normalizeUsagePurpose(value = 'unclassified') {
  if (!USAGE_PURPOSES.includes(value)) throw new Error('invalid_usage_purpose');
  return value;
}

function bucket() {
  return { events: 0, tasks: new Set(), references: 0, contributed: 0, not_contributed: 0,
    not_assessed: 0, action_observed: 0, reported_used: 0, delivery_confirmed: 0, received_assessed: 0,
    injected_token_estimate: 0, tasks_with_use: new Set() };
}
function finish(value) {
  const assessed = value.contributed + value.not_contributed;
  return { ...value, tasks: value.tasks.size, tasks_with_use: value.tasks_with_use.size,
    assessment_coverage: value.references ? assessed / value.references : null,
    received_assessment_coverage: value.delivery_confirmed ? value.received_assessed / value.delivery_confirmed : null,
    contribution_rate_assessed: assessed ? value.contributed / assessed : null,
    task_use_rate: value.tasks.size ? value.tasks_with_use.size / value.tasks.size : null };
}

// A read-only projection. Unknown labels never become negative training data.
export async function localUsageReport(db, { tenant_id = 'default', project_id = null,
  principal_id = process.env.ORGBRAIN_USE_PRINCIPAL || 'local' } = {}) {
  const total = bucket(), byPurpose = Object.fromEntries(USAGE_PURPOSES.map(key => [key, bucket()])), byReference = {};
  const byPurposeReference = Object.fromEntries(USAGE_PURPOSES.map(key => [key, {}]));
  const reasons = {}, contexts = new Map();
  const service = localUseService(db, tenant_id, principal_id);
  const liveContexts = db.prepare(`SELECT c.* FROM memory_use_contexts c WHERE tenant_id=? AND principal=? AND (? IS NULL OR project_id=?)
    AND NOT EXISTS(SELECT 1 FROM memory_use_contexts n WHERE n.tenant_id=c.tenant_id AND n.supersedes_id=c.id)`)
    .all(tenant_id, principal_id, project_id, project_id);
  const evaluations = [];
  for (const context of liveContexts) {
    if (!await service.live(context)) continue;
    contexts.set(context.usage_item_id, context);
    const latest = db.prepare(`SELECT e.* FROM memory_use_evaluations e WHERE e.tenant_id=? AND e.context_id=?
      AND e.verification_state='verified'
      AND (e.effect_event_id IS NULL OR EXISTS(SELECT 1 FROM memory_effect_events f WHERE f.tenant_id=e.tenant_id AND f.id=e.effect_event_id
        AND NOT EXISTS(SELECT 1 FROM memory_effect_events n WHERE n.tenant_id=f.tenant_id AND n.supersedes_effect_id=f.id)))
      AND NOT EXISTS(SELECT 1 FROM memory_use_evaluations x WHERE x.tenant_id=e.tenant_id AND x.supersedes_id=e.id)`)
      .all(tenant_id, context.id);
    for (const evaluation of latest) evaluations.push({ ...evaluation,
      task_key: JSON.stringify([context.project_id,context.task_id,context.source_type,context.source_id,context.source_version]) });
  }
  let positive = 0;
  const assessedTasks = new Set();
  for (const evaluation of evaluations.sort((a,b)=>b.created_at-a.created_at||b.id.localeCompare(a.id))) {
    if (assessedTasks.has(evaluation.task_key)) continue;
    assessedTasks.add(evaluation.task_key);
    positive += Number(evaluation.outcome === 'positive');
  }
  const events = db.prepare(`SELECT * FROM memory_usage_events WHERE tenant_id=? AND COALESCE(actor_principal,'local')=?
    AND (? IS NULL OR project_id=?) ORDER BY created_at,id`).all(tenant_id, principal_id, project_id, project_id);
  for (const event of events) {
    const purpose = byPurpose[event.usage_purpose] ?? byPurpose.unclassified;
    for (const target of [total, purpose]) {
      target.events++;
      if (event.task_id) target.tasks.add(event.task_id);
    }
    const items = db.prepare('SELECT * FROM memory_usage_items WHERE tenant_id=? AND usage_event_id=?').all(tenant_id, event.id);
    const eventReferences = new Set();
    for (const item of items) {
      const reference = byReference[item.reference_type] ??= bucket();
      const cross = (byPurposeReference[event.usage_purpose] ?? byPurposeReference.unclassified)[item.reference_type] ??= bucket();
      if (!eventReferences.has(item.reference_type)) { reference.events++; cross.events++; eventReferences.add(item.reference_type); }
      if (event.task_id) { reference.tasks.add(event.task_id); cross.tasks.add(event.task_id); }
      const observed = contexts.has(item.id), used = item.used_state === 'used';
      const received = Boolean(db.prepare('SELECT 1 FROM local_use_deliveries WHERE tenant_id=? AND usage_item_id=? AND principal=?').get(tenant_id,item.id,principal_id));
      // Contradictory explicit non-use and action evidence stay unassessed.
      const conflict = observed && item.used_state === 'not_used';
      const state = conflict ? 'not_assessed' : used || observed ? 'contributed' : item.used_state === 'not_used' ? 'not_contributed' : 'not_assessed';
      for (const target of [total, purpose, reference, cross]) {
        target.references++; target[state]++;
        target.delivery_confirmed += Number(received); target.received_assessed += Number(received && state !== 'not_assessed');
        target.action_observed += Number(observed); target.reported_used += Number(used && item.used_state_source === 'reported');
        target.injected_token_estimate += item.injected_token_estimate || 0;
        if (state === 'contributed' && event.task_id) target.tasks_with_use.add(event.task_id);
      }
      if (state === 'not_assessed') {
        const receipt = db.prepare(`SELECT rejection_reason FROM local_use_observation_receipts WHERE tenant_id=? AND usage_item_id=? ORDER BY created_at DESC,id DESC LIMIT 1`).get(tenant_id, item.id);
        const reason = conflict ? 'conflicting_use_evidence' : receipt?.rejection_reason || (receipt ? 'awaiting_transcript_verification' : received ? 'no_use_observation' : 'delivery_not_confirmed');
        reasons[reason] = (reasons[reason] || 0) + 1;
      }
    }
  }
  return { scope: { tenant_id, project_id, principal_id }, total: finish(total),
    by_purpose: Object.fromEntries(Object.entries(byPurpose).map(([key, value]) => [key, finish(value)])),
    by_reference: Object.fromEntries(Object.entries(byReference).map(([key, value]) => [key, finish(value)])),
    by_purpose_reference: Object.fromEntries(Object.entries(byPurposeReference).map(([purpose, references]) =>
      [purpose, Object.fromEntries(Object.entries(references).map(([key, value]) => [key, finish(value)]))])),
    verified_positive_effects: positive, unassessed_reasons: reasons,
    definitions: { contributed: 'Reported adoption or observed action; not a measured causal benefit.',
      injected: 'Database injection receipt; delivery is not implied.',
      token_estimate: 'Estimated entry tokens, excludes hook framing and other instructions.',
      task_denominator: 'Distinct identified tasks including zero-result events; legacy purpose remains unclassified.' } };
}
