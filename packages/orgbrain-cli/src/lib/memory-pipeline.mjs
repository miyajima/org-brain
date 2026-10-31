// Explicit, source-bound admission. This does not change global autonomy policy
// or turn historical assistant reports into execution or human-approval evidence.
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {spawn} from 'node:child_process';
import {verifyPipelineReviewReceipt,MEMORY_PIPELINE_REVIEW_POLICY_HASH,getPipelineReviewPolicyDescriptor} from './memory-pipeline-review.mjs';
import {screenSensitiveMemory} from '../../../shared/src/memory-capture-v2-runtime.mjs';
import {classifiedAutoSaveEnabled,CLASSIFIED_AUTO_POLICY,classifySourceMemory} from './memory-classified-autosave.mjs';
export const pipelineHash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function initMemoryPipeline(db){db.exec(`CREATE TABLE IF NOT EXISTS memory_pipeline_runs(
 id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,project_id TEXT NOT NULL,source_key TEXT NOT NULL,source_hash TEXT NOT NULL,
 policy TEXT NOT NULL,status TEXT NOT NULL,snapshot_json TEXT NOT NULL,candidate_json TEXT,review_json TEXT,
 memory_id TEXT,error TEXT,created_at INTEGER NOT NULL,completed_at INTEGER,
 UNIQUE(tenant_id,project_id,source_key,source_hash,policy));
 CREATE TABLE IF NOT EXISTS memory_pipeline_queue(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,project_id TEXT NOT NULL,
 selector_json TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,error TEXT);
 CREATE TABLE IF NOT EXISTS memory_pipeline_settings(tenant_id TEXT NOT NULL,project_id TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(tenant_id,project_id));`);
 if(!db.prepare('PRAGMA table_info(memory_pipeline_runs)').all().some(c=>c.name==='policy_descriptor_json'))db.exec('ALTER TABLE memory_pipeline_runs ADD COLUMN policy_descriptor_json TEXT');
}
const POLICY=`source-review/v2:${MEMORY_PIPELINE_REVIEW_POLICY_HASH}`;
export async function pipelineStatus(store,{tenantId='default',projectId=null}={}){
 await store.init();const db=store.open();try{initMemoryPipeline(db);return {policy:classifiedAutoSaveEnabled()?CLASSIFIED_AUTO_POLICY:POLICY,
 settings:db.prepare('SELECT * FROM memory_pipeline_settings WHERE tenant_id=?').all(tenantId),
 runs:db.prepare('SELECT id,project_id,source_key,source_hash,status,memory_id,error,created_at,completed_at FROM memory_pipeline_runs WHERE tenant_id=? AND (? IS NULL OR project_id=?) ORDER BY created_at DESC LIMIT 100').all(tenantId,projectId,projectId),
 queue:db.prepare('SELECT id,project_id,status,error FROM memory_pipeline_queue WHERE tenant_id=? AND (? IS NULL OR project_id=?) ORDER BY created_at DESC LIMIT 100').all(tenantId,projectId,projectId)};}finally{db.close();}}
export async function configureMemoryPipeline(store,projectId,enabled,tenantId='default'){if(!projectId||typeof enabled!=='boolean')throw Error('pipeline_configuration_invalid');await store.init();const db=store.open();try{initMemoryPipeline(db);db.prepare('INSERT INTO memory_pipeline_settings VALUES(?,?,?) ON CONFLICT(tenant_id,project_id) DO UPDATE SET enabled=excluded.enabled').run(tenantId,projectId,enabled?1:0);return {project_id:projectId,enabled};}finally{db.close();}}
export async function enqueueMemoryPipelineSource(store,{tenantId='default',projectId,selector,env=process.env}){
 await store.init();const db=store.open();try{initMemoryPipeline(db);if(!db.prepare('SELECT enabled FROM memory_pipeline_settings WHERE tenant_id=? AND project_id=?').get(tenantId,projectId)?.enabled)return {queued:false,reason:'disabled'};
 const id=pipelineHash({tenantId,projectId,selector,policy:classifiedAutoSaveEnabled(env)?CLASSIFIED_AUTO_POLICY:POLICY});const r=db.prepare("INSERT OR IGNORE INTO memory_pipeline_queue VALUES(?,?,?,?,'pending',?,NULL)").run(id,tenantId,projectId,JSON.stringify(selector),Date.now());return {queued:Boolean(r.changes),id};}finally{db.close();}}
