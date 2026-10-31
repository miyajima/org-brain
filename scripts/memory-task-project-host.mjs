// Local host bridge for a real human's native UI answer. Never invokes a model.
import {readFile,realpath,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {LocalMemoryStore} from '../packages/orgbrain-cli/src/lib/local-memory-store.mjs';
import {MemoryReuse} from '../packages/orgbrain-cli/src/lib/memory-reuse.mjs';
import {prepareLocalTask,answerLocalTask,primeLocalTaskSource,taskCompletion,localTaskSourceEnvelope} from '../packages/orgbrain-cli/src/lib/memory-reuse-task-confirmation.mjs';
import {appendWorkObservation} from '../packages/orgbrain-cli/src/lib/memory-task-observation.mjs';
const [operation,requestPath,answerPath]=process.argv.slice(2),root=await realpath(resolve(process.env.ORGBRAIN_REUSE_ROOT||process.cwd())),config=JSON.parse(await readFile(join(root,'.local/memory-reuse/config.json'),'utf8')),request=JSON.parse(await readFile(requestPath,'utf8'));
if(config.observation_purpose==='test')throw Error('real_host_bridge_not_for_simulated_answers');
const store=new LocalMemoryStore(config.db_path,{denseEmbeddingProvider:null,memoryJudge:null,relevanceSelector:null}),reuse=new MemoryReuse(store,{tenant_id:config.tenant_id,project_id:config.project_id,principal_id:process.env.ORGBRAIN_USE_PRINCIPAL||'local',work_type:'implementation'});
const word=s=>/^[\w./:-]+$/u.test(s)?s:"'"+s.replaceAll("'","'\\''")+"'",prefix=[process.execPath,fileURLToPath(new URL('./memory-reuse-claude.mjs',import.meta.url))].map(word).join(' '),input={session_id:request.session_id,prompt:request.prompt},args={root,reuse,config,input,prefix,condition:request.comparison_condition??'reuse'};
const start=performance.now();
async function packet(){const envelope=await localTaskSourceEnvelope(args),directory=join(root,'.local/memory-reuse/source-envelopes'),path=join(directory,input.session_id+'.txt');await mkdir(directory,{recursive:true,mode:0o700});await writeFile(path,envelope.content,{mode:0o600,flag:'wx'});return {source_envelope_path:path,source_envelope_digest:envelope.digest};}
if(operation==='prepare'){
 const offer=await prepareLocalTask(args);let source=null;if(!offer.question)source=await primeLocalTaskSource(args);
 await appendWorkObservation(root,{session_id:input.session_id,event:'prepared',purpose:'task',origin:request.observation_origin??'solicited',condition:args.condition,workflow_id:offer.state.workflow_id,kind:offer.state.kind,model_starts:0});
 console.log(JSON.stringify({session_id:input.session_id,question:offer.question,workflow_id:offer.state.workflow_id,requested_units:offer.state.requested_units,gaps:offer.state.gaps??[],source_receipt_id:source?.id??null,...(source?await packet():{}),prepared_ms:performance.now()-start,model_starts:0}));
}else if(operation==='answer'||operation==='scenario-answer'){
 const scenario=operation==='scenario-answer',receipt=JSON.parse(await readFile(answerPath,'utf8'));if(receipt.provenance!==(scenario?'user_requested_scenario':'native_user_answer')||scenario&&receipt.raw_user_instruction!=='全パターン実行して'||receipt.session_id!==input.session_id||!Number.isFinite(receipt.response_window_ms)||receipt.response_window_ms<0)throw Error('actual_user_answer_receipt_required');
 if(receipt.human_active_ms!==undefined&&receipt.human_active_ms!==null&&(!Number.isFinite(receipt.human_active_ms)||receipt.human_active_ms<0||receipt.human_active_ms>receipt.response_window_ms))throw Error('invalid_human_active_time');
 const evidence={source:'native_question_answer',call_id:receipt.question_call_id,session_id:input.session_id,answer:receipt.answer,question_digest:receipt.question_digest};
 const decision=await answerLocalTask({...args,...(scenario?{config:{...config,observation_purpose:'test'}}:{}),answer:receipt.answer,selected_units:receipt.selected_units,...(scenario?{}:{confirmation_evidence:evidence})});
 const observation={session_id:input.session_id,event:decision.pending?'cancelled':'confirmed',purpose:scenario?'test':'task',origin:request.observation_origin??'solicited',condition:args.condition,choice:decision.choice??null,confirmation_elapsed_ms:scenario?null:receipt.response_window_ms,human_active_ms:scenario?null:receipt.human_active_ms??null,human_time_source:scenario?'user_requested_scenario':'native_ui_response_window',human_timing_group_id:receipt.question_call_id,model_starts:0};
 await appendWorkObservation(root,observation);
 if(decision.pending){console.log(JSON.stringify({pending:true,model_starts:0}));process.exit(0);}
 if(decision.choice==='existing'){
  const completion=await taskCompletion({...args,session_id:input.session_id});await appendWorkObservation(root,{...observation,event:'completed_existing',confirmation_elapsed_ms:undefined,human_active_ms:undefined,completion,session_elapsed_ms:performance.now()-start+receipt.response_window_ms});console.log(JSON.stringify({decision,completion,prepared_ms:performance.now()-start,model_starts:0}));
 }else{const source=await primeLocalTaskSource(args);console.log(JSON.stringify({decision,source_receipt_id:source.id,...await packet(),prepared_ms:performance.now()-start,model_starts:0}));}
}else if(operation==='model-start'){
 await appendWorkObservation(root,{session_id:input.session_id,event:'model_start_attempt',purpose:'task',origin:request.observation_origin??'solicited',condition:args.condition,model_starts:1});console.log(JSON.stringify({recorded:true,model_starts:0}));
}else throw Error('use_prepare_or_answer');
