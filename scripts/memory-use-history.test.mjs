import test from 'node:test';
import assert from 'node:assert/strict';
import { localUseService, storeLocalUseProof } from '../packages/orgbrain-cli/src/lib/local-memory-use.mjs';
import { useScore, useHash, MEMORY_USE_SCHEMA_SQL } from '../packages/shared/src/memory-use-history-runtime.mjs';
import { assessMemoryUsefulnessV2 } from '../packages/shared/src/memory-usefulness-runtime.mjs';
import { collectMemoryUse } from '../packages/orgbrain-cli/src/lib/memory-use-collector.mjs';

import {fixture} from './lib/memory-use-fixture.mjs';

test('A/B/C: context adds a candidate, only verified outcome/assessment changes C',async()=>{
  const f=await fixture();try {
    await f.service.record(f.payload);
    const input={query:'duplicate transaction',project_id:'p',task_id:'future-task',work_type:'implementation',base:[],limit:5};
    assert.equal((await f.service.search(input)).results.length,0);
    const b=await f.service.search({...input,context_enabled:true});assert.equal(b.results[0].id,f.id);
    assert.equal(b.results[0].use_history.evaluation_count,0);
    const e=await f.service.evaluate({id:'eval',context_id:'context',proof_id:'context:2'});assert.equal(e.outcome,'positive');
    const c=await f.service.search({...input,context_enabled:true,ranking_enabled:true});
    assert.ok(c.results[0].score>b.results[0].score);assert.equal(c.results[0].use_history.evaluation_count,1);
  }finally{await f.close();}
});
test('forged verified flag, wrong hash and task mismatch cannot be trusted',async()=>{
  const f=await fixture();try {
    await assert.rejects(f.service.record({...f.payload,task_id:'other'}),/scope_mismatch/);
    const e=f.evidence.map(x=>({...x,content_hash:'a'.repeat(64),verification_state:'verified'}));
    assert.equal((await f.service.record({...f.payload,evidence:e})).verification_state,'unverified');
    const result=await f.service.evaluate({id:'e',context_id:'context',proof_id:'context:2',outcome:'positive'});assert.equal(result.outcome,'unknown');
  }finally{await f.close();}
});
test('idempotency, correction and revocation invalidate projection and statistics',async()=>{
  const f=await fixture();try {
    assert.equal((await f.service.record(f.payload)).created,true);
    assert.equal((await f.service.record(f.payload)).created,false);
    await assert.rejects(f.service.record({...f.payload,work_type:'debug'}),/idempotency_conflict/);
    await f.service.evaluate({id:'eval',context_id:'context',proof_id:'context:2'});
    await f.service.record({...f.payload,id:'corrected',supersedes_id:'context',context:{...f.payload.context,task:'reconciliation'}});
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM memory_use_statistics').get().n,0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM memory_use_context_fts WHERE context_id=?').get('context').n,0);
    await f.service.revoke('corrected');assert.equal(f.db.prepare('SELECT count(*) AS n FROM memory_use_context_fts').get().n,0);
  }finally{await f.close();}
});
test('private history never contributes to another principal, project or task',async()=>{
  const f=await fixture();try {
    await f.service.record(f.payload);await f.service.evaluate({id:'e',context_id:'context',proof_id:'context:2'});
    const q={query:'duplicate',project_id:'p',work_type:'implementation',task_id:'future',context_enabled:true,ranking_enabled:true};
    assert.equal((await localUseService(f.db,'t','someone').search(q)).results.length,0);
    assert.equal((await f.service.search({...q,project_id:'other'})).results.length,0);
    assert.equal((await f.service.search({...q,task_id:'prior-task'})).results.length,0);
    assert.equal((await localUseService(f.db,'other','local').search(q)).results.length,0);
  }finally{await f.close();}
});
test('version change, deleted evidence and changed permissions remove contributions',async()=>{
  const f=await fixture();try {
    await f.service.record(f.payload);await f.service.evaluate({id:'e',context_id:'context',proof_id:'context:2'});
    const q={query:'duplicate',project_id:'p',work_type:'implementation',task_id:'future',context_enabled:true,ranking_enabled:true};
    f.db.prepare('UPDATE memories SET current_version=2 WHERE id=?').run(f.id);
    assert.equal((await f.service.search(q)).results.length,0);
    f.db.prepare('UPDATE memories SET current_version=1,permissions_json=? WHERE id=?').run(JSON.stringify([{principal_type:'principal',principal_id:'other',permissions:['read']}]),f.id);
    assert.equal((await f.service.history()).items.length,0);
    f.db.prepare('UPDATE memories SET permissions_json=? WHERE id=?').run('[]',f.id);
    f.db.prepare('DELETE FROM local_use_proofs WHERE id=?').run(f.evidence[0].ref_id);
    assert.equal((await f.service.search(q)).results.length,0);
  }finally{await f.close();}
});
test('unknown version cannot become verified; source creation-time version is not inferred',async()=>{
  const f=await fixture();try {
    f.db.prepare('UPDATE memory_usage_items SET source_version=NULL WHERE id=?').run('item');
    assert.equal((await f.service.record(f.payload)).verification_state,'unverified');
  }finally{await f.close();}
});
test('conditions constrain context search and future statistics cannot leak backwards',async()=>{
  const f=await fixture();try {
    await f.service.record({...f.payload,context:{...f.payload.context,conditions:'staging'}});
    await f.service.evaluate({id:'e',context_id:'context',proof_id:'context:2'});
    const q={query:'duplicate',project_id:'p',work_type:'implementation',task_id:'future',context_enabled:true,ranking_enabled:true};
    assert.equal((await f.service.search(q)).results.length,0);
    assert.equal((await f.service.search({...q,context:{conditions:'staging'}})).results.length,1);
    assert.equal((await f.service.search({...q,at:f.now-1,context:{conditions:'staging'}})).results.length,0);
  }finally{await f.close();}
});
test('repeated task evaluations count once; negative evidence lowers score, neutral does not',async()=>{
  const f=await fixture();try {
    await f.service.record(f.payload);await f.service.evaluate({id:'e',context_id:'context',proof_id:'context:2'});
    const negative=await storeLocalUseProof(f.db,{tenant_id:'t',principal:'local',project_id:'p',task_id:'prior-task',source_id:f.id,usage_item_id:'item',role:'assessment',text:'harmful',contribution:'negative',created_at:f.now});
    await f.service.record({...f.payload,id:'another-use',evidence:[f.evidence[0],f.evidence[1],negative]});
    f.setNow(f.now+1);await f.service.evaluate({id:'e2',context_id:'another-use',proof_id:'another-use:2'});
    const stat=f.db.prepare('SELECT * FROM memory_use_statistics').get();
    assert.equal(stat.evaluation_count,1);assert.equal(stat.positive,0);assert.equal(stat.negative,1);
    assert.ok(useScore(1,0,1)<1);assert.equal(useScore(1,0,0),1);
  }finally{await f.close();}
});
test('usefulness eligible is not returned for explicit no contribution',()=>{
  const common={evidence_supported:true,applicable:true,task_contribution:true,incremental_value:true,within_budget:true};
  assert.equal(assessMemoryUsefulnessV2(common).disposition,'eligible');
  assert.notEqual(assessMemoryUsefulnessV2({...common,task_contribution:false}).disposition,'eligible');
  assert.notEqual(assessMemoryUsefulnessV2({...common,incremental_value:false}).disposition,'eligible');
});
test('migration SQL stays exactly aligned with shared installer',async()=>{
  const {readFile}=await import('node:fs/promises');
  assert.ok((await readFile(new URL('../migrations/0041_memory_use_history.sql',import.meta.url),'utf8')).endsWith(MEMORY_USE_SCHEMA_SQL));
});
test('collector requires actual search/action/observe events; duplicate Stop is idempotent',async()=>{
  const f=await fixture();try {
    const obs={usage_id:'usage',usage_item_id:'item',source_id:f.id,source_version:1,task_id:'prior-task',project_id:'p',work_type:'implementation',context:f.payload.context,action_call_id:'act',outcome_call_id:'act'};
    const call=(id,name,args)=>({payload:{type:'function_call',call_id:id,name,arguments:JSON.stringify(args)}});
    const out=(id,output)=>({payload:{type:'function_call_output',call_id:id,output:JSON.stringify(output)}});
    const rows=[call('s','orgbrain_memory_search',{project_id:'p',task_id:'prior-task'}),out('s',{results:[{id:f.id,current_version:1}],meta:{usage_id:'usage',usage_item_ids:['item']}}),
      call('act','exec_command',{cmd:'test example'}),out('act',{exit_code:0}),call('o','orgbrain_memory_observe',{use_observation:obs}),out('o',{accepted:true})];
    const input={rows,tenantId:'t',projectId:'p',taskId:'prior-task'};
    assert.equal((await collectMemoryUse(f.store,input)).recorded,1);
    assert.equal((await collectMemoryUse(f.store,input)).recorded,1);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM memory_use_contexts').get().n,1);
    const invalid={...input,rows:rows.filter((_,i)=>i!==3)};
    assert.deepEqual((await collectMemoryUse(f.store,invalid)).rejected,['use_action_not_observed']);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM memory_use_statistics').get().n,0);
  }finally{await f.close();}
});

