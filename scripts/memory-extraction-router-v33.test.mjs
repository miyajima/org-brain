import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hash, createManifest } from './memory-extraction-router-v33-core.mjs';
import { buildReviewRequest, REVIEW_MODELS, createCloudClient } from './memory-extraction-router-v33-cloud.mjs';
import { reviewRun, writePrivate, main, inspectReviewState } from './memory-extraction-router-v33.mjs';
import { prepareContinuation, runContinuation } from './memory-extraction-router-v33-continue.mjs';

function runFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-v33-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'reviews'), { mode: 0o700 });
  const cases = Array.from({ length: 120 }, (_, i) => {
    const turns = [{ id: 's1', role: 'assistant', content: `作業番号 ${i} を確認しました。` }];
    return { id: `case-${i}`, group_id: `g${i}`, dataset_role: 'development', turns, source_hash: hash(turns), review_text_hash: hash(turns), cohort: i < 40 ? 'challenge' : 'sampled_development', prior_ai_exposure: 'ai_assisted', hard_excluded: false };
  });
  const m = createManifest(cases, { experimentId: 'test', sources: {}, fixtureHash: 'test' });
  return { dir, m };
}
function valid() { return { usefulness: 'operational_history_only', review_status: 'accepted', lesson_types: [], evidence_spans: [], future_use: '', outcome: 'episode_fragment', confidence: 'high', exclusion_reason: '' }; }

test('continuation reuses saved and diagnostic answers, quarantines unknown, and does not overwrite the source', async t => {
  const { dir, m } = runFixture(t);
  const seal = body => ({ ...body, content_hash: hash(body) });
  const manifest = path.join(dir, 'manifest.json'); writePrivate(manifest, m);
  const oldHash = hash(buildReviewRequest(m.cases[0], REVIEW_MODELS[0]));
  const oldFile = path.join(dir, 'reviews', `${oldHash.slice(7)}-1.json`);
  writePrivate(oldFile, seal({ manifest_hash: m.manifest_hash, request_hash: oldHash, case_id: m.cases[0].id, model: REVIEW_MODELS[0].id, ok: true, response: { annotation: valid() } }));
  const before = fs.readFileSync(oldFile);
  const unknownHash = hash(buildReviewRequest(m.cases[1], REVIEW_MODELS[1]));
  writePrivate(path.join(dir, 'reviews', `${unknownHash.slice(7)}-1.claim.json`), {});
  const diag = path.join(dir, 'diagnostic'); fs.mkdirSync(diag, { mode: 0o700 });
  writePrivate(path.join(diag, 'request.json'), { manifest_hash: m.manifest_hash, case_id: m.cases[0].id, request: buildReviewRequest(m.cases[0], REVIEW_MODELS[1], { maxOutputTokens: 16384 }) });
  writePrivate(path.join(diag, 'response.json'), { http_status: 200, raw: JSON.stringify({ status: 'completed', model: REVIEW_MODELS[1].id, reasoning: { effort: 'max' }, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(valid()) }] }] }) });
  const output = path.join(dir, 'continuation');
  const plan = prepareContinuation(manifest, diag, output);
  assert.equal(plan.jobs.filter(j => j.disposition === 'reused').length, 2);
  assert.equal(plan.jobs.filter(j => j.disposition === 'quarantined_unknown').length, 1);
  assert.throws(() => prepareContinuation(manifest, diag, output), /EEXIST/);
  const aborted = path.join(dir, 'aborted-continuation');
  prepareContinuation(manifest, diag, aborted);
  let posts = 0;
  const interruptedClient = createCloudClient({ apiKey: 'test', fetchImpl: async (url, options) => {
    if (options.method === 'GET') return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id: decodeURIComponent(url.split('/').pop()) }) };
    posts++;
    return { ok: true, status: 200, headers: { get: () => 'request-id' }, json: async () => { throw Object.assign(new Error('body interrupted'), { name: 'AbortError' }); } };
  } });
  let calls = 0;
  const client = { preflight: async () => ({}), review: async (c, model, options) => {
    calls++;
    assert.notEqual(c.id + model.id, m.cases[1].id + REVIEW_MODELS[1].id);
    assert.equal(options.maxOutputTokens, model.id === REVIEW_MODELS[1].id ? 16384 : 8192);
    return { annotation: valid() };
  } };
  const write = process.stdout.write; process.stdout.write = () => true;
  try {
    await assert.rejects(runContinuation(aborted, interruptedClient), /openai_transport_error/);
    assert.equal(posts, 1);
    await assert.rejects(runContinuation(aborted, { preflight: () => { throw Error('must_not_call'); } }), /continuation_failure_requires_action/);
    const result = await runContinuation(output, client);
    assert.equal(calls, 237); assert.equal(result.quarantined, 1); assert.equal(result.status, 'cloud_not_ready');
    await runContinuation(output, { preflight: () => { throw Error('must_not_call'); } });
    assert.equal(fs.existsSync(path.join(dir, 'labels.json')), false);
    assert.deepEqual(fs.readFileSync(oldFile), before);
    assert.equal(fs.statSync(path.join(output, 'partial-labels.json')).mode & 0o077, 0);
  } finally { process.stdout.write = write; }
});

