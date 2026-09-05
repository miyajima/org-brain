import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hash, prepareCases, createManifest, validateManifest, consensus, supportSummary,
  foldsFor, projection, featureRows, channelText, summarize, selectThresholds, trainNested,
  compareEvidence, pairedBootstrap, developmentGate, safetySplitAudit,
} from './memory-extraction-router-v33-core.mjs';
import { createV32ExperimentManifest, evaluateV32SafetyFixture } from './memory-extraction-router-v32.mjs';
import { sanitizeMemoryExtractionReviewCase } from '../packages/shared/src/memory-extraction-review-text-runtime.mjs';

function item(i) {
  const turns = [{ id: 's1', role: i % 2 ? 'user' : 'assistant', content: `今後の制約は記録を維持する。識別 ${hash(`unique-case-${i}`).slice(7)}。` }];
  return { id: `case-${i}`, session_hash: `session-${i}`, source_hash: hash(turns), review_text_hash: hash(turns), turns, group_id: `group-${i}`, dataset_role: 'development', cohort: i < 40 ? 'challenge' : 'sampled_development', prior_ai_exposure: 'ai_assisted', hard_excluded: false };
}
function annotations(cases) {
  return Object.fromEntries(cases.map((c, i) => [c.id, { case_id: c.id, revision_id: `${c.id}:v33:test`, source_hash: c.source_hash, review_text_hash: c.review_text_hash, usefulness: ['durable_memory', 'operational_history_only', 'not_useful'][i % 3], review_status: 'accepted', label_origin: 'ai_assisted', evidence_spans: i % 3 ? [] : [{ turn_id: 's1', start: 0, end: 16, quote: c.turns[0].content.slice(0, 16) }] }]));
}
function vectors(cases) {
  return Object.fromEntries(cases.map((c, i) => [c.id, Object.fromEntries(['all', 'user', 'assistant'].filter(channel => channelText(c, channel === 'all' ? null : channel)).map(channel => {
    const vector = Array.from({ length: 1024 }, (_, d) => d === i % 3 ? 1 : 0);
    return [channel, { vector, vector_hash: hash(vector), input_hash: hash(channelText(c, channel === 'all' ? null : channel)), model: 'text-embedding-3-large', dimensions: 1024 }];
  }))]));
}

test('selection uses blind hash order, preserves source groups and rejects tampering/holdout', () => {
  const source = Array.from({ length: 500 }, (_, i) => item(i));
  const legacy = createV32ExperimentManifest(source, { experimentId: 'old', legacyDevelopment: true });
  const challenge = { cases: source.slice(0, 40).map(c => ({ ...sanitizeMemoryExtractionReviewCase(c), group_id: legacy.case_records.find(r => r.id === c.id).group_id })) };
  const selected = prepareCases(source, challenge, legacy);
  assert.equal(selected.length, 120);
  assert.equal(new Set(selected.map(c => c.id)).size, 120);
  const changedPredictions = source.map(c => ({ ...c, model_prediction: { usefulness: 'anything' } }));
  assert.deepEqual(prepareCases(changedPredictions, challenge, legacy).map(c => c.id), selected.map(c => c.id));
  assert.ok(selected.every(c => !('model_prediction' in c)));
  const m = createManifest(selected, { experimentId: 'test', sources: {}, fixtureHash: 'fixed' });
  assert.equal(validateManifest(m), m);
  assert.throws(() => validateManifest({ ...m, dataset_role: 'final_holdout' }), /development_manifest/);
  assert.throws(() => prepareCases([{ ...source[0], source_hash: 'wrong' }, ...source.slice(1)], challenge, legacy), /source_or_group_hash/);
});

test('AI consensus preserves history and Sol support; disagreement stays uncertain', () => {
  const c = item(0), sol = { review_status: 'accepted', usefulness: 'durable_memory', evidence_spans: [{ quote: 'sol' }] }, luna = { ...sol, evidence_spans: [{ quote: 'luna' }] };
  const agreed = consensus(c, sol, luna);
  assert.equal(agreed.label_origin, 'ai_assisted');
  assert.equal(agreed.prior_ai_exposure, 'ai_assisted');
  assert.deepEqual(agreed.evidence_spans, sol.evidence_spans);
  assert.equal(consensus(c, sol, { ...luna, usefulness: 'not_useful' }).review_status, 'uncertain');
});

test('role projection is fixed; missing roles flagged; review notes cannot affect features', () => {
  const cases = [item(0)], a = annotations(cases), e = vectors(cases);
  assert.equal(projection('all', 64).hash, projection('all', 64).hash);
  const r = featureRows(cases, a, e, 'combined_role')[0];
  assert.equal(r.features.has_user, 0); assert.equal(r.features.has_assistant, 1);
  assert.equal(r.features.user_0, 0);
  assert.deepEqual(featureRows(cases, { [cases[0].id]: { ...a[cases[0].id], future_use: 'changed' } }, e, 'combined_role')[0].features, r.features);
  e[cases[0].id].assistant.vector[0] = NaN;
  assert.throws(() => featureRows(cases, a, e, 'combined_role'), /embedding_binding/);
});

