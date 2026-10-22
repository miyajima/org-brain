import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './lib/memory-use-fixture.mjs';
import { collectMemoryUse } from '../packages/orgbrain-cli/src/lib/memory-use-collector.mjs';
import { receiveLocalUseObservation } from '../packages/orgbrain-cli/src/lib/local-use-observations.mjs';
import { recordLocalMemoryUseAssessment } from '../packages/orgbrain-cli/src/lib/memory-use-assessment.mjs';

const call = (id, name, args) => ({ payload: { type: 'custom_tool_call', call_id: id, name, arguments: args } });
const out = (id, output) => ({ payload: { type: 'custom_tool_call_output', call_id: id, output } });
const codeRunnerOutput = (value) => [
  { type: 'input_text', text: 'Script completed\n\nOutput:\n' },
  { type: 'input_text', text: JSON.stringify(value, null, 2) }
];

test('collector accepts multiline JSON and a printed receipt in real code-runner output blocks', async () => {
  const f = await fixture();
  try {
    const useObservation = {
      usage_id: 'usage', usage_item_id: 'item', source_id: f.id, source_version: 1,
      task_id: 'prior-task', project_id: 'p', work_type: 'implementation', context: f.payload.context,
      action_call_id: 'action', outcome_call_id: 'outcome'
    };
    const receipt = await receiveLocalUseObservation(f.store, 't', useObservation);
    const usageEnvelope = {
      results: [],
      candidates: [{ id: f.id, current_version: 1 }],
      meta: {
        usage_id: 'usage',
        usage_item_ids: ['item'],
        usage_items: [{ usage_item_id: 'item', source_type: 'memory', source_id: f.id, source_version: 1 }]
      }
    };
    const rows = [
      call('retrieval', 'exec', 'const source = "meta.usage_items";'),
      out('retrieval', codeRunnerOutput(usageEnvelope)),
      call('action', 'exec_command', JSON.stringify({ cmd: 'fixture action' })),
      out('action', JSON.stringify({ exit_code: 0 })),
      call('outcome', 'exec_command', JSON.stringify({ cmd: 'fixture outcome' })),
      out('outcome', JSON.stringify({ exit_code: 0 })),
      call('observe', 'exec', 'print the accepted receipt'),
      out('observe', codeRunnerOutput({ use_receipt: receipt.use_receipt }))
    ];

    const result = await collectMemoryUse(f.store, { rows, tenantId: 't', projectId: 'p', taskId: 'prior-task', turnId: 'transport-turn' });

    assert.equal(result.delivered, 1);
    assert.equal(result.recorded, 1);
    assert.deepEqual(result.rejected, []);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM local_use_deliveries WHERE usage_item_id=?').get('item').n, 1);
    const contextId = f.db.prepare('SELECT context_id FROM local_use_observation_receipts WHERE id=?').get(receipt.use_receipt).context_id;
    assert.notEqual(contextId, null);
    const assessment = f.db.prepare('SELECT * FROM local_memory_use_assessments WHERE tenant_id=? AND usage_item_id=?').get('t', 'item');
    assert.equal(assessment.used_state, 'used');
    assert.equal(assessment.reason_code, 'verified_action_context');
    assert.equal(assessment.action_context_id, contextId);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM memory_use_evidence WHERE context_id=? AND role='assessment'").get(contextId).n, 0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM memory_effect_events WHERE tenant_id=? AND usage_event_id=?').get('t', 'usage').n, 0);

    const duplicate = await collectMemoryUse(f.store, { rows, tenantId: 't', projectId: 'p', taskId: 'prior-task', turnId: 'transport-turn' });
    assert.equal(duplicate.recorded, 1);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM local_memory_use_assessments WHERE tenant_id=? AND usage_item_id=?').get('t', 'item').n, 1);
    assert.equal(f.db.prepare('SELECT id FROM local_memory_use_assessments WHERE tenant_id=? AND usage_item_id=?').get('t', 'item').id, assessment.id);
  } finally { await f.close(); }
});

