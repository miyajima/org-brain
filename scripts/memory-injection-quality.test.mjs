import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalMemoryStore } from '../packages/orgbrain-cli/src/lib/local-memory-store.mjs';
import { buildCodexMemoryContext } from '../packages/orgbrain-cli/src/codex-memory-context.mjs';
import { handleLocalMcpRequest } from '../packages/orgbrain-cli/src/local-mcp.mjs';
import { collectMemoryUse } from '../packages/orgbrain-cli/src/lib/memory-use-collector.mjs';

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'orgbrain-injection-quality-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const workspace=join(root,'workspace');await mkdir(workspace);
  const config=join(root,'workspaces.json');await writeFile(config,JSON.stringify({version:1,workspaces:{[workspace]:{tenant_id:'default',project_id:'p',memory_learning_mode:'off'}}}));
  const store=new LocalMemoryStore(join(root,'memory.sqlite'),{denseEmbeddingProvider:null});
  await store.useHistory('configure',{mode:'c',collect:true});
  const env={ORGBRAIN_WORKSPACES_FILE:config,ORGBRAIN_ENABLE_CLOUD_MEMORY:'false',ORGBRAIN_ENABLE_ORG_SHARING:'false',ORGBRAIN_LOCAL_DB:store.dbPath,DOMAIN_RECALL_MODE:'off'};
  const run=(prompt,extra={})=>buildCodexMemoryContext({hook_event_name:'UserPromptSubmit',cwd:workspace,session_id:'quality-session',turn_id:'turn',prompt,...extra},{env,store});
  const save=(id,summary,rest={})=>store.capture({id,tenant_id:'default',project_id:'p',kind:'fact',work_type:'other',source:'test',summary,content:summary,external_key:id,...rest});
  return {root,store,save,run};
}
function hookCandidates(context) {
  return context.split('\n\n').filter(part=>part.startsWith('{'))
    .map(part=>JSON.parse(part)).filter(item=>item.detail_ref?.tool==='orgbrain_memory_get');
}
async function readHookCandidate(store,context,memoryId) {
  const candidate=hookCandidates(context).find(item=>item.memory_id===memoryId);
  assert.ok(candidate,context);
  assert.equal(candidate.detail_ref.arguments.memory_id,candidate.memory_id);
  assert.equal(candidate.detail_ref.arguments.expected_version,candidate.current_version);
  const response=await handleLocalMcpRequest(store,{method:'tools/call',params:{name:candidate.detail_ref.tool,arguments:candidate.detail_ref.arguments}});
  assert.equal(response.isError,false,response.content[0].text);
  const detail=JSON.parse(response.content[0].text);
  assert.equal(detail.memory.id,memoryId);
  assert.equal(detail.memory.current_version,candidate.current_version);
  return {candidate,memory:detail.memory};
}
function assertReturnedUnknown(store,memoryId) {
  const db=store.open({readOnly:true});
  try {
    const row=db.prepare("SELECT reference_type,used_state,injected_token_estimate FROM memory_usage_items WHERE source_id=? ORDER BY rowid DESC LIMIT 1").get(memoryId);
    assert.deepEqual({...row},{reference_type:'returned',used_state:'unknown',injected_token_estimate:0});
  } finally {db.close();}
}
test('status memories do not occupy the automatic context but remain available to explicit history questions',async t=>{
  const f=await fixture(t);
  await f.save('status','Voice | command-result | 11件をコミット済み: abc123',{content:'Voice API の設定とテスト11件をコミットしました。'});
  await f.save('rule','Voice APIの切断はtimeoutを確認する',{reuse_rule:'Voice APIの切断が発生した場合',content:'Voice APIの切断が発生した場合はtimeoutとサーバー終了ログを照合する。'});
  const normal=(await f.run('Voice APIが切断する原因を調べて')).hookSpecificOutput.additionalContext;
  assert.doesNotMatch(normal,/11件をコミット済み/);
  assert.match(normal,/timeout/);
  const history=(await f.run('Voice APIで前回コミットした内容と作業の完了状況を教えて',{turn_id:'history-turn'})).hookSpecificOutput.additionalContext;
  assert.match(history,/11件をコミット済み/);
  assert.equal(hookCandidates(normal)[0].memory_id,'rule');
  const selectedHistory=await readHookCandidate(f.store,history,'status');
  assert.equal(selectedHistory.memory.id,'status');
  const db=f.store.open({readOnly:true});try {
    assert.equal(db.prepare("SELECT lifecycle_state FROM memories WHERE id='status'").get().lifecycle_state,'active');
  }finally{db.close();}
  assertReturnedUnknown(f.store,'rule');
  assertReturnedUnknown(f.store,'status');
});
test('protected decisions survive a status-like summary and complete success lessons show reusable content',async t=>{
  const f=await fixture(t);
  await f.save('decision','Voiceの方針を確定しました',{kind:'constraint',content:'Voice APIへの公開前にはレビューが必要です。'});
  await f.save('success','Voice API修正完了',{reuse_rule:'同じVoice設定を変更するとき',learning:{schema_version:2,lesson_type:'success',procedure:'Voice設定の時間単位をミリ秒に揃える',why_it_worked:'APIはミリ秒を要求する',observed_outcome:'切断回帰テストが成功',reuse_when:'同じVoice設定を変更するとき',gaps:[]}});
  const output=(await f.run('Voice APIの設定を修正したい')).hookSpecificOutput.additionalContext;
  assert.match(output,/Voiceの方針/);
  assert.match(output,/ミリ秒に揃える/);
  assert.match(output,/同じVoice設定を変更するとき/);
});
test('identical current-turn hook invocations share one receipt instead of double-counting injection',async t=>{
  const f=await fixture(t);await f.save('rule','Voice APIの切断時はtimeoutを確認する');
  const a=await f.run('Voice APIの切断原因を調べて');
  const b=await f.run('Voice APIの切断原因を調べて');
  assert.equal(a.hookSpecificOutput.additionalContext,b.hookSpecificOutput.additionalContext);
  const db=f.store.open({readOnly:true});try{
    const rows=db.prepare("SELECT reference_type,used_state,injected_token_estimate FROM memory_usage_items WHERE source_id='rule'").all();
    assert.deepEqual(rows.map(row=>({...row})),[{reference_type:'returned',used_state:'unknown',injected_token_estimate:0}]);
  }finally{db.close();}
});
test('only receipt-backed pending previews deduplicate the same query and version',async t=>{
  const f=await fixture(t);await f.save('rule','Voice APIの切断時はtimeoutを確認する');
  const prompt='Voice APIの切断原因を調べて';
  const first=(await f.run(prompt)).hookSpecificOutput.additionalContext;
  assert.equal(hookCandidates(first)[0].memory_id,'rule');
  assert.equal(hookCandidates(first)[0].current_version,1);
  assert.match(first,/Use tracking: receipt;/u);
  assertReturnedUnknown(f.store,'rule');

  const transcript=join(f.root,'transcript.jsonl');
  const writeTranscript=async(text,file=transcript)=>writeFile(file,[
    {type:'turn_context',payload:{turn_id:'turn'}},
    {payload:{type:'message',role:'developer',content:[{type:'text',text}]}},
    {type:'turn_context',payload:{turn_id:'second'}}
  ].map(JSON.stringify).join('\n'));
  await writeTranscript(first);
  const repeat=(await f.run(prompt,{turn_id:'second',transcript_path:transcript})).hookSpecificOutput.additionalContext;
  assert.deepEqual(hookCandidates(repeat),[],'a trusted earlier returned receipt suppresses only the same query and version');

  const noReceiptTranscript=join(f.root,'transcript-without-receipt.jsonl');
  const previewOnly=first.split('\n\nUse tracking: receipt;')[0];
  assert.doesNotMatch(previewOnly,/Use tracking: receipt;/u);
  await writeTranscript(previewOnly,noReceiptTranscript);
  const unconfirmed=(await f.run(prompt,{turn_id:'second',transcript_path:noReceiptTranscript})).hookSpecificOutput.additionalContext;
  assert.equal(hookCandidates(unconfirmed)[0].memory_id,'rule','a visible preview without its usage receipt is not trusted delivery evidence');

  const changed=(await f.run('Voice APIのtimeout設定を変更したい',{turn_id:'third',transcript_path:transcript})).hookSpecificOutput.additionalContext;
  assert.equal(hookCandidates(changed)[0].memory_id,'rule');
  const restored=(await f.run(prompt,{turn_id:'fourth',transcript_path:transcript,hook_event_name:'PostCompact'})).hookSpecificOutput.additionalContext;
  assert.equal(hookCandidates(restored)[0].memory_id,'rule');
  assert.match(changed,/pending_host_selection/u);
  assert.match(restored,/pending_host_selection/u);

  await f.store.revise('default','rule',{summary:'Voice APIの切断時はtimeoutを確認する（release updated）',
    content:'For the next Voice API timeout change, verify the current release before applying the retry rule.'});
  const newer=(await f.run(prompt,{turn_id:'fifth',transcript_path:transcript})).hookSpecificOutput.additionalContext;
  assert.equal(hookCandidates(newer)[0].memory_id,'rule');
  assert.equal(hookCandidates(newer)[0].current_version,2,'a prior receipt cannot suppress a newer version');

  const db=f.store.open({readOnly:true});try{
    const rows=db.prepare("SELECT reference_type,used_state,injected_token_estimate FROM memory_usage_items WHERE source_id='rule'").all();
    assert.ok(rows.length>=1);
    assert.ok(rows.every(row=>row.reference_type==='returned'&&row.used_state==='unknown'&&row.injected_token_estimate===0));
    assert.equal(db.prepare("SELECT COUNT(*) n FROM memory_use_evaluations").get().n,0);
  }finally{db.close();}
});

