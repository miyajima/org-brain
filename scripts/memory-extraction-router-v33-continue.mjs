import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hash, validateManifest, consensus, supportSummary } from './memory-extraction-router-v33-core.mjs';
import { buildReviewRequest, REVIEW_MODELS, createCloudClient, validateReview, profileReviewRequest } from './memory-extraction-router-v33-cloud.mjs';
import { inspectReviewState, writePrivate } from './memory-extraction-router-v33.mjs';

function read(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw Error('private_file_required');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function sealed(data) { return { ...data, content_hash: hash(data) }; }
function verify(data) {
  const { content_hash, ...body } = data;
  if (content_hash !== hash(body)) throw Error('checkpoint_hash_mismatch');
  return data;
}
function inactiveLock(file) {
  if (!fs.existsSync(file)) return;
  const { pid } = read(file);
  if (!Number.isInteger(pid) || pid <= 0) throw Error('invalid_lock_pid');
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
  throw Error('source_run_still_active');
}

// An explicit continuation never edits or clears the source run's failure/claim ledger.
export function prepareContinuation(manifestFile, diagnosticDir, outputDir) {
  const m = validateManifest(read(manifestFile));
  for (const source of Object.values(m.sources)) if (hash(fs.readFileSync(source.path, 'utf8')) !== source.hash) throw Error('source_hash_mismatch');
  const sourceDir = path.dirname(manifestFile);
  inactiveLock(path.join(sourceDir, 'review.lock'));
  const oldState = inspectReviewState(sourceDir, m);
  const diagnostic = read(path.join(diagnosticDir, 'request.json'));
  const diagnosticResponse = read(path.join(diagnosticDir, 'response.json'));
  const diagnosticCase = m.cases.find(c => c.id === diagnostic.case_id);
  const luna = REVIEW_MODELS[1];
  if (!diagnosticCase || diagnostic.manifest_hash !== m.manifest_hash || hash(diagnostic.request) !== hash(buildReviewRequest(diagnosticCase, luna, { maxOutputTokens: 16384 }))) throw Error('diagnostic_request_mismatch');
  const raw = JSON.parse(diagnosticResponse.raw);
  if (diagnosticResponse.http_status !== 200 || raw.model !== luna.id || raw.reasoning?.effort !== luna.effort) throw Error('diagnostic_response_mismatch');
  const diagnosticAnswer = validateReview(raw, diagnosticCase);
  const jobs = [];
  for (const item of m.cases.filter(c => !c.hard_excluded)) for (const model of REVIEW_MODELS) {
    const oldHash = hash(buildReviewRequest(item, model));
    const maxOutputTokens = model.id === luna.id ? 16384 : 8192;
    const request = buildReviewRequest(item, model, { maxOutputTokens });
    const job = { case_id: item.id, model, maxOutputTokens, request_hash: hash(request), profile: profileReviewRequest(request), disposition: 'pending' };
    let unknown = false, failed = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const stem = path.join(sourceDir, 'reviews', `${oldHash.slice(7)}-${attempt}`);
      if (fs.existsSync(`${stem}.json`)) {
        const record = verify(read(`${stem}.json`));
        if (record.manifest_hash !== m.manifest_hash || record.request_hash !== oldHash || record.case_id !== item.id || record.model !== model.id) throw Error('source_checkpoint_mismatch');
        if (record.ok) { job.disposition = 'reused'; job.annotation = validateReview(record.response.annotation, item); job.source = { file: `${stem}.json`, hash: hash(record), original_request_hash: oldHash }; }
        else failed = true;
      } else if (fs.existsSync(`${stem}.claim.json`)) unknown = true;
    }
    if (unknown) { job.disposition = 'quarantined_unknown'; delete job.annotation; }
    else if (item.id === diagnostic.case_id && model.id === luna.id) {
      job.disposition = 'reused'; job.annotation = diagnosticAnswer;
      job.source = { file: path.join(diagnosticDir, 'response.json'), hash: hash(diagnosticResponse), original_request_hash: hash(diagnostic.request) };
    } else if (failed && job.disposition !== 'reused') throw Error('unresolved_failure_requires_action');
    jobs.push(job);
  }
  const pending = jobs.filter(j => j.disposition === 'pending');
  const plan = sealed({ contract: 'router-v33-review-continuation/v1', manifest_file: path.resolve(manifestFile), manifest_hash: m.manifest_hash, source_state: oldState, jobs,
    maximum_new_requests: pending.length * 2, maximum_output_tokens: pending.reduce((n, j) => n + j.maxOutputTokens * 2, 0),
    original_run_unchanged: true, unresolved_unknowns_block_training: true });
  fs.mkdirSync(outputDir, { mode: 0o700 });
  writePrivate(path.join(outputDir, 'continuation.json'), plan);
  return plan;
}

