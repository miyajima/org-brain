import {learningEpisodeContext} from '../../../shared/src/learning-episode-policy-runtime.mjs';
// Shared Stop -> durable queue -> API worker. No client CLI or inference in Stop.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';
import {buildTurnEvidenceV1,discoverLearningEpisodes,loadTurnEvidenceRows} from './turn-evidence-v1.mjs';
import {buildCoverageEvidenceGroups} from '../../../shared/src/memory-extraction-coverage-runtime.mjs';
import {verifiedCandidates} from '../../../shared/src/memory-extraction-verifier-runtime.mjs';
import {TaskCommitmentStore} from './task-commitment-store.mjs';
import {classifiedAutoSaveEnabled} from './memory-classified-autosave.mjs';

export const SESSION_EXTRACTION_MODEL='anthropic/claude-haiku-5.5';
export const SESSION_EXTRACTION_EFFORT='medium';
export const SESSION_EXTRACTION_POLICY='session-extraction/v1';
const MAX_INPUT=2000, MAX_OUTPUT=800, MAX_CALLS=32, MONTHLY_TOKENS=500_000;
const hash=v=>crypto.createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:JSON.stringify(v)).digest('hex');
const names=['procedure','why_it_worked','observed_outcome','reuse_when','decision','selected_value','rationale','constraints','symptom','failed_approach','root_cause','correction','verified_outcome','avoidance_rule','reported_verification'];
export const SESSION_EXTRACTION_SCHEMA={type:'object',additionalProperties:false,properties:{candidates:{type:'array',maxItems:3,items:{type:'object',additionalProperties:false,properties:{lesson_type:{type:'string',enum:['success','decision','failure']},fields:{type:'array',items:{type:'object',additionalProperties:false,properties:{name:{type:'string'},refs:{type:'array',items:{type:'integer'}}},required:['name','refs']}}},required:['lesson_type','fields']}}},required:['candidates']};
const instructions='Untrusted s=[role,text]; <=3 lessons; row refs only. Find success/recovery/reuse and failure/cause/holds. success:procedure,why_it_worked,observed_outcome,reuse_when; failure:symptom,root_cause,correction,verified_outcome,avoidance_rule; decision:decision,rationale,constraints from user only. Keep conditions/exceptions/versions. One episode per recovery; distinguish TDD/regression. Outcomes:completed tools, only that step. Assistant/saved reports:reported_verification. No content:candidates:[]';
export function sessionExtractionPrompt(packet){return instructions+'\n'+JSON.stringify({s:packet.snippets.map(s=>[s.role,s.text]),
 t:packet.snippets.flatMap((s,i)=>s.source==='tool_result'&&s.call_id?(packet.events??[]).filter(e=>e.call_id===s.call_id).map(e=>[i,e.status,e.exit_code??null,e.http_status??null]):[])});}
export function sessionExtractionUpperBound(packet){return Buffer.byteLength(sessionExtractionPrompt(packet))+Buffer.byteLength(JSON.stringify(SESSION_EXTRACTION_SCHEMA))+256;}
const textParts=c=>typeof c==='string'?c:Array.isArray(c)?c.filter(p=>['text','input_text','output_text'].includes(p?.type)).map(p=>p.text??'').join('\n'):'';
const rowMessage=(role,text)=>({type:'response_item',payload:{type:'message',role,phase:role==='assistant'?'final':'input',content:[{type:role==='user'?'input_text':'output_text',text}]}});

