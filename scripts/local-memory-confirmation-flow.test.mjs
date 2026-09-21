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
import {memoryConfirmationQuestion} from '../packages/orgbrain-cli/src/lib/memory-confirmation-hints.mjs';
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

test('eager mode closes a context-enrichment miss with one verified secret-safe memory',async()=>{
  const root=await mkdtemp(join(tmpdir(),'local-eager-flow-'));
  try {
    const dbPath=join(root,'memory.sqlite'),workspaces=join(root,'workspaces.json'),envFile=join(root,'empty.env'),transcript=join(root,'turn.jsonl');
    await writeFile(envFile,'ORGBRAIN_LOCAL_HOOK_CAPTURE=true\n');
    await writeFile(workspaces,JSON.stringify({version:3,workspaces:{[root]:{tenant_id:'tenant',project_id:'project',default_work_type:'implementation',memory_learning_mode:'eager',memory_capture_v2_mode:'on'}}}));
    const secret=`sk-or-v1-${'x'.repeat(32)}`;
    const finalText=[
      '## Conclusion',
      'OpenRouter authentication is configured as the `OPENROUTER_API_KEY` environment variable for TypeSafe AI.',
      '## Reason',
      'The TypeSafe AI setup reads this named environment variable, so future installs can reuse the same binding without copying any credential value.',
      '## Reuse Rule',
      'When reinstalling or diagnosing TypeSafe AI, verify that `OPENROUTER_API_KEY` is present and non-empty, then run the health check without printing its value.'
    ].join('\n');
    const rows=[
      {type:'turn_context',payload:{turn_id:'turn-eager',cwd:root}},
      {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'TypeSafe AIをOpenRouterで使えるように設定してください。'}]}},
      {type:'response_item',payload:{type:'function_call',call_id:'context',name:'mcp__orgbrain__orgbrain_context_enrich',arguments:JSON.stringify({project_id:'project',query:'TypeSafe AI OpenRouter setup'})}},
      {type:'response_item',payload:{type:'function_call_output',call_id:'context',output:JSON.stringify({evidence_bundle:{evidence_status:'insufficient',evidence:[],abstention_recommended:true}})}},
      {type:'response_item',payload:{type:'function_call',call_id:'configure',name:'exec_command',arguments:JSON.stringify({cmd:`OPENROUTER_API_KEY=${secret} typesafe-ai configure`})}},
      {type:'response_item',payload:{type:'function_call_output',call_id:'configure',output:JSON.stringify({exit_code:0,status:'succeeded'})}},
      {type:'response_item',payload:{type:'function_call',call_id:'verify',name:'exec_command',arguments:JSON.stringify({cmd:'typesafe-ai doctor'})}},
      {type:'response_item',payload:{type:'function_call_output',call_id:'verify',output:JSON.stringify({exit_code:0,status:'succeeded'})}},
      {type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:finalText}]}}
    ];
    await writeFile(transcript,rows.map(x=>JSON.stringify(x)).join('\n')+'\n');
    const env={...getDefaultEnvironment(),ORGBRAIN_HOOK_ENV_FILES:envFile,ORGBRAIN_WORKSPACES_FILE:workspaces,ORGBRAIN_LOCAL_DB:dbPath,
      ORGBRAIN_ENABLE_CLOUD_MEMORY:'false',ORGBRAIN_ENABLE_ORG_SHARING:'false',ORGBRAIN_MEMORY_EXTRACTION_MODE:'off',ORGBRAIN_TENANT_ID:'tenant'};
    const output=JSON.parse(execFileSync(process.execPath,['--no-warnings',cli,'event','ingest','codex-stop'],{env,input:JSON.stringify({hook_event_name:'Stop',session_id:'session-eager',turn_id:'turn-eager',cwd:root,transcript_path:transcript,last_assistant_message:finalText}),encoding:'utf8'}));
    assert.equal(output.ok,true);
    assert.equal(output.created,1,JSON.stringify(output));
    assert.equal(output.capture_v2_shadow.latest_retrieval,'miss');
    assert.equal(output.capture_v2_shadow.successful_actions_after_miss,2);
    const stored=await memories(new LocalMemoryStore(dbPath),'tenant');
    assert.equal(stored.length,1);
    assert.match(stored[0].content,/OPENROUTER_API_KEY/u);
    assert.doesNotMatch(JSON.stringify(stored),new RegExp(secret,'u'));
    const found=await callLocalMcpTool(new LocalMemoryStore(dbPath),'orgbrain_memory_search',{tenant_id:'tenant',project_id:'project',query:'TypeSafe AI OpenRouter environment variable',limit:5});
    assert.ok(found.results.length>0,JSON.stringify(found));
  } finally {await rm(root,{recursive:true,force:true});}
});

