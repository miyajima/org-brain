#!/usr/bin/env node
// Offline replay of the real local prompt hook. Synthetic stores only; no model calls.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing ${name}`);
  return args[index + 1];
}
const roots = { baseline: resolve(option('--baseline-root')), candidate: resolve(import.meta.dirname, '..') };
const destination = resolve(option('--output'));
const content = 'Voice API requests must use a 2500 millisecond timeout; keep the retry count at zero for a non-idempotent operation.';
const rationale = 'A disconnect does not establish whether the server completed the operation.';
const reuse = 'Apply this only to non-idempotent Voice API requests; idempotent status reads have a separate retry policy.';
const long = `Voice API migration policy. ${'This migration has a scoped compatibility check. '.repeat(8)}Only use it after the staging schema version is verified.`;
const base = { kind: 'decision', summary: 'Voice API timeout policy', content, rationale, reuse_rule: reuse };
const cases = [
  { id: 'decision_body_and_rationale', memory: base, required: [content, rationale, reuse] },
  { id: 'constraint_body_and_rationale', memory: { ...base, kind: 'constraint' }, required: [content, rationale, reuse] },
  { id: 'long_fact_limiting_clause', memory: { kind: 'fact', summary: long, content: long }, required: [long] },
  { id: 'legacy_failure_body', memory: { ...base, kind: 'pitfall' }, required: [content, rationale, reuse, '未検証または情報不足'] },
  { id: 'success_fields', memory: { ...base, kind: 'fact', learning: { schema_version: 2, lesson_type: 'success',
    procedure: 'Set Voice API timeout to 2500 milliseconds.', why_it_worked: rationale,
    observed_outcome: 'The synthetic timeout regression passed.', reuse_when: reuse, gaps: [] } },
    required: ['Set Voice API timeout to 2500 milliseconds.', rationale, reuse, '過去の報告'] },
  { id: 'oversized_body', memory: { ...base, content: 'Voice API timeout policy. '.repeat(1000) }, omitted: true },
  { id: 'oversized_rationale', memory: { ...base, rationale: '適用条件の検証が必要です。'.repeat(250) }, omitted: true },
  { id: 'other_project', memory: { ...base, project_id: 'other' }, omitted: true },
  { id: 'expired', memory: { ...base, expires_at: 1 }, omitted: true },
  { id: 'stale_source', memory: { ...base, verification_state: 'verified', capture_origin: 'observed', verified_at: 1, learning: { schema_version: 2, lesson_type: 'decision', gaps: [] },
    evidence: [{ type: 'file', ref: 'voice.md', content_hash: '0'.repeat(64) }] }, omitted: true },
  { id: 'unrelated', memory: base, query: 'galactic bakery payroll', omitted: true },
  { id: 'redaction', memory: { ...base, content: 'Voice API timeout: contact operator@example.com for historical settings.',
    rationale: 'The original test was run by reviewer@example.com.' },
    required: ['historical settings', 'original test', '[REDACTED_EMAIL]'], forbidden: ['operator@example.com', 'reviewer@example.com'] }
];
const sourceFiles = ['packages/orgbrain-cli/src/lib/hook-failure-context.mjs',
  'packages/orgbrain-cli/src/codex-memory-context.mjs', 'packages/orgbrain-cli/src/lib/local-memory-store.mjs'];
const report = { schema: 'memory-value-context-replay/v1', generated_at: new Date().toISOString(),
  scope: 'synthetic regression replay of the real local UserPromptSubmit hook; identical inputs on both revisions',
  metric: 'complete usable memory fields or correct omission; not a model task outcome',
  actual_session_tokens: null, actual_session_turns: null, actual_task_elapsed_ms: null,
  actual_provider_cost: null, fixture_count: cases.length, variants: {} };