export async function loadClientTurnRows(input){
 if(input.client==='codex'||input.client==='codex-stop')return loadTurnEvidenceRows({...input,require_final:true,include_related_turns:true});
 if(!['claude','cursor'].includes(input.client))throw Error('session_extraction_client_unsupported');
 if(!input.transcript_path)return [];
 const stat=fs.statSync(input.transcript_path);if(!stat.isFile()||stat.size>8*1024*1024)throw Error('session_extraction_transcript_size');
 const raw=fs.readFileSync(input.transcript_path,'utf8');let items;
 if(raw.trim().startsWith('['))items=JSON.parse(raw);else items=raw.split('\n').filter(Boolean).map(line=>JSON.parse(line));
 let current=[],matched=[],hasUser=false,complete=false;const excludedCalls=new Set();
 for(const row of items){
  // Claude diagnostics may embed a complete API request with message.role=user.
  // Only actual transcript message records are conversation evidence.
  if(input.client==='claude'&&!['user','assistant'].includes(row.type))continue;
  if(row.isSidechain||row.agentId||row.parentSessionId)continue;
  const sid=row.sessionId??row.session_id??row.conversation_id;
  if(input.session_id&&sid&&sid!==input.session_id)continue;
  if(row.cwd&&input.workspace&&path.resolve(row.cwd)!==path.resolve(input.workspace))throw Error('session_extraction_scope_mismatch');
  const message=row.message??row;const role=message.role??row.role??row.type;
  const content=textParts(message.content??row.content);
  if(!['user','assistant'].includes(role))continue;
  if(role==='user'&&content){
   if(complete){current=[];hasUser=false;complete=false;}
   current.push(rowMessage('user',content));hasUser=true;
  }
  if(hasUser&&Array.isArray(message.content))for(const block of message.content){
   if(block.type==='tool_use'){
    if(/^(?:Agent|Task)$|spawn_agent|read_thread|send_message|collaboration/iu.test(block.name??'')){excludedCalls.add(block.id);continue;}
    current.push({type:'response_item',payload:{type:'function_call',call_id:block.id,name:block.name,arguments:JSON.stringify(block.input??{})}});
   }
   if(block.type==='tool_result'&&!excludedCalls.has(block.tool_use_id))current.push({type:'response_item',payload:{type:'function_call_output',call_id:block.tool_use_id,output:textParts(block.content),...(block.is_error?{status:'failed',is_error:true}:{})}});
  }
  if(role==='assistant'&&hasUser&&content){
   // Text only; thinking, tool_use, tool_result, subagent history never becomes proof.
   const final=input.client==='cursor'?input.completed===true:['end_turn','stop_sequence'].includes(message.stop_reason)
     || input.completed===true&&message.stop_reason==null&&!message.content?.some?.(b=>b.type==='tool_use');
   if(!final)continue;
   current.push(rowMessage('assistant',content));matched=[...current];complete=true;
  }
 }
 if(!matched.length)return [];
 const identity=input.turn_id??hash(matched);
 return [{type:'turn_context',payload:{turn_id:identity,cwd:input.workspace??''}},...matched,{type:'event_msg',payload:{type:'task_complete',turn_id:identity}}];
}
function allowed(project,env){return Boolean(project)&&String(env.ORGBRAIN_SESSION_EXTRACTION_PROJECTS??'').split(',').map(s=>s.trim()).includes(project);}
let loadedPolicyHash;
function policyHash(){
 if(loadedPolicyHash)return loadedPolicyHash;
 const files=[import.meta.url,new URL('./turn-evidence-v1.mjs',import.meta.url),...['learning-episode-policy-runtime.mjs','memory-extraction-verifier-runtime.mjs','memory-extraction-coverage-runtime.mjs','memory-contract-v2-runtime.mjs','memory-capture-v2-runtime.mjs','memory-capture-profile.generated.mjs'].map(f=>new URL('../../../shared/src/'+f,import.meta.url))];
 return loadedPolicyHash=hash(files.filter(f=>fs.existsSync(fileURLToPath(f))).map(f=>hash(fs.readFileSync(fileURLToPath(f)))));
}
function openQueue(queueDir){
 const root=path.resolve(queueDir??process.env.ORGBRAIN_SESSION_EXTRACTION_QUEUE??path.join(os.homedir(),'.org-brain/session-extraction'));
 fs.mkdirSync(root,{recursive:true,mode:0o700});fs.chmodSync(root,0o700);
 const file=path.join(root,'queue.sqlite');const db=new DatabaseSync(file);fs.chmodSync(file,0o600);db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,tenant_id TEXT,project_id TEXT,client TEXT,packet_json TEXT,packet_hash TEXT,status TEXT,created_at INTEGER,month TEXT,result_json TEXT,charged INTEGER DEFAULT 0,error TEXT); CREATE INDEX IF NOT EXISTS jobs_scope ON jobs(tenant_id,project_id,status);");db.exec('CREATE TABLE IF NOT EXISTS input_holds(id TEXT PRIMARY KEY,tenant_id TEXT,project_id TEXT,client TEXT,source_hash TEXT,reason TEXT,span_count INTEGER,created_at INTEGER)');if(!db.prepare('PRAGMA table_info(jobs)').all().some(c=>c.name==='policy_hash'))db.exec('ALTER TABLE jobs ADD COLUMN policy_hash TEXT');return db;
}
function processAlive(pid){
 if(!Number.isSafeInteger(pid)||pid<=0)return false;
 try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}
}
function processIdentity(pid){
 try{
  if(process.platform==='linux'){
   const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8');const started=stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];return /^\d+$/u.test(started??'')?hash([fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8'),started]):null;
  }
  const options={encoding:'utf8',timeout:2000,stdio:['ignore','pipe','ignore'],env:{...process.env,LC_ALL:'C',LANG:'C'}};
  if(process.platform==='darwin'){
   const started=execFileSync('/bin/ps',['-o','lstart=','-p',String(pid)],options).trim();
   return started?hash([execFileSync('/usr/sbin/sysctl',['-n','kern.boottime'],options).trim(),started]):null;
  }
  if(process.platform==='win32'){const started=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`],options).trim();return /^\d+$/u.test(started)?hash(started):null;}
 }catch{}
 return null;
}
function ownerAlive(lease){
 if(!processAlive(lease.pid))return false;
 const identity=processIdentity(lease.pid);
 // Missing identity never authorizes taking over a possibly live owner.
 return !identity||!lease.owner_identity||identity===lease.owner_identity;
}
function workerTables(db){
 db.exec('BEGIN IMMEDIATE');
 db.exec('CREATE TABLE IF NOT EXISTS worker_leases(tenant_id TEXT,project_id TEXT,token TEXT,pid INTEGER,PRIMARY KEY(tenant_id,project_id)); CREATE TABLE IF NOT EXISTS worker_runs(token TEXT PRIMARY KEY,tenant_id TEXT,project_id TEXT,pid INTEGER,started_at INTEGER,finished_at INTEGER,status TEXT,processed INTEGER DEFAULT 0,saved INTEGER DEFAULT 0,failed INTEGER DEFAULT 0,cost_usd REAL,error TEXT)');
 if(!db.prepare('PRAGMA table_info(worker_leases)').all().some(c=>c.name==='owner_identity'))db.exec('ALTER TABLE worker_leases ADD COLUMN owner_identity TEXT');
 db.exec('COMMIT');
}
function queueRoot(queueDir){return path.resolve(queueDir??process.env.ORGBRAIN_SESSION_EXTRACTION_QUEUE??path.join(os.homedir(),'.org-brain/session-extraction'));}
export function sessionExtractionAutorunEnabled(env=process.env){
 return env.ORGBRAIN_SESSION_EXTRACTION_AUTORUN==='true'&&env.ORGBRAIN_SESSION_EXTRACTION_MODE==='on'&&env.ORGBRAIN_LOCAL_HOOK_CAPTURE!=='false';
}
export async function wakeSessionExtraction({queueDir,dbPath,tenantId='default',projectId,env=process.env,cliPath,spawnImpl=spawn}={}){
 if(!sessionExtractionAutorunEnabled(env)||!allowed(projectId,env))return {started:false,status:'autorun_disabled'};
 if(!env.OPENROUTER_API_KEY)return {started:false,status:'model_unavailable'};
 const root=queueRoot(queueDir);const db=openQueue(root);let pending;
 try{pending=Number(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE tenant_id=? AND project_id=? AND status IN ('pending','generated')").get(tenantId,projectId).n);}finally{db.close();}
 if(!pending)return {started:false,status:'idle'};
 const invoked=process.argv[1];
 const entry=cliPath??(path.basename(invoked??'')==='hook-memory-bridge.mjs'?fileURLToPath(new URL('../local-memory.mjs',import.meta.url)):invoked);
 if(!entry||!path.isAbsolute(entry)||!fs.statSync(entry,{throwIfNoEntry:false})?.isFile())return {started:false,status:'worker_entry_unavailable'};
 const target=dbPath??env.ORGBRAIN_LOCAL_DB??path.join(os.homedir(),'.org-brain/memory.sqlite');
 const argv=['--no-warnings',entry,'memory','extraction','auto-run','--project-id',projectId,'--tenant-id',tenantId,'--queue-dir',root,'--db',path.resolve(target),'--limit','20','--execute'];
 try{return await new Promise(resolve=>{
  const child=spawnImpl(process.execPath,argv,{cwd:root,env,detached:true,stdio:'ignore',windowsHide:true});
  child.once('error',()=>resolve({started:false,status:'worker_spawn_failed'}));
  child.once('spawn',()=>{child.unref();resolve({started:true,status:'started',pid:child.pid});});
 });}catch{return {started:false,status:'worker_spawn_failed'};}
}
export async function inspectSessionExtractionWorker({queueDir,tenantId='default',projectId}){
 const db=openQueue(queueDir);try{workerTables(db);const lease=db.prepare('SELECT pid,owner_identity FROM worker_leases WHERE tenant_id=? AND project_id=?').get(tenantId,projectId);
  return {active:Boolean(lease&&ownerAlive(lease)),latest:db.prepare('SELECT pid,started_at,finished_at,status,processed,saved,failed,cost_usd,error FROM worker_runs WHERE tenant_id=? AND project_id=? ORDER BY started_at DESC,rowid DESC LIMIT 1').get(tenantId,projectId)??null};
 }finally{db.close();}
}
function acquireWorker({queueDir,tenantId='default',projectId}){
 const db=openQueue(queueDir);try{workerTables(db);db.exec('BEGIN IMMEDIATE');const old=db.prepare('SELECT * FROM worker_leases WHERE tenant_id=? AND project_id=?').get(tenantId,projectId);
  if(old&&ownerAlive(old)){db.exec('ROLLBACK');return null;}
  if(old)db.prepare("UPDATE worker_runs SET status='owner_exited',finished_at=? WHERE token=? AND finished_at IS NULL").run(Date.now(),old.token);
  const identity=processIdentity(process.pid);if(!identity)throw Error('worker_identity_unavailable');
  const token=crypto.randomUUID();db.prepare('INSERT OR REPLACE INTO worker_leases(tenant_id,project_id,token,pid,owner_identity) VALUES(?,?,?,?,?)').run(tenantId,projectId,token,process.pid,identity);
  db.prepare("INSERT INTO worker_runs(token,tenant_id,project_id,pid,started_at,status) VALUES(?,?,?,?,?,'running')").run(token,tenantId,projectId,process.pid,Date.now());db.exec('COMMIT');return token;
 }finally{db.close();}
}
function releaseWorker({queueDir,tenantId='default',projectId},token,report){
 const db=openQueue(queueDir);try{db.exec('BEGIN IMMEDIATE');
  const usage=report.usage??[];const cost=usage.length&&usage.every(u=>typeof u.cost_usd==='number'&&Number.isFinite(u.cost_usd)&&u.cost_usd>=0)?usage.reduce((n,u)=>n+u.cost_usd,0):null;
  db.prepare('UPDATE worker_runs SET finished_at=?,status=?,processed=?,saved=?,failed=?,cost_usd=?,error=? WHERE token=?').run(Date.now(),report.status,report.processed??0,report.saved??0,report.failed??0,cost,report.error??null,token);
  const released=db.prepare('DELETE FROM worker_leases WHERE tenant_id=? AND project_id=? AND token=?').run(tenantId,projectId,token).changes;
  const pending=released?Number(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE tenant_id=? AND project_id=? AND status IN ('pending','generated')").get(tenantId,projectId).n):0;
  db.exec('COMMIT');return pending;
 }finally{db.close();}
}

export async function prepareSessionExtraction({rows,client,projectId,tenantId='default',workspace,sessionId,turnId}){
 if(!['codex','codex-stop','claude','cursor'].includes(client))throw Error('session_extraction_client_unsupported');
 const evidence=await buildTurnEvidenceV1({rows,project_id:projectId,provider:'anthropic',model:SESSION_EXTRACTION_MODEL,session_hash:hash(sessionId??rows),turn_hash:hash(turnId??rows)},{workspace_root:workspace,sensitive_policy:{mode:'deny',allowed_principals:[]},preserve_snippet_text:true});
 const discovery=await discoverLearningEpisodes(evidence);
 if(discovery.routing.decisions.hard_excluded)return {packets:[],held:[],status:'excluded',reason:evidence.hard_exclusion_reason};
 const signals=learningEpisodeContext(evidence).discovery;
 if(!discovery.llm_recommended&&!signals.success&&!signals.failure)return {packets:[],held:[],status:'rule_complete_or_no_durable_episode',routing:discovery.routing.primary_route};
 const groups=buildCoverageEvidenceGroups(evidence.snippets,evidence.events);
 const packets=[],held=[];
 // All redacted source spans participate; router support IDs never narrow away adjacent evidence.
 // Related sentences are indivisible. Too-large groups are held, never clipped.
 let current=[];
 const make=gs=>({schema:'learning-extraction-proposal/v2',episode_profile:'session-episodes/v1',session_hash:evidence.session_hash,turn_hash:evidence.turn_hash,source_evidence_hash:evidence.evidence_hash,snippets:gs.flatMap(g=>g.snippets),events:evidence.events.filter(e=>gs.some(g=>g.snippets.some(s=>s.call_id===e.call_id))),coverage:{groups:gs.map(g=>({span_ids:g.span_ids,outcome_state:g.outcome_state,lesson_tags:g.lesson_tags,test_first_reported:g.test_first_reported}))},project_id:projectId,policy:SESSION_EXTRACTION_POLICY,tenant_id:tenantId});
 const flush=()=>{if(current.length){packets.push(make(current));current=[];}};
 for(const group of groups){
  if(sessionExtractionUpperBound(make([group]))>MAX_INPUT){held.push({span_ids:group.span_ids,reason:'atomic_group_input_budget'});continue;}
  if(sessionExtractionUpperBound(make([...current,group]))>MAX_INPUT)flush();
  if(packets.length>=MAX_CALLS){held.push({span_ids:group.span_ids,reason:'turn_call_limit'});continue;}
  current.push(group);
 }
 flush();
 return {packets,held,status:held.length?'partial_input_held':'prepared',discovery_signals:signals,source_spans:groups.reduce((n,g)=>n+g.snippets.length,0),presented_spans:packets.reduce((n,p)=>n+p.snippets.length,0)};
}
export async function enqueueSessionExtraction(input){
 const env=input.env??process.env;const sessionId=input.sessionId??input.rows?.find(r=>r.type==='session_meta')?.payload?.id;
 if(sessionId&&String(env.ORGBRAIN_SESSION_EXTRACTION_EXCLUDE_SESSIONS??'').split(',').map(s=>s.trim()).includes(sessionId))return {queued:0,status:'session_excluded'};
 if(!allowed(input.projectId,env))return {queued:0,status:'project_not_allowlisted'};
 const prepared=await prepareSessionExtraction(input);const db=openQueue(input.queueDir);let queued=0;
 try{for(const held of prepared.held??[]){const sourceHash=hash([input.rows,held.span_ids]);const id=hash([input.tenantId??'default',input.projectId,SESSION_EXTRACTION_POLICY,sourceHash,held.reason]);db.prepare('INSERT OR IGNORE INTO input_holds VALUES(?,?,?,?,?,?,?,?)').run(id,input.tenantId??'default',input.projectId,input.client,sourceHash,held.reason,held.span_ids.length,Date.now());}
 for(const packet of prepared.packets){const packetHash=hash(packet);const id=hash([input.tenantId??'default',input.projectId,SESSION_EXTRACTION_POLICY,SESSION_EXTRACTION_MODEL,SESSION_EXTRACTION_EFFORT,packetHash]);queued+=Number(db.prepare("INSERT OR IGNORE INTO jobs(id,tenant_id,project_id,client,packet_json,packet_hash,status,created_at,policy_hash) VALUES(?,?,?,?,?,?,'pending',?,?)").run(id,input.tenantId??'default',input.projectId,input.client,JSON.stringify(packet),packetHash,Date.now(),policyHash()).changes);}}
 finally{db.close();}
 return {queued,status:prepared.status,held:prepared.held,source_spans:prepared.source_spans,presented_spans:prepared.presented_spans};
}
function expandSelections(raw,packet){
 if(!raw||!Array.isArray(raw.candidates)||raw.candidates.length>3)throw Error('candidate_schema_invalid');
 const expanded=raw.candidates.map(c=>{
  if(!['success','decision','failure'].includes(c?.lesson_type)||!Array.isArray(c.fields))throw Error('candidate_schema_invalid');
  const fields=c.fields.map(f=>{if(!names.includes(f?.name)||!Array.isArray(f.refs)||f.refs.some(i=>!Number.isSafeInteger(i)||i<0||i>=packet.snippets.length))throw Error('candidate_reference_invalid');return {name:f.name,values:[...new Set(f.refs)].map(i=>packet.snippets[i].text)};}).filter(f=>f.values.length);
  const required=c.lesson_type==='success'?['procedure','why_it_worked','observed_outcome','reuse_when']:c.lesson_type==='failure'?['symptom','root_cause','correction','verified_outcome','avoidance_rule']:['decision','rationale','constraints'];
  const gaps=required.filter(n=>!fields.some(f=>f.name===n)).map(n=>n+'_missing');
  return {lesson_type:c.lesson_type,fields,support_span_ids:[...new Set(c.fields.flatMap(f=>f.refs).map(i=>packet.snippets[i].span_id))],gaps:['llm_proposed_review_only',...gaps]};
 });
 // Collapse only an exactly equivalent recovery, not different lessons that
 // happen to use one report. Keep the richer failure with the successful result.
 const aliases={procedure:'correction',why_it_worked:'root_cause',observed_outcome:'verified_outcome',reuse_when:'avoidance_rule',reported_verification:'reported_verification'};
 const duplicateSuccesses=new Set();
 for(const failure of expanded.filter(c=>c.lesson_type==='failure')){
  for(const success of expanded.filter(c=>c.lesson_type==='success')){
   const group=(packet.coverage?.groups??[]).find(g=>g.outcome_state==='recovered'
    && [...failure.support_span_ids,...success.support_span_ids].every(id=>g.span_ids.includes(id)));
   if(!group||!['procedure','why_it_worked','observed_outcome','reuse_when'].every(name=>success.fields.some(f=>f.name===name)))continue;
   if(!success.fields.every(f=>aliases[f.name]&&failure.fields.some(other=>other.name===aliases[f.name]
     && JSON.stringify(other.values)===JSON.stringify(f.values))))continue;
   failure.lesson_tags=['failure','success'];duplicateSuccesses.add(success);
  }
 }
 return expanded.filter(c=>!duplicateSuccesses.has(c));
}
export async function generateSessionExtraction(packet,{env=process.env,fetchImpl=fetch}={}){
 if(!env.OPENROUTER_API_KEY)throw Error('session_extraction_key_missing');
 if(sessionExtractionUpperBound(packet)>MAX_INPUT)throw Error('session_extraction_input_budget');
 const body={model:SESSION_EXTRACTION_MODEL,reasoning:{effort:SESSION_EXTRACTION_EFFORT,exclude:true},max_tokens:MAX_OUTPUT,
 provider:{only:['google-vertex/global'],allow_fallbacks:false,require_parameters:true,data_collection:'deny',zdr:true,max_price:{prompt:2,completion:10}},
 response_format:{type:'json_schema',json_schema:{name:'session_extraction',strict:true,schema:SESSION_EXTRACTION_SCHEMA}},messages:[{role:'user',content:sessionExtractionPrompt(packet)}]};
 const response=await fetchImpl('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${env.OPENROUTER_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(90_000)});
 if(!response.ok)throw Error(`session_extraction_http_${response.status}`);
 const result=await response.json();
 if(result.error)throw Error('session_extraction_provider_error');
 if(result.model!==SESSION_EXTRACTION_MODEL||result.provider!=='Google')throw Error('session_extraction_model_mismatch');
 if(result.choices?.length!==1||result.choices[0].finish_reason!=='stop')throw Error('session_extraction_incomplete_output');
 return parseSessionExtractionResponse(packet,result);
}
export function parseSessionExtractionResponse(packet,result){
 if(result.model!==SESSION_EXTRACTION_MODEL||result.provider!=='Google'||result.choices?.length!==1||result.choices[0].finish_reason!=='stop')throw Error('session_extraction_incomplete_output');
 const raw=JSON.parse(result.choices[0].message.content);
 const candidates=expandSelections(raw,packet);
 const usage=result.usage??{};if(!Number.isSafeInteger(usage.prompt_tokens)||!Number.isSafeInteger(usage.completion_tokens)||usage.prompt_tokens<0||usage.completion_tokens<0||usage.prompt_tokens>MAX_INPUT||usage.completion_tokens>MAX_OUTPUT)throw Error('session_extraction_usage_invalid');
 return {candidates,usage:{input_tokens:usage.prompt_tokens,output_tokens:usage.completion_tokens,cost_usd:typeof usage.cost==='number'?usage.cost:null},model:result.model,provider:result.provider,finish_reason:'stop'};
}
export async function inspectSessionExtraction({queueDir,tenantId='default',projectId}){
 const db=openQueue(queueDir);try{return db.prepare("SELECT id,status,created_at,charged,error,NULL AS held_span_count,NULL AS source_hash FROM jobs WHERE tenant_id=? AND project_id=? UNION ALL SELECT id,'input_held' AS status,created_at,0 AS charged,reason AS error,span_count AS held_span_count,source_hash FROM input_holds WHERE tenant_id=? AND project_id=? ORDER BY created_at").all(tenantId,projectId,tenantId,projectId);}finally{db.close();}
}
export async function drainSessionExtraction(options={}){
 const env=options.env??process.env;
 if(!allowed(options.projectId,env))return {processed:0,saved:0,failed:0,status:'project_not_allowlisted'};
 if(!env.OPENROUTER_API_KEY)return {processed:0,saved:0,failed:0,status:'model_unavailable'};
 const token=acquireWorker(options);if(!token)return {processed:0,saved:0,failed:0,status:'worker_busy'};
 let report={processed:0,saved:0,failed:1,status:'worker_failed',error:'worker_exception'};
 try{report=await drainSessionExtractionBatch(options);return report;}
 finally{
  const pending=releaseWorker(options,token,report);
  if(pending&&!['budget_exhausted','model_unavailable','worker_failed','held'].includes(report.status)&&sessionExtractionAutorunEnabled(env)){
   report.continuation=await (options.wakeImpl??wakeSessionExtraction)({...options,env});
  }
 }
}
async function drainSessionExtractionBatch({queueDir,dbPath,tenantId='default',projectId,env=process.env,fetchImpl=fetch,limit=20}){
 if(!allowed(projectId,env))return {processed:0,saved:0,failed:0,status:'project_not_allowlisted'};
 if(!env.OPENROUTER_API_KEY)return {processed:0,saved:0,failed:0,status:'model_unavailable'};
 const targetDb=dbPath??env.ORGBRAIN_LOCAL_DB??(await import('./local-memory-store.mjs')).DEFAULT_LOCAL_DB;
 const store=new TaskCommitmentStore(targetDb);const db=openQueue(queueDir);const report={processed:0,saved:0,failed:0,status:'idle',usage:[],rejections:[]};
 try{
  const jobs=db.prepare("SELECT * FROM jobs WHERE tenant_id=? AND project_id=? AND status IN ('pending','generated') ORDER BY created_at LIMIT ?").all(tenantId,projectId,Math.max(1,Math.min(100,Number(limit)||20)));
  for(const job of jobs){
   let generated=job.result_json?JSON.parse(job.result_json):null;
   const packet=JSON.parse(job.packet_json);if(hash(packet)!==job.packet_hash||packet.policy!==SESSION_EXTRACTION_POLICY||job.policy_hash!==policyHash()||packet.project_id!==projectId||packet.tenant_id!==tenantId){db.prepare("UPDATE jobs SET status='held',error='policy_or_packet_mismatch' WHERE id=?").run(job.id);report.failed++;continue;}
   if(!generated){
    const month=new Date().toISOString().slice(0,7);
    db.exec('BEGIN IMMEDIATE');const used=Number(db.prepare('SELECT COALESCE(SUM(charged),0) AS n FROM jobs WHERE tenant_id=? AND month=?').get(tenantId,month).n);
    if(used+MAX_INPUT+MAX_OUTPUT>MONTHLY_TOKENS){db.exec('ROLLBACK');report.status='budget_exhausted';break;}
    const claimed=db.prepare("UPDATE jobs SET status='running',charged=?,month=? WHERE id=? AND status='pending'").run(MAX_INPUT+MAX_OUTPUT,month,job.id).changes;db.exec('COMMIT');if(!claimed)continue;
    try{generated=await generateSessionExtraction(packet,{env,fetchImpl});db.prepare("UPDATE jobs SET status='generated',result_json=? WHERE id=? AND status='running'").run(JSON.stringify(generated),job.id);}
    catch(error){db.prepare("UPDATE jobs SET status='held',error=? WHERE id=? AND status='running'").run(String(error?.message).slice(0,120),job.id);report.failed++;report.status='held';break;}
   }
   const result=await verifiedCandidates({packet,project_id:projectId,run_id:job.id},generated.candidates);
   const candidates=result.candidates.map((c,i)=>({...c,...(generated.candidates[result.accepted_indices[i]]?.lesson_tags?{lesson_tags:generated.candidates[result.accepted_indices[i]].lesson_tags}:{}),automatic_promotion:false,source_client:job.client,extraction_model:SESSION_EXTRACTION_MODEL,extraction_effort:SESSION_EXTRACTION_EFFORT}));
   const saved=await store.saveLearningCandidates({tenantId,projectId,taskKey:`session-extraction:${job.id}`,candidates,requireExactBody:true,autoSaveClassified:classifiedAutoSaveEnabled(env),sourcePacket:{...packet,source_hash:job.packet_hash}});
   const held=saved.filter(s=>s.status==='held');
   db.prepare("UPDATE jobs SET status='completed',charged=?,error=NULL WHERE id=?").run(generated.usage.input_tokens+generated.usage.output_tokens,job.id);
   if(saved.some(s=>s.status==='quarantine')){
    const {LocalMemoryStore}=await import('./local-memory-store.mjs');
    const {enqueueMemoryPipelineSource,wakeMemoryPipeline}=await import('./memory-pipeline.mjs');
    const memoryStore=new LocalMemoryStore(targetDb);
    await enqueueMemoryPipelineSource(memoryStore,{tenantId,projectId,env,selector:{source:'session',job_id:job.id}});
    await wakeMemoryPipeline(memoryStore,{tenantId,projectId,env});
   }
   report.processed++;report.saved+=saved.filter(s=>['quarantine','active'].includes(s.status)).length;report.active=(report.active??0)+saved.filter(s=>s.status==='active').length;report.usage.push(generated.usage);
   report.rejections.push(...result.rejections,...held.map(s=>({reason_codes:[s.reason_code]})));
   if(held.length)report.status='completed_with_held_candidates';else if(report.status==='idle')report.status='completed';
  }
 }finally{db.close();}
 return report;
}

export async function drainConfiguredSessionExtraction(options={}){
 const env=options.env??process.env;const projects=[...new Set(String(env.ORGBRAIN_SESSION_EXTRACTION_PROJECTS??'').split(',').map(s=>s.trim()).filter(Boolean))];
 const total={processed:0,saved:0,failed:0,status:'idle',projects:[]};const limit=Math.max(1,Math.min(100,Number(options.limit)||20));
 for(const projectId of projects){const remaining=limit-total.processed-total.failed;if(remaining<=0)break;
  const r=await drainSessionExtraction({...options,env,projectId,limit:remaining});total.projects.push({project_id:projectId,...r});total.processed+=r.processed;total.saved+=r.saved;total.failed+=r.failed;
  if(r.status!=='idle')total.status=r.status;if(r.status==='budget_exhausted')break;
 }return total;
}
