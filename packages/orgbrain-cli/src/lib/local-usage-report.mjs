import { localUseService } from './local-memory-use.mjs';

export const USAGE_PURPOSES = ['task', 'audit', 'diagnostic', 'test', 'unclassified'];
export function normalizeUsagePurpose(value = 'unclassified') {
  if (!USAGE_PURPOSES.includes(value)) throw new Error('invalid_usage_purpose');
  return value;
}

function reportTimestamp(value) {
  if (value == null) return null;
  const match = typeof value === 'string' && value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/);
  const timestamp = match ? Date.parse(value) : NaN;
  const local = match && new Date(`${match[1]}T${match[2]}${match[3] || ''}Z`);
  if (!Number.isFinite(timestamp) || !Number.isFinite(local?.getTime()) || local.toISOString().slice(0,19) !== `${match[1]}T${match[2]}`) {
    throw new Error('usage_report_invalid_timestamp: use an RFC3339 timestamp with timezone');
  }
  return timestamp;
}

function collectionMetrics(db, tenantId, principal, projectId, since, until) {
  const rows=db.prepare(`SELECT * FROM local_use_collection_runs WHERE tenant_id=? AND principal=? AND (? IS NULL OR project_id=?)
    AND (? IS NULL OR created_at>=?) AND (? IS NULL OR created_at<?) ORDER BY created_at`)
    .all(tenantId,principal,projectId,projectId,since,since,until,until);
  const out={runs:rows.length,first_recorded_at:rows[0]?.created_at??null,last_recorded_at:rows.at(-1)?.created_at??null,completed_calls:0,delivered_items:0,observations:0,verified_use_records:0,without_use_observation:0,gap_reasons:{},rejection_reasons:{}};
  for(const row of rows){out.completed_calls+=row.completed_calls;out.delivered_items+=row.delivered_items;out.observations+=row.observations;out.verified_use_records+=row.recorded;out.without_use_observation+=row.without_observation;
    if(row.gap_reason)out.gap_reasons[row.gap_reason]=(out.gap_reasons[row.gap_reason]??0)+1;
    for(const [reason,count]of Object.entries(JSON.parse(row.rejection_counts_json)))out.rejection_reasons[reason]=(out.rejection_reasons[reason]??0)+count;
  }
  return out;
}

function bucket() {
  return { events: 0, tasks: new Set(), tasks_with_references: new Set(), references: 0, contributed: 0, not_contributed: 0,
    not_assessed: 0, action_observed: 0, reported_used: 0, delivery_confirmed: 0, received_assessed: 0,
    injected_token_estimate: 0, tasks_with_use: new Set(),
    usefulness: { verified_helpful: 0, verified_not_helpful: 0, unconfirmed: 0, unrated: 0 } };
}
function finish(value) {
  const assessed = value.contributed + value.not_contributed;
  const { verified_helpful, verified_not_helpful } = value.usefulness;
  const rated = verified_helpful + verified_not_helpful;
  return { ...value, tasks: value.tasks.size, tasks_with_references: value.tasks_with_references.size, tasks_with_use: value.tasks_with_use.size,
    use: { used: value.contributed, not_used: value.not_contributed, unassessed: value.not_assessed },
    usefulness: { ...value.usefulness, helpful_rate_verified: rated ? verified_helpful / rated : null },
    assessment_coverage: value.references ? assessed / value.references : null,
    received_assessment_coverage: value.delivery_confirmed ? value.received_assessed / value.delivery_confirmed : null,
    contribution_rate_assessed: assessed ? value.contributed / assessed : null,
    task_use_rate: value.tasks.size ? value.tasks_with_use.size / value.tasks.size : null };
}