export async function runContinuation(outputDir, client = createCloudClient()) {
  const stat = fs.lstatSync(outputDir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw Error('private_directory_required');
  const plan = verify(read(path.join(outputDir, 'continuation.json')));
  const m = validateManifest(read(plan.manifest_file));
  if (m.manifest_hash !== plan.manifest_hash) throw Error('manifest_changed');
  for (const source of Object.values(m.sources)) if (hash(fs.readFileSync(source.path, 'utf8')) !== source.hash) throw Error('source_hash_mismatch');
  // Scan before preflight; any interrupted continuation remains stopped.
  for (const j of plan.jobs) {
    const item = m.cases.find(c => c.id === j.case_id);
    if (!item || item.hard_excluded || hash(buildReviewRequest(item, j.model, { maxOutputTokens: j.maxOutputTokens })) !== j.request_hash) throw Error('continuation_job_mismatch');
    if (j.disposition === 'reused') {
      if (hash(read(j.source.file)) !== j.source.hash) throw Error('reused_checkpoint_changed');
      validateReview(j.annotation, item);
    }
    if (j.disposition !== 'pending') continue;
    let failed = false, succeeded = false;
    for (let a = 1; a <= 2; a++) {
      const stem = path.join(outputDir, `${j.request_hash.slice(7)}-${a}`);
      if (fs.existsSync(`${stem}.claim.json`) && !fs.existsSync(`${stem}.json`)) throw Error('continuation_outcome_unknown');
      if (fs.existsSync(`${stem}.json`)) {
        const saved = verify(read(`${stem}.json`));
        if (saved.request_hash !== j.request_hash) throw Error('continuation_checkpoint_mismatch');
        if (saved.ok) { validateReview(saved.response.annotation, item); succeeded = true; }
        else failed = true;
      }
    }
    if (failed && !succeeded) throw Error('continuation_failure_requires_action');
  }
  if (fs.existsSync(path.join(outputDir, 'partial-labels.json'))) return { status: verify(read(path.join(outputDir, 'partial-labels.json'))).status, resumed: true };
  const lock = path.join(outputDir, 'review.lock');
  writePrivate(lock, { pid: process.pid });
  try {
    await client.preflight();
    const answers = new Map();
    let completed = 0;
    for (const job of plan.jobs) {
      if (job.disposition === 'quarantined_unknown') continue;
      const item = m.cases.find(c => c.id === job.case_id);
      const key = `${job.case_id}:${job.model.id}`;
      if (job.disposition === 'reused') {
        if (hash(read(job.source.file)) !== job.source.hash) throw Error('reused_checkpoint_changed');
        answers.set(key, validateReview(job.annotation, item));
      } else {
        for (let attempt = 1; attempt <= 2; attempt++) {
          const stem = path.join(outputDir, `${job.request_hash.slice(7)}-${attempt}`);
          let saved;
          if (fs.existsSync(`${stem}.json`)) { saved = verify(read(`${stem}.json`)); if (!saved.ok && attempt === 1) continue; }
          else {
            writePrivate(`${stem}.claim.json`, { manifest_hash: m.manifest_hash, request_hash: job.request_hash, attempt });
            try {
              const response = await client.review(item, job.model, { maxOutputTokens: job.maxOutputTokens });
              saved = sealed({ ok: true, request_hash: job.request_hash, response });
              writePrivate(`${stem}.json`, saved);
            } catch (error) {
              writePrivate(`${stem}.json`, sealed({ ok: false, request_hash: job.request_hash, error_code: error.code ?? 'review_error', diagnostics: error.diagnostics ?? null, raw_response: error.raw_response ?? null }));
              if (error.retryable === true && attempt === 1 && error.code !== 'openai_transport_error') continue;
              throw error;
            }
          }
          if (saved.request_hash !== job.request_hash || !saved.ok) throw Error('continuation_checkpoint_mismatch');
          answers.set(key, validateReview(saved.response.annotation, item));
          break;
        }
      }
      completed++;
      process.stdout.write(JSON.stringify({ completed, total: plan.jobs.length, quarantined: plan.jobs.filter(j => j.disposition === 'quarantined_unknown').length }) + '\n');
    }
    const annotations = {};
    for (const item of m.cases) annotations[item.id] = consensus(item, answers.get(`${item.id}:${REVIEW_MODELS[0].id}`), answers.get(`${item.id}:${REVIEW_MODELS[1].id}`));
    const quarantined = plan.jobs.filter(j => j.disposition === 'quarantined_unknown').length;
    const result = sealed({ status: quarantined ? 'cloud_not_ready' : 'reviews_completed', unresolved_job_errors: quarantined, annotations, support: supportSummary(m.cases, annotations), manifest_hash: m.manifest_hash, continuation_hash: plan.content_hash });
    writePrivate(path.join(outputDir, 'partial-labels.json'), result);
    return { status: result.status, completed, quarantined, support: result.support };
  } finally { fs.unlinkSync(lock); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, manifest, diagnostic, output] = process.argv.slice(2);
  const task = command === 'prepare' && manifest && diagnostic && output
    ? Promise.resolve().then(() => { const p = prepareContinuation(manifest, diagnostic, output); return { jobs: p.jobs.length, reused: p.jobs.filter(j => j.disposition === 'reused').length, quarantined: p.jobs.filter(j => j.disposition === 'quarantined_unknown').length, maximum_new_requests: p.maximum_new_requests, maximum_output_tokens: p.maximum_output_tokens }; })
    : command === 'run' && manifest ? runContinuation(manifest) : Promise.reject(Error('usage: prepare MANIFEST DIAGNOSTIC_DIR NEW_DIR | run CONTINUATION_DIR'));
  task.then(r => console.log(JSON.stringify(r))).catch(e => { console.error(JSON.stringify({ status: 'stopped', reason: e.code ?? e.message })); process.exitCode = 1; });
}
