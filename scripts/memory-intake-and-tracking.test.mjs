import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {verifyLearningEvent} from '../packages/orgbrain-cli/src/lib/memory-learning-transcript.mjs';
import {collectMemoryUse} from '../packages/orgbrain-cli/src/lib/memory-use-collector.mjs';
import {fixture} from './lib/memory-use-fixture.mjs';

const event={schema_version:2,lesson_type:'success',capture_intent:'verify',conclusion:'alpha reconciliation',rationale:'idempotent alpha logic',reuse_rule:'same alpha timeout',outcome:'alpha check passed',procedure:'check alpha then reconcile',why_it_worked:'alpha preserves identity',observed_outcome:'alpha check passed',reuse_when:'same alpha timeout',applicability:{target_files:['alpha.mjs'],components:['alpha']},gaps:[],evidence_selectors:[{type:'file',ref:'alpha.mjs',supports:['procedure']},{type:'command',ref:'node --test alpha.test.mjs',supports:['observed_outcome']}]};
const rows=[{type:'function_call',payload:{type:'function_call',name:'exec_command',call_id:'check',arguments:JSON.stringify({cmd:'node --test alpha.test.mjs'})}},{type:'function_call_output',payload:{type:'function_call_output',call_id:'check',output:JSON.stringify({exit_code:0})}}];

