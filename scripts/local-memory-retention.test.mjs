import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './lib/memory-use-fixture.mjs';
import { inspectRetention, runMemoryRetention, setRetentionPolicy, keepMemory } from '../packages/orgbrain-cli/src/lib/memory-retention.mjs';

const DAY = 86_400_000;
const start = Date.parse('2026-11-24T03:17:00+09:00');
const report = '# Reusable Memory\n\n## Takeaway\n## QOL日次レポート — 2026年11月23日\n\n当日の観測値を記録した。\n\n## Evidence\n元の観測。';

test('shadow selects the four known automatic report shapes and leaves review-only decisions untouched', async () => {
  const f = await fixture();
  try {
    const cases = {
      rehearsal: ['{"suggestions":[{"title":"リハーサル案","prompt":"次回の通話を確認"}]}', 'bulk_suggestions'],
      commit: ['11件をコミット済み: `ce173f145939`\n\n197件通過。', 'commit_status']
    };
    const reasons = new Map([[await seed(f.store, 'qol-fixture'), 'dated_report']]);
    for (const [key, [takeaway, reason]] of Object.entries(cases)) {
      reasons.set(await seed(f.store, key, {summary:takeaway,content:`# Reusable Memory\n\n## Takeaway\n${takeaway}\n\n## Evidence\n観測記録。`}), reason);
    }
    const symptom = 'Bluetooth接続時に音が途切れる。原因は調査中。';
    const bluetooth = await seed(f.store, 'bluetooth', {summary:symptom,content:`symptom: ${symptom}`});
    // Reproduce an older row that current capture correctly refuses to create.
    f.db.prepare("UPDATE memories SET source='classified-auto',capture_route='realtime_hook',learning_json=? WHERE id=?")
      .run(JSON.stringify({lesson_type:'failure',symptom,contract_metadata:{classification_policy:'classified-auto/v2'}}),bluetooth);
    reasons.set(bluetooth,'symptom_only');
    for (const [key, takeaway] of Object.entries({ batch:'未確認の28件を隔離する。', clone:'MyCloneの判断基準案。', wiki:'Wikiの承認設定案。' })) {
      await seed(f.store,key,{kind:'decision',tags:['user-confirmed-learning'],content:`# Reusable Memory\n\n## Takeaway\n${takeaway}\n\n## Evidence\n当時の確認。`});
    }
    await seed(f.store,'reviewed-procedure',{content:'# Reusable Memory\n\n## Takeaway\n起動後に最終状態を確認する。\n\n## Evidence\n起動応答は途中状態。\n\n## Reuse Rule\nワーカーを起動したとき。'});
    await seed(f.store,'nested-example',{content:'# Reusable Memory\n\n## Takeaway\n集計ファイルの例。\n\n## QOL日次レポート — 2026年11月23日\n\n## Evidence\n見出しのサンプル。'});
    await seed(f.store,'report-with-reusable-condition',{content:`${report}\n\n## Reuse Rule\nTracking IDがOtherのみなら、対象IDの数値として扱わない。`});
    await seed(f.store,'report-with-appended-reuse',{content:`${report}\n\n## Reuse Rule\nReuse this workaround only for the same project pattern.\nValidate with the same check after applying: 元の観測。\n本番の締め日は担当者に確認する。`});
    const ownerProtected = await seed(f.store,'hold-principal',{kind:'org_knowledge'});
    f.db.prepare("UPDATE memories SET owner_principal='local' WHERE id=?").run(ownerProtected);
    await runMemoryRetention(f.store,{tenantId:'t',now:start});
    const preview = await inspectRetention(f.store,{tenantId:'t',projectId:'p'});
    assert.deepEqual(new Map(preview.candidates.map(({id,reason})=>[id,reason])), reasons);
    assert.equal(preview.policies[0].observations[0].plan_hash,preview.plan_hash);
    assert.equal(preview.policies[0].observations[0].candidates.length,4);
  } finally { await f.close(); }
});

async function seed(store, key, overrides = {}) {
  return (await store.capture({ tenant_id: 't', project_id: 'p', scope_type: 'project', scope_key: 'p', source: 'codex',
    kind: 'pitfall', external_key: key, summary: '当日のレポート', content: report, ...overrides })).memory_id;
}

async function enable(f, scope) {
  const opts = { tenantId: 't', projectId: scope };
  const preview = await inspectRetention(f.store, opts);
  await assert.rejects(setRetentionPolicy(f.store, { ...opts, enable: true, expectedPlanHash: preview.plan_hash, now: start }), /retention_shadow_incomplete/);
  for (let day = 0; day <= 7; day++) {
    const run = await runMemoryRetention(f.store, { tenantId: 't', now: start + day * DAY });
    assert.equal(run.suppressed + run.purged, 0);
  }
  const plan = await inspectRetention(f.store, opts);
  await setRetentionPolicy(f.store, { ...opts, enable: true, expectedPlanHash: plan.plan_hash, now: start + 7 * DAY });
  return { now: start + 7 * DAY };
}

