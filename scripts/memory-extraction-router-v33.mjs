#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  hash, prepareCases, createManifest, validateManifest, consensus, supportSummary,
  channelText, trainNested, compareEvidence, v2Result, pairedBootstrap, summarize, developmentGate, safetySplitAudit,
} from './memory-extraction-router-v33-core.mjs';
import { buildV32SafetyFixture, evaluateV32SafetyFixture, validateV32SafetyGate } from './memory-extraction-router-v32.mjs';
import { REVIEW_MODELS, buildReviewRequest, createCloudClient, validateReview } from './memory-extraction-router-v33-cloud.mjs';

function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function digestFile(file) { return hash(fs.readFileSync(file, 'utf8')); }
export function writePrivate(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
function sealed(data) { return { ...data, content_hash: hash(data) }; }
function verify(data) {
  const { content_hash, ...body } = data;
  if (hash(body) !== content_hash) throw new Error('artifact_hash_mismatch');
  return data;
}
function bound(data, manifest) {
  verify(data);
  if (data.manifest_hash !== manifest.manifest_hash) throw new Error('artifact_manifest_mismatch');
  return data;
}
function save(dir, name, body, manifest) { writePrivate(path.join(dir, name), sealed({ ...body, manifest_hash: manifest.manifest_hash })); }
function load(dir, name, m) { return bound(read(safeFile(dir, name)), m); }
function privateDirectory(dir) {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('private_directory_required');
}
function ensureFolder(dir) { fs.mkdirSync(dir, { mode: 0o700 }); }
function safeFile(dir, name) {
  const file = path.join(dir, name);
  if (fs.existsSync(file) && (fs.lstatSync(file).isSymbolicLink() || (fs.statSync(file).mode & 0o077))) throw new Error('private_regular_file_required');
  return file;
}
function loadManifest(file) {
  privateDirectory(path.dirname(file)); safeFile(path.dirname(file), path.basename(file));
  const m = validateManifest(read(file));
  for (const folder of ['reviews', 'embeddings', 'embedding-batches']) privateDirectory(path.join(path.dirname(file), folder));
  for (const s of Object.values(m.sources)) if (digestFile(s.path) !== s.hash) throw new Error('original_source_file_changed');
  return m;
}

export function prepareRun(manifestPath, sourcePath, legacyPath, challengePath) {
  if ([sourcePath, legacyPath, challengePath].some(p => !p)) throw new Error('prepare_sources_required');
  if (fs.existsSync(manifestPath)) throw new Error('run_overwrite_forbidden');
  const dir = path.dirname(manifestPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
  privateDirectory(dir);
  if (fs.readdirSync(dir).length) throw new Error('new_empty_run_directory_required');
  const source = read(sourcePath), legacy = read(legacyPath), challenge = read(challengePath);
  const cases = prepareCases(source.cases, challenge, legacy);
  const fixture = buildV32SafetyFixture();
  safetySplitAudit(fixture);
  const m = createManifest(cases, { experimentId: `router-v33-${hash(cases).slice(7, 23)}`, sources: Object.fromEntries([['source', sourcePath], ['legacy_manifest', legacyPath], ['challenge', challengePath]].map(([k, p]) => [k, { path: path.resolve(p), hash: digestFile(p) }])), fixtureHash: fixture.fixture_sha256 });
  writePrivate(manifestPath, m);
  save(dir, 'safety-fixture.json', { fixture }, m);
  const safety = evaluateV32SafetyFixture(fixture);
  if (!validateV32SafetyGate(safety).pass) throw new Error('frozen_safety_gate_failed');
  save(dir, 'safety.json', { safety }, m);
  for (const subdir of ['reviews', 'embeddings', 'embedding-batches']) ensureFolder(path.join(dir, subdir));
  const jobs = cases.filter(c => !c.hard_excluded).flatMap(c => REVIEW_MODELS.map(model => {
    const request = buildReviewRequest(c, model);
    return { case_id: c.id, model: model.id, input_hash: hash(request), input_tokens_upper_bound: Buffer.byteLength(JSON.stringify(request), 'utf8'), output_tokens_max: 8192 };
  }));
  save(dir, 'token-profile.json', { contract: 'router-v33-token-profile/v1', method: 'conservative UTF-8 bytes upper bound, not an exact tokenizer', logical_review_jobs: jobs.length, maximum_review_requests: jobs.length * 2, maximum_review_input_tokens: jobs.reduce((s, j) => s + j.input_tokens_upper_bound * 2, 0), maximum_review_output_tokens: jobs.length * 2 * 8192, jobs, api_billing_required: true, external_calls: 0 }, m);
  return { status: 'prepared', cases: cases.length, challenge: 40, sampled_development: 80, groups: new Set(cases.map(c => c.group_id)).size, safety_pass: true, external_calls: 0, manifest: manifestPath };
}

function withLock(dir, stage, fn) {
  const lock = path.join(dir, `${stage}.lock`);
  writePrivate(lock, { pid: process.pid, stage });
  return Promise.resolve().then(fn).finally(() => fs.unlinkSync(lock));
}

export function inspectReviewState(dir, m) {
  const state = { successful_responses: 0, failed_responses: 0, unknown_outcomes: 0, exhausted_jobs: 0, permanent_failures: 0, lock_present: fs.existsSync(path.join(dir, 'review.lock')), failures: [] };
  for (const item of m.cases.filter(c => !c.hard_excluded)) for (const model of REVIEW_MODELS) {
    const requestHash = hash(buildReviewRequest(item, model));
    let failures = 0, permanent = 0, success = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const stem = `${requestHash.slice(7)}-${attempt}`;
      const file = safeFile(path.join(dir, 'reviews'), `${stem}.json`);
      if (!fs.existsSync(file)) {
        if (fs.existsSync(safeFile(path.join(dir, 'reviews'), `${stem}.claim.json`))) state.unknown_outcomes++;
        continue;
      }
      const saved = bound(read(file), m);
      if (saved.request_hash !== requestHash || saved.case_id !== item.id || saved.model !== model.id) throw new Error('review_checkpoint_mismatch');
      if (saved.ok) { validateReview(saved.response.annotation, item); state.successful_responses++; success = true; }
      else {
        failures++; state.failed_responses++;
        // Old incomplete checkpoints lack the reason; do not infer a token limit.
        if (!saved.retryable || saved.error_code === 'review_response_incomplete') permanent++;
        state.failures.push({ case_id: item.id, model: model.id, attempt, error_code: saved.error_code, diagnostics: saved.diagnostics ?? null });
      }
    }
    if (!success && failures >= 2) state.exhausted_jobs++;
    if (!success) state.permanent_failures += permanent;
  }
  state.blocked = state.lock_present || state.unknown_outcomes > 0 || state.exhausted_jobs > 0 || state.permanent_failures > 0;
  return state;
}

function assertReviewCanResume(state) {
  if (state.unknown_outcomes) throw new Error('review_attempt_outcome_unknown_no_automatic_resend');
  if (state.exhausted_jobs) throw new Error('review_retry_exhausted');
  if (state.permanent_failures) throw new Error('review_permanent_failure_requires_action');
  if (state.lock_present) throw new Error('review_lock_present_requires_inspection');
}

export async function reviewRun(dir, m, client = createCloudClient()) {
  assertReviewCanResume(inspectReviewState(dir, m));
  if (fs.existsSync(path.join(dir, 'labels.json'))) {
    const labels = load(dir, 'labels.json', m);
    return { status: labels.unresolved_job_errors ? 'cloud_review_failed' : labels.support.pass ? 'ai_reviews_ready' : 'insufficient_ai_review_support', support: labels.support, resumed: true };
  }
  return withLock(dir, 'review', async () => {
    const preflight = await client.preflight();
    const annotations = {};
    const unresolvedJobErrors = 0;
    for (const item of m.cases) {
      const answers = [];
      if (item.hard_excluded) {
        annotations[item.id] = { ...consensus(item, null, null), reason: 'safety_blocked_before_transmission' };
        continue;
      }
      for (const model of REVIEW_MODELS) {
        const requestHash = hash(buildReviewRequest(item, model));
        let answer = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
          const name = `${requestHash.slice(7)}-${attempt}`;
          const claim = safeFile(path.join(dir, 'reviews'), `${name}.claim.json`);
          const result = safeFile(path.join(dir, 'reviews'), `${name}.json`);
          if (fs.existsSync(result)) {
            const saved = bound(read(result), m);
            if (saved.request_hash !== requestHash || saved.case_id !== item.id || saved.model !== model.id) throw new Error('review_checkpoint_mismatch');
            if (saved.ok) { answer = validateReview(saved.response.annotation, item); break; }
            if (!saved.retryable) throw new Error(saved.error_code);
            continue;
          }
          if (fs.existsSync(claim)) throw new Error('review_attempt_outcome_unknown_no_automatic_resend');
          writePrivate(claim, { manifest_hash: m.manifest_hash, request_hash: requestHash, attempt });
          try {
            const response = await client.review(item, model);
            answer = validateReview(response.annotation, item);
            writePrivate(result, sealed({ manifest_hash: m.manifest_hash, request_hash: requestHash, case_id: item.id, model: model.id, attempt, ok: true, response }));
            break;
          } catch (error) {
            writePrivate(result, sealed({ manifest_hash: m.manifest_hash, request_hash: requestHash, case_id: item.id, model: model.id, attempt, ok: false, retryable: error.retryable === true, error_code: error.code ?? 'review_validation_or_transport_error', request_id: error.request_id ?? null, diagnostics: error.diagnostics ?? null, raw_response: error.raw_response ?? null }));
            if (error.retryable !== true) throw error;
            if (attempt === 2) throw new Error(`review_retry_exhausted:${error.code ?? 'review_validation_or_transport_error'}`);
          }
        }
        if (!answer) throw new Error('review_retry_exhausted');
        answers.push(answer);
      }
      annotations[item.id] = consensus(item, answers[0], answers[1]);
      process.stdout.write(JSON.stringify({ stage: 'review', completed: Object.keys(annotations).length, total: m.cases.length }) + '\n');
    }
    const support = supportSummary(m.cases, annotations);
    save(dir, 'labels.json', { contract: 'router-v33-labels/v1', annotations, support, preflight, unresolved_job_errors: unresolvedJobErrors }, m);
    return { status: unresolvedJobErrors ? 'cloud_review_failed' : support.pass ? 'ai_reviews_ready' : 'insufficient_ai_review_support', support, unresolved_job_errors: unresolvedJobErrors };
  });
}