test('explicit feedback needs verified execution and outcome; corrections revoke replay snapshots',async()=>{
  const f=await fixture();try {
    await f.service.record({...f.payload,evidence:[f.evidence[0]]});
    const unknown=await f.service.evaluate({id:'feedback1',context_id:'context',feedback:{contribution:'positive',statement:'It helped with reconciliation.'}});
    assert.equal(unknown.outcome,'unknown');
    await f.service.record({...f.payload,id:'complete',supersedes_id:'context',evidence:f.evidence.slice(0,2)});
    await f.service.evaluate({id:'feedback2',context_id:'complete',feedback:{contribution:'positive',statement:'It prevented a duplicated action.'}});
    const snapshot=f.db.prepare('SELECT snapshot_id FROM memory_use_statistics').get().snapshot_id;
    const q={query:'duplicate',project_id:'p',work_type:'implementation',task_id:'new',context_enabled:true,ranking_enabled:true,snapshot_id:snapshot};
    assert.equal((await f.service.search(q)).results[0].use_history.evaluation_count,1);
    f.setNow(f.now+1);
    await f.service.evaluate({id:'feedback3',context_id:'complete',supersedes_id:'feedback2',feedback:{contribution:'unknown',statement:'The contribution could not be isolated.'}});
    const revised=await f.service.search(q);
    assert.equal(revised.results[0].use_history.evaluation_count,0);
    assert.ok(revised.meta.degraded_reasons.includes('use_statistics_unavailable'));
  } finally {await f.close();}
});