test('scheduled retention uses an explicit shadow-reviewed scope, waits 30 days and erases copies before backup restore', async () => {
  const f = await fixture();
  try {
    const uniqueTerm = 'kiwipurplecitron';
    const privateReport = `${report} ${uniqueTerm}`;
    const id = await seed(f.store, 'qol', {content:privateReport,summary:`当日のレポート ${uniqueTerm}`});
    const other = await seed(f.store, 'other-project', { project_id: 'other', scope_key: 'other' });
    const confirmed = await seed(f.store, 'confirmed', { tags: ['user-confirmed-learning'] });
    const { now } = await enable(f, 'p');
    await f.store.recordUsage({ id:'report-delivery',tenant_id:'t',project_id:'p',task_id:'report-task',items:[
      {id:'report-use',source_type:'memory',source_id:id,source_version:1},
      {id:'unrelated-use',source_type:'memory',source_id:confirmed,source_version:1} ] });
    f.db.prepare(`INSERT INTO memory_use_contexts(id,tenant_id,usage_item_id,source_type,source_id,source_version,
      project_id,task_id,work_type,principal,context_json,request_hash,verification_state,created_at)
      VALUES('report-context','t','report-use','memory',?,1,'p','report-task','other','local',?,'hash','unverified',?)`)
      .run(id, JSON.stringify({excerpt:privateReport}), now);
    f.db.prepare("INSERT INTO memory_use_context_fts(context_id,text) VALUES('report-context',?)").run(privateReport);
    f.db.prepare("INSERT INTO memory_use_outbox(id,tenant_id,payload_json,status,created_at) VALUES('report-context','t',?,'sent',?)")
      .run(JSON.stringify({usage_item_id:'report-use',excerpt:privateReport}),now);
    const backup = join(f.dir, 'before-cleanup.sqlite');
    await f.store.createBackup(backup);
    const run = (at) => runMemoryRetention(f.store, { tenantId: 't', now: at });
    assert.equal((await run(now)).suppressed, 1);
    assert.equal((await f.store.get('t', id)).lifecycle_state, 'suppressed');
    assert.equal((await run(now + 30 * DAY - 1)).purged, 0);
    assert.equal((await run(now + 30 * DAY)).purged, 1);
    assert.equal((await run(now + 31 * DAY)).purged, 0);
    assert.ok(!(await f.store.get('t', id)));
    assert.equal((await f.store.get('t', other)).lifecycle_state, 'active');
    assert.equal((await f.store.get('t', confirmed)).lifecycle_state, 'active');
    assertPurged(f.db);
    await assert.rejects(f.store.restoreBackup(backup), /database is locked/u);
    assert.ok(!(await f.store.get('t', id)));
    f.db.close();
    await f.store.restoreBackup(backup);
    assert.ok(!(await f.store.get('t', id)));
    const db = f.store.open({ readOnly: true });
    try { assertPurged(db); }
    finally { db.close(); }
    function assertPurged(db) {
      assert.equal(db.prepare('SELECT count(*) n FROM memory_versions WHERE memory_id=?').get(id).n, 0);
      assert.equal(db.prepare('SELECT count(*) n FROM memory_retrieval_units_v4 WHERE memory_id=?').get(id).n, 0);
      assert.equal(db.prepare("SELECT count(*) n FROM memory_usage_items WHERE usage_event_id='report-delivery'").get().n, 1);
      assert.equal(db.prepare("SELECT count(*) n FROM memory_use_contexts WHERE id='report-context'").get().n, 0);
      assert.equal(db.prepare("SELECT count(*) n FROM memory_use_context_fts WHERE context_id='report-context'").get().n, 0);
      assert.equal(db.prepare("SELECT count(*) n FROM memory_use_outbox WHERE id='report-context'").get().n, 0);
      assert.deepEqual(JSON.parse(db.prepare("SELECT payload_json FROM memory_use_outbox WHERE id='report-context:revoke'").get().payload_json),
        {operation:'revoke',id:'report-context'});
      for (const table of ['memories_fts','memory_retrieval_units_fts','memory_retrieval_units_v4_fts','retrieval_units_fts','memory_use_context_fts']) {
        assert.equal(db.prepare(`SELECT count(*) n FROM ${table}_data WHERE instr(block,cast(? as blob))>0`).get(uniqueTerm).n,0,table);
      }
    }
  } finally { await f.close(); }
});

test('a keep, a restored version, and a new legal hold all prevent the pending deletion', async () => {
  const f = await fixture();
  try {
    const restored = await seed(f.store, 'restore');
    const kept = await seed(f.store, 'keep');
    const held = await seed(f.store, 'hold');
    const dependedOn = await seed(f.store, 'became-origin');
    const { now } = await enable(f, 'p');
    await runMemoryRetention(f.store, { tenantId: 't', now });
    await f.store.restoreMemoryVersion('t', restored, 1, 'local');
    await f.store.capture({tenant_id:'t',project_id:'p',source:'manual',kind:'constraint',content:'Reuse the established publication checklist.',
      evidence:[{evidence_type:'memory',evidence_ref:dependedOn}],created_at:now+29*DAY});
    await keepMemory(f.store, { tenantId: 't', projectId: 'p', memoryId: kept });
    f.db.prepare('INSERT INTO retention_policies(id,tenant_id,project_id,retention_days,legal_hold,updated_by_principal,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run('legal-hold', 't', 'p', 30, 1, 'operator', now, now);
    assert.equal((await runMemoryRetention(f.store, { tenantId: 't', now: now + 30 * DAY })).purged, 0);
    f.db.prepare('DELETE FROM retention_policies WHERE id=?').run('legal-hold');
    const final = await runMemoryRetention(f.store, { tenantId: 't', now: now + 31 * DAY });
    assert.equal(final.purged, 1);
    assert.equal((await f.store.get('t', restored)).lifecycle_state, 'active');
    assert.ok(await f.store.get('t', kept));
    assert.ok(!(await f.store.get('t', held)));
    assert.ok(await f.store.get('t', dependedOn));
  } finally { await f.close(); }
});
