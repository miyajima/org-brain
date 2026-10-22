import {randomUUID} from 'node:crypto';
import {runMemoryPipeline,pipelineStatus,configureMemoryPipeline,pipelineBudgetCall,initMemoryPipeline,wakeMemoryPipeline} from './memory-pipeline.mjs';
import {loadSessionPipelineSource,loadSessionPipelinePacket,loadWikiPipelineSource} from './memory-pipeline-sources.mjs';
import {createOpenRouterPipelineJudge,createOpenRouterPipelineExtractor,reviewPipelineCandidate,DEFAULT_PIPELINE_REVIEW_MODELS} from './memory-pipeline-review.mjs';
import {wikiServiceForStore} from './wiki-service.mjs';
import {initLocalMemoryUseAssessment,recordLocalMemoryUseAssessment,readLocalMemoryUseAssessments} from './memory-use-assessment.mjs';
import {readMemoryUseTurnEvidence} from './memory-learning-transcript.mjs';
import {collectMemoryUse} from './memory-use-collector.mjs';

export async function handleUseAssessment(store,action,input){
 await store.init();const db=store.open();try{initLocalMemoryUseAssessment(db);
  const scope={tenantId:input.tenant_id??'default',principal:input.principal_id??'local',projectId:input.project_id,taskId:input.task_id};
  if(action==='assessments')return {assessments:readLocalMemoryUseAssessments(db,scope)};
  return await recordLocalMemoryUseAssessment(db,{...scope,id:input.id??randomUUID(),usageEventId:input.usage_id,usageItemId:input.usage_item_id,sourceVersion:input.source_version,state:input.state,reasonCode:input.reason_code,actionContextId:input.action_context_id,supersedesId:input.supersedes_id});
 }finally{db.close();}
}
export async function handleUseCollect(store,input){
 const evidence=await readMemoryUseTurnEvidence({transcriptPath:input.transcript_path,turnId:input.turn_id});
 return collectMemoryUse(store,{...evidence,readReason:evidence.reason,tenantId:input.tenant_id??'default',projectId:input.project_id,taskId:input.task_id,turnId:input.turn_id,principal:input.principal_id??'local'});
}
export async function runSelectedPipeline(store,input,{env=process.env,extractorFactory=createOpenRouterPipelineExtractor,judgeFactory=createOpenRouterPipelineJudge}={}){
 const tenantId=input.tenant_id??'default',projectId=input.project_id;if(!projectId)throw Error('pipeline_project_required');
 const reload=async()=>{
  if(input.source==='session'&&input.job_id)return loadSessionPipelinePacket({queueDir:input.queue_dir,tenantId,projectId,jobId:input.job_id});
  if(input.source==='session'){await store.init();const db=store.open();try{return await loadSessionPipelineSource({db,queueDir:input.queue_dir,tenantId,projectId,candidateId:input.candidate_id});}finally{db.close();}}
  if(input.source==='wiki')return loadWikiPipelineSource({wikiService:wikiServiceForStore(store),path:input.path,pageId:input.page_id,expectedHash:input.expected_hash,tenantId,projectId});
  throw Error('pipeline_source_unsupported');
 };
 const snapshot=await reload();
 const budget=(args,run)=>pipelineBudgetCall({queueDir:input.queue_dir,env,tenantId,projectId,reserve:Buffer.byteLength(JSON.stringify(args),'utf8')+12000,run});
 let extractor,judge;
 const getExtractor=()=>extractor??=extractorFactory({apiKey:env.OPENROUTER_API_KEY});
 const getJudge=()=>judge??=judgeFactory({apiKey:env.OPENROUTER_API_KEY,modelByProfile:DEFAULT_PIPELINE_REVIEW_MODELS});
 const result=await runMemoryPipeline({store,snapshot,reload,
  extract:args=>{const infer=getExtractor();return budget(args,()=>infer(args));},
  review:args=>reviewPipelineCandidate({...args,runJudge:profile=>{const infer=getJudge();return budget(profile,()=>infer(profile));}}),
 });
 if(result.status!=='active'||result.replayed)return result;
 const pending=(reason)=>{
  const configured=store.denseEmbeddingProvider,details={};
  if(typeof configured?.provider==='string'&&configured.provider.trim())details.provider=configured.provider;
  if(Number.isSafeInteger(configured?.dimensions)&&configured.dimensions>0)details.dimensions=configured.dimensions;
  return {...result,dense_projection:{state:'pending',reason,...details}};
 };
 if(typeof result.memory_id!=='string'||!result.memory_id)return pending('memory_id_unavailable');
 if(!store.denseEmbeddingProvider)return pending('not_configured');
 try{
  const projection=await store.rebuildDenseEmbeddings({tenant_id:tenantId,project_id:projectId,memory_ids:[result.memory_id]});
  if(!Number.isSafeInteger(projection?.indexed)||projection.indexed<1)return pending(projection?.indexed===0?'no_units_indexed':'index_count_unavailable');
  if(typeof projection.provider!=='string'||!projection.provider.trim()||!Number.isSafeInteger(projection.dimensions)||projection.dimensions<1)return pending('projection_metadata_unavailable');
  return {...result,dense_projection:{state:'indexed',provider:projection.provider,dimensions:projection.dimensions,indexed:projection.indexed}};
 }catch{
  return pending('projection_failed');
 }
}
export async function handlePipelineCLI(store,action,input){
 if(action==='status')return pipelineStatus(store,{tenantId:input.tenant_id??'default',projectId:input.project_id??null});
 if(action==='configure')return configureMemoryPipeline(store,input.project_id,input.enabled,input.tenant_id??'default');
 if(action==='run'&&input.source)return runSelectedPipeline(store,input);
 if(action==='run')return drainMemoryPipeline(store,input);
 throw Error('pipeline_action_invalid');
}

export async function drainMemoryPipeline(store,input,{runSelected=runSelectedPipeline,limit=3}={}){
 const runs=[];let blocked=false;
 for(let n=0;n<Math.max(1,Math.min(3,limit));n++){
  await store.init();const db=store.open();let selected;
  try{initMemoryPipeline(db);db.exec('BEGIN IMMEDIATE');selected=db.prepare("SELECT q.* FROM memory_pipeline_queue q JOIN memory_pipeline_settings s ON s.tenant_id=q.tenant_id AND s.project_id=q.project_id AND s.enabled=1 WHERE q.tenant_id=? AND q.project_id=? AND q.status='pending' ORDER BY q.created_at LIMIT 1").get(input.tenant_id??'default',input.project_id);if(selected)db.prepare("UPDATE memory_pipeline_queue SET status='running' WHERE id=?").run(selected.id);db.exec('COMMIT');}finally{db.close();}
  if(!selected)break;
  try{const r=await runSelected(store,{...JSON.parse(selected.selector_json),tenant_id:selected.tenant_id,project_id:selected.project_id});const update=store.open();try{update.prepare('UPDATE memory_pipeline_queue SET status=? WHERE id=?').run(r.status,selected.id);}finally{update.close();}runs.push(r);if(r.status==='held'||r.review?.reason_codes?.includes('judge_call_failed')){blocked=true;break;}}
  catch(error){const update=store.open();try{update.prepare("UPDATE memory_pipeline_queue SET status='held',error=? WHERE id=?").run(String(error.message).slice(0,120),selected.id);}finally{update.close();}throw error;}

 }
 const continuation=!blocked&&runs.length===3?await wakeMemoryPipeline(store,{tenantId:input.tenant_id??'default',projectId:input.project_id}):null;
 return {status:runs.length?'completed':'idle',processed:runs.length,runs,continuation};
}
