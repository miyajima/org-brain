import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {LocalMemoryStore} from '../packages/orgbrain-cli/src/lib/local-memory-store.mjs';
async function fixture(fn){
 const root=await mkdtemp(join(tmpdir(),'reuse-inline-')),db=join(root,'memory.sqlite'),store=new LocalMemoryStore(db,{denseEmbeddingProvider:null});
 await store.init();await mkdir(join(root,'docs'));await writeFile(join(root,'docs/rules.md'),'Synthetic target');await mkdir(join(root,'.local/memory-reuse'),{recursive:true});
 const seed=extra=>store.capture({id:'rule',external_key:'test:inline',tenant_id:'default',project_id:'org-brain',work_type:'implementation',kind:'fact',content:'Use batch 8. Deduplicate unless the source is already unique.',rationale:'Synthetic input restriction.',reuse_rule:'Only this synthetic target, current version.',source:'unit-test-fixture',verification_state:'verified',verified_at:Date.now(),learning:{fixture:true},capture_origin:'observed',source_references:[{ref:'docs/rules.md'}],...extra});
 await seed({});await writeFile(join(root,'.local/memory-reuse/config.json'),JSON.stringify({tenant_id:'default',project_id:'org-brain',db_path:db,flags:{object:true},delivery_mode:'inline',observation_purpose:'test'}));
 const invoke=(command,input,raw=false)=>{
  const p=spawnSync(process.execPath,[resolve('scripts/memory-reuse-claude.mjs'),command,...(raw?[JSON.stringify(input)]:[])],{env:{...process.env,ORGBRAIN_REUSE_ROOT:root,ORGBRAIN_USE_PRINCIPAL:'alice'},input:raw?undefined:JSON.stringify({cwd:root,session_id:'test',...input}),encoding:'utf8'});
  return {status:p.status,stderr:p.stderr,value:p.stdout?JSON.parse(p.stdout):null};
 };
 try{await fn({root,store,seed,invoke});}finally{await rm(root,{recursive:true,force:true});}
}
test('short original is delivered at prompt time; only explicit later attribution creates a verified use',()=>fixture(async({root,store,invoke})=>{
 const c=invoke('context',{prompt:'Check docs/rules.md'});assert.equal(c.status,0,c.stderr);
 const text=c.value.hookSpecificOutput.additionalContext;
 assert.ok(text.includes('Deduplicate unless the source is already unique.'));assert.ok(text.includes('Only this synthetic target, current version.'));
 assert.ok(text.includes('Use tracking: receipt;'));assert.equal(text.includes('consult it before acting with'),false);
 const db=store.open();let item;
 try{assert.equal(db.prepare('select count(*) n from memory_use_contexts').get().n,0);item=db.prepare('select id from memory_usage_items').get().id;}finally{db.close();}
 const ghost=invoke('report',{used:true,usage_item_id:item,action_call_id:'invented'},true);assert.notEqual(ghost.status,0);
 const action={hook_event_name:'PostToolUse',tool_name:'Bash',tool_use_id:'native-action',tool_input:{command:'node check docs/rules.md'},tool_response:{stdout:'{"ok":true}',exitCode:0}};
 const post=invoke('post',action);assert.equal(post.status,0,post.stderr);
 assert.ok(post.value.hookSpecificOutput.additionalContext.includes('native-action'));assert.ok(post.value.hookSpecificOutput.additionalContext.length<200);
 const signal=invoke('report',{used:true,usage_item_id:item,action_call_id:'native-action'},true);assert.equal(signal.status,0,signal.stderr);
 assert.ok(signal.value.use_receipt);
 const report=invoke('post',{hook_event_name:'PostToolUse',tool_name:'Bash',tool_use_id:'native-report',tool_input:{command:'node /repo/memory-reuse-claude.mjs report'},tool_response:{stdout:JSON.stringify(signal.value),exitCode:0}});assert.equal(report.status,0,report.stderr);
 const stop=invoke('stop',{transcript_path:join(root,'absent.jsonl')});assert.equal(stop.status,0,stop.stderr);
 const observed=JSON.parse(await readFile(join(root,'.local/memory-reuse/last-observation.json'),'utf8'));
 assert.equal(observed.collection.recorded,1);assert.equal(observed.collection.delivered,1);assert.equal(observed.natural,false);
 assert.deepEqual(observed.collection.rejected,[]);
}));
test('delivery without a use report stays unassessed',()=>fixture(async({root,invoke})=>{
 assert.equal(invoke('context',{prompt:'Check docs/rules.md'}).status,0);
 assert.equal(invoke('post',{hook_event_name:'PostToolUse',tool_name:'Bash',tool_use_id:'read-only',tool_input:{command:'node check docs/rules.md'},tool_response:{stdout:'{"ok":true}',exitCode:0}}).status,0);
 assert.equal(invoke('stop',{transcript_path:join(root,'absent.jsonl')}).status,0);
 const observed=JSON.parse(await readFile(join(root,'.local/memory-reuse/last-observation.json'),'utf8'));
 assert.equal(observed.collection.recorded,0);assert.equal(observed.collection.delivered,1);
}));
test('source changes after injection cannot become a verified use',()=>fixture(async({invoke,store,seed})=>{
 assert.equal(invoke('context',{prompt:'Check docs/rules.md'}).status,0);const db=store.open();const id=db.prepare('select id from memory_usage_items').get().id;db.close();
 assert.equal(invoke('post',{hook_event_name:'PostToolUse',tool_name:'Bash',tool_use_id:'action',tool_input:{command:'node check docs/rules.md'},tool_response:{stdout:'{"ok":true}',exitCode:0}}).status,0);
 await seed({content:'The source has changed.'});assert.notEqual(invoke('report',{used:true,usage_item_id:id,action_call_id:'action'},true).status,0);
}));
