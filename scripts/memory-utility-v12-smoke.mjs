#!/usr/bin/env node

/*
 * Public synthetic transport smoke for the v1.2 contracts.
 *
 * It deliberately contains no source case, private transcript, or real
 * memory. The caller may run it with the same Codex stdin runner used by the
 * experiment to attest that C, semantic quality, replay, and evaluation
 * schemas travel through the native route successfully.
 */
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';

import {hash} from './memory-extraction-router-v33-core.mjs';
import {
  assertPrivateTree,
  rawMessages,
  runCliStage,
  segments,
  seal,
  spanCatalog,
  supportIdsByItem,
  qualityItemsPayload,
  validateC,
  validateEvaluation,
  validateQuality,
  validateReplay,
  JSON_ANGLE_ESCAPE_INSTRUCTION,
  serializeV12Payload
} from './memory-utility-v12.mjs';
import {
  CLI_ACTIVE_CONTRACT,
  CLI_REQUEST_CONTRACT,
  CLI_ROOT,
  RUNNER_HASH,
  V12_EFFORT,
  V12_EXECUTION_TRANSPORT,
  V12_MAX_ATTEMPTS,
  V12_MODEL,
  V12_SCHEMA_HASHES,
  V12_TIMEOUT_MS,
  assertSupportedOutputSchema,
  serializeV12Schema,
  v12InputByteAccounting,
  v12SchemaForJob
} from './memory-utility-v12-cli.mjs';
import {
  V12_EVALUATION_SCHEMA,
  V12_FIELD_NAMES,
  V12_QUALITY_KINDS,
  V12_REPLAY_OUTPUT_SCHEMA
} from './memory-utility-v12-contracts.mjs';

const SMOKE_CASE_ID = 'synthetic-v12-smoke';
const SMOKE_CONTRACT = 'memory-utility-v12-smoke/v1';
export const RESERVED_TAG = '<oai-mem-citation>public synthetic fixture</oai-mem-citation>';
const RULES = [
  'これは公開人工smokeです。ツール、ファイル操作、ネットワーク、外部知識、追加エージェントを使用しない。',
  '入力に含まれるJSONを変更せず、指定された出力JSONだけを返す。Markdownのコードフェンスや説明文を付けない。',
  JSON_ANGLE_ESCAPE_INSTRUCTION
].join('');

function fail(code) { throw new Error(code); }

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { fail(`smoke_json_invalid:${path.basename(file)}:${error.message}`); }
}

function writePrivate(file, value) {
  const data = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(file, data, {flag: 'wx', mode: 0o600});
  fs.chmodSync(file, 0o600);
}

function readSealed(file) {
  const value = readJson(file);
  if (!value || typeof value !== 'object' || typeof value.content_hash !== 'string') fail(`smoke_unsealed:${path.basename(file)}`);
  const {content_hash: actual, ...body} = value;
  if (hash(body) !== actual) fail(`smoke_hash_mismatch:${path.basename(file)}`);
  return value;
}

function privateRoot(manifestPath) {
  const root = path.dirname(path.resolve(manifestPath));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory() || (fs.statSync(root).mode & 0o777) !== 0o700) {
    fail('smoke_private_manifest_root_required');
  }
  return root;
}