function memoryInventory(db, tenantId, projectId) {
  const now = Date.now(), week = now - 7 * 86400000, month = now - 30 * 86400000;
  const memories = db.prepare(`SELECT COUNT(*) total,
    COALESCE(SUM(COALESCE(lifecycle_state,'active')<>'suppressed' AND COALESCE(deleted_at,0)=0),0) active,
    COALESCE(SUM(lifecycle_state='suppressed'),0) suppressed,
    COALESCE(SUM(created_at>=? AND created_at<=?),0) created_last_7_days,
    COALESCE(SUM(created_at>=? AND created_at<=?),0) created_last_30_days,
    MAX(created_at) latest_created_at FROM memories WHERE tenant_id=? AND (? IS NULL OR project_id=?)`)
    .get(week, now, month, now, tenantId, projectId, projectId);
  const hasCandidates = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_learning_candidates'").get();
  const candidates = hasCandidates ? db.prepare(`SELECT
    COALESCE(SUM(status='quarantine'),0) quarantine_candidates,
    COALESCE(SUM(created_at>=? AND created_at<=?),0) candidates_created_last_7_days
    FROM memory_learning_candidates WHERE tenant_id=? AND (? IS NULL OR project_id=?)`)
    .get(week, now, tenantId, projectId, projectId) : { quarantine_candidates: null, candidates_created_last_7_days: null };
  return { as_of: now, ...memories, ...candidates };
}

// Explicit reports attached to live use evidence, never verified counterfactuals.
function avoidedOperations(db, tenantId, contexts) {
  const result = { reported_operations: 0, linked_use_records: 0, tasks: 0,
    by_kind: { result_reuse: 0, failure_avoidance: 0 },
    by_purpose: Object.fromEntries(USAGE_PURPOSES.map(purpose => [purpose, 0])),
    measured_time_saved_ms: null, measured_cost_saved_usd: null };
  const operations = new Set(), tasks = new Set(), purposeOperations = new Set();
  for (const row of contexts) {
    const context = JSON.parse(row.context_json), claim = context.avoided_operation;
    if (!claim) continue;
    const item = db.prepare(`SELECT i.used_state,e.usage_purpose FROM memory_usage_items i
      JOIN memory_usage_events e ON e.tenant_id=i.tenant_id AND e.id=i.usage_event_id
      WHERE i.tenant_id=? AND i.id=?`).get(tenantId,row.usage_item_id);
    if (!item || item.used_state === 'not_used') continue;
    result.linked_use_records++;
    const key = JSON.stringify([row.project_id,row.task_id,context.target,claim.kind,claim.operation]);
    const purpose = USAGE_PURPOSES.includes(item.usage_purpose) ? item.usage_purpose : 'unclassified';
    const purposeKey = JSON.stringify([purpose,key]);
    if (!purposeOperations.has(purposeKey)) {
      purposeOperations.add(purposeKey);
      result.by_purpose[purpose]++;
    }
    if (operations.has(key)) continue;
    operations.add(key);
    tasks.add(JSON.stringify([row.project_id,row.task_id]));
    result.reported_operations++;
    result.by_kind[claim.kind]++;
  }
  result.tasks = tasks.size;
  return result;
}

