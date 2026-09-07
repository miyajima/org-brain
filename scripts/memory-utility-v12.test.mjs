import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Ajv from 'ajv';

import {
  POLICY,
  MAX_INPUT_BYTES,
  acceptCliStage,
  buildStore,
  buildV12Manifest,
  calibrationReportStage,
  calibrationStage,
  canonicalItemFromC,
  C_INSTRUCTION,
  deriveStatus,
  evaluationStage,
  evaluationInput,
  hydrateAcceptedOutput,
  hydrateCOutput,
  hydrateQualityOutput,
  outputForJob as reloadOutputForJob,
  prepareCliStage,
  QUALITY_CHECKED_FIELDS_INSTRUCTION,
  QUALITY_RETENTION_INSTRUCTION,
  qualityItemsPayload,
  replayStage,
  qualityAudit,
  spanCatalog,
  supportIdsByItem,
  retrieve,
  retentionDecision,
  seal,
  segments,
  validateC,
  validateEvaluation,
  validateQuality
} from './memory-utility-v12.mjs';
import {
  CLI_ACTIVE_CONTRACT,
  CLI_ATTEMPT_CONTRACT,
  CLI_ATTEMPTS_CONTRACT,
  CLI_REQUEST_CONTRACT,
  CLI_ROOT,
  RUNNER_HASH,
  V12_EXECUTION_TRANSPORT,
  V12_MAX_ATTEMPTS,
  V12_ENUM_VALUE_LIMIT,
  V12_SCHEMA_ENCODING,
  V12_SCHEMA_PREFLIGHT,
  V12_SCHEMA_HASHES,
  V12_TIMEOUT_MS,
  V12_TRANSPORT_SCHEMAS,
  assertV12SchemaPreflight,
  countSchemaEnumValues,
  serializeV12Schema,
  v12InputByteAccounting,
  v12SchemaForJob,
  v12SchemaHashForJob
} from './memory-utility-v12-cli.mjs';
import {
  V12_C_OUTPUT_SCHEMA,
  V12_FIELD_NAMES,
  V12_MAX_ITEM_REFS,
  V12_MAX_SPAN_REFS,
  V12_QUALITY_KINDS,
  V12_QUALITY_SCHEMA,
  V12_REPLAY_OUTPUT_SCHEMA,
} from './memory-utility-v12-contracts.mjs';
import {createManifest, hash} from './memory-extraction-router-v33-core.mjs';

const at = (index, seconds = 0) => new Date(Date.parse('2026-01-01T00:00:00.000Z') + index * 60_000 + seconds * 1000).toISOString();
const span = (id, text, role = 'user', time = at(0)) => ({id: `target:${id}:full`, message_id: id, role, at: time, start: 0, end: text.length, text});

function cItem(id, source, changes = {}) {
  const values = Object.fromEntries(V12_FIELD_NAMES.map(field => [field, field === 'content' ? source.text : 'unknown']));
  const certainty = Object.fromEntries(V12_FIELD_NAMES.map(field => [field, field === 'content' ? 'observed' : 'unknown']));
  const evidence = Object.fromEntries(V12_FIELD_NAMES.map(field => [field, field === 'content' ? [{id: source.id, quote: source.text}] : []]));
  return {
    id, category: 'reference', subtype: 'unknown', incident_id: 'incident-1', status: 'observed', source_role: source.role,
    ...values, field_certainty: certainty, gaps: [], evidence, support_ids: [source.id], relation: 'create', target_ids: [], ...changes
  };
}

function writeSealed(root, name, value) {
  const file = path.join(root, name.endsWith('.json') ? name : `${name}.json`);
  fs.writeFileSync(file, `${JSON.stringify(seal(value), null, 2)}\n`, {flag: 'wx', mode: 0o600});
  fs.chmodSync(file, 0o600);
  return file;
}

function outputForJob(root, id, output) {
  const job = JSON.parse(fs.readFileSync(path.join(root, `job-${id}.json`), 'utf8'));
  const isC = job.private?.stage === 'calibrate' || job.private?.stage === 'extract' && job.private?.method === 'C';
  const isQuality = job.private?.stage === 'quality';
  const parsed = isC
    ? cTransportOutput(output, job.private.spans)
    : isQuality
      ? qualityTransportOutput(output, job.private.spans, job.private.extracted_items)
      : output;
  const canonical = hydrateAcceptedOutput(job, parsed);
  const raw = JSON.stringify(parsed);
  const initial = JSON.parse(fs.readFileSync(writeSealed(root, `initial-${id}`, {
    job_hash: job.content_hash,
    raw,
    raw_hash: hash(raw),
    parsed,
    parsed_hash: hash(parsed),
    canonical: canonical.output,
    canonical_hash: canonical.provenance.canonical_hash,
    canonical_provenance: canonical.provenance,
    metadata: {}
  }), 'utf8'));
  writeSealed(root, `accepted-${id}`, {
    job_hash: job.content_hash,
    initial_hash: initial.content_hash,
    raw_hash: initial.raw_hash,
    parsed_hash: initial.parsed_hash,
    transport_hash: canonical.provenance.transport_hash,
    canonical_hash: canonical.provenance.canonical_hash,
    canonical_provenance: canonical.provenance,
    output: canonical.output,
    execution_transport: V12_EXECUTION_TRANSPORT, input_plaintext_attested: true,
    runner_hash: RUNNER_HASH, schema_hash: job.schema_hash
  });
}

function writePrivateJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {flag: 'wx', mode: 0o600});
  fs.chmodSync(file, 0o600);
}

function writePrivateText(file, value) {
  fs.writeFileSync(file, value, {flag: 'wx', mode: 0o600});
  fs.chmodSync(file, 0o600);
}

function writeNativeAcceptanceFixture({root, sessionsRoot, caseId, id, prompt, raw, schema, privateData, payload = {}, sessionId, outputRaw = raw, eventsRaw = raw, nativeRaw = raw}) {
  const schemaHash = hash(schema);
  const inputBytes = v12InputByteAccounting(prompt, schema);
  const job = seal({
    id, payload, private: privateData, prompt,
    ...inputBytes, expected_model: 'gpt-5.6-sol', expected_effort: 'medium',
    schema_encoding: V12_SCHEMA_ENCODING,
    schema_hash: schemaHash, runner_hash: RUNNER_HASH
  });
  writePrivateJson(path.join(root, `job-${id}.json`), job);
  const promptPath = path.join(root, `dispatch-${id}.txt`);
  const schemaPath = path.join(root, `cli-schema-${id}.json`);
  const requestPath = path.join(root, `cli-request-${id}.json`);
  const activePath = path.join(root, 'active-cli.json');
  const attemptsPath = path.join(root, `cli-attempts-${id}.json`);
  writePrivateText(promptPath, prompt);
  writePrivateText(schemaPath, serializeV12Schema(schema));
  const preparedAt = new Date(Date.now() - 2_000).toISOString();
  const active = seal({contract: CLI_ACTIVE_CONTRACT, job_id: id, job_hash: job.content_hash, prompt_hash: hash(prompt), schema_hash: schemaHash, runner_hash: RUNNER_HASH, prepared_at: preparedAt, ...inputBytes});
  writePrivateJson(activePath, active);
  const request = seal({
    contract: CLI_REQUEST_CONTRACT, job_hash: job.content_hash, prompt_hash: hash(prompt),
    prompt_path: promptPath, schema_path: schemaPath, schema_hash: schemaHash, runner_hash: RUNNER_HASH,
    attempts_path: attemptsPath, active_path: activePath, model: 'gpt-5.6-sol', effort: 'medium', cwd: CLI_ROOT,
    sandbox: 'read-only', timeout_ms: V12_TIMEOUT_MS, max_attempts: V12_MAX_ATTEMPTS,
    prepared_at: preparedAt, active_hash: active.content_hash, ...inputBytes
  });
  writePrivateJson(requestPath, request);
  const eventsPath = path.join(root, `cli-events-${id}-attempt-1.jsonl`);
  const outputPath = path.join(root, `cli-output-${id}-attempt-1.json`);
  const stderrPath = path.join(root, `cli-stderr-${id}-attempt-1.log`);
  writePrivateText(outputPath, outputRaw);
  writePrivateText(stderrPath, '');
  writePrivateText(eventsPath, [
    {type: 'thread.started', thread_id: sessionId},
    {type: 'turn.started'},
    {type: 'item.completed', item: {type: 'agent_message', text: eventsRaw}},
    {type: 'turn.completed', usage: {input_tokens: 1, output_tokens: 2}}
  ].map(row => JSON.stringify(row)).join('\n'));
  const startedAt = new Date(Date.now() - 1_000).toISOString();
  const finalAt = new Date(Date.now() - 500).toISOString();
  const date = new Date(fs.statSync(eventsPath).mtimeMs).toISOString().slice(0, 10).replaceAll('-', '/');
  const sessionDir = path.join(sessionsRoot, date);
  fs.mkdirSync(sessionDir, {recursive: true, mode: 0o700});
  fs.chmodSync(sessionDir, 0o700);
  const nativeLog = [
    {timestamp: startedAt, type: 'session_meta', payload: {id: sessionId, source: 'exec', cwd: CLI_ROOT, timestamp: startedAt}},
    {timestamp: startedAt, type: 'response_item', payload: {type: 'message', role: 'developer', content: [{type: 'input_text', text: 'MEMORY_SUMMARY BEGINS\nsynthetic common host memory'}]}},
    {timestamp: startedAt, type: 'turn_context', payload: {model: 'gpt-5.6-sol', effort: 'medium', sandbox_policy: {type: 'read-only'}}},
    {timestamp: startedAt, type: 'response_item', payload: {type: 'message', role: 'user', content: [{type: 'input_text', text: prompt}], internal_chat_message_metadata_passthrough: {content_item_kinds: ['user.text']}}},
    {timestamp: finalAt, type: 'response_item', payload: {type: 'message', role: 'assistant', phase: 'final_answer', content: [{type: 'output_text', text: nativeRaw}]}}
  ];
  writePrivateText(path.join(sessionDir, `rollout-${sessionId}.jsonl`), nativeLog.map(row => JSON.stringify(row)).join('\n') + '\n');
  const descriptor = seal({
    contract: CLI_ATTEMPT_CONTRACT, job_id: id, job_hash: job.content_hash, prompt_hash: hash(prompt),
    schema_hash: schemaHash, runner_hash: RUNNER_HASH, attempt: 1, final_present: true, quiesced: true,
    events_path: eventsPath, output_path: outputPath, stderr_path: stderrPath, session_id: sessionId,
    native_status: 'available', retry: {status: 'final', retryable: false, reason: 'final_present'},
    usage: {input_tokens: 1, output_tokens: 2}
  });
  writePrivateJson(path.join(root, `cli-attempt-${id}-1.json`), descriptor);
  writePrivateJson(path.join(root, `cli-attempts-${id}.json`), seal({
    contract: CLI_ATTEMPTS_CONTRACT, job_id: id, job_hash: job.content_hash, prompt_hash: hash(prompt),
    schema_hash: schemaHash, runner_hash: RUNNER_HASH, max_attempts: V12_MAX_ATTEMPTS,
    attempts: [{...descriptor, attempt_hash: descriptor.content_hash}]
  }));
  return {job, id, caseId, sessionsRoot, eventsPath, outputPath, nativePath: path.join(sessionDir, `rollout-${sessionId}.jsonl`), startedAt};
}

