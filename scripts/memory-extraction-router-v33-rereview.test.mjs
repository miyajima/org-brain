import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {hash, createManifest, consensus, supportSummary} from './memory-extraction-router-v33-core.mjs';
import {prepare, loadRun, collect, normalize, prepareRepairs, repairPreservesJudgment, feasibility, finalize, RUBRIC} from './memory-extraction-router-v33-rereview.mjs';
const item = {id: 'test', turns: [{id: 's1', role: 'assistant', content: '😀 再発を防ぐため、更新前に権限を確認する。'}]};
const annotation = {case_id: 'test', usefulness: 'durable_memory', review_status: 'accepted', lesson_types: ['decision'], evidence_spans: [{turn_id: 's1', quote: '再発を防ぐため、更新前に権限を確認する。'}], future_use: '次回更新時の権限確認', outcome: 'candidate', confidence: 'high', exclusion_reason: ''};
const episode = id => ({case_id: id, usefulness: 'operational_history_only', review_status: 'accepted', lesson_types: [], evidence_spans: [], future_use: '', outcome: 'episode_fragment', confidence: 'high', exclusion_reason: ''});
const write = (p, value) => fs.writeFileSync(p, JSON.stringify(value), {mode: 0o600});
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'router-rereview-test-'));
  t.after(() => fs.rmSync(root, {recursive: true}));
  const cases = Array.from({length: 120}, (_, i) => ({...item, id: 'case-' + i, source_hash: hash(item.turns), review_text_hash: hash(item.turns), group_id: 'g' + i, dataset_role: 'development', cohort: i < 40 ? 'challenge' : 'sampled_development', prior_ai_exposure: 'ai_assisted', hard_excluded: false}));
  const m = createManifest(cases, {experimentId: 'unit-test', sources: {}, fixtureHash: 'test-only'});
  const prior = {manifest_hash: m.manifest_hash, annotations: Object.fromEntries(cases.map(c => [c.id, consensus(c, episode(c.id), episode(c.id))]))};
  write(path.join(root, 'source.json'), m); write(path.join(root, 'old.json'), {...prior, content_hash: hash(prior)});
  const run = prepare(path.join(root, 'source.json'), path.join(root, 'old.json'), path.join(root, 'run'));
  return {root, cases, manifest: run.manifest, run: path.join(root, 'run')};
}
function fill(f, channel, alter = x => x) {for (let i = 0; i < 12; i++) write(path.join(f.run, channel, `answer-${String(i + 1).padStart(2, '0')}.json`), f.cases.slice(i * 10, i * 10 + 10).map(c => alter(episode(c.id))));}

