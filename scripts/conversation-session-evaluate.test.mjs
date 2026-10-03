import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto, { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LocalMemoryStore } from '../packages/orgbrain-cli/src/lib/local-memory-store.mjs';
import { evaluateConversationSession, SESSION_LIMITS } from './conversation-session-evaluate.mjs';

const exec = promisify(execFile);
const SCOPE = { tenant_id: 'fixture-tenant', project_id: 'ExampleApp-fixture', task_id: 'synthetic-call-preflight', principal_id: 'fixture-reader' };
const sha = value => createHash('sha256').update(value).digest('hex');
const SECRET = 'sk-fixtureSensitiveString123456789';
async function fixture(fn, seedOverrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'orgbrain-session-test-'));
  const dbPath = join(dir, 'memory.sqlite');
  const off = async () => ({ mode: 'off', applied: false, decisions: [] });
  const store = new LocalMemoryStore(dbPath, { env: {}, denseEmbeddingProvider: null, memoryJudge: off, contextSearchJudge: off });
  try {
    await store.init();
    const seed = async overrides => (await store.capture({ tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id,
      work_type: 'implementation', kind: 'fact', source: 'synthetic-fixture',
      content: 'ExampleApp testcontact identifier is fixture-contact-17. Use the staging configuration before the next call.',
      summary: 'ExampleApp testcontact identifier and staging configuration', confidence_score: 0.95,
      source_references: [{ type: 'conversation', ref: 'synthetic:source-turn-1' }], ...overrides })).memory_id;
    const id = await seed(seedOverrides);
    const input = { schema_version: 1, session_kind: 'synthetic', scope: SCOPE,
      query: 'ExampleApp testcontact identifier staging configuration', work_type: 'implementation', source_memory_ids: [id],
      capture_report: { candidate_ids: ['synthetic-candidate-1'], source_refs: [{ ref: 'synthetic:capture-report', content_sha256: sha('synthetic captured candidate') }] } };
    let sequence = 0;
    const run = async (phase, data, receiptPath) => {
      const prefix = join(dir, `run-${++sequence}`), inputPath = `${prefix}-input.json`, outputPath = `${prefix}-output.json`;
      await writeFile(inputPath, JSON.stringify(data), { mode: 0o600 });
      const result = await evaluateConversationSession({ phase, dbPath, inputPath, outputPath, receiptPath });
      return { result, report: JSON.parse(await readFile(outputPath, 'utf8')), outputPath, inputPath };
    };
    const count = table => { const db = store.open(); try { return db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n; } finally { db.close(); } };
    await fn({ dir, dbPath, store, seed, id, input, run, count });
  } finally { await rm(dir, { recursive: true, force: true }); }
}
function usage(receipt, overrides = {}) {
  const item = receipt.stages.delivered.items[0];
  return { schema_version: 1, session_kind: 'synthetic', scope: SCOPE, receipt_sha256: receipt.receipt_sha256,
    items: [{ ...item, adopted: true,
      action: { ref: 'synthetic:action-1', summary: 'Selected the supplied fixture contact identifier for a simulated preflight.' },
      result: { ref: 'synthetic:result-1', summary: 'Synthetic fixture only; no call was placed.' }, ...overrides }].map(({ source_type, ...item }) => item) };
}

