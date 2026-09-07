#!/usr/bin/env node

/*
 * One short, public synthetic transport smoke for the evaluation-only run.
 * It exercises the new evaluation schema and native codex-exec path without
 * loading any frozen case, replay, retrieval, or private project data.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';

import {
  CLI_ACTIVE_CONTRACT,
  CLI_REQUEST_CONTRACT,
  CLI_ROOT,
  RUNNER_HASH,
  runCli,
  assertSupportedOutputSchema
} from './memory-utility-v11-cli.mjs';
import {cliResult} from './memory-utility-v11-stages.mjs';
import {seal, verify} from './memory-utility-v11.mjs';
import {hash} from './memory-extraction-router-v33-core.mjs';
import {
  EVALUATION_ONLY_RUNNER_HASH,
  EVALUATION_ONLY_SCHEMA,
  EVALUATION_ONLY_SCHEMA_HASH,
  EVALUATION_ONLY_SMOKE_CODE_HASH,
  EVALUATION_ONLY_SMOKE_CONTRACT,
  validateEvaluationOnlyOutput
} from './memory-utility-v11-evaluation-only.mjs';

const TRANSPORT = 'codex_exec_stdin_v1';
const SMOKE_ID = 'synthetic-evaluation-only-smoke';
const ANSWERS = [
  {id: 'answer-1', text: '人工smokeの回答1です。'},
  {id: 'answer-2', text: '人工smokeの回答2です。'},
  {id: 'answer-3', text: '人工smokeの回答3です。'}
];
const SPEC = {answers: new Map(ANSWERS.map(answer => [answer.id, answer])), suppliedByAnswer: new Map(ANSWERS.map(answer => [answer.id, []])), evidenceIds: new Set()};

function fail(code) { throw new Error(code); }

function fileSha256(file) {
  if (!fs.existsSync(file)) return null;
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function readSealed(file) {
  try { return verify(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch (error) { fail(`smoke_json_invalid:${path.basename(file)}:${error.message}`); }
}

function writePrivate(file, value) {
  fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, {flag: 'wx', mode: 0o600});
  fs.chmodSync(file, 0o600);
}

function privateRoot(root) {
  const resolved = path.resolve(root);
  if (!fs.existsSync(resolved)) fail('smoke_run_missing');
  if (!fs.statSync(resolved).isDirectory() || (fs.statSync(resolved).mode & 0o777) !== 0o700) fail('smoke_private_directory_required');
  return resolved;
}

function privateTree(root) {
  const stat = fs.statSync(root);
  if (stat.isDirectory()) {
    if ((stat.mode & 0o777) !== 0o700) fail(`smoke_directory_not_private:${root}`);
    for (const name of fs.readdirSync(root)) privateTree(path.join(root, name));
  } else if ((stat.mode & 0o777) !== 0o600) fail(`smoke_file_not_private:${root}`);
}

function smokeOutput() {
  const metric = {rating: 'unknown', reason: '人工smokeでは評価対象を提示していないため不明です。', support_ids: []};
  return {
    answers: ANSWERS.map(answer => ({
      id: answer.id,
      metrics: {
        continuation: metric,
        constraints: metric,
        recurrence_prevention: metric,
        memory_harm: {
          rating: 'unknown',
          reason: '人工smokeでは回答とmemoryの因果関係を評価する材料がないため不明です。',
          support_ids: [],
          checked_answer_id: '',
          checked_memory_ids: [],
          problematic_answer_passage: '',
          causal_memory_id: '',
          constraint_support_ids: [],
          missing_evidence_reason: '人工smokeには供給memoryがないため因果関係を判定できません。'
        }
      },
      major_memory_errors: []
    })),
    extraction_issues: []
  };
}

function promptFor() {
  return [
    'これは公開の人工smokeテストです。個人情報、案件情報、非公開のcaseデータは含まれていません。',
    'ツール、ファイル操作、ネットワーク、外部知識、追加のエージェントを使用しないでください。',
    '以下のJSONを内容を変更せず、そのまま1つだけ返してください。Markdownのコードフェンスや説明文は付けないでください。',
    JSON.stringify(smokeOutput())
  ].join('\n');
}

function prepare(root) {
  const prompt = promptFor();
  const job = seal({
    id: SMOKE_ID,
    private: {stage: 'evaluate', case_id: 'synthetic-smoke'},
    prompt,
    input_bytes: Buffer.byteLength(prompt),
    expected_model: 'gpt-5.6-sol',
    expected_effort: 'medium',
    schema_hash: EVALUATION_ONLY_SCHEMA_HASH,
    runner_hash: RUNNER_HASH
  });
  const promptPath = path.join(root, 'dispatch.txt');
  const schemaPath = path.join(root, 'schema.json');
  const attemptsPath = path.join(root, 'cli-attempts.json');
  const activePath = path.join(root, 'active-cli.json');
  const requestPath = path.join(root, 'cli-request.json');
  writePrivate(path.join(root, 'job.json'), job);
  writePrivate(promptPath, prompt);
  writePrivate(schemaPath, `${JSON.stringify(EVALUATION_ONLY_SCHEMA, null, 2)}\n`);
  const preparedAt = new Date().toISOString();
  const active = seal({contract: CLI_ACTIVE_CONTRACT, job_id: SMOKE_ID, job_hash: job.content_hash, prompt_hash: hash(prompt), schema_hash: EVALUATION_ONLY_SCHEMA_HASH, runner_hash: RUNNER_HASH, prepared_at: preparedAt});
  writePrivate(activePath, active);
  const request = seal({contract: CLI_REQUEST_CONTRACT, job_hash: job.content_hash, prompt_hash: hash(prompt), prompt_path: promptPath, schema_path: schemaPath, schema_hash: EVALUATION_ONLY_SCHEMA_HASH, runner_hash: RUNNER_HASH, attempts_path: attemptsPath, active_path: activePath, model: 'gpt-5.6-sol', effort: 'medium', cwd: CLI_ROOT, sandbox: 'read-only', timeout_ms: 5 * 60 * 1000, max_attempts: 2, prepared_at: preparedAt, active_hash: active.content_hash});
  writePrivate(requestPath, request);
  return {job, request, requestPath, schemaPath};
}

export async function runSyntheticSmoke(manifestPath, options = {}) {
  const manifestFile = path.resolve(manifestPath);
  const root = privateRoot(path.dirname(manifestFile));
  const manifest = readSealed(manifestFile);
  if (manifest.evaluation_schema_hash !== EVALUATION_ONLY_SCHEMA_HASH) fail('smoke_manifest_schema_mismatch');
  const markerPath = path.join(root, 'synthetic-smoke.json');
  if (fs.existsSync(markerPath)) return readSealed(markerPath);
  const smokeRoot = path.join(root, 'synthetic-smoke');
  if (fs.existsSync(smokeRoot)) fail('smoke_evidence_exists');
  fs.mkdirSync(smokeRoot, {mode: 0o700});
  fs.chmodSync(smokeRoot, 0o700);
  const prepared = prepare(smokeRoot);
  assertSupportedOutputSchema(EVALUATION_ONLY_SCHEMA);
  const executable = options.executable ?? process.env.CODEX_CLI_PATH ?? 'codex';
  const sessionsRoot = Array.isArray(options.sessionsRoot) ? options.sessionsRoot[0] : options.sessionsRoot;
  const outcome = await runCli({root: smokeRoot, request: {...prepared.request, path: prepared.requestPath}, job: prepared.job, schema: EVALUATION_ONLY_SCHEMA, executable, timeoutMs: prepared.request.timeout_ms, sessionsRoot});
  const attempt = outcome.attempts.findLast(item => item.final_present === true && item.retry?.status === 'final');
  if (outcome.status !== 'final_available' || !attempt || attempt.quiesced !== true) fail(`synthetic_smoke_held:${attempt?.retry?.reason ?? outcome.status}`);
  const checked = cliResult(prepared.requestPath, prepared.job, sessionsRoot, attempt);
  const parsed = JSON.parse(checked.raw);
  validateEvaluationOnlyOutput(parsed, SPEC);
  const commonMemoryHash = checked.metadata.common_memory_hash;
  if (typeof commonMemoryHash !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(commonMemoryHash)) fail('synthetic_smoke_memory_hash_missing');
  privateTree(smokeRoot);
  const marker = seal({
    contract: EVALUATION_ONLY_SMOKE_CONTRACT,
    status: 'accepted_evidence',
    synthetic: true,
    manifest_hash: manifest.content_hash,
    schema_hash: EVALUATION_ONLY_SCHEMA_HASH,
    runner_hash: EVALUATION_ONLY_RUNNER_HASH,
    smoke_code_hash: EVALUATION_ONLY_SMOKE_CODE_HASH,
    execution_transport: TRANSPORT,
    input_plaintext_attested: true,
    backend_attested: false,
    common_memory_hash: commonMemoryHash,
    session_id: attempt.session_id,
    attempt: attempt.attempt,
    attempts_hash: fileSha256(path.join(smokeRoot, 'cli-attempts.json')),
    final_output_sha256: fileSha256(attempt.output_path),
    evidence_root: smokeRoot,
    data_scope: 'public_synthetic_empty_evaluation_payload'
  });
  writePrivate(markerPath, marker);
  return marker;
}

export async function main(argv = process.argv.slice(2)) {
  const {values: v, positionals: [command]} = parseArgs({args: argv, allowPositionals: true, options: {manifest: {type: 'string'}, executable: {type: 'string'}, 'sessions-root': {type: 'string', multiple: true}}});
  if (command !== 'run' || !v.manifest) fail('smoke_manifest_required');
  const marker = await runSyntheticSmoke(v.manifest, {executable: v.executable, sessionsRoot: v['sessions-root']});
  console.log(JSON.stringify({status: marker.status, manifest: path.resolve(v.manifest), evidence_root: marker.evidence_root, common_memory_hash: marker.common_memory_hash}, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
