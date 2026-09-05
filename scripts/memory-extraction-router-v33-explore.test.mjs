import assert from 'node:assert/strict';
import test from 'node:test';
import {recallThresholds, trainExploration, EXPLORE_POLICY} from './memory-extraction-router-v33-explore.mjs';
import {hash, createManifest, summarize, selectThresholds} from './memory-extraction-router-v33-core.mjs';

const scored = (i, label, p, status = 'accepted') => ({case_id: `c${i}`, cohort: 'sampled_development', review_status: status, usefulness: label, durable_probability: p, operational_probability: 0.8, hard_excluded: false});
const route = (rows, t) => rows.map(r => ({...r, route: r.hard_excluded ? 'hard_excluded' : r.durable_probability >= t.durable ? 'llm_candidate' : r.operational_probability >= t.operational ? 'operational_history' : 'discard'}));
test('recall target is allowed above former cap; operational misroutes remain FN', () => {
  const rows = [scored(0, 'durable_memory', 0.9), scored(1, 'operational_history_only', 0.85), scored(2, 'durable_memory', 0.8), scored(3, 'operational_history_only', 0.1)];
  const t = recallThresholds(rows, 0.95), s = summarize(route(rows, t));
  assert.equal(t.durable, 0.8); assert.equal(s.semantic.durable.recall, 1); assert.equal(s.all_case_call_rate, 0.75);
  assert.equal(s.semantic.operational.fn, 1); assert.equal(s.semantic.operational.f1, 2 / 3);
  assert.ok(summarize(route(rows, selectThresholds(rows))).all_case_call_rate <= 0.47);
  assert.throws(() => recallThresholds(rows, 1.1), /invalid_recall/);
  assert.throws(() => recallThresholds(rows.filter(r => r.usefulness === 'durable_memory'), 0.95), /insufficient/);
});
test('uncertain labels never choose thresholds and remain in candidate-rate denominator', () => {
  const rows = [scored(0, 'durable_memory', 0.9), scored(1, 'operational_history_only', 0.1), scored(2, null, 0.99, 'uncertain')];
  const t = recallThresholds(rows, 0.95), s = summarize(route(rows, t));
  assert.equal(s.all_case_call_rate, 2 / 3); assert.equal(s.semantic.call_rate, 0.5);
  assert.deepEqual(recallThresholds(rows.map(r => r.review_status === 'uncertain' ? {...r, usefulness: 'durable_memory'} : r), 0.95), t);
});
function fixture() {
  const cases = Array.from({length: 120}, (_, i) => {
    const turns = [{id: 's1', role: i % 2 ? 'user' : 'assistant', content: `今後も検証を維持する。理由は再発防止。識別 ${i}`}];
    return {id: `case${i}`, turns, source_hash: hash(turns), review_text_hash: hash(turns), group_id: `g${i}`, cohort: i < 40 ? 'challenge' : 'sampled_development', dataset_role: 'development', hard_excluded: false};
  });
  const a = Object.fromEntries(cases.map((c, i) => [c.id, {case_id: c.id, revision_id: `r${i}`, source_hash: c.source_hash, review_text_hash: c.review_text_hash, label_origin: 'ai_assisted', review_status: i % 11 ? 'accepted' : 'uncertain', usefulness: i % 11 ? (i % 2 ? 'durable_memory' : 'operational_history_only') : null}]));
  const m = createManifest(cases, {experimentId: 'test', sources: {}, fixtureHash: 'test'});
  return {cases, a, folds: m.folds};
}
test('grouped nested exploration deterministic, all policies predict all120, outer label isolation', () => {
  const {cases, a, folds} = fixture(), options = {iterations: 2, l2: [0.08]};
  const t = trainExploration(cases, a, folds, options);
  assert.deepEqual(trainExploration(cases, a, folds, options), t);
  assert.equal(t.final_model_created, false); assert.equal(t.policy.candidate_rate_is_gate, false);
  assert.deepEqual(Object.keys(t.by_policy), ['reference_cap47', 'recall80', 'recall90', 'recall95', 'recall100']);
  for (const rows of Object.values(t.by_policy)) {
    assert.equal(rows.length, 120); assert.equal(new Set(rows.map(r => r.case_id)).size, 120);
    assert.ok(rows.every(r => r.model_hash && r.training_group_hash && r.revision_id && !r.features));
    for (const r of rows) assert.equal(r.fold, folds.outer[r.group_id]);
  }
  const changed = structuredClone(a);
  for (const c of cases.filter(c => folds.outer[c.group_id] === 0)) changed[c.id].usefulness = 'not_useful';
  assert.deepEqual(trainExploration(cases, changed, folds, options).fold_artifacts[0], t.fold_artifacts[0]);
  assert.equal(EXPLORE_POLICY.iterations, 4000);
});
test('uncertain judgments do not change models; no network during training; holdout rejected', () => {
  const {cases, a, folds} = fixture(), options = {iterations: 1, l2: [0.08]};
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {throw Error('network_forbidden');};
  try {
    const t = trainExploration(cases, a, folds, options), changed = structuredClone(a);
    for (const v of Object.values(changed)) if (v.review_status === 'uncertain') v.usefulness = 'durable_memory';
    assert.deepEqual(trainExploration(cases, changed, folds, options).fold_artifacts, t.fold_artifacts);
    assert.throws(() => trainExploration([{...cases[0], dataset_role: 'final_holdout'}, ...cases.slice(1)], a, folds, options), /holdout/);
    const bad = structuredClone(folds); delete bad.inner[0][cases.find(c => folds.outer[c.group_id] !== 0).group_id];
    assert.throws(() => trainExploration(cases, a, bad, options), /fold_binding/);
  } finally {globalThis.fetch = originalFetch;}
});
