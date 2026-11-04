import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {mergeReuseHooks} from '../packages/orgbrain-cli/src/lib/memory-reuse-claude.mjs';
import {LocalMemoryStore} from '../packages/orgbrain-cli/src/lib/local-memory-store.mjs';
import {MemoryReuse} from '../packages/orgbrain-cli/src/lib/memory-reuse.mjs';
import {prepareLocalTask,answerLocalTask,primeLocalTaskSource,localTaskSourceEnvelope} from '../packages/orgbrain-cli/src/lib/memory-reuse-task-confirmation.mjs';
const helper=resolve(process.env.ORGBRAIN_TASK_TEST_HELPER||'scripts/memory-reuse-claude.mjs'),prefix=process.execPath+' '+helper;
async function fixture(fn){
 const root=await mkdtemp(join(tmpdir(),'reuse-task-'));await mkdir(join(root,'.local/memory-reuse'),{recursive:true});await writeFile(join(root,'source.json'),JSON.stringify({a:'Alpha requires 8 items.',b:'Beta retains 14 days.',c:'Gamma runs locally.'}));
 const store=new LocalMemoryStore(join(root,'memory.sqlite'),{denseEmbeddingProvider:null});await store.init();
 await store.capture({id:'source',external_key:'task:source',tenant_id:'default',project_id:'org-brain',work_type:'implementation',kind:'fact',content:'Synthetic confirmed workflow constraints.',rationale:'Known source for a controlled test.',reuse_rule:'Only the fixture workflow.',source:'test-fixture',verification_state:'verified',verified_at:Date.now(),capture_origin:'observed',learning:{fixture:true}});
 const adapter=join(root,'adapter.mjs');await writeFile(adapter,`import {readFile,writeFile,mkdir,appendFile} from 'node:fs/promises';import {randomUUID,createHash} from 'node:crypto';const x=JSON.parse(process.argv.at(-1));await appendFile('actions.jsonl',JSON.stringify(x)+'\\n');const source=JSON.parse(await readFile('source.json','utf8'));let out;if(x.op==='read')out={ok:true,sections:Object.fromEntries(x.units.map(u=>[u,source[u]]))};else{await mkdir('results',{recursive:true});const path='results/'+randomUUID()+'.md',body=Object.entries(x.sections).map(([u,v])=>'## '+u+'\\n'+v).join('\\n\\n');await writeFile(path,body);out={ok:true,artifact:{path,sha256:createHash('sha256').update(body).digest('hex'),sections:x.sections}};}console.log(JSON.stringify(out));`);
 const workflow={kind:'research',title:'Fixture research',target:'fixture',phrases:['fixture.research'],units:{a:'Alpha',b:'Beta',c:'Gamma'},default_units:['a','b','c'],source_refs:[{source_id:'source',source_version:1}],source_files:['source.json'],environment:{version:'test-v1'},valid_for_ms:60000,allowed_principals:['bob'],adapter:'work'};
 const config={tenant_id:'default',project_id:'org-brain',db_path:join(root,'memory.sqlite'),flags:{},delivery_mode:'inline',tracking_mode:'bundled',observation_purpose:'test',task_confirmation_mode:'off',task_workflows:{fixture:workflow},action_adapters:{work:{argv:[process.execPath,adapter],operations:['read','write'],object_type_key:'completed_work',object_id:'fixture',task_workflow:'fixture'}}};
 const save=()=>writeFile(join(root,'.local/memory-reuse/config.json'),JSON.stringify(config));await save();
 const invoke=(cmd,input,raw=false,principal='alice')=>{const p=spawnSync(process.execPath,[helper,cmd,...(raw?[JSON.stringify(input)]:[])],{cwd:root,env:{...process.env,ORGBRAIN_REUSE_ROOT:root,ORGBRAIN_USE_PRINCIPAL:principal},input:raw?undefined:JSON.stringify({cwd:root,session_id:'prior',...input}),encoding:'utf8'});return {status:p.status,stderr:p.stderr,value:p.stdout?JSON.parse(p.stdout):null};};
 const prompt=units=>'fixture.research\n<reuse_task>'+JSON.stringify({workflow:'fixture',units})+'</reuse_task>';
 const run=(session,input)=>{const req={task_id:'claude:'+session,adapter:'work',input,uses:[]};return {req,result:invoke('run',req,true)};};
 const post=(session,req,result,id)=>invoke('post',{session_id:session,hook_event_name:'PostToolUse',tool_name:'Bash',tool_use_id:id,tool_input:{command:prefix+" run '"+JSON.stringify(req)+"'"},tool_response:{stdout:JSON.stringify(result),exitCode:0}});
 try{await fn({root,store,config,save,invoke,prompt,run,post,workflow});}finally{await rm(root,{recursive:true,force:true});}
}
async function prior(f){
 assert.equal(f.invoke('context',{prompt:f.prompt(['a','b'])}).status,0);
 const {req,result}=f.run('prior',{op:'write',units:['a','b'],sections:{a:'Alpha requires 8 items.',b:'Beta retains 14 days.'}});assert.equal(result.status,0,result.stderr);assert.equal(f.post('prior',req,result.value,'prior-native').status,0);
 f.config.task_confirmation_mode='ask';await f.save();
}
async function offer(f,units=['a','b','c'],session='next',principal='alice'){
 const c=f.invoke('context',{session_id:session,prompt:f.prompt(units)},false,principal);assert.equal(c.status,0,c.stderr);assert.ok(c.value.hookSpecificOutput?.additionalContext,'Task confirmation context missing');assert.match(c.value.hookSpecificOutput.additionalContext,/AskUserQuestion/);
 const state=JSON.parse(await readFile(join(f.root,'.local/memory-reuse/task-confirmations',session+'.json'),'utf8'));return state;
}
function answer(f,state,label,id='question-native'){
 const input={questions:[state.question]};const pre=f.invoke('pre',{session_id:state.session_id,hook_event_name:'PreToolUse',tool_name:'AskUserQuestion',tool_use_id:id,tool_input:input});assert.equal(pre.status,0,pre.stderr);assert.notEqual(pre.value.hookSpecificOutput?.permissionDecision,'deny');
 return f.invoke('post',{session_id:state.session_id,hook_event_name:'PostToolUse',tool_name:'AskUserQuestion',tool_use_id:id,tool_input:input,tool_response:{answers:{[state.question.question]:label}}});
}
async function local(f,session='local-task',principal='alice'){
 f.config.task_local_mode='on';f.workflow.local_source_field='sections';await f.save();
 const reuse=new MemoryReuse(f.store,{tenant_id:'default',project_id:'org-brain',principal_id:principal,work_type:'implementation'});
 const args={root:f.root,reuse,config:f.config,prefix,input:{session_id:session,prompt:f.prompt(['a','b','c'])}};
 const offer=await prepareLocalTask(args);return {...args,offer};
}
async function fileLocal(f,session,choice='全体を実施'){
 f.workflow.source_mode='project_files';f.workflow.source_refs=[];f.workflow.allowed_principals=[];await f.save();await prior(f);
 f.config.task_request_mode='sections_stdin';const a=await local(f,session);await answerLocalTask({...a,answer:choice});await primeLocalTaskSource(a);
 const context=f.invoke('context',{session_id:session,prompt:f.prompt(['a','b','c'])});assert.equal(context.status,0,context.stderr);return {...a,context:context.value.hookSpecificOutput.additionalContext};
}
async function factPrior(f,{long_location=false}={}){
 f.workflow.source_mode='project_files';f.workflow.source_refs=[];f.workflow.allowed_principals=[];f.workflow.retained_fact_topics={a:['configuration_paths'],b:['sample_size','denominator']};f.config.task_delta_consistency='on';
 const sections={a:(long_location?'すべての適用条件を満たす場合だけ '.repeat(12):'')+'設定ファイルの場所は .local/memory-reuse/config.json。',b:'各群 n=10。分母は control の153274トークン。'};
 await writeFile(join(f.root,'source.json'),JSON.stringify({...sections,c:'人の確認時間は未観測。'}));await f.save();
 assert.equal(f.invoke('context',{prompt:f.prompt(['a','b'])}).status,0);const {req,result}=f.run('prior',{op:'write',units:['a','b'],sections});assert.equal(result.status,0,result.stderr);assert.equal(f.post('prior',req,result.value,'fact-prior-native').status,0);
 f.config.task_confirmation_mode='ask';await f.save();return sections;
}
test('local delta delivers source-bound short facts and rejects contradictions before and after execution',()=>fixture(async f=>{
 const old=await factPrior(f),a=await local(f,'facts-local');await answerLocalTask({...a,answer:'差分だけ実施'});await primeLocalTaskSource(a);
 const envelope=await localTaskSourceEnvelope(a),packet=JSON.parse(envelope.content.slice(envelope.content.indexOf(': ')+2));assert.ok(packet.retained_context);assert.equal(packet.retained_context.prior_id,a.offer.state.prior.id);assert.ok(packet.retained_context.character_count<=1200);
 assert.match(JSON.stringify(packet.retained_context),/config.json|153274/);assert.equal(f.invoke('context',{session_id:'facts-local',prompt:f.prompt(['a','b','c'])}).status,0);
 const bad={op:'patch',units:['c'],sections:{c:'設定ファイルの場所は不明。'}};
 const badRequest={task_id:'claude:facts-local',adapter:'work',input:bad,uses:[]},blocked=f.invoke('pre',{session_id:'facts-local',hook_event_name:'PreToolUse',tool_name:'Bash',tool_use_id:'contradiction-blocked',tool_input:{command:prefix+" run '"+JSON.stringify(badRequest)+"'"}});assert.equal(blocked.value.hookSpecificOutput.permissionDecision,'deny');assert.match(blocked.value.hookSpecificOutput.permissionDecisionReason,/retained_fact_contradiction/);
 const denied=f.run('facts-local',bad);assert.notEqual(denied.result.status,0);assert.match(denied.result.stderr,/retained_fact_contradiction/);
 const good=f.run('facts-local',{op:'patch',units:['c'],sections:{c:'設定場所と分母は保持済みの節を参照する。人の確認時間は未観測。'}});assert.equal(good.result.status,0,good.result.stderr);assert.equal(f.post('facts-local',good.req,good.result.value,'coherent-native').status,0);
 const s=JSON.parse(await readFile(join(f.root,'.local/memory-reuse/task-confirmations/facts-local.json'),'utf8'));assert.deepEqual(good.result.value.artifact.sections,{...old,c:'設定場所と分母は保持済みの節を参照する。人の確認時間は未観測。'});assert.equal(s.created_results[0].consistency_check.status,'passed');assert.ok(s.created_results[0].consistency_check.checked_topics.includes('configuration_paths'));
}));
test('retained context tampering is rejected even if a declared digest is recomputed',()=>fixture(async f=>{
 await factPrior(f);const a=await local(f,'facts-tamper');await answerLocalTask({...a,answer:'差分だけ実施'});await primeLocalTaskSource(a);
 const path=join(f.root,'.local/memory-reuse/task-confirmations/facts-tamper.json'),s=JSON.parse(await readFile(path,'utf8'));s.local.retained_context.snippets[0].text='forged';const {createHash}=await import('node:crypto');s.local.retained_context_digest=createHash('sha256').update(JSON.stringify(s.local.retained_context)).digest('hex');await writeFile(path,JSON.stringify(s));
 await assert.rejects(localTaskSourceEnvelope(a),/source_not_ready/);
}));
test('prior section tampering cannot supply invented facts before context delivery',()=>fixture(async f=>{
 await factPrior(f);const a=await local(f,'prior-fact-tamper');await answerLocalTask({...a,answer:'差分だけ実施'});
 const path=join(f.root,'.local/memory-reuse/task-confirmations/prior-fact-tamper.json'),s=JSON.parse(await readFile(path,'utf8'));s.prior.sections.a='設定ファイルの場所は forged/config.json。';await writeFile(path,JSON.stringify(s));
 await assert.rejects(primeLocalTaskSource(a),/prior_work_evidence_changed/);
}));
test('required retained facts that cannot fit stop source preparation instead of silently disappearing',()=>fixture(async f=>{
 f.config.task_retained_fact_max_chars=80;await factPrior(f,{long_location:true});const a=await local(f,'facts-too-long');await answerLocalTask({...a,answer:'差分だけ実施'});
 await assert.rejects(primeLocalTaskSource(a),/task_retained_facts_incomplete/);
}));
test('section stdin transport preserves literal shell text and verifies actual native completion',()=>fixture(async f=>{
 const a=await fileLocal(f,'stdin-native');assert.match(a.context,/ORGBRAIN_TASK_SECTIONS/);
 const {taskSectionsCommand}=await import('../packages/orgbrain-cli/src/lib/memory-task-transport.mjs');
 const sections={a:"Use --prompt '依頼文'.",b:'Literal $(touch INJECTED) and `touch INJECTED2`.',c:'Keep "quotes", \\ paths and\nnewlines.'},command=taskSectionsCommand(prefix,'stdin-native',sections);
 const pre=f.invoke('pre',{session_id:'stdin-native',hook_event_name:'PreToolUse',tool_name:'Bash',tool_use_id:'stdin-call',tool_input:{command}});assert.notEqual(pre.value.hookSpecificOutput?.permissionDecision,'deny');
 const p=spawnSync('/bin/sh',['-c',command],{cwd:f.root,env:{...process.env,ORGBRAIN_REUSE_ROOT:f.root,ORGBRAIN_USE_PRINCIPAL:'alice'},encoding:'utf8'});assert.equal(p.status,0,p.stderr);const output=JSON.parse(p.stdout);
 const native={session_id:'stdin-native',hook_event_name:'PostToolUse',tool_name:'Bash',tool_use_id:'stdin-call',tool_input:{command},tool_response:{stdout:p.stdout,exitCode:0}};assert.equal(f.invoke('post',native).status,0);
 const state=JSON.parse(await readFile(join(f.root,'.local/memory-reuse/task-confirmations/stdin-native.json'),'utf8'));assert.equal(state.created_results.length,1);assert.deepEqual(output.artifact.sections,sections);
 await assert.rejects(readFile(join(f.root,'INJECTED')),{code:'ENOENT'});await assert.rejects(readFile(join(f.root,'INJECTED2')),{code:'ENOENT'});
 assert.notEqual(f.invoke('post',{...native,tool_use_id:'replayed-call'}).status,0);
 assert.notEqual(f.invoke('post',{...native,tool_input:{command:taskSectionsCommand(prefix,'stdin-native',{...sections,a:'forged'})}}).status,0);
}));
test('section stdin rejects command additions, substituted delimiters and wrong task scope',()=>fixture(async f=>{
 await fileLocal(f,'stdin-deny');const {taskSectionsCommand}=await import('../packages/orgbrain-cli/src/lib/memory-task-transport.mjs'),command=taskSectionsCommand(prefix,'stdin-deny',{a:'A',b:'B',c:'C'});
 for(const altered of [command+'\ntouch INJECTED',command.replace("<<'ORGBRAIN_TASK_SECTIONS'",'<<ORGBRAIN_TASK_SECTIONS'),command.replace("task 'stdin-deny'","task 'other-task'"),taskSectionsCommand(prefix,'stdin-deny',{task_id:'forged',a:'A'})]){
  const p=f.invoke('pre',{session_id:'stdin-deny',hook_event_name:'PreToolUse',tool_name:'Bash',tool_use_id:'denied',tool_input:{command:altered}});assert.equal(p.value.hookSpecificOutput.permissionDecision,'deny');
 }
}));
test('section stdin delta keeps prior sections and cannot suppress attribution for memory sources',()=>fixture(async f=>{
 await fileLocal(f,'stdin-delta','差分だけ実施');const {taskSectionsCommand}=await import('../packages/orgbrain-cli/src/lib/memory-task-transport.mjs');const command=taskSectionsCommand(prefix,'stdin-delta',{c:'New current constraint.'});
 const p=spawnSync('/bin/sh',['-c',command],{cwd:f.root,env:{...process.env,ORGBRAIN_REUSE_ROOT:f.root,ORGBRAIN_USE_PRINCIPAL:'alice'},encoding:'utf8'});assert.equal(p.status,0,p.stderr);const x=JSON.parse(p.stdout);assert.equal(x.artifact.sections.a,'Alpha requires 8 items.');assert.equal(x.artifact.sections.b,'Beta retains 14 days.');
 assert.equal(f.invoke('post',{session_id:'stdin-delta',hook_event_name:'PostToolUse',tool_name:'Bash',tool_use_id:'delta-stdin',tool_input:{command},tool_response:{stdout:p.stdout,exitCode:0}}).status,0);
 f.workflow.source_mode=undefined;f.workflow.source_refs=[{source_id:'source',source_version:1}];await f.save();
 const a=await local(f,'memory-stdin');await primeLocalTaskSource(a);assert.equal(f.invoke('context',{session_id:'memory-stdin',prompt:f.prompt(['a','b','c'])}).status,0);
 const denied=f.invoke('pre',{session_id:'memory-stdin',hook_event_name:'PreToolUse',tool_name:'Bash',tool_use_id:'no-attribution',tool_input:{command:taskSectionsCommand(prefix,'memory-stdin',{a:'A',b:'B',c:'C'})}});assert.equal(denied.value.hookSpecificOutput.permissionDecision,'deny');
}));
test('compact task receipt keeps full backend proof and detects tampered evidence',()=>fixture(async f=>{
 f.config.task_compact_receipts='on';await fileLocal(f,'compact-task');const {taskSectionsCommand}=await import('../packages/orgbrain-cli/src/lib/memory-task-transport.mjs');
 const sections={a:'Full original section A.',b:'Full original section B.',c:'Full original section C.'},command=taskSectionsCommand(prefix,'compact-task',sections);
 const p=spawnSync('/bin/sh',['-c',command],{cwd:f.root,env:{...process.env,ORGBRAIN_REUSE_ROOT:f.root,ORGBRAIN_USE_PRINCIPAL:'alice'},encoding:'utf8'});assert.equal(p.status,0,p.stderr);const result=JSON.parse(p.stdout);assert.equal(result.artifact.sections,undefined);
 const path=join(f.root,'.local/memory-reuse/invocations',result.reuse_invocation_id+'.json'),privateRecord=JSON.parse(await readFile(path,'utf8'));assert.deepEqual(privateRecord.backend_output.artifact.sections,sections);assert.equal(privateRecord.output.artifact.sections,undefined);assert.ok(privateRecord.timings.adapter_ms>=0);
 const native={session_id:'compact-task',hook_event_name:'PostToolUse',tool_name:'Bash',tool_use_id:'compact-call',tool_input:{command},tool_response:{stdout:p.stdout,exitCode:0}};
 privateRecord.backend_output.artifact.sections.a='forged';await writeFile(path,JSON.stringify(privateRecord));assert.notEqual(f.invoke('post',native).status,0);
 privateRecord.backend_output.artifact.sections=sections;await writeFile(path,JSON.stringify(privateRecord));assert.equal(f.invoke('post',native).status,0);
 const s=JSON.parse(await readFile(join(f.root,'.local/memory-reuse/task-confirmations/compact-task.json'),'utf8'));assert.equal(s.created_results.length,1);
}));
test('full optimization drops prior-file dependency after explicit choice but retains current-source checks',()=>fixture(async f=>{
 await prior(f);f.config.task_full_checks='current_sources_only';const a=await local(f,'full-current');await answerLocalTask({...a,answer:'全体を実施'});
 await writeFile(join(f.root,a.offer.state.prior.path),'old result invalidated');await primeLocalTaskSource(a);
 const c=f.invoke('context',{session_id:'full-current',prompt:f.prompt(['a','b','c'])});assert.equal(c.status,0,c.stderr);
 await writeFile(join(f.root,'source.json'),JSON.stringify({a:'changed'}));assert.notEqual(f.run('full-current',{op:'write',units:['a','b','c'],sections:{a:'A',b:'B',c:'C'}}).result.status,0);
}));
test('full optimization never removes delta prior verification or memory attribution requirements',()=>fixture(async f=>{
 await prior(f);f.config.task_full_checks='current_sources_only';f.config.task_request_mode='sections_stdin';const a=await local(f,'delta-current');await answerLocalTask({...a,answer:'差分だけ実施'});
 await writeFile(join(f.root,a.offer.state.prior.path),'old result invalidated');await assert.rejects(primeLocalTaskSource(a),/prior_work_no_longer_available/);
}));
test('local confirmation supplies only approved source and a native patch preserves prior sections',()=>fixture(async f=>{
 await prior(f);const a=await local(f);assert.equal(a.offer.state.choice,'pending');
 const blocked=f.run('local-task',{op:'read',units:['c']});assert.notEqual(blocked.result.status,0);
 await answerLocalTask({...a,answer:'差分だけ実施'});await primeLocalTaskSource(a);
 assert.notEqual(f.run('local-task',{op:'patch',units:['c'],sections:{c:'Gamma runs locally.'}}).result.status,0,'No context was delivered yet');
 const context=f.invoke('context',{session_id:'local-task',prompt:f.prompt(['a','b','c'])});assert.equal(context.status,0,context.stderr);
 const content=context.value.hookSpecificOutput.additionalContext;assert.match(content,/Gamma runs locally/);assert.doesNotMatch(content,/Alpha requires 8|Beta retains 14|AskUserQuestion/);
 const {req,result}=f.run('local-task',{op:'patch',units:['c'],sections:{c:'Gamma runs locally.'}});assert.equal(result.status,0,result.stderr);
 assert.deepEqual(result.value.artifact.sections,{a:'Alpha requires 8 items.',b:'Beta retains 14 days.',c:'Gamma runs locally.'});
 assert.equal(f.post('local-task',req,result.value,'patch-native').status,0);
 const done=f.invoke('stop',{session_id:'local-task',hook_event_name:'Stop'});assert.equal(done.status,0,done.stderr);
 const observation=JSON.parse(await readFile(join(f.root,'.local/memory-reuse/last-observation.json'),'utf8'));
 assert.equal(observation.task_completion.status,'completed_delta');assert.equal(observation.task_completion.executed_operations,1);assert.equal(observation.task_completion.host_read_operations,1);assert.equal(observation.task_completion.answer_call_id,null);
}));
test('local cancellation does not authorize work and host read requires a decision',()=>fixture(async f=>{
 await prior(f);const a=await local(f);await answerLocalTask({...a,answer:''});
 await assert.rejects(primeLocalTaskSource(a),/confirmation_required/);assert.notEqual(f.run('local-task',{op:'write',units:['a','b','c'],sections:{a:'a',b:'b',c:'c'}}).result.status,0);
}));
test('local source and prompt bindings reject changes before model launch',()=>fixture(async f=>{
 await prior(f);const a=await local(f);await answerLocalTask({...a,answer:'差分だけ実施'});await primeLocalTaskSource(a);
 assert.notEqual(f.invoke('context',{session_id:'local-task',prompt:f.prompt(['a','b'])}).status,0);
 await writeFile(join(f.root,'source.json'),'{}');assert.notEqual(f.invoke('context',{session_id:'local-task',prompt:f.prompt(['a','b','c'])}).status,0);
}));
test('local candidate and host context remain principal scoped',()=>fixture(async f=>{
 await prior(f);const a=await local(f);await answerLocalTask({...a,answer:'差分だけ実施'});await primeLocalTaskSource(a);
 assert.notEqual(f.invoke('context',{session_id:'local-task',prompt:f.prompt(['a','b','c'])},false,'outsider').status,0);
}));
test('local patch rejects old units and altered injected source receipt',()=>fixture(async f=>{
 await prior(f);const a=await local(f);await answerLocalTask({...a,answer:'差分だけ実施'});await primeLocalTaskSource(a);
 assert.equal(f.invoke('context',{session_id:'local-task',prompt:f.prompt(['a','b','c'])}).status,0);
 assert.notEqual(f.run('local-task',{op:'patch',units:['a','c'],sections:{a:'changed',c:'Gamma runs locally.'}}).result.status,0);
 const path=join(f.root,'.local/memory-reuse/task-confirmations/local-task.json'),s=JSON.parse(await readFile(path,'utf8'));s.local.source.output.sections.c='Forged source';await writeFile(path,JSON.stringify(s));
 assert.notEqual(f.run('local-task',{op:'patch',units:['c'],sections:{c:'Gamma runs locally.'}}).result.status,0);
}));
test('local launcher uses explicit simulated input only in test scope and never starts a model in prepare-only mode',()=>fixture(async f=>{
 await prior(f);f.config.task_local_mode='on';f.workflow.local_source_field='sections';await f.save();
 const request=join(f.root,'local-request.json');await writeFile(request,JSON.stringify({session_id:'launcher',prompt:f.prompt(['a','b','c'])}));
 const launcher=resolve('scripts/memory-reuse-task-local.mjs'),argv=[launcher,'--request',request,'--prepare-only','--simulate-answer','差分だけ実施'];
 const env={...process.env,ORGBRAIN_REUSE_ROOT:f.root,ORGBRAIN_USE_PRINCIPAL:'alice'};
 const forbidden=spawnSync(process.execPath,argv,{env,encoding:'utf8'});assert.notEqual(forbidden.status,0);
 const prepared=spawnSync(process.execPath,argv,{env:{...env,ORGBRAIN_TASK_EVAL_SIMULATION:'1'},encoding:'utf8'});assert.equal(prepared.status,0,prepared.stderr);
 const receipt=JSON.parse(prepared.stdout);assert.equal(receipt.model_starts,0);assert.equal(receipt.decision_source,'simulated_local_user');assert.equal(receipt.human_wait_ms,0);
 assert.notEqual(f.run('launcher',{op:'patch',units:['c'],sections:{c:'Gamma runs locally.'}}).result.status,0);
}));
test('revoked team grant invalidates a locally confirmed task before launch',()=>fixture(async f=>{
 await prior(f);const a=await local(f,'local-team','bob');await answerLocalTask({...a,answer:'差分だけ実施'});await primeLocalTaskSource(a);
 const db=await a.reuse.open();try{db.prepare('DELETE FROM memory_reuse_artifact_grants WHERE principal=?').run('bob');}finally{db.close();}
 assert.notEqual(f.invoke('context',{session_id:'local-team',prompt:f.prompt(['a','b','c'])},false,'bob').status,0);
}));
test('project file work retains exact file provenance without inventing a memory record',()=>fixture(async f=>{
 f.workflow.source_mode='project_files';f.workflow.source_refs=[];f.workflow.allowed_principals=[];await f.save();
 await prior(f);
 const a=await local(f,'files-local');assert.ok(a.offer.question);
 assert.equal(a.offer.state.prior.source_mode,'project_files');
 assert.equal(a.offer.state.prior.file_sources[0].path,'source.json');
 assert.match(a.offer.state.prior.file_sources[0].sha256,/^[a-f0-9]{64}$/);
 await assert.rejects(reuseWithoutAction(),/completed_action_required/);
 async function reuseWithoutAction(){return a.reuse.createArtifact({kind:'result',object_type_key:'completed_work',object_id:'fixture',refs:[],payload:a.offer.state.prior,fingerprint:a.offer.state.source_fingerprint});}
 await assert.rejects(a.reuse.createArtifact({kind:'result',object_type_key:'completed_work',object_id:'fixture',refs:[],payload:a.offer.state.prior,fingerprint:a.offer.state.source_fingerprint,allowed_principals:['bob']}),/file_work_sharing_requires_source_permissions/);
 const db=await a.reuse.open();try{assert.equal(db.prepare('select count(*) n from memories').get().n,1);}finally{db.close();}
 await writeFile(join(f.root,'source.json'),JSON.stringify({a:'changed'}));
 await assert.rejects(answerLocalTask({...a,answer:'既存成果で完了'}),/prior_work_no_longer_available/);
}));
test('native host UI answers keep actual question provenance and reject a mismatched session',()=>fixture(async f=>{
 await prior(f);f.config.observation_purpose='task';await f.save();const a=await local(f,'native-ui');
 const evidence={source:'native_question_answer',call_id:'call_actual_question',session_id:'different',answer:'差分だけ実施'};
 await assert.rejects(answerLocalTask({...a,answer:evidence.answer,confirmation_evidence:evidence}),/human_answer_evidence_mismatch/);
 evidence.session_id='native-ui';const result=await answerLocalTask({...a,answer:evidence.answer,confirmation_evidence:evidence});assert.equal(result.choice,'delta');
 const state=JSON.parse(await readFile(join(f.root,'.local/memory-reuse/task-confirmations/native-ui.json'),'utf8'));assert.equal(state.decision_source,'native_question_answer');assert.deepEqual(state.local.decision.human_evidence,evidence);
}));
test('large source uses a bound CLI source envelope and never relies on a truncated hook',()=>fixture(async f=>{
 await writeFile(join(f.root,'source.json'),JSON.stringify({a:'Complete original source. '.repeat(600),b:'Beta retains 14 days.',c:'Gamma runs locally.'}));
 f.config.task_confirmation_mode='ask';
 const a=await local(f,'long-source');await primeLocalTaskSource(a);const envelope=await localTaskSourceEnvelope(a);
 assert.ok(envelope.content.length>10000);assert.match(envelope.content,/Complete original source/);
 const missing=f.invoke('context',{session_id:'long-source',prompt:f.prompt(['a','b','c'])});assert.notEqual(missing.status,0);assert.match(missing.stderr,/source_envelope_required/);
 const p=spawnSync(process.execPath,[helper,'context'],{cwd:f.root,env:{...process.env,ORGBRAIN_REUSE_ROOT:f.root,ORGBRAIN_USE_PRINCIPAL:'alice',ORGBRAIN_TASK_SOURCE_ENVELOPE_DIGEST:envelope.digest},input:JSON.stringify({cwd:f.root,session_id:'long-source',prompt:f.prompt(['a','b','c'])}),encoding:'utf8'});
 assert.equal(p.status,0,p.stderr);const context=JSON.parse(p.stdout).hookSpecificOutput.additionalContext;assert.ok(context.length<10000);assert.doesNotMatch(context,/Complete original source/);assert.match(context,/CLI source envelope/);
 const s=JSON.parse(await readFile(join(f.root,'.local/memory-reuse/task-confirmations/long-source.json'),'utf8'));assert.equal(s.local.source_delivery,'cli_system_append');assert.equal(s.local.source_envelope_digest,envelope.digest);
}));
test('local control route does not offer prior work and still requires delivered context',()=>fixture(async f=>{
 await prior(f);f.config.task_local_mode='on';f.workflow.local_source_field='sections';await f.save();
 const reuse=new MemoryReuse(f.store,{tenant_id:'default',project_id:'org-brain',principal_id:'alice',work_type:'implementation'});
 const a={root:f.root,reuse,config:f.config,prefix,input:{session_id:'control-local',prompt:f.prompt(['a','b','c'])},condition:'control'};
 const offer=await prepareLocalTask(a);assert.equal(offer.question,null);assert.equal(offer.state.prior,undefined);assert.equal(offer.state.local.condition,'control');
 assert.notEqual(f.run('control-local',{op:'read',units:['a']}).result.status,0);
}));
test('local model cannot read before the prepared context is consumed',()=>fixture(async f=>{
 await prior(f);const a=await local(f);await answerLocalTask({...a,answer:'差分だけ実施'});await primeLocalTaskSource(a);
 assert.notEqual(f.run('local-task',{op:'read',units:['c']}).result.status,0);
}));
test('expired local decision cannot start the host source read',()=>fixture(async f=>{
 await prior(f);const a=await local(f);await answerLocalTask({...a,answer:'差分だけ実施'});
 const path=join(f.root,'.local/memory-reuse/task-confirmations/local-task.json'),s=JSON.parse(await readFile(path,'utf8'));s.local.created_at-=31*60000;await writeFile(path,JSON.stringify(s));
 await assert.rejects(primeLocalTaskSource(a),/expired/);
}));
test('complete prior work is presented with author and result; unanswered and preselected values never execute',()=>fixture(async f=>{
 await prior(f);const state=await offer(f);assert.match(state.question.question,/alice/);assert.match(state.question.question,/results\//);assert.equal(state.choice,'pending');
 const denied=f.invoke('pre',{session_id:'next',tool_name:'Bash',tool_use_id:'attempt',tool_input:{command:'echo work'}});assert.equal(denied.value.hookSpecificOutput.permissionDecision,'deny');
 assert.notEqual(f.run('next',{op:'read',units:['a']}).result.status,0);
 const forged=f.invoke('pre',{session_id:'next',tool_name:'AskUserQuestion',tool_use_id:'forged',tool_input:{questions:[state.question],answers:{[state.question.question]:'全体を実施'}}});assert.equal(forged.value.hookSpecificOutput.permissionDecision,'deny');
}));
test('another configured adapter cannot bypass a pending task through direct run',()=>fixture(async f=>{
 await prior(f);await offer(f);f.config.action_adapters.other={...f.config.action_adapters.work,task_workflow:undefined};await f.save();
 const bypass=f.invoke('run',{task_id:'claude:next',adapter:'other',input:{op:'read',units:['a']},uses:[]},true);assert.notEqual(bypass.status,0);
}));
test('accepting the existing result completes the task without any new work or original-use receipt',()=>fixture(async f=>{
 await prior(f);const state=await offer(f,['a','b']);const a=answer(f,state,'既存成果で完了');assert.equal(a.status,0,a.stderr);assert.notEqual(f.run('next',{op:'read',units:['a']}).result.status,0);
 const stop=f.invoke('stop',{session_id:'next'});assert.equal(stop.status,0,stop.stderr);const o=JSON.parse(await readFile(join(f.root,'.local/memory-reuse/last-observation.json'),'utf8'));assert.equal(o.task_completion.status,'completed_with_existing_result');assert.equal(o.task_completion.decision_source,'simulated');assert.equal(o.collection.recorded,0);assert.equal(o.task_completion.executed_operations,0);
}));
test('delta execution is restricted to approved gaps and preserves the existing sections',()=>fixture(async f=>{
 await prior(f);const state=await offer(f);assert.equal(answer(f,state,'差分だけ実施').status,0);
 assert.notEqual(f.run('next',{op:'read',units:['a']}).result.status,0);const read=f.run('next',{op:'read',units:['c']});assert.equal(read.result.status,0);assert.equal(f.post('next',read.req,read.result.value,'read-native').status,0);
 assert.notEqual(f.run('next',{op:'write',units:['a','b','c'],sections:{a:'changed',b:'Beta retains 14 days.',c:'Gamma runs locally.'}}).result.status,0);
 const {req,result}=f.run('next',{op:'write',units:['a','b','c'],sections:{a:'Alpha requires 8 items.',b:'Beta retains 14 days.',c:'Gamma runs locally.'}});assert.equal(result.status,0,result.stderr);assert.equal(f.post('next',req,result.value,'new-native').status,0);assert.equal(f.invoke('stop',{session_id:'next'}).status,0);
 const o=JSON.parse(await readFile(join(f.root,'.local/memory-reuse/last-observation.json'),'utf8'));assert.equal(o.task_completion.status,'completed_delta');assert.deepEqual(o.task_completion.reused_units,['a','b']);
}));
test('full execution is allowed only after the answer and requires all requested units',()=>fixture(async f=>{
 await prior(f);const state=await offer(f);assert.equal(answer(f,state,'全体を実施').status,0);assert.equal(f.run('next',{op:'read',units:['a','b','c']}).result.status,0);
 assert.notEqual(f.run('next',{op:'write',units:['c'],sections:{c:'Gamma runs locally.'}}).result.status,0);
 assert.notEqual(f.run('next',{op:'write',units:['a','b','c'],sections:{a:'Alpha requires 8 items.',b:'Beta retains 14 days.',c:'Gamma runs locally.'}}).result.status,0,'an uncompleted read cannot attest full fresh work');
}));
test('changed source bytes prevent a prior result offer',()=>fixture(async f=>{
 await prior(f);await writeFile(join(f.root,'source.json'),'{}');const c=f.invoke('context',{session_id:'changed',prompt:f.prompt(['a','b'])});assert.equal(c.status,0,c.stderr);assert.doesNotMatch(c.value.hookSpecificOutput.additionalContext,/AskUserQuestion/);
}));
test('native cancellation or an unknown answer keeps the task pending',()=>fixture(async f=>{
 await prior(f);const state=await offer(f);assert.equal(answer(f,state,'unrecognized').status,0);assert.notEqual(f.run('next',{op:'read',units:['a']}).result.status,0);
 const cancelled=f.invoke('post',{session_id:'next',hook_event_name:'PostToolUseFailure',tool_name:'AskUserQuestion',tool_use_id:'question-native',tool_input:{questions:[state.question]},tool_response:{is_error:true}});assert.equal(cancelled.status,0,cancelled.stderr);
}));
test('a delta with no declared gap asks for explicit units before any work',()=>fixture(async f=>{
 await prior(f);const state=await offer(f,['a','b']);assert.equal(answer(f,state,'差分だけ実施').status,0);assert.notEqual(f.run('next',{op:'read',units:['a']}).result.status,0);
 const next=JSON.parse(await readFile(join(f.root,'.local/memory-reuse/task-confirmations/next.json'),'utf8'));assert.equal(next.choice,'pending_delta');assert.equal(answer(f,next,'Alpha','delta-question').status,0);assert.equal(f.run('next',{op:'read',units:['a']}).result.status,0);assert.notEqual(f.run('next',{op:'read',units:['b']}).result.status,0);
}));
test('native question JSON key order and omitted default false do not change the user question',()=>fixture(async f=>{
 await prior(f);const s=await offer(f),q=s.question,reordered={header:q.header,options:q.options.map(o=>({description:o.description,label:o.label})),question:q.question};
 const p=f.invoke('pre',{session_id:'next',tool_name:'AskUserQuestion',tool_use_id:'reordered',tool_input:{questions:[reordered]}});assert.equal(p.status,0,p.stderr);assert.notEqual(p.value.hookSpecificOutput?.permissionDecision,'deny');
 const r=f.invoke('post',{session_id:'next',hook_event_name:'PostToolUse',tool_name:'AskUserQuestion',tool_use_id:'reordered',tool_input:{questions:[reordered]},tool_response:{answers:{[q.question]:'全体を実施'}}});assert.equal(r.status,0,r.stderr);
}));
for(const kind of ['analysis','document'])test(kind+' workflow uses the same explicit acceptance gate',()=>fixture(async f=>{
 f.workflow.kind=kind;await f.save();await prior(f);const s=await offer(f,['a','b']);assert.equal(s.kind,kind);assert.equal(answer(f,s,'既存成果で完了').status,0);assert.notEqual(f.run('next',{op:'read',units:['a']}).result.status,0);
}));
test('an output without completed native evidence cannot become an existing result',()=>fixture(async f=>{
 assert.equal(f.invoke('context',{prompt:f.prompt(['a','b'])}).status,0);assert.equal(f.run('prior',{op:'write',units:['a','b'],sections:{a:'Alpha requires 8 items.',b:'Beta retains 14 days.'}}).result.status,0);f.config.task_confirmation_mode='ask';await f.save();const c=f.invoke('context',{session_id:'next',prompt:f.prompt(['a','b'])});assert.equal(c.status,0,c.stderr);assert.doesNotMatch(c.value.hookSpecificOutput.additionalContext,/AskUserQuestion/);
}));
test('expired or edited results are not offered',()=>fixture(async f=>{
 await prior(f);let db=f.store.open();db.prepare("update memory_reuse_artifacts set created_at=0 where object_type_key='completed_work'").run();db.close();let c=f.invoke('context',{session_id:'expired',prompt:f.prompt(['a','b'])});assert.equal(c.status,0,c.stderr);assert.doesNotMatch(c.value.hookSpecificOutput.additionalContext,/AskUserQuestion/);
 db=f.store.open();const row=db.prepare("select payload_json from memory_reuse_artifacts where object_type_key='completed_work'").get();db.prepare("update memory_reuse_artifacts set created_at=? where object_type_key='completed_work'").run(Date.now());db.close();await writeFile(join(f.root,JSON.parse(row.payload_json).path),'edited');c=f.invoke('context',{session_id:'edited',prompt:f.prompt(['a','b'])});assert.equal(c.status,0,c.stderr);assert.doesNotMatch(c.value.hookSpecificOutput.additionalContext,/AskUserQuestion/);
}));
test('an answer without the matching question call and another principal cannot authorize work',()=>fixture(async f=>{
 await prior(f);const s=await offer(f);const forged=f.invoke('post',{session_id:'next',hook_event_name:'PostToolUse',tool_name:'AskUserQuestion',tool_use_id:'invented',tool_input:{questions:[s.question]},tool_response:{answers:{[s.question.question]:'全体を実施'}}});assert.notEqual(forged.status,0);assert.notEqual(f.invoke('run',{task_id:'claude:next',adapter:'work',input:{op:'read',units:['a']},uses:[]},true,'bob').status,0);
}));
test('changing the source after user acceptance prevents a verified task completion',()=>fixture(async f=>{
 await prior(f);const s=await offer(f,['a','b']);assert.equal(answer(f,s,'既存成果で完了').status,0);await writeFile(join(f.root,'source.json'),'{}');const stop=f.invoke('stop',{session_id:'next'});assert.equal(stop.status,0,stop.stderr);const o=JSON.parse(await readFile(join(f.root,'.local/memory-reuse/last-observation.json'),'utf8'));assert.equal(o.task_completion.status,'verification_missing');
}));
test('a granted team member can see prior work but an ungranted principal cannot',()=>fixture(async f=>{
 await prior(f);await offer(f,['a','b'],'bob-session','bob');const c=f.invoke('context',{session_id:'eve-session',prompt:f.prompt(['a','b'])},false,'eve');assert.equal(c.status,0,c.stderr);assert.doesNotMatch(c.value.hookSpecificOutput.additionalContext,/AskUserQuestion/);
}));
test('hook installation preserves unrelated hooks and adds a task pre-check only when requested',()=>{
 const old={hooks:{PreToolUse:[{matcher:'Write',hooks:[{type:'command',command:'unrelated'}]}]}};const configured=mergeReuseHooks(old,prefix,{bundled:true,taskConfirmation:true});assert.equal(configured.hooks.PreToolUse[0].hooks[0].command,'unrelated');assert.ok(configured.hooks.PreToolUse.some(x=>x.hooks.some(h=>h.command===prefix+' pre')));assert.deepEqual(mergeReuseHooks(old,prefix).hooks.PreToolUse,old.hooks.PreToolUse);
});
