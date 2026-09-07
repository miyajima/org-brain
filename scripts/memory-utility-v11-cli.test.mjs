import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {
  CLI_ACTIVE_CONTRACT,
  CLI_ATTEMPTS_CONTRACT,
  CLI_REQUEST_CONTRACT,
  CLI_RUNNER_CONTRACT,
  CLI_ROOT,
  EVALUATION_OUTPUT_SCHEMA,
  REPLAY_OUTPUT_SCHEMA,
  C_TRANSPORT_OUTPUT_SCHEMA,
  RUNNER_HASH,
  SCHEMA_HASHES,
  assertSupportedOutputSchema,
  runCli,
  schemaForJob
} from './memory-utility-v11-cli.mjs';
import {hash} from './memory-extraction-router-v33-core.mjs';
import {MEMORY_EXTRACTION_OUTPUT_SCHEMA} from '../packages/shared/src/memory-extraction-provider-contract-runtime.mjs';

const rawFinal = '{"answer":"ok","used_memory_ids":[]}';

function fixture(sequence = ['final']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-utility-v11-cli-'));
  fs.chmodSync(root, 0o700);
  const id = `job-${Math.random().toString(36).slice(2, 10)}`;
  const promptPath = path.join(root, 'dispatch.txt');
  const schemaPath = path.join(root, 'schema.json');
  const attemptsPath = path.join(root, 'attempts.json');
  const activePath = path.join(root, 'active.json');
  const prompt = 'synthetic public smoke prompt';
  fs.writeFileSync(promptPath, prompt, {mode: 0o600});
  fs.writeFileSync(schemaPath, `${JSON.stringify(REPLAY_OUTPUT_SCHEMA, null, 2)}\n`, {mode: 0o600});
  const job = {id, prompt, content_hash: `sha256:${id}`, schema_hash: hash(REPLAY_OUTPUT_SCHEMA), private: {stage: 'replay', method: 'A'}};
  const activeBody = {contract: CLI_ACTIVE_CONTRACT, job_id: id, job_hash: job.content_hash, prompt_hash: hash(prompt), schema_hash: job.schema_hash, runner_hash: RUNNER_HASH, prepared_at: '2026-09-06T00:00:00.000Z'};
  const active = {...activeBody, content_hash: hash(activeBody)};
  fs.writeFileSync(activePath, `${JSON.stringify(active)}\n`, {mode: 0o600});
  const request = {contract: CLI_REQUEST_CONTRACT, job_hash: job.content_hash, prompt_hash: hash(prompt), prompt_path: promptPath, schema_path: schemaPath, schema_hash: job.schema_hash, runner_hash: RUNNER_HASH, attempts_path: attemptsPath, active_path: activePath, model: 'gpt-5.6-sol', effort: 'medium', cwd: CLI_ROOT, sandbox: 'read-only', timeout_ms: 300_000, max_attempts: 2, prepared_at: active.prepared_at, active_hash: active.content_hash};
  const modes = [];
  const tracker = {active: 0, maxActive: 0, closeTimes: [], startTimes: []};
  const script = `const fs=require('node:fs');const mode=process.env.SMOKE_MODE;const out=process.env.SMOKE_OUTPUT;const raw=process.env.SMOKE_RAW;const id=process.env.SMOKE_SESSION;const events=[{type:'thread.started',thread_id:id},{type:'turn.started'}];if(mode==='final'||mode==='malformed')events.push({type:'item.completed',item:{type:'agent_message',text:raw}});if(mode!=='timeout')events.push({type:'turn.completed',usage:mode==='communication'?{}:{input_tokens:7,output_tokens:4}});process.stdout.write(events.map(JSON.stringify).join('\\n')+'\\n');if(mode==='final'||mode==='malformed'||mode==='output-only')fs.writeFileSync(out,raw);if(mode==='communication'){process.stderr.write('connection reset by peer\\n');process.exit(1)}if(mode==='config'){process.stderr.write('unknown option --output-schema\\n');process.exit(2)}if(mode==='timeout')setTimeout(()=>{},10000);`;
  const spawnImpl = (executable, args, options) => {
    const index = modes.length;
    const mode = sequence[index] ?? sequence.at(-1);
    const session = `01a00000-0000-7000-8000-0000000000${index + 1}`;
    const output = args[args.indexOf('-o') + 1];
    modes.push({mode, session, raw: mode === 'malformed' || mode === 'native-only' ? 'not-json' : mode === 'output-only' ? ' \n\t' : rawFinal});
    tracker.active += 1;
    tracker.maxActive = Math.max(tracker.maxActive, tracker.active);
    tracker.startTimes.push(Date.now());
    const child = spawn(process.execPath, ['-e', script], {...options, env: {...options.env, SMOKE_MODE: mode, SMOKE_OUTPUT: output, SMOKE_RAW: modes.at(-1).raw, SMOKE_SESSION: session}});
    child.once('close', () => {tracker.active -= 1;tracker.closeTimes.push(Date.now());});
    return child;
  };
  const nativeInspector = async sessionId => {
    const mode = modes.find(item => item.session === sessionId);
    if (!mode) return {status: 'unavailable', finals: [], usage: {}};
    return {status: 'available', session_id: sessionId, log: `/synthetic/${sessionId}.jsonl`, finals: ['final', 'malformed', 'native-only'].includes(mode.mode) ? [{text: mode.raw, source: 'native'}] : [], common_memory_hash: 'sha256:common', usage: {input_tokens: 7, output_tokens: 4}};
  };
  return {root, id, job, request, schema: REPLAY_OUTPUT_SCHEMA, sequence, modes, tracker, spawnImpl, nativeInspector};
}