export async function wakeMemoryPipeline(store,{tenantId='default',projectId,env=process.env,spawnImpl=spawn,cliPath=process.argv[1]}={}){
 await store.init();const db=store.open();try{initMemoryPipeline(db);
  if(!db.prepare('SELECT enabled FROM memory_pipeline_settings WHERE tenant_id=? AND project_id=?').get(tenantId,projectId)?.enabled)return {started:false,reason:'disabled'};
  if(!db.prepare("SELECT 1 FROM memory_pipeline_queue WHERE tenant_id=? AND project_id=? AND status='pending' LIMIT 1").get(tenantId,projectId))return {started:false,reason:'idle'};
  if(!cliPath||!env.OPENROUTER_API_KEY)return {started:false,reason:'reviewer_unavailable'};
  const child=spawnImpl(process.execPath,[cliPath,'pipeline','run','--json',JSON.stringify({tenant_id:tenantId,project_id:projectId}),'--db',store.dbPath],{detached:true,stdio:'ignore',env});child.on('error',()=>{});child.unref();return {started:true,pid:child.pid??null};
 }finally{db.close();}
}
function normalizedCandidate(c,snapshot){
 const keys=['content','rationale','reuse_rule','kind','support_refs'];
 if(!c||Object.keys(c).some(k=>!keys.includes(k))||!['fact','constraint','pitfall'].includes(c.kind)||['content','rationale','reuse_rule'].some(k=>typeof c[k]!=='string'||!c[k].trim()||c[k].length>2000)||!Array.isArray(c.support_refs)||!c.support_refs.length||c.support_refs.length>8||c.support_refs.some(x=>typeof x!=='string'||x.length>256))throw Error('pipeline_candidate_invalid');
 // References must occur in the selected immutable snapshot, not invented URLs.
 const original=JSON.stringify(snapshot);if(c.support_refs.some(ref=>!original.includes(ref)))throw Error('pipeline_support_ref_invalid');
 if(/(?:Bearer\s+[a-z0-9._-]{16,}|-----BEGIN .*PRIVATE KEY|\/Users\/[^\s/]+)/iu.test(JSON.stringify(c)))throw Error('pipeline_sensitive_candidate');
 return c;
}
export async function runMemoryPipeline({store,snapshot,extract,review,reload,autoSaveClassified=false}){
 if(!snapshot?.tenant_id||!snapshot?.project_id||!snapshot.source_key||!snapshot.source_hash||!['session_extraction','personal_wiki'].includes(snapshot.source_type))throw Error('pipeline_source_invalid');
 await store.init();const db=store.open();let id,owned=false;
 try{
  const policy=autoSaveClassified?CLASSIFIED_AUTO_POLICY:POLICY;
  initMemoryPipeline(db);id=pipelineHash({tenant:snapshot.tenant_id,project:snapshot.project_id,key:snapshot.source_key,hash:snapshot.source_hash,policy});
  if(autoSaveClassified){
   const active=db.prepare("SELECT id,status,memory_id,error FROM memory_pipeline_runs WHERE tenant_id=? AND project_id=? AND source_key=? AND source_hash=? AND status='active' AND policy=? ORDER BY completed_at DESC LIMIT 1").get(snapshot.tenant_id,snapshot.project_id,snapshot.source_key,snapshot.source_hash,POLICY);
   if(active)return {...active,replayed:true};
  }
  const prior=db.prepare('SELECT id,status,memory_id,error FROM memory_pipeline_runs WHERE id=?').get(id);if(prior)return {...prior,replayed:true};
  const claim=db.prepare("INSERT OR IGNORE INTO memory_pipeline_runs(id,tenant_id,project_id,source_key,source_hash,policy,status,snapshot_json,created_at,policy_descriptor_json) VALUES(?,?,?,?,?,?,'extracting',?,?,?)").run(id,snapshot.tenant_id,snapshot.project_id,snapshot.source_key,snapshot.source_hash,policy,JSON.stringify(snapshot),Date.now(),JSON.stringify(autoSaveClassified?{schema:policy}:getPipelineReviewPolicyDescriptor()));
  if(!claim.changes)return {...db.prepare('SELECT id,status,memory_id,error FROM memory_pipeline_runs WHERE id=?').get(id),replayed:true};owned=true;
  if(!autoSaveClassified&&snapshot.source_type==='session_extraction'&&snapshot.authorship!=='verified'&&snapshot.observation?.lesson_type==='decision')throw Error('pipeline_decision_authority_unverified');
  if(snapshot.source_type==='session_extraction'&&snapshot.job_id&&!snapshot.snippets?.some(s=>s.source==='tool_result'))throw Error('pipeline_technical_source_required');
  const generated=await extract({snapshot});
  if(generated.candidate===null){db.prepare("UPDATE memory_pipeline_runs SET status='abstained',completed_at=? WHERE id=?").run(Date.now(),id);return {id,status:'abstained'};}
  if(!screenSensitiveMemory(JSON.stringify(generated.candidate),{mode:'deny',allowed_principals:[]}).allowed)throw Error('pipeline_sensitive_candidate');
  if(autoSaveClassified&&!["fact","constraint","pitfall"].includes(generated.candidate?.kind)){
   db.prepare("UPDATE memory_pipeline_runs SET status='reviewing',candidate_json=?,error='classification_ambiguous' WHERE id=?").run(JSON.stringify(generated),id);
   return {id,status:'reviewing',reason_code:'classification_ambiguous'};
  }
  const candidate=normalizedCandidate(generated.candidate,snapshot);
  if(!autoSaveClassified&&candidate.kind==='constraint'&&snapshot.authorship!=='verified')throw Error('pipeline_constraint_authority_unverified');
  if(snapshot.source_type==='session_extraction'&&snapshot.job_id&&!snapshot.snippets.some(s=>s.source==='tool_result'&&candidate.support_refs.includes(s.span_id)))throw Error('pipeline_technical_support_required');
  db.prepare("UPDATE memory_pipeline_runs SET status='reviewing',candidate_json=? WHERE id=?").run(JSON.stringify({candidate,extraction:generated}),id);
  const verdict=autoSaveClassified?null:await review({snapshot,candidate});db.prepare('UPDATE memory_pipeline_runs SET review_json=? WHERE id=?').run(verdict?JSON.stringify(verdict):null,id);
  if(verdict&&!verdict.accepted){db.prepare("UPDATE memory_pipeline_runs SET status='rejected',completed_at=? WHERE id=?").run(Date.now(),id);return {id,status:'rejected',review:verdict};}
  const current=await reload();if(current.source_hash!==snapshot.source_hash)throw Error('pipeline_source_changed');
  // Review adapters alone can issue this receipt after actual bounded responses.
  if(!autoSaveClassified&&!verifyPipelineReviewReceipt(verdict,{snapshot,candidate}))throw Error('pipeline_review_receipt_invalid');
  let input={tenant_id:snapshot.tenant_id,project_id:snapshot.project_id,work_type:'implementation',kind:candidate.kind,scope_type:'project',scope_key:snapshot.project_id,
   lifecycle_state:'active',content:candidate.content,summary:candidate.content,rationale:candidate.rationale,reuse_rule:candidate.reuse_rule,
   source:autoSaveClassified?'classified-auto':snapshot.source_type==='personal_wiki'?'llm-wiki-reviewed':'session-reviewed',external_key:`memory-pipeline:${id}`,tags:[autoSaveClassified?'classified-auto':'source-reviewed'],entities:[],permissions:[],conflicts:[],
   source_references:candidate.support_refs.map(ref=>({type:snapshot.source_type,ref,content_hash:snapshot.source_hash})),
   evidence:verdict?[{type:'source-review',ref:`pipeline:${id}`,content_hash:verdict.receipt_hash}]:[],capture_origin:'observed',capture_route:'repair',verification_state:autoSaveClassified?'unverified':'verified',verified_at:autoSaveClassified?null:Date.now(),
   learning:{schema_version:2,verification_scope:autoSaveClassified?'classification_only':'source_grounding_and_review',historical_execution_verified:false,contract_metadata:{pipeline_id:id,...(verdict?{review_receipt_hash:verdict.receipt_hash}:{})}}};
  if(autoSaveClassified)input=classifySourceMemory(input,{snapshot,candidate});
  // Same DB transaction makes admission and the receipt atomic. Store creates
  // all retrieval projections; no direct INSERT into memories is used.
  db.exec('BEGIN IMMEDIATE');try{
   const saved=store.captureIntoDatabase(db,input);const memoryId=saved.memory_id??saved.memory?.id??saved.id;if(!memoryId)throw Error('pipeline_capture_missing_id');
   db.prepare("UPDATE memory_pipeline_runs SET status='active',memory_id=?,completed_at=? WHERE id=?").run(memoryId,Date.now(),id);db.exec('COMMIT');
   return {id,status:'active',memory_id:memoryId,verification_scope:input.learning.verification_scope};
  }catch(error){db.exec('ROLLBACK');throw error;}
 }catch(error){if(owned)db.prepare("UPDATE memory_pipeline_runs SET status='held',error=?,completed_at=? WHERE id=? AND status!='active'").run(String(error.message).replace(/[^a-z0-9_: -]/giu,'').slice(0,160),Date.now(),id);throw error;}finally{db.close();}
}