test('an observation without an observed action cannot create a used assessment', async () => {
  const f = await fixture();
  try {
    const useObservation = {
      usage_id: 'usage', usage_item_id: 'item', source_id: f.id, source_version: 1,
      task_id: 'prior-task', project_id: 'p', work_type: 'implementation', context: f.payload.context,
      action_call_id: 'missing-action'
    };
    const receipt = await receiveLocalUseObservation(f.store, 't', useObservation);
    const usageEnvelope = {
      results: [], candidates: [{ id: f.id, current_version: 1 }],
      meta: {
        usage_id: 'usage', usage_item_ids: ['item'],
        usage_items: [{ usage_item_id: 'item', source_type: 'memory', source_id: f.id, source_version: 1 }]
      }
    };
    const rows = [
      call('retrieval', 'exec', 'const source = "meta.usage_items";'),
      out('retrieval', codeRunnerOutput(usageEnvelope)),
      call('observe', 'exec', 'print the accepted receipt'),
      out('observe', codeRunnerOutput({ use_receipt: receipt.use_receipt }))
    ];

    const result = await collectMemoryUse(f.store, { rows, tenantId: 't', projectId: 'p', taskId: 'prior-task', turnId: 'missing-action-turn' });

    assert.equal(result.recorded, 0);
    assert.deepEqual(result.rejected, ['use_action_not_observed']);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM memory_use_contexts WHERE tenant_id=? AND usage_item_id=?').get('t', 'item').n, 0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM local_memory_use_assessments WHERE tenant_id=? AND usage_item_id=?').get('t', 'item').n, 0);
    assert.equal(f.db.prepare('SELECT used_state FROM memory_usage_items WHERE tenant_id=? AND id=?').get('t', 'item').used_state, 'unknown');
  } finally { await f.close(); }
});

test('a source-version gap after verified context recording does not fabricate a used assessment', async () => {
  const f = await fixture();
  try {
    const useObservation = {
      usage_id: 'usage', usage_item_id: 'item', source_id: f.id, source_version: 1,
      task_id: 'prior-task', project_id: 'p', work_type: 'implementation', context: f.payload.context,
      action_call_id: 'action'
    };
    const receipt = await receiveLocalUseObservation(f.store, 't', useObservation);
    const usageEnvelope = {
      results: [], candidates: [{ id: f.id, current_version: 1 }],
      meta: {
        usage_id: 'usage', usage_item_ids: ['item'],
        usage_items: [{ usage_item_id: 'item', source_type: 'memory', source_id: f.id, source_version: 1 }]
      }
    };
    const rows = [
      call('retrieval', 'exec', 'const source = "meta.usage_items";'),
      out('retrieval', codeRunnerOutput(usageEnvelope)),
      call('action', 'exec_command', JSON.stringify({ cmd: 'fixture action' })),
      out('action', JSON.stringify({ exit_code: 0 })),
      call('observe', 'exec', 'print the accepted receipt'),
      out('observe', codeRunnerOutput({ use_receipt: receipt.use_receipt }))
    ];
    f.db.prepare('UPDATE memories SET current_version=2 WHERE tenant_id=? AND id=?').run('t', f.id);

    const result = await collectMemoryUse(f.store, { rows, tenantId: 't', projectId: 'p', taskId: 'prior-task', turnId: 'stale-source-turn' });

    assert.equal(result.recorded, 1);
    assert.deepEqual(result.rejected, []);
    assert.deepEqual(result.assessment_gaps, { use_assessment_source_version_not_live: 1 });
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM memory_use_contexts WHERE tenant_id=? AND usage_item_id=?').get('t', 'item').n, 1);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM local_memory_use_assessments WHERE tenant_id=? AND usage_item_id=?').get('t', 'item').n, 0);
    assert.equal(f.db.prepare('SELECT used_state FROM memory_usage_items WHERE tenant_id=? AND id=?').get('t', 'item').used_state, 'unknown');
    assert.equal(f.db.prepare('SELECT gap_reason FROM local_use_collection_runs WHERE tenant_id=? AND task_id=?').get('t', 'prior-task').gap_reason, 'use_assessment_gap');
  } finally { await f.close(); }
});

test('collector preserves an explicit human not-used assessment', async () => {
  const f = await fixture();
  try {
    const useObservation = {
      usage_id: 'usage', usage_item_id: 'item', source_id: f.id, source_version: 1,
      task_id: 'prior-task', project_id: 'p', work_type: 'implementation', context: f.payload.context,
      action_call_id: 'action'
    };
    const receipt = await receiveLocalUseObservation(f.store, 't', useObservation);
    f.db.prepare(`INSERT INTO local_use_deliveries
      (tenant_id,usage_item_id,principal,task_id,project_id,confirmed_at) VALUES(?,?,?,?,?,?)`)
      .run('t', 'item', 'local', 'prior-task', 'p', Date.now());
    await recordLocalMemoryUseAssessment(f.db, {
      id: 'human-not-used', tenantId: 't', principal: 'local', projectId: 'p', taskId: 'prior-task',
      usageEventId: 'usage', usageItemId: 'item', sourceVersion: 1,
      state: 'not_used', reasonCode: 'not_consulted'
    });
    const usageEnvelope = {
      results: [], candidates: [{ id: f.id, current_version: 1 }],
      meta: {
        usage_id: 'usage', usage_item_ids: ['item'],
        usage_items: [{ usage_item_id: 'item', source_type: 'memory', source_id: f.id, source_version: 1 }]
      }
    };
    const rows = [
      call('retrieval', 'exec', 'const source = "meta.usage_items";'),
      out('retrieval', codeRunnerOutput(usageEnvelope)),
      call('action', 'exec_command', JSON.stringify({ cmd: 'fixture action' })),
      out('action', JSON.stringify({ exit_code: 0 })),
      call('observe', 'exec', 'print the accepted receipt'),
      out('observe', codeRunnerOutput({ use_receipt: receipt.use_receipt }))
    ];

    const result = await collectMemoryUse(f.store, { rows, tenantId: 't', projectId: 'p', taskId: 'prior-task', turnId: 'explicit-not-used-turn' });

    assert.equal(result.recorded, 1);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM local_memory_use_assessments WHERE tenant_id=? AND usage_item_id=?').get('t', 'item').n, 1);
    const latest = f.db.prepare('SELECT used_state,reason_code FROM local_memory_use_assessments WHERE tenant_id=? AND usage_item_id=?').get('t', 'item');
    assert.deepEqual({ ...latest }, { used_state: 'not_used', reason_code: 'not_consulted' });
    assert.deepEqual(result.assessment_gaps, { assessment_preserved_explicit_nonuse: 1 });
  } finally { await f.close(); }
});