test('proof for another usage item cannot verify an attribution',async()=>{
  const f=await fixture();try {
    const wrong=await storeLocalUseProof(f.db,{tenant_id:'t',principal:'local',project_id:'p',task_id:'prior-task',source_id:f.id,usage_item_id:'different-item',role:'action',text:'an action on a different retrieved item',created_at:f.now});
    const result=await f.service.record({...f.payload,evidence:[wrong]});
    assert.equal(result.verification_state,'unverified');
    assert.equal(result.evidence[0].reason,'evidence_scope_mismatch');
  } finally {await f.close();}
});

test('signed proof trust is scoped, expires, and rejects payload tampering',async()=>{
  const {signMemoryUseAttestation,verifyMemoryUseAttestation}=await import('../packages/shared/src/memory-use-attestation.mjs');
  const secret='fixture-only-attestation-key-not-secret';
  const proof={tenant_id:'t',principal:'actor',text:'observed action',created_at:100,expires_at:200};
  const token=await signMemoryUseAttestation(proof,secret);
  const options={secret,tenant:'t',principal:'actor',now:150};
  assert.equal((await verifyMemoryUseAttestation(token,options)).verified,true);
  for(const changed of [{secret:undefined},{tenant:'other'},{principal:'other'},{now:201},{now:99}]) assert.equal(await verifyMemoryUseAttestation(token,{...options,...changed}),null);
  assert.equal(await verifyMemoryUseAttestation((token[0]==='a'?'b':'a')+token.slice(1),options),null);
});