// Shares the extraction worker's monthly ledger; unknown calls retain the full
// reservation. A rejected judgment is still charged, never counted as zero.
export function resolvePipelineQueueDir({queueDir,env=process.env}={}){return queueDir??env.ORGBRAIN_SESSION_EXTRACTION_QUEUE??join(homedir(),'.org-brain/session-extraction');}
export async function pipelineBudgetCall({queueDir,env=process.env,tenantId='default',projectId,reserve=26000,run}){
 const db=new DatabaseSync(join(resolvePipelineQueueDir({queueDir,env}),'queue.sqlite'));const id=`pipeline:${randomUUID()}`,month=new Date().toISOString().slice(0,7);
 try{db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');const used=db.prepare('SELECT COALESCE(SUM(charged),0) n FROM jobs WHERE tenant_id=? AND month=?').get(tenantId,month).n;
  if(!Number.isSafeInteger(reserve)||reserve<1||used+reserve>500000){db.exec('ROLLBACK');throw Error('pipeline_monthly_budget_exhausted');}
  db.prepare("INSERT INTO jobs(id,tenant_id,project_id,client,packet_json,packet_hash,status,created_at,month,charged) VALUES(?,?,?,'pipeline','{}',?,'pipeline_running',?,?,?)").run(id,tenantId,projectId,pipelineHash({id}),Date.now(),month,reserve);db.exec('COMMIT');
  try{const result=await run();const u=result.usage;if(!u||!Number.isSafeInteger(u.input_tokens)||!Number.isSafeInteger(u.output_tokens)||u.input_tokens<0||u.output_tokens<0||u.input_tokens+u.output_tokens>reserve)throw Error('pipeline_usage_unavailable_or_exceeds_reservation');
   db.prepare("UPDATE jobs SET status='pipeline_completed',charged=? WHERE id=?").run(u.input_tokens+u.output_tokens,id);return result;
  }catch(error){db.prepare("UPDATE jobs SET status='pipeline_held',error='review_or_usage_unavailable' WHERE id=?").run(id);throw error;}
 }finally{db.close();}
}
