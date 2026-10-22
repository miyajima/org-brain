import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './lib/memory-use-fixture.mjs';
import {
  initLocalMemoryUseAssessment,
  latestLocalMemoryUseAssessment,
  recordLocalMemoryUseAssessment
} from '../packages/orgbrain-cli/src/lib/memory-use-assessment.mjs';

async function setup() {
  const f = await fixture();
  initLocalMemoryUseAssessment(f.db);
  return f;
}

function assessment(overrides = {}) {
  return {
    id: 'assessment-1', tenantId: 't', principal: 'local', projectId: 'p', taskId: 'prior-task',
    usageEventId: 'usage', usageItemId: 'item', sourceVersion: 1,
    state: 'unknown', reasonCode: 'action_evidence_missing', ...overrides
  };
}

function confirmDelivery(f) {
  f.db.prepare(`INSERT INTO local_use_deliveries
    (tenant_id,usage_item_id,principal,task_id,project_id,confirmed_at) VALUES(?,?,?,?,?,?)`)
    .run('t', 'item', 'local', 'prior-task', 'p', f.now);
}

test('assessment rejects a caller scope that differs from stored event and item scope', async () => {
  const f = await setup();
  try {
    await assert.rejects(recordLocalMemoryUseAssessment(f.db, assessment({ projectId: 'other-project' })), /use_assessment_scope_mismatch/);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM local_memory_use_assessments').get().n, 0);
  } finally { await f.close(); }
});

test('not_used requires confirmed delivery and a specific explicit reason', async () => {
  const f = await setup();
  try {
    await assert.rejects(recordLocalMemoryUseAssessment(f.db, assessment({ state: 'not_used', reasonCode: 'not_consulted' })), /use_delivery_not_confirmed/);
    confirmDelivery(f);
    await assert.rejects(recordLocalMemoryUseAssessment(f.db, assessment({ state: 'not_used', reasonCode: 'delivery_not_confirmed' })), /use_assessment_explicit_nonuse_reason_required/);
    const result = await recordLocalMemoryUseAssessment(f.db, assessment({ state: 'not_used', reasonCode: 'not_consulted' }));
    assert.equal(result.assessment.state, 'not_used');
    assert.equal(result.assessment.reason_code, 'not_consulted');
    const row = f.db.prepare('SELECT used_state,used_state_source FROM memory_usage_items WHERE tenant_id=? AND id=?').get('t', 'item');
    assert.deepEqual({ ...row }, { used_state: 'not_used', used_state_source: 'assessed' });
  } finally { await f.close(); }
});

test('used rejects caller assertion without a live verified action context', async () => {
  const f = await setup();
  try {
    await assert.rejects(recordLocalMemoryUseAssessment(f.db, assessment({ state: 'used', reasonCode: 'verified_action_context' })), /use_verified_action_context_required/);
    assert.equal(f.db.prepare('SELECT used_state FROM memory_usage_items WHERE tenant_id=? AND id=?').get('t', 'item').used_state, 'unknown');
  } finally { await f.close(); }
});

test('revoked action context removes assessed use from the live report',async()=>{
 const f=await setup();try{
  await f.service.record(f.payload);
  await recordLocalMemoryUseAssessment(f.db,assessment({state:'used',reasonCode:'verified_action_context',actionContextId:'context'}));
  const scope={tenant_id:'t',project_id:'p',principal_id:'local'};
  assert.equal((await f.store.useHistory('report',scope)).total.contributed,1);
  await f.service.revoke('context');
  const report=await f.store.useHistory('report',scope);
  assert.equal(report.total.contributed,0);
  assert.equal(report.total.not_assessed,1);
  assert.equal(report.unassessed_reasons.assessed_use_evidence_not_live,1);
 }finally{await f.close();}
});

