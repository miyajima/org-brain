import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fixture } from './lib/memory-use-fixture.mjs';

// Run against the exact built/installed artifact, not an import of CLI source.
const cli = process.env.ORGBRAIN_TEST_CLI;
function invoke(db, args) {
  const command = cli ? process.execPath : 'orgbrain';
  return JSON.parse(execFileSync(command, [...(cli ? [resolve(cli)] : []), ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ORGBRAIN_LOCAL_DB: db, ORGBRAIN_ENABLE_CLOUD_MEMORY: 'false',
      ORGBRAIN_LOCAL_EMBEDDING_PROVIDER: '' }
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