function escapedJson(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
}

function spanRef(id, spans) {
  const index = spans.findIndex(span => span.id === id);
  assert.ok(index >= 0, `missing span fixture: ${id}`);
  return `span-${index + 1}`;
}

function itemRef(id, items) {
  const index = items.findIndex(item => item.id === id);
  assert.ok(index >= 0, `missing item fixture: ${id}`);
  return `item-${index + 1}`;
}

function cTransportOutput(output, spans) {
  return {
    items: output.items.map(item => ({
      ...item,
      evidence: Object.fromEntries(V12_FIELD_NAMES.map(field => [
        field,
        item.evidence[field].map(entry => ({id: spanRef(entry.id, spans)}))
      ])),
      support_ids: item.support_ids.map(id => spanRef(id, spans))
    }))
  };
}

function qualityTransportOutput(output, spans, items) {
  return {
    ...output,
    checked_set: output.checked_set.map(entry => ({id: spanRef(entry.id, spans)})),
    item_checks: output.item_checks.map(check => ({
      ...check,
      item_id: itemRef(check.item_id, items),
      support_ids: check.support_ids.map(id => spanRef(id, spans))
    })),
    findings: output.findings.map(findingValue => ({
      ...findingValue,
      item_id: findingValue.item_id === 'none' ? 'none' : itemRef(findingValue.item_id, items),
      support_ids: findingValue.support_ids.map(id => spanRef(id, spans))
    })),
    positive_evidence: output.positive_evidence.map(evidence => ({
      ...evidence,
      support_ids: evidence.support_ids.map(id => spanRef(id, spans))
    }))
  };
}

function acceptanceContext(root, caseId) {
  return {
    root,
    m: {cases: [{id: caseId, context: [], target: [], task: {text: 'task', at: at(1)}}], calibration_cases: []}
  };
}

test('C canonicalization validates the full ordered batch before update/conflict/duplicate conversion', () => {
  const spans = [span('m1', 'baseline policy'), span('m2', 'updated policy'), span('m3', 'conflicting policy'), span('m4', 'duplicate policy')];
  const output = {items: [
    cItem('i1', spans[0]),
    cItem('i2', spans[1], {relation: 'update', target_ids: ['i1']}),
    cItem('i3', spans[2], {relation: 'conflict', target_ids: ['i2']}),
    cItem('i4', spans[3], {relation: 'duplicate', target_ids: ['i3']})
  ]};
  validateC(output, spans);
  const canonical = output.items.map(item => canonicalItemFromC(item, spans, output));
  const store = buildStore(canonical, at(10), 'C', 'case');
  assert.deepEqual(store.records.map(record => record.active), [false, true, true, false]);
  assert.equal(store.history.length, 1);
  assert.deepEqual(store.records[2].target_ids, ['case:C:i2']);
});

test('retrieval bundles an active conflict pair as one top-k unit', () => {
  const spans = [span('m1', 'old policy'), span('m2', 'new policy'), span('m3', 'conflicting policy')];
  const output = {items: [
    cItem('i1', spans[0]),
    cItem('i2', spans[1], {relation: 'conflict', target_ids: ['i1']}),
    cItem('i3', spans[2])
  ]};
  const canonical = output.items.map(item => canonicalItemFromC(item, spans, output));
  const fillers = Array.from({length: 8}, (_, index) => ({
    source_item_id: `i${index + 4}`, category: 'reference', subtype: 'unknown', incident_id: `filler-${index}`,
    content: `unrelated filler ${index}`, fields: Object.fromEntries(V12_FIELD_NAMES.map(field => [field, field === 'content' ? `unrelated filler ${index}` : 'unknown'])),
    field_certainty: Object.fromEntries(V12_FIELD_NAMES.map(field => [field, field === 'content' ? 'observed' : 'unknown'])),
    evidence: Object.fromEntries(V12_FIELD_NAMES.map(field => [field, []])), support_ids: [], source_role: 'unknown', status: 'observed',
    relation: 'create', target_ids: [], gaps: [], source: 'C'
  }));
  const records = buildStore(canonical.concat(fillers), at(10), 'C', 'case').records;
  const result = retrieve('conflicting policy', records, at(20));
  assert.ok(result.selected_ids.includes('case:C:i1'));
  assert.ok(result.selected_ids.includes('case:C:i2'));
  assert.ok(result.retrieval_units.some(unit => unit.ids.includes('case:C:i1') && unit.ids.includes('case:C:i2')));
  assert.ok(result.selected_unit_ids.length <= POLICY.top_k);
  assert.ok(result.selected_ids.length >= result.selected_unit_ids.length);
});

test('replay payload is bounded by five units and keeps conflict targets inside the bundle', () => {
  const source = [span('m1', 'old policy'), span('m2', 'new policy')];
  const output = {items: [
    cItem('i1', source[0]),
    cItem('i2', source[1], {relation: 'conflict', target_ids: ['i1']})
  ]};
  const canonical = output.items.map(item => canonicalItemFromC(item, source, output));
  const fillers = Array.from({length: 8}, (_, index) => ({
    source_item_id: `filler-${index}`, category: 'reference', subtype: 'unknown', incident_id: `filler-${index}`,
    content: `unrelated filler ${index}`, fields: Object.fromEntries(V12_FIELD_NAMES.map(field => [field, field === 'content' ? `unrelated filler ${index}` : 'unknown'])),
    field_certainty: Object.fromEntries(V12_FIELD_NAMES.map(field => [field, field === 'content' ? 'observed' : 'unknown'])),
    evidence: Object.fromEntries(V12_FIELD_NAMES.map(field => [field, []])), support_ids: [], source_role: 'unknown', status: 'observed',
    relation: 'create', target_ids: [], gaps: [], source: 'C'
  }));
  const records = buildStore(canonical.concat(fillers), at(10), 'C', 'case').records;
  const retrieval = retrieve('policy', records, at(20));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-utility-v12-replay-'));
  fs.chmodSync(root, 0o700);
  writeSealed(root, 'retrieval', {
    contract: 'memory-utility-retrieval/v1.2',
    cases: {case: {stores: {B: {records: []}, C: {records}}, retrieval: {B: {selected_ids: []}, C: retrieval}}}
  });
  writeSealed(root, 'quality-report', {
    contract: 'memory-utility-quality-report/v1.2',
    status: 'failed', quality_status: 'failed', cases: [{case_id: 'case', status: 'failed'}]
  });
  replayStage({
    root,
    m: {content_hash: `sha256:${'a'.repeat(64)}`, cases: [{id: 'case', task: {text: 'policy'}, workspace_root: null}]},
    config: {common_information: 'common'}
  });
  const job = JSON.parse(fs.readFileSync(path.join(root, 'job-replay-c-case.json'), 'utf8'));
  const memories = job.payload.memories;
  assert.ok(memories.length <= POLICY.top_k);
  assert.equal(new Set(memories.map(memory => memory.id)).size, memories.length);
  const bundle = memories.find(memory => memory.members?.length > 1);
  assert.ok(bundle);
  assert.equal(bundle.relation, 'conflict');
  assert.deepEqual(bundle.target_ids, []);
  assert.equal('versions' in bundle, false);
  const memberIds = new Set(bundle.members.map(member => member.id));
  assert.ok(bundle.members.some(member => member.content === 'old policy'));
  assert.ok(bundle.members.some(member => member.content === 'new policy'));
  for (const member of bundle.members) for (const target of member.target_ids) assert.ok(memberIds.has(target));
});

test('evaluation harm evidence binds checked_answer_id to its enclosing answer', () => {
  const source = {target: [{id: 'm1', role: 'user', text: 'task', at: at(0)}], context: [], task: {text: 'task', at: at(1)}};
  const base = id => ({id, metrics: {
    continuation: {rating: 'unknown', reason: 'insufficient', support_ids: []},
    constraints: {rating: 'unknown', reason: 'insufficient', support_ids: []},
    recurrence_prevention: {rating: 'unknown', reason: 'insufficient', support_ids: []},
    memory_harm: {rating: 'unknown', reason: 'insufficient', support_ids: [], checked_answer_id: id, checked_memory_ids: [], problematic_answer_passage: '', causal_memory_id: '', constraint_support_ids: [], missing_evidence_reason: 'insufficient'}
  }, major_memory_errors: []});
  const valid = {answers: ['answer-1', 'answer-2', 'answer-3'].map(base), extraction_issues: []};
  validateEvaluation(valid, source, {answers: {}, memoriesByAnswer: {}});
  const invalid = structuredClone(valid);
  invalid.answers[0].metrics.memory_harm.checked_answer_id = 'answer-2';
  assert.throws(() => validateEvaluation(invalid, source, {answers: {}, memoriesByAnswer: {}}), /harm_checked_answer_mismatch/);
});

