import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {LocalMemoryStore} from '../packages/orgbrain-cli/src/lib/local-memory-store.mjs';
import {MemoryReuse, reportCompactUse,recordReuseAction,reuseContentAllowed} from '../packages/orgbrain-cli/src/lib/memory-reuse.mjs';
test('content screening examines structured values without mistaking generated UUIDs for phone numbers',()=>{
 assert.equal(reuseContentAllowed({note:'password=synthetic-secret-value'}),false);
 assert.equal(reuseContentAllowed({note:'Call 090-1234-5678'}),false);
 assert.equal(reuseContentAllowed({usage_item_id:'00000000-1234-4123-8123-000000000000',note:'safe synthetic rule'}),true);
 assert.equal(reuseContentAllowed({note:'password=00000000-1234-4123-8123-000000000000'}),false);
});
test('structured source bodies and artifact payloads cannot bypass credential screening',()=>fixture(async({store,reuse})=>{
 store.getMemoryDetail=async()=>({memory:{id:'unsafe',current_version:1,content:'password=synthetic-secret-value'}});
 await assert.rejects(reuse.link({source_id:'unsafe',source_version:1,object_type_key:'file',object_id:'unsafe.md'}),/sensitive_reuse_source_denied/);
 store.getMemoryDetail=async()=>({memory:{id:'m',current_version:1,content:'Safe synthetic rule'}});
 await assert.rejects(reuse.createArtifact({kind:'result',refs:[{source_id:'m',source_version:1}],payload:{password:'synthetic-secret-value'}}),/sensitive_artifact_denied/);
}));
import {handleLocalMcpRequest} from '../packages/orgbrain-cli/src/local-mcp.mjs';

