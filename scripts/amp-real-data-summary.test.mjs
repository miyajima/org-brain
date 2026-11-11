import test from 'node:test';
import assert from 'node:assert/strict';
import { auditedCases, aggregate } from './amp-real-data-summary.mjs';
import { scoreResult } from './amp-real-data-evaluation.mjs';
import { readFile } from 'node:fs/promises';

test('audit accepts equivalent hash guards and mock boundaries without changing frozen questions', async () => {
  const frozen = JSON.parse(await readFile('docs/agent-memory-protocol/evaluation-20261109-cases.json'));
  const before = JSON.stringify(frozen);
  const cases = await auditedCases(frozen);
  const hash = scoreResult({ evidence: [{ text: 'ページID・ハッシュ・保存済みprojectの一致を確認してから候補をキューへ入れる。範囲やハッシュが一致しなければ処理を保留する。' }] }, cases.find(c => c.id === 'q09'));
  assert.equal(hash.complete, true);
  const mock = scoreResult({ evidence: [{ text: '32記憶を保存。Macへ反映後のStop確認は隔離DBと模擬APIで実施。新しい自然なStopから実モデルで抽出できたかは、この記録では未確認。' }] }, cases.find(c => c.id === 'q16'));
  assert.equal(mock.complete, true);
  assert.equal(JSON.stringify(frozen), before);
});

test('aggregate keeps errors in the question denominator but excludes them from valid token averages', () => {
  const good = { error: null, output_tokens: 100, input_tokens: 20, score: { any_claim: true, complete: true, qualifier_found: 2, qualifier_total: 2, relevant_units: 1, returned_units: 2 } };
  const failed = { error: 'invalid_query_terms', output_tokens: 10, input_tokens: 30, score: null };
  const a = aggregate([good, failed], 4);
  assert.equal(a.questions, 2); assert.equal(a.errors, 1);
  assert.equal(a.complete, 1); assert.equal(a.qualifiers_missing, 2);
  assert.equal(a.mean_valid_output_tokens, 100);
  assert.equal(a.mean_all_attempt_output_tokens, 55);
});