export function syntheticCase() {
  const messages = rawMessages([
    {timestamp: '2026-01-01T00:00:00.000Z', payload: {type: 'user_message', message: `Synthetic source line one: ${RESERVED_TAG}`}},
    {timestamp: '2026-01-01T00:00:01.000Z', payload: {type: 'agent_message', phase: 'final_answer', message: 'Synthetic source line two.'}}
  ]);
  const target = segments(messages, 'target');
  const item = {
    id: 'i1', category: 'reference', subtype: 'unknown', incident_id: 'synthetic-incident',
    status: 'observed', source_role: 'user',
    content: 'Synthetic summary.', decision: 'unknown', rationale: 'unknown', symptom: 'unknown',
    cause: 'unknown', correction: 'unknown', outcome: 'unknown', reuse_when: 'unknown', scope: 'unknown',
    field_certainty: Object.fromEntries(V12_FIELD_NAMES.map(field => [field, field === 'content' ? 'observed' : 'unknown'])),
    gaps: [],
    evidence: Object.fromEntries(V12_FIELD_NAMES.map(field => [field, field === 'content' ? [{id: 'span-1'}] : []])),
    support_ids: ['span-1'], relation: 'create', target_ids: []
  };
  const source = {id: SMOKE_CASE_ID, context: [], target: messages, task: {text: 'Synthetic task.', at: '2026-01-01T00:00:02.000Z'}, boundary: '2026-01-01T00:00:02.000Z'};
  return {source, target, item};
}

export function qualityOutput(spans) {
  return {
    status: 'passed',
    checked_kinds: [...V12_QUALITY_KINDS],
    checked_set: spans.map((_, index) => ({id: `span-${index + 1}`})),
    item_checks: [{item_id: 'item-1', checked_fields: [...V12_FIELD_NAMES], support_ids: ['span-1']}],
    findings: [],
    positive_evidence: V12_QUALITY_KINDS.map(kind => ({kind, result: 'passed', reason: `Synthetic evidence checked for ${kind}.`, support_ids: ['span-1']}))
  };
}

function evaluationOutput() {
  const answers = ['answer-1', 'answer-2', 'answer-3'].map(id => ({
    id,
    metrics: {
      continuation: {rating: 'unknown', reason: 'Synthetic smoke has no quality judgment.', support_ids: []},
      constraints: {rating: 'unknown', reason: 'Synthetic smoke has no quality judgment.', support_ids: []},
      recurrence_prevention: {rating: 'unknown', reason: 'Synthetic smoke has no quality judgment.', support_ids: []},
      memory_harm: {
        rating: 'unknown', reason: 'Synthetic smoke has no supplied memory.', support_ids: [],
        checked_answer_id: id, checked_memory_ids: [], problematic_answer_passage: '', causal_memory_id: '',
        constraint_support_ids: [], missing_evidence_reason: 'Synthetic smoke supplies no memory set.'
      }
    },
    major_memory_errors: []
  }));
  return {answers, extraction_issues: []};
}

function replayOutput() { return {answer: 'Synthetic replay answer.', used_memory_ids: []}; }

export function jobPrompt(payload) { return `${RULES}\n${serializeV12Payload(payload)}`; }

function makeJob(root, id, payload, privateData, schema) {
  const prompt = jobPrompt(payload);
  const inputBytes = v12InputByteAccounting(prompt, schema);
  const job = seal({
    id, payload, private: privateData, prompt, ...inputBytes,
    expected_model: V12_MODEL, expected_effort: V12_EFFORT, schema_hash: hash(schema), runner_hash: RUNNER_HASH
  });
  const schemaPath = path.join(root, `schema-${id}.json`);
  const promptPath = path.join(root, `prompt-${id}.txt`);
  const requestPath = path.join(root, `cli-request-${id}.json`);
  const activePath = path.join(root, 'active-cli.json');
  const attemptsPath = path.join(root, `cli-attempts-${id}.json`);
  writePrivate(path.join(root, `job-${id}.json`), job);
  writePrivate(promptPath, prompt);
  writePrivate(schemaPath, serializeV12Schema(schema));
  const preparedAt = new Date().toISOString();
  const active = seal({contract: CLI_ACTIVE_CONTRACT, job_id: id, job_hash: job.content_hash, prompt_hash: hash(prompt), schema_hash: hash(schema), runner_hash: RUNNER_HASH, prepared_at: preparedAt, ...inputBytes});
  writePrivate(activePath, active);
  const request = seal({
    contract: CLI_REQUEST_CONTRACT, job_hash: job.content_hash, prompt_hash: hash(prompt), prompt_path: promptPath,
    schema_path: schemaPath, schema_hash: hash(schema), runner_hash: RUNNER_HASH, attempts_path: attemptsPath,
    ...inputBytes,
    active_path: activePath, model: V12_MODEL, effort: V12_EFFORT, cwd: CLI_ROOT, sandbox: 'read-only',
    timeout_ms: V12_TIMEOUT_MS, max_attempts: V12_MAX_ATTEMPTS, prepared_at: preparedAt, active_hash: active.content_hash
  });
  writePrivate(requestPath, request);
  return {job, request, requestPath, schema, schemaPath, activePath};
}

