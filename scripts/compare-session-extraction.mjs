// Fixed approved real sources, current normal router, no production memory writes.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {prepareSessionExtraction,enqueueSessionExtraction,drainSessionExtraction,SESSION_EXTRACTION_MODEL,generateSessionExtraction} from '../packages/orgbrain-cli/src/lib/session-extraction.mjs';
import {buildTurnEvidenceV1,loadTurnEvidenceRows} from '../packages/orgbrain-cli/src/lib/turn-evidence-v1.mjs';
import {TaskCommitmentStore} from '../packages/orgbrain-cli/src/lib/task-commitment-store.mjs';
const root=path.join(os.homedir(),'.org-brain/evaluations/shared-extraction-20261019');
const sha=x=>crypto.createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:JSON.stringify(x)).digest('hex');
const write=(n,x)=>fs.writeFileSync(path.join(root,n),JSON.stringify(x,null,2)+'\n',{mode:0o600,flag:'wx'});
const allowed=['consentside','org-brain','AIma','socia','sfk-shinsa','jrg','factoreview','smart-block','tsugi'];
const beforeRoot=path.join(root,'before');
const beforeTurn=await import(pathToFileURL(path.join(beforeRoot,'packages/orgbrain-cli/src/lib/turn-evidence-v1.mjs')));
const beforeContract=await import(pathToFileURL(path.join(beforeRoot,'packages/shared/src/memory-extraction-provider-contract-runtime.mjs')));
const beforeVerifier=await import(pathToFileURL(path.join(beforeRoot,'packages/shared/src/memory-extraction-verifier-runtime.mjs')));
const mode=process.argv[2];
if(mode==='prepare'||mode==='prepare-v2'){
 const corpusFile=path.join(os.homedir(),'.org-brain/memhub-eval/retention-443-20261017/corpus.json');const bytes=fs.readFileSync(corpusFile);if(sha(bytes)!=='52f084e700ade9bf6de986908d22e5611125b707d01707c725058aec025183c5')throw Error('source_changed');
 const unique=new Map();for(const r of JSON.parse(bytes)){if(!allowed.includes(r.project))throw Error('scope');const a=r.task_inputs.find(x=>x.role==='assistant');if(!a)continue;const k=sha([r.project,a.evidence_id]);if(!unique.has(k))unique.set(k,{project:r.project,inputs:r.task_inputs});}
 const cases=[];let i=0;
 for(const [key,c]of unique){const workspace=c.inputs.find(s=>s.workspace)?.workspace??process.cwd();const rows=c.inputs.map(s=>({type:'response_item',payload:{type:'message',role:s.role,phase:s.role==='assistant'?'final':'input',content:[{type:s.role==='assistant'?'output_text':'input_text',text:s.verbatim}]}}));cases.push({id:`c${++i}`,project:c.project,rows,workspace,source_hash:key,cohort:'final_answers'});}
 const fullRoot=path.join(os.homedir(),'.org-brain/evaluations/extraction-coverage-20261017/full-turn-v2');
 for(const c of JSON.parse(fs.readFileSync(path.join(fullRoot,'corpus.json')))){if(!allowed.includes(c.project))throw Error('scope');const rows=await loadTurnEvidenceRows({transcript_path:path.join(fullRoot,`${c.id}.input.jsonl`),turn_id:c.turn_id,require_final:true});cases.push({id:`c${++i}`,project:c.project,rows,workspace:c.cwd,source_hash:sha(c.id),cohort:'full_turns'});}
 for(const c of cases){
  const evidence=await beforeTurn.buildTurnEvidenceV1({rows:c.rows,project_id:c.project,provider:'anthropic',model:SESSION_EXTRACTION_MODEL,session_hash:c.source_hash,turn_hash:c.source_hash},{workspace_root:c.workspace,sensitive_policy:{mode:'deny',allowed_principals:[]}});
  const discovery=await beforeTurn.discoverLearningEpisodes(evidence);c.before={eligible:discovery.llm_recommended,hard_excluded:evidence.hard_exclusion_reason??null,route:discovery.routing.disposition};
  if(discovery.llm_recommended)try{c.before.packet=beforeTurn.buildLearningExtractionPacket(evidence,discovery);}catch{c.before.error='input_budget';}
  const after=await prepareSessionExtraction({rows:c.rows,client:'codex',projectId:c.project,workspace:c.workspace});c.after=after;
 }
 const sources=['packages/orgbrain-cli/src/lib/session-extraction.mjs','packages/shared/src/memory-extraction-verifier-runtime.mjs','packages/shared/src/memory-contract-v2-runtime.mjs','packages/shared/src/memory-extraction-coverage-runtime.mjs'];
 const plan={schema:'session-extraction-real-comparison/v1',model:SESSION_EXTRACTION_MODEL,effort:'low',source_sha256:sha(bytes),max_cost_usd:5,per_call_reserve_usd:0.012,max_output_tokens:800,max_input_byte_upper_bound:2000,no_uncertain_retry:true,production_writes:false,source_versions:Object.fromEntries(sources.map(f=>[f,sha(fs.readFileSync(f))])),cases};write(mode==='prepare-v2'?'plan-v2.json':'plan.json',plan);
 console.log(JSON.stringify({cases:cases.length,before_calls:cases.filter(c=>c.before.packet?.snippets.length).length,after_calls:cases.reduce((n,c)=>n+c.after.packets.length,0),held:cases.reduce((n,c)=>n+c.after.held.length,0),routes:cases.reduce((o,c)=>(o[c.before.route]=(o[c.before.route]??0)+1,o),{}),projects:Object.fromEntries(allowed.map(p=>[p,{cases:cases.filter(c=>c.project===p).length,after_calls:cases.filter(c=>c.project===p).reduce((n,c)=>n+c.after.packets.length,0)}]))}));
}else if(mode==='execute'){
 const plan=JSON.parse(fs.readFileSync(path.join(root,'plan-v2.json')));for(const [f,h]of Object.entries(plan.source_versions))if(sha(fs.readFileSync(f))!==h)throw Error('execution_source_changed');
 const calls=path.join(root,'calls');fs.mkdirSync(calls,{recursive:true,mode:0o700});
 let transportBlocked=null;
 const fetchLogged=key=>async(url,options)=>{
  if(transportBlocked)throw Error('transport_blocked');
  const body=JSON.parse(options.body);if(body.model!==SESSION_EXTRACTION_MODEL||body.reasoning?.effort!=='low')throw Error('model_mismatch');
  const intents=fs.readdirSync(calls).filter(n=>n.endsWith('.intent.json')).length;if((intents+1)*plan.per_call_reserve_usd>plan.max_cost_usd)throw Error('evaluation_budget');
  const base=path.join(calls,key+'-'+sha(body).slice(0,16));fs.writeFileSync(base+'.intent.json',JSON.stringify({request_hash:sha(body),model:body.model,effort:'low',created_at:new Date().toISOString()}),{flag:'wx',mode:0o600});
  const response=await fetch(url,options);const result=await response.json();if([400,401,402,403,404,429].includes(response.status))transportBlocked=response.status;
  // Persist only text answer, usage and safe metadata. Never retain reasoning.
  const safe={model:result.model,provider:result.provider,choices:result.choices?.map(c=>({finish_reason:c.finish_reason,message:{content:c.message?.content}})),usage:result.usage,error:result.error?{code:result.error.code}:undefined};
  fs.writeFileSync(base+'.response.json',JSON.stringify(safe),{flag:'wx',mode:0o600});return new Response(JSON.stringify(safe),{status:response.status});
 };
 const results=[];const env={...process.env,ORGBRAIN_SESSION_EXTRACTION_PROJECTS:allowed.join(',')};
 const store=new TaskCommitmentStore(path.join(root,'before.sqlite'));await store.init();
 for(const c of plan.cases){
  const row={id:c.id,project:c.project,cohort:c.cohort,before:{},after:{}};
  const armOrder=parseInt(c.source_hash.slice(0,2),16)%2?['after','before']:['before','after'];
  for(const arm of armOrder){const outFile=path.join(root,`${c.id}-${arm}.json`);if(fs.existsSync(outFile)){row[arm]=JSON.parse(fs.readFileSync(outFile));continue;}
   if(arm==='before'){
    const packet=c.before.packet;if(!packet?.snippets.length)row.before={status:c.before.error??c.before.route,candidates:[],calls:0};
    else{
     const body={model:SESSION_EXTRACTION_MODEL,reasoning:{effort:'low',exclude:true},max_tokens:800,provider:{only:['google-vertex/global'],allow_fallbacks:false,require_parameters:true,data_collection:'deny',zdr:true,max_price:{prompt:2,completion:10}},response_format:{type:'json_schema',json_schema:{name:'memory_extraction',strict:true,schema:beforeContract.MEMORY_EXTRACTION_OUTPUT_SCHEMA}},messages:[{role:'user',content:beforeContract.buildMemoryExtractionPrompt(packet)}]};
     try{const res=await fetchLogged(`${c.id}-before`)('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${env.OPENROUTER_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(90000)});const raw=await res.json();if(!res.ok||raw.error)throw Error(`http_${res.status}`);if(raw.model!==SESSION_EXTRACTION_MODEL||raw.provider!=='Google'||raw.choices?.[0]?.finish_reason!=='stop')throw Error('incomplete');const parsed=JSON.parse(raw.choices[0].message.content);const v=await beforeVerifier.verifiedCandidates({packet,project_id:c.project,run_id:`before:${c.id}`},parsed.candidates);await store.saveLearningCandidates({tenantId:'default',projectId:c.project,candidates:v.candidates});row.before={status:'completed',candidates:v.candidates,rejections:v.rejections,calls:1,usage:raw.usage};}catch(e){row.before={status:'held',error:e.message,calls:1,candidates:[]};}
    }
   }else{
    const queueDir=path.join(root,'after-queue',c.id);const dbPath=path.join(root,'after.sqlite');
    const q=await enqueueSessionExtraction({rows:c.rows,client:'codex',projectId:c.project,tenantId:'default',workspace:c.workspace,queueDir,env});
    const r=await drainSessionExtraction({queueDir,dbPath,projectId:c.project,tenantId:'default',env,fetchImpl:fetchLogged(`${c.id}-after`),limit:100});
    const s=new TaskCommitmentStore(dbPath);await s.init();const db=s.open();const saved=db.prepare('SELECT payload_json FROM memory_learning_candidates WHERE project_id=? AND task_key IN (SELECT task_key FROM memory_learning_candidates WHERE project_id=?)').all(c.project,c.project).map(r=>JSON.parse(r.payload_json));db.close();
    const ids=new DatabaseSync(path.join(queueDir,'queue.sqlite'));const jobids=ids.prepare('SELECT id FROM jobs').all().map(j=>j.id);ids.close();
    const candidates=saved.filter(s=>jobids.some(id=>s.external_key.startsWith(`memory-extraction:${id}:`)));
    row.after={status:r.status,candidates,calls:r.processed+r.failed,usage:r.usage,rejections:r.rejections,input:q};
   }
   fs.writeFileSync(outFile,JSON.stringify(row[arm],null,2),{flag:'wx',mode:0o600});console.log(JSON.stringify({case:c.id,project:c.project,arm,status:row[arm].status,calls:row[arm].calls,saved:row[arm].candidates?.length??0}));
  }
  results.push(row);if(transportBlocked)throw Error(`transport_blocked_${transportBlocked}`);
 }
 write('results.json',results);
}else throw Error('prepare|execute');