function runFixture(fx, options = {}) {
  return runCli({root: fx.root, request: fx.request, job: fx.job, schema: fx.schema, spawnImpl: fx.spawnImpl, nativeInspector: fx.nativeInspector, nativeWaitMs: 1, killGraceMs: options.killGraceMs ?? 100, timeoutMs: options.timeoutMs ?? 1_000});
}

test('transport schemas for C, B, replay, and evaluate use the supported subset', () => {
  for (const schema of [C_TRANSPORT_OUTPUT_SCHEMA, MEMORY_EXTRACTION_OUTPUT_SCHEMA, REPLAY_OUTPUT_SCHEMA, EVALUATION_OUTPUT_SCHEMA]) assertSupportedOutputSchema(schema);
  assert.equal(Object.keys(SCHEMA_HASHES).sort().join(','), 'calibrate-c,evaluate,extract-b,extract-c,replay');
  assert.equal(schemaForJob({private: {stage: 'replay', method: 'A'}}), REPLAY_OUTPUT_SCHEMA);
  assert.equal(schemaForJob({private: {stage: 'extract', method: 'B'}}), MEMORY_EXTRACTION_OUTPUT_SCHEMA);
  assert.equal(schemaForJob({private: {stage: 'extract', method: 'C'}}), C_TRANSPORT_OUTPUT_SCHEMA);
  assert.equal(schemaForJob({private: {stage: 'evaluate'}}), EVALUATION_OUTPUT_SCHEMA);
});

test('successful structured CLI run captures exact route, output, stderr, and usage once', async () => {
  const fx = fixture(['final']);
  const result = await runFixture(fx);
  assert.equal(result.status, 'final_available', JSON.stringify(result));
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].retry.retryable, false);
  assert.deepEqual(result.attempts[0].usage, {input_tokens: 7, output_tokens: 4, cached_input_tokens: null, reasoning_tokens: null, total_tokens: null});
  assert.equal(fx.tracker.maxActive, 1);
  const args = result.attempts[0].args;
  assert.deepEqual(args.slice(0, 5), ['exec', '-C', CLI_ROOT, '-s', 'read-only']);
  assert.ok(args.includes('--output-schema'));
  for (const file of [result.attempts[0].events_path, result.attempts[0].output_path, result.attempts[0].stderr_path, result.attempts_path]) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a malformed final is final evidence and is never retried', async () => {
  const fx = fixture(['malformed', 'final']);
  const result = await runFixture(fx);
  assert.equal(result.status, 'final_available', JSON.stringify(result));
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].final_present, true);
  assert.equal(result.attempts[0].retry.reason, 'final_present');
});