async function executeJob(root, spec, expected, validate, options) {
  assertSupportedOutputSchema(spec.schema);
  const acceptedResult = await runCliStage({
    root,
    m: {cases: [spec.source], calibration_cases: []}
  }, {job: spec.job.id, executable: options.executable, 'sessions-root': options.sessionsRoot});
  if (acceptedResult.status !== 'accepted') fail(`synthetic_smoke_not_accepted:${spec.job.id}`);
  const accepted = readSealed(path.join(root, `accepted-${spec.job.id}.json`));
  const initial = readSealed(path.join(root, `initial-${spec.job.id}.json`));
  const output = accepted.output;
  validate(output);
  return {
    id: spec.job.id,
    attempt: accepted.attempt,
    session_id: accepted.session_id,
    common_memory_hash: initial.metadata.common_memory_hash,
    output_hash: hash(output),
    output,
    parsed: initial.parsed,
    raw: initial.raw,
    expected
  };
}

function assertReservedTagTransport(result, expectedQuote, outputQuote) {
  if (typeof outputQuote !== 'function' || outputQuote(result.output) !== expectedQuote) fail('smoke_reserved_tag_output_missing');
  if (typeof result.raw !== 'string' || result.raw.includes(RESERVED_TAG)) fail('smoke_reserved_tag_raw_present');
  if (hash(JSON.parse(result.raw)) !== hash(result.parsed)) fail('smoke_reserved_tag_raw_transformed');
}

