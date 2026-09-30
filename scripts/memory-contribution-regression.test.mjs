import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './lib/memory-use-fixture.mjs';
import { collectMemoryUse } from '../packages/orgbrain-cli/src/lib/memory-use-collector.mjs';
import { handleLocalMcpRequest } from '../packages/orgbrain-cli/src/local-mcp.mjs';
import { readMemoryUseTurnRows } from '../packages/orgbrain-cli/src/lib/memory-learning-transcript.mjs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const call=(id,name,args)=>({type:'response_item',payload:{type:'function_call',call_id:id,name,arguments:JSON.stringify(args)}});
const out=(id,value)=>({type:'response_item',payload:{type:'function_call_output',call_id:id,output:JSON.stringify(value)}});
const wrapped=(id,text)=>({type:'response_item',payload:{type:'custom_tool_call',call_id:id,name:'exec',input:text}});
const wrappedOut=(id,value)=>({type:'response_item',payload:{type:'custom_tool_call_output',call_id:id,output:`Script completed\nOutput:\n${JSON.stringify(value)}`}});
const observation=f=>({usage_id:'usage',usage_item_id:'item',source_id:f.id,source_version:1,project_id:'p',task_id:'prior-task',work_type:'implementation',context:f.payload.context,action_call_id:'act',outcome_call_id:'act'});
async function receipt(f,obs=observation(f)) {
  const result=await handleLocalMcpRequest(f.store,{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'orgbrain_memory_observe',arguments:{tenant_id:'t',schema_version:2,lesson_type:'success',use_observation:obs}}});
  assert.ok(!result.isError,JSON.stringify(result));
  return JSON.parse(result.content[0].text);
}
function wrappedRows(f,accepted) {
  return [wrapped('s','actual retrieval through the tool runtime'),wrappedOut('s',{meta:{usage_id:'usage',usage_items:[{usage_item_id:'item',source_id:f.id,source_version:1}]}}),
    call('act','exec_command',{cmd:'check fixture'}),out('act',{exit_code:0}),wrapped('o','actual observation through the tool runtime'),wrappedOut('o',accepted)];
}

