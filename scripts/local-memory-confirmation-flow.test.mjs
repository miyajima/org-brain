import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport,getDefaultEnvironment} from '@modelcontextprotocol/client/stdio';
import {LocalMemoryStore} from '../packages/orgbrain-cli/src/lib/local-memory-store.mjs';
import {TaskCommitmentStore} from '../packages/orgbrain-cli/src/lib/task-commitment-store.mjs';
import {handleLocalMcpRequest} from '../packages/orgbrain-cli/src/local-mcp.mjs';

async function callLocalMcpTool(store,name,input) {
  const response=await handleLocalMcpRequest(store,{method:'tools/call',params:{name,arguments:input}});
  const payload=JSON.parse(response.content[0].text);
  if(response.isError) throw new Error(payload.error);
  return payload;
}

async function memories(store,tenant) {
  await store.init();const db=store.open({readOnly:true});
  try{return db.prepare('SELECT * FROM memories WHERE tenant_id=?').all(tenant);}finally{db.close();}
}

const cli=process.env.ORGBRAIN_TEST_CLI||resolve('packages/orgbrain-cli/src/local-memory.mjs');

test('local Stop → prompt → question → approval → durable MCP receipt → search, with no network',async()=>{
  const root=await mkdtemp(join(tmpdir(),'local-confirm-flow-'));
  let connection;
  try {
    const dbPath=join(root,'memory.sqlite'),workspaces=join(root,'workspaces.json'),envFile=join(root,'empty.env'),transcript=join(root,'turn.jsonl');
    await writeFile(envFile,'');
    await writeFile(workspaces,JSON.stringify({version:3,workspaces:{[root]:{tenant_id:'tenant',project_id:'project',default_work_type:'implementation',memory_learning_mode:'confirm',memory_capture_v2_mode:'on'}}}));
    const networkMarker=join(root,'network-called');
    const guard=join(root,'no-network.mjs');
    await writeFile(guard,`import {writeFileSync} from 'node:fs';globalThis.fetch=()=>{writeFileSync(${JSON.stringify(networkMarker)},'called');throw new Error('network forbidden');};`);
    const env={...getDefaultEnvironment(),ORGBRAIN_HOOK_ENV_FILES:envFile,ORGBRAIN_WORKSPACES_FILE:workspaces,ORGBRAIN_LOCAL_DB:dbPath,
      ORGBRAIN_ENABLE_CLOUD_MEMORY:'false',ORGBRAIN_ENABLE_ORG_SHARING:'false',ORGBRAIN_MEMORY_EXTRACTION_MODE:'off',ORGBRAIN_USE_SYNC:'off',ORGBRAIN_USE_COLLECT:'off',ORGBRAIN_USE_CONTEXT:'off',ORGBRAIN_USE_RANKING:'off',ORGBRAIN_TENANT_ID:'tenant'};
    const scope={session_id:'session',cwd:root,project_id:'project'};
    const hook=(name,payload)=>JSON.parse(execFileSync(process.execPath,['--no-warnings','--import',guard,cli,'hook',name],{env,input:JSON.stringify({...scope,...payload}),encoding:'utf8'}));
    const rows=[
      {type:'turn_context',payload:{turn_id:'turn-review',cwd:root}},
      {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'今後、このプロジェクトの認証APIはOAuthを必ず使う方針に決定します。'}]}},
      {type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'認証APIはOAuthを使う方針です。'}]}}
    ];
    await writeFile(transcript,rows.map(x=>JSON.stringify(x)).join('\n')+'\n');
    assert.deepEqual(hook('codex-stop',{turn_id:'turn-review',transcript_path:transcript,last_assistant_message:'認証APIはOAuthを使う方針です。'}),{});
    const store=new LocalMemoryStore(dbPath);
    assert.equal((await memories(store,'tenant')).length,0);
    const queue=new TaskCommitmentStore(dbPath);
    const [candidate]=await queue.takeMemoryConfirmationBatch({tenantId:'tenant',projectId:'project',taskKey:'codex:session',deliverySessionKey:'codex:session'});
    assert.ok(candidate);
    const prompt={hook_event_name:'UserPromptSubmit',prompt:'この認証方針に沿って次の実装を進めてください。'};
    const context=hook('codex-context',prompt).hookSpecificOutput.additionalContext;
    assert.match(context,/configured LOCAL OrgBrain MCP/);
    assert.doesNotMatch(context,/Require Remote tool schemas/);
    assert.match(context,/orgbrain_memory_observe/);
    const questions=JSON.parse(context.match(/^questions=(.+)$/mu)[1]);
    const payloads=JSON.parse(context.match(/^candidate_payloads=(.+)$/mu)[1]);
    assert.equal(payloads[0].work_type,'implementation');
    const review_context={candidate_id:candidate.id,candidate_hash:candidate.candidate_hash,source_references:candidate.source_references,
      conclusion:candidate.conclusion,reason_summary:candidate.reason,reuse_rule:candidate.reuse_rule};
    const proposalInput={tenant_id:'tenant',source:'codex',item:{content:candidate.conclusion,project_id:'project',work_type:'implementation',external_key:candidate.external_key},review_context};
    const connect=async()=>{
      const transport=new StdioClientTransport({command:process.execPath,args:['--no-warnings','--import',guard,cli,'mcp'],env,stderr:'pipe'});
      const client=new Client({name:'local-confirmation-flow-test',version:'1.0.0'},{versionNegotiation:{mode:{pin:'2026-07-28'},probe:{timeoutMs:2000}}});
      await client.connect(transport);
      return {client,close:async()=>{await client.close();await transport.close();}};
    };
    connection=await connect();
    const invoke=async(name,args)=>{
      const result=await connection.client.callTool({name,arguments:args});
      assert.notEqual(result.isError,true,JSON.stringify(result));return JSON.parse(result.content[0].text);
    };
    const proposal=await invoke('orgbrain_memories_propose',proposalInput);
    hook('codex-post-tool',{tool_name:'mcp__orgbrain__orgbrain_memories_propose',tool_input:proposalInput,tool_result:proposal});
    assert.equal((await invoke('orgbrain_memories_confirmation_status',{tenant_id:'tenant',confirmation_token:proposal.confirmation_token})).status,'pending');
    const questionInput={questions:questions.map(q=>({title:q.question,options:q.options.map(o=>o.label)}))};
    hook('codex-post-tool',{tool_name:'functions.request_user_input_async',tool_input:questionInput,tool_result:{ok:true}});
    assert.equal((await memories(store,'tenant')).length,0,'async ACK cannot save');
    const actualAnswer='保存する (Recommended)';
    hook('codex-post-tool',{tool_name:'functions.request_user_input_async',tool_input:questionInput,tool_result:{answers:[actualAnswer]}});
    await connection.close();connection=await connect();
    const confirmInput={tenant_id:'tenant',confirmation_token:proposal.confirmation_token,approved:true,review_label:'accepted',review_answer:actualAnswer};
    const saved=await invoke('orgbrain_memories_confirm',confirmInput);
    assert.equal(saved.saved,true);
    hook('codex-post-tool',{tool_name:'mcp__orgbrain__orgbrain_memories_confirm',tool_input:confirmInput,tool_result:saved});
    await connection.close();connection=await connect();
    assert.deepEqual(await invoke('orgbrain_memories_confirm',confirmInput),saved);
    const status=await invoke('orgbrain_memories_confirmation_status',{tenant_id:'tenant',confirmation_token:proposal.confirmation_token});
    assert.equal(status.status,'completed');assert.equal(status.memory_id,saved.memory_id);
    assert.equal((await memories(store,'tenant')).length,1);
    const result=await invoke('orgbrain_memory_search',{tenant_id:'tenant',project_id:'project',query:'認証APIはOAuthを必ず使う方針',limit:5});
    assert.ok(result.results.length,JSON.stringify({result,memories:await memories(store,'tenant')}));
    assert.equal(result.results[0].memory.id,saved.memory_id);
    assert.match(result.results[0].memory.content,/理由: 未確認/);
    assert.ok(result.results[0].memory.source_references.length>0);
    assert.equal(result.results[0].memory.reuse_rule,candidate.reuse_rule);
    assert.doesNotMatch(hook('codex-context',prompt).hookSpecificOutput.additionalContext,/OrgBrain memory confirmation/);
    const report=await queue.memoryReviewStatus({tenantId:'tenant',projectId:'project'});
    assert.ok(report.states.some(s=>s.save_state==='saved'));
    await assert.rejects(readFile(networkMarker),{code:'ENOENT'});
  } finally {await connection?.close().catch(()=>{});await rm(root,{recursive:true,force:true});}
});