test('automatic used assessment appends after and supersedes the latest unknown assessment', async () => {
  const f = await fixture();
  try {
    await recordLocalMemoryUseAssessment(f.db, {
      id: 'human-unknown', tenantId: 't', principal: 'local', projectId: 'p', taskId: 'prior-task',
      usageEventId: 'usage', usageItemId: 'item', sourceVersion: 1,
      state: 'unknown', reasonCode: 'action_evidence_missing'
    });
    const useObservation = {
      usage_id: 'usage', usage_item_id: 'item', source_id: f.id, source_version: 1,
      task_id: 'prior-task', project_id: 'p', work_type: 'implementation', context: f.payload.context,
      action_call_id: 'action'
    };
    const receipt = await receiveLocalUseObservation(f.store, 't', useObservation);
    const usageEnvelope = {
      results: [], candidates: [{ id: f.id, current_version: 1 }],
      meta: {
        usage_id: 'usage', usage_item_ids: ['item'],
        usage_items: [{ usage_item_id: 'item', source_type: 'memory', source_id: f.id, source_version: 1 }]
      }
    };
    const rows = [
      call('retrieval', 'exec', 'const source = "meta.usage_items";'),
      out('retrieval', codeRunnerOutput(usageEnvelope)),
      call('action', 'exec_command', JSON.stringify({ cmd: 'fixture action' })),
      out('action', JSON.stringify({ exit_code: 0 })),
      call('observe', 'exec', 'print the accepted receipt'),
      out('observe', codeRunnerOutput({ use_receipt: receipt.use_receipt }))
    ];

    const result = await collectMemoryUse(f.store, { rows, tenantId: 't', projectId: 'p', taskId: 'prior-task', turnId: 'superseding-assessment-turn' });

    assert.equal(result.recorded, 1);
    assert.deepEqual(result.assessment_gaps, {});
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM local_memory_use_assessments WHERE tenant_id=? AND usage_item_id=?').get('t', 'item').n, 2);
    const latest = f.db.prepare(`SELECT a.used_state,a.reason_code,a.supersedes_id,a.action_context_id
      FROM local_memory_use_assessments a
      WHERE a.tenant_id=? AND a.usage_item_id=?
        AND NOT EXISTS(SELECT 1 FROM local_memory_use_assessments n WHERE n.tenant_id=a.tenant_id AND n.supersedes_id=a.id)`)
      .get('t', 'item');
    assert.equal(latest.used_state, 'used');
    assert.equal(latest.reason_code, 'verified_action_context');
    assert.equal(latest.supersedes_id, 'human-unknown');
    assert.notEqual(latest.action_context_id, null);
  } finally { await f.close(); }
});

test('quoted code and nested diagnostic metadata are not retrieval delivery', async () => {
  const f = await fixture();
  try {
    const fakeEnvelope = { meta: { usage_id: 'usage', usage_items: [{ usage_item_id: 'item', source_id: f.id, source_version: 1 }] } };
    const rows = [
      call('quoted-code', 'exec', `const quoted = ${JSON.stringify(JSON.stringify(fakeEnvelope))};`),
      out('quoted-code', JSON.stringify({ diagnostic: fakeEnvelope }))
    ];

    const result = await collectMemoryUse(f.store, { rows, tenantId: 't', projectId: 'p', taskId: 'prior-task', turnId: 'quoted-turn' });

    assert.equal(result.delivered, 0);
    assert.equal(result.recorded, 0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM local_use_deliveries').get().n, 0);
  } finally { await f.close(); }
});