test('quality requires one substantiated result for every quality kind and rejects unknown as passed', () => {
  const spans = [span('m1', 'quality source')];
  const item = cItem('i1', spans[0]);
  const output = {
    status: 'passed', checked_kinds: [...V12_QUALITY_KINDS], checked_set: [{id: spans[0].id, quote: spans[0].text}],
    item_checks: [{item_id: item.id, checked_fields: [...V12_FIELD_NAMES], support_ids: [spans[0].id]}], findings: [],
    positive_evidence: V12_QUALITY_KINDS.map(kind => ({kind, result: 'passed', reason: `reviewed ${kind}`, support_ids: [spans[0].id]}))
  };
  validateQuality(output, spans, [item]);
  const incomplete = structuredClone(output);
  incomplete.positive_evidence = incomplete.positive_evidence.slice(0, -1);
  assert.throws(() => validateQuality(incomplete, spans, [item]), /quality_positive_evidence_incomplete/);
  const unknown = structuredClone(output);
  unknown.positive_evidence[0].result = 'unknown';
  assert.throws(() => validateQuality(unknown, spans, [item]), /quality_pass_with_findings/);
});

test('quality item checks enumerate only the nine semantic fields', () => {
  const checkedFieldsSchema = V12_QUALITY_SCHEMA.properties.item_checks.items.properties.checked_fields;
  assert.deepEqual(checkedFieldsSchema.items.enum, [...V12_FIELD_NAMES]);
  assert.equal(checkedFieldsSchema.maxItems, V12_FIELD_NAMES.length);
  assert.equal(QUALITY_CHECKED_FIELDS_INSTRUCTION.includes(JSON.stringify(V12_FIELD_NAMES)), true);
  assert.match(QUALITY_CHECKED_FIELDS_INSTRUCTION, /各項目一度ずつ/u);
  assert.match(QUALITY_RETENTION_INSTRUCTION, /operational/);
  assert.match(QUALITY_RETENTION_INSTRUCTION, /short TTL/);
  assert.match(QUALITY_RETENTION_INSTRUCTION, /reuse_whenがunknown/);
  assert.match(QUALITY_RETENTION_INSTRUCTION, /overretention/);

  const spans = [span('m1', 'quality source')];
  const item = cItem('i1', spans[0]);
  const output = {
    status: 'passed',
    checked_kinds: [...V12_QUALITY_KINDS],
    checked_set: [{id: spans[0].id, quote: spans[0].text}],
    item_checks: [{item_id: item.id, checked_fields: [...V12_FIELD_NAMES], support_ids: [spans[0].id]}],
    findings: [],
    positive_evidence: V12_QUALITY_KINDS.map(kind => ({kind, result: 'passed', reason: `reviewed ${kind}`, support_ids: [spans[0].id]}))
  };
  validateQuality(output, spans, [item]);

  const extra = structuredClone(output);
  extra.item_checks[0].checked_fields = [...V12_FIELD_NAMES, 'id'];
  assert.throws(() => validateQuality(extra, spans, [item]), /quality_fields_incomplete/);
});

test('quality audit catches tautological rationale while preserving an unknown cause', () => {
  const source = span('m1', '障害の症状を確認した');
  const item = cItem('i1', source, {category: 'failure', symptom: '障害の症状', rationale: '障害の症状'});
  item.field_certainty.symptom = 'observed';
  item.field_certainty.rationale = 'observed';
  item.evidence.symptom = [{id: source.id, quote: item.symptom}];
  item.evidence.rationale = [{id: source.id, quote: item.rationale}];
  validateC({items: [item]}, [source]);
  const audit = qualityAudit({items: [item]}, [source]);
  assert.ok(audit.findings.some(finding => finding.kind === 'fabricated_reason'));
  assert.equal(item.cause, 'unknown');
  assert.deepEqual(item.evidence.cause, []);
});

test('adoption requires a user decision and quoted evidence', () => {
  const assistant = span('m1', '採用しました。', 'assistant');
  const item = cItem('i1', assistant, {
    category: 'decision', status: 'adopted', decision: '採用しました。'
  });
  item.field_certainty.decision = 'observed';
  item.evidence.decision = [{id: assistant.id, quote: item.decision}];
  item.support_ids = [assistant.id];
  assert.throws(() => validateC({items: [item]}, [assistant]), /false_adoption/);
});

test('conditional user execution requests are not adopted decisions', () => {
  const request = span('m1', 'まずorigin/mainに追いついたあとに未コミット分をコミットして安全？安全なら実行して', 'user');
  const item = cItem('i1', request, {
    category: 'decision', status: 'adopted', content: '安全なら未コミット分をコミットする。', decision: request.text
  });
  item.field_certainty.content = 'observed';
  item.field_certainty.decision = 'adopted';
  item.evidence.content = [{id: request.id, quote: request.text}];
  item.evidence.decision = [{id: request.id, quote: request.text}];
  item.support_ids = [request.id];
  assert.throws(() => validateC({items: [item]}, [request]), /false_adoption/);
});

test('unconditional user choice remains an adopted decision', () => {
  const choice = span('m1', 'これで進めます。', 'user');
  const item = cItem('i1', choice, {
    category: 'decision', status: 'adopted', content: choice.text, decision: choice.text,
    scope: '対象作業', reuse_when: '同じ作業を再開するとき'
  });
  item.field_certainty.content = 'adopted';
  item.field_certainty.decision = 'adopted';
  item.field_certainty.scope = 'observed';
  item.field_certainty.reuse_when = 'observed';
  item.evidence.content = [{id: choice.id, quote: choice.text}];
  item.evidence.decision = [{id: choice.id, quote: choice.text}];
  item.evidence.scope = [{id: choice.id, quote: choice.text}];
  item.evidence.reuse_when = [{id: choice.id, quote: choice.text}];
  item.support_ids = [choice.id];
  validateC({items: [item]}, [choice]);
  assert.equal(retentionDecision(canonicalItemFromC(item, [choice])).storage, 'long');
});

test('adoption decisions are detected per clause', () => {
  const cases = [
    ['実行時の設定はAを採用します。', 'adopted'],
    ['追加確認は不要です。そのまま実行してください。', 'adopted'],
    ['これで進めます。', 'adopted'],
    ['今回はAを採用しません。', 'adopted'],
    ['安全なら実行してください。', 'observed'],
    ['問題なければAを採用します。', 'observed'],
    ['確認できればAを採用します。', 'observed']
  ];
  for (const [text, expected] of cases) {
    const source = span('m1', text, 'user');
    const item = cItem('i1', source, {category: 'decision', content: text, decision: text});
    item.field_certainty.content = 'observed';
    item.field_certainty.decision = 'adopted';
    item.evidence.content = [{id: source.id, quote: text}];
    item.evidence.decision = [{id: source.id, quote: text}];
    item.support_ids = [source.id];
    assert.equal(deriveStatus(item, [source]), expected, text);
  }
});

test('completion keeps the preceding user choice in one incident provenance', () => {
  const request = span('u1', '今後は資料をv2、v3のような世代名で管理したい。', 'user');
  const completion = span('a1', '現行完成版を残し、同一内容をv1として複製しました。SHA-256ハッシュも一致しています。', 'assistant');
  const userItem = cItem('i1', request, {
    category: 'decision', subtype: 'settings', incident_id: 'version-naming', status: 'proposed',
    content: request.text, decision: request.text, scope: '資料の版管理', reuse_when: '資料の版を管理するとき'
  });
  userItem.field_certainty.decision = 'proposed';
  userItem.field_certainty.scope = 'proposed';
  userItem.field_certainty.reuse_when = 'proposed';
  userItem.evidence.decision = [{id: request.id, quote: request.text}];
  userItem.evidence.scope = [{id: request.id, quote: request.text}];
  userItem.evidence.reuse_when = [{id: request.id, quote: request.text}];
  userItem.support_ids = [request.id];

  const completionItem = cItem('i2', completion, {
    category: 'operational', incident_id: 'version-naming', status: 'observed', source_role: 'mixed',
    content: completion.text, scope: '資料の版管理'
  });
  completionItem.field_certainty.scope = 'proposed';
  completionItem.evidence.scope = [{id: request.id, quote: request.text}];
  completionItem.support_ids = [completion.id, request.id];
  const output = {items: [userItem, completionItem]};
  validateC(output, [request, completion]);
  const canonical = output.items.map(item => canonicalItemFromC(item, [request, completion], output));
  const store = buildStore(canonical, at(10), 'C', 'case');
  assert.equal(canonical[0].incident_id, canonical[1].incident_id);
  assert.ok(canonical[1].evidence.scope.some(entry => entry.id === request.id));
  assert.ok(store.records[1].provenance.some(entry => entry.span_id === request.id && entry.speaker === 'user'));
});

test('operational settings retain for the TTL and blank decisions are not retained', () => {
  const source = span('m1', '設定を次回も確認する。');
  const operational = canonicalItemFromC(cItem('i1', source, {category: 'operational', subtype: 'settings'}), [source]);
  const store = buildStore([operational], at(0), 'C', 'case');
  assert.equal(store.records[0].storage, 'short');
  const expiry = new Date(Date.parse(store.records[0].expires_at)).toISOString();
  assert.equal(retrieve('設定', store.records, new Date(Date.parse(expiry) - 1).toISOString()).selected_ids.length, 1);
  assert.equal(retrieve('設定', store.records, expiry).selected_ids.length, 0);
  const blank = {category: 'decision', relation: 'create', fields: Object.fromEntries(V12_FIELD_NAMES.map(field => [field, 'unknown'])), content: 'unknown', decision: 'unknown', scope: 'unknown', reuse_when: 'unknown'};
  assert.equal(retentionDecision(blank).storage, 'none');
});

