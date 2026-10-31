// Project-local launcher. Only the terminal (or an explicit test participant) answers.
import {readFile,writeFile,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline/promises';
import {spawn} from 'node:child_process';
import {LocalMemoryStore} from '../packages/orgbrain-cli/src/lib/local-memory-store.mjs';
import {MemoryReuse} from '../packages/orgbrain-cli/src/lib/memory-reuse.mjs';
import {prepareLocalTask,answerLocalTask,primeLocalTaskSource,taskCompletion,localTaskSourceEnvelope} from '../packages/orgbrain-cli/src/lib/memory-reuse-task-confirmation.mjs';
import {appendWorkObservation,confirmationTiming} from '../packages/orgbrain-cli/src/lib/memory-task-observation.mjs';

const argv=process.argv.slice(2),requestIndex=argv.indexOf('--request'),simulateIndex=argv.indexOf('--simulate-answer'),prepareOnly=argv.includes('--prepare-only');
if(requestIndex<0||!argv[requestIndex+1])throw Error('Use --request FILE with {session_id,prompt}; --prepare-only never starts a model.');
const root=await realpath(resolve(process.env.ORGBRAIN_REUSE_ROOT||process.cwd())),config=JSON.parse(await readFile(join(root,'.local/memory-reuse/config.json'),'utf8'));
const request=JSON.parse(await readFile(argv[requestIndex+1],'utf8')),input={session_id:request.session_id??randomUUID(),prompt:request.prompt};
if(typeof input.prompt!=='string'||!input.prompt||Buffer.byteLength(input.prompt)>32768)throw Error('invalid_local_task_prompt');
const simulated=simulateIndex>=0;
if(simulated&&(process.env.ORGBRAIN_TASK_EVAL_SIMULATION!=='1'||config.observation_purpose!=='test'))throw Error('simulated_answers_require_explicit_test_scope');
if(!simulated&&config.observation_purpose==='test')throw Error('test_configuration_requires_explicit_simulation');
const store=new LocalMemoryStore(config.db_path,{denseEmbeddingProvider:null,memoryJudge:null,relevanceSelector:null});
const reuse=new MemoryReuse(store,{tenant_id:config.tenant_id,project_id:config.project_id,principal_id:process.env.ORGBRAIN_USE_PRINCIPAL||'local',work_type:'implementation'});
const helper=fileURLToPath(new URL('./memory-reuse-claude.mjs',import.meta.url)),quote=s=>"'"+s.replaceAll("'","'\\''")+"'",word=s=>/^[\w./:-]+$/u.test(s)?s:quote(s),prefix=[process.execPath,helper].map(word).join(' ');
const condition=argv.includes('--control')?'control':'reuse',args={root,reuse,config,input,prefix,condition},started=performance.now();let humanWaitMs=0,timing={confirmation_elapsed_ms:null,human_active_ms:null,human_time_source:'no_question'};
const observation={session_id:input.session_id,workflow_id:null,condition,purpose:simulated?'test':'task',origin:request.observation_origin==='solicited'?'solicited':'organic'};
const offer=await prepareLocalTask(args);
observation.workflow_id=offer.state.workflow_id;observation.kind=offer.state.kind;
if(offer.question){
 let answer,selected_units;
 if(simulated)answer=argv[simulateIndex+1];
 else{
  if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('local_task_requires_interactive_terminal');
  const waiting=performance.now();console.log(offer.question.question);offer.question.options.forEach((o,i)=>console.log(`${i+1}. ${o.label}: ${o.description}`));
  const terminal=createInterface({input:process.stdin,output:process.stdout});
  try{
   const value=(await terminal.question('選択番号（空欄で中止）: ')).trim();answer=offer.question.options[Number(value)-1]?.label;
   if(answer==='差分だけ実施'&&!offer.state.gaps.length){
    const available=offer.state.requested_units;available.forEach((u,i)=>console.log(`${i+1}. ${config.task_workflows[offer.state.workflow_id].units[u]}`));
    const chosen=(await terminal.question('新しく作業する対象の番号（複数はカンマ区切り）: ')).split(',').map(x=>x.trim());
    selected_units=chosen.map(x=>available[Number(x)-1]);
   }
  }finally{humanWaitMs=performance.now()-waiting;timing=confirmationTiming({displayed_ms:waiting,answered_ms:waiting+humanWaitMs,simulated:false});terminal.close();}
 }
 if(simulated)timing=confirmationTiming({simulated:true});
 const decision=await answerLocalTask({...args,answer,selected_units});
 await appendWorkObservation(root,{...observation,event:decision.pending?'cancelled':'confirmed',choice:decision.choice??null,...timing,model_starts:0});
 if(decision.pending){console.log(JSON.stringify({status:'pending',model_starts:0,...timing}));process.exit(0);}
 if(decision.choice==='existing'){
  const completion=await taskCompletion({...args,session_id:input.session_id});await writeFile(join(root,'.local/memory-reuse/last-local-task.json'),JSON.stringify(completion),{mode:0o600});
  await appendWorkObservation(root,{...observation,event:'completed_existing',choice:'existing',completion,session_elapsed_ms:performance.now()-started,model_starts:0});
  console.log(JSON.stringify({status:completion.status,result:decision.prior_path,model_starts:0,...timing}));process.exit(0);
 }
}
const source=await primeLocalTaskSource(args),receipt={session_id:input.session_id,route:'local_confirmation',condition,source_receipt_id:source.id,decision_source:simulated?'simulated_local_user':offer.question?'local_user':null,pre_model_ms:performance.now()-started,human_wait_ms:humanWaitMs,...timing,model_starts:0};
const envelope=await localTaskSourceEnvelope(args);receipt.source_envelope_digest=envelope.digest;
await writeFile(join(root,'.local/memory-reuse/local-launch.json'),JSON.stringify(receipt),{mode:0o600});
await appendWorkObservation(root,{...observation,event:'prepared',choice:offer.state.choice,pre_model_ms:receipt.pre_model_ms,model_starts:0});
if(prepareOnly){console.log(JSON.stringify(receipt));process.exit(0);}
// The project hooks consume the single-use prepared context for this exact prompt/session.
await appendWorkObservation(root,{...observation,event:'model_start_attempt',model_starts:1});
const cliStarted=performance.now(),modelArgs=config.task_model?['--model',config.task_model]:[],effortArgs=config.task_effort?['--effort',config.task_effort]:[];
const child=spawn('claude',[...modelArgs,...effortArgs,'--append-system-prompt',envelope.content,'--session-id',input.session_id,input.prompt],{cwd:root,env:{...process.env,ORGBRAIN_REUSE_ROOT:root,ORGBRAIN_TASK_SOURCE_ENVELOPE_DIGEST:envelope.digest},stdio:'inherit'});
const exit=await new Promise(resolve=>{child.once('error',error=>{console.error(error.message);resolve(1);});child.once('exit',code=>resolve(code??1));});
await appendWorkObservation(root,{...observation,event:'cli_exit',exit_code:exit,cli_elapsed_ms:performance.now()-cliStarted,session_elapsed_ms:performance.now()-started,model_starts:0});process.exitCode=exit;
