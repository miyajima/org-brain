import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreResult } from './amp-real-data-evaluation.mjs';

const c = { atoms: [
  { id: 'claim', type: 'claim', patterns: ['起動は受付'] },
  { id: 'condition', type: 'qualifier', patterns: ['手動起動のみ'] },
] };
test('a retrieved conclusion with a missing condition is not complete', () => {
  const result = scoreResult({ evidence: [{ text: '起動は受付。' }] }, c);
  assert.equal(result.any_claim, true); assert.equal(result.complete, false);
  assert.equal(result.qualifier_found, 0); assert.equal(result.qualifier_total, 1);
});
test('AMP metadata and diagnostics do not substitute for returned memory evidence', () => {
  const result = scoreResult({ results: [], gaps: [{ reason: '起動は受付。手動起動のみ' }] }, c);
  assert.equal(result.any_claim, false); assert.equal(result.complete, false);
});
test('both formats count the same information, including a qualifier in a separate result', () => {
  const legacy = scoreResult({ evidence: [{ text: '起動は受付。' }, { text: '手動起動のみ。' }] }, c);
  const amp = scoreResult({ results: [{ memory: { claim: '起動は受付。', limitations: ['手動起動のみ。'] }, evidence: [] }] }, c);
  assert.equal(legacy.complete, true); assert.equal(amp.complete, true);
  assert.equal(legacy.qualifier_found, amp.qualifier_found);
});