test('grounded short operational retention is accepted while extra retention is flagged', () => {
  const source = span('m1', 'TypeScriptビルド成功、テスト112件成功。', 'assistant');
  const item = cItem('i1', source, {category: 'operational', subtype: 'testcounts'});
  const shortRecord = {...canonicalItemFromC(item, [source]), source_item_id: item.id, storage: 'short'};
  const shortAudit = qualityAudit({items: [item]}, [source], {records: [shortRecord]});
  assert.equal(shortRecord.storage, 'short');
  assert.equal(shortAudit.counts.overretention, 0);

  const overretained = {...shortRecord, storage: 'long'};
  const blank = {
    source_item_id: 'blank', category: 'reference', relation: 'duplicate', storage: 'short',
    fields: Object.fromEntries(V12_FIELD_NAMES.map(field => [field, 'unknown'])), content: 'unknown', support_ids: [source.id]
  };
  const overAudit = qualityAudit({items: [item]}, [source], {records: [overretained, blank]});
  assert.equal(overAudit.counts.overretention, 2);
});

test('quality audit leaves fragmented incident classification to semantic review', () => {
  const source = span('m1', 'ビルド成功、デプロイ失敗を同じ実行で確認した。', 'tool');
  const build = cItem('i1', source, {category: 'operational', subtype: 'testcounts', incident_id: 'deploy-run'});
  const deploy = cItem('i2', source, {category: 'failure', incident_id: 'deploy-run'});
  const audit = qualityAudit({items: [build, deploy]}, [source]);
  assert.equal(audit.counts.fragmented_incident, 0);
});

test('quality audit does not mark durable context grounding as a target omission', () => {
  const context = {...span('context', '採用方針は次回も必ず再利用する。', 'user'), id: 'context-0:context:full'};
  const target = span('target', '今回の作業を確認した。', 'assistant');
  const item = cItem('i1', target, {content: target.text});
  const audit = qualityAudit({items: [item]}, [context, target]);
  assert.equal(audit.counts.omission, 0);
  assert.deepEqual(audit.findings.filter(findingValue => findingValue.kind === 'omission'), []);
});

test('evidence quotes must match source text and gaps contribute to retrieval', () => {
  const source = span('m1', 'source text');
  const invalid = cItem('i1', source);
  invalid.evidence.content = [{id: source.id, quote: 'altered text'}];
  assert.throws(() => validateC({items: [invalid]}, [source]), /quote/);
  const record = canonicalItemFromC(cItem('i1', source, {content: 'unrelated content', gaps: ['unique unresolved gap']}), [source]);
  const store = buildStore([record], at(0), 'C', 'case');
  assert.deepEqual(retrieve('unique unresolved gap', store.records, at(1)).selected_ids, ['case:C:i1']);
});

test('evaluation input uses per-answer opaque memory, relation, incident and evidence IDs', () => {
  const previous = {
    id: 'case:C:i0', content: 'previous memory', fields: Object.fromEntries(V12_FIELD_NAMES.map(field => [field, field === 'content' ? 'previous memory' : 'unknown'])),
    field_certainty: Object.fromEntries(V12_FIELD_NAMES.map(field => [field, field === 'content' ? 'observed' : 'unknown'])), category: 'reference', subtype: 'unknown',
    incident_id: 'case:C:incident', status: 'observed', source_role: 'user', storage: 'short', storage_reason: 'reference_short_lived', relation: 'create', target_ids: [], gaps: [],
    evidence: Object.fromEntries(V12_FIELD_NAMES.map(field => [field, field === 'content' ? [{id: 'target:m0:full', quote: 'previous memory'}] : []])), provenance: [{span_id: 'target:m0:full', speaker: 'user', session_hash: 'secret-case'}], at: at(0), expires_at: at(2), active: true
  };
  const record = {
    id: 'case:C:i1', content: 'memory content', fields: Object.fromEntries(V12_FIELD_NAMES.map(field => [field, field === 'content' ? 'memory content' : 'unknown'])),
    field_certainty: Object.fromEntries(V12_FIELD_NAMES.map(field => [field, field === 'content' ? 'observed' : 'unknown'])), category: 'reference', subtype: 'unknown',
    incident_id: 'case:C:incident', status: 'observed', source_role: 'user', storage: 'short', storage_reason: 'reference_short_lived', relation: 'update', target_ids: [previous.id], gaps: ['unresolved gap'],
    evidence: Object.fromEntries(V12_FIELD_NAMES.map(field => [field, field === 'content' ? [{id: 'target:m1:full', quote: 'memory content'}] : []])), provenance: [{span_id: 'target:m1:full', speaker: 'user', session_hash: 'secret-case'}], at: at(0), expires_at: at(2), active: true
  };
  const item = {id: 'case', context: [], target: [{id: 'm1', role: 'user', text: 'task', at: at(0)}], task: {text: 'task', at: at(1)}};
  const retrieval = {stores: {B: {records: []}, C: {records: [previous, record]}}, retrieval: {B: {selected_ids: []}, C: {selected_ids: [record.id]}}};
  const input = evaluationInput(item, retrieval, {A: {answer: 'a', used_memory_ids: []}, B: {answer: 'b', used_memory_ids: []}, C: {answer: 'c', used_memory_ids: ['memory-1']}});
  const memory = input.payload.memories_by_answer['answer-1'];
  const cAnswerId = Object.entries(input.memoryMappingByAnswer).find(([, mapping]) => mapping.method === 'C')[0];
  const cMemory = input.payload.memories_by_answer[cAnswerId][0];
  assert.deepEqual(memory, []);
  assert.equal(cMemory.id, 'memory-2');
  assert.equal(cMemory.incident_id, 'incident-1');
  assert.deepEqual(cMemory.target_ids, ['memory-1']);
  assert.equal(cMemory.gaps[0], 'unresolved gap');
  assert.equal(cMemory.provenance, undefined);
  assert.equal(cMemory.storage_reason, undefined);
  assert.equal(cMemory.evidence.content[0].id, 'evidence-2');
  assert.equal(input.payload.candidates_by_answer[cAnswerId][0].id, 'memory-1');
  assert.equal(input.payload.candidates_by_answer[cAnswerId][1].id, 'memory-2');
  assert.equal(input.payload.answers.find(answer => answer.id === cAnswerId).used_memory_ids[0], 'memory-2');
  assert.equal(input.memoryMappingByAnswer[cAnswerId].records[1].raw_id, record.id);
  assert.equal(input.memoryMappingByAnswer[cAnswerId].method, 'C');
});

test('calibration report creates and consumes a jobs array through quality review', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-utility-v12-calibration-'));
  fs.chmodSync(root, 0o700);
  const calibrationCases = Array.from({length: POLICY.calibration_count}, (_, index) => {
    const message = {id: `m${index}`, role: 'user', text: `calibration source ${index}`, at: at(index)};
    return {id: `cal-${index}`, context: [], target: [message], task: {text: `task ${index}`, at: at(index, 1)}, boundary: at(index, 1)};
  });
  const ctx = {root, m: {calibration_cases: calibrationCases}};
  const first = calibrationStage(ctx);
  assert.equal(first.jobs, POLICY.calibration_count);
  for (const item of calibrationCases) {
    const spans = segments(item.target, 'target');
    outputForJob(root, `calibrate-c-${item.id}`, {items: [cItem('i1', spans[0], {support_ids: []})]});
  }
  writeSealed(root, 'host-context', {common_memory_hash: `sha256:${'a'.repeat(64)}`, policy: POLICY.context_policy});
  const pendingQuality = calibrationReportStage(ctx);
  assert.equal(pendingQuality.status, 'calibration_quality_incomplete');
  const qualityArtifact = JSON.parse(fs.readFileSync(path.join(root, 'calibration-quality-jobs.json'), 'utf8'));
  assert.ok(Array.isArray(qualityArtifact.jobs));
  assert.equal(qualityArtifact.jobs.length, POLICY.calibration_count);
  for (const qualityJob of qualityArtifact.jobs) {
    const job = JSON.parse(fs.readFileSync(path.join(root, `job-${qualityJob.id}.json`), 'utf8'));
    const spans = job.private.spans;
    const extracted = job.private.extracted_items;
    assert.deepEqual(job.payload.support_ids_by_item, {'item-1': ['span-1']});
    assert.equal(job.payload.extracted.items[0].id, 'item-1');
    assert.deepEqual(job.payload.extracted.items[0].support_ids, ['span-1']);
    assert.equal(job.payload.span_catalog[0].ordinal, 'span-1');
    assert.equal(job.payload.span_catalog[0].canonical_id, spans[0].id);
    assert.match(job.prompt, new RegExp(JSON.stringify(V12_FIELD_NAMES).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
    assert.match(job.prompt, /short TTL/u);
    assert.match(job.prompt, /scopeがtargetのturnだけ/u);
    assert.match(job.prompt, /contextだけに現れる/u);
    assert.match(job.prompt, /checked_setはcontextも含め/u);
    const output = {status: 'passed', checked_kinds: [...V12_QUALITY_KINDS], checked_set: spans.map(value => ({id: value.id, quote: value.text})),
      item_checks: extracted.map(value => ({item_id: value.id, checked_fields: [...V12_FIELD_NAMES], support_ids: [spans[0].id]})), findings: [],
      positive_evidence: V12_QUALITY_KINDS.map(kind => ({kind, result: 'passed', reason: `reviewed ${kind}`, support_ids: [spans[0].id]}))};
    outputForJob(root, qualityJob.id, output);
  }
  const report = calibrationReportStage(ctx);
  assert.equal(report.status, 'passed');
  assert.equal(report.quality_status, 'passed');
});

test('manifest selection fails closed without the canonical baseline and accepts an explicit override', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-utility-v12-manifest-'));
  fs.chmodSync(root, 0o700);
  const sourceFile = path.join(root, 'source.txt');
  fs.writeFileSync(sourceFile, 'synthetic source\n', {mode: 0o600});
  const sourceCases = Array.from({length: 120}, (_, index) => {
    const id = `case-${String(index).padStart(3, '0')}`;
    const turns = [{
      id: `turn-${index}`,
      role: 'user',
      content: `決定: 必ずこの方針を使う。 fixture request ${index}`,
      observed_at: at(index)
    }];
    return {
      id,
      group_id: `group-${index}`,
      turns,
      source_hash: hash(turns),
      review_text_hash: hash(turns),
      dataset_role: 'development',
      cohort: index < 40 ? 'challenge' : 'sampled_development',
      session_hash: `session-${index}`,
      prior_ai_exposure: 'unknown',
      legacy_exposure_preserved: true
    };
  });
  const sourceManifest = createManifest(sourceCases, {
    experimentId: 'v12-synthetic-source',
    sources: {fixture: {path: sourceFile, hash: hash(fs.readFileSync(sourceFile, 'utf8'))}},
    fixtureHash: hash(fs.readFileSync(sourceFile, 'utf8'))
  });
  const sourcePath = path.join(root, 'source-manifest.json');
  fs.writeFileSync(sourcePath, `${JSON.stringify(sourceManifest)}\n`, {mode: 0o600});
  const priorCases = sourceCases.slice(0, 10).map(item => ({
    id: item.id,
    group_id: item.group_id,
    source_hash: item.source_hash,
    target: [{id: item.turns[0].id, role: 'user', text: item.turns[0].content, at: item.turns[0].observed_at}],
    context: [],
    task: {text: 'next task', at: '2026-01-02T00:00:00.000Z'},
    boundary: '2026-01-02T00:00:00.000Z'
  }));
  const priorPath = path.join(root, 'synthetic-v11.json');
  fs.writeFileSync(priorPath, `${JSON.stringify(seal({contract: 'memory-utility-manifest/v1.1', cases: priorCases, calibration_cases: []}))}\n`, {mode: 0o600});
  assert.throws(() => buildV12Manifest(sourcePath, {
    priorManifestPaths: [priorPath], sourceCases: sourceCases, experimentId: 'v12-no-implicit-baseline'
  }), /prior_fixed10_unavailable/);
  const manifest = buildV12Manifest(sourcePath, {
    priorManifestPaths: [priorPath], canonicalBaselinePath: priorPath,
    sourceCases, experimentId: 'v12-explicit-baseline'
  });
  assert.equal(manifest.canonical_baseline.path, path.resolve(priorPath));
  assert.deepEqual(manifest.selected_counts, {original: 10, holdout: 5, calibration: 5, evaluation: 15});
});

