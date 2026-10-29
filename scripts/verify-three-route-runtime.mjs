// Exact-bundle canaries: isolated DB/queue, mocked inference, real Wiki read.
// This is integration acceptance, not evidence of model quality or savings.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';import {DatabaseSync} from 'node:sqlite';
const args=process.argv.slice(2),get=k=>args[args.indexOf(k)+1];
const cli=path.resolve(get('--cli')),out=path.resolve(get('--output'));
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orgbrain-route-canary-'));
const queue=path.join(dir,'queue'),db=path.join(dir,'memory.sqlite'),calls=path.join(dir,'calls.jsonl'),envFile=path.join(dir,'hooks.env'),map=path.join(dir,'map.json'),loader=path.join(dir,'mock.mjs');
const pageId='22b14a09-1eed-4367-be58-71347257514a';
const write=(name,value)=>fs.writeFileSync(path.join(dir,name),typeof value==='string'?value:JSON.stringify(value));
write('map.json',{version:3,workspaces:{[dir]:{project_id:'org-brain',tenant_id:'default',memory_learning_mode:'eager'}}});
write('hooks.env','ORGBRAIN_ENABLE_CLOUD_MEMORY=false\nORGBRAIN_LOCAL_HOOK_CAPTURE=true\nORGBRAIN_SESSION_EXTRACTION_MODE=on\nORGBRAIN_SESSION_EXTRACTION_PROJECTS=org-brain\nORGBRAIN_SESSION_EXTRACTION_AUTORUN=false\n');
write('mock.mjs',`import fs from 'node:fs';globalThis.fetch=async(_u,options)=>{const b=JSON.parse(options.body);const name=b.response_format.json_schema.name;fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({schema:name,model:b.model,has_episode_context:b.messages[1]?.content.includes('episode_context')??false})+'\\n');let output={candidate:null};if(name==='session_extraction'){const s=JSON.parse(b.messages[0].content.split('\\n').slice(1).join('\\n')).s;const refs=s.map((_,i)=>i);output={candidates:[{lesson_type:'success',fields:[{name:'procedure',refs},{name:'why_it_worked',refs},{name:'reuse_when',refs},{name:'reported_verification',refs}]}]};}return new Response(JSON.stringify({model:b.model,provider:name==='session_extraction'?'Google':'fixture',choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}],usage:{prompt_tokens:100,completion_tokens:50,total_tokens:150,cost:0}}));};`);
const env={...process.env,HOME:dir,ORGBRAIN_HOOK_ENV_FILES:envFile,ORGBRAIN_WORKSPACES_FILE:map,ORGBRAIN_LOCAL_DB:db,ORGBRAIN_SESSION_EXTRACTION_QUEUE:queue,ORGBRAIN_WIKI_ROOT:path.join(os.homedir(),'.org-brain/wiki/personal'),ORGBRAIN_FEATURES_FILE:path.join(os.homedir(),'.org-brain/features.json'),OPENROUTER_API_KEY:'fixture',NODE_OPTIONS:`--import=${loader}`,ORGBRAIN_LOCAL_EMBEDDING_PROVIDER:''};
function invoke(argv,input){const r=spawnSync(process.execPath,['--no-warnings',cli,...argv],{env,encoding:'utf8',input:input==null?undefined:JSON.stringify(input),timeout:30000});if(r.status!==0)throw Error(r.stderr.slice(-1000)||'CLI failed');return JSON.parse(r.stdout.trim());}
const lesson='Use the cache because duplicate work wastes resources. Reuse only when inputs match. Tests passed; production remains unverified.';
try{
 write('claude.jsonl',[{type:'user',sessionId:'realtime',message:{role:'user',content:'Implement the cache.'}},{type:'assistant',sessionId:'realtime',message:{role:'assistant',content:lesson,stop_reason:'end_turn'}}].map(JSON.stringify).join('\n'));
 invoke(['hook','claude-stop'],{hook_event_name:'Stop',cwd:dir,session_id:'realtime',transcript_path:path.join(dir,'claude.jsonl'),last_assistant_message:lesson});
 const realtime=invoke(['memory','extraction','run','--project-id','org-brain','--queue-dir',queue,'--db',db,'--execute']);
 write('codex.jsonl',[{type:'turn_context',timestamp:'2026-10-20T00:00:00Z',payload:{turn_id:'historical',cwd:dir}},{type:'response_item',payload:{type:'message',role:'assistant',phase:'final',content:[{type:'text',text:lesson}]}},{type:'event_msg',payload:{type:'task_complete',turn_id:'historical'}}].map(JSON.stringify).join('\n'));
 const enqueued=invoke(['memory','extraction','enqueue','--client','codex','--project-id','org-brain','--workspace',dir,'--input',path.join(dir,'codex.jsonl'),'--queue-dir',queue,'--db',db,'--execute']);
 const historical=invoke(['memory','extraction','run','--project-id','org-brain','--queue-dir',queue,'--db',db,'--execute']);
 const page=invoke(['wiki','read','--page-id',pageId]);
 const wiki=invoke(['pipeline','run','--db',db,'--json',JSON.stringify({source:'wiki',page_id:pageId,expected_hash:page.hash,project_id:'org-brain',queue_dir:queue})]);
 const m=new DatabaseSync(db,{readOnly:true});const states=m.prepare('SELECT status,count(*) n FROM memory_learning_candidates GROUP BY status').all();const active=m.prepare('SELECT count(*) n FROM memories').get().n;m.close();
 const acceptance={realtime_quarantined:Boolean(realtime.saved),historical_quarantined:Boolean(historical.saved),historical_enqueued:Boolean(enqueued.queued),wiki_abstained:wiki.status==='abstained',no_active_memories:active===0,only_quarantined_candidates:states.every(s=>s.status==='quarantine')};
 const requests=fs.readFileSync(calls,'utf8').trim().split('\n').map(JSON.parse);
 const result={schema:'three-route-runtime-canary/v1',mocked_inference:true,real_wiki_read:true,realtime:{processed:realtime.processed,quarantined:realtime.saved},historical:{processed:historical.processed,quarantined:historical.saved},wiki:{page_id:pageId,hash:page.hash,status:wiki.status},requests,acceptance,isolated_active_memories:active,production_writes:0,model_quality_verified:false,reuse_effect_verified:false};
 fs.writeFileSync(out,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
 if(Object.values(acceptance).some(passed=>!passed))throw Error('canary_acceptance_failed');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