export async function embedRun(dir, m, client = createCloudClient()) {
  const labels = load(dir, 'labels.json', m);
  if (labels.unresolved_job_errors) throw new Error('unresolved_review_errors');
  if (!supportSummary(m.cases, labels.annotations).pass) return { status: 'insufficient_ai_review_support', support: labels.support };
  if (fs.existsSync(path.join(dir, 'embedding-snapshot.json'))) { load(dir, 'embedding-snapshot.json', m); return { status: 'embeddings_ready', resumed: true }; }
  return withLock(dir, 'embed', async () => {
    await client.preflight();
    const entries = {};
    let cacheHits = 0, generated = 0;
    const started = performance.now();
    for (const item of m.cases) {
      entries[item.id] = {};
      if (item.hard_excluded) continue;
      for (const channel of ['all', 'user', 'assistant']) {
        const text = channelText(item, channel === 'all' ? null : channel);
        if (!text.trim()) continue;
        const cacheKey = hash({ provider: 'openai', model: 'text-embedding-3-large', dimensions: 1024, sanitizer: item.sanitizer, input_hash: hash(text), chunk: 'unicode1500-l2-charmean-v1' });
        const file = safeFile(path.join(dir, 'embeddings'), `${cacheKey.slice(7)}.json`);
        let record;
        if (fs.existsSync(file)) {
          record = verify(read(file)); cacheHits++;
          if (record.cache_key !== cacheKey || record.input_hash !== hash(text) || record.vector_hash !== hash(record.vector)) throw new Error('embedding_cache_mismatch');
        } else {
          const result = await client.embed(text, {
            loadBatch: key => {
              const p = safeFile(path.join(dir, 'embedding-batches'), `${hash(key).slice(7)}.json`);
              return fs.existsSync(p) ? verify(read(p)).batch : null;
            },
            saveBatch: (key, batch) => writePrivate(safeFile(path.join(dir, 'embedding-batches'), `${hash(key).slice(7)}.json`), sealed({ batch })),
          });
          record = sealed({ cache_key: cacheKey, input_hash: hash(text), vector: result.vector, vector_hash: hash(result.vector), provider: 'openai', model: 'text-embedding-3-large', dimensions: 1024, raw: result.raw });
          writePrivate(file, record); generated++;
        }
        entries[item.id][channel] = record;
      }
    }
    save(dir, 'embedding-snapshot.json', { contract: 'router-v33-embeddings/v1', entries, stats: { cache_hits: cacheHits, generated, cache_hit_rate: (cacheHits + generated) ? cacheHits / (cacheHits + generated) : null, elapsed_ms: performance.now() - started }, reproducibility: 'Actual vector snapshot; no immutable provider model digest claimed' }, m);
    return { status: 'embeddings_ready', cache_hits: cacheHits, generated };
  });
}