test('evaluation keeps structurally valid failed quality evidence for comparison', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-utility-v12-evaluation-quality-'));
  fs.chmodSync(root, 0o700);
  const item = {id: 'case', context: [], target: [{id: 'm1', role: 'user', text: 'task', at: at(0)}], task: {text: 'task', at: at(1)}, workspace_root: null};
  const emptyRetrieval = {stores: {B: {records: []}, C: {records: []}}, retrieval: {B: {selected_ids: []}, C: {selected_ids: []}}};
  writeSealed(root, 'retrieval', {contract: 'memory-utility-retrieval/v1.2', cases: {case: emptyRetrieval}});
  const ctx = {root, m: {content_hash: `sha256:${'a'.repeat(64)}`, cases: [item]}, config: {common_information: 'common'}};
  writeSealed(root, 'quality-report', {
    contract: 'memory-utility-quality-report/v1.2', parent_hash: `sha256:${'b'.repeat(64)}`,
    status: 'failed', quality_status: 'failed', semantic_model_required: true,
    cases: [{case_id: 'case', status: 'failed', findings: [{kind: 'fabricated_reason', item_id: 'i1', reason: 'synthetic finding', support_ids: ['target:m1:1']}]}]
  });
  replayStage(ctx);
  const replayJobs = JSON.parse(fs.readFileSync(path.join(root, 'replay-jobs.json'), 'utf8'));
  for (const jobRef of replayJobs.jobs) outputForJob(root, jobRef.id, {answer: 'answer', used_memory_ids: []});
  const result = evaluationStage(ctx);
  assert.equal(result.blind, true);
  assert.equal(result.jobs, 1);
  assert.equal(result.pending.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'evaluation-jobs.json'), 'utf8')).quality_status, 'failed');
});

test('evaluation remains blocked while downstream quality is missing or held', () => {
  const makeContext = (held = false) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-utility-v12-quality-gate-'));
    fs.chmodSync(root, 0o700);
    const item = {id: 'case', context: [], target: [{id: 'm1', role: 'user', text: 'task', at: at(0)}], task: {text: 'task', at: at(1)}, workspace_root: null};
    writeSealed(root, 'retrieval', {contract: 'memory-utility-retrieval/v1.2', cases: {case: {stores: {B: {records: []}, C: {records: []}}, retrieval: {B: {selected_ids: []}, C: {selected_ids: []}}}}});
    writeSealed(root, 'quality-jobs', {contract: 'memory-utility-quality-jobs/v1.2', parent_hash: `sha256:${'a'.repeat(64)}`, jobs: [{id: 'quality-case', job_hash: `sha256:${'b'.repeat(64)}`} ]});
    if (held) writeSealed(root, 'initial-quality-case', {job_hash: `sha256:${'b'.repeat(64)}`, parsed: null});
    return {root, m: {content_hash: `sha256:${'c'.repeat(64)}`, cases: [item]}, config: {common_information: 'common'}};
  };
  const missing = makeContext();
  const held = makeContext(true);
  assert.equal(evaluationStage(missing).status, 'quality_incomplete');
  assert.equal(evaluationStage(held).status, 'quality_held');
  assert.throws(() => replayStage(missing), /quality_incomplete/);
  assert.throws(() => replayStage(held), /quality_held/);
});

test('C IDs are explicit in both prompt and transport schema, while support IDs derive from field evidence', () => {
  assert.match(C_INSTRUCTION, /idとtarget_idsは必ずi1、i2/);
  assert.match(C_INSTRUCTION, /現在仕様、実装済み制約、未反映または条件付き/);
  assert.match(C_INSTRUCTION, /先行user span.*decisionまたはscope evidence.*canonical化時のprovenance/u);
  assert.match(C_INSTRUCTION, /同じincident_id.*意味の異なるitem/u);
  assert.match(C_INSTRUCTION, /成功・失敗・gap・修正・結果を別incidentに分割せず/u);
  assert.match(C_INSTRUCTION, /source_roleは全9つのfield（content、decision、rationale、symptom、cause、correction、outcome、reuse_when、scope）のevidenceを合算.*role集合/u);
  assert.match(C_INSTRUCTION, /assistant span.*content evidence.*user span.*scope evidence.*source_roleはmixed/u);
  assert.equal(V12_C_OUTPUT_SCHEMA.properties.items.items.properties.id.pattern, undefined);
  assert.equal(V12_C_OUTPUT_SCHEMA.properties.items.items.properties.target_ids.items.pattern, undefined);
  const source = span('m1', 'support evidence');
  const item = cItem('i1', source, {support_ids: []});
  validateC({items: [item]}, [source]);
  const canonical = canonicalItemFromC(item, [source]);
  assert.deepEqual(canonical.support_ids, [source.id]);
  assert.throws(() => validateC({items: [cItem('item-1', source)]}, [source]), /c_item_id_invalid/);
});

test('source_role is derived from all nine field evidence roles, including scope', () => {
  const assistant = span('assistant', 'assistant report', 'assistant');
  const user = span('user', 'user-selected scope', 'user');
  const mixed = cItem('i1', assistant, {
    source_role: 'mixed',
    scope: user.text,
    support_ids: [assistant.id, user.id]
  });
  mixed.field_certainty.scope = 'observed';
  mixed.evidence.scope = [{id: user.id, quote: user.text}];
  validateC({items: [mixed]}, [assistant, user]);

  const spoofed = structuredClone(mixed);
  spoofed.source_role = 'assistant';
  assert.throws(() => validateC({items: [spoofed]}, [assistant, user]), /source_role_spoof/);

  const assistantOnly = cItem('i1', assistant);
  validateC({items: [assistantOnly]}, [assistant]);

  const empty = cItem('i1', assistant, {
    source_role: 'unknown', support_ids: [],
    ...Object.fromEntries(V12_FIELD_NAMES.map(field => [field, 'unknown'])),
    field_certainty: Object.fromEntries(V12_FIELD_NAMES.map(field => [field, 'unknown'])),
    evidence: Object.fromEntries(V12_FIELD_NAMES.map(field => [field, []]))
  });
  validateC({items: [empty]}, [assistant]);
});

