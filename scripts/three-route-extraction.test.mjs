import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {buildTurnEvidenceV1,discoverLearningEpisodes} from '../packages/orgbrain-cli/src/lib/turn-evidence-v1.mjs';
import {prepareSessionExtraction,inspectSessionExtraction} from '../packages/orgbrain-cli/src/lib/session-extraction.mjs';
import {createOpenRouterPipelineExtractor} from '../packages/orgbrain-cli/src/lib/memory-pipeline-review.mjs';
const msg=(role,text)=>({type:'response_item',payload:{type:'message',role,phase:role==='assistant'?'final':'input',content:[{type:'text',text}]}});
const source='既存サービスを再起動し、埋め込みを取得しました。停止中のサービスだったため復旧できました。同じ構成の場合に再利用できます。検索品質は未測定です。';
const evidence=text=>buildTurnEvidenceV1({rows:[msg('assistant',text)],project_id:'org-brain'},{preserve_snippet_text:true});

test('real-time discovery preserves a success procedure without a correction keyword',async()=>{
 const d=await discoverLearningEpisodes(await evidence(source));assert.equal(d.llm_recommended,true);assert.ok(d.review_drafts.some(c=>c.observation.lesson_type==='success'));
});
test('real-time source reports are never promoted into observed execution or user authority',async()=>{
 const d=await discoverLearningEpisodes(await evidence('We changed the cache because stale keys caused failures. Tests passed. Reuse when inputs match. We decided on the API policy.'));
 assert.equal(d.review_drafts.some(c=>c.observation.lesson_type==='decision'),false);
 for(const c of d.review_drafts){assert.equal(c.observation.observed_outcome??null,null);assert.equal(c.observation.verified_outcome??null,null);}
});
test('real-time decisions cannot borrow an assistant rationale',async()=>{
 const e=await buildTurnEvidenceV1({rows:[msg('user','今後はAPIをRESTで統一します。'),msg('assistant','理由は私が速いと思ったためです。')],project_id:'org-brain'});
 const d=await discoverLearningEpisodes(e);const decision=d.review_drafts.find(c=>c.observation.lesson_type==='decision');assert.ok(decision);assert.equal(decision.observation.rationale,null);
});
for(const source_type of ['personal_wiki','session_extraction'])test(source_type+' receives the same discovery and evidence constraints as Stop extraction',async()=>{
 const snapshot={source_type,source_key:'selected',source_hash:'a'.repeat(64),tenant_id:'default',project_id:'org-brain',authorship:'unverified',...(source_type==='personal_wiki'?{text:source,sources:[{ref:'source:11111111-1111-4111-8111-111111111111@1',text:source}]}:{snippets:[{span_id:'a',role:'assistant',source:'assistant',text:source}],events:[]})};
 let request;
 const extract=createOpenRouterPipelineExtractor({apiKey:'test',fetchImpl:async(_url,options)=>{request=JSON.parse(options.body);return new Response(JSON.stringify({model:request.model,provider:'fixture',choices:[{finish_reason:'stop',message:{content:'{"candidate":null}'}}],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12,cost:0}}));}});
 const result=await extract({snapshot});assert.equal(result.candidate,null);
 const sent=JSON.parse(request.messages[1].content.slice('Snapshot JSON:\n'.length));
 assert.equal(sent.episode_context.discovery.success,true);assert.equal(sent.episode_context.execution_attested,false);assert.equal(sent.snapshot.source_hash,snapshot.source_hash);
 assert.deepEqual(sent.episode_context.success_requires,['procedure','why_it_worked','observed_outcome','reuse_when']);
 const stop=await prepareSessionExtraction({rows:[msg('assistant',source)],client:'codex',projectId:'org-brain'});
 assert.deepEqual(stop.discovery_signals,sent.episode_context.discovery);
});
test('off blocks the normal Stop path including common queue and legacy capture',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'three-route-off-'));
 try{
 const map=path.join(dir,'map.json'),config=path.join(dir,'hooks.env'),transcript=path.join(dir,'session.jsonl'),db=path.join(dir,'memory.sqlite'),queueDir=path.join(dir,'q');
 await fs.writeFile(map,JSON.stringify({version:3,workspaces:{[dir]:{project_id:'org-brain',tenant_id:'default',memory_learning_mode:'off'}}}));
 await fs.writeFile(config,'ORGBRAIN_ENABLE_CLOUD_MEMORY=false\nORGBRAIN_LOCAL_HOOK_CAPTURE=true\nORGBRAIN_SESSION_EXTRACTION_MODE=on\nORGBRAIN_SESSION_EXTRACTION_PROJECTS=org-brain\nORGBRAIN_SESSION_EXTRACTION_AUTORUN=false\n');
 await fs.writeFile(transcript,[{type:'user',sessionId:'off',message:{role:'user',content:'今後はこのAPIを採用することを必須にしてください。'}},{type:'assistant',sessionId:'off',message:{role:'assistant',content:source,stop_reason:'end_turn'}}].map(JSON.stringify).join('\n'));
 const cli=process.env.ORGBRAIN_TEST_CLI_PATH??path.resolve('packages/orgbrain-cli/src/local-memory.mjs');
 const r=spawnSync(process.execPath,['--no-warnings',cli,'hook','claude-stop'],{encoding:'utf8',input:JSON.stringify({hook_event_name:'Stop',cwd:dir,session_id:'off',transcript_path:transcript,last_assistant_message:source}),env:{HOME:dir,PATH:'',ORGBRAIN_HOOK_ENV_FILES:config,ORGBRAIN_WORKSPACES_FILE:map,ORGBRAIN_LOCAL_DB:db,ORGBRAIN_SESSION_EXTRACTION_QUEUE:queueDir}});
 assert.equal(r.status,0,r.stderr);const {DatabaseSync}=await import('node:sqlite');const stored=new DatabaseSync(db,{readOnly:true});assert.equal(stored.prepare('SELECT count(*) n FROM memories').get().n,0);stored.close();
 assert.equal((await inspectSessionExtraction({queueDir,projectId:'org-brain'})).length,0);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('historical pipeline keeps the recovery groups and their result state',async()=>{
 const {DatabaseSync}=await import('node:sqlite');const {createHash}=await import('node:crypto');
 const {loadSessionPipelinePacket}=await import('../packages/orgbrain-cli/src/lib/memory-pipeline-sources.mjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'three-route-packet-'));
 try{
 const id='a'.repeat(64),text='Tests passed; only the local check is verified.';
 const packet={policy:'session-extraction/v1',tenant_id:'default',project_id:'org-brain',snippets:[{span_id:'s',role:'tool',source:'tool_result',call_id:'checked',text}],events:[],coverage:{groups:[{span_ids:['s'],outcome_state:'recovered',lesson_tags:['failure','success'],test_first_reported:true}]}};
 const db=new DatabaseSync(path.join(dir,'queue.sqlite'));db.exec('CREATE TABLE jobs(id TEXT,tenant_id TEXT,project_id TEXT,packet_json TEXT,packet_hash TEXT,status TEXT,policy_hash TEXT)');
 const json=JSON.stringify(packet);db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)').run(id,'default','org-brain',json,createHash('sha256').update(json).digest('hex'),'completed','fixed');db.close();
 const loaded=await loadSessionPipelinePacket({queueDir:dir,projectId:'org-brain',jobId:id});assert.deepEqual(loaded.coverage,packet.coverage);assert.ok(Object.isFrozen(loaded.coverage));
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('an empty Stop event remains a no-op before workspace initialization',async()=>{
 const {ingestHookEvent}=await import('../packages/orgbrain-cli/src/hook-memory-bridge.mjs');
 const result=await ingestHookEvent('codex-stop','   ',{emit:false});assert.equal(result.skipped,'empty-payload');
});
