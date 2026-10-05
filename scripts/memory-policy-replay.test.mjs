import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluatePolicyReplay, snapshotEvents, assessPolicyCase } from './memory-policy-replay.mjs';
import { policyCases, replayTime } from './fixtures/memory-policy-replay.mjs';

test('snapshot excludes future corrections and successes, including exact-boundary events', () => {
  const rows = [{ at: replayTime + 1, kind: 'revise' }, { at: replayTime, kind: 'capture' }, { at: replayTime - 1, kind: 'attempt' }];
  assert.deepEqual(snapshotEvents(rows).map(row => row.kind), ['attempt', 'capture']);
  assert.equal(rows.length, 3, 'the immutable fixture corpus remains unchanged');
  assert.throws(() => snapshotEvents([{ at: NaN }]), /invalid_replay_time/);
});

test('oracle rejects chatter-first, stale versions and removal of applicability exceptions', () => {
  const observed = { delivered: [{ fixture_key: 'chatter' }, { fixture_key: 'official' }], context_text: '', preflight: null };
  assert.ok(assessPolicyCase(policyCases[0], observed).failures.includes('source_priority'));
  assert.ok(assessPolicyCase(policyCases[1], { ...observed, delivered: [{ fixture_key: 'corrected', source_version: 1 }] }).failures.includes('version:corrected'));
  assert.ok(assessPolicyCase(policyCases[2], { ...observed, delivered: [{ fixture_key: 'conditional' }] }).failures.includes('missing_condition'));
});

test('fair offline replay preserves scope, receipts, conditions and failure gates without inventing outcomes', async () => {
  const root = new URL('..', import.meta.url).pathname;
  const result = await evaluatePolicyReplay({ currentRoot: root, improvedRoot: root });
  assert.equal(result.session_kind, 'synthetic');
  assert.equal(result.actual_provider_cost, null);
  const current = result.variants.current, improved = result.variants.improved, none = result.variants['no-memory'];
  assert.deepEqual(current.source_hashes, improved.source_hashes);
  assert.deepEqual(current.policy, improved.policy);
  assert.equal(current.fixture_sha256, improved.fixture_sha256);
  assert.equal(current.as_of, replayTime);
  assert.ok(none.cases.every(row => row.delivered.length === 0 && row.applied_event_count === 0));
  for (const variant of Object.values(result.variants)) {
    assert.equal(variant.network_calls, 0);
    assert.equal(variant.provider_calls, 0);
    assert.ok(variant.cases.every(row => row.within_budget && row.adopted.count === null && row.verified_outcomes === null));
    assert.ok(variant.cases.every(row => !row.context_text.includes('FUTURE_ONLY_731')));
  }
  for (const variant of [current, improved]) {
    const byId = Object.fromEntries(variant.cases.map(row => [row.id, row]));
    for (const id of ['source-priority', 'explicit-correction', 'applicable-exception', 'retracted-procedure', 'future-source',
      'failure-recurrence', 'changed-condition', 'reported-failure', 'project-boundary', 'permission-boundary'])
      assert.deepEqual(byId[id].assessment.failures, [], id);
    assert.equal(byId['failure-recurrence'].excluded_future_events, 1);
    assert.equal(byId['explicit-correction'].excluded_future_events, 1);
    assert.deepEqual(current.cases.map(row => row.assessment), improved.cases.map(row => row.assessment));
  }
});