test('ordinary decision previews keep rationale and reuse conditions while full details require a versioned read',async t=>{
  const f=await fixture(t);
  const content='Voice API requests must use a 2500 millisecond timeout; keep the retry count at zero for a non-idempotent operation.';
  const rationale='A disconnect does not establish whether the server completed the operation.';
  const reuse='Apply this only to non-idempotent Voice API requests; idempotent status reads have a separate retry policy.';
  await f.save('decision','Voice API timeout policy',{kind:'decision',content,rationale,reuse_rule:reuse,source_references:[{type:'file',ref:'docs/voice-timeout.md'}]});
  const output=(await f.run('Voice API timeout policy')).hookSpecificOutput.additionalContext;
  const selected=await readHookCandidate(f.store,output,'decision');
  assert.match(selected.candidate.preview,/Voice API timeout policy/u);
  assert.ok(selected.candidate.preview.includes(rationale));
  assert.ok(selected.candidate.preview.includes(reuse));
  assert.equal(selected.candidate.full_body_omitted,true);
  assert.ok(!output.includes(content));
  assert.doesNotMatch(output,/docs\/voice-timeout\.md/u);
  assert.equal(selected.memory.content,content);
  assert.equal(selected.memory.rationale,rationale);
  assert.equal(selected.memory.reuse_rule,reuse);
  assert.equal(selected.memory.source_references[0].ref,'docs/voice-timeout.md');
  assert.ok(Buffer.byteLength(output)<=7168);
});