test('job schemas use bounded ordered references without changing frozen B', () => {
  const context = segments([{id: 'context-turn', role: 'user', text: '先行ユーザー選択', at: at(0)}], 'context-0');
  const target = segments([{id: 'target-turn', role: 'assistant', text: '実行結果', at: at(1)}], 'target');
  const spans = [...context, ...target];
  const cJob = {private: {stage: 'extract', method: 'C', spans}};
  const cSchema = v12SchemaForJob(cJob);
  for (const field of V12_FIELD_NAMES) {
    assert.equal(cSchema.properties.items.items.properties.evidence.properties[field].items.properties.id.enum, undefined);
  }
  assert.equal(cSchema.properties.items.items.properties.support_ids.items.enum, undefined);
  assert.equal(cSchema.properties.items.maxItems, V12_MAX_ITEM_REFS);
  assert.equal(cSchema.properties.items.items.properties.evidence.properties.content.items.properties.id.type, 'string');
  assert.equal(v12SchemaHashForJob(cJob), hash(cSchema));
  assert.equal(v12SchemaHashForJob(cJob), v12SchemaHashForJob(cJob));
  const extra = segments([{id: 'extra-turn', role: 'tool', text: '追加結果', at: at(2)}], 'target-extra');
  assert.equal(v12SchemaHashForJob({private: {stage: 'extract', method: 'C', spans: [...spans, ...extra]}}), v12SchemaHashForJob(cJob));
  const manySpans = Array.from({length: 436}, (_, index) => span(`many-${index}`, `source ${index}`));
  const manySchema = v12SchemaForJob({private: {stage: 'extract', method: 'C', spans: manySpans}});
  assert.equal(manySchema.properties.items.items.properties.evidence.properties.content.items.properties.id.enum, undefined);
  assert.ok(manySpans.length < V12_MAX_SPAN_REFS);

  const item = cItem('i1', target[0], {source_role: 'mixed', scope: context[0].text, support_ids: [target[0].id, context[0].id]});
  item.field_certainty.scope = 'observed';
  item.evidence.scope = [{id: context[0].id, quote: context[0].text}];
  const transport = {
    items: [{...item, evidence: Object.fromEntries(V12_FIELD_NAMES.map(field => [field, item.evidence[field].map(entry => ({id: entry.id}))]))}]
  };
  transport.items[0].evidence = Object.fromEntries(V12_FIELD_NAMES.map(field => [
    field, transport.items[0].evidence[field].map(entry => ({id: spanRef(entry.id, spans)}))
  ]));
  transport.items[0].support_ids = item.support_ids.map(id => spanRef(id, spans));
  const validateCTransport = new Ajv({strict: false}).compile(cSchema);
  assert.equal(validateCTransport(transport), true);
  const invalidC = structuredClone(transport);
  invalidC.items[0].evidence.scope[0].id = 'span-99';
  // Ordinal references are intentionally generic strings in the transport
  // schema; the private ordered catalog is the runtime range check.
  assert.equal(validateCTransport(invalidC), true);
  assert.throws(() => hydrateCOutput(invalidC, spans), /c_transport_evidence:scope_unknown_id:span-99/);
  const hydrated = hydrateAcceptedOutput(cJob, transport).output;
  validateC(hydrated, spans);
  assert.equal(hydrated.items[0].evidence.scope[0].quote, context[0].text);

  const qSchema = v12SchemaForJob({private: {stage: 'quality', spans, extracted_items: [item]}});
  assert.equal(qSchema.properties.checked_set.items.properties.id.enum, undefined);
  for (const property of ['item_checks', 'findings', 'positive_evidence']) {
    assert.equal(qSchema.properties[property].items.properties.support_ids.items.enum, undefined);
  }
  assert.equal(qSchema.properties.item_checks.items.properties.item_id.enum, undefined);
  assert.equal(qSchema.properties.findings.items.properties.item_id.enum, undefined);
  const qualityTransport = {
    status: 'passed', checked_kinds: [...V12_QUALITY_KINDS], checked_set: spans.map((_, index) => ({id: `span-${index + 1}`})),
    item_checks: [{item_id: 'item-1', checked_fields: [...V12_FIELD_NAMES], support_ids: ['span-1']}], findings: [],
    positive_evidence: V12_QUALITY_KINDS.map(kind => ({kind, result: 'passed', reason: 'checked', support_ids: ['span-1']}))
  };
  const validateQualityTransport = new Ajv({strict: false}).compile(qSchema);
  assert.equal(validateQualityTransport(qualityTransport), true);
  const invalidQuality = structuredClone(qualityTransport);
  invalidQuality.checked_set[0].id = 'span-99';
  assert.equal(validateQualityTransport(invalidQuality), true);
  assert.throws(() => hydrateQualityOutput(invalidQuality, spans, [item]), /quality_checked_set_transport_unknown_id:span-99/);

  const bJob = {private: {stage: 'extract', method: 'B'}};
  assert.equal(v12SchemaForJob(bJob), V12_TRANSPORT_SCHEMAS['extract-b']);
  assert.equal(v12SchemaHashForJob(bJob), V12_SCHEMA_HASHES['extract-b']);
});

test('all v1.2 transport schemas stay below the enum budget and avoid references', () => {
  for (const [name, schema] of Object.entries(V12_TRANSPORT_SCHEMAS)) {
    const preflight = V12_SCHEMA_PREFLIGHT[name];
    assert.ok(preflight, `missing preflight for ${name}`);
    assert.equal(preflight.enum_limit, V12_ENUM_VALUE_LIMIT);
    assert.equal(preflight.enum_values, countSchemaEnumValues(schema));
    assert.ok(preflight.enum_values <= V12_ENUM_VALUE_LIMIT);
    const visit = value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      assert.equal(Object.hasOwn(value, '$defs'), false, `${name} has $defs`);
      assert.equal(Object.hasOwn(value, '$ref'), false, `${name} has $ref`);
      for (const child of Object.values(value)) visit(child);
    };
    visit(schema);
  }
});

test('generated C jobs expose one ordered span catalog and account for exact schema bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-utility-v12-c-catalog-'));
  fs.chmodSync(root, 0o700);
  const item = {
    id: 'catalog-case',
    context: [[{id: 'context-turn', role: 'user', text: 'context line', at: at(0)}]],
    target: [{id: 'target-turn', role: 'assistant', text: 'target line', at: at(1)}],
    task: {text: 'catalog task', at: at(2)}
  };
  calibrationStage({root, m: {calibration_cases: [item]}});
  const job = JSON.parse(fs.readFileSync(path.join(root, 'job-calibrate-c-catalog-case.json'), 'utf8'));
  assert.equal(job.payload.target, undefined);
  assert.equal(job.payload.context, undefined);
  assert.deepEqual(job.payload.span_catalog.map(entry => entry.ordinal), ['span-1', 'span-2']);
  assert.deepEqual(job.payload.span_catalog.map(entry => entry.canonical_id), job.private.spans.map(spanValue => spanValue.id));
  assert.match(job.prompt, /span_catalog/u);
  assert.match(job.prompt, /source_roleは全9つのfield（content、decision、rationale、symptom、cause、correction、outcome、reuse_when、scope）のevidenceを合算.*role集合/u);
  assert.match(job.prompt, /assistant spanをcontent evidenceに使い、user spanをscope evidenceに使うitemのsource_roleはmixed/u);
  const prepared = prepareCliStage({root}, {job: 'calibrate-c-catalog-case'});
  const schemaText = fs.readFileSync(prepared.schema_path, 'utf8');
  const promptText = fs.readFileSync(prepared.prompt_path, 'utf8');
  const request = JSON.parse(fs.readFileSync(prepared.request, 'utf8'));
  assert.equal(schemaText, serializeV12Schema(v12SchemaForJob(job)));
  assert.equal(Buffer.byteLength(schemaText, 'utf8'), job.schema_bytes);
  assert.equal(Buffer.byteLength(promptText, 'utf8'), job.prompt_bytes);
  assert.equal(request.schema_bytes + request.prompt_bytes, request.input_bytes);
  assert.equal(request.input_bytes, job.input_bytes);
});

test('generated C jobs accept the largest corpus span catalog within the bounded input budget', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-utility-v12-large-catalog-'));
  fs.chmodSync(root, 0o700);
  const target = Array.from({length: 436}, (_, index) => ({
    id: `large-turn-${index + 1}`,
    role: index % 3 === 0 ? 'user' : index % 3 === 1 ? 'assistant' : 'tool',
    text: `source line ${index + 1}: bounded ordinal catalog fixture`,
    at: at(index)
  }));
  const item = {id: 'large-catalog-case', context: [], target, task: {text: 'large catalog task', at: at(437)}};
  const result = calibrationStage({root, m: {calibration_cases: [item]}});
  assert.equal(result.jobs, 1);
  const job = JSON.parse(fs.readFileSync(path.join(root, 'job-calibrate-c-large-catalog-case.json'), 'utf8'));
  assert.equal(job.private.spans.length, 436);
  assert.equal(job.payload.span_catalog.length, 436);
  assert.equal(job.payload.span_catalog[0].ordinal, 'span-1');
  assert.equal(job.payload.span_catalog.at(-1).ordinal, 'span-436');
  assert.equal(job.payload.span_catalog.at(-1).canonical_id, job.private.spans.at(-1).id);
  assert.ok(job.input_bytes <= MAX_INPUT_BYTES);
});

test('schema preflight rejects an enum budget overrun', () => {
  const overBudget = {type: 'string', enum: Array.from({length: V12_ENUM_VALUE_LIMIT + 1}, (_, index) => `value-${index}`)};
  assert.throws(
    () => assertV12SchemaPreflight({over_budget: overBudget}),
    new RegExp(`v12_schema_enum_limit:over_budget:${V12_ENUM_VALUE_LIMIT + 1}`)
  );
});

test('ordinal hydration preserves source order and rejects collisions or tampering', () => {
  const spans = [span('first', 'first source'), span('second', 'second source')];
  const item = cItem('i1', spans[0], {
    content: spans[1].text,
    evidence: Object.fromEntries(V12_FIELD_NAMES.map(field => [field, field === 'content' ? [{id: 'span-2'}] : []])),
    support_ids: ['span-2']
  });
  const hydrated = hydrateCOutput({items: [{...item, evidence: item.evidence, support_ids: item.support_ids}]}, spans);
  assert.deepEqual(hydrated.items[0].evidence.content, [{id: spans[1].id, quote: spans[1].text}]);
  assert.deepEqual(hydrated.items[0].support_ids, [spans[1].id]);

  assert.throws(
    () => hydrateCOutput({items: [{...item, evidence: {...item.evidence, content: [{id: 'span-3'}]}}]}, spans),
    /c_transport_evidence:content_unknown_id:span-3/
  );
  assert.throws(
    () => hydrateCOutput({items: [{...item, evidence: {...item.evidence, content: [{id: 'span-1'}, {id: 'span-1'}]}}]}, spans),
    /c_transport_evidence:content_duplicate/
  );
  assert.throws(
    () => hydrateCOutput({items: [{...item, evidence: item.evidence, support_ids: ['span-2', 'span-2']}]}, spans),
    /c_transport_support_ids_duplicate/
  );
  assert.throws(
    () => hydrateCOutput({items: [{...item, evidence: item.evidence, support_ids: ['span-99']}]}, spans),
    /c_transport_support_ids_unknown_id:span-99/
  );
  assert.throws(
    () => hydrateCOutput({items: [{...item, evidence: item.evidence, support_ids: ['span-1']}]}, [spans[0], {...spans[1], id: spans[0].id}]),
    /c_transport_id_collision/
  );

  const quality = {
    status: 'passed', checked_kinds: [...V12_QUALITY_KINDS], checked_set: [{id: 'span-2'}],
    item_checks: [{item_id: 'item-1', checked_fields: [...V12_FIELD_NAMES], support_ids: ['span-2']}],
    findings: [], positive_evidence: V12_QUALITY_KINDS.map(kind => ({kind, result: 'passed', reason: 'checked', support_ids: ['span-2']}))
  };
  const qualityHydrated = hydrateQualityOutput(quality, spans, [item]);
  assert.deepEqual(qualityHydrated.checked_set, [{id: spans[1].id, quote: spans[1].text}]);
  assert.equal(qualityHydrated.item_checks[0].item_id, item.id);
  assert.deepEqual(qualityHydrated.item_checks[0].support_ids, [spans[1].id]);
  assert.throws(
    () => hydrateQualityOutput(quality, spans, [item, {...item, id: item.id}]),
    /quality_transport_id_collision/
  );
});

