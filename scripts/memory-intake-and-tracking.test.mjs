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

test('CLI transient preview does not mutate and apply preserves audit history',async()=>{
 const f=await fixture();try{
 const old=await f.store.capture({tenant_id:'t',project_id:'p',source:'legacy',kind:'fact',summary:'qol-item | command-result | 公開が完了しました',content:'公開が完了しました'});
 const cli=join(process.cwd(),'packages/orgbrain-cli/src/local-memory.mjs');
 const run=(...args)=>JSON.parse(execFileSync(process.execPath,[cli,'memory','prune-transient','--tenant-id','t',...args],{encoding:'utf8',env:{...process.env,ORGBRAIN_LOCAL_DB:f.store.dbPath},stdio:['ignore','pipe','pipe']}));
 assert.equal(run().selected.length,1);assert.equal(f.db.prepare('SELECT lifecycle_state FROM memories WHERE id=?').get(old.memory_id).lifecycle_state,'active');
 assert.equal(run('--apply').suppressed.length,1);assert.equal(run('--apply').selected.length,0);
 }finally{await f.close();}
});