test('used requires a live verified action context for this exact usage item and source version', async () => {
  const f = await setup();
  try {
    const context = await f.service.record(f.payload);
    assert.equal(context.verification_state, 'verified');
    const result = await recordLocalMemoryUseAssessment(f.db, assessment({ state: 'used', reasonCode: 'verified_action_context', actionContextId: 'context' }));
    assert.equal(result.assessment.state, 'used');
    assert.equal(result.assessment.action_context_id, 'context');
    assert.equal(result.assessment.source_version, 1);
    const row = f.db.prepare('SELECT used_state,used_state_source FROM memory_usage_items WHERE tenant_id=? AND id=?').get('t', 'item');
    assert.deepEqual({ ...row }, { used_state: 'used', used_state_source: 'assessed' });
  } finally { await f.close(); }
});

test('used and not_used cannot be recorded against a stale source version', async () => {
  const f = await setup();
  try {
    await f.service.record(f.payload);
    confirmDelivery(f);
    f.db.prepare('UPDATE memories SET current_version=2 WHERE tenant_id=? AND id=?').run('t', f.id);
    await assert.rejects(recordLocalMemoryUseAssessment(f.db, assessment({
      state: 'used', reasonCode: 'verified_action_context', actionContextId: 'context'
    })), /use_assessment_source_version_not_live/);
    await assert.rejects(recordLocalMemoryUseAssessment(f.db, assessment({ state: 'not_used', reasonCode: 'not_relevant' })), /use_assessment_source_version_not_live/);
  } finally { await f.close(); }
});

test('unknown persists its reason and never changes into negative use', async () => {
  const f = await setup();
  try {
    f.db.prepare('UPDATE memory_usage_items SET source_version=NULL WHERE tenant_id=? AND id=?').run('t', 'item');
    const result = await recordLocalMemoryUseAssessment(f.db, assessment({ sourceVersion: null, reasonCode: 'source_version_unknown' }));
    assert.equal(result.assessment.state, 'unknown');
    assert.equal(result.assessment.reason_code, 'source_version_unknown');
    const stored = latestLocalMemoryUseAssessment(f.db, { tenantId: 't', principal: 'local', usageItemId: 'item' });
    assert.equal(stored.state, 'unknown');
    assert.equal(stored.reason_code, 'source_version_unknown');
    assert.equal(f.db.prepare('SELECT used_state FROM memory_usage_items WHERE tenant_id=? AND id=?').get('t', 'item').used_state, 'unknown');
  } finally { await f.close(); }
});

test('duplicate assessment is idempotent and the same id with changed content conflicts', async () => {
  const f = await setup();
  try {
    const input = assessment();
    const first = await recordLocalMemoryUseAssessment(f.db, input);
    const duplicate = await recordLocalMemoryUseAssessment(f.db, input);
    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.assessment.id, first.assessment.id);
    await assert.rejects(recordLocalMemoryUseAssessment(f.db, { ...input, reasonCode: 'delivery_not_confirmed' }), /use_assessment_idempotency_conflict/);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM local_memory_use_assessments').get().n, 1);
  } finally { await f.close(); }
});

test('correction appends a superseding assessment and updates the item to the new state', async () => {
  const f = await setup();
  try {
    const first = await recordLocalMemoryUseAssessment(f.db, assessment());
    confirmDelivery(f);
    const corrected = await recordLocalMemoryUseAssessment(f.db, assessment({
      id: 'assessment-2', state: 'not_used', reasonCode: 'not_relevant', supersedesId: first.assessment.id
    }));
    assert.equal(corrected.assessment.supersedes_id, first.assessment.id);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM local_memory_use_assessments').get().n, 2);
    assert.equal(latestLocalMemoryUseAssessment(f.db, { tenantId: 't', principal: 'local', usageItemId: 'item' }).state, 'not_used');
    const row = f.db.prepare('SELECT used_state,used_state_source FROM memory_usage_items WHERE tenant_id=? AND id=?').get('t', 'item');
    assert.deepEqual({ ...row }, { used_state: 'not_used', used_state_source: 'assessed' });
  } finally { await f.close(); }
});

test('not_used is rejected when a live verified use already exists', async () => {
  const f = await setup();
  try {
    await f.service.record(f.payload);
    confirmDelivery(f);
    await assert.rejects(recordLocalMemoryUseAssessment(f.db, assessment({ state: 'not_used', reasonCode: 'not_consulted' })), /use_conflicting_verified_use/);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM local_memory_use_assessments').get().n, 0);
  } finally { await f.close(); }
});