test('synthetic two-phase evaluation separates capture, presence, retrieval, artifact delivery and reported adoption', async () => {
  await fixture(async f => {
    const fetched = await f.run('retrieve', f.input);
    const r = fetched.report;
    assert.equal(r.session_kind, 'synthetic');
    assert.equal(r.stages.capture.count, 1);
    assert.equal(r.stages.capture.basis, 'caller_reported');
    assert.equal(r.stages.saved.count, 1);
    assert.equal(r.stages.saved.basis, 'tool_observed_store_presence');
    assert.equal(r.stages.retrieved.count, 1);
    assert.equal(r.stages.delivered.count, 1);
    assert.equal(r.stages.delivered.parent_consumption, 'unknown');
    assert.equal(r.stages.adopted.count, null);
    assert.equal(r.stages.effect.user_bill_savings, null);
    assert.equal(r.query.sha256, sha(f.input.query));
    assert.equal(r.context.meta.usage_id, r.usage_id);
    assert.equal(r.context.evidence_bundle.token_budget, 1500);
    assert.equal(r.retrieval_policy.threshold, 'normal_tool_default');
    assert.equal(f.count('local_use_deliveries'), 1);
    assert.equal(f.count('conversation_session_receipts'), 1);
    assert.equal((await stat(fetched.outputPath)).mode & 0o777, 0o600);
    assert.match(r.limitations.join(' '), /Synthetic fixture/);
    const adopted = await f.run('record-use', usage(r), fetched.outputPath);
    assert.equal(adopted.report.stages.adopted.count, 1);
    assert.equal(adopted.report.stages.adopted.basis, 'caller_reported');
    assert.equal(adopted.report.stages.execution.tool_observed_actions, null);
    assert.equal(adopted.report.stages.execution.verified_outcomes, null);
    assert.equal(adopted.report.stages.effect.verified, false);
    assert.equal(adopted.report.stages.effect.provider_tokens_saved, null);
    assert.equal(adopted.report.state_update.used_state_source, 'reported');
    const db = f.store.open();
    try {
      const item = db.prepare('SELECT used_state,used_state_source FROM memory_usage_items WHERE usage_event_id=?').get(r.usage_id);
      assert.deepEqual({ ...item }, { used_state: 'used', used_state_source: 'reported' });
      assert.throws(() => db.prepare('UPDATE conversation_session_receipts SET phase=?').run('forged'), /immutable/);
      assert.throws(() => db.exec('DELETE FROM conversation_session_receipts'), /immutable/);
    } finally { db.close(); }
    for (const table of ['local_use_proofs', 'memory_use_contexts', 'memory_use_evaluations', 'memory_use_statistics']) assert.equal(f.count(table), 0, table);
    assert.equal(f.count('memories'), 1, 'harness never captures a memory');
  });
});

test('exact irrelevant query abstains without ID hints, rewritten query or lowered threshold', async () => {
  await fixture(async f => {
    const query = 'galactic bakery payroll';
    const { report } = await f.run('retrieve', { ...f.input, query, capture_report: undefined });
    assert.equal(report.query.text, query);
    assert.equal(report.query.sha256, sha(query));
    assert.equal(report.stages.saved.count, 1);
    assert.equal(report.stages.capture.count, null);
    assert.equal(report.stages.retrieved.count, 0);
    assert.equal(report.stages.delivered.count, 0);
    assert.deepEqual(report.stages.retrieved.requested_sources_not_returned, [f.id]);
    assert.equal(report.context.evidence_bundle.abstention_recommended, true);
    await assert.rejects(f.run('retrieve', { ...f.input, minimum_total_score: 0 }), /unknown_retrieval_field/);
  });
});

test('mandatory tenant, project, task and principal scope; no cross-scope saved or retrieval claims', async () => {
  await fixture(async f => {
    for (const key of Object.keys(SCOPE)) {
      const s = { ...SCOPE }; delete s[key];
      await assert.rejects(f.run('retrieve', { ...f.input, scope: s }), new RegExp(`invalid_${key}`));
    }
    for (const override of [{ tenant_id: 'other-tenant' }, { project_id: 'other-project' }]) {
      const { report } = await f.run('retrieve', { ...f.input, scope: { ...SCOPE, ...override } });
      assert.equal(report.stages.saved.count, 0);
      assert.equal(report.stages.retrieved.count, 0);
    }
    const restricted = await f.seed({ content: 'ExampleApp testcontact secret alternate identifier fixture-contact-29.',
      permissions: [{ principal_type: 'principal', principal_id: 'someone-else', permissions: ['read'] }] });
    const { report } = await f.run('retrieve', { ...f.input, source_memory_ids: [restricted] });
    assert.equal(report.stages.saved.count, 0);
    assert.ok(!JSON.stringify(report).includes('fixture-contact-29'));
  });
});

