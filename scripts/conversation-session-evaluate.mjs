#!/usr/bin/env node
/** Explicit private-session evaluation. No transcript discovery, provider, or action execution. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LocalMemoryStore } from '../packages/orgbrain-cli/src/lib/local-memory-store.mjs';
import { handleLocalMcpRequest } from '../packages/orgbrain-cli/src/local-mcp.mjs';
import { redactJudgmentValue } from '../packages/shared/src/memory-judgment-runtime.mjs';

export const SESSION_LIMITS = Object.freeze({ input_bytes: 131072, output_bytes: 262144, query_chars: 4000, source_ids: 32 });
const SCHEMA = 'conversation-session-evaluation/v1';
const TYPES = new Set(['implementation', 'review', 'debug', 'proposal', 'support', 'research', 'operations', 'other']);
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
const canonical = value => JSON.stringify(sort(value));
function sort(value) {
  return Array.isArray(value) ? value.map(sort) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;
}
function object(value, name, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid_${name}`);
  if (allowed && Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`unknown_${name}_field`);
  return value;
}
function string(value, name, max = 128) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw new Error(`invalid_${name}`);
  return value;
}
// Identity syntax is context-specific. Never exempt UUID-looking strings in prose or refs.
const OPAQUE_ID = /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|memory-confirmation:[a-f0-9]{40})$/iu;
const SHA256 = /^(?:sha256:)?[a-f0-9]{64}$/u;
const CONTEXT_ID_PATH = /^(?:meta\.(?:usage_id|usage_item_ids\.\d+|usage_items\.\d+\.(?:usage_item_id|source_id))|results\.\d+\.memory\.(?:id|project_id)|evidence_bundle\.evidence\.\d+\.(?:memory_id|(?:source_reference|additional_sources\.\d+)\.(?:span_id|parent_span_id))|attempt_usage_ids\.\d+|prior_attempts\.\d+\.(?:id|tenant_id|project_id|supersedes_id))$/u;
const CONTEXT_HASH_PATH = /^(?:evidence_bundle\.evidence\.\d+\.(?:source_reference|additional_sources\.\d+)\.content_hash|prior_attempts\.\d+\.(?:conditions_hash|evidence\.\d+\.content_hash))$/u;
function identifier(value, name) {
  string(value, name);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(value) || (!OPAQUE_ID.test(value) && redact(value) !== value)) throw new Error(`invalid_${name}`);
  return value;
}
function redact(value, schema = null, path = []) {
  if (Array.isArray(value)) return value.map((item, index) => redact(item, schema, [...path, index]));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /^(?:api[_-]?key|password|secret|authorization|access[_-]?token|client[_-]?secret)$/iu.test(key)
      ? '[REDACTED]' : redact(item, schema, [...path, key])]));
  const field = path.join('.');
  if (typeof value === 'string' && (
    (schema === 'context' && CONTEXT_ID_PATH.test(field) && OPAQUE_ID.test(value))
    || (schema === 'source_refs' && /^\d+\.(?:span_id|parent_span_id)$/u.test(field) && OPAQUE_ID.test(value))
    || (SHA256.test(value) && ((schema === 'context' && CONTEXT_HASH_PATH.test(field))
      || (schema === 'source_refs' && /^\d+\.content_hash$/u.test(field)))))) return value;
  const redacted = redactJudgmentValue(value);
  return typeof redacted !== 'string' ? redacted : redacted
    .replace(/\b(?:secret|token|credential|phone|email|address|ssn)\s*[:=]\s*["']?[^\n,"']+/giu, '[REDACTED_PERSONAL_OR_SECRET]')
    .replace(/\b\d{3}-\d{2}-\d{4}\b/gu, '[REDACTED_SSN]')
    .replace(/\b(?:\d[ -]?){13,19}\b/gu, '[REDACTED_NUMBER]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, '$1[REDACTED]@');
}
function scope(input) {
  object(input, 'scope', ['tenant_id', 'project_id', 'task_id', 'principal_id']);
  return Object.fromEntries(['tenant_id', 'project_id', 'task_id', 'principal_id'].map(key => [key, identifier(input[key], key)]));
}
function evidenceRef(input) {
  object(input, 'source_ref', ['ref', 'content_sha256']);
  string(input.ref, 'source_ref', 500);
  if (!/^[a-f0-9]{64}$/u.test(input.content_sha256)) throw new Error('invalid_source_hash');
  return { ref: redact(input.ref), ref_sha256: hash(input.ref), content_sha256: input.content_sha256,
    hash_basis: 'caller_supplied_content_hash', verification_state: 'reported' };
}
function refs(input = []) {
  if (!Array.isArray(input) || input.length > 8) throw new Error('invalid_source_refs');
  return input.map(evidenceRef);
}
function baseInput(input) {
  if (input.schema_version !== 1) throw new Error('invalid_schema_version');
  if (!['actual', 'synthetic'].includes(input.session_kind)) throw new Error('invalid_session_kind');
  return { session_kind: input.session_kind, scope: scope(input.scope) };
}
function captureReport(input) {
  if (input == null) return { count: null, basis: 'not_observed', candidate_ids: [], source_refs: [] };
  object(input, 'capture_report', ['candidate_ids', 'source_refs']);
  if (!Array.isArray(input.candidate_ids) || input.candidate_ids.length > SESSION_LIMITS.source_ids) throw new Error('invalid_capture_candidates');
  const ids = input.candidate_ids.map(id => identifier(id, 'candidate_id'));
  if (new Set(ids).size !== ids.length) throw new Error('duplicate_capture_candidate');
  const sourceRefs = refs(input.source_refs);
  if (ids.length && !sourceRefs.length) throw new Error('capture_source_refs_required');
  return { count: ids.length, basis: 'caller_reported', candidate_ids: ids, source_refs: sourceRefs };
}
function retrievalInput(input) {
  object(input, 'retrieval', ['schema_version', 'session_kind', 'scope', 'query', 'work_type', 'source_memory_ids', 'capture_report', 'source_refs']);
  const base = baseInput(input);
  string(input.query, 'query', SESSION_LIMITS.query_chars);
  if (!TYPES.has(input.work_type)) throw new Error('invalid_work_type');
  if (!Array.isArray(input.source_memory_ids) || !input.source_memory_ids.length || input.source_memory_ids.length > SESSION_LIMITS.source_ids) throw new Error('source_memory_ids_required');
  const ids = input.source_memory_ids.map(id => identifier(id, 'source_memory_id'));
  if (new Set(ids).size !== ids.length) throw new Error('duplicate_source_memory_id');
  return { ...base, query: input.query, work_type: input.work_type, source_memory_ids: ids,
    capture: captureReport(input.capture_report), source_refs: refs(input.source_refs) };
}
function reportedEvidence(input, role) {
  object(input, role, ['ref', 'summary']);
  string(input.ref, `${role}_ref`, 500); string(input.summary, `${role}_summary`, 2000);
  return { role, ref: redact(input.ref), ref_sha256: hash(input.ref), summary: redact(input.summary),
    content_sha256: hash(input.summary), verification_state: 'reported' };
}
function usageInput(input) {
  object(input, 'usage', ['schema_version', 'session_kind', 'scope', 'receipt_sha256', 'items']);
  const base = baseInput(input);
  if (!/^[a-f0-9]{64}$/u.test(input.receipt_sha256)) throw new Error('invalid_receipt_hash');
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > SESSION_LIMITS.source_ids) throw new Error('invalid_usage_items');
  const items = input.items.map(item => {
    object(item, 'usage_item', ['usage_item_id', 'source_id', 'source_version', 'adopted', 'action', 'result']);
    const output = { usage_item_id: identifier(item.usage_item_id, 'usage_item_id'), source_id: identifier(item.source_id, 'source_id'), source_version: item.source_version };
    if (!Number.isSafeInteger(item.source_version) || item.source_version < 1) throw new Error('invalid_source_version');
    if (![true, false, null].includes(item.adopted)) throw new Error('invalid_adopted');
    const evidence = [];
    if (item.adopted === true && (!item.action || !item.result)) throw new Error('reported_action_and_result_required');
    if (item.action) evidence.push(reportedEvidence(item.action, 'action'));
    if (item.result) evidence.push(reportedEvidence(item.result, 'result'));
    return { ...output, adopted: item.adopted, evidence, verification_state: 'reported' };
  });
  if (new Set(items.map(item => item.usage_item_id)).size !== items.length) throw new Error('duplicate_usage_item');
  return { ...base, receipt_sha256: input.receipt_sha256, items };
}
async function readJson(file, max = SESSION_LIMITS.input_bytes) {
  const handle = await open(resolve(string(file, 'input_path', 4096)), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > max) throw new Error('input_file_not_regular_or_too_large');
    const buffer = Buffer.alloc(max + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const result = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
    }
    if (bytes > max) throw new Error('input_file_too_large');
    try { return JSON.parse(buffer.subarray(0, bytes).toString('utf8')); }
    catch { throw new Error('invalid_input_json'); }
  } finally { await handle.close(); }
}
function seal(report) { return { ...report, receipt_sha256: hash(report) }; }
function checkSeal(report) {
  const { receipt_sha256, ...body } = report;
  if (!/^[a-f0-9]{64}$/u.test(receipt_sha256) || hash(body) !== receipt_sha256) throw new Error('receipt_hash_mismatch');
}
const RECEIPT_SQL = `CREATE TABLE IF NOT EXISTS conversation_session_receipts (
 id TEXT PRIMARY KEY, phase TEXT NOT NULL, report_sha256 TEXT NOT NULL UNIQUE,
 tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, task_id TEXT NOT NULL, principal_id TEXT NOT NULL,
 usage_id TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS conversation_session_receipts_no_update BEFORE UPDATE ON conversation_session_receipts
 BEGIN SELECT RAISE(ABORT, 'conversation_session_receipt_immutable'); END;
CREATE TRIGGER IF NOT EXISTS conversation_session_receipts_no_delete BEFORE DELETE ON conversation_session_receipts
 BEGIN SELECT RAISE(ABORT, 'conversation_session_receipt_immutable'); END;`;
function receiptRow(db, report) {
  const s = report.scope;
  return db.prepare('SELECT * FROM conversation_session_receipts WHERE report_sha256=? AND tenant_id=? AND project_id=? AND task_id=? AND principal_id=?')
    .get(report.receipt_sha256, s.tenant_id, s.project_id, s.task_id, s.principal_id);
}
function recordArtifact(store, report, delivered = []) {
  const db = store.open();
  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT INTO conversation_session_receipts VALUES(?,?,?,?,?,?,?,?,?)').run(report.id, report.phase, report.receipt_sha256,
      report.scope.tenant_id, report.scope.project_id, report.scope.task_id, report.scope.principal_id, report.usage_id, report.created_at);
    for (const item of delivered) db.prepare('INSERT OR IGNORE INTO local_use_deliveries VALUES(?,?,?,?,?,?)').run(
      report.scope.tenant_id, item.usage_item_id, report.scope.principal_id, report.scope.task_id, report.scope.project_id, report.created_at);
    db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  finally { db.close(); }
}
const unknownEffect = () => ({ state: 'unknown', verified: false, causal_benefit: null, avoided_calls: null,
  actual_task_time_saved_ms: null, provider_tokens_saved: null, user_bill_savings: null });
function accessible(memory, s) {
  return memory && memory.project_id === s.project_id && !memory.deleted_at
    && (!memory.permissions?.length || memory.permissions.some(grant => grant.principal_type === 'principal'
      && grant.principal_id === s.principal_id && grant.permissions?.includes('read')));
}
async function retrieve(store, input) {
  const s = input.scope;
  const saved = await Promise.all(input.source_memory_ids.map(async id => {
    const memory = await store.get(s.tenant_id, id);
    return accessible(memory, s) ? { source_id: id, stored: true, source_version: memory.current_version,
      content_sha256: hash(memory.content), source_refs: redact(memory.source_references ?? [], 'source_refs') }
      : { source_id: id, stored: false, source_version: null };
  }));
  const result = await handleLocalMcpRequest(store, { method: 'tools/call', params: {
    name: 'orgbrain_context_enrich', arguments: { ...s, query: input.query, work_type: input.work_type,
      usage_purpose: input.session_kind === 'synthetic' ? 'test' : 'task', context_format: 'compact',
      include_domain_recall: false, include_wiki: false }
  } });
  if (result.isError) throw new Error('context_enrich_failed');
  const rawContext = JSON.parse(result.content.filter(item => item.type === 'text').map(item => item.text).join('\n'));
  const items = rawContext.meta?.usage_items ?? [];
  const evidenceIds = new Set((rawContext.evidence_bundle?.evidence ?? []).map(item => item.memory_id));
  if (items.some(item => !evidenceIds.has(item.source_id))) throw new Error('retrieval_receipt_without_evidence');
  const context = redact(rawContext, 'context');
  const retrievedIds = items.map(item => item.source_id);
  return seal({ schema: SCHEMA, id: randomUUID(), phase: 'retrieve', created_at: Date.now(),
    session_kind: input.session_kind, scope: s, usage_id: rawContext.meta.usage_id,
    query: { text: redact(input.query), sha256: hash(input.query), executed_exactly_as_supplied: true },
    retrieval_policy: { tool: 'orgbrain_context_enrich', threshold: 'normal_tool_default', top_k: 'normal_tool_default',
      token_budget: 'normal_tool_default', provider_calls: 0, query_expansion: false },
    source_refs: input.source_refs, context,
    evidence: { raw_mcp_result_sha256: hash(rawContext), emitted_context_sha256: hash(context), redacted: canonical(context) !== canonical(rawContext) },
    stages: {
      capture: input.capture,
      saved: { count: saved.filter(item => item.stored).length, basis: 'tool_observed_store_presence', items: saved,
        note: 'Presence is not proof of capture in this session or human confirmation.' },
      retrieved: { count: items.length, basis: 'tool_observed_context_result', items,
        requested_sources_returned: input.source_memory_ids.filter(id => retrievedIds.includes(id)),
        requested_sources_not_returned: input.source_memory_ids.filter(id => !retrievedIds.includes(id)) },
      delivered: { count: items.length, basis: 'tool_observed_output_artifact', items,
        destination: 'explicit_private_output_file', parent_consumption: 'unknown' },
      adopted: { count: null, basis: 'not_observed' },
      execution: { state: 'not_observed' }, effect: unknownEffect()
    },
    limitations: ['Artifact export does not establish parent consumption or adoption.',
      'Hashes detect altered evidence; caller references do not authenticate their source.',
      'Pattern redaction is not a guarantee that arbitrary free text contains no personal data.',
      ...(input.session_kind === 'synthetic' ? ['Synthetic fixture only; no actual-session savings claim.'] : [])]
  });
}
async function recordUse(store, input, receipt) {
  checkSeal(receipt);
  if (receipt.schema !== SCHEMA || receipt.phase !== 'retrieve' || receipt.session_kind !== input.session_kind
    || canonical(receipt.scope) !== canonical(input.scope) || receipt.receipt_sha256 !== input.receipt_sha256) throw new Error('receipt_scope_mismatch');
  const s = input.scope, db = store.open();
  try {
    const anchor = receiptRow(db, receipt);
    if (!anchor || anchor.phase !== 'retrieve' || anchor.usage_id !== receipt.usage_id) throw new Error('receipt_not_issued');
    for (const item of input.items) {
      if (!receipt.stages.delivered.items.some(delivered => ['usage_item_id', 'source_id', 'source_version'].every(key => delivered[key] === item[key]))) throw new Error('source_not_delivered');
      const row = db.prepare(`SELECT i.source_id,i.source_version FROM memory_usage_items i
        JOIN memory_usage_events e ON e.tenant_id=i.tenant_id AND e.id=i.usage_event_id
        JOIN local_use_deliveries d ON d.tenant_id=i.tenant_id AND d.usage_item_id=i.id
        WHERE e.tenant_id=? AND e.project_id=? AND e.task_id=? AND e.actor_principal=? AND e.id=? AND i.id=?
        AND d.project_id=e.project_id AND d.task_id=e.task_id AND d.principal=e.actor_principal`)
        .get(s.tenant_id, s.project_id, s.task_id, s.principal_id, receipt.usage_id, item.usage_item_id);
      if (!row || row.source_id !== item.source_id || row.source_version !== item.source_version) throw new Error('delivery_scope_mismatch');
    }
  } finally { db.close(); }
  const report = seal({ schema: SCHEMA, id: randomUUID(), phase: 'record-use', created_at: Date.now(), session_kind: input.session_kind,
    scope: s, usage_id: receipt.usage_id, retrieval_receipt_sha256: receipt.receipt_sha256,
    stages: { capture: receipt.stages.capture, saved: receipt.stages.saved, retrieved: receipt.stages.retrieved,
      delivered: receipt.stages.delivered, adopted: { count: input.items.filter(item => item.adopted === true).length,
        not_adopted_count: input.items.filter(item => item.adopted === false).length,
        unassessed_count: receipt.stages.delivered.count - input.items.filter(item => item.adopted !== null).length,
        basis: 'caller_reported', items: input.items },
      execution: { state: 'reported_only', tool_observed_actions: null, verified_outcomes: null }, effect: unknownEffect() },
    state_update: { usage_event_id: receipt.usage_id, updated_count: input.items.length, used_state_source: 'reported' },
    limitations: ['Supplied action and result are reports, not trusted tool observations or verified effects.',
      'No contribution rating, proof, verified-use record, savings estimate, or ranking adjustment was created.',
      ...(input.session_kind === 'synthetic' ? ['Synthetic fixture only; no actual-session savings claim.'] : [])]
  });
  if (Buffer.byteLength(`${JSON.stringify(report, null, 2)}\n`) > SESSION_LIMITS.output_bytes) throw new Error('report_too_large');
  await store.updateUsageStates(s.tenant_id, { usage_event_id: receipt.usage_id,
    items: input.items.map(item => ({ usage_item_id: item.usage_item_id, used_state: item.adopted === null ? 'unknown' : item.adopted ? 'used' : 'not_used' })) });
  return report;
}
let running = false;
/** Standalone-process API. Explicit paths only; environment overrides are restored after completion. */
export async function evaluateConversationSession(options) {
  if (running) throw new Error('session_harness_already_running');
  running = true;
  try { return await evaluateIsolated(options); } finally { running = false; }
}
async function evaluateIsolated({ phase, dbPath, inputPath, outputPath, receiptPath }) {
  if (!['retrieve', 'record-use'].includes(phase)) throw new Error('invalid_phase');
  if (phase === 'record-use' && !receiptPath) throw new Error('receipt_path_required');
  string(dbPath, 'db_path', 4096); string(outputPath, 'output_path', 4096);
  const info = await lstat(resolve(dbPath));
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('existing_regular_database_required');
  const input = phase === 'retrieve' ? retrievalInput(await readJson(inputPath)) : usageInput(await readJson(inputPath));
  const receipt = phase === 'record-use' ? await readJson(receiptPath, SESSION_LIMITS.output_bytes) : null;
  // Refuse replacement before performing any retrieval/state update.
  const output = await open(resolve(outputPath), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let isolated;
  let previous = {};
  const previousFetch = globalThis.fetch;
  try {
    isolated = await mkdtemp(join(tmpdir(), 'orgbrain-session-env-'));
    const overrides = { ORGBRAIN_WORKSPACES_FILE: join(isolated, 'workspaces.json'), ORGBRAIN_FEATURES_FILE: join(isolated, 'features.json'),
      ORGBRAIN_ENABLE_CLOUD_MEMORY: 'false', ORGBRAIN_ENABLE_ORG_SHARING: 'false', ORGBRAIN_USE_SYNC: 'off', ORGBRAIN_USE_PRINCIPAL: input.scope.principal_id };
    previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
    await writeFile(overrides.ORGBRAIN_WORKSPACES_FILE, '{"version":3,"workspaces":{}}', { mode: 0o600 });
    await writeFile(overrides.ORGBRAIN_FEATURES_FILE, '{"features":{"llm_wiki":{"enabled":false,"epoch":0}}}', { mode: 0o600 });
    Object.assign(process.env, overrides);
    globalThis.fetch = async () => { throw new Error('session_harness_network_disabled'); };
    const off = async () => ({ mode: 'off', status: 'skipped', applied: false, reason_code: 'disabled', decisions: [] });
    const store = new LocalMemoryStore(dbPath, { env: {}, denseEmbeddingProvider: null, memoryJudge: off, contextSearchJudge: off });
    await store.init();
    const db = store.open(); try { db.exec(RECEIPT_SQL); } finally { db.close(); }
    const report = phase === 'retrieve' ? await retrieve(store, input) : await recordUse(store, input, receipt);
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > SESSION_LIMITS.output_bytes) throw new Error('report_too_large');
    await output.writeFile(serialized); await output.sync(); await output.close();
    // Export has completed. An unanchored file from any failure cannot authorize adoption.
    recordArtifact(store, report, phase === 'retrieve' ? report.stages.delivered.items : []);
    return { schema: SCHEMA, phase, receipt_sha256: report.receipt_sha256, usage_id: report.usage_id,
      session_kind: report.session_kind, output_written: true, effect: 'unknown' };
  } finally {
    await output.close().catch(() => {});
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    if (isolated) await rm(isolated, { recursive: true, force: true });
  }
}
function parseArgs(args) {
  const [phase, ...rest] = args;
  const flags = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index], value = rest[index + 1];
    if (!['--db', '--input', '--output', '--receipt'].includes(key) || !value || value.startsWith('--') || flags[key]) throw new Error('invalid_arguments');
    flags[key] = value;
  }
  return { phase, dbPath: flags['--db'], inputPath: flags['--input'], outputPath: flags['--output'], receiptPath: flags['--receipt'] };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await evaluateConversationSession(parseArgs(process.argv.slice(2))))); }
  catch (error) {
    // Never include a filesystem path, query, result, or caller evidence in stderr.
    console.error(JSON.stringify({ error: /^[a-z_]+$/u.test(error.message) ? error.message : 'session_evaluation_failed',
      detail: error.code === 'EEXIST' ? 'output_already_exists' : undefined }));
    process.exitCode = 1;
  }
}