test('receipt-backed wrapped MCP use records an action once without inventing a positive evaluation',async()=>{
  const f=await fixture();try {
    const accepted=await receipt(f);
    assert.equal(accepted.persisted,false);
    assert.match(accepted.use_receipt,/^orgbrain-use-receipt:[a-f0-9-]{36}$/);
    const args={rows:wrappedRows(f,accepted),tenantId:'t',projectId:'p',taskId:'prior-task',turnId:'turn'};
    assert.equal((await collectMemoryUse(f.store,args)).recorded,1);
    assert.equal((await collectMemoryUse(f.store,args)).recorded,1);
    assert.equal(f.db.prepare('SELECT count(*) n FROM memory_use_contexts').get().n,1);
    assert.equal(f.db.prepare('SELECT count(*) n FROM memory_use_evaluations').get().n,0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM memory_use_statistics').get().n,0);
  } finally {await f.close();}
});

test('quoted, forged and cross-task receipts never establish use',async()=>{
  const f=await fixture();try {
    const accepted=await receipt(f);
    const args={tenantId:'t',projectId:'p',taskId:'prior-task',turnId:'turn'};
    const forged={...accepted,use_receipt:'orgbrain-use-receipt:00000000-0000-4000-8000-000000000000'};
    assert.equal((await collectMemoryUse(f.store,{...args,rows:wrappedRows(f,forged)})).recorded,0);
    const quoted=wrappedRows(f,accepted).slice(0,-1);
    quoted.push({payload:{type:'message',role:'user',content:[{type:'text',text:JSON.stringify(accepted)}]}});
    assert.equal((await collectMemoryUse(f.store,{...args,rows:quoted})).recorded,0);
    assert.equal((await collectMemoryUse(f.store,{...args,taskId:'another-task',rows:wrappedRows(f,accepted)})).recorded,0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM memory_use_contexts').get().n,0);
  } finally {await f.close();}
});

test('tool names are rejected as action IDs and a missing result remains unassessed with a reason',async()=>{
  const f=await fixture();try {
    const accepted=await receipt(f,{...observation(f),action_call_id:'exec_command'});
    const args={rows:wrappedRows(f,accepted),tenantId:'t',projectId:'p',taskId:'prior-task',turnId:'turn'};
    assert.deepEqual((await collectMemoryUse(f.store,args)).rejected,['use_action_not_observed']);
    const report=await f.store.useHistory('report',{tenant_id:'t'});
    assert.equal(report.total.not_assessed,1);
    assert.equal(report.unassessed_reasons.use_action_not_observed,1);
  } finally {await f.close();}
});

test('usage report separates purpose, delivery, adoption and effect while retaining zero-result tasks',async()=>{
  const f=await fixture();try {
    await f.store.recordUsage({id:'audit',tenant_id:'t',project_id:'p',task_id:'audit-task',usage_purpose:'audit',items:[{id:'audit-item',source_type:'memory',source_id:f.id,source_version:1,reference_type:'returned'}]});
    await f.store.updateUsageStates('t',{usage_event_id:'audit',items:[{usage_item_id:'audit-item',used_state:'not_used'}]});
    await f.store.recordUsage({id:'empty',tenant_id:'t',project_id:'p',task_id:'empty-task',usage_purpose:'task',items:[]});
    const report=await f.store.useHistory('report',{tenant_id:'t'});
    assert.equal(report.total.references,2);
    assert.equal(report.total.not_assessed,1);
    assert.equal(report.by_purpose.audit.not_contributed,1);
    assert.equal(report.by_purpose_reference.audit.returned.not_contributed,1);
    assert.equal(report.by_purpose.task.events,1);
    assert.equal(report.by_purpose.task.tasks,1);
    assert.equal(report.by_purpose.task.references,0);
    assert.equal(report.by_purpose.unclassified.references,1);
    assert.equal(report.verified_positive_effects,0);
    assert.equal(report.total.assessment_coverage,0.5);
  } finally {await f.close();}
});

test('a failed action is observable but is not automatically a positive or negative effect',async()=>{
  const f=await fixture();try {
    const accepted=await receipt(f),rows=wrappedRows(f,accepted);
    rows[3]=out('act',{exit_code:1});
    assert.equal((await collectMemoryUse(f.store,{rows,tenantId:'t',projectId:'p',taskId:'prior-task'})).recorded,1);
    assert.equal((await f.store.useHistory('report',{tenant_id:'t'})).verified_positive_effects,0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM memory_use_evaluations').get().n,0);
  }finally{await f.close();}
});

test('expired receipts and actions without completed tool results remain unassessed',async()=>{
  const f=await fixture();try {
    const accepted=await receipt(f),args={tenantId:'t',projectId:'p',taskId:'prior-task'};
    assert.deepEqual((await collectMemoryUse(f.store,{...args,rows:wrappedRows(f,accepted).filter((_,i)=>i!==3)})).rejected,['use_action_not_observed']);
    f.db.prepare('UPDATE local_use_observation_receipts SET expires_at=0').run();
    assert.deepEqual((await collectMemoryUse(f.store,{...args,rows:wrappedRows(f,accepted)})).rejected,['use_receipt_expired']);
    assert.equal(f.db.prepare('SELECT count(*) n FROM memory_use_contexts').get().n,0);
  }finally{await f.close();}
});
test('received retrievals are counted separately from use, including when no observation is emitted',async()=>{
  const f=await fixture();try {
    const rows=wrappedRows(f,{}).slice(0,2),args={rows,tenantId:'t',projectId:'p',taskId:'prior-task'};
    await collectMemoryUse(f.store,args);await collectMemoryUse(f.store,args);
    const report=await f.store.useHistory('report',{tenant_id:'t'});
    assert.equal(report.total.delivery_confirmed,1);
    assert.equal(report.total.not_assessed,1);
    assert.equal(report.total.action_observed,0);
    assert.equal(report.total.received_assessment_coverage,0);
  }finally{await f.close();}
});
test('malformed wrapper receipts cannot interrupt valid later observations',async()=>{
  const f=await fixture();try {
    const accepted=await receipt(f);
    const rows=[wrapped('bad','untrusted output'),wrappedOut('bad',{meta:{usage_id:'usage',usage_items:[null,{},'item']}}),...wrappedRows(f,accepted)];
    assert.equal((await collectMemoryUse(f.store,{rows,tenantId:'t',projectId:'p',taskId:'prior-task'})).recorded,1);
  }finally{await f.close();}
});
test('superseded use evidence never survives in the contribution report',async()=>{
  const f=await fixture();try {
    await f.service.record(f.payload);
    await f.service.evaluate({id:'rating',context_id:'context',proof_id:'context:2'});
    assert.equal((await f.store.useHistory('report',{tenant_id:'t'})).verified_positive_effects,1);
    await f.service.record({...f.payload,id:'corrected',supersedes_id:'context',evidence:[]});
    const report=await f.store.useHistory('report',{tenant_id:'t'});
    assert.equal(report.verified_positive_effects,0);
    assert.equal(report.total.action_observed,0);
    assert.equal(report.total.not_assessed,1);
  }finally{await f.close();}
});
test('repeated positive assessments of the same task and memory count once',async()=>{
  const f=await fixture();try {
    await f.service.record(f.payload);
    await f.service.evaluate({id:'rating',context_id:'context',proof_id:'context:2'});
    await f.service.record({...f.payload,id:'duplicate'});
    f.setNow(f.now+1);
    await f.service.evaluate({id:'rating-2',context_id:'duplicate',proof_id:'duplicate:2'});
    assert.equal((await f.store.useHistory('report',{tenant_id:'t'})).verified_positive_effects,1);
  }finally{await f.close();}
});

test('a later turn may use a delivered injection, but never borrow an earlier action or a pre-compaction receipt',async()=>{
  const f=await fixture();try {
    f.db.prepare("UPDATE memory_usage_events SET capability='hook_context',trace_id='earlier'").run();
    f.db.prepare("UPDATE memory_usage_items SET reference_type='injected'").run();
    const accepted=await receipt(f);
    const delivery={payload:{type:'message',role:'developer',content:[{type:'text',text:`Use tracking: receipt; task_id=prior-task; project_id=p; work_type=implementation; usage_id=usage; items=${JSON.stringify([{usage_item_id:'item',source_id:f.id,source_version:1}])} If and only if...`}]}};
    const current=wrappedRows(f,accepted).slice(2);
    const rows=[{type:'turn_context',payload:{turn_id:'earlier'}},delivery,call('past-act','exec_command',{}),out('past-act',{exit_code:0}),{type:'turn_context',payload:{turn_id:'later'}},...current];
    const path=join(f.dir,'transcript.jsonl');await writeFile(path,rows.map(JSON.stringify).join('\n'));
    const loaded=await readMemoryUseTurnRows({transcriptPath:path,turnId:'later'});
    assert.equal(loaded.some(row=>row.payload?.call_id==='past-act'),false);
    assert.equal((await collectMemoryUse(f.store,{rows:loaded,tenantId:'t',projectId:'p',taskId:'prior-task',turnId:'later'})).recorded,1);
    assert.deepEqual((await collectMemoryUse(f.store,{rows:current,tenantId:'t',projectId:'p',taskId:'prior-task',turnId:'later'})).rejected,['use_retrieval_not_observed']);
    rows.splice(4,0,{type:'compacted',payload:{message:'summary'}});
    await writeFile(path,rows.map(JSON.stringify).join('\n'));
    const compacted=await readMemoryUseTurnRows({transcriptPath:path,turnId:'later'});
    assert.deepEqual((await collectMemoryUse(f.store,{rows:compacted,tenantId:'t',projectId:'p',taskId:'prior-task',turnId:'later'})).rejected,['use_retrieval_not_observed']);
  }finally{await f.close();}
});
