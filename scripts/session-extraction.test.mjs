import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {verifiedCandidates} from '../packages/shared/src/memory-extraction-verifier-runtime.mjs';
const snippets=[{span_id:'a',role:'assistant',source:'assistant',text:'Use the cache.'},{span_id:'r',role:'assistant',source:'assistant',text:'The reason is reduced duplicate work.'},{span_id:'c',role:'assistant',source:'assistant',text:'Except in production.'},{span_id:'v',role:'assistant',source:'assistant',text:'27 tests passed; production remains unverified.'}];
const packet={schema:'learning-extraction-proposal/v2',snippets,events:[]};
test('ordinary extraction rejects empty success and decision, even with support',async()=>{
 for(const lesson_type of ['success','decision']){
 const r=await verifiedCandidates({packet,run_id:'empty',project_id:'org-brain'},[{lesson_type,support_span_ids:['a'],fields:[],gaps:[]}]);
 assert.equal(r.candidates.length,0);assert.ok(r.rejections[0].reason_codes.includes('candidate_content_missing'));
 }
});
test('reported verification survives normalized body while remaining unverified',async()=>{
 const r=await verifiedCandidates({packet,run_id:'report',project_id:'org-brain'},[{lesson_type:'success',support_span_ids:['a','r','c','v'],fields:[{name:'procedure',values:[snippets[0].text]},{name:'why_it_worked',values:[snippets[1].text]},{name:'reuse_when',values:[snippets[2].text]},{name:'reported_verification',values:[snippets[3].text]}],gaps:['observed_outcome_missing']}]);
 assert.equal(r.candidates.length,1,JSON.stringify(r.rejections));assert.deepEqual(r.candidates[0].observation.reported_verification,{state:'unverified',text:snippets[3].text});
 assert.equal(r.candidates[0].observation.observed_outcome,null);
});
test('common client adapters preserve user, final and report; exclude thinking and other sessions',async()=>{
 const {loadClientTurnRows}=await import('../packages/orgbrain-cli/src/lib/session-extraction.mjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'client-evidence-'));const file=path.join(dir,'claude.jsonl');
 await fs.writeFile(file,[{type:'user',sessionId:'s',message:{role:'user',content:'Fix cache.'}},{type:'assistant',sessionId:'s',message:{role:'assistant',content:[{type:'thinking',thinking:'PRIVATE'},{type:'text',text:snippets.map(s=>s.text).join('\n')}],stop_reason:'end_turn'}},{type:'assistant',sessionId:'other',message:{role:'assistant',content:'Other project',stop_reason:'end_turn'}}].map(JSON.stringify).join('\n'));
 const rows=await loadClientTurnRows({client:'claude',transcript_path:file,session_id:'s',workspace:dir});
 assert.equal(JSON.stringify(rows).includes('PRIVATE'),false);assert.equal(JSON.stringify(rows).includes('Other project'),false);assert.ok(JSON.stringify(rows).includes('production remains unverified'));
 const cursor=path.join(dir,'cursor.jsonl');await fs.writeFile(cursor,[{role:'user',message:{content:[{type:'text',text:'Fix cache.'}]}},{role:'assistant',message:{content:[{type:'text',text:'27 tests passed.'}]}}].map(JSON.stringify).join('\n'));
 const cr=await loadClientTurnRows({client:'cursor',transcript_path:cursor,session_id:'c',workspace:dir,completed:true});assert.ok(JSON.stringify(cr).includes('27 tests passed.'));
 await fs.rm(dir,{recursive:true,force:true});
});
test('common worker has no CLI dependency, pins Haiku/medium and reads persisted body back',async()=>{
 const {enqueueSessionExtraction,drainSessionExtraction}=await import('../packages/orgbrain-cli/src/lib/session-extraction.mjs');
 const {LocalMemoryStore}=await import('../packages/orgbrain-cli/src/lib/local-memory-store.mjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'session-worker-'));const dbPath=path.join(dir,'memory.sqlite');const queueDir=path.join(dir,'queue');
 const rows=[{type:'turn_context',payload:{turn_id:'t',cwd:dir}},{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'今後は配布前に互換確認を必須手順として実行してください。The reason is reduced duplicate work. Except in production. 27 tests passed; production remains unverified.'}]}},{type:'response_item',payload:{type:'message',role:'assistant',phase:'final',content:[{type:'output_text',text:'今後は配布前に互換確認を必須手順として実行してください。The reason is reduced duplicate work. Except in production. 27 tests passed; production remains unverified.'}]}}];
 const env={ORGBRAIN_SESSION_EXTRACTION_PROJECTS:'org-brain',OPENROUTER_API_KEY:'test'};
 const queued=await enqueueSessionExtraction({rows,client:'cursor',projectId:'org-brain',tenantId:'default',workspace:dir,queueDir,env});assert.ok(queued.queued>0,JSON.stringify(queued));
 let calls=0;
 const fetchImpl=async(url,opts)=>{calls++;const body=JSON.parse(opts.body);assert.equal(body.model,'anthropic/claude-haiku-5.5');assert.equal(body.reasoning.effort,'medium');assert.equal(body.temperature,undefined);const prompt=body.messages[0].content;const table=JSON.parse(prompt.slice(prompt.indexOf('\n')+1));const ids=table.s.map((s,i)=>i);return new Response(JSON.stringify({model:body.model,provider:'Google',choices:[{finish_reason:'stop',message:{content:JSON.stringify({candidates:[{lesson_type:'success',fields:[{name:'procedure',refs:ids}]}]})}}],usage:{prompt_tokens:100,completion_tokens:50,cost:0.001}}));};
 const r=await drainSessionExtraction({queueDir,dbPath,projectId:'org-brain',tenantId:'default',env,fetchImpl});assert.ok(r.saved>0);assert.equal(calls,queued.queued);
 const {TaskCommitmentStore}=await import('../packages/orgbrain-cli/src/lib/task-commitment-store.mjs');const store=new TaskCommitmentStore(dbPath);await store.init();const db=store.open();const saved=db.prepare('SELECT status,payload_json FROM memory_learning_candidates').all();db.close();assert.ok(saved.length>0);assert.ok(saved.every(s=>s.status==='quarantine'));assert.ok(saved.some(s=>s.payload_json.includes('production remains unverified')));
 const second=await drainSessionExtraction({queueDir,dbPath,projectId:'org-brain',tenantId:'default',env,fetchImpl});assert.equal(second.processed,0);assert.equal(calls,queued.queued);
 await fs.rm(dir,{recursive:true,force:true});
});
test('atomic reason/exception/result input is retained whole or held, never prefix clipped',async()=>{
 const {prepareSessionExtraction}=await import('../packages/orgbrain-cli/src/lib/session-extraction.mjs');
 const text='今後は配布前に互換確認を必須手順として実行してください。理由は互換性の維持のためです。ただし本番では実行しない。検証結果は27件成功、2件未検証。';
 const make=t=>[{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:t}]}}];
 const p=await prepareSessionExtraction({rows:make(text),client:'claude',workspace:'/tmp',projectId:'org-brain'});
 const sent=p.packets.flatMap(p=>p.snippets.map(s=>s.text)).join('');assert.equal(sent,text);assert.equal(p.held.length,0);
 const huge=await prepareSessionExtraction({rows:make(text.repeat(100)),client:'claude',workspace:'/tmp',projectId:'org-brain'});assert.ok(huge.held.length>0);assert.ok(huge.packets.flatMap(p=>p.snippets).every(s=>!s.text.endsWith('…')));
});
test('failed provider attempt stays held and is never resent; review bodies cannot be automatically promoted',async()=>{
 const {enqueueSessionExtraction,drainSessionExtraction,inspectSessionExtraction}=await import('../packages/orgbrain-cli/src/lib/session-extraction.mjs');
 const {TaskCommitmentStore}=await import('../packages/orgbrain-cli/src/lib/task-commitment-store.mjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'session-held-'));const queueDir=path.join(dir,'q'),dbPath=path.join(dir,'m.sqlite');
 const env={ORGBRAIN_SESSION_EXTRACTION_PROJECTS:'org-brain',OPENROUTER_API_KEY:'test'};
 const rows=[{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'今後は配布前に互換確認を必須手順として実行してください。'}]}}];
 await enqueueSessionExtraction({rows,client:'claude',projectId:'org-brain',workspace:dir,queueDir,env});let calls=0;
 const fetchImpl=async()=>{calls++;throw Error('timeout');};await drainSessionExtraction({queueDir,dbPath,projectId:'org-brain',env,fetchImpl});await drainSessionExtraction({queueDir,dbPath,projectId:'org-brain',env,fetchImpl});assert.equal(calls,1);assert.equal((await inspectSessionExtraction({queueDir,projectId:'org-brain'}))[0].status,'held');
 const store=new TaskCommitmentStore(dbPath);await store.saveLearningCandidates({projectId:'org-brain',candidates:[{external_key:'review-test',automatic_promotion:false,observation:{procedure:'Exact report.'}}]});let evaluated=0;await store.maintainLearningCandidates({evaluate:async()=>{evaluated++;return {route:'active',verified:true,consensus_pass:true};}});assert.equal(evaluated,0);
 await fs.rm(dir,{recursive:true,force:true});
});
test('Claude tool result retains same call identity and excludes subagent output',async()=>{
 const {loadClientTurnRows}=await import('../packages/orgbrain-cli/src/lib/session-extraction.mjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'claude-tools-'));const transcript=path.join(dir,'t.jsonl');
 const rows=[{type:'user',message:{role:'user',content:'Run tests.'}},{type:'assistant',message:{role:'assistant',content:[{type:'tool_use',id:'c',name:'Bash',input:{command:'npm test'}},{type:'tool_use',id:'child',name:'Agent',input:{prompt:'PRIVATE'}}]}},{type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:'c',content:'exit_code=0; 27 tests passed'},{type:'tool_result',tool_use_id:'child',content:'PRIVATE CHILD HISTORY'}]}},{type:'assistant',message:{role:'assistant',content:'Tests passed.',stop_reason:'end_turn'}}];
 await fs.writeFile(transcript,rows.map(JSON.stringify).join('\n'));const normalized=await loadClientTurnRows({client:'claude',transcript_path:transcript,workspace:dir});assert.ok(JSON.stringify(normalized).includes('exit_code=0'));assert.equal(JSON.stringify(normalized).includes('PRIVATE'),false);await fs.rm(dir,{recursive:true,force:true});
});
test('Claude and Cursor Stop enqueue in the normal CLI with no Codex executable',async()=>{
 const {spawnSync}=await import('node:child_process');const {inspectSessionExtraction}=await import('../packages/orgbrain-cli/src/lib/session-extraction.mjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cross-client-hook-'));const queueDir=path.join(dir,'q');const dbPath=path.join(dir,'m.sqlite');const map=path.join(dir,'workspaces.json'),envfile=path.join(dir,'hooks.env');
 await fs.writeFile(map,JSON.stringify({version:3,workspaces:{[dir]:{project_id:'org-brain',tenant_id:'default',memory_learning_mode:'eager'}}}));
 await fs.writeFile(envfile,`ORGBRAIN_ENABLE_CLOUD_MEMORY=false\nORGBRAIN_LOCAL_HOOK_CAPTURE=true\nORGBRAIN_SESSION_EXTRACTION_MODE=on\nORGBRAIN_SESSION_EXTRACTION_PROJECTS=org-brain\n`,{mode:0o600});
 const env={PATH:'',HOME:dir,ORGBRAIN_LOCAL_DB:dbPath,ORGBRAIN_WORKSPACES_FILE:map,ORGBRAIN_HOOK_ENV_FILES:envfile,ORGBRAIN_SESSION_EXTRACTION_QUEUE:queueDir};
 for(const client of ['claude','cursor']){
 const file=path.join(dir,client+'.jsonl');const content='今後は配布前に互換確認を必須手順として実行してください。';
 const rows=client==='claude'?[{type:'user',sessionId:client,message:{role:'user',content}},{type:'assistant',sessionId:client,message:{role:'assistant',content:'The implementation requires a compatibility check.',stop_reason:'end_turn'}}]:[{role:'user',message:{content}},{role:'assistant',message:{content:'A compatibility check is required.'}}];
 await fs.writeFile(file,rows.map(JSON.stringify).join('\n'));
 const payload={hook_event_name:client==='cursor'?'stop':'Stop',...(client==='cursor'?{workspace_roots:[dir]}:{cwd:dir}),session_id:client,conversation_id:client,transcript_path:file,last_assistant_message:'Complete.'};
 const r=spawnSync(process.execPath,['--no-warnings',process.env.ORGBRAIN_TEST_CLI_PATH??path.resolve('packages/orgbrain-cli/src/local-memory.mjs'),'hook',client+'-stop'],{env,input:JSON.stringify(payload),encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 }
 const jobs=await inspectSessionExtraction({queueDir,projectId:'org-brain'});assert.ok(jobs.length>=2);assert.ok(jobs.every(j=>j.status==='pending'));
 await fs.rm(dir,{recursive:true,force:true});
});
test('empty optional field does not discard another substantive candidate; all-empty still rejected',async()=>{
 const {generateSessionExtraction}=await import('../packages/orgbrain-cli/src/lib/session-extraction.mjs');
 const p={schema:'learning-extraction-proposal/v2',snippets:[snippets[0]],events:[]};
 const fake=async()=>new Response(JSON.stringify({model:'anthropic/claude-haiku-5.5',provider:'Google',choices:[{finish_reason:'stop',message:{content:JSON.stringify({candidates:[{lesson_type:'success',fields:[{name:'procedure',refs:[0]},{name:'why_it_worked',refs:[]}]}]})}}],usage:{prompt_tokens:100,completion_tokens:40}}));
 const generated=await generateSessionExtraction(p,{env:{OPENROUTER_API_KEY:'test'},fetchImpl:fake});assert.deepEqual(generated.candidates[0].fields,[{name:'procedure',values:[snippets[0].text]}]);
});
test('storage never silently changes the extraction body; opaque generated keys stay stable',async()=>{
 const {TaskCommitmentStore}=await import('../packages/orgbrain-cli/src/lib/task-commitment-store.mjs');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'session-storage-'));const store=new TaskCommitmentStore(path.join(dir,'m.sqlite'));
 const key=`memory-extraction:${'1234567890'.repeat(6)}abcd:${'a'.repeat(64)}`;
 const saved=await store.saveLearningCandidates({projectId:'org-brain',requireExactBody:true,candidates:[{external_key:key,observation:{decision_key:'inferred.123456789012345678901234',procedure:'Exact procedure.'}},{external_key:'unsafe-number',observation:{procedure:'Call +1 212 555 0199 now.'}}]});
 assert.equal(saved.filter(s=>s.status==='quarantine').length,1);assert.equal(saved.filter(s=>s.status==='held').length,1);
 const db=store.open();const rows=db.prepare('SELECT payload_json FROM memory_learning_candidates').all();db.close();assert.equal(rows.length,1);const value=JSON.parse(rows[0].payload_json);assert.equal(value.external_key,key);assert.equal(value.observation.decision_key,'inferred.123456789012345678901234');assert.equal(value.observation.procedure,'Exact procedure.');await fs.rm(dir,{recursive:true,force:true});
});
test('provider usage cannot lower the monthly budget with negative accounting',async()=>{
 const {parseSessionExtractionResponse}=await import('../packages/orgbrain-cli/src/lib/session-extraction.mjs');
 const response={model:'anthropic/claude-haiku-5.5',provider:'Google',choices:[{finish_reason:'stop',message:{content:'{"candidates":[]}'}}],usage:{prompt_tokens:-100,completion_tokens:0}};
 assert.throws(()=>parseSessionExtractionResponse({snippets:[],events:[]},response),/usage_invalid/);
});
test('Haiku worker rejects an old Sonnet response rather than accepting a fallback',async()=>{
 const {generateSessionExtraction}=await import('../packages/orgbrain-cli/src/lib/session-extraction.mjs');
 await assert.rejects(()=>generateSessionExtraction({snippets:[],events:[]},{env:{OPENROUTER_API_KEY:'test'},fetchImpl:async()=>new Response(JSON.stringify({model:'anthropic/claude-sonnet-5.5',provider:'Google',choices:[{finish_reason:'stop',message:{content:'{"candidates":[]}'}}],usage:{prompt_tokens:100,completion_tokens:10,cost:0.001}}))}),/model_mismatch/);
});
test('explicit failed Claude results cannot become successful verification evidence',async()=>{
 const {loadClientTurnRows}=await import('../packages/orgbrain-cli/src/lib/session-extraction.mjs');
 const {buildTurnEvidenceV1}=await import('../packages/orgbrain-cli/src/lib/turn-evidence-v1.mjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'failed-claude-'));const file=path.join(dir,'t.jsonl');
 await fs.writeFile(file,[{type:'user',message:{role:'user',content:'Run checks.'}},{type:'assistant',message:{role:'assistant',content:[{type:'tool_use',id:'c',name:'Bash',input:{command:'npm test'}}]}},{type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:'c',is_error:true,content:'exit_code=0; 27 checks complete.'}]}},{type:'assistant',message:{role:'assistant',content:'Checks complete.',stop_reason:'end_turn'}}].map(JSON.stringify).join('\n'));
 const rows=await loadClientTurnRows({client:'claude',transcript_path:file,workspace:dir});
 for(const variant of [rows,[{type:'response_item',payload:{type:'function_call',call_id:'c',name:'Bash',arguments:'{}'}},{type:'response_item',payload:{type:'function_call_output',call_id:'c',status:'failed',output:'exit_code=0; 27 checks complete.'}}]]){
 const e=await buildTurnEvidenceV1({rows:variant,project_id:'org-brain'},{preserve_snippet_text:true});assert.equal(e.events.find(x=>x.call_id==='c').status,'failed');
 const tool=e.snippets.find(s=>s.source==='tool_result');const r=await verifiedCandidates({packet:{snippets:e.snippets,events:e.events},run_id:'failure',project_id:'org-brain'},[{lesson_type:'success',support_span_ids:e.snippets.map(s=>s.span_id),fields:[{name:'procedure',values:['Checks complete.']},{name:'observed_outcome',values:[tool.text]}],gaps:[]}]);assert.ok(r.candidates.every(c=>!c.observation.observed_outcome));
 }
 await fs.rm(dir,{recursive:true,force:true});
});
test('same-speaker explicit reason and decision are indivisible across input limits',async()=>{
 const {prepareSessionExtraction}=await import('../packages/orgbrain-cli/src/lib/session-extraction.mjs');
 const text='We decided to use the cache '+ 'x'.repeat(350)+'. Reason: reduced duplicate work '+ 'y'.repeat(350)+'.';
 const rows=[{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}}];
 const p=await prepareSessionExtraction({rows,client:'claude',workspace:'/tmp',projectId:'org-brain'});
 assert.equal(p.packets.length,0);assert.equal(p.held.length,1);assert.equal(p.held[0].reason,'atomic_group_input_budget');
});
test('promotion-disabled rows do not consume the maintenance selection limit',async()=>{
 const {TaskCommitmentStore}=await import('../packages/orgbrain-cli/src/lib/task-commitment-store.mjs');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'selection-limit-'));const store=new TaskCommitmentStore(path.join(dir,'m.sqlite'));
 await store.saveLearningCandidates({projectId:'org-brain',candidates:[{external_key:'disabled',automatic_promotion:false,observation:{procedure:'Review only.'}},{external_key:'eligible',observation:{procedure:'Evaluate this.'}}]});
 const keys=[];await store.maintainLearningCandidates({limit:1,evaluate:async row=>{keys.push(row.external_key);return {route:'quarantine'};}});assert.deepEqual(keys,['eligible']);await fs.rm(dir,{recursive:true,force:true});
});
test('input holds survive enqueue and status without retaining original text',async()=>{
 const {enqueueSessionExtraction,inspectSessionExtraction}=await import('../packages/orgbrain-cli/src/lib/session-extraction.mjs');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'input-hold-'));
 const text='今後は配布前に互換確認を必須手順として実行してください。理由は'+ '互換性'.repeat(1000)+'。';const rows=[{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}}];
 const q=await enqueueSessionExtraction({rows,client:'claude',projectId:'org-brain',queueDir:dir,env:{ORGBRAIN_SESSION_EXTRACTION_PROJECTS:'org-brain'}});assert.ok(q.held.length);
 const status=await inspectSessionExtraction({queueDir:dir,projectId:'org-brain'});assert.ok(status.some(s=>s.status==='input_held'&&s.error==='atomic_group_input_budget'&&s.held_span_count>0));assert.equal(JSON.stringify(status).includes('互換性'),false);
 const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(path.join(dir,'queue.sqlite'),{readOnly:true});const table=db.prepare('SELECT * FROM input_holds').all();db.close();assert.ok(table.length);assert.equal(JSON.stringify(table).includes('互換性'),false);await fs.rm(dir,{recursive:true,force:true});
});
test('native Cursor Stop resolves workspace_roots without invented cwd',async()=>{
 const {normalizeRecord}=await import('../packages/orgbrain-cli/src/hook-memory-bridge.mjs');
 const record=normalizeRecord('cursor',JSON.stringify({hook_event_name:'stop',workspace_roots:['/tmp/orgbrain-native-project'],conversation_id:'native-c',generation_id:'native-g',transcript_path:'/tmp/native.jsonl',status:'completed'}));
 assert.equal(record.cwd,'/tmp/orgbrain-native-project');assert.equal(record.metadata.sessionId,'native-c');
 const multiple=normalizeRecord('cursor',JSON.stringify({workspace_roots:['/tmp/a','/tmp/b'],conversation_id:'native-c'}));assert.equal(multiple.cwd,null);
});
test('Claude API request blobs are not user messages; real sensitive user input stays denied',async()=>{
 const {loadClientTurnRows,prepareSessionExtraction}=await import('../packages/orgbrain-cli/src/lib/session-extraction.mjs');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'claude-native-blob-'));const file=path.join(dir,'t.jsonl');
 const input='今後は失敗状態を終了コードより優先することを必須手順としてください。';const rows=[{type:'user',sessionId:'native',message:{role:'user',content:input}},{type:'api-request-blob',sessionId:'native',message:{role:'user',content:[{type:'text',text:'PRIVATE INTERNAL REQUEST contact@example.invalid'}]}},{type:'assistant',sessionId:'native',message:{role:'assistant',content:[{type:'thinking',thinking:'PRIVATE THINKING'},{type:'text',text:'Failure status has priority because text may misclassify tools. Except when evidence proves success. Three checks passed.'}],stop_reason:'end_turn'}}];
 await fs.writeFile(file,rows.map(JSON.stringify).join('\n'));const loaded=await loadClientTurnRows({client:'claude',transcript_path:file,session_id:'native',workspace:dir,completed:true});assert.equal(JSON.stringify(loaded).includes('PRIVATE'),false);const prepared=await prepareSessionExtraction({rows:loaded,client:'claude',projectId:'org-brain',workspace:dir});assert.notEqual(prepared.status,'excluded');
 rows[0].message.content=input+' Contact contact@example.invalid.';await fs.writeFile(file,rows.map(JSON.stringify).join('\n'));const sensitive=await loadClientTurnRows({client:'claude',transcript_path:file,session_id:'native',workspace:dir,completed:true});const denied=await prepareSessionExtraction({rows:sensitive,client:'claude',projectId:'org-brain',workspace:dir});assert.equal(denied.status,'excluded');assert.equal(denied.reason,'sensitive_default_deny');await fs.rm(dir,{recursive:true,force:true});
});
