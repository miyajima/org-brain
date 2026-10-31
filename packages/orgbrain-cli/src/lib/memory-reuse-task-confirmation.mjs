import {readFile,writeFile,mkdir,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {reuseDigest,reuseContentAllowed,recordReuseAction} from './memory-reuse.mjs';
import {taskSectionsCommand,parseTaskSectionsCommand} from './memory-task-transport.mjs';
import {buildRetainedContext,checkJoinedConsistency} from './memory-task-consistency.mjs';
const KINDS=new Set(['research','analysis','document']);
const CHOICES=['既存成果で完了','差分だけ実施','全体を実施'];
const execute=promisify(execFile);
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const same=(a,b)=>JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
export function taskQuestionMatches(questions,expected){
 if(!Array.isArray(questions)||questions.length!==1)return false;const q=questions[0];
 return q&&Object.keys(q).every(k=>['question','header','options','multiSelect'].includes(k))&&q.question===expected.question&&q.header===expected.header&&(q.multiSelect??false)===expected.multiSelect&&Array.isArray(q.options)&&q.options.length===expected.options.length&&q.options.every((o,i)=>Object.keys(o).every(k=>['label','description'].includes(k))&&o.label===expected.options[i].label&&o.description===expected.options[i].description);
}
const pathFor=(root,session)=>{if(!/^[\w:-]{1,128}$/u.test(session))throw Error('invalid_task_session');return join(root,'.local/memory-reuse/task-confirmations',session+'.json');};
async function readState(root,session){try{return JSON.parse(await readFile(pathFor(root,session),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;return null;}}
async function save(root,s){await mkdir(join(root,'.local/memory-reuse/task-confirmations'),{recursive:true,mode:0o700});await writeFile(pathFor(root,s.session_id),JSON.stringify(s),{mode:0o600});}
function workflow(config,id){const w=config.task_workflows?.[id];if(!w||!KINDS.has(w.kind)||!w.title||!w.units||Object.keys(w.units).length>4||!Array.isArray(w.source_refs)||!w.source_refs.length&&w.source_mode!=='project_files'||!w.source_files?.length||!Number.isInteger(w.valid_for_ms)||w.valid_for_ms<1||w.valid_for_ms>7*86400000)throw Error('unconfigured_task_workflow');return w;}
function units(w,items){if(!Array.isArray(items)||!items.length||new Set(items).size!==items.length||items.some(x=>!Object.hasOwn(w.units,x)))throw Error('invalid_task_units');return items;}
function scoped(reuse,s){if(['tenant_id','project_id','principal_id'].some(k=>reuse.scope[k]!==s.scope[k]))throw Error('task_scope_mismatch');}
async function localFile(root,name){const base=await realpath(root),p=await realpath(resolve(root,name));if(!p.startsWith(base+'/'))throw Error('task_artifact_outside_project');const b=await readFile(p),content=b.toString('utf8');if(b.length>65536||!Buffer.from(content).equals(b)||!reuseContentAllowed(content))throw Error('unsafe_task_artifact');return {path:p,content,sha256:createHash('sha256').update(b).digest('hex')};}
export async function taskSnapshot({root,reuse,config,workflow_id}){
 const w=workflow(config,workflow_id),action=config.action_adapters?.[w.adapter];if(!action||action.task_workflow!==workflow_id||action.argv?.[0]!==process.execPath)throw Error('unconfigured_task_adapter');
 const refs=[];for(const r of w.source_refs){const m=await reuse.detail(r);if(m.verification_state!=='verified')throw Error('unverified_task_source');refs.push({ref:r,body:reuseDigest({content:m.content,reuse_rule:m.reuse_rule,source_references:m.source_references})});}
 const files=[];for(const name of w.source_files){const f=await localFile(root,name);files.push({name,sha256:f.sha256});}
 const dependencies=[];for(const name of [...new Set([action.argv[1],...(w.dependency_files??[])])])dependencies.push({name,sha256:reuseDigest(await readFile(name,'utf8'))});
 return reuseDigest({workflow_id,kind:w.kind,target:w.target,units:w.units,refs,files,...(w.source_mode==='project_files'?{source_mode:w.source_mode,document_units:w.document_units}:{}),...(w.retained_fact_topics?{retained_fact_topics:w.retained_fact_topics}:{}),...(config.task_delta_consistency==='on'?{delta_consistency:'known-fact-consistency/v1',retained_fact_budget:config.task_retained_fact_max_chars??1200}:{}),environment:{node:process.version,declared:w.environment,dependencies}});
}
async function candidates({root,reuse,config,workflow_id}){
 const fingerprint=await taskSnapshot({root,reuse,config,workflow_id}),w=workflow(config,workflow_id),s=reuse.scope,db=await reuse.open();let found;
 try{found=db.prepare(`SELECT a.* FROM memory_reuse_artifacts a WHERE a.kind='result' AND a.tenant_id=? AND a.project_id=? AND a.object_type_key='completed_work' AND a.object_id=? AND a.fingerprint=?
 AND(a.principal=? OR EXISTS(SELECT 1 FROM memory_reuse_artifact_grants g WHERE g.artifact_id=a.id AND g.tenant_id=a.tenant_id AND g.project_id=a.project_id AND g.principal=?)) ORDER BY a.created_at DESC`).all(s.tenant_id,s.project_id,workflow_id,fingerprint,s.principal_id,s.principal_id);}finally{db.close();}
 const result=[];for(const r of found){const p=JSON.parse(r.payload_json);if(Date.now()-r.created_at>w.valid_for_ms)continue;let f;try{f=await localFile(root,p.path);}catch(e){if(e.code==='ENOENT')continue;throw e;}if(f.sha256!==p.content_digest)continue;result.push({id:r.id,owner:r.principal,completed_at:r.created_at,source_refs:JSON.parse(r.refs_json),...p});}return result;
}
async function currentPrior(args,s){const c=(await candidates({...args,workflow_id:s.workflow_id})).find(x=>x.id===s.prior?.id);if(!c)throw Error('prior_work_no_longer_available');if(c.content_digest!==s.prior.content_digest||reuseDigest(c.sections)!==reuseDigest(s.prior.sections))throw Error('prior_work_evidence_changed');return c;}
const commandShape=(prefix,s)=>prefix+" run "+quote(JSON.stringify({task_id:s.task_id,adapter:s.adapter,input:{op:'read',units:s.allowed_units},uses:[]}));
function context(prefix,s){
 if(s.choice==='pending'||s.choice==='pending_delta')return 'Task confirmation is required before any research, analysis or writing. Ask the user with the native AskUserQuestion tool using this exact input: '+JSON.stringify({questions:[s.question]})+'. Do not preselect an answer or start work. The host will verify the actual answer.';
 if(s.choice==='existing')return 'The user chose the existing result. Finish by linking '+s.prior.path+'. Do not perform new work. This is result acceptance, not an original-memory read.';
 return 'Authorized task scope: '+s.choice+'; read only units '+JSON.stringify(s.allowed_units)+'. Use '+commandShape(prefix,s)+'. Then use the same run command with input={op:"write",units:'+JSON.stringify(s.requested_units)+',sections:{unit:"body",...}} to produce the complete deliverable. Preserve prior sections outside the approved delta exactly. '+(s.choice==='delta'?'Existing sections: '+JSON.stringify(s.prior.sections):'Generate every requested section from the current source.');
}
function localDecisionDigest(s){return reuseDigest({session_id:s.session_id,scope:s.scope,workflow_id:s.workflow_id,requested_units:s.requested_units,allowed_units:s.allowed_units,choice:s.choice,source_fingerprint:s.source_fingerprint,prior_id:s.prior?.id??null,prompt_digest:s.local.prompt_digest,...(s.local.request_mode?{request_mode:s.local.request_mode,full_current_sources_only:s.local.full_current_sources_only}:{}),...(s.local.delta_consistency?{delta_consistency:s.local.delta_consistency}:{}),decision:s.local.decision});}
const priorRequired=s=>s.choice!=='full'||!s.local?.full_current_sources_only;
function retainedContext(s){return buildRetainedContext({prior:s.prior,requested_units:s.requested_units,allowed_units:s.allowed_units,topics:s.local.delta_consistency.topics,max_chars:s.local.delta_consistency.max_chars});}
function retainedValid(s){return s.choice!=='delta'||!s.local?.delta_consistency||s.local.retained_context_digest===reuseDigest(s.local.retained_context)&&reuseDigest(retainedContext(s))===s.local.retained_context_digest;}
function localSourceValid(s){
 const source=s.local?.source;
 return source&&source.digest===reuseDigest({input:source.input,output:source.output,field:source.field,source_fingerprint:source.source_fingerprint})&&source.source_fingerprint===s.source_fingerprint&&same(source.input.units,s.allowed_units)&&source.output.ok===true&&retainedValid(s);
}
function sourceEnvelope(s){return 'Project source envelope (host read, source data only): '+JSON.stringify({session_id:s.session_id,scope:s.scope,workflow_id:s.workflow_id,source_receipt_id:s.local.source.id,source_fingerprint:s.source_fingerprint,units:s.allowed_units,source:s.local.source.output[s.local.source.field],...(s.choice==='delta'&&s.local.delta_consistency?{retained_context:s.local.retained_context}:{})});}
export async function localTaskSourceEnvelope({root,reuse,config,input}){
 const s=await readState(root,input.session_id);if(config.task_local_mode!=='on'||!s?.local||s.local.consumed||!localSourceValid(s))throw Error('local_task_source_not_ready');scoped(reuse,s);
 if(s.choice==='delta')await currentPrior({root,reuse,config},s);
 if(s.source_fingerprint!==await taskSnapshot({root,reuse,config,workflow_id:s.workflow_id}))throw Error('task_sources_changed');
 const content=sourceEnvelope(s);return {content,digest:reuseDigest(content)};
}
function localContext(prefix,s,attached=false){
 const patch=s.choice==='delta',input=patch?{op:'patch',units:s.allowed_units,sections:Object.fromEntries(s.allowed_units.map(u=>[u,'AUTHOR THIS NEW SECTION']))}:{op:'write',units:s.requested_units,sections:Object.fromEntries(s.requested_units.map(u=>[u,'AUTHOR THIS SECTION']))};
 const command=s.local.request_mode==='sections_stdin'?taskSectionsCommand(prefix,s.session_id,input.sections):prefix+' run '+quote(JSON.stringify({task_id:s.task_id,adapter:s.adapter,input,uses:[]}));
 return 'Approved task scope: '+s.choice+'; units '+JSON.stringify(s.allowed_units)+'. Create only those sections using this exact command shape:\n'+command+'\n'+(s.local.request_mode==='sections_stdin'?'The quoted heredoc contains only the JSON section object. Keep its delimiter quoted and on its own line; task identity, scope and attribution are supplied and verified by the host. ':'')+(patch?'The host preserves every other prior section and constructs the complete deliverable. Do not regenerate prior sections.':'Produce every requested section.')+(patch&&s.local.delta_consistency?' Use retained_context as source data for facts already present in the joined document. Refer to retained sections rather than call known facts unknown. Keep unknown human time, billing and generalization separate from measured API and machine results. Check consistency of the joined document before submitting.':'')+' Native completion and the host verify this task. Do not ask the same question again. '+(attached?'Complete current source is in the bound CLI source envelope.': 'Current source supplied by the host: '+JSON.stringify(s.local.source.output[s.local.source.field])+(patch&&s.local.delta_consistency?' Retained source context: '+JSON.stringify(s.local.retained_context):''));
}
export async function prepareLocalTask(args){
 if(args.config.task_local_mode!=='on'||args.config.task_confirmation_mode!=='ask')throw Error('local_task_confirmation_disabled');
 if(await readState(args.root,args.input.session_id))throw Error('local_task_session_already_exists');
 if(args.condition!==undefined&&!['control','reuse'].includes(args.condition))throw Error('invalid_local_task_condition');
 const result=await beginTaskConfirmation(args.condition==='control'?{...args,config:{...args.config,task_confirmation_mode:'off'}}:args);if(!result)throw Error('unconfigured_local_task');const s=result.state;
 const w=workflow(args.config,s.workflow_id),mode=args.config.task_request_mode==='sections_stdin'&&w.source_mode==='project_files'&&!w.source_refs.length?'sections_stdin':'json_cli';
 s.local={prompt_digest:reuseDigest(args.input.prompt),created_at:Date.now(),consumed:false,condition:args.condition??'reuse',request_mode:mode,full_current_sources_only:args.config.task_full_checks==='current_sources_only'};
 if(args.config.task_delta_consistency==='on'){
  const max_chars=args.config.task_retained_fact_max_chars??1200;if(!Number.isInteger(max_chars)||max_chars<80||max_chars>6000)throw Error('invalid_retained_fact_budget');
  s.local.delta_consistency={version:'known-fact-consistency/v1',max_chars,topics:w.retained_fact_topics??{}};
 }
 await save(args.root,s);return {state:s,question:s.question??null};
}
export async function answerLocalTask({root,reuse,config,input,answer,selected_units,confirmation_evidence}){
 const s=await readState(root,input.session_id);if(config.task_local_mode!=='on'||!s?.local||s.local.consumed)throw Error('local_task_confirmation_unavailable');scoped(reuse,s);
 if(s.choice!=='pending')throw Error('local_task_confirmation_not_pending');await currentPrior({root,reuse,config},s);
 if(!CHOICES.includes(answer))return {pending:true};
 if(confirmation_evidence&&(config.observation_purpose==='test'||confirmation_evidence.source!=='native_question_answer'||!/^call_[\w-]+$/u.test(confirmation_evidence.call_id)||confirmation_evidence.session_id!==s.session_id||confirmation_evidence.answer!==answer))throw Error('human_answer_evidence_mismatch');
 const choice=['existing','delta','full'][CHOICES.indexOf(answer)];let allowed=choice==='delta'?s.gaps:choice==='full'?s.requested_units:[];
 if(choice==='delta'&&!allowed.length){allowed=units(workflow(config,s.workflow_id),selected_units);if(allowed.some(u=>!s.requested_units.includes(u)))throw Error('invalid_task_units');}
 s.choice=choice;s.allowed_units=allowed;s.decision_source=config.observation_purpose==='test'?'simulated_local_user':confirmation_evidence?'native_question_answer':'local_user';
 s.local.decision={id:randomUUID(),question:s.question,answer,selected_units:allowed,provenance:s.decision_source,...(confirmation_evidence?{human_evidence:confirmation_evidence}:{})};s.local.decision_digest=localDecisionDigest(s);s.local.consumed=choice==='existing';await save(root,s);
 return {choice,allowed_units:allowed,prior_path:s.prior.path,decision_id:s.local.decision.id};
}
export async function primeLocalTaskSource({root,reuse,config,input}){
 const s=await readState(root,input.session_id);if(config.task_local_mode!=='on'||!s?.local||s.local.consumed||!['delta','full'].includes(s.choice))throw Error('local_task_confirmation_required');scoped(reuse,s);
 if(Date.now()-s.local.created_at>30*60000)throw Error('local_task_confirmation_expired');
 if(s.local.source)throw Error('local_task_source_already_prepared');
 if(s.prior){if(priorRequired(s))await currentPrior({root,reuse,config},s);if(s.local.decision_digest!==localDecisionDigest(s))throw Error('local_task_decision_changed');}
 const w=workflow(config,s.workflow_id),action=config.action_adapters[s.adapter],field=w.local_source_field;
 if(!field||!action.operations.includes('read'))throw Error('local_task_source_contract_required');
 if(s.source_fingerprint!==await taskSnapshot({root,reuse,config,workflow_id:s.workflow_id}))throw Error('task_sources_changed');
 const request={op:'read',units:s.allowed_units},started=performance.now(),{stdout}=await execute(action.argv[0],[...action.argv.slice(1),JSON.stringify(request)],{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:65536});
 const output=JSON.parse(stdout);if(output.ok!==true||!output[field]||!same(Object.keys(output[field]),s.allowed_units)||!reuseContentAllowed(output))throw Error('local_task_source_contract_mismatch');
 if(s.source_fingerprint!==await taskSnapshot({root,reuse,config,workflow_id:s.workflow_id}))throw Error('task_sources_changed_during_host_read');
 s.local.source={id:randomUUID(),route:'host_context',input:request,output,field,elapsed_ms:performance.now()-started,source_fingerprint:s.source_fingerprint};s.local.source.digest=reuseDigest({input:request,output,field,source_fingerprint:s.source_fingerprint});
 if(s.choice==='delta'&&s.local.delta_consistency){s.local.retained_context=retainedContext(s);if(s.local.retained_context.uncovered_topics.length)throw Error('task_retained_facts_incomplete');s.local.retained_context_digest=reuseDigest(s.local.retained_context);}
 await save(root,s);
 return s.local.source;
}
async function consumeLocalTask({root,reuse,config,input,prefix},s,request){
 scoped(reuse,s);
 if(config.task_local_mode!=='on'||s.local.prompt_digest!==reuseDigest(input.prompt)||request.workflow!==s.workflow_id||!same(request.units,s.requested_units)||Date.now()-s.local.created_at>30*60000)throw Error('local_task_binding_mismatch');
 if(s.source_fingerprint!==await taskSnapshot({root,reuse,config,workflow_id:s.workflow_id}))throw Error('task_sources_changed');
 if(s.prior){if(priorRequired(s))await currentPrior({root,reuse,config},s);if(s.local.decision_digest!==localDecisionDigest(s))throw Error('local_task_decision_changed');}
 if(!['delta','full'].includes(s.choice)||!localSourceValid(s))throw Error('local_task_context_not_ready');
 const expected=reuseDigest(sourceEnvelope(s)),provided=process.env.ORGBRAIN_TASK_SOURCE_ENVELOPE_DIGEST,attached=provided===expected;
 if(provided&&!attached)throw Error('local_task_source_envelope_mismatch');
 const additionalContext=localContext(prefix,s,attached);if(additionalContext.length>10000)throw Error('local_task_source_envelope_required');
 s.local.source_delivery=attached?'cli_system_append':'hook_context';s.local.source_envelope_digest=attached?expected:null;
 s.local.consumed=true;s.local.consumed_at=Date.now();s.local.delivered_digest=reuseDigest(additionalContext);await save(root,s);return {additionalContext,state:s};
}
export function taskExecutionInput(s,input){
 if(input?.op!=='patch')return input;
 if(!s?.local||s.choice!=='delta')throw Error('task_patch_not_authorized');
 return {op:'write',units:s.requested_units,sections:Object.fromEntries(s.requested_units.map(u=>[u,s.allowed_units.includes(u)?input.sections[u]:s.prior.sections[u]]))};
}
export function taskJoinedConsistency(s,sections){
 if(s.choice!=='delta'||!s.local?.delta_consistency)return null;
 if(!retainedValid(s))throw Error('task_retained_context_changed');
 const result=checkJoinedConsistency({retained:s.local.retained_context,sections,added_units:s.allowed_units});
 if(result.status==='contradiction')throw Error('task_retained_fact_contradiction:'+result.issues.map(x=>x.topic).join(',')+'; use retained_context and distinguish known facts from human or billing unknowns');
 return result;
}
export async function beginTaskConfirmation({root,reuse,config,input,prefix}){
 const tagged=[...String(input.prompt??'').matchAll(/<reuse_task>([^\n]*?)<\/reuse_task>/gu)];let request;
 if(tagged.length){if(tagged.length!==1)throw Error('ambiguous_task_request');request=JSON.parse(tagged[0][1]);}
 else{const matches=Object.entries(config.task_workflows??{}).filter(([,w])=>(w.phrases??[]).some(p=>input.prompt?.includes(p)));if(matches.length===1)request={workflow:matches[0][0],units:matches[0][1].default_units};}
 if(!request){const prior=await readState(root,input.session_id);if(prior){prior.inactive=true;await save(root,prior);}return null;}
 const prepared=await readState(root,input.session_id);if(prepared?.local&&!prepared.local.consumed)return consumeLocalTask({root,reuse,config,input,prefix},prepared,request);
 const w=workflow(config,request.workflow),requested=units(w,request.units),s={session_id:input.session_id,task_id:'claude:'+input.session_id,scope:reuse.scope,workflow_id:request.workflow,adapter:w.adapter,kind:w.kind,requested_units:requested,allowed_units:requested,choice:'full',operations:[],created_results:[],created_at:Date.now()};
 s.choice='initializing';await save(root,s);s.source_fingerprint=await taskSnapshot({root,reuse,config,workflow_id:request.workflow});s.choice='full';
 if(config.task_confirmation_mode==='ask'){
   const all=await candidates({root,reuse,config,workflow_id:request.workflow}),prior=all.filter(c=>c.covered_units.some(u=>requested.includes(u))).sort((a,b)=>b.covered_units.filter(u=>requested.includes(u)).length-a.covered_units.filter(u=>requested.includes(u)).length)[0];
  if(prior){
   s.prior=prior;s.choice='pending';s.allowed_units=[];const gaps=requested.filter(x=>!prior.covered_units.includes(x));s.gaps=gaps;
   s.question={question:`既存成果: ${w.title}\n作成者: ${prior.owner}\n実行日: ${new Date(prior.completed_at).toISOString()}\n成果物: ${prior.path}\n既存の範囲: ${prior.covered_units.map(x=>w.units[x]).join('、')}\n今回の範囲: ${requested.map(x=>w.units[x]).join('、')}\n差分: ${gaps.length?gaps.map(x=>w.units[x]).join('、'):'未指定（差分実施なら対象を追加確認）'}\n要旨: ${prior.content.slice(0,240)}\n今回の作業範囲を選んでください。`,header:'作業範囲',options:[{label:CHOICES[0],description:'この成果で十分として新規作業を行わず完了する。'},{label:CHOICES[1],description:gaps.length?'追加対象: '+gaps.map(x=>w.units[x]).join('、'):'やり直したい対象を次に選ぶ。'},{label:CHOICES[2],description:'今回の対象全体を新しく調査・分析・作成する。'}],multiSelect:false};
  }
 }
 await save(root,s);return {additionalContext:context(prefix,s),state:s};
}
export async function assertTaskOperation({root,reuse,config,request}){
 const action=config.action_adapters?.[request.adapter],s=request.task_id?.startsWith('claude:')?await readState(root,request.task_id.slice(7)):null;
 if(s&&!s.inactive){scoped(reuse,s);if(!['delta','full'].includes(s.choice))throw Error('task_confirmation_required');if(request.adapter!==s.adapter)throw Error('task_adapter_scope_mismatch');}
 if(!action?.task_workflow)return null;
 if(!request.task_id?.startsWith('claude:'))throw Error('task_identity_required');if(!s||s.inactive||s.workflow_id!==action.task_workflow)throw Error('task_context_required');scoped(reuse,s);
 if(!['delta','full'].includes(s.choice))throw Error('task_confirmation_required');
 if(s.local&&!s.local.consumed)throw Error('local_task_context_not_delivered');
 if(s.source_fingerprint!==await taskSnapshot({root,reuse,config,workflow_id:s.workflow_id}))throw Error('task_sources_changed');
 if(s.local?.consumed&&(!localSourceValid(s)||s.prior&&s.local.decision_digest!==localDecisionDigest(s)))throw Error('local_task_receipt_changed');
 const w=workflow(config,s.workflow_id),x=request.input;units(w,x?.units);
 if(x.op==='read'){if(x.units.some(u=>!s.allowed_units.includes(u)))throw Error('task_delta_scope_exceeded');}
 else if(x.op==='write'||x.op==='patch'){
  if(s.local&&!s.local.consumed)throw Error('local_task_context_not_delivered');
  if(s.local&&s.choice==='delta'&&x.op!=='patch')throw Error('local_task_patch_required');
  if(x.op==='patch'&&(!s.local||s.choice!=='delta'||!same(x.units,s.allowed_units)))throw Error('task_patch_scope_exceeded');
  const expected=x.op==='patch'?s.allowed_units:s.requested_units;
  if(!same(x.units,expected)||!x.sections||!same(Object.keys(x.sections),expected)||Object.values(x.sections).some(v=>typeof v!=='string'||!v))throw Error('task_deliverable_incomplete');
  if(s.decision_source&&!s.local?.consumed&&s.allowed_units.some(u=>!s.operations.some(o=>o.op==='read'&&o.units.includes(u))))throw Error('task_source_read_required');
  const effective=taskExecutionInput(s,x);
  if(s.choice==='delta'){const p=await currentPrior({root,reuse,config},s);for(const u of s.requested_units.filter(u=>!s.allowed_units.includes(u)))if(effective.sections[u]!==p.sections[u])throw Error('task_existing_section_modified');}
  taskJoinedConsistency(s,effective.sections);
 }else throw Error('unsupported_task_operation');
 return s;
}
function parseRun(command,prefix){const start=prefix+" run '";if(!command?.startsWith(start)||!command.endsWith("'"))return null;try{const raw=command.slice(start.length,-1).replaceAll("'\\''","'"),x=JSON.parse(raw);return prefix+' run '+quote(raw)===command?x:null;}catch{return null;}}
export async function taskSectionRequest({root,reuse,config,session_id,sections}){
 const s=await readState(root,session_id);if(!s||s.inactive||!s.local?.consumed||s.local.request_mode!=='sections_stdin'||config.task_request_mode!=='sections_stdin')throw Error('task_section_transport_not_authorized');scoped(reuse,s);
 const w=workflow(config,s.workflow_id);if(w.source_mode!=='project_files'||w.source_refs.length)throw Error('task_section_transport_requires_file_sources');
 if(!['full','delta'].includes(s.choice)||!sections||typeof sections!=='object'||Array.isArray(sections))throw Error('task_section_transport_scope_mismatch');
 return {task_id:s.task_id,adapter:s.adapter,input:{op:s.choice==='delta'?'patch':'write',units:s.choice==='delta'?s.allowed_units:s.requested_units,sections},uses:[]};
}
export async function preTaskConfirmation({root,reuse,config,input,prefix}){
 const s=await readState(root,input.session_id);if(!s||s.inactive)return {};
 const deny=reason=>({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:reason}});
 try{
  scoped(reuse,s);
  if(['pending','pending_delta'].includes(s.choice)&&input.tool_name==='AskUserQuestion'){
   if(input.tool_input?.answers||!taskQuestionMatches(input.tool_input?.questions,s.question))return deny('Use the exact pending question without an answer or preselection.');
   await currentPrior({root,reuse,config},s);s.question_call_id=input.tool_use_id;await save(root,s);return {};
  }
  if(['pending','pending_delta','existing'].includes(s.choice))return deny(s.choice==='existing'?'The user accepted the prior result; no new task work is authorized.':'Wait for the user choice using AskUserQuestion.');
  let request=input.tool_name==='Bash'?parseRun(input.tool_input?.command,prefix):null;const section=input.tool_name==='Bash'?parseTaskSectionsCommand(input.tool_input?.command,prefix):null;
  if(section){if(section.session_id!==input.session_id)return deny('Task session mismatch.');request=await taskSectionRequest({root,reuse,config,...section});}
  if(!request||request.task_id!==s.task_id||request.adapter!==s.adapter)return deny('Use only the configured task adapter within the approved scope.');
  await assertTaskOperation({root,reuse,config,request});return {};
 }catch(e){return deny(e.message);}
}
export async function postTaskQuestion({root,reuse,config,input,prefix}){
 if(input.tool_name!=='AskUserQuestion')return null;const s=await readState(root,input.session_id);if(!s||s.inactive)return null;scoped(reuse,s);
 if(input.hook_event_name==='PostToolUseFailure')return {additionalContext:'The user question was not completed. No task work is authorized; wait for an explicit answer.'};
 if(input.hook_event_name!=='PostToolUse'||s.question_call_id!==input.tool_use_id||!taskQuestionMatches(input.tool_input?.questions,s.question))throw Error('task_question_evidence_mismatch');
 await currentPrior({root,reuse,config},s);
 const answer=input.tool_response?.answers?.[s.question.question];
 if(s.choice==='pending'&&CHOICES.includes(answer)){
  s.choice=['existing','delta','full'][CHOICES.indexOf(answer)];s.allowed_units=s.choice==='delta'?s.gaps:s.choice==='full'?s.requested_units:[];
  if(s.choice==='delta'&&!s.allowed_units.length){if(s.requested_units.length===1)s.allowed_units=s.requested_units;else{s.choice='pending_delta';const w=workflow(config,s.workflow_id);s.question={question:'差分として新しく作業する対象を選んでください。',header:'差分の対象',options:s.requested_units.map(u=>({label:w.units[u],description:'この対象を新しく調査・分析・作成する。'})),multiSelect:true};}}
 }else if(s.choice==='pending_delta'){
  const labels=Array.isArray(answer)?answer:typeof answer==='string'?answer.split(', '):[],w=workflow(config,s.workflow_id),selected=s.requested_units.filter(u=>labels.includes(w.units[u]));
  if(selected.length&&selected.length===labels.length){s.choice='delta';s.allowed_units=selected;}
 }
 s.decision_source=config.observation_purpose==='test'?'simulated':'native_user';s.answer_evidence={call_id:input.tool_use_id,answer,tool_input:input.tool_input,tool_response:input.tool_response};await save(root,s);
 return {additionalContext:context(prefix,s)};
}
export async function captureCompletedWork({root,reuse,config,action,record,native}){
 if(!action.task_workflow)return null;const s=await assertTaskOperation({root,reuse,config,request:record.request});if(s.source_fingerprint!==record.work_source_fingerprint)throw Error('task_sources_changed_during_action');
 if(s.operations.some(x=>x.native_call_id===native.tool_use_id))return null;
 const effective=taskExecutionInput(s,record.request.input);s.operations.push({native_call_id:native.tool_use_id,op:effective.op,units:record.request.input.units,...(record.request.input.op==='patch'?{route:'delta_patch'}:{})});
 if(effective.op==='write'){
  const a=(record.backend_output??record.output).artifact;if(!a?.path||reuseDigest(a.sections)!==reuseDigest(effective.sections))throw Error('task_output_evidence_missing');const file=await localFile(root,a.path),w=workflow(config,s.workflow_id);if(a.sha256&&a.sha256!==file.sha256)throw Error('task_output_digest_mismatch');
  const fileSources=w.source_mode==='project_files'?await Promise.all(w.source_files.map(async name=>({path:name,sha256:(await localFile(root,name)).sha256}))):null;
  const consistency_check=taskJoinedConsistency(s,a.sections);
  const payload={workflow_id:s.workflow_id,kind:w.kind,title:w.title,path:a.path,content:file.content,content_digest:file.sha256,covered_units:effective.units,sections:a.sections,...(fileSources?{source_mode:'project_files',file_sources:fileSources}:{}),...(consistency_check?{consistency_check}:{})};
  await recordReuseAction(reuse.store,reuse.scope,{call_id:native.tool_use_id,task_id:s.task_id,completed:true,ok:true,args:native.tool_input,result:native.tool_response,cache:{payload,fingerprint:s.source_fingerprint,refs:w.source_refs,object_type_key:'completed_work',object_id:s.workflow_id}});
  const artifact=await reuse.createArtifact({kind:'result',object_type_key:'completed_work',object_id:s.workflow_id,refs:w.source_refs,payload,fingerprint:s.source_fingerprint,action_ref:native.tool_use_id,allowed_principals:w.allowed_principals??[]});s.created_results.push({id:artifact.id,native_call_id:native.tool_use_id,path:a.path,content_digest:file.sha256,covered_units:payload.covered_units,...(consistency_check?{consistency_check}:{})});
 }
 await save(root,s);return s.created_results.at(-1)??null;
}
export async function taskCompletion({root,reuse,config,session_id}){
 const s=await readState(root,session_id);if(!s||s.inactive)return null;scoped(reuse,s);
 const result={choice:s.choice,status:'pending',decision_source:s.decision_source??null,answer_call_id:s.answer_evidence?.call_id??null,prior_artifact_id:s.prior?.id??null,requested_units:s.requested_units,executed_operations:s.operations.length,reused_units:[]};
 if(s.local){result.local_confirmation_id=s.local.decision?.id??null;result.host_read_operations=s.local.source?1:0;result.host_source_route='host_context';}
 if(s.local&&(!s.local.consumed||s.prior&&s.local.decision_digest!==localDecisionDigest(s)||s.choice!=='existing'&&!localSourceValid(s)))return {...result,status:'verification_missing',reason:'local_confirmation_or_context_not_verified'};
 if(['pending','pending_delta'].includes(s.choice))return result;
 if(s.source_fingerprint!==await taskSnapshot({root,reuse,config,workflow_id:s.workflow_id}))return {...result,status:'verification_missing',reason:'source_changed_before_stop'};
 if(s.choice==='existing'){await currentPrior({root,reuse,config},s);if(s.operations.length)throw Error('work_executed_after_existing_acceptance');return {...result,status:'completed_with_existing_result',reused_units:s.prior.covered_units};}
 const artifact=s.created_results.at(-1);if(!artifact)return result;const f=await localFile(root,artifact.path);if(f.sha256!==artifact.content_digest)return {...result,status:'verification_missing',reason:'result_changed_before_stop'};
 if(s.choice==='delta')await currentPrior({root,reuse,config},s);
 return {...result,status:s.choice==='delta'?'completed_delta':'completed_full',artifact_id:artifact.id,native_call_id:artifact.native_call_id,reused_units:s.choice==='delta'?s.requested_units.filter(u=>!s.allowed_units.includes(u)):[],allowed_units:s.allowed_units,...(artifact.consistency_check?{consistency_check:artifact.consistency_check}:{})};
}