test('input byte accounting accepts the exact limit and holds an over-limit job', () => {
  const makeBoundaryJob = (root, id, prompt) => {
    const privateData = {stage: 'replay', method: 'A', case_id: 'boundary-case', memory_ids: []};
    const schema = v12SchemaForJob({private: privateData});
    const inputBytes = v12InputByteAccounting(prompt, schema);
    const job = seal({
      id, payload: {memories: []}, private: privateData, prompt, ...inputBytes,
      schema_encoding: V12_SCHEMA_ENCODING, expected_model: 'gpt-5.6-sol', expected_effort: 'medium',
      schema_hash: hash(schema), runner_hash: RUNNER_HASH
    });
    writePrivateJson(path.join(root, `job-${id}.json`), job);
    return {privateData, schema, inputBytes};
  };
  const schemaBytes = v12InputByteAccounting('', V12_REPLAY_OUTPUT_SCHEMA).schema_bytes;
  const exactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-utility-v12-input-exact-'));
  fs.chmodSync(exactRoot, 0o700);
  const exactPrompt = 'x'.repeat(MAX_INPUT_BYTES - schemaBytes);
  const exact = makeBoundaryJob(exactRoot, 'replay-boundary-exact', exactPrompt);
  assert.equal(exact.inputBytes.input_bytes, MAX_INPUT_BYTES);
  const prepared = prepareCliStage({root: exactRoot}, {job: 'replay-boundary-exact'});
  assert.equal(prepared.id, 'replay-boundary-exact');
  assert.equal(JSON.parse(fs.readFileSync(path.join(exactRoot, 'cli-request-replay-boundary-exact.json'), 'utf8')).input_bytes, MAX_INPUT_BYTES);

  const overRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-utility-v12-input-over-'));
  fs.chmodSync(overRoot, 0o700);
  const over = makeBoundaryJob(overRoot, 'replay-boundary-over', `${exactPrompt}x`);
  assert.equal(over.inputBytes.input_bytes, MAX_INPUT_BYTES + 1);
  assert.throws(() => prepareCliStage({root: overRoot}, {job: 'replay-boundary-over'}), /input_limit_exceeded:replay-boundary-over/);
  const marker = JSON.parse(fs.readFileSync(path.join(overRoot, 'unexecuted-replay-boundary-over.json'), 'utf8'));
  assert.equal(marker.reason, 'input_limit_exceeded');
  assert.equal(marker.input_bytes, MAX_INPUT_BYTES + 1);
  assert.equal(fs.existsSync(path.join(overRoot, 'active-cli.json')), false);
});

test('the v1.1 CLI runner remains byte-frozen for the v1.2 experiment', () => {
  const file = path.join(path.dirname(new URL(import.meta.url).pathname), 'memory-utility-v11-cli.mjs');
  const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.equal(digest, 'cd9b166a419c935e421591ebb4db84d7a231a29edf2612f85aeb6cc9b7e152cb');
});

test('main CLI acceptance path verifies the full native session before accepting', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-utility-v12-native-accept-'));
  fs.chmodSync(root, 0o700);
  const sessionsRoot = path.join(root, 'sessions');
  fs.mkdirSync(sessionsRoot, {mode: 0o700});
  const caseId = 'native-accept-case';
  const id = `replay-a-${caseId}`;
  const prompt = 'Return the supplied synthetic replay JSON.';
  const raw = JSON.stringify({answer: 'native answer', used_memory_ids: []});
  const schemaHash = hash(V12_REPLAY_OUTPUT_SCHEMA);
  const inputBytes = v12InputByteAccounting(prompt, V12_REPLAY_OUTPUT_SCHEMA);
  const job = seal({
    id,
    payload: {memories: []},
    private: {stage: 'replay', method: 'A', case_id: caseId, memory_ids: []},
    prompt,
    ...inputBytes,
    schema_encoding: V12_SCHEMA_ENCODING,
    expected_model: 'gpt-5.6-sol',
    expected_effort: 'medium',
    schema_hash: schemaHash,
    runner_hash: RUNNER_HASH
  });
  writePrivateJson(path.join(root, `job-${id}.json`), job);
  const promptPath = path.join(root, `dispatch-${id}.txt`);
  const schemaPath = path.join(root, `cli-schema-${id}.json`);
  const requestPath = path.join(root, `cli-request-${id}.json`);
  const activePath = path.join(root, 'active-cli.json');
  const attemptsPath = path.join(root, `cli-attempts-${id}.json`);
  writePrivateText(promptPath, prompt);
  writePrivateText(schemaPath, serializeV12Schema(V12_REPLAY_OUTPUT_SCHEMA));
  const preparedAt = new Date(Date.now() - 2_000).toISOString();
  const active = seal({contract: CLI_ACTIVE_CONTRACT, job_id: id, job_hash: job.content_hash, prompt_hash: hash(prompt), schema_hash: schemaHash, runner_hash: RUNNER_HASH, prepared_at: preparedAt, ...inputBytes});
  writePrivateJson(activePath, active);
  const request = seal({
    contract: CLI_REQUEST_CONTRACT, job_hash: job.content_hash, prompt_hash: hash(prompt),
    prompt_path: promptPath, schema_path: schemaPath, schema_hash: schemaHash, runner_hash: RUNNER_HASH,
    attempts_path: attemptsPath, active_path: activePath, model: 'gpt-5.6-sol', effort: 'medium', cwd: CLI_ROOT,
    sandbox: 'read-only', timeout_ms: V12_TIMEOUT_MS, max_attempts: V12_MAX_ATTEMPTS,
    prepared_at: preparedAt, active_hash: active.content_hash, ...inputBytes
  });
  writePrivateJson(requestPath, request);
  const eventsPath = path.join(root, `cli-events-${id}-attempt-1.jsonl`);
  const outputPath = path.join(root, `cli-output-${id}-attempt-1.json`);
  const stderrPath = path.join(root, `cli-stderr-${id}-attempt-1.log`);
  writePrivateText(outputPath, raw);
  writePrivateText(stderrPath, '');
  const sessionId = '01a00000-0000-7000-8000-000000000321';
  writePrivateText(eventsPath, [
    {type: 'thread.started', thread_id: sessionId},
    {type: 'turn.started'},
    {type: 'item.completed', item: {type: 'agent_message', text: raw}},
    {type: 'turn.completed', usage: {input_tokens: 1, output_tokens: 2}}
  ].map(row => JSON.stringify(row)).join('\n'));
  const startedAt = new Date(Date.now() - 1_000).toISOString();
  const finalAt = new Date(Date.now() - 500).toISOString();
  const date = new Date(fs.statSync(eventsPath).mtimeMs).toISOString().slice(0, 10).replaceAll('-', '/');
  const sessionDir = path.join(sessionsRoot, date);
  fs.mkdirSync(sessionDir, {recursive: true, mode: 0o700});
  fs.chmodSync(sessionDir, 0o700);
  const nativeLog = [
    {timestamp: startedAt, type: 'session_meta', payload: {id: sessionId, source: 'exec', cwd: CLI_ROOT, timestamp: startedAt}},
    {timestamp: startedAt, type: 'response_item', payload: {type: 'message', role: 'developer', content: [{type: 'input_text', text: 'MEMORY_SUMMARY BEGINS\nsynthetic common host memory'}]}},
    {timestamp: startedAt, type: 'turn_context', payload: {model: 'gpt-5.6-sol', effort: 'medium', sandbox_policy: {type: 'read-only'}}},
    {timestamp: startedAt, type: 'response_item', payload: {type: 'message', role: 'user', content: [{type: 'input_text', text: prompt}], internal_chat_message_metadata_passthrough: {content_item_kinds: ['user.text']}}},
    {timestamp: finalAt, type: 'response_item', payload: {type: 'message', role: 'assistant', phase: 'final_answer', content: [{type: 'output_text', text: raw}]}}
  ];
  writePrivateText(path.join(sessionDir, `rollout-${sessionId}.jsonl`), nativeLog.map(row => JSON.stringify(row)).join('\n') + '\n');
  const descriptor = seal({
    contract: CLI_ATTEMPT_CONTRACT, job_id: id, job_hash: job.content_hash, prompt_hash: hash(prompt),
    schema_hash: schemaHash, runner_hash: RUNNER_HASH, attempt: 1, final_present: true, quiesced: true,
    events_path: eventsPath, output_path: outputPath, stderr_path: stderrPath, session_id: sessionId,
    native_status: 'available', retry: {status: 'final', retryable: false, reason: 'final_present'},
    usage: {input_tokens: 1, output_tokens: 2}
  });
  writePrivateJson(path.join(root, `cli-attempt-${id}-1.json`), descriptor);
  writePrivateJson(path.join(root, `cli-attempts-${id}.json`), seal({
    contract: CLI_ATTEMPTS_CONTRACT, job_id: id, job_hash: job.content_hash, prompt_hash: hash(prompt),
    schema_hash: schemaHash, runner_hash: RUNNER_HASH, max_attempts: V12_MAX_ATTEMPTS,
    attempts: [{...descriptor, attempt_hash: descriptor.content_hash}]
  }));
  const result = await acceptCliStage({
    root,
    m: {cases: [{id: caseId, context: [], target: [], task: {text: 'task', at: startedAt}}], calibration_cases: []}
  }, {job: id, 'sessions-root': sessionsRoot});
  assert.equal(result.status, 'accepted');
  const accepted = JSON.parse(fs.readFileSync(path.join(root, `accepted-${id}.json`), 'utf8'));
  assert.deepEqual(accepted.output, {answer: 'native answer', used_memory_ids: []});
  assert.equal(accepted.execution_transport, V12_EXECUTION_TRANSPORT);
  assert.equal(fs.existsSync(path.join(root, `cli-completed-${id}.json`)), true);
});