for (const [name, root] of Object.entries(roots)) {
  const load = file => import(pathToFileURL(join(root, file)).href);
  const { LocalMemoryStore } = await load('packages/orgbrain-cli/src/lib/local-memory-store.mjs');
  const { buildCodexMemoryContext } = await load('packages/orgbrain-cli/src/codex-memory-context.mjs');
  const { countContextTokens } = await load('packages/orgbrain-cli/src/lib/compact-memory-context.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'orgbrain-context-replay-'));
  const results = [];
  try {
    const workspace = join(directory, 'workspace'); await mkdir(workspace);
    await writeFile(join(workspace, 'voice.md'), 'synthetic fixture evidence');
    const mapping = join(directory, 'workspaces.json');
    await writeFile(mapping, JSON.stringify({ version: 1, workspaces: {
      [workspace]: { tenant_id: 'default', project_id: 'p', memory_learning_mode: 'off' }
    } }));
    for (const item of cases) {
      const store = new LocalMemoryStore(join(directory, `${item.id}.sqlite`), {
        env: {}, denseEmbeddingProvider: null,
        memoryJudge: async () => ({ mode: 'off', applied: false, status: 'disabled', decisions: [] })
      });
      await store.useHistory('configure', { mode: 'off', collect: true, sync: false });
      await store.capture({ id: item.id, tenant_id: 'default', project_id: 'p', work_type: 'other',
        source: 'synthetic-fixture', external_key: item.id,
        source_references: [{ type: 'file', ref: 'voice.md' }], ...item.memory });
      const result = await buildCodexMemoryContext({ hook_event_name: 'UserPromptSubmit', cwd: workspace,
        session_id: `synthetic-${item.id}`, turn_id: 'turn-1', prompt: item.query ?? 'Voice API timeout policy' },
      { store, env: { ORGBRAIN_WORKSPACES_FILE: mapping, ORGBRAIN_LOCAL_DB: store.dbPath,
        ORGBRAIN_ENABLE_CLOUD_MEMORY: 'false', ORGBRAIN_ENABLE_ORG_SHARING: 'false', DOMAIN_RECALL_MODE: 'off' } });
      const text = result?.hookSpecificOutput?.additionalContext ?? '';
      const db = store.open({ readOnly: true });
      let injected;
      try { injected = db.prepare("SELECT source_id FROM memory_usage_items WHERE reference_type='injected'").all().map(row => row.source_id); }
      finally { db.close(); }
      const complete = (item.required ?? []).every(value => text.includes(value));
      const safe = (item.forbidden ?? []).every(value => !text.includes(value));
      const withinBudget = Buffer.byteLength(text) <= 7168;
      const passed = withinBudget && safe && (item.omitted ? injected.length === 0 && !text.includes('summary:') :
        complete && injected.length === 1 && injected[0] === item.id);
      results.push({ id: item.id, passed, complete_fields: item.omitted ? null : complete,
        injected_count: injected.length, within_budget: withinBudget, redaction_passed: safe,
        hook_context_tokens: countContextTokens(text), hook_context_bytes: Buffer.byteLength(text) });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
  const hashes = {};
  for (const file of sourceFiles) hashes[file] = createHash('sha256').update(await readFile(join(root, file))).digest('hex');
  report.variants[name] = { revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    source_sha256: hashes, cases: results,
    summary: { passed: results.filter(item => item.passed).length, total: results.length,
      budget_violations: results.filter(item => !item.within_budget).length,
      delivered_complete_positive_cases: results.filter(item => item.complete_fields === true && item.injected_count === 1).length,
      hook_context_tokens: results.reduce((sum, item) => sum + item.hook_context_tokens, 0) } };
}
report.interpretation = 'More complete context can require more injected tokens. This replay measures usable evidence delivery and safe omission; it does not measure agent adoption, avoided lookups or session savings. Fixtures are authored regressions, not independent held-out evaluation.';
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(Object.fromEntries(Object.entries(report.variants).map(([key, value]) => [key, value.summary])), null, 2));
if (report.variants.candidate.cases.some(item => !item.passed)) process.exitCode = 1;