export async function runSyntheticSmoke(manifestPath, options = {}) {
  const manifestFile = path.resolve(manifestPath);
  const root = privateRoot(manifestFile);
  const manifest = readSealed(manifestFile);
  if (manifest.contract !== 'memory-utility-manifest/v1.2') fail('smoke_manifest_contract_mismatch');
  const markerPath = path.join(root, 'synthetic-v12-smoke.json');
  if (fs.existsSync(markerPath)) return readSealed(markerPath);
  const smokeRoot = path.join(root, 'synthetic-v12-smoke');
  if (fs.existsSync(smokeRoot)) fail('smoke_evidence_exists');
  fs.mkdirSync(smokeRoot, {mode: 0o700});
  fs.chmodSync(smokeRoot, 0o700);
  const {source, target, item} = syntheticCase();
  const spans = target;
  const c = v12SchemaForJob({private: {stage: 'extract', method: 'C', spans}});
  const q = v12SchemaForJob({private: {stage: 'quality', spans, extracted_items: [item]}});
  const r = V12_REPLAY_OUTPUT_SCHEMA;
  const e = V12_EVALUATION_SCHEMA;
  const cSpec = {...makeJob(smokeRoot, 'c', {output_schema: c, span_catalog: spanCatalog(spans), expected_output: {items: [item]}}, {stage: 'extract', method: 'C', case_id: SMOKE_CASE_ID, spans}, c), source};
  const cResult = await executeJob(smokeRoot, cSpec, 'C', output => validateC(output, target), options);
  assertReservedTagTransport(cResult, target[0].text, output => output.items?.[0]?.evidence?.content?.[0]?.quote);
  if (cResult.output.items?.[0]?.content !== item.content) fail('smoke_reserved_tag_content_changed');
  if (cResult.parsed.items?.[0]?.evidence?.content?.[0]?.quote !== undefined) fail('smoke_reserved_tag_raw_quote_present');
  if (cResult.parsed.items?.[0]?.evidence?.content?.[0]?.id !== 'span-1') fail('smoke_reserved_tag_raw_id_missing');
  if (cResult.output.items?.[0]?.evidence?.content?.[0]?.quote !== target[0].text) fail('smoke_reserved_tag_evidence_missing');
  const quality = qualityOutput(spans);
  const qualityItems = qualityItemsPayload(cResult.output.items, spans);
  const qSpec = {...makeJob(smokeRoot, 'quality', {output_schema: q, span_catalog: spanCatalog(spans), extracted: {items: qualityItems}, support_ids_by_item: supportIdsByItem(cResult.output.items, spans), expected_output: quality}, {stage: 'quality', quality_phase: 'downstream', case_id: SMOKE_CASE_ID, spans, extracted_items: cResult.output.items}, q), source};
  const qResult = await executeJob(smokeRoot, qSpec, 'quality', output => validateQuality(output, spans, cResult.output.items), options);
  assertReservedTagTransport(qResult, target[0].text, output => output.checked_set?.find(entry => entry.id === target[0].id)?.quote);
  if (qResult.parsed.checked_set?.some(entry => Object.keys(entry).sort().join('|') !== 'id')) fail('smoke_reserved_tag_raw_checked_set_quote_present');
  const replay = replayOutput();
  const rSpec = {...makeJob(smokeRoot, 'replay', {output_schema: r, task: source.task.text, memories: [], expected_output: replay}, {stage: 'replay', method: 'A', case_id: SMOKE_CASE_ID, memory_ids: []}, r), source};
  const rResult = await executeJob(smokeRoot, rSpec, 'A', output => validateReplay(output, []), options);
  const evaluation = evaluationOutput();
  const eSpec = {...makeJob(smokeRoot, 'evaluate', {output_schema: e, answers: evaluation.answers, memories_by_answer: {}, expected_output: evaluation}, {stage: 'evaluate', case_id: SMOKE_CASE_ID}, e), source};
  const eResult = await executeJob(smokeRoot, eSpec, 'evaluate', output => validateEvaluation(output, source, {answers: {}, memoriesByAnswer: {}}), options);
  const results = [cResult, qResult, rResult, eResult];
  const commonMemoryHashes = [...new Set(results.map(result => result.common_memory_hash).filter(Boolean))];
  if (commonMemoryHashes.length !== 1 || !/^sha256:[0-9a-f]{64}$/u.test(commonMemoryHashes[0])) fail('synthetic_common_memory_hash_invalid');
  assertPrivateTree(smokeRoot);
  const marker = seal({
    contract: SMOKE_CONTRACT, status: 'accepted_evidence', synthetic: true, manifest_hash: manifest.content_hash,
    schema_hashes: V12_SCHEMA_HASHES, runner_hash: RUNNER_HASH, execution_transport: V12_EXECUTION_TRANSPORT,
    input_plaintext_attested: true, backend_attested: false, common_memory_hash: commonMemoryHashes[0],
    jobs: results, evidence_root: smokeRoot, data_scope: 'public_synthetic_v12_empty_memory_payload'
  });
  writePrivate(markerPath, marker);
  return marker;
}

export async function main(argv = process.argv.slice(2)) {
  const {values, positionals} = parseArgs({
    args: argv, allowPositionals: true,
    options: {manifest: {type: 'string'}, executable: {type: 'string'}, 'sessions-root': {type: 'string', multiple: true}}
  });
  if (positionals[0] !== 'run' || !values.manifest) fail('smoke_manifest_required');
  const sessionsRoot = Array.isArray(values['sessions-root']) ? values['sessions-root'][0] : values['sessions-root'];
  const marker = await runSyntheticSmoke(values.manifest, {executable: values.executable ?? process.env.CODEX_CLI_PATH ?? 'codex', sessionsRoot});
  console.log(JSON.stringify({status: marker.status, manifest: path.resolve(values.manifest), evidence_root: marker.evidence_root, common_memory_hash: marker.common_memory_hash}, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