test('adoption rejects undelivered IDs, wrong scope/version, missing evidence and unissued or changed receipt', async () => {
  await fixture(async f => {
    const retrieved = await f.run('retrieve', f.input), r = retrieved.report;
    for (const change of [{ source_id: 'never-delivered' }, { usage_item_id: 'never-delivered' }, { source_version: 99 }]) {
      await assert.rejects(f.run('record-use', usage(r, change), retrieved.outputPath), /source_not_delivered/);
    }
    const absent = usage(r); delete absent.items[0].result;
    await assert.rejects(f.run('record-use', absent, retrieved.outputPath), /reported_action_and_result_required/);
    await assert.rejects(f.run('record-use', { ...usage(r), scope: { ...SCOPE, task_id: 'different-task' } }, retrieved.outputPath), /scope_mismatch/);
    const changed = JSON.parse(JSON.stringify(r)); changed.query.text = 'forged';
    const file = join(f.dir, 'changed.json'); await writeFile(file, JSON.stringify(changed));
    await assert.rejects(f.run('record-use', usage(r), file), /receipt_hash_mismatch/);
    const canonical = v => JSON.stringify((function sort(x) { return Array.isArray(x) ? x.map(sort) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, sort(x[k])])) : x; })(v));
    delete changed.receipt_sha256; changed.receipt_sha256 = sha(canonical(changed));
    await writeFile(file, JSON.stringify(changed));
    await assert.rejects(f.run('record-use', usage(changed), file), /receipt_not_issued/);
    const db = f.store.open(); try { assert.equal(db.prepare('SELECT used_state FROM memory_usage_items').get().used_state, 'unknown'); } finally { db.close(); }
    assert.equal(f.count('memory_use_statistics'), 0);
  });
});

test('forged verification flags cannot become proofs or positive effects; negative and unknown reports stay distinct', async () => {
  await fixture(async f => {
    const fetched = await f.run('retrieve', f.input);
    const forged = usage(fetched.report); forged.items[0].result.verified = true;
    await assert.rejects(f.run('record-use', forged, fetched.outputPath), /unknown_result_field/);
    const forgedItem = usage(fetched.report, { verification_state: 'verified' });
    await assert.rejects(f.run('record-use', forgedItem, fetched.outputPath), /unknown_usage_item_field/);
    for (const adopted of [false, null]) {
      const input = usage(fetched.report, { adopted }); delete input.items[0].action; delete input.items[0].result;
      const { report } = await f.run('record-use', input, fetched.outputPath);
      assert.equal(report.stages.adopted.count, 0);
      assert.equal(report.stages.adopted.not_adopted_count, adopted === false ? 1 : 0);
      assert.equal(report.stages.adopted.unassessed_count, adopted === null ? 1 : 0);
      assert.equal(report.stages.effect.state, 'unknown');
    }
    assert.equal(f.count('local_use_proofs'), 0);
  });
});