async function fixture(fn) {
  const dir=await mkdtemp(join(tmpdir(),'reuse-test-'));
  const store=new LocalMemoryStore(join(dir,'memory.sqlite'),{denseEmbeddingProvider:null,memoryJudge:null,relevanceSelector:null});
  await store.init(); await store.useHistory('configure',{mode:'a',collect:true});
  const scope={tenant_id:'t',project_id:'p',principal_id:'alice',work_type:'implementation'};
  const reuse=new MemoryReuse(store,scope);
  const seed=async(id,extra={})=>store.capture({id,external_key:`reuse-test:${id}`,tenant_id:'t',project_id:'p',work_type:'implementation',kind:'fact',content:'Keep the queue batch at 8 and retain 14 days.',rationale:'The synthetic service accepts these limits.',reuse_rule:'Only for queue batch planning.',source:'test',capture_origin:'synthetic',source_references:[{ref:'synthetic:queue.md'}],...extra});
  const request={channel:'object',object_type_key:'file',object_id:'queue.md',task_id:'task',session_id:'session',context_epoch:'turn',flags:{object:true}};
  try {await seed('m'); await fn({store,reuse,scope,seed,request});} finally {await rm(dir,{recursive:true,force:true});}
}
test('target lookup returns the pinned original, wrong targets and disabled flags return nothing',()=>fixture(async({reuse,request})=>{
  await reuse.link({source_id:'m',source_version:1,object_type_key:'file',object_id:'queue.md',operation:'queue.plan'});
  assert.equal((await reuse.recall(request)).references[0].source_id,'m');
  assert.equal((await reuse.recall({...request,object_id:'other.md'})).references.length,0);
  assert.equal((await reuse.recall({...request,flags:{}})).references.length,0);
}));
test('an unavailable backend is an error rather than an empty knowledge result',()=>fixture(async({store,reuse,request})=>{
  await reuse.link({source_id:'m',source_version:1,object_type_key:'file',object_id:'queue.md'});
  store.getMemoryDetail=async()=>{throw Error('database_busy');};
  await assert.rejects(reuse.recall(request),/database_busy/);
}));
test('operation keys are exact and require the operation flag',()=>fixture(async({reuse,request})=>{
  await reuse.link({source_id:'m',source_version:1,object_type_key:'file',object_id:'queue.md',operation:'queue.plan'});
  assert.equal((await reuse.recall({...request,channel:'operation',operation:'queue.plan',flags:{operation:true}})).references.length,1);
  assert.equal((await reuse.recall({...request,channel:'operation',operation:'queue.delete',flags:{operation:true}})).references.length,0);
}));
test('refreshing a source link preserves its observed operation and unfinished status',()=>fixture(async({reuse,request})=>{
  await reuse.link({source_id:'m',source_version:1,object_type_key:'file',object_id:'queue.md',operation:'queue.plan',unresolved:true,updated_at:Date.now()-20*86400000});
  await reuse.link({source_id:'m',source_version:1,object_type_key:'file',object_id:'queue.md',updated_at:Date.now()-20*86400000});
  assert.equal((await reuse.recall({...request,channel:'operation',operation:'queue.plan',flags:{operation:true}})).references.length,1);
  assert.equal((await reuse.recall({...request,channel:'recent',flags:{recent:true}})).references.length,1);
}));
test('ACL, expiry, conflicts and stale source versions fail closed',()=>fixture(async({store,reuse,scope,seed,request})=>{
  await seed('private',{permissions:[{principal_type:'principal',principal_id:'alice',permissions:['read']}]});
  await reuse.link({source_id:'private',source_version:1,object_type_key:'file',object_id:'queue.md'});
  assert.equal((await new MemoryReuse(store,{...scope,principal_id:'bob'}).recall(request)).references.length,0);
  await seed('private',{content:'Revised private rule.',permissions:[{principal_type:'principal',principal_id:'alice',permissions:['read']}]});
  assert.equal((await reuse.recall(request)).references.length,0);
  await seed('expired',{valid_until:Date.now()-100});
  await assert.rejects(reuse.link({source_id:'expired',source_version:1,object_type_key:'file',object_id:'queue.md'}));
  await seed('conflicted',{conflicts:['The old procedure is revoked.']});
  await assert.rejects(reuse.link({source_id:'conflicted',source_version:1,object_type_key:'file',object_id:'queue.md'}),/reuse_source_conflicted/);
}));
test('only an explicitly still-visible version is deduplicated; a new context can retrieve it',()=>fixture(async({reuse,request})=>{
  await reuse.link({source_id:'m',source_version:1,object_type_key:'file',object_id:'queue.md'});
  const a=await reuse.recall(request);
  assert.equal((await reuse.recall({...request,visible_versions:a.references})).references.length,0);
  assert.equal((await reuse.recall({...request,context_epoch:'after-compaction'})).references.length,1);
}));
test('recent cards preserve old unresolved items and exclude old completed items',()=>fixture(async({reuse,request})=>{
  await reuse.link({source_id:'m',source_version:1,object_type_key:'file',object_id:'queue.md',unresolved:true,updated_at:Date.now()-20*86400000});
  const r=await reuse.recall({...request,channel:'recent',flags:{recent:true}});
  assert.equal(r.references.length,1); assert.equal(r.representation,'card');
  await reuse.link({source_id:'m',source_version:1,object_type_key:'file',object_id:'queue.md',unresolved:false,updated_at:Date.now()-20*86400000});
  assert.equal((await reuse.recall({...request,channel:'recent',flags:{recent:true}})).references.length,0);
}));
test('one project card serves different targets and is regenerated after a source update',()=>fixture(async({reuse,seed,request})=>{
  await seed('other',{content:'A different synthetic ledger rule.',reuse_rule:'Only for the ledger.'});
  await reuse.link({source_id:'m',source_version:1,object_type_key:'file',object_id:'queue.md'});
  await reuse.link({source_id:'other',source_version:1,object_type_key:'file',object_id:'ledger.md'});
  const q={...request,channel:'recent',flags:{recent:true}};
  const a=await reuse.recall(q),b=await reuse.recall({...q,object_id:'ledger.md'});
  assert.equal(typeof a.derivation.card_id,'string');assert.equal(a.derivation.card_id,b.derivation.card_id);
  assert.equal(b.derivation.cache_hit,true);assert.equal(b.references[0].source_id,'other');
  await seed('other',{content:'A revised synthetic ledger rule.'});
  await reuse.link({source_id:'other',source_version:2,object_type_key:'file',object_id:'ledger.md'});
  const c=await reuse.recall({...q,object_id:'ledger.md'});
  assert.equal(c.derivation.card_id,a.derivation.card_id);assert.notEqual(c.derivation.source_digest,a.derivation.source_digest);assert.equal(c.references[0].source_version,2);
}));
test('changes are per principal and repeat only after a new source version',()=>fixture(async({store,reuse,scope,seed,request})=>{
  await reuse.link({source_id:'m',source_version:1,object_type_key:'file',object_id:'queue.md'});
  const q={...request,channel:'changes',flags:{changes:true}};
  assert.equal((await reuse.recall(q)).references.length,1);
  assert.equal((await reuse.recall(q)).references.length,0);
  assert.equal((await new MemoryReuse(store,{...scope,principal_id:'bob'}).recall(q)).references.length,1);
  await seed('m',{content:'Keep the queue batch at 10.'});
  await reuse.link({source_id:'m',source_version:2,object_type_key:'file',object_id:'queue.md'});
  assert.equal((await reuse.recall(q)).references[0].source_version,2);
}));
test('procedures require observed prior use; result artifacts require matching conditions and current sources',()=>fixture(async({reuse,request})=>{
  await reuse.link({source_id:'m',source_version:1,object_type_key:'file',object_id:'queue.md'});
  await assert.rejects(reuse.createArtifact({kind:'procedure',object_type_key:'file',object_id:'queue.md',refs:[{source_id:'m',source_version:1}],payload:{batch:8}}),/insufficient_verified_use/);
  await assert.rejects(reuse.createArtifact({kind:'result',object_type_key:'file',object_id:'queue.md',refs:[{source_id:'m',source_version:1}],payload:{batch:8},fingerprint:'a'}),/completed_action_required/);
  assert.equal((await reuse.recall({...request,channel:'result',fingerprint:'different',flags:{result:true}})).references.length,0);
}));
test('compact use is not inferred from delivery or invented action IDs',()=>fixture(async({store,scope,reuse,request})=>{
  await reuse.link({source_id:'m',source_version:1,object_type_key:'file',object_id:'queue.md'});
  const delivery=await reuse.recall(request);
  const host={store,scope,delivered:new Map(delivery.items.map(i=>[i.usage_item_id,{...i,usage_id:delivery.usage_id,...scope,task_id:'task'}])),actions:new Map(),task_id:'task',context:{task:'plan queue',target:'queue',constraints:'batch limit',conditions:'synthetic fixture'}};
  assert.deepEqual(await reportCompactUse(host,{}),{state:'unassessed'});
  await assert.rejects(reportCompactUse(host,{used:true,usage_item_id:delivery.items[0].usage_item_id,action_call_id:'invented'}),/action_not_observed/);
}));
test('normal MCP context connects the explicitly enabled object route',()=>fixture(async({store,reuse})=>{
  await reuse.link({source_id:'m',source_version:1,object_type_key:'file',object_id:'queue.md'});
  const r=await handleLocalMcpRequest(store,{method:'tools/call',params:{name:'orgbrain_context_enrich',arguments:{tenant_id:'t',project_id:'p',principal_id:'alice',work_type:'implementation',task_id:'normal-mcp',query:'queue planning',object_type_key:'file',object_id:'queue.md',reuse:{channel:'object',flags:{object:true}}}}});
  assert.equal(r.isError,false); assert.equal(JSON.parse(r.content[0].text).references[0].source_id,'m');
}));
test('a cache cannot attach an arbitrary result to an unrelated completed action',()=>fixture(async({store,reuse,scope})=>{
  await recordReuseAction(store,scope,{call_id:'actual-action',task_id:'task',completed:true,ok:true,args:{op:'verify'},result:{ok:true}});
  await assert.rejects(reuse.createArtifact({kind:'result',object_type_key:'file',object_id:'queue.md',refs:[{source_id:'m',source_version:1}],
    payload:{invented:'result'},fingerprint:'unrelated-input',action_ref:'actual-action'}),/result_proof_mismatch/);
}));
test('a native completed result is reusable only with the exact fingerprint and original version',()=>fixture(async({store,reuse,scope,request,seed})=>{
  const refs=[{source_id:'m',source_version:1}],payload={batch_size:8,retain_days:14};
  await reuse.link({...refs[0],object_type_key:'file',object_id:'queue.md'});
  await recordReuseAction(store,scope,{call_id:'result-action',task_id:'previous-task',completed:true,ok:true,args:{op:'verify'},result:{ok:true},
    cache:{payload,fingerprint:'input-source-environment-v1',refs,object_type_key:'file',object_id:'queue.md'}});
  await reuse.createArtifact({kind:'result',object_type_key:'file',object_id:'queue.md',refs,payload,fingerprint:'input-source-environment-v1',action_ref:'result-action'});
  const q={...request,channel:'result',flags:{result:true},fingerprint:'input-source-environment-v1'};
  assert.equal((await reuse.recall(q)).references.length,1);
  assert.equal((await reuse.recall({...q,fingerprint:'input-source-environment-v2'})).references.length,0);
  await seed('m',{content:'New current source rule.'});
  assert.equal((await reuse.recall(q)).references.length,0);
}));
test('artifact execution is counted only after the matching native completion, separately from model memory use',()=>fixture(async({store,reuse,scope})=>{
  const refs=[{source_id:'m',source_version:1}],payload={batch_size:8};
  await recordReuseAction(store,scope,{call_id:'prior',task_id:'prior-task',completed:true,ok:true,args:{op:'check'},result:{ok:true},cache:{payload,refs,fingerprint:'matching',object_type_key:'file',object_id:'queue.md'}});
  const artifact=await reuse.createArtifact({kind:'result',refs,payload,fingerprint:'matching',object_type_key:'file',object_id:'queue.md',action_ref:'prior'});
  let calls=0;
  const output=await reuse.applyArtifact({artifact_id:artifact.id,fingerprint:'matching',task_id:'current'},async p=>{calls++;return {ok:p.batch_size===8};});
  assert.equal(calls,1);assert.equal((await reuse.applications('current')).length,0);
  await assert.rejects(reuse.confirmApplication(output.derived_application_token,{call_id:'forged',task_id:'current',args:{},result:output}),/native_action_required/);
  await recordReuseAction(store,scope,{call_id:'native',task_id:'current',completed:true,ok:true,args:{op:'apply_artifact'},result:output});
  await reuse.confirmApplication(output.derived_application_token,{call_id:'native',task_id:'current',args:{op:'apply_artifact'},result:output});
  assert.equal((await reuse.applications('current'))[0].channel,'result');
  await assert.rejects(reuse.applyArtifact({artifact_id:artifact.id,fingerprint:'wrong',task_id:'other'},()=>{throw Error('must not execute');}),/artifact_conditions_mismatch/);
  const declined=await reuse.applyArtifact({artifact_id:artifact.id,fingerprint:'matching',task_id:'declined'},async()=>({ok:true,reuse_applied:false}));
  assert.equal(declined.derived_application_token,undefined);assert.equal((await reuse.applications('declined')).length,0);
}));
test('private artifact outputs are not exposed through otherwise public source references',()=>fixture(async({store,reuse,scope,request})=>{
  const refs=[{source_id:'m',source_version:1}],payload={note:'synthetic private task input'};
  await reuse.link({...refs[0],object_type_key:'file',object_id:'queue.md'});
  await recordReuseAction(store,scope,{call_id:'private-result',task_id:'prior',completed:true,ok:true,args:{},result:{ok:true},cache:{payload,refs,fingerprint:'same',object_type_key:'file',object_id:'queue.md'}});
  const a=await reuse.createArtifact({kind:'result',refs,payload,fingerprint:'same',object_type_key:'file',object_id:'queue.md',action_ref:'private-result'});
  const bob=new MemoryReuse(store,{...scope,principal_id:'bob'});
  assert.equal((await bob.recall({...request,channel:'result',flags:{result:true},fingerprint:'same'})).references.length,0);
  await assert.rejects(bob.applyArtifact({artifact_id:a.id,fingerprint:'same',task_id:'bob-task'},()=>{throw Error('must not execute');}),/artifact_unavailable/);
}));
test('an explicitly shared result can be applied by an authorized different principal',()=>fixture(async({store,reuse,scope})=>{
  const refs=[{source_id:'m',source_version:1}],payload={batch_size:8};
  await recordReuseAction(store,scope,{call_id:'shared-result',task_id:'prior',completed:true,ok:true,args:{},result:{ok:true},cache:{payload,refs,fingerprint:'shared-input',object_type_key:'file',object_id:'queue.md'}});
  const a=await reuse.createArtifact({kind:'result',refs,payload,fingerprint:'shared-input',object_type_key:'file',object_id:'queue.md',action_ref:'shared-result',allowed_principals:['bob']});
  const bob=new MemoryReuse(store,{...scope,principal_id:'bob'});
  assert.equal((await bob.applyArtifact({artifact_id:a.id,fingerprint:'shared-input',task_id:'bob'},async p=>({ok:p.batch_size===8}))).ok,true);
}));