test('sync is opt-in, retains retries, and sends a revocation tombstone',async()=>{
  const f=await fixture();try {
    await assert.rejects(f.store.syncMemoryUse({apiBase:'https://example.invalid',apiKey:'test'}),/sync_disabled/);
    await f.store.useHistory('configure',{mode:'c',collect:true,sync:true});
    await f.service.record(f.payload);
    f.db.prepare("INSERT INTO memory_use_outbox VALUES(?,?,?,'pending',NULL,?)").run('context','t',JSON.stringify(f.payload),f.now);
    const args={tenantId:'t',apiBase:'https://example.invalid',apiKey:'test',fetchImpl:async()=>new Response('{}',{status:503})};
    assert.equal((await f.store.syncMemoryUse(args)).remaining,1);
    const sent=[];
    const fetchImpl=async(url,request)=>{sent.push({url:String(url),body:JSON.parse(request.body)});return Response.json({data:{id:JSON.parse(request.body).id,usage_id:JSON.parse(request.body).id}});};
    assert.equal((await f.store.syncMemoryUse({...args,fetchImpl})).sent,1);
    await f.service.revoke('context');
    assert.equal((await f.store.syncMemoryUse({...args,fetchImpl})).sent,1);
    assert.ok(sent.at(-1).url.endsWith('/context/revoke'));
    assert.equal(sent.at(-1).body.operation,'revoke');
    assert.equal((await f.store.syncMemoryUse({...args,fetchImpl})).sent,0);
  } finally {await f.close();}
});

test('history pagination bounds and governance scores do not bypass policy',async()=>{
  const f=await fixture();try {
    await assert.rejects(f.service.history({limit:NaN}),/invalid_use_limit/);
    await assert.rejects(f.service.history({limit:101}),/invalid_use_limit/);
    await f.service.record(f.payload);await f.service.evaluate({id:'e',context_id:'context',proof_id:'context:2'});
    f.db.prepare("UPDATE memories SET kind='constraint' WHERE id=?").run(f.id);
    const result=await f.service.search({query:'alpha',project_id:'p',work_type:'implementation',task_id:'future',ranking_enabled:true,base:[{id:f.id,kind:'memory',score:1}]});
    assert.equal(result.results[0].score,1);
    assert.equal(result.results[0].memory_kind,'constraint');
  } finally {await f.close();}
});

test('context-only C candidates can be injected with a current-turn usage receipt',async()=>{
  const {writeFile}=await import('node:fs/promises');
  const {buildCodexMemoryContext}=await import('../packages/orgbrain-cli/src/codex-memory-context.mjs');
  const f=await fixture();try {
    await f.service.record(f.payload);await f.service.evaluate({id:'e',context_id:'context',proof_id:'context:2'});
    const workspacesFile=`${f.dir}/workspaces.json`;
    await writeFile(workspacesFile,JSON.stringify({version:1,workspaces:{[f.dir]:{tenant_id:'t',project_id:'p',default_work_type:'implementation'}}}));
    const result=await buildCodexMemoryContext({hook_event_name:'UserPromptSubmit',cwd:f.dir,prompt:'duplicate transaction',thread_id:'new-task',turn_id:'turn-one'},
      {store:f.store,env:{ORGBRAIN_WORKSPACES_FILE:workspacesFile,ORGBRAIN_ENABLE_CLOUD_MEMORY:'false',ORGBRAIN_ENABLE_ORG_SHARING:'false'}});
    assert.match(result.hookSpecificOutput.additionalContext,/Use tracking:/);
    assert.match(result.hookSpecificOutput.additionalContext,/alpha procedure/);
    assert.match(result.hookSpecificOutput.additionalContext,/source_version/);
  } finally {await f.close();}
});
