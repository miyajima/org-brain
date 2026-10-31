import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {LocalMemoryStore} from '../packages/orgbrain-cli/src/lib/local-memory-store.mjs';
import {MemoryReuse} from '../packages/orgbrain-cli/src/lib/memory-reuse.mjs';
const helper=resolve('scripts/memory-reuse-claude.mjs');
async function fixture(fn){
 const root=await mkdtemp(join(tmpdir(),'reuse-bundled-')),db=join(root,'memory.sqlite'),store=new LocalMemoryStore(db,{denseEmbeddingProvider:null});
 await store.init();await mkdir(join(root,'docs'));await writeFile(join(root,'docs/rules.md'),'Synthetic target');await mkdir(join(root,'.local/memory-reuse'),{recursive:true});
 const seed=extra=>store.capture({id:'rule',external_key:'test:bundled',tenant_id:'default',project_id:'org-brain',work_type:'implementation',kind:'fact',content:'Use batch 8 and preserve the exact target.',rationale:'Synthetic input restriction.',reuse_rule:'Only rules.plan at the current version.',source:'unit-test-fixture',verification_state:'verified',verified_at:Date.now(),learning:{fixture:true},capture_origin:'observed',source_references:[{ref:'docs/rules.md'}],...extra});
 await seed({});
 await writeFile(join(root,'adapter.mjs'),`import {appendFile} from 'node:fs/promises';const x=JSON.parse(process.argv.at(-1));await appendFile(${JSON.stringify(join(root,'executed.jsonl'))},JSON.stringify(x)+'\\n');console.log(JSON.stringify({ok:x.plan?.batch===8,applied_plan:x.plan}));`);
 const config={tenant_id:'default',project_id:'org-brain',db_path:db,flags:{object:true},delivery_mode:'inline',tracking_mode:'bundled',observation_purpose:'test',action_adapters:{plan:{argv:[process.execPath,join(root,'adapter.mjs')],operations:['apply'],object_type_key:'file',object_id:'docs/rules.md',target_field:'plan.target',target_value:'rules'}}};
 await writeFile(join(root,'.local/memory-reuse/config.json'),JSON.stringify(config));
 const invoke=(command,input,raw=false,principal='alice')=>{
  const p=spawnSync(process.execPath,[helper,command,...(raw?[JSON.stringify(input)]:[])],{env:{...process.env,ORGBRAIN_REUSE_ROOT:root,ORGBRAIN_USE_PRINCIPAL:principal},input:raw?undefined:JSON.stringify({cwd:root,session_id:'test',...input}),encoding:'utf8'});
  return {status:p.status,stderr:p.stderr,value:p.stdout?JSON.parse(p.stdout):null};
 };
 const item=()=>{const d=store.open();try{return d.prepare('select id from memory_usage_items order by rowid desc').get()?.id;}finally{d.close();}};
 const command=req=>`${process.execPath} ${helper} run '${JSON.stringify(req)}'`;
 const request=uses=>({task_id:'claude:test',adapter:'plan',input:{op:'apply',plan:{target:'rules',batch:8}},uses});
 const post=(req,result,id='native-action')=>invoke('post',{hook_event_name:'PostToolUse',tool_name:'Bash',tool_use_id:id,tool_input:{command:command(req)},tool_response:{stdout:JSON.stringify(result),exitCode:0}});
 const stop=()=>{const r=invoke('stop',{});assert.equal(r.status,0,r.stderr);return readFile(join(root,'.local/memory-reuse/last-observation.json'),'utf8').then(JSON.parse);};
 try{await fn({root,store,seed,invoke,item,request,post,stop,config});}finally{await rm(root,{recursive:true,force:true});}
}
test('explicit use travels with one real action; Stop verifies it without a fabricated report tool call',()=>fixture(async({root,store,invoke,item,request,post,stop})=>{
 const context=invoke('context',{prompt:'Check docs/rules.md'});assert.equal(context.status,0,context.stderr);
 const req=request([item()]),run=invoke('run',req,true);assert.equal(run.status,0,run.stderr);assert.equal(run.value.ok,true);
 const d=store.open();assert.equal(d.prepare('select count(*) n from memory_use_contexts').get().n,0);d.close();
 const p=post(req,run.value);assert.equal(p.status,0,p.stderr);assert.ok(p.value.hookSpecificOutput.additionalContext.includes('use_receipt'));
 const o=await stop();assert.equal(o.collection.recorded,1);assert.equal(o.collection.delivered,1);assert.deepEqual(o.collection.rejected,[]);
 const journal=await readFile(join(root,'.local/memory-reuse/native-evidence', (await import('node:crypto')).createHash('sha256').update('test').digest('hex')+'.jsonl'),'utf8');
 const calls=journal.trim().split('\n').map(JSON.parse).filter(r=>r.payload.type==='function_call');assert.equal(calls.length,1);assert.equal(calls[0].payload.call_id,'native-action');
 await stop();const db=store.open();assert.equal(db.prepare('select count(*) n from memory_use_contexts').get().n,1);db.close();
}));
test('delivery and successful action without explicit selection stay unassessed',()=>fixture(async({invoke,request,post,stop})=>{
 assert.equal(invoke('context',{prompt:'Check docs/rules.md'}).status,0);const req=request([]),run=invoke('run',req,true);assert.equal(run.status,0,run.stderr);assert.equal(post(req,run.value).status,0);assert.equal((await stop()).collection.recorded,0);
}));
test('unknown item, wrong task, target or operation never execute a bundled action',()=>fixture(async({root,invoke,item,request})=>{
 assert.equal(invoke('context',{prompt:'Check docs/rules.md'}).status,0);const req=request([item()]);
 for(const bad of [{...req,uses:['invented']},{...req,task_id:'claude:other'},{...req,input:{op:'apply',plan:{target:'other',batch:8}}},{...req,input:{op:'delete'}}])assert.notEqual(invoke('run',bad,true).status,0);
 await assert.rejects(readFile(join(root,'executed.jsonl')),/ENOENT/);
}));
test('failed native action cannot become verified use',()=>fixture(async({invoke,item,request,post,stop})=>{
 assert.equal(invoke('context',{prompt:'Check docs/rules.md'}).status,0);const req=request([item()]);req.input.plan.batch=9;const failed=invoke('run',req,true);assert.equal(failed.status,0,failed.stderr);assert.equal(failed.value.ok,false);assert.equal(post(req,failed.value).status,0);assert.equal((await stop()).collection.recorded,0);
}));
test('source update after action and before its native completion is rejected',()=>fixture(async({invoke,item,request,post,seed,stop})=>{
 assert.equal(invoke('context',{prompt:'Check docs/rules.md'}).status,0);const req=request([item()]),run=invoke('run',req,true);assert.equal(run.status,0,run.stderr);await seed({content:'Use batch 9 after the update.'});assert.notEqual(post(req,run.value).status,0);assert.equal((await stop()).collection.recorded,0);
}));
test('another principal cannot attach the first principal delivery to its action',()=>fixture(async({root,invoke,item,request})=>{
 assert.equal(invoke('context',{prompt:'Check docs/rules.md'}).status,0);assert.notEqual(invoke('run',request([item()]),true,'bob').status,0);await assert.rejects(readFile(join(root,'executed.jsonl')),/ENOENT/);
}));
test('a changed native command or fabricated invocation never attaches the registered receipt',()=>fixture(async({invoke,item,request,post,stop})=>{
 assert.equal(invoke('context',{prompt:'Check docs/rules.md'}).status,0);const req=request([item()]),run=invoke('run',req,true);assert.equal(run.status,0,run.stderr);
 assert.notEqual(post({...req,uses:[]},run.value,'changed-command').status,0);
 assert.notEqual(post(req,{...run.value,reuse_invocation_id:'00000000-0000-0000-0000-000000000000'},'invented').status,0);
 assert.equal((await stop()).collection.recorded,0);
}));
test('a completed invocation cannot be replayed as a second native action',()=>fixture(async({invoke,item,request,post,stop})=>{
 assert.equal(invoke('context',{prompt:'Check docs/rules.md'}).status,0);const req=request([item()]),run=invoke('run',req,true);assert.equal(run.status,0,run.stderr);assert.equal(post(req,run.value).status,0);
 assert.notEqual(post(req,run.value,'another-native-action').status,0);assert.equal((await stop()).collection.recorded,1);
}));
test('version change after the host receipt but before Stop remains unverified',()=>fixture(async({invoke,item,request,post,seed,stop})=>{
 assert.equal(invoke('context',{prompt:'Check docs/rules.md'}).status,0);const req=request([item()]),run=invoke('run',req,true);assert.equal(run.status,0,run.stderr);assert.equal(post(req,run.value).status,0);await seed({content:'Use batch 9 after the update.'});const o=await stop();assert.equal(o.collection.recorded,0);
}));
async function enableFreshness(f){
 await writeFile(join(f.root,'docs/source.json'),'{"batch":8}');
 await writeFile(join(f.root,'validate.mjs'),`import {readFile} from 'node:fs/promises';const p=JSON.parse(process.argv.at(-1));const r=JSON.parse(await readFile(p.source_files[0],'utf8'));console.log(JSON.stringify({ok:p.memories[0].content.includes('batch '+r.batch)}));`);
 f.config.freshness_mode='validated';f.config.freshness_profiles={rules:{argv:[process.execPath,join(f.root,'validate.mjs')],refs:[{source_id:'rule',source_version:1}],source_files:['docs/source.json'],environment:{service:'fixture-v1'},valid_for_ms:60000}};
 Object.assign(f.config.action_adapters.plan,{freshness_profile:'rules',conditions:{target:'rules',records:25}});
 await writeFile(join(f.root,'.local/memory-reuse/config.json'),JSON.stringify(f.config));
 const prime=f.invoke('prime',{profile_id:'rules',input:{target:'rules',records:25}},true);assert.equal(prime.status,0,prime.stderr);
}
test('freshness is checked inside the attributed action, without an extra model lookup',()=>fixture(async f=>{
 await enableFreshness(f);assert.equal(f.invoke('context',{prompt:'Check docs/rules.md'}).status,0);const req={...f.request([f.item()]),freshness_profile:'rules'},run=f.invoke('run',req,true);assert.equal(run.status,0,run.stderr);assert.equal(run.value.ok,true);assert.equal(f.post(req,run.value).status,0);assert.equal((await f.stop()).collection.recorded,1);
}));
test('changed source proof rejects the action before execution and requests fresh investigation',()=>fixture(async f=>{
 await enableFreshness(f);assert.equal(f.invoke('context',{prompt:'Check docs/rules.md'}).status,0);await writeFile(join(f.root,'docs/source.json'),'{"batch":9}');const req={...f.request([f.item()]),freshness_profile:'rules'},run=f.invoke('run',req,true);assert.equal(run.status,0,run.stderr);assert.equal(run.value.ok,false);assert.equal(run.value.freshness_check.fresh,false);await assert.rejects(readFile(join(f.root,'executed.jsonl')),/ENOENT/);
}));
test('source dependency changed after an accepted host receipt cannot verify at Stop',()=>fixture(async f=>{
 await enableFreshness(f);assert.equal(f.invoke('context',{prompt:'Check docs/rules.md'}).status,0);const req={...f.request([f.item()]),freshness_profile:'rules'},run=f.invoke('run',req,true);assert.equal(run.status,0,run.stderr);assert.equal(f.post(req,run.value).status,0);await writeFile(join(f.root,'docs/source.json'),'{"batch":9}');assert.equal((await f.stop()).collection.recorded,0);
}));
async function enableResolution(f){
 await enableFreshness(f);
 const validator=join(f.root,'validate.mjs');await writeFile(validator,`import {readFile} from 'node:fs/promises';const p=JSON.parse(process.argv.at(-1));const r=JSON.parse(await readFile(p.source_files[0],'utf8'));console.log(JSON.stringify({ok:p.memories[0].content.includes('batch '+r.batch),coverage:{kind:'complete_source',fields:['batch','target']}}));`);
 const source=join(f.root,'source.mjs');await writeFile(source,`import {readFile,appendFile} from 'node:fs/promises';await appendFile(${JSON.stringify(join(f.root,'source-read.jsonl'))},'read\\n');const r=JSON.parse(await readFile(${JSON.stringify(join(f.root,'docs/source.json'))},'utf8'));console.log(JSON.stringify({ok:true,rules:r}));`);
 const action=f.config.action_adapters.plan;Object.assign(action,{source_argv:[process.execPath,source],source_requests:[{op:'read'}],required_fields:['batch','target']});
 f.config.source_resolution='verified';f.config.freshness_profiles.rules.coverage_contract={kind:'complete_source',fields:['batch','target']};
 await writeFile(join(f.root,'.local/memory-reuse/config.json'),JSON.stringify(f.config));
 const p=f.invoke('prime',{profile_id:'rules',input:action.conditions},true);assert.equal(p.status,0,p.stderr);
}
test('verified complete task context skips duplicate source execution; resolution alone is not use',()=>fixture(async f=>{
 await enableResolution(f);const context=f.invoke('context',{prompt:'Check docs/rules.md\n<task_input>{"target":"rules","records":25}</task_input>'});assert.equal(context.status,0,context.stderr);assert.ok(context.value.hookSpecificOutput.additionalContext.includes('current_for_exact_input'));
 const lookup=f.invoke('resolve',{task_id:'claude:test',adapter:'plan'},true);assert.equal(lookup.status,0,lookup.stderr);assert.equal(lookup.value.source,'verified_context');await assert.rejects(readFile(join(f.root,'source-read.jsonl')),/ENOENT/);
 assert.equal((await f.stop()).collection.recorded,0);
}));
test('changed dependency and explicit refresh read the current source',()=>fixture(async f=>{
 await enableResolution(f);assert.equal(f.invoke('context',{prompt:'Check docs/rules.md\n<task_input>{"target":"rules","records":25}</task_input>'}).status,0);
 let r=f.invoke('resolve',{task_id:'claude:test',adapter:'plan',refresh:true},true);assert.equal(r.status,0,r.stderr);assert.equal(r.value.source,'current_source');
 await writeFile(join(f.root,'docs/source.json'),'{"batch":9}');r=f.invoke('resolve',{task_id:'claude:test',adapter:'plan'},true);assert.equal(r.status,0,r.stderr);assert.equal(r.value.source,'current_source');assert.equal(r.value.results[0].rules.batch,9);
}));
test('an unreceived or other-task reference cannot suppress source resolution',()=>fixture(async f=>{
 await enableResolution(f);let r=f.invoke('resolve',{task_id:'claude:test',adapter:'plan'},true);assert.equal(r.status,0,r.stderr);assert.equal(r.value.source,'current_source');
 assert.equal(f.invoke('context',{prompt:'Check docs/rules.md\n<task_input>{"target":"rules","records":25}</task_input>'}).status,0);r=f.invoke('resolve',{task_id:'claude:other',adapter:'plan'},true);assert.equal(r.status,0,r.stderr);assert.equal(r.value.source,'current_source');
}));
test('resolution accepts only a configured source and never an arbitrary command',()=>fixture(async f=>{
 await enableResolution(f);assert.notEqual(f.invoke('resolve',{task_id:'claude:test',adapter:'invented'},true).status,0);assert.notEqual(f.invoke('resolve',{task_id:'claude:test',adapter:'plan',argv:['echo','fake']},true).status,0);await assert.rejects(readFile(join(f.root,'source-read.jsonl')),/ENOENT/);
}));
test('missing or conflicting task input and incomplete coverage never claim a complete current source',()=>fixture(async f=>{
 await enableResolution(f);
 for(const prompt of ['Check docs/rules.md','Check docs/rules.md\n<task_input>{"target":"rules","records":26}</task_input>','Check docs/rules.md\n<task_input>{"target":"rules","records":25}</task_input><task_input>{"target":"rules","records":26}</task_input>']){
  const r=f.invoke('context',{prompt});assert.equal(r.status,0,r.stderr);assert.equal(r.value.hookSpecificOutput.additionalContext.includes('current_for_exact_input'),false);
 }
 delete f.config.freshness_profiles.rules.coverage_contract;await writeFile(join(f.root,'.local/memory-reuse/config.json'),JSON.stringify(f.config));
 const r=f.invoke('context',{prompt:'Check docs/rules.md\n<task_input>{"target":"rules","records":25}</task_input>'});assert.equal(r.status,0,r.stderr);assert.equal(r.value.hookSpecificOutput.additionalContext.includes('current_for_exact_input'),false);
}));
test('verified source routing cannot credit an original without checking the declared freshness profile',()=>fixture(async f=>{
 await enableResolution(f);assert.equal(f.invoke('context',{prompt:'Check docs/rules.md\n<task_input>{"target":"rules","records":25}</task_input>'}).status,0);
 assert.notEqual(f.invoke('run',f.request([f.item()]),true).status,0);await assert.rejects(readFile(join(f.root,'executed.jsonl')),/ENOENT/);
}));
test('a complete verified source can drive an action and Stop while preserving its context evidence',()=>fixture(async f=>{
 await enableResolution(f);assert.equal(f.invoke('context',{prompt:'Check docs/rules.md\n<task_input>{"target":"rules","records":25}</task_input>'}).status,0);
 const req={...f.request([f.item()]),freshness_profile:'rules'},run=f.invoke('run',req,true);assert.equal(run.status,0,run.stderr);assert.equal(f.post(req,run.value).status,0);assert.equal((await f.stop()).collection.recorded,1);
}));
async function enableResults(f){
 await enableResolution(f);
 const adapter=join(f.root,'adapter.mjs');await writeFile(adapter,(await readFile(adapter,'utf8')).replace('applied_plan:x.plan','applied_plan:x.plan,adapter_call_id:"actual-adapter-call"'));
 f.config.result_mode='validated';f.config.action_adapters.plan.result_contract={operation:'apply',payload_field:'plan',result_field:'applied_plan'};
 await writeFile(join(f.root,'.local/memory-reuse/config.json'),JSON.stringify(f.config));
 const c=f.invoke('context',{prompt:'Check docs/rules.md\n<task_input>{"target":"rules","records":25}</task_input>'});assert.equal(c.status,0,c.stderr);
 const req={...f.request([f.item()]),freshness_profile:'rules'},run=f.invoke('run',req,true);assert.equal(run.status,0,run.stderr);assert.equal(f.post(req,run.value,'prior-native').status,0);
 return req;
}
const nextPrompt='Check docs/rules.md\n<task_input>{"target":"rules","records":25}</task_input>';
test('an actual successful prior action can replace plan generation; derived use stays separate from original use',()=>fixture(async f=>{
 await enableResults(f);
 const c=f.invoke('context',{session_id:'next',prompt:nextPrompt});assert.equal(c.status,0,c.stderr);assert.match(c.value.hookSpecificOutput.additionalContext,/validated_result_available/);
 assert.equal(c.value.hookSpecificOutput.additionalContext.includes('Use batch 8'),false);
 const db=f.store.open(),artifact=db.prepare("select id from memory_reuse_artifacts where kind='result'").get();db.close();assert.ok(artifact);
 const req={task_id:'claude:next',adapter:'plan',result_id:artifact.id,uses:[],freshness_profile:'rules'},run=f.invoke('run',req,true);assert.equal(run.status,0,run.stderr);assert.equal(run.value.reuse_channel,'result');
 let d=f.store.open();assert.equal(d.prepare('select count(*) n from memory_reuse_applications where native_call_id is not null').get().n,0);d.close();
 const p=f.invoke('post',{session_id:'next',hook_event_name:'PostToolUse',tool_name:'Bash',tool_use_id:'next-native',tool_input:{command:`${process.execPath} ${helper} run '${JSON.stringify(req)}'`},tool_response:{stdout:JSON.stringify(run.value),exitCode:0}});assert.equal(p.status,0,p.stderr);
 assert.equal(f.invoke('stop',{session_id:'next'}).status,0);const o=JSON.parse(await readFile(join(f.root,'.local/memory-reuse/last-observation.json'),'utf8'));assert.equal(o.collection.recorded,0);assert.equal(o.derived_applications.length,1);assert.equal(o.derived_applications[0].channel,'result');assert.equal(o.derived_applications[0].native_call_id,'next-native');
}));
test('result reuse requires exact task input, explicit permission, and an unchanged current proof',()=>fixture(async f=>{
 await enableResults(f);
 const d=f.store.open(),artifact=d.prepare("select id from memory_reuse_artifacts where kind='result'").get();d.close();assert.ok(artifact);
 const req={task_id:'claude:next',adapter:'plan',result_id:artifact.id,uses:[],freshness_profile:'rules'};
 assert.notEqual(f.invoke('run',req,true).status,0,'result was never offered to this task');
 const wrong=f.invoke('context',{session_id:'wrong',prompt:nextPrompt.replace('25','26')});assert.equal(wrong.status,0,wrong.stderr);assert.doesNotMatch(wrong.value.hookSpecificOutput.additionalContext,/validated_result_available/);
 const other=f.invoke('context',{session_id:'bob',prompt:nextPrompt},false,'bob');assert.equal(other.status,0,other.stderr);assert.doesNotMatch(other.value.hookSpecificOutput.additionalContext,/validated_result_available/);
 assert.equal(f.invoke('context',{session_id:'next',prompt:nextPrompt}).status,0);await writeFile(join(f.root,'docs/source.json'),'{"batch":9}');assert.notEqual(f.invoke('run',req,true).status,0);
}));
test('environment changes prevent reuse of a prior successful result',()=>fixture(async f=>{
 await enableResults(f);const d=f.store.open();assert.equal(d.prepare("select count(*) n from memory_reuse_artifacts where kind='result'").get().n,1);d.close();
 f.config.freshness_profiles.rules.environment={service:'changed'};await writeFile(join(f.root,'.local/memory-reuse/config.json'),JSON.stringify(f.config));
 const c=f.invoke('context',{session_id:'changed',prompt:nextPrompt});assert.equal(c.status,0,c.stderr);assert.doesNotMatch(c.value.hookSpecificOutput.additionalContext,/validated_result_available/);
}));
test('a successful adapter return without native completion cannot create a result',()=>fixture(async f=>{
 await enableResolution(f);f.config.result_mode='validated';f.config.action_adapters.plan.result_contract={operation:'apply',payload_field:'plan',result_field:'applied_plan'};await writeFile(join(f.root,'.local/memory-reuse/config.json'),JSON.stringify(f.config));
 assert.equal(f.invoke('context',{prompt:nextPrompt}).status,0);const run=f.invoke('run',{...f.request([f.item()]),freshness_profile:'rules'},true);assert.equal(run.status,0,run.stderr);assert.equal(run.value.ok,true);
 const d=f.store.open();assert.equal(d.prepare("select count(*) n from memory_reuse_artifacts where kind='result'").get().n,0);d.close();
}));
test('expired proof and changed implementation prevent result offers',()=>fixture(async f=>{
 await enableResults(f);const path=join(f.root,'.local/memory-reuse/freshness/rules.json'),proof=JSON.parse(await readFile(path,'utf8'));await writeFile(path,JSON.stringify({...proof,expires_at:0}));
 let c=f.invoke('context',{session_id:'expired',prompt:nextPrompt});assert.equal(c.status,0,c.stderr);assert.doesNotMatch(c.value.hookSpecificOutput.additionalContext,/validated_result_available/);
 await writeFile(path,JSON.stringify(proof));await writeFile(join(f.root,'validate.mjs'),(await readFile(join(f.root,'validate.mjs'),'utf8'))+'\n// changed implementation\n');
 c=f.invoke('context',{session_id:'changed-code',prompt:nextPrompt});assert.equal(c.status,0,c.stderr);assert.doesNotMatch(c.value.hookSpecificOutput.additionalContext,/validated_result_available/);
}));
test('a shared result needs an explicit grant and current source permission',()=>fixture(async f=>{
 await enableResults(f);const d=f.store.open(),row=d.prepare("select * from memory_reuse_artifacts where kind='result'").get();d.close();
 const reuse=new MemoryReuse(f.store,{tenant_id:'default',project_id:'org-brain',principal_id:'alice',work_type:'implementation'});
 await reuse.createArtifact({kind:'result',object_type_key:row.object_type_key,object_id:row.object_id,refs:JSON.parse(row.refs_json),payload:JSON.parse(row.payload_json),fingerprint:row.fingerprint,action_ref:row.action_ref,allowed_principals:['bob']});
 const p=f.invoke('prime',{profile_id:'rules',input:{target:'rules',records:25}},true,'bob');assert.equal(p.status,0,p.stderr);
 const c=f.invoke('context',{session_id:'shared',prompt:nextPrompt},false,'bob');assert.equal(c.status,0,c.stderr);assert.match(c.value.hookSpecificOutput.additionalContext,/validated_result_available/);
 // Changing the original version invalidates both owner and explicit grant routes.
 await f.seed({content:'Use batch 9 after the update.'});const changed=f.invoke('context',{session_id:'shared-changed',prompt:nextPrompt},false,'bob');assert.equal(changed.status,0,changed.stderr);assert.doesNotMatch(changed.value.hookSpecificOutput.additionalContext,/validated_result_available/);
}));
test('a changed source between cached execution and Stop leaves the derived application unverified',()=>fixture(async f=>{
 await enableResults(f);assert.equal(f.invoke('context',{session_id:'next',prompt:nextPrompt}).status,0);const d=f.store.open(),artifact=d.prepare("select id from memory_reuse_artifacts where kind='result'").get();d.close();assert.ok(artifact);
 const req={task_id:'claude:next',adapter:'plan',result_id:artifact.id,uses:[],freshness_profile:'rules'},run=f.invoke('run',req,true);assert.equal(run.status,0,run.stderr);
 assert.equal(f.invoke('post',{session_id:'next',hook_event_name:'PostToolUse',tool_name:'Bash',tool_use_id:'next-native',tool_input:{command:`${process.execPath} ${helper} run '${JSON.stringify(req)}'`},tool_response:{stdout:JSON.stringify(run.value),exitCode:0}}).status,0);
 await writeFile(join(f.root,'docs/source.json'),'{"batch":9}');assert.equal(f.invoke('stop',{session_id:'next'}).status,0);const o=JSON.parse(await readFile(join(f.root,'.local/memory-reuse/last-observation.json'),'utf8'));assert.equal(o.derived_applications.length,0);const db=f.store.open();assert.equal(db.prepare('select count(*) n from memory_reuse_applications where native_call_id is not null').get().n,0);db.close();
}));