test('a whitespace-only output artifact is final evidence and is never retried', async () => {
  const fx = fixture(['output-only', 'final']);
  const result = await runFixture(fx);
  assert.equal(result.status, 'final_available');
  assert.equal(result.attempts.length, 1);
  assert.deepEqual(result.attempts[0].final_sources, ['output']);
  assert.equal(result.attempts[0].retry.reason, 'final_present');
});

test('a malformed native-only final is final evidence and is never retried', async () => {
  const fx = fixture(['native-only', 'final']);
  const result = await runFixture(fx);
  assert.equal(result.status, 'final_available');
  assert.equal(result.attempts.length, 1);
  assert.deepEqual(result.attempts[0].final_sources, ['native']);
  assert.equal(result.attempts[0].retry.reason, 'final_present');
});

test('a proven absent-final transport failure gets exactly one fresh-session retry', async () => {
  const fx = fixture(['communication', 'final']);
  const result = await runFixture(fx);
  assert.equal(result.status, 'final_available');
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].retry.retryable, true);
  assert.equal(result.attempts[0].retry.status, 'communication_failure');
  assert.equal(result.attempts[1].attempt, 2);
  assert.notEqual(result.attempts[0].session_id, result.attempts[1].session_id);
});

test('timeout terminates the process group and waits for quiescence before retry', async () => {
  const fx = fixture(['timeout', 'final']);
  const result = await runFixture(fx, {timeoutMs: 250, killGraceMs: 100});
  assert.equal(result.status, 'final_available');
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].timed_out, true);
  assert.equal(result.attempts[0].quiesced, true);
  assert.equal(result.attempts[0].retry.retryable, true);
  assert.equal(fx.tracker.maxActive, 1);
  assert.ok(fx.tracker.startTimes[1] >= fx.tracker.closeTimes[0]);
});

test('a leader that exits early cannot leave a descendant process running', async () => {
  const fx = fixture(['unknown']);
  const descendantPath = path.join(fx.root, 'descendant.pid');
  const session = '01a00000-0000-7000-8000-000000000099';
  const script = [
    "const fs=require('node:fs');",
    "const {spawn}=require('node:child_process');",
    "const descendant=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},10000)\"],{stdio:'inherit'});",
    "fs.writeFileSync(process.env.DESCENDANT_PATH,String(descendant.pid));",
    "process.stdout.write(JSON.stringify({type:'thread.started',thread_id:process.env.SESSION})+'\\n');",
    "process.exit(0);"
  ].join('');
  fx.spawnImpl = (executable, args, options) => spawn(process.execPath, ['-e', script], {
    ...options,
    env: {...options.env, DESCENDANT_PATH: descendantPath, SESSION: session}
  });
  fx.nativeInspector = async sessionId => ({status: 'unavailable', session_id: sessionId, finals: [], usage: {}});
  let descendantPid = null;
  try {
    const result = await runCli({root: fx.root, request: fx.request, job: fx.job, schema: fx.schema, spawnImpl: fx.spawnImpl, nativeInspector: fx.nativeInspector, nativeWaitMs: 1, timeoutMs: 2_000, killGraceMs: 100});
    assert.equal(result.status, 'held');
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].quiesced, true);
    descendantPid = Number(fs.readFileSync(descendantPath, 'utf8'));
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.throws(() => process.kill(descendantPid, 0), error => error?.code === 'ESRCH');
  } finally {
    if (descendantPid) {
      try { process.kill(descendantPid, 'SIGKILL'); } catch {}
    }
  }
});

test('unknown or configuration failures are held without retry', async () => {
  for (const mode of ['config', 'unknown']) {
    const fx = fixture([mode, 'final']);
    const result = await runFixture(fx);
    assert.equal(result.status, 'held');
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].retry.retryable, false);
  }
});