test('redacts credentials and ordinary PII from query, memory, evidence, source refs and reports', async () => {
  await fixture(async f => {
    const unsafe = `ExampleApp testcontact staging configuration. Bearer ${SECRET} reader@example.test +1-212-555-0199`;
    const db = f.store.open();
    try { db.prepare('UPDATE memories SET content=?,source_refs_json=? WHERE id=?').run(unsafe,
      JSON.stringify([{ type: 'conversation', ref: `user:reader@example.test?password=${SECRET}` }]), f.id); }
    finally { db.close(); }
    const input = { ...f.input, query: `${f.input.query}\npassword=${SECRET}`,
      source_refs: [{ ref: `mail:reader@example.test`, content_sha256: sha(unsafe) }] };
    // Query is intentionally not sanitized before matching. Source hashes prove the exact supplied text.
    const fetched = await f.run('retrieve', input);
    const serialized = JSON.stringify(fetched.report);
    for (const secret of [SECRET, 'reader@example.test', '+1-212-555-0199']) assert.ok(!serialized.includes(secret), secret);
    assert.equal(fetched.report.query.sha256, sha(input.query));
    assert.equal(fetched.report.stages.saved.items[0].content_sha256, sha(unsafe));
    const normal = await f.run('retrieve', f.input);
    assert.equal(normal.report.stages.delivered.count, 1);
    const reported = usage(normal.report);
    reported.items[0].action.summary = unsafe;
    reported.items[0].result.ref = `mail:reader@example.test`;
    const { report } = await f.run('record-use', reported, normal.outputPath);
    assert.ok(!JSON.stringify(report).includes(SECRET));
    assert.ok(!JSON.stringify(report).includes('reader@example.test'));
    assert.equal(report.stages.adopted.items[0].evidence[0].content_sha256, sha(unsafe));
  });
});

test('explicit bounded files, no overwrites or symlink inputs, offline environment restored', async () => {
  await fixture(async f => {
    const inputPath = join(f.dir, 'bounded-input.json'), outputPath = join(f.dir, 'bounded-output.json');
    await writeFile(inputPath, 'x'.repeat(SESSION_LIMITS.input_bytes + 1));
    await assert.rejects(evaluateConversationSession({ phase: 'retrieve', dbPath: f.dbPath, inputPath, outputPath }), /too_large/);
    await writeFile(inputPath, JSON.stringify(f.input));
    const link = join(f.dir, 'linked-input.json'); await symlink(inputPath, link);
    await assert.rejects(evaluateConversationSession({ phase: 'retrieve', dbPath: f.dbPath, inputPath: link, outputPath }));
    const beforeFetch = globalThis.fetch, beforeEnv = process.env.ORGBRAIN_WORKSPACES_FILE;
    process.env.ORGBRAIN_WORKSPACES_FILE = '/must-not-read-global-config.json';
    try {
      const first = await evaluateConversationSession({ phase: 'retrieve', dbPath: f.dbPath, inputPath, outputPath });
      assert.equal(first.output_written, true);
      assert.equal(globalThis.fetch, beforeFetch);
      assert.equal(process.env.ORGBRAIN_WORKSPACES_FILE, '/must-not-read-global-config.json');
      const count = f.count('memory_usage_events');
      await assert.rejects(evaluateConversationSession({ phase: 'retrieve', dbPath: f.dbPath, inputPath, outputPath }), { code: 'EEXIST' });
      assert.equal(f.count('memory_usage_events'), count);
    } finally { if (beforeEnv === undefined) delete process.env.ORGBRAIN_WORKSPACES_FILE; else process.env.ORGBRAIN_WORKSPACES_FILE = beforeEnv; }
  });
});

test('standalone CLI runs a labeled synthetic fixture and returns only bounded completion metadata', async () => {
  await fixture(async f => {
    const inputPath = join(f.dir, 'cli-input.json'), outputPath = join(f.dir, 'cli-output.json');
    await writeFile(inputPath, JSON.stringify(f.input));
    const { stdout } = await exec(process.execPath, ['scripts/conversation-session-evaluate.mjs', 'retrieve', '--db', f.dbPath,
      '--input', inputPath, '--output', outputPath], { cwd: new URL('..', import.meta.url), maxBuffer: 16384 });
    const result = JSON.parse(stdout);
    assert.equal(result.session_kind, 'synthetic'); assert.equal(result.output_written, true); assert.equal(result.effect, 'unknown');
    assert.ok(!stdout.includes('fixture-contact-17'));
    assert.equal(JSON.parse(await readFile(outputPath, 'utf8')).stages.retrieved.count, 1);
  });
});