test('hierarchical operational false negatives and uncertainty bounds use all rows', () => {
  const rows = [
    { review_status: 'accepted', usefulness: 'operational_history_only', route: 'llm_candidate' },
    { review_status: 'accepted', usefulness: 'durable_memory', route: 'llm_candidate' },
    { review_status: 'uncertain', usefulness: null, route: 'discard' },
  ];
  const s = summarize(rows);
  assert.equal(s.semantic.operational.fn, 1);
  assert.equal(s.conservative.durable_recall, 0.5);
  assert.equal(s.all_case_call_rate, 2 / 3);
  assert.equal(s.conservative.operational_f1, 0);
});

test('durable threshold obeys both uncertainty-inclusive and semantic candidate caps', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ cohort: 'sampled_development', review_status: i < 8 ? 'accepted' : 'uncertain', usefulness: i < 4 ? 'durable_memory' : 'operational_history_only', durable_probability: i < 8 ? 0.9 - i * 0.07 : 0.99, operational_probability: 0.5 }));
  const thresholds = selectThresholds(rows);
  assert.ok(rows.filter(r => r.durable_probability >= thresholds.durable).length / 10 <= 0.47);
});

test('nested procedure is deterministic, saves all OOF and excludes outer labels from selection', () => {
  const cases = Array.from({ length: 120 }, (_, i) => item(i));
  const a = annotations(cases), e = vectors(cases);
  const m = createManifest(cases, { experimentId: 'test', sources: {}, fixtureHash: 'fixed' });
  const options = { iterations: 3, l2: [0.08], configurations: ['rules', 'embedding_mean', 'combined_mean', 'combined_role'] };
  const t = trainNested(cases, a, e, m.folds, options);
  assert.equal(t.outer_rows.length, 120);
  assert.equal(new Set(t.outer_rows.map(r => r.case_id)).size, 120);
  assert.ok(t.outer_rows.every(r => r.model_hash && r.training_group_hash && r.thresholds));
  assert.deepEqual(trainNested(cases, a, e, m.folds, options), t);
  const changed = structuredClone(a);
  for (const c of cases.filter(c => m.folds.outer[c.group_id] === 0)) changed[c.id].usefulness = 'not_useful';
  const again = trainNested(cases, changed, e, m.folds, options);
  assert.deepEqual(again.fold_artifacts[0], t.fold_artifacts[0]);
  assert.throws(() => trainNested([{ ...cases[0], dataset_role: 'final_holdout' }], a, e, m.folds, options), /holdout/);
  assert.equal(supportSummary(cases, a).pass, true);
});

test('grouped folds never split a shared group', () => {
  const cases = Array.from({ length: 20 }, (_, i) => ({ ...item(i), group_id: `g-${i % 10}` }));
  assert.deepEqual(foldsFor(cases, 5, 'seed'), foldsFor(cases.slice().reverse(), 5, 'seed'));
});

test('safety split audit catches family and digit-masked duplicate leakage', () => {
  assert.throws(() => safetySplitAudit({ cases: [{ family: 'a', text: 'token 123', phase: 'calibration' }, { family: 'b', text: 'token 456', phase: 'locked' }] }), /safety_split_overlap/);
  assert.throws(() => safetySplitAudit({ cases: [{ family: 'a', text: 'abc', phase: 'calibration' }, { family: 'a', text: 'def', phase: 'locked' }] }), /safety_split_overlap/);
});

test('routed false negative has zero coverage, forced packing is separate and no packets gives null exact', () => {
  const c = item(0), a = annotations([c]);
  const e = compareEvidence([c], a, [{ case_id: c.id, route: 'discard' }]);
  assert.equal(e.end_to_end.v33.packet_exact_source_rate, null);
  assert.equal(e.end_to_end.v33.character_coverage, 0);
  assert.equal(e.causes[0].reason, 'route');
  assert.ok(e.packer_only.v33.packet_cases > 0);
  const s = summarize([{ ...a[c.id], route: 'discard' }]);
  assert.equal(developmentGate(s, e, evaluateV32SafetyFixture()).pass, false);
});

test('paired group bootstrap is reproducible and identical predictions have zero delta', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ case_id: `c${i}`, group_id: `g${i}`, review_status: 'accepted', usefulness: i % 2 ? 'durable_memory' : 'operational_history_only', route: i % 2 ? 'llm_candidate' : 'operational_history' }));
  const result = pairedBootstrap(rows, rows, 50);
  assert.deepEqual(pairedBootstrap(rows, rows, 50), result);
  assert.equal(result.delta_v33_minus_v2.durable_recall.lower, 0);
  assert.equal(result.delta_v33_minus_v2.call_rate.upper, 0);
});
