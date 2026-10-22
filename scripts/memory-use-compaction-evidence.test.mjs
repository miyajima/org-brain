import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readMemoryUseTurnEvidence } from '../packages/orgbrain-cli/src/lib/memory-learning-transcript.mjs';

const turn = turnId => ({ type: 'turn_context', payload: { type: 'turn_context', turn_id: turnId } });
const compacted = () => ({ type: 'compacted', payload: { type: 'compacted', message: 'context compacted' } });
const usageItem = { usage_item_id: 'item-1', source_id: 'memory-1', source_version: 1 };
const pendingPreview = { memory_id: 'memory-1', current_version: 1, full_body_omitted: true,
  detail_ref: { tool: 'orgbrain_memory_get', arguments: { tenant_id: 'tenant-1', project_id: 'project-1',
    principal_id: 'alice', work_type: 'implementation', memory_id: 'memory-1', expected_version: 1 } } };

function nativeDelivery({ usageId = 'usage-1', workType = 'implementation', preview = pendingPreview, item = usageItem } = {}) {
  const parts = [JSON.stringify(preview), `Use tracking: receipt; task_id=task-1; project_id=project-1; work_type=${workType}; usage_id=${usageId}; items=${JSON.stringify([item])} If and only if this item informs a tool action, record the use.`];
  return { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'text', text: parts.join('\n\n') }] } };
}

async function read(rows, turnId) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'orgbrain-use-compaction-'));
  try {
    const transcriptPath = path.join(directory, 'transcript.jsonl');
    await writeFile(transcriptPath, rows.map(row => JSON.stringify(row)).join('\n'));
    return await readMemoryUseTurnEvidence({ transcriptPath, turnId });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('same-turn native pending receipts survive compaction without carrying earlier action or assessment events', async () => {
  const delivery = nativeDelivery();
  const priorAction = { type: 'response_item', payload: { type: 'function_call', call_id: 'before-compact', name: 'functions.exec', arguments: '{}' } };
  const priorAssessment = { type: 'response_item', payload: { type: 'message', role: 'user', content: 'memory-1: 役立った' } };
  const priorSummary = { type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'Use tracking receipt was present.' } };
  const currentAction = { type: 'response_item', payload: { type: 'function_call', call_id: 'after-compact', name: 'functions.exec', arguments: '{}' } };
  const evidence = await read([turn('same-turn'), delivery, priorAction, priorAssessment, priorSummary,
    compacted(), turn('same-turn'), currentAction], 'same-turn');
  assert.equal(evidence.reason, null);
  assert.deepEqual(evidence.rows, [delivery, turn('same-turn'), currentAction]);

  const crossTypeDelivery = nativeDelivery({ workType: 'other' });
  const crossType = await read([turn('same-turn'), crossTypeDelivery, compacted(), turn('same-turn')], 'same-turn');
  assert.deepEqual(crossType.rows, [crossTypeDelivery, turn('same-turn')]);
});

test('prior-turn and summarized or quoted receipts are not restored across compaction', async () => {
  const priorTurn = await read([turn('previous-turn'), nativeDelivery({ usageId: 'previous-usage' }), compacted(),
    turn('current-turn')], 'current-turn');
  assert.deepEqual(priorTurn.rows, [turn('current-turn')]);

  const quoted = nativeDelivery();
  quoted.payload.content = [{ type: 'text', text: `Summary of the old delivery:\n> ${quoted.payload.content[0].text.replaceAll('\n', '\n> ')}` }];
  const summary = await read([turn('same-turn'), quoted, compacted(), turn('same-turn')], 'same-turn');
  assert.deepEqual(summary.rows, [turn('same-turn')]);

  const copied = nativeDelivery();
  const assistantSummary = { type: 'response_item', payload: { type: 'message', role: 'assistant',
    content: `Summary of the old delivery:\n${copied.payload.content[0].text}` } };
  const assistant = await read([turn('same-turn'), assistantSummary, compacted(), turn('same-turn')], 'same-turn');
  assert.deepEqual(assistant.rows, [turn('same-turn')]);
});

test('post-compaction legacy developer receipts remain available to the current turn', async () => {
  const legacy = nativeDelivery({ preview: { memory_id: 'memory-1', current_version: 1, full_body_omitted: false,
    detail_ref: pendingPreview.detail_ref } });
  const evidence = await read([compacted(), legacy, turn('current-turn')], 'current-turn');
  assert.deepEqual(evidence.rows, [legacy, turn('current-turn')]);
});

test('multiple compactions retain only pending deliveries from the uninterrupted current turn', async () => {
  const old=nativeDelivery({usageId:'old-turn'}), current=nativeDelivery();
  const evidence=await read([turn('old'),old,turn('same'),current,compacted(),turn('same'),compacted(),turn('same')],'same');
  assert.deepEqual(evidence.rows,[current,turn('same')]);
});