test('main C acceptance hydrates IDs-only transport, reloads canonically, and holds tampering', async () => {
  const source = span('citation', 'source <oai-mem-citation><citation_entries>synthetic</citation_entries></oai-mem-citation>');
  const output = {items: [cItem('i1', source, {content: 'Synthetic summary.'})]};
  const transport = cTransportOutput(output, [source]);
  const raw = escapedJson(transport);
  assert.deepEqual(JSON.parse(raw), transport);
  assert.equal(raw.includes('<oai-mem-citation>'), false);

  const caseId = 'ids-only-citation-case';
  const privateData = {stage: 'extract', method: 'C', case_id: caseId, spans: [source]};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-utility-v12-ids-only-c-'));
  fs.chmodSync(root, 0o700);
  const sessionsRoot = path.join(root, 'sessions');
  fs.mkdirSync(sessionsRoot, {mode: 0o700});
  const fixture = writeNativeAcceptanceFixture({
    root, sessionsRoot, caseId, id: `extract-c-${caseId}`, prompt: 'Return the supplied synthetic C JSON.',
    raw, schema: V12_C_OUTPUT_SCHEMA, privateData, payload: {target: [source]},
    sessionId: '01a00000-0000-7000-8000-000000000322'
  });
  const result = await acceptCliStage(acceptanceContext(root, caseId), {job: fixture.id, 'sessions-root': sessionsRoot});
  assert.equal(result.status, 'accepted');
  const initialPath = path.join(root, `initial-${fixture.id}.json`);
  const acceptedPath = path.join(root, `accepted-${fixture.id}.json`);
  const initial = JSON.parse(fs.readFileSync(initialPath, 'utf8'));
  const accepted = JSON.parse(fs.readFileSync(acceptedPath, 'utf8'));
  assert.equal(initial.raw, raw);
  assert.deepEqual(initial.parsed, transport);
  assert.deepEqual(JSON.parse(initial.raw), initial.parsed);
  assert.equal(initial.parsed_hash, hash(transport));
  assert.equal(initial.canonical_hash, hash(output));
  assert.deepEqual(accepted.output, output);
  assert.equal(accepted.output.items[0].evidence.content[0].quote, source.text);
  assert.equal(accepted.output.items[0].content, 'Synthetic summary.');
  assert.deepEqual(reloadOutputForJob(root, fixture.id), output);

  const rawBeforeTamper = initial.raw;
  const {content_hash: _contentHash, ...acceptedBody} = accepted;
  acceptedBody.output = {...acceptedBody.output, items: acceptedBody.output.items.map(item => ({...item, content: 'altered canonical output'}))};
  fs.writeFileSync(acceptedPath, `${JSON.stringify({...acceptedBody, content_hash: hash(acceptedBody)}, null, 2)}\n`, {mode: 0o600});
  fs.chmodSync(acceptedPath, 0o600);
  assert.throws(() => reloadOutputForJob(root, fixture.id), /answer_binding_changed/);
  assert.equal(JSON.parse(fs.readFileSync(initialPath, 'utf8')).raw, rawBeforeTamper);
  assert.equal(fs.readFileSync(fixture.outputPath, 'utf8'), raw);

  const wrapperCaseId = 'wrapped-citation-case';
  const wrapperRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-utility-v12-wrapped-c-'));
  fs.chmodSync(wrapperRoot, 0o700);
  const wrapperSessionsRoot = path.join(wrapperRoot, 'sessions');
  fs.mkdirSync(wrapperSessionsRoot, {mode: 0o700});
  const wrapperRaw = escapedJson({parsed: transport});
  const wrapperFixture = writeNativeAcceptanceFixture({
    root: wrapperRoot, sessionsRoot: wrapperSessionsRoot, caseId: wrapperCaseId,
    id: `extract-c-${wrapperCaseId}`, prompt: 'Return the supplied synthetic C JSON.',
    raw: wrapperRaw, schema: V12_C_OUTPUT_SCHEMA,
    privateData: {stage: 'extract', method: 'C', case_id: wrapperCaseId, spans: [source]},
    payload: {target: [source]}, sessionId: '01a00000-0000-7000-8000-000000000327'
  });
  await assert.rejects(
    () => acceptCliStage(acceptanceContext(wrapperRoot, wrapperCaseId), {job: wrapperFixture.id, 'sessions-root': wrapperSessionsRoot}),
    /c_output_shape_invalid/
  );
  const wrapperInitial = JSON.parse(fs.readFileSync(path.join(wrapperRoot, `initial-${wrapperFixture.id}.json`), 'utf8'));
  assert.deepEqual(wrapperInitial.parsed, JSON.parse(wrapperRaw));
  assert.equal(fs.existsSync(path.join(wrapperRoot, `accepted-${wrapperFixture.id}.json`)), false);
});

test('main C and quality acceptance hydrate exact quotes while invalid or duplicate IDs are held', async () => {
  const source = span('citation', 'source <oai-mem-citation><citation_entries>synthetic</citation_entries></oai-mem-citation>');
  const cOutput = {items: [cItem('i1', source, {content: 'Synthetic summary.'})]};
  const cTransport = cTransportOutput(cOutput, [source]);
  const qualityOutput = {
    status: 'passed',
    checked_kinds: [...V12_QUALITY_KINDS],
    checked_set: [{id: source.id}],
    item_checks: [{item_id: 'i1', checked_fields: [...V12_FIELD_NAMES], support_ids: [source.id]}],
    findings: [],
    positive_evidence: V12_QUALITY_KINDS.map(kind => ({kind, result: 'passed', reason: `reviewed ${kind}`, support_ids: [source.id]}))
  };
  const qualityTransport = qualityTransportOutput(qualityOutput, [source], cOutput.items);
  const makeFixtureRoot = prefix => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    fs.chmodSync(root, 0o700);
    const sessionsRoot = path.join(root, 'sessions');
    fs.mkdirSync(sessionsRoot, {mode: 0o700});
    return {root, sessionsRoot};
  };
  const prompt = 'Return the supplied synthetic JSON.';

  const qualityCaseId = 'ids-only-quality-case';
  const qualityRoot = makeFixtureRoot('memory-utility-v12-ids-only-quality-');
  const qualityFixture = writeNativeAcceptanceFixture({
    root: qualityRoot.root, sessionsRoot: qualityRoot.sessionsRoot, caseId: qualityCaseId,
    id: `quality-${qualityCaseId}`, prompt, raw: escapedJson(qualityTransport), schema: V12_QUALITY_SCHEMA,
    privateData: {stage: 'quality', quality_phase: 'downstream', case_id: qualityCaseId, spans: [source], extracted_items: cOutput.items},
    payload: {source_spans: [source], extracted: cOutput}, sessionId: '01a00000-0000-7000-8000-000000000324'
  });
  const qualityAccepted = await acceptCliStage(acceptanceContext(qualityRoot.root, qualityCaseId), {job: qualityFixture.id, 'sessions-root': qualityRoot.sessionsRoot});
  assert.equal(qualityAccepted.status, 'accepted');
  const qualityInitial = JSON.parse(fs.readFileSync(path.join(qualityRoot.root, `initial-${qualityFixture.id}.json`), 'utf8'));
  const qualityCanonical = JSON.parse(fs.readFileSync(path.join(qualityRoot.root, `accepted-${qualityFixture.id}.json`), 'utf8')).output;
  assert.equal(qualityInitial.raw.includes('<oai-mem-citation>'), false);
  assert.deepEqual(JSON.parse(qualityInitial.raw), qualityInitial.parsed);
  assert.equal(qualityCanonical.checked_set[0].quote, source.text);
  assert.deepEqual(reloadOutputForJob(qualityRoot.root, qualityFixture.id), qualityCanonical);

  const makeHeld = async (label, checkedSet, sessionId) => {
    const caseId = `held-${label}-case`;
    const heldRoot = makeFixtureRoot(`memory-utility-v12-held-${label}-`);
    const transport = {...qualityTransport, checked_set: checkedSet};
    const fixture = writeNativeAcceptanceFixture({
      root: heldRoot.root, sessionsRoot: heldRoot.sessionsRoot, caseId, id: `quality-${caseId}`, prompt,
      raw: escapedJson(transport), schema: V12_QUALITY_SCHEMA,
      privateData: {stage: 'quality', quality_phase: 'downstream', case_id: caseId, spans: [source], extracted_items: cOutput.items},
      payload: {source_spans: [source], extracted: cOutput}, sessionId
    });
    await assert.rejects(
      () => acceptCliStage(acceptanceContext(heldRoot.root, caseId), {job: fixture.id, 'sessions-root': heldRoot.sessionsRoot}),
      /quality_checked_set_transport_(?:unknown_id|duplicate)/
    );
    const initial = JSON.parse(fs.readFileSync(path.join(heldRoot.root, `initial-${fixture.id}.json`), 'utf8'));
    assert.equal(fs.existsSync(path.join(heldRoot.root, `accepted-${fixture.id}.json`)), false);
    assert.equal(initial.raw, escapedJson(transport));
    assert.deepEqual(initial.parsed, transport);
  };

  await makeHeld('unknown', [{id: 'span-2'}], '01a00000-0000-7000-8000-000000000325');
  await makeHeld('duplicate', [{id: 'span-1'}, {id: 'span-1'}], '01a00000-0000-7000-8000-000000000326');
});