test('exact UTF-16 quote resolution rejects invented, ambiguous and foreign evidence', () => {
  const a = normalize(annotation, item); assert.equal(a.evidence_spans[0].start, 3);
  assert.throws(() => normalize({...annotation, evidence_spans: [{turn_id: 's1', quote: '再発を防ぐから'}]}, item), /quote_not_exact/);
  assert.throws(() => normalize(annotation, {...item, turns: [{...item.turns[0], content: item.turns[0].content.repeat(2)}]}), /quote_ambiguous/);
  assert.throws(() => normalize({...annotation, evidence_spans: [{turn_id: 's2', quote: '再発'}]}, item), /support_id_invalid/);
  assert.throws(() => normalize({...annotation, evidence_spans: [...annotation.evidence_spans, ...annotation.evidence_spans]}, item), /duplicate/);
});
test('format repairs preserve judgments and words while exact validation remains mandatory', () => {
  const bad = {...annotation, evidence_spans: [{turn_id: 's1', quote: '再発を防ぐため、 更新前に権限を確認する。'}]};
  assert.ok(repairPreservesJudgment(bad, annotation));
  assert.throws(() => normalize(bad, item), /quote_not_exact/); normalize(annotation, item);
  assert.equal(repairPreservesJudgment(bad, {...annotation, usefulness: 'not_useful'}), false);
  assert.equal(repairPreservesJudgment(bad, {...annotation, future_use: '別用途'}), false);
  assert.equal(repairPreservesJudgment(bad, {...annotation, future_use: undefined}), false);
  assert.equal(repairPreservesJudgment(bad, {...annotation, evidence_spans: [{turn_id: 's1', quote: '更新後に権限を確認する'}]}), false);
  assert.equal(repairPreservesJudgment({...annotation, evidence_spans: [{turn_id: 's1', quote: 'x > 1.0'}]}, {...annotation, evidence_spans: [{turn_id: 's1', quote: 'x < 10'}]}), false);
});
test('feasibility uses integer caps with both denominators and 95 percent boundary', () => {
  assert.equal(feasibility(80, 57, 43).maximum_tp, 26);
  assert.equal(feasibility(100, 100, 49).status, 'potentially_feasible');
  assert.equal(feasibility(100, 100, 50).status, 'target_constraints_infeasible');
  assert.equal(feasibility(80, 0, 0).maximum_recall, null);
  assert.throws(() => feasibility(80, 90, 20));
});
test('prepare preserves source/folds, excludes prior labels from blind payload, refuses overwrite and holdout', t => {
  const f = fixture(t), {n, m} = loadRun(f.manifest);
  assert.equal(n.folds_hash, hash(m.folds)); assert.deepEqual(n.case_ids, m.cases.map(c => c.id)); assert.equal(n.reused_answers, 0);
  const b = JSON.parse(fs.readFileSync(path.join(f.run, 'sol/batch-01.json')));
  assert.deepEqual(Object.keys(b[0]).sort(), ['id', 'turns']);
  assert.deepEqual(Object.keys(b[0].turns[0]).sort(), ['content', 'id', 'role']);
  assert.equal(n.rubric_hash, hash(RUBRIC));
  assert.throws(() => prepare(path.join(f.root, 'source.json'), path.join(f.root, 'old.json'), f.run), /EEXIST/);
  write(path.join(f.root, 'source.json'), {...m, dataset_role: 'final_holdout'});
  assert.throws(() => loadRun(f.manifest), /development_manifest/);
});
test('checkpoint resume never changes originals; one repair attempt; consensus preserves AI history', t => {
  const f = fixture(t);
  fill(f, 'sol', a => a.case_id === 'case-0' ? {...a, extra: 'remove this non-schema key'} : a);
  fill(f, 'luna');
  const initial = collect(f.manifest, {checkpoint: true});
  assert.equal(initial.summary.counts.sol.invalid, 1);
  const packet = prepareRepairs(f.manifest, 'sol'); assert.equal(packet.count, 1);
  const saved = fs.readFileSync(path.join(f.run, 'sol/initial-01.json'), 'utf8');
  write(path.join(f.run, 'sol/repair-answers.json'), [episode('case-0')]);
  const fixed = collect(f.manifest, {checkpoint: true}); assert.equal(fixed.summary.counts.sol.repaired, 1);
  assert.equal(fs.readFileSync(path.join(f.run, 'sol/initial-01.json'), 'utf8'), saved);
  assert.equal(fixed.annotations['case-0'].prior_ai_exposure, 'ai_assisted'); assert.equal(fixed.annotations['case-0'].label_origin, 'ai_assisted');
  assert.deepEqual(collect(f.manifest).summary, fixed.summary);
  finalize(f.manifest); assert.throws(() => finalize(f.manifest), /EEXIST/);
  write(path.join(f.run, 'sol/repair-answers.json'), [{...episode('case-0'), confidence: 'low'}]);
  assert.throws(() => collect(f.manifest), /second_repair_rejected/);
});
test('valid disagreement receives no repair request and remains uncertain', t => {
  const f = fixture(t); fill(f, 'sol'); fill(f, 'luna', a => ({...a, usefulness: 'not_useful', outcome: 'no_candidate'}));
  assert.equal(prepareRepairs(f.manifest, 'sol').count, 0);
  assert.equal(prepareRepairs(f.manifest, 'luna').count, 0);
  const r = collect(f.manifest); assert.equal(r.annotations['case-0'].review_status, 'uncertain');
  assert.equal(r.summary.support.accepted, 0);
});
test('source/input changes and edits to checkpointed answers are rejected', t => {
  const f = fixture(t); fill(f, 'sol'); collect(f.manifest, {checkpoint: true});
  write(path.join(f.run, 'sol/answer-01.json'), []);
  assert.throws(() => collect(f.manifest), /initial_answer_changed/);
  write(path.join(f.run, 'luna/batch-01.json'), []);
  assert.throws(() => loadRun(f.manifest), /blind_input_changed/);
});
test('consensus uses Sol spans and support threshold includes operational minimum', () => {
  const a = normalize(annotation, item), result = consensus({...item, prior_ai_exposure: 'ai_assisted'}, a, {...a, evidence_spans: []});
  assert.deepEqual(result.evidence_spans, a.evidence_spans);
  const cases = Array.from({length: 80}, (_, i) => ({id: String(i), cohort: 'sampled_development', group_id: 'g' + i}));
  const labels = Object.fromEntries(cases.map((c, i) => [c.id, {review_status: i < 72 ? 'accepted' : 'uncertain', usefulness: i < 20 ? 'durable_memory' : i < 40 ? 'operational_history_only' : 'not_useful'}]));
  assert.equal(supportSummary(cases, labels).pass, true);
  labels['39'].usefulness = 'not_useful'; assert.equal(supportSummary(cases, labels).pass, false);
});