test('phone-like UUIDs retain exact identity through real retrieval and reported use without exempting sensitive prose', async () => {
  const memoryId = '12345678-1234-4123-8123-123456789012';
  const contentHash = 'sha256:' + '1'.repeat(64);
  await fixture(async f => {
    f.input.scope = { ...SCOPE, task_id: memoryId, principal_id: 'abcdef12-3456-4789-8abc-def123456789' };
    const db = f.store.open();
    try {
      db.prepare('UPDATE memories SET source_refs_json=? WHERE id=?').run(JSON.stringify([
        { type: 'conversation', ref: `private:${memoryId}:reader@example.test`, content_hash: contentHash,
          id: memoryId, password: memoryId, span_id: memoryId, parent_span_id: memoryId }
      ]), memoryId);
    } finally { db.close(); }
    const original = crypto.randomUUID;
    let counter = 123456789013n;
    crypto.randomUUID = () => `12345678-1234-4123-8123-${counter++}`;
    syncBuiltinESMExports();
    try {
      const fetched = await f.run('retrieve', f.input), r = fetched.report;
      const item = r.stages.delivered.items[0];
      assert.deepEqual(r.scope, f.input.scope);
      assert.equal(r.stages.saved.items[0].source_id, memoryId);
      assert.equal(r.context.results[0].memory.id, memoryId);
      assert.equal(r.context.evidence_bundle.evidence[0].memory_id, memoryId);
      assert.equal(r.context.meta.usage_id, r.usage_id);
      assert.equal(r.context.meta.usage_item_ids[0], item.usage_item_id);
      assert.equal(r.context.meta.usage_items[0].usage_item_id, item.usage_item_id);
      assert.equal(r.context.meta.usage_items[0].source_id, memoryId);
      assert.match(item.usage_item_id, /^12345678-1234-4123-8123-\d{12}$/u);
      for (const source of [r.stages.saved.items[0].source_refs[0], r.context.evidence_bundle.evidence[0].source_reference]) {
        assert.equal(source.content_hash, contentHash);
        assert.equal(source.span_id, memoryId); assert.equal(source.parent_span_id, memoryId);
        assert.ok(!source.ref.includes(memoryId));
        assert.ok(!source.ref.includes('reader@example.test'));
        assert.notEqual(source.id, memoryId, 'arbitrary IDs inside private refs are not identity exemptions');
        assert.equal(source.password, '[REDACTED]');
      }
      const reported = { ...usage(r), scope: f.input.scope };
      reported.items[0].action.summary = `Private body ${memoryId}; reader@example.test; ${SECRET}`;
      const adopted = (await f.run('record-use', reported, fetched.outputPath)).report;
      assert.equal(adopted.usage_id, r.usage_id);
      assert.equal(adopted.retrieval_receipt_sha256, r.receipt_sha256);
      assert.equal(adopted.stages.adopted.items[0].usage_item_id, item.usage_item_id);
      assert.equal(adopted.stages.adopted.items[0].source_id, memoryId);
      assert.equal(adopted.stages.adopted.count, 1);
      const body = adopted.stages.adopted.items[0].evidence[0].summary;
      for (const value of [memoryId, 'reader@example.test', SECRET]) assert.ok(!body.includes(value));
      const check = f.store.open();
      try {
        assert.equal(check.prepare('SELECT used_state FROM memory_usage_items WHERE id=?').get(item.usage_item_id).used_state, 'used');
      } finally { check.close(); }
      for (const invalid of ['0123-456-7890', '1234567890123456', SECRET]) {
        await assert.rejects(f.run('retrieve', { ...f.input, scope: { ...SCOPE, principal_id: invalid } }), /invalid_principal_id/);
      }
    } finally { crypto.randomUUID = original; syncBuiltinESMExports(); }
  }, { id: memoryId });
});