test('local review rejects ambiguous approvals, preserves corrections, and never writes for declines',async()=>{
  const root=await mkdtemp(join(tmpdir(),'local-confirm-decisions-'));
  try {
    const store=new LocalMemoryStore(join(root,'memory.sqlite'));
    const propose=async(id)=>callLocalMcpTool(store,'orgbrain_memories_propose',{tenant_id:'t',item:{content:'接続切断時は処理結果を照合する。',project_id:'p'},review_context:{candidate_id:id,candidate_hash:'a'.repeat(64),source_references:[],conclusion:'接続切断時は処理結果を照合する。',reason_summary:'二重実行を避けるため。',reuse_rule:'通信結果が不明なとき。'}});
    const p=await propose('candidate');
    await assert.rejects(callLocalMcpTool(store,'orgbrain_memories_confirmation_status',{tenant_id:'other',confirmation_token:p.confirmation_token}),/confirmation_not_found/);
    const base={tenant_id:'t',confirmation_token:p.confirmation_token,approved:true};
    for(const input of [base,{...base,review_answer:'はい'},{...base,review_answer:'保存しない',review_label:'accepted'},
      {...base,review_answer:'保存する',corrected_content:'変更した内容'}]) await assert.rejects(callLocalMcpTool(store,'orgbrain_memories_confirm',input));
    assert.equal((await memories(store,'t')).length,0);
    const request={...base,review_answer:'修正: 再送前に処理IDを照合する。',review_label:'corrected',corrected_content:'再送前に処理IDを照合する。',corrected_summary:'処理IDを照合する'};
    const saved=await callLocalMcpTool(store,'orgbrain_memories_confirm',request);
    assert.equal(saved.confirmation_state,'user_corrected');
    assert.deepEqual(await callLocalMcpTool(new LocalMemoryStore(store.dbPath),'orgbrain_memories_confirm',request),saved);
    await assert.rejects(callLocalMcpTool(store,'orgbrain_memories_confirm',{...request,corrected_content:'別の内容'}),/confirmation_answer_changed/);
    for(const [id,answer,label] of [['decline','今回は保存しない','not_needed'],['later','まだ決定していない','not_decided']]) {
      const proposed=await propose(id);
      const receipt=await callLocalMcpTool(store,'orgbrain_memories_confirm',{tenant_id:'t',confirmation_token:proposed.confirmation_token,approved:false,review_answer:answer,review_label:label});
      assert.equal(receipt.saved,false);
      assert.equal((await callLocalMcpTool(store,'orgbrain_memories_confirmation_status',{tenant_id:'t',confirmation_token:proposed.confirmation_token})).review_label,label);
    }
    assert.equal((await memories(store,'t')).length,1);
  } finally {await rm(root,{recursive:true,force:true});}
});
