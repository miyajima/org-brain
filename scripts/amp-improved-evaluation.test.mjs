import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreRetrieved } from './amp-improved-evaluation.mjs';

test('hybrid scoring includes original passages and complete memories, but never summary cards', () => {
  const c = { atoms: [{ id: 'claim', type: 'claim', patterns: ['保留'] }, { id: 'limit', type: 'qualifier', patterns: ['予算不足'] }] };
  assert.equal(scoreRetrieved([{ results: [{ kind: 'source', text: '予算不足なら保留。' }] }], c).complete, true);
  assert.equal(scoreRetrieved([{ results: [{ kind: 'amp', memory: { claim: '保留', exceptions: ['予算不足'] } }] }], c).complete, true);
  assert.equal(scoreRetrieved([{ results: [{ kind: 'amp', requires_read: true, summary: '予算不足なら保留。' }] }], c).complete, false);
});
