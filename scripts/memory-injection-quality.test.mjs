import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalMemoryStore } from '../packages/orgbrain-cli/src/lib/local-memory-store.mjs';
import { buildCodexMemoryContext } from '../packages/orgbrain-cli/src/codex-memory-context.mjs';

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
test('status memories do not occupy the automatic context but remain available to explicit history questions',async t=>{
  const f=await fixture(t);
  await f.save('status','Voice | command-result | 11件をコミット済み: abc123',{content:'Voice API の設定とテスト11件をコミットしました。'});
  await f.save('rule','Voice APIの切断はtimeoutを確認する',{reuse_rule:'Voice APIの切断が発生した場合',content:'Voice APIの切断が発生した場合はtimeoutとサーバー終了ログを照合する。'});
  const normal=(await f.run('Voice APIが切断する原因を調べて')).hookSpecificOutput.additionalContext;
  assert.doesNotMatch(normal,/11件をコミット済み/);
  assert.match(normal,/timeout/);
  const history=(await f.run('Voice APIで前回コミットした内容と作業の完了状況を教えて',{turn_id:'history-turn'})).hookSpecificOutput.additionalContext;
  assert.match(history,/11件をコミット済み/);
  const db=f.store.open({readOnly:true});try {
    assert.equal(db.prepare("SELECT lifecycle_state FROM memories WHERE id='status'").get().lifecycle_state,'active');
    assert.ok(db.prepare("SELECT injected_token_estimate FROM memory_usage_items WHERE source_id='rule'").get().injected_token_estimate>0);
  }finally{db.close();}
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
  const db=f.store.open({readOnly:true});try{assert.equal(db.prepare("SELECT count(*) n FROM memory_usage_items WHERE reference_type='injected'").get().n,1);}finally{db.close();}
});
test('unchanged delivered context is not repeated, while changed questions and post-compaction restore it',async t=>{
  const f=await fixture(t);await f.save('rule','Voice APIの切断時はtimeoutを確認する');
  const prompt='Voice APIの切断原因を調べて';
  const first=(await f.run(prompt)).hookSpecificOutput.additionalContext;
  const transcript=join(f.root,'transcript.jsonl');
  await writeFile(transcript,[{type:'turn_context',payload:{turn_id:'turn'}},
    {payload:{type:'message',role:'developer',content:[{type:'text',text:first}]}}].map(JSON.stringify).join('\n'));
  const repeat=(await f.run(prompt,{turn_id:'second',transcript_path:transcript})).hookSpecificOutput.additionalContext;
  assert.doesNotMatch(repeat,/summary:/);
  assert.match((await f.run('Voice APIのtimeout設定を変更したい',{turn_id:'third',transcript_path:transcript})).hookSpecificOutput.additionalContext,/summary:/);
  assert.match((await f.run(prompt,{turn_id:'fourth',transcript_path:transcript,hook_event_name:'PostCompact'})).hookSpecificOutput.additionalContext,/summary:/);
});