export function trainRun(dir, m) {
  const labels = load(dir, 'labels.json', m);
  if (labels.unresolved_job_errors) throw new Error('unresolved_review_errors');
  const support = supportSummary(m.cases, labels.annotations);
  if (!support.pass) return { status: 'insufficient_ai_review_support', support };
  if (support.maximum_durable_recall_at_cap < 0.95) return { status: 'development_gate_failed', reason: 'label_distribution_call_cap_infeasible', support };
  const embeddings = load(dir, 'embedding-snapshot.json', m);
  if (fs.existsSync(path.join(dir, 'training.json'))) throw new Error('training_overwrite_forbidden');
  const start = performance.now();
  const training = trainNested(m.cases, labels.annotations, embeddings.entries, m.folds);
  save(dir, 'training.json', { training, labels_hash: labels.content_hash, embeddings_hash: embeddings.content_hash, elapsed_ms: performance.now() - start }, m);
  return { status: 'training_complete', metrics: training.sampled, final_configuration: training.final_model.config };
}

export function reportRun(dir, m) {
  const fixture = load(dir, 'safety-fixture.json', m).fixture;
  const splitAudit = safetySplitAudit(fixture);
  if (fixture.fixture_sha256 !== m.fixture_hash) throw new Error('safety_fixture_binding_mismatch');
  const safety = evaluateV32SafetyFixture(fixture);
  if (!validateV32SafetyGate(safety).pass) throw new Error('safety_gate_failed');
  let report = { contract: 'router-v33-report/v1', evaluation_kind: 'ai_assisted_development', production_eligible: false, status: 'cloud_not_ready', default_router: 'v2', safety: safety.report, safety_split_audit: splitAudit, source_input_hash: m.input_hash, original_40_evidence_comparison: { legacy_only: true, v32: 0.929, v2: 0.214, comparable: false }, independent_holdout_opened: false, production_writes: 0 };
  if (fs.existsSync(path.join(dir, 'labels.json'))) {
    const labels = load(dir, 'labels.json', m);
    const support = supportSummary(m.cases, labels.annotations);
    report.support = support;
    report.status = labels.unresolved_job_errors ? 'cloud_not_ready' : support.pass ? 'awaiting_embeddings_or_training' : 'insufficient_ai_review_support';
    report.unresolved_job_errors = labels.unresolved_job_errors;
    if (support.pass && support.maximum_durable_recall_at_cap < 0.95) { report.status = 'development_gate_failed'; report.reason = 'label_distribution_call_cap_infeasible'; }
    if (fs.existsSync(path.join(dir, 'training.json'))) {
      const saved = load(dir, 'training.json', m), t = saved.training;
      const e = load(dir, 'embedding-snapshot.json', m);
      if (saved.labels_hash !== labels.content_hash || saved.embeddings_hash !== e.content_hash || t.final_model_hash !== hash(t.final_model)) throw new Error('training_input_binding_mismatch');
      const evidence = compareEvidence(m.cases.filter(c => c.cohort === 'sampled_development'), labels.annotations, t.outer_rows);
      const base = t.outer_rows.map(r => ({ ...r, route: v2Result(m.cases.find(c => c.id === r.case_id)).route }));
      const gate = developmentGate(t.sampled, evidence, safety);
      report = { ...report, status: gate.status, gates: gate, sampled: t.sampled, challenge: t.challenge, v2_sampled: summarize(base.filter(r => r.cohort === 'sampled_development')), evidence, paired_intervals: pairedBootstrap(t.outer_rows.filter(r => r.cohort === 'sampled_development'), base), exposure_groups: Object.fromEntries([...new Set(t.outer_rows.map(r => r.prior_ai_exposure))].map(exposure => [exposure, summarize(t.outer_rows.filter(r => r.prior_ai_exposure === exposure))])), embedding_stats: e.stats, training_elapsed_ms: saved.elapsed_ms, final_model_hash: t.final_model_hash };
      const errors = t.outer_rows.filter(r => r.review_status === 'accepted' && (r.usefulness === 'durable_memory' ? r.route !== 'llm_candidate' : r.usefulness === 'operational_history_only' ? r.route !== 'operational_history' : ['llm_candidate', 'operational_history'].includes(r.route)));
      if (!fs.existsSync(path.join(dir, 'error-queue.json'))) save(dir, 'error-queue.json', { rows: errors }, m);
    }
  } else report.reason = 'cloud_review_not_completed';
  report.review_execution = inspectReviewState(dir, m);
  if (report.review_execution.blocked) {
    report.status = 'cloud_not_ready';
    report.reason = report.review_execution.unknown_outcomes ? 'review_attempt_outcome_unknown_no_automatic_resend' : 'review_execution_blocked';
  }
  const name = `report-${hash(report).slice(7, 23)}.json`;
  if (!fs.existsSync(path.join(dir, name))) save(dir, name, report, m);
  return { ...report, report_path: path.join(dir, name) };
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  const value = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };
  if (!value('manifest') || !['prepare', 'review', 'embed', 'train', 'report', 'inspect'].includes(command)) throw new Error('usage: prepare|review|embed|train|report|inspect --manifest FILE');
  const file = path.resolve(value('manifest')), dir = path.dirname(file);
  if (command === 'prepare') return prepareRun(file, value('source'), value('legacy-manifest'), value('challenge'));
  const m = loadManifest(file);
  if (command === 'inspect') return inspectReviewState(dir, m);
  if (command === 'review') return reviewRun(dir, m);
  if (command === 'embed') return embedRun(dir, m);
  if (command === 'train') return trainRun(dir, m);
  return reportRun(dir, m);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(JSON.stringify({ status: 'stopped', reason: error.code ?? error.message })); process.exitCode = 1;
  });
}