test('long facts keep a complete limiting condition in the preview while requiring a full-detail read',async t=>{
  const f=await fixture(t);
  const limitingClause='Only use it after the staging schema version is verified.';
  const content=`Voice API migration policy. ${'This migration has a scoped compatibility check. '.repeat(8)}${limitingClause}`;
  await f.save('fact','Voice API migration policy',{content,reuse_rule:limitingClause});
  const output=(await f.run('Voice API migration policy')).hookSpecificOutput.additionalContext;
  const selected=await readHookCandidate(f.store,output,'fact');
  assert.equal(selected.candidate.full_body_omitted,true);
  assert.ok(selected.candidate.preview.includes(limitingClause));
  assert.ok(!output.includes(content));
  assert.equal(selected.memory.content,content);
  assert.equal(selected.memory.reuse_rule,limitingClause);
});

test('oversized full body stays out of the bounded preview while its receipt remains returned and unknown',async t=>{
  const f=await fixture(t);
  const fullBodyMarker='FULL_BODY_MARKER_0e88f1c7';
  const content=`Voice API timeout policy. ${fullBodyMarker} ${'This remains part of the stored full body. '.repeat(500)}`;
  await f.save('oversized','Voice API timeout policy',{kind:'decision',content,rationale:'The entire decision is required.'});
  const output=(await f.run('Voice API timeout policy')).hookSpecificOutput.additionalContext;
  const selected=await readHookCandidate(f.store,output,'oversized');
  assert.equal(selected.candidate.full_body_omitted,true);
  assert.match(selected.candidate.preview,/Voice API timeout policy/u);
  assert.match(selected.candidate.preview,/The entire decision is required/u);
  assert.ok(!output.includes(fullBodyMarker));
  assert.ok(selected.memory.content.startsWith(`Voice API timeout policy. ${fullBodyMarker}`));
  assertReturnedUnknown(f.store,'oversized');
  assert.ok(Buffer.byteLength(output)<=7168);
});

test('ordinary body and rationale receive the same redaction as lesson fields',async t=>{
  const f=await fixture(t);
  await f.save('private','Voice API timeout policy',{kind:'decision',content:'Voice API timeout: contact operator@example.com for the historical setting.',rationale:'The original test was run by reviewer@example.com.'});
  const output=(await f.run('Voice API timeout policy')).hookSpecificOutput.additionalContext;
  assert.doesNotMatch(output,/operator@example\.com|reviewer@example\.com/);
  assert.match(output,/\[REDACTED_EMAIL\]/);
  assert.match(output,/original test/);
});

test('pending hook previews remain unassessed in action bookkeeping',async t=>{
  const f=await fixture(t);
  await f.save('decision','Voice API timeout policy',{kind:'decision',
    content:'Voice API non-idempotent requests must not be retried after an unknown timeout.',
    rationale:'A timeout does not establish whether the request completed.',reuse_rule:'Only for non-idempotent Voice API requests.'});
  const text=(await f.run('Voice API timeout policy',{usage_purpose:'test'})).hookSpecificOutput.additionalContext;
  const candidate=hookCandidates(text).find(item=>item.memory_id==='decision');
  assert.ok(candidate,text);
  assert.equal(candidate.full_body_omitted,true);
  assert.match(candidate.preview,/Only for non-idempotent Voice API requests/u);
  assert.doesNotMatch(text,/Voice API non-idempotent requests must not be retried/u);
  const delivery={payload:{type:'message',role:'developer',content:[{type:'text',text}]}};
  const collected=await collectMemoryUse(f.store,{tenantId:'default',projectId:'p',taskId:'codex:quality-session',turnId:'turn',rows:[delivery]});
  assert.equal(collected.recorded,0);
  assert.equal(collected.queued,0);
  const report=await f.store.useHistory('report',{tenant_id:'default',project_id:'p'});
  assert.equal(report.by_purpose.test.action_observed,0);
  assert.equal(report.verified_positive_effects,0);
  assertReturnedUnknown(f.store,'decision');
});