// A read-only projection. Unknown labels never become negative training data.
export async function localUsageReport(db, { tenant_id = 'default', project_id = null,
  principal_id = process.env.ORGBRAIN_USE_PRINCIPAL || 'local', since = null, until = null } = {}) {
  const sinceMs = reportTimestamp(since), untilMs = reportTimestamp(until);
  if (sinceMs !== null && untilMs !== null && sinceMs >= untilMs) throw new Error('usage_report_invalid_period');
  const asOf = Date.now();
  const total = bucket(), byPurpose = Object.fromEntries(USAGE_PURPOSES.map(key => [key, bucket()])), byReference = {};
  const byPurposeReference = Object.fromEntries(USAGE_PURPOSES.map(key => [key, {}]));
  const reasons = {}, reasonsByPurpose = Object.fromEntries(USAGE_PURPOSES.map(key => [key, {}])), contexts = new Map();
  const service = localUseService(db, tenant_id, principal_id);
  const assessmentTable=Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_memory_use_assessments'").get());
  const assessments=new Map(assessmentTable?db.prepare(`SELECT a.* FROM local_memory_use_assessments a WHERE tenant_id=? AND principal=? AND NOT EXISTS(SELECT 1 FROM local_memory_use_assessments n WHERE n.tenant_id=a.tenant_id AND n.supersedes_id=a.id)`).all(tenant_id,principal_id).map(a=>[a.usage_item_id,a]):[]);
  const liveContexts = db.prepare(`SELECT c.* FROM memory_use_contexts c WHERE tenant_id=? AND principal=? AND (? IS NULL OR project_id=?)
    AND NOT EXISTS(SELECT 1 FROM memory_use_contexts n WHERE n.tenant_id=c.tenant_id AND n.supersedes_id=c.id)`)
    .all(tenant_id, principal_id, project_id, project_id);
  const evaluations = [];
  const currentEvaluationByItem = new Map();
  const observedInPeriod = [];
  for (const context of liveContexts) {
    if (!await service.live(context)) continue;
    contexts.set(context.usage_item_id, context);
    if ((sinceMs === null || context.created_at >= sinceMs) && (untilMs === null || context.created_at < untilMs)) observedInPeriod.push(context);
    const latest = db.prepare(`SELECT e.* FROM memory_use_evaluations e WHERE e.tenant_id=? AND e.context_id=?
      AND e.created_at<=?
      AND (e.effect_event_id IS NULL OR EXISTS(SELECT 1 FROM memory_effect_events f WHERE f.tenant_id=e.tenant_id AND f.id=e.effect_event_id
        AND NOT EXISTS(SELECT 1 FROM memory_effect_events n WHERE n.tenant_id=f.tenant_id AND n.supersedes_effect_id=f.id)))
      AND NOT EXISTS(SELECT 1 FROM memory_use_evaluations x WHERE x.tenant_id=e.tenant_id AND x.supersedes_id=e.id)`)
      .all(tenant_id, context.id, asOf);
    for (const evaluation of latest) {
      const prior = currentEvaluationByItem.get(context.usage_item_id);
      if (!prior || evaluation.created_at > prior.created_at || (evaluation.created_at === prior.created_at && evaluation.id > prior.id)) {
        currentEvaluationByItem.set(context.usage_item_id, evaluation);
      }
      if (evaluation.verification_state === 'verified' && (sinceMs === null || evaluation.created_at >= sinceMs)
        && (untilMs === null || evaluation.created_at < untilMs)) {
        evaluations.push({ ...evaluation, task_key: JSON.stringify([context.project_id,context.task_id,context.source_type,context.source_id,context.source_version]) });
      }
    }
  }
  let positive = 0;
  const assessedTasks = new Set();
  for (const evaluation of evaluations.sort((a,b)=>b.created_at-a.created_at||b.id.localeCompare(a.id))) {
    if (assessedTasks.has(evaluation.task_key)) continue;
    assessedTasks.add(evaluation.task_key);
    positive += Number(evaluation.outcome === 'positive');
  }
  const events = db.prepare(`SELECT * FROM memory_usage_events WHERE tenant_id=? AND COALESCE(actor_principal,'local')=?
    AND (? IS NULL OR project_id=?) AND (? IS NULL OR created_at>=?) AND (? IS NULL OR created_at<?)
    ORDER BY created_at,id`).all(tenant_id, principal_id, project_id, project_id, sinceMs, sinceMs, untilMs, untilMs);
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
      const assessment=assessments.get(item.id);
      const observed = contexts.has(item.id), staleAssessedUse=item.used_state_source==='assessed'&&item.used_state==='used'&&(!assessment||contexts.get(item.id)?.id!==assessment.action_context_id);
      const used = item.used_state === 'used'&&!staleAssessedUse;
      const received = Boolean(db.prepare('SELECT 1 FROM local_use_deliveries WHERE tenant_id=? AND usage_item_id=? AND principal=?').get(tenant_id,item.id,principal_id));
      // Contradictory explicit non-use and action evidence stay unassessed.
      const conflict = observed && item.used_state === 'not_used';
      const state = conflict ? 'not_assessed' : used || observed ? 'contributed' : item.used_state === 'not_used' ? 'not_contributed' : 'not_assessed';
      const evaluation = currentEvaluationByItem.get(item.id);
      let usefulness = evaluation ? 'unconfirmed' : 'unrated';
      if (evaluation?.verification_state === 'verified') {
        if (evaluation.outcome === 'positive') usefulness = 'verified_helpful';
        if (evaluation.outcome === 'negative') usefulness = 'verified_not_helpful';
      }
      for (const target of [total, purpose, reference, cross]) {
        if (event.task_id) target.tasks_with_references.add(event.task_id);
        target.references++; target[state]++;
        target.delivery_confirmed += Number(received); target.received_assessed += Number(received && state !== 'not_assessed');
        target.action_observed += Number(observed); target.reported_used += Number(used && item.used_state_source === 'reported');
        target.injected_token_estimate += item.injected_token_estimate || 0;
        if (state === 'contributed') {
          target.usefulness[usefulness]++;
          if (event.task_id) target.tasks_with_use.add(event.task_id);
        }
      }
      if (state === 'not_assessed') {
        const receipt = db.prepare(`SELECT rejection_reason FROM local_use_observation_receipts WHERE tenant_id=? AND usage_item_id=? ORDER BY created_at DESC,id DESC LIMIT 1`).get(tenant_id, item.id);
        const reason = conflict ? 'conflicting_use_evidence' : staleAssessedUse?'assessed_use_evidence_not_live':assessment?.used_state==='unknown'?assessment.reason_code:receipt?.rejection_reason || (receipt ? 'awaiting_transcript_verification' : received ? 'no_use_observation' : 'delivery_not_confirmed');
        reasons[reason] = (reasons[reason] || 0) + 1;
        const purposeReasons = reasonsByPurpose[event.usage_purpose] ?? reasonsByPurpose.unclassified;
        purposeReasons[reason] = (purposeReasons[reason] || 0) + 1;
      }
    }
  }
  return { scope: { tenant_id, project_id, principal_id },
    period: { since: sinceMs === null ? null : new Date(sinceMs).toISOString(), until: untilMs === null ? null : new Date(untilMs).toISOString(), end_exclusive: true, assessment_as_of: asOf },
    action_observations_in_period: { references: new Set(observedInPeriod.map(context => context.usage_item_id)).size,
      tasks: new Set(observedInPeriod.map(context => context.task_id).filter(Boolean)).size },
    avoided_operations: avoidedOperations(db, tenant_id, observedInPeriod),
    total: finish(total),
    by_purpose: Object.fromEntries(Object.entries(byPurpose).map(([key, value]) => [key, finish(value)])),
    by_reference: Object.fromEntries(Object.entries(byReference).map(([key, value]) => [key, finish(value)])),
    by_purpose_reference: Object.fromEntries(Object.entries(byPurposeReference).map(([purpose, references]) =>
      [purpose, Object.fromEntries(Object.entries(references).map(([key, value]) => [key, finish(value)]))])),
    verified_positive_effects: positive, unassessed_reasons: reasons,
    unassessed_reasons_by_purpose: reasonsByPurpose,
    memory_inventory: memoryInventory(db, tenant_id, project_id),
    collection_metrics: collectionMetrics(db,tenant_id,principal_id,project_id,sinceMs,untilMs),
    definitions: { period: 'Retrieval cohorts use event creation time. Assessments are current at assessment_as_of, not a historical snapshot. Collection, action observations and positive effects use their own recording times. Inventory is current.',
      contributed: 'Reported adoption or observed action; not a measured causal benefit.',
      usefulness: 'Latest live assessment per used reference at assessment_as_of. Unconfirmed assessments and missing ratings are separate and excluded from the verified helpful rate.',
      avoided_operations: 'Explicit omission reports linked to currently valid use evidence, grouped by project, task, target, kind and exact operation label. Each purpose deduplicates independently; purpose counts may overlap. Period uses use-record creation time. Prior evidence and applicability are reported, not independently verified. Missing reports do not mean zero avoidance. No causal time or cost savings are inferred.',
      injected: 'Database injection receipt; delivery is not implied.',
      token_estimate: 'Estimated entry tokens, excludes hook framing and other instructions.',
      task_denominator: 'Distinct identified tasks including zero-result events; legacy purpose remains unclassified.',
      memory_inventory: 'Stored memory records and extraction candidates are separate. Quarantine is not active memory; candidate creation is not proof of extraction quality or promotion.' } };
}