test('intake verifies existing unchanged code with an observed successful check; a doc alone cannot attest execution',async t=>{
 const root=await mkdtemp(join(tmpdir(),'orgbrain-intake-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(join(root,'alpha.mjs'),'export const alpha = true;\n');
 execFileSync('git',['init','-q'],{cwd:root});execFileSync('git',['add','alpha.mjs'],{cwd:root});execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture'],{cwd:root});
 const result=await verifyLearningEvent(event,{workspaceRoot:root,rows,userText:''});assert.equal(result.verification_state,'verified');
 const unsupported=await verifyLearningEvent({...event,evidence_selectors:[{type:'doc',ref:'source:12345678-1234-4234-9234-123456789abc@1',supports:['procedure']}]},{workspaceRoot:root,rows:[],userText:'',resolveWikiSource:async()=>({ok:true,evidence:{type:'doc',ref:'source:12345678-1234-4234-9234-123456789abc@1',content_hash:'a'.repeat(64),attestation_ref:'wiki:immutable'}})});
 assert.notEqual(unsupported.verification_state,'verified');assert(!unsupported.reason_codes.includes('file_not_found'));assert(unsupported.evidence.some(e=>e.ref.startsWith('source:')));
});

test('collection persists delivery and missing-observation metrics across restart without treating them as use',async()=>{
 const f=await fixture();try{
 const response={meta:{usage_id:'usage',usage_items:[{usage_item_id:'item',source_id:f.id,source_version:1}]}};
 const calls=[{payload:{type:'custom_tool_call',call_id:'wrap',name:'exec',input:'opaque transport'}},{payload:{type:'custom_tool_call_output',call_id:'wrap',output:'Script completed\nOutput:\n'+JSON.stringify({i:0,result:{status:'fulfilled',value:{content:[{type:'text',text:JSON.stringify(response)}]}}})}}];
 const args={rows:calls,tenantId:'t',projectId:'p',taskId:'prior-task',turnId:'metrics-turn'};await collectMemoryUse(f.store,args);await collectMemoryUse(f.store,args);
 const report=await f.store.useHistory('report',{tenant_id:'t'});assert.equal(report.total.delivery_confirmed,1);assert.equal(report.total.action_observed,0);assert.equal(report.collection_metrics.runs,1);assert.equal(report.collection_metrics.delivered_items,1);assert.equal(report.collection_metrics.without_use_observation,1);
 await collectMemoryUse(f.store,{rows:[],tenantId:'t',projectId:'p',taskId:'prior-task',turnId:'missing-turn',readReason:'transcript_path_missing'});
 const {LocalMemoryStore}=await import('../packages/orgbrain-cli/src/lib/local-memory-store.mjs');
 const restarted=new LocalMemoryStore(f.store.dbPath,{denseEmbeddingProvider:null});
 const again=await restarted.useHistory('report',{tenant_id:'t'});assert.equal(again.collection_metrics.runs,2);assert.equal(again.collection_metrics.gap_reasons.transcript_path_missing,1);
 assert(!JSON.stringify(again.collection_metrics).includes('opaque transport'));
 await collectMemoryUse(f.store,{rows:[{payload:{type:'function_call',call_id:'failed-call',name:'fixture',arguments:'{}'}},{payload:{type:'function_call_output',call_id:'failed-call',output:JSON.stringify({isError:true})}}],tenantId:'t',projectId:'p',taskId:'prior-task',turnId:'failed-turn'});
 assert.equal((await restarted.useHistory('report',{tenant_id:'t'})).collection_metrics.completed_calls,2);
 }finally{await f.close();}
});

test('transient cleanup preserves decisions and reusable lessons and suppresses completion notices without erasing usage',async()=>{
 const {isTransientMemory}=await import('../packages/shared/src/memory-admission-runtime.mjs');
 assert.equal(isTransientMemory({kind:'fact',summary:'qol-item | command-result | 本日の公開が完了しました',content:'本日の公開が完了しました'}),true);
 assert.equal(isTransientMemory({kind:'fact',summary:'本日の公開が完了しました',content:'- RecordedAt: 2026-10-01\n\n本日の公開が完了しました'}),true);
 assert.equal(isTransientMemory({kind:'constraint',summary:'公開が完了しました',content:'公開前の確認を必須とする'}),false);
 assert.equal(isTransientMemory({kind:'fact',summary:'修正完了',content:'修正完了',reuse_rule:'同じ接続障害が発生したら実行パスを照合する'}),false);
 assert.equal(isTransientMemory({kind:'fact',summary:'再起動済み',content:'silenceDurationMs=500 を設定した'}),false);
 assert.equal(isTransientMemory({kind:'fact',summary:'日次レポート設定完了しました',content:'毎朝9時に前日のレポートを生成する'}),false);
 assert.equal(isTransientMemory({kind:'fact',summary:'移設完了しました',content:'現行セットの保存先を移設した'}),false);
 assert.equal(isTransientMemory({kind:'fact',summary:'command-result | 検索の説明',content:'検索は全文検索とベクトル検索を組み合わせる',tags:['command-result']}),false);
 assert.equal(isTransientMemory({kind:'fact',summary:'本日の公開が完了しました',tags_json:'{}'}),false);
 const f=await fixture();try {
 await assert.rejects(f.store.capture({tenant_id:'t',project_id:'p',source:'codex',kind:'fact',capture_origin:'observed',capture_route:'realtime_hook',summary:'本日の公開が完了しました',content:'本日の公開が完了しました'}),/transient_memory_rejected/);
 const {pruneTransientMemories}=await import('../packages/orgbrain-cli/src/lib/memory-prune.mjs');
 const old=await f.store.capture({tenant_id:'t',project_id:'p',source:'legacy',kind:'fact',summary:'qol-item | command-result | 本日の公開が完了しました',content:'本日の公開が完了しました'});
 await f.store.recordUsage({id:'old-usage',tenant_id:'t',project_id:'p',items:[{id:'old-item',source_type:'memory',source_id:old.memory_id,source_version:1}]});
 const preview=await pruneTransientMemories(f.store,{tenantId:'t'});assert.equal(preview.selected.length,1);
 await pruneTransientMemories(f.store,{tenantId:'t',apply:true});assert.equal(f.db.prepare('SELECT lifecycle_state FROM memories WHERE id=?').get(old.memory_id).lifecycle_state,'suppressed');assert.equal(f.db.prepare('SELECT count(*) n FROM memory_usage_items WHERE id=?').get('old-item').n,1);
 assert.equal((await pruneTransientMemories(f.store,{tenantId:'t',apply:true})).selected.length,0);
 }finally{await f.close();}
});

test('Wiki source intake rejects changed bytes, wrong versions and incomplete source reads',async t=>{
 const {resolveWikiSourceEvidence}=await import('../packages/orgbrain-cli/src/lib/wiki-source-evidence.mjs');
 const {createHash}=await import('node:crypto');const root=await mkdtemp(join(tmpdir(),'orgbrain-wiki-evidence-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const configPath=join(root,'config.json');await writeFile(configPath,JSON.stringify({enabled:true,wiki_id:'personal',wiki_command:['fixture-cli','wiki']}));
 const id='12345678-1234-4234-9234-123456789abc',ref='source:'+id+'@1',text='alpha code and recorded result\n',hash=createHash('sha256').update(text).digest('hex');
 const run=async(_exe,args)=>{assert.equal(args.at(-1),'personal');return {stdout:JSON.stringify({source_id:id,version:1,text,hash,truncated:false,next_char_offset:null})};};
 assert.equal((await resolveWikiSourceEvidence(ref,null,{configPath,run})).evidence.verification_scope,'source_provenance');
 assert.equal((await resolveWikiSourceEvidence(ref,'f'.repeat(64),{configPath,run})).reason,'wiki_source_digest_mismatch');
 assert.equal((await resolveWikiSourceEvidence(ref+'#L1-L99',null,{configPath,run})).reason,'wiki_source_range_invalid');
 assert.equal((await resolveWikiSourceEvidence(ref,null,{configPath,run:async()=>({stdout:JSON.stringify({source_id:id,version:1,text,hash,truncated:true})})})).reason,'wiki_source_incomplete');
 await writeFile(configPath,JSON.stringify({enabled:true,wiki_id:'another',wiki_command:['fixture-cli']}));assert.equal((await resolveWikiSourceEvidence(ref,null,{configPath,run})).reason,'wiki_source_unavailable');
});

test('automatic intake skips reports and suggestion dumps, leaving reusable rules in mixed output', async () => {
  const {prepareMemoryRecordForUpsert} = await import('../packages/orgbrain-cli/src/hook-memory-bridge.mjs');
  const {extractDurableMemoryDrafts} = await import('../packages/shared/src/memory-capture-v2-runtime.mjs');
  const suggestions = JSON.stringify({suggestions: [{title: '応答を短縮する', description: '今回の遅延対策としてプロファイルを取る案です。',
    prompt: 'The recommended next action is to profile the check. The reason is the last rehearsal exceeded the deadline. Implement a small fix and verify the result.'}]});
  const snapshot = '## QOL日次レポート — 2026年9月29日\n\n集計結果です。仮の計測方針では、ユニーク訪問者93、リクエスト735でした。確認用の参照先は既存の手順書に記録しました。理由は今回だけ集計時間が異なるためです。';
  const status = '11件をコミット済み: `ce173f145939`\n\n`pnpm test` で197件通過しました。本番の音声は未検証で、今回はローカルの検証結果を共有します。対象環境と結果の確認手順は現在の変更通知に記載してあります。';
  for (const text of [suggestions, snapshot, status]) {
    const payload = JSON.stringify({ hook_event_name: 'Stop', cwd: '/tmp/workspaces/p', last_assistant_message: text });
    assert.equal(prepareMemoryRecordForUpsert('codex-stop', payload).action, 'skip', text);
  }
  const draft = '調査結果を共有します。こちらは提案です。採用はまだ決まっていません。原因は設定漏れかもしれません。\n- `example-cli status` で取得値を確認します。\n- `example-cli inspect` を使って設定ミスの対処を試します。\n本番適用の可否を検討するという案です。';
  const legacyPayload = text => JSON.stringify({type:'agent-turn-complete',cwd:'/tmp/workspaces/org-brain','last-assistant-message':text});
  assert.equal(prepareMemoryRecordForUpsert('codex',legacyPayload(draft)).reason,'proposal_without_adoption');
  const procedure = '原因は `wrangler` 本体ではなく、Cloudflare OAuth ログイン未完了でした。\n\n今回やったこと:\n- `wrangler login` を実行\n- OAuth 認証完了を確認\n- `wrangler whoami` と `pnpm cf:usage:status` を再実行\n\n結果として D1 クエリは成功し、再発時は最初に `wrangler login` を確認する方針です。\n\n表示の例は「採用はまだ決まっていません。」です。';
  const reusable = prepareMemoryRecordForUpsert('codex',legacyPayload(procedure));
  assert.equal(reusable.action,'promote',reusable.reason);
  const rule = '欠落した使用量をゼロで補完しない方針とする。理由は未計測と報告済みのゼロを区別するため。';
  const parsed = extractDurableMemoryDrafts({ source: 'codex', project_id: 'p', text: `${snapshot}\n\n${rule}` });
  assert.ok(parsed.drafts.some((item) => item.content.includes('ゼロで補完しない')));
});

test('automatic intake drops unresolved symptoms and old report wrappers are eligible for preview', async () => {
  const f = await fixture();
  try {
    const { TaskCommitmentStore } = await import('../packages/orgbrain-cli/src/lib/task-commitment-store.mjs');
    const { pruneTransientMemories } = await import('../packages/orgbrain-cli/src/lib/memory-prune.mjs');
    const commits = new TaskCommitmentStore(f.store.dbPath);
    const symptom = { external_key: 'unresolved-quote', observation: {
      schema_version: 2, lesson_type: 'failure', symptom: 'After a macOS update this headset stutters. Does anyone know why?'
    }};
    const [skipped, retained] = await commits.saveLearningCandidates({ tenantId: 't', projectId: 'p', autoSaveClassified: true,
      sourcePacket:{snippets:[{span_id:'resolved',role:'assistant',text:`${symptom.observation.symptom} For Bluetooth headset stutter, check the selected input device first.`}]}, candidates: [
      symptom, { ...symptom, external_key: 'resolved-failure', support_span_ids:['resolved'], observation: { ...symptom.observation,
        root_cause: 'Input device selected headset mode.', correction: 'Select a separate microphone.',
        avoidance_rule: 'For Bluetooth headset stutter, check the selected input device first.' } }
    ] });
    assert.equal(skipped.status, 'held');
    assert.equal(retained.status, 'active');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM memory_learning_candidates').get().n, 0);
    const content = '# Reusable Memory\n\n## Takeaway\n{"suggestions":[{"title":"Profile today only","prompt":"Investigate the current rehearsal"}]}\n\n## Evidence\nOld output.';
    const capture = await f.store.capture({ tenant_id: 't', project_id: 'p', kind: 'pitfall', source: 'codex',
      summary: 'p | diagnosis | Profile the last rehearsal', content });
    const preview = await pruneTransientMemories(f.store, { tenantId: 't' });
    assert.deepEqual(preview.selected.map(item => item.id), [capture.memory_id]);
    assert.equal(f.db.prepare('SELECT lifecycle_state FROM memories WHERE id=?').get(capture.memory_id).lifecycle_state, 'active');
  } finally { await f.close(); }
});

test('CLI transient preview does not mutate and apply preserves audit history',async()=>{
 const f=await fixture();try{
 const old=await f.store.capture({tenant_id:'t',project_id:'p',source:'legacy',kind:'fact',summary:'qol-item | command-result | 公開が完了しました',content:'公開が完了しました'});
 const cli=join(process.cwd(),'packages/orgbrain-cli/src/local-memory.mjs');
 const run=(...args)=>JSON.parse(execFileSync(process.execPath,[cli,'memory','prune-transient','--tenant-id','t',...args],{encoding:'utf8',env:{...process.env,ORGBRAIN_LOCAL_DB:f.store.dbPath},stdio:['ignore','pipe','pipe']}));
 assert.equal(run().selected.length,1);assert.equal(f.db.prepare('SELECT lifecycle_state FROM memories WHERE id=?').get(old.memory_id).lifecycle_state,'active');
 assert.equal(run('--apply').suppressed.length,1);assert.equal(run('--apply').selected.length,0);
 }finally{await f.close();}
});

test('a daily report below a nested heading is transient, while documented reusable procedures stay searchable', async () => {
  const f = await fixture();
  try {
    const { pruneTransientMemories } = await import('../packages/orgbrain-cli/src/lib/memory-prune.mjs');
    const report = await f.store.capture({ tenant_id: 't', project_id: 'p', source: 'codex', kind: 'pitfall',
      summary: 'p | command-result | Report shared', content: '# Reusable Memory\n\n## Takeaway\n## QOL日次レポート — 2026年9月29日\n\nPVは未確認でした。\n\n## Evidence\n当日の記録。' });
    await f.store.capture({ tenant_id: 't', project_id: 'p', kind: 'constraint', source: 'codex',
      summary: '定期レポートの照合', content: '## QOL日次レポート — 2026年9月29日\n既定の集計方法はUTCと現地時間を分けて照合する。', reuse_rule: '日付境界をまたぐ集計時に適用する。' });
    assert.deepEqual((await pruneTransientMemories(f.store, { tenantId: 't' })).selected.map(x => x.id), [report.memory_id]);
  } finally { await f.close(); }
});
