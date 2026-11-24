import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fixture } from './lib/memory-use-fixture.mjs';

// Run against the exact built/installed artifact, not an import of CLI source.
const cli = process.env.ORGBRAIN_TEST_CLI;
function invoke(db, args, environment = {}, input) {
  const command = cli ? process.execPath : 'orgbrain';
  return JSON.parse(execFileSync(command, [...(cli ? [resolve(cli)] : []), ...args], {
    encoding: 'utf8', input, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    env: { ...process.env, ORGBRAIN_LOCAL_DB: db, ORGBRAIN_ENABLE_CLOUD_MEMORY: 'false',
      ORGBRAIN_LOCAL_EMBEDDING_PROVIDER: '', ...environment }
  }));
}
test('distributed CLI previews and suppresses transient notices while retaining decisions and history', async () => {
  const f = await fixture();
  try {
    const old = await f.store.capture({ tenant_id: 't', project_id: 'p', source: 'legacy', kind: 'fact',
      summary: '本日の公開が完了しました', content: '本日の公開が完了しました' });
    await f.store.capture({ tenant_id: 't', project_id: 'p', source: 'manual', kind: 'constraint',
      summary: '公開前の確認を必須とする', content: '公開前の確認を必須とする' });
    await f.store.recordUsage({ id: 'old-use', tenant_id: 't', project_id: 'p', items: [
      { id: 'old-use-item', source_type: 'memory', source_id: old.memory_id, source_version: 1 }] });
    const args = ['memory', 'prune-transient', '--tenant-id', 't'];
    assert.equal(invoke(f.store.dbPath, args).selected.length, 1);
    assert.equal((await f.store.get('t', old.memory_id)).lifecycle_state, 'active');
    assert.equal(invoke(f.store.dbPath, [...args, '--apply']).suppressed.length, 1);
    assert.equal(invoke(f.store.dbPath, [...args, '--apply']).selected.length, 0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM memory_usage_items WHERE id=?').get('old-use-item').n, 1);
    assert.equal(f.db.prepare("SELECT count(*) n FROM memories WHERE kind='constraint' AND lifecycle_state='active'").get().n, 1);
  } finally { await f.close(); }
});

test('the shipped schedule records one shadow day, and the shipped prompt hook preserves a confirmed answer', async () => {
  const f = await fixture();
  try {
    const workspace = resolve(f.dir, 'workspace');
    const config = resolve(f.dir, 'workspaces.json');
    const state = resolve(f.dir, 'state');
    await mkdir(workspace);
    await writeFile(config, JSON.stringify({ version: 1, workspaces: { [workspace]: { tenant_id:'default', project_id:'p', memory_learning_mode:'off' } } }));
    const hooks = resolve(f.dir,'hooks.env');
    await writeFile(hooks, 'ORGBRAIN_LOCAL_CONTEXT_ENABLED=true\nORGBRAIN_MEMORY_COMMITMENTS_MODE=on\n', {mode:0o600});
    const env = { ORGBRAIN_WORKSPACES_FILE: config, ORGBRAIN_AUTONOMY_STATE_DIR: state, ORGBRAIN_HOOK_ENV_FILES: hooks,
      ORGBRAIN_SESSION_EXTRACTION_MODE:'off', ORGBRAIN_TENANT_ID:'default' };
    const report = await f.store.capture({ tenant_id:'default', project_id:'p', scope_type:'project', scope_key:'p', source:'codex', kind:'fact',
      content:'# Reusable Memory\n\n## Takeaway\n## QOL日次レポート — 2026年11月23日\n\nアクセス数は12。\n\n## Evidence\n集計結果。' });
    const command = ['autonomy','run','--workspace',workspace,'--state-dir',state];
    invoke(f.store.dbPath, [...command, '--dry-run'], env);
    const before = invoke(f.store.dbPath, ['memory','retention','--project-id','p'], env);
    assert.equal(before.policies.length, 0);
    invoke(f.store.dbPath, [...command, '--execute','--apply'], env);
    const after = invoke(f.store.dbPath, ['memory','retention','--project-id','p'], env);
    assert.equal(after.policies[0].observed_days, 1);
    assert.equal(after.policies[0].enabled, false);
    assert.equal(after.candidates[0].id, report.memory_id);
    assert.deepEqual(after.pending, []);
    assert.equal((await f.store.get('default',report.memory_id)).lifecycle_state,'active');
    const observation = invoke(f.store.dbPath,['memory','retention','--observe'],env);
    assert.equal(observation.candidate_count,1);
    assert.equal(observation.suppressed+observation.purged,0);
    const control = ['memory','retention','--project-id','p'];
    assert.throws(() => invoke(f.store.dbPath,[...control,'--enable','--expected-plan-hash',after.plan_hash],env),/retention_shadow_incomplete/u);
    assert.throws(() => invoke(f.store.dbPath,[...control,'--enable=false'],env),/retention_invalid_args/u);
    assert.equal(invoke(f.store.dbPath,[...control,'--pause'],env).enabled,false);

    const session = { session_id:'fixture-session', cwd:workspace, project_id:'p' };
    const question = { id:'posting_policy', question:'投稿前に承認を必須にしますか？',
      options:[{id:'required',label:'承認必須'},{id:'optional',label:'任意'}] };
    const { TaskCommitmentStore } = await import('../packages/orgbrain-cli/src/lib/task-commitment-store.mjs');
    const commitments = new TaskCommitmentStore(f.store.dbPath);
    await commitments.ingestToolResult({ ...session, hook_event_name:'PostToolUse', tool_name:'request_user_input',
      tool_input:{questions:[question]},tool_result:{answers:{posting_policy:'承認必須'}} },'default');
    await f.store.capture({ tenant_id:'default', project_id:'p', source:'manual', kind:'decision', work_type:'other',
      content:'Use the Codex notify and prompt hooks with a short-lived Node CLI. Avoid a resident MCP server and do not call an LLM from either hook.',
      summary:'Use short-lived Codex hooks instead of resident MCP or extra LLM calls.',tags:['codex','hooks'],confidence_score:0.9,utility_score:0.8 });
    const hook = invoke(f.store.dbPath, ['hook','codex-context'], env, JSON.stringify({ ...session, hook_event_name:'UserPromptSubmit',
      prompt:'How should Codex integrate OrgBrain without resident MCP or extra LLM calls?' }));
    const content = hook.hookSpecificOutput.additionalContext;
    assert.ok(content.includes('changes a decision'), 'recall guidance must accompany a relevant memory');
    assert.match(content,/decision_key=posting_policy[\s\S]+承認必須/u);
    const guard = invoke(f.store.dbPath, ['hook','codex-pre-tool'], env, JSON.stringify({ ...session, hook_event_name:'PreToolUse',
      tool_name:'request_user_input',tool_input:{questions:[question]} }));
    assert.equal(guard.hookSpecificOutput.permissionDecision,'deny');
  } finally { await f.close(); }
});
test('distributed CLI reports persisted collection gaps without upgrading missing observations to use', async () => {
  const f = await fixture();
  try {
    const { collectMemoryUse } = await import('../packages/orgbrain-cli/src/lib/memory-use-collector.mjs');
    await collectMemoryUse(f.store, { rows: [], tenantId: 't', projectId: 'p', taskId: 'fixture-task',
      turnId: 'fixture-turn', readReason: 'transcript_path_missing' });
    const report = invoke(f.store.dbPath, ['usage', 'report', '--tenant-id', 't']);
    assert.equal(report.collection_metrics.runs, 1);
    assert.equal(report.collection_metrics.gap_reasons.transcript_path_missing, 1);
    assert.equal(report.collection_metrics.verified_use_records, 0);
    assert.equal(report.total.action_observed, 0);
    assert.equal(report.total.contributed, 0);
  } finally { await f.close(); }
});

const baseline = process.env.ORGBRAIN_COMPAT_BASELINE_CLI;
test('distributed CLI retains every previously installed public command signature', t => {
  const help = path => execFileSync(process.execPath, [resolve(path), '--help'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const installedHelp = () => execFileSync('orgbrain', ['--help'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  let previous;
  try { previous = baseline ? help(baseline) : installedHelp(); }
  catch (error) {
    if (!baseline && error.code === 'ENOENT') { t.skip('No previously installed CLI'); return; }
    throw error;
  }
  const signatures = text => text.split('\n').filter(line => line.startsWith('  orgbrain ')).map(line => line.trim());
  const before = signatures(previous);
  const after = new Set(signatures(cli ? help(cli) : installedHelp()));
  assert(before.length > 0);
  assert.deepEqual(before.filter(line => !after.has(line)), []);
});