test('eager mode saves nothing without a retrieval miss or a safe durable candidate',async()=>{
  const root=await mkdtemp(join(tmpdir(),'local-eager-negative-'));
  try {
    const dbPath=join(root,'memory.sqlite'),workspaces=join(root,'workspaces.json'),envFile=join(root,'empty.env'),transcript=join(root,'turn.jsonl');
    await writeFile(envFile,'ORGBRAIN_LOCAL_HOOK_CAPTURE=true\n');
    await writeFile(workspaces,JSON.stringify({version:3,workspaces:{[root]:{tenant_id:'tenant',project_id:'project',memory_learning_mode:'eager',memory_capture_v2_mode:'on'}}}));
    const env={...getDefaultEnvironment(),ORGBRAIN_HOOK_ENV_FILES:envFile,ORGBRAIN_WORKSPACES_FILE:workspaces,ORGBRAIN_LOCAL_DB:dbPath,
      ORGBRAIN_ENABLE_CLOUD_MEMORY:'false',ORGBRAIN_ENABLE_ORG_SHARING:'false',ORGBRAIN_MEMORY_EXTRACTION_MODE:'off',ORGBRAIN_TENANT_ID:'tenant'};
    const durable='OpenRouter authentication is configured as `OPENROUTER_API_KEY` because the installer reads that binding.\nWhen reinstalling TypeSafe AI, verify the variable is present without printing the value.';
    let rows=[{type:'turn_context',payload:{turn_id:'no-miss'}},{type:'response_item',payload:{type:'function_call',call_id:'work',name:'exec_command',arguments:'{}'}},{type:'response_item',payload:{type:'function_call_output',call_id:'work',output:JSON.stringify({exit_code:0})}},{type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:durable}]}}];
    let file=join(root,'no-miss.jsonl');await writeFile(file,rows.map(x=>JSON.stringify(x)).join('\n')+'\n');
    let output=JSON.parse(execFileSync(process.execPath,['--no-warnings',cli,'event','ingest','codex-stop'],{env,input:JSON.stringify({hook_event_name:'Stop',session_id:'s',turn_id:'no-miss',cwd:root,transcript_path:file,last_assistant_message:durable}),encoding:'utf8'}));
    assert.equal(output.skipped,'eager-no-retrieval-miss',JSON.stringify(output));
    rows=[{type:'turn_context',payload:{turn_id:'no-candidate'}},{type:'response_item',payload:{type:'function_call',call_id:'ctx',name:'orgbrain_context_enrich',arguments:JSON.stringify({project_id:'project'})}},{type:'response_item',payload:{type:'function_call_output',call_id:'ctx',output:JSON.stringify({evidence_bundle:{evidence_status:'insufficient',abstention_recommended:true}})}},{type:'response_item',payload:{type:'function_call',call_id:'work2',name:'exec_command',arguments:JSON.stringify({cmd:'typesafe-ai doctor'})}},{type:'response_item',payload:{type:'function_call_output',call_id:'work2',output:JSON.stringify({exit_code:0})}},{type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'完了しました。'}]}}];
    file=join(root,'no-candidate.jsonl');await writeFile(file,rows.map(x=>JSON.stringify(x)).join('\n')+'\n');
    output=JSON.parse(execFileSync(process.execPath,['--no-warnings',cli,'event','ingest','codex-stop'],{env,input:JSON.stringify({hook_event_name:'Stop',session_id:'s',turn_id:'no-candidate',cwd:root,transcript_path:file,last_assistant_message:'完了しました。'}),encoding:'utf8'}));
    assert.equal(output.skipped,'eager-no-safe-durable-candidate');
    assert.equal((await memories(new LocalMemoryStore(dbPath),'tenant')).length,0);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('local Stop → prompt → question → approval → durable MCP receipt → search, with no network',async()=>{
  const root=await mkdtemp(join(tmpdir(),'local-confirm-flow-'));
  let connection;
  try {
    const dbPath=join(root,'memory.sqlite'),workspaces=join(root,'workspaces.json'),envFile=join(root,'empty.env'),transcript=join(root,'turn.jsonl');
    await writeFile(envFile,'ORGBRAIN_LOCAL_HOOK_CAPTURE=true\n');
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
    const stopOutput=hook('codex-stop',{turn_id:'turn-review',transcript_path:transcript,last_assistant_message:'認証APIはOAuthを使う方針です。'});
    assert.equal(stopOutput.decision,'block');
    assert.match(stopOutput.reason,/保存確認待ち/);
    assert.match(stopOutput.reason,/通常のassistant本文/);
    assert.match(stopOutput.reason,/OAuth/);
    assert.match(stopOutput.reason,/どのカテゴリとして保存しますか/);
    assert.match(stopOutput.reason,/番号だけでも回答できます/);
    assert.match(stopOutput.reason,/1\. 決定事項と根拠として/);
    assert.match(stopOutput.reason,/4\. 保存しない/);
    assert.match(stopOutput.reason,/5\. 後で判断するので一時保存/);
    assert.doesNotMatch(stopOutput.reason,/表示した内容を/u);
    assert.doesNotMatch(stopOutput.reason,/questions=\[/);
    assert.doesNotMatch(stopOutput.reason,/利用できる質問ツール/);
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
    assert.match(context,/1=decision, 2=success, 3=failure, 4=not_needed, 5=not_decided/);
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
    const listedTools=await connection.client.listTools();
    const confirmationTool=listedTools.tools.find((tool)=>tool.name==='orgbrain_memories_confirm');
    assert.equal(confirmationTool.title,'OrgBrain');
    assert.equal(confirmationTool._meta?.['openai/toolInvocation/invoking'],'OrgBrainを使用しています…');
    assert.equal(confirmationTool._meta?.['openai/toolInvocation/invoked'],'OrgBrainを使用しました');
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
    const actualAnswer='1';
    hook('codex-post-tool',{tool_name:'functions.request_user_input_async',tool_input:questionInput,tool_result:{answers:[actualAnswer]}});
    await connection.close();connection=await connect();
    const confirmInput={tenant_id:'tenant',confirmation_token:proposal.confirmation_token,approved:true,review_label:'accepted',review_answer:actualAnswer};
    const saved=await invoke('orgbrain_memories_confirm',confirmInput);
    assert.equal(saved.saved,true);
    assert.equal(saved.memory_category,'decision');
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
    assert.ok(result.results[0].memory.tags.includes('memory-category:decision'));
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
    for(const [id,answer,label] of [['decline','今回は保存しない','not_needed'],['later','後で判断するので一時保存','not_decided']]) {
      const proposed=await propose(id);
      const receipt=await callLocalMcpTool(store,'orgbrain_memories_confirm',{tenant_id:'t',confirmation_token:proposed.confirmation_token,approved:false,review_answer:answer,review_label:label});
      assert.equal(receipt.saved,false);
      assert.equal((await callLocalMcpTool(store,'orgbrain_memories_confirmation_status',{tenant_id:'t',confirmation_token:proposed.confirmation_token})).review_label,label);
    }
    assert.equal((await memories(store,'t')).length,1);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('plain-text numeric answer resolves offered confirmations without a question tool',async()=>{
  const root=await mkdtemp(join(tmpdir(),'local-plain-decline-'));
  try {
    const queue=new TaskCommitmentStore(join(root,'memory.sqlite'));
    await queue.queueMemoryConfirmations({tenantId:'tenant',projectId:'project',taskKey:'codex:session',candidates:[{
      candidate_hash:'b'.repeat(64),category:'decision',conclusion:'テスト候補',reason:'テスト',reuse_rule:'テスト時',source_references:[]
    }]});
    await queue.takeMemoryConfirmationBatch({tenantId:'tenant',projectId:'project',taskKey:'codex:session',deliverySessionKey:'codex:session'});
    const resolved=await queue.resolveMemoryConfirmationsFromPrompt({tenantId:'tenant',projectId:'project',taskKey:'codex:session',prompt:'4'});
    assert.equal(resolved.length,1);
    assert.equal(resolved[0].label,'not_needed');
    const status=await queue.memoryReviewStatus({tenantId:'tenant',projectId:'project'});
    assert.equal(status.states[0].state,'rejected');
    assert.equal(status.states[0].save_state,'not_requested');
  } finally {await rm(root,{recursive:true,force:true});}
});

test('local PostToolUse plan answers queue a broad decision-memory confirmation',async()=>{
  const root=await mkdtemp(join(tmpdir(),'local-plan-confirmation-'));
  try {
    const dbPath=join(root,'memory.sqlite'),workspaces=join(root,'workspaces.json'),envFile=join(root,'empty.env');
    await writeFile(envFile,'ORGBRAIN_LOCAL_HOOK_CAPTURE=true\n');
    await writeFile(workspaces,JSON.stringify({version:3,workspaces:{[root]:{tenant_id:'tenant',project_id:'project',default_work_type:'implementation',memory_learning_mode:'confirm',memory_capture_v2_mode:'on'}}}));
    const env={...getDefaultEnvironment(),ORGBRAIN_HOOK_ENV_FILES:envFile,ORGBRAIN_WORKSPACES_FILE:workspaces,ORGBRAIN_LOCAL_DB:dbPath,
      ORGBRAIN_ENABLE_CLOUD_MEMORY:'false',ORGBRAIN_ENABLE_ORG_SHARING:'false',ORGBRAIN_MEMORY_EXTRACTION_MODE:'off',ORGBRAIN_USE_SYNC:'off',ORGBRAIN_USE_COLLECT:'off',ORGBRAIN_USE_CONTEXT:'off',ORGBRAIN_USE_RANKING:'off',ORGBRAIN_TENANT_ID:'tenant'};
    const hook=JSON.parse(execFileSync(process.execPath,['--no-warnings',cli,'hook','codex-post-tool'],{env,input:JSON.stringify({
      hook_event_name:'PostToolUse',session_id:'plan-session',turn_id:'plan-turn',cwd:root,
      tool_name:'request_user_input',
      tool_input:{questions:[{id:'agent_rollout',question:'どのAgentから認証しますか？',options:[
        {label:'Codex先行',description:'Codexで先に進めます。'},
        {label:'Claude先行',description:'Claudeで先に進めます。'}
      ]}]},
      tool_result:{answers:{agent_rollout:'Codex先行'}}
    }),encoding:'utf8'}));
    assert.equal(hook.ok,true);
    assert.equal(hook.commitments.length,1);
    assert.equal(hook.memory_confirmation_queue.length,1);
    assert.equal(hook.memory_confirmation_queue[0].created,true);
    const queue=new TaskCommitmentStore(dbPath);
    const [candidate]=await queue.takeMemoryConfirmationBatch({tenantId:'tenant',projectId:'project',taskKey:'codex:plan-session',deliverySessionKey:'codex:plan-session'});
    assert.ok(candidate);
    assert.equal(candidate.confirmation_prompt,'plan_answer');
    assert.equal(candidate.conclusion,'質問: どのAgentから認証しますか? 回答: Codex先行');
    assert.equal(candidate.source_question,'どのAgentから認証しますか?');
    assert.match(memoryConfirmationQuestion(candidate).question,/結論:\n質問: どのAgentから認証しますか\? 回答: Codex先行/u);
    assert.match(memoryConfirmationQuestion(candidate).question,/どのカテゴリとして保存しますか？/u);
    assert.equal((await memories(new LocalMemoryStore(dbPath),'tenant')).length,0);
  } finally {await rm(root,{recursive:true,force:true});}
});