test('missing API key stops before network or attempts; manifest is mandatory', async t => {
  const { dir, m } = runFixture(t);
  let called = false;
  await assert.rejects(reviewRun(dir, m, createCloudClient({ apiKey: '', fetchImpl: () => { called = true; } })), /openai_api_key_missing/);
  assert.equal(called, false);
  assert.equal(fs.readdirSync(path.join(dir, 'reviews')).length, 0);
  await assert.rejects(main(['review']), /manifest/);
});

test('review checkpoints resume success, cap error retries, preserve original answers', async t => {
  const { dir, m } = runFixture(t);
  let calls = 0;
  const client = { preflight: async () => ({ verified: true }), review: async () => { calls++; return { annotation: valid(), raw: { model: 'mock' } }; } };
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    const first = await reviewRun(dir, m, client);
    assert.equal(calls, 240);
    assert.equal(first.status, 'insufficient_ai_review_support');
    const bytes = fs.readFileSync(path.join(dir, 'labels.json'));
    await reviewRun(dir, m, client);
    assert.equal(calls, 240);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'labels.json')), bytes);
    assert.throws(() => writePrivate(path.join(dir, 'labels.json'), {}), /EEXIST/);
    assert.equal(fs.statSync(path.join(dir, 'labels.json')).mode & 0o077, 0);
  } finally { process.stdout.write = originalWrite; }
});

test('unknown in-flight outcome is never automatically resent', async t => {
  const { dir, m } = runFixture(t);
  const requestHash = hash(buildReviewRequest(m.cases[0], REVIEW_MODELS[0]));
  writePrivate(path.join(dir, 'reviews', `${requestHash.slice(7)}-1.claim.json`), {});
  let calls = 0;
  await assert.rejects(reviewRun(dir, m, { preflight: async () => ({}), review: async () => { calls++; } }), /outcome_unknown/);
  assert.equal(calls, 0);
});

test('retry exhaustion stops the entire run after two attempts and restart sends nothing', async t => {
  const { dir, m } = runFixture(t);
  let calls = 0;
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    const client = { preflight: async () => ({}), review: async () => { calls++; throw Object.assign(new Error('schema'), { code: 'schema', retryable: true }); } };
    await assert.rejects(reviewRun(dir, m, client), /review_retry_exhausted/);
    assert.equal(calls, 2);
    const state = inspectReviewState(dir, m);
    assert.equal(state.exhausted_jobs, 1);
    assert.equal(state.failed_responses, 2);
    await assert.rejects(reviewRun(dir, m, { preflight: () => { throw new Error('must_not_preflight'); } }), /review_retry_exhausted/);
    assert.equal(fs.existsSync(path.join(dir, 'labels.json')), false);
  } finally { process.stdout.write = originalWrite; }
});

test('output-limit failure is saved with diagnostics and never retried or advanced', async t => {
  const { dir, m } = runFixture(t);
  let calls = 0;
  const diagnostic = { incomplete_reason: 'max_output_tokens', output_tokens: 8192, reasoning_tokens: 8192 };
  const client = { preflight: async () => ({}), review: async () => { calls++; throw Object.assign(new Error('limit'), { code: 'review_output_limit_exceeded', retryable: false, diagnostics: diagnostic, raw_response: { status: 'incomplete' }, request_id: 'req-test' }); } };
  await assert.rejects(reviewRun(dir, m, client), /limit/);
  assert.equal(calls, 1);
  const state = inspectReviewState(dir, m);
  assert.equal(state.permanent_failures, 1);
  assert.deepEqual(state.failures[0].diagnostics, diagnostic);
  assert.equal(state.lock_present, false);
  await assert.rejects(reviewRun(dir, m, { preflight: () => { throw new Error('must_not_preflight'); } }), /review_permanent_failure/);
});

test('unknown outcome anywhere in run blocks before preflight even when earlier jobs are pending', async t => {
  const { dir, m } = runFixture(t);
  const key = hash(buildReviewRequest(m.cases.at(-1), REVIEW_MODELS[1]));
  writePrivate(path.join(dir, 'reviews', `${key.slice(7)}-1.claim.json`), {});
  await assert.rejects(reviewRun(dir, m, { preflight: () => { throw new Error('must_not_preflight'); } }), /outcome_unknown/);
  assert.equal(inspectReviewState(dir, m).unknown_outcomes, 1);
});
