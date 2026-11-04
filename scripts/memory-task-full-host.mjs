// Evaluation setup only; never starts a model or accepts an invented human decision.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {LocalMemoryStore} from '../packages/orgbrain-cli/src/lib/local-memory-store.mjs';
import {MemoryReuse} from '../packages/orgbrain-cli/src/lib/memory-reuse.mjs';
import {loadTaskRuntimeConfig} from '../packages/orgbrain-cli/src/lib/memory-task-runtime-config.mjs';
import {prepareLocalTask,answerLocalTask,primeLocalTaskSource,localTaskSourceEnvelope} from '../packages/orgbrain-cli/src/lib/memory-reuse-task-confirmation.mjs';
const root=resolve(process.env.ORGBRAIN_REUSE_ROOT||process.cwd()),config=await loadTaskRuntimeConfig(root);
if(config.observation_purpose!=='test'||process.env.ORGBRAIN_TASK_EVAL_SIMULATION!=='1')throw Error('explicit_test_configuration_required');
const request=JSON.parse(await readFile(process.argv[2],'utf8')),store=new LocalMemoryStore(config.db_path,{denseEmbeddingProvider:null,memoryJudge:null,relevanceSelector:null}),reuse=new MemoryReuse(store,{tenant_id:config.tenant_id,project_id:config.project_id,principal_id:'local',work_type:'implementation'});
const word=s=>/^[\w./:-]+$/u.test(s)?s:"'"+s.replaceAll("'","'\\''")+"'",prefix=[process.execPath,fileURLToPath(new URL('./memory-reuse-claude.mjs',import.meta.url))].map(word).join(' '),input={session_id:request.session_id,prompt:request.prompt},args={root,reuse,config,input,prefix,condition:request.condition==='none'?'control':'reuse'};
const started=performance.now(),offer=await prepareLocalTask(args),offered=performance.now();
if(request.condition!=='none'&&!offer.question)throw Error('real_prior_result_required_for_comparison');
if(offer.question)await answerLocalTask({...args,answer:'全体を実施'});
const answered=performance.now(),source=await primeLocalTaskSource(args),envelope=await localTaskSourceEnvelope(args),directory=join(root,'.local/memory-reuse/evaluation/packets');await mkdir(directory,{recursive:true,mode:0o700});const path=join(directory,request.session_id+'.txt');await writeFile(path,envelope.content,{mode:0o600,flag:'wx'});
console.log(JSON.stringify({session_id:request.session_id,prior_id:offer.state.prior?.id??null,question_present:!!offer.question,decision_source:offer.question?'simulated_local_user':null,source_envelope_path:path,source_envelope_digest:envelope.digest,source_receipt_id:source.id,offer_body_ms:offered-started,scripted_answer_body_ms:answered-offered,source_body_ms:performance.now()-answered,model_starts:0}));
