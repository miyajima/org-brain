import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './lib/memory-use-fixture.mjs';
import { collectMemoryUse } from '../packages/orgbrain-cli/src/lib/memory-use-collector.mjs';
import { handleLocalMcpRequest } from '../packages/orgbrain-cli/src/local-mcp.mjs';
import { readMemoryUseTurnRows } from '../packages/orgbrain-cli/src/lib/memory-learning-transcript.mjs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { storeLocalUseProof } from '../packages/orgbrain-cli/src/lib/local-memory-use.mjs';

const call=(id,name,args)=>({type:'response_item',payload:{type:'function_call',call_id:id,name,arguments:JSON.stringify(args)}});
const out=(id,value)=>({type:'response_item',payload:{type:'function_call_output',call_id:id,output:JSON.stringify(value)}});
const wrapped=(id,text)=>({type:'response_item',payload:{type:'custom_tool_call',call_id:id,name:'exec',input:text}});
const wrappedOut=(id,value)=>({type:'response_item',payload:{type:'custom_tool_call_output',call_id:id,output:`Script completed\nOutput:\n${JSON.stringify(value)}`}});
const observation=f=>({usage_id:'usage',usage_item_id:'item',source_id:f.id,source_version:1,project_id:'p',task_id:'prior-task',work_type:'implementation',context:f.payload.context,action_call_id:'act',outcome_call_id:'act'});

const avoidedOperation = (kind = 'result_reuse') => ({kind, operation:'repeat unchanged test suite',
  prior_evidence:'test receipt at revision abc123', applicability_check:'source and test inputs unchanged',
  reason:'the previous result answers the current check'});

test('usage and usefulness are separate, including unknown and revised assessments', async () => {
  const f = await fixture();
  try {
    f.db.prepare("UPDATE memory_usage_events SET usage_purpose='task'").run();
    const report = async () => (await f.store.useHistory('report', { tenant_id: 't' })).by_purpose.task;
    await f.service.record(f.payload);
    let result = await report();
    assert.deepEqual(result.use, { used: 1, not_used: 0, unassessed: 0 });
    assert.deepEqual(result.usefulness, { verified_helpful: 0, verified_not_helpful: 0, unconfirmed: 0, unrated: 1, helpful_rate_verified: null });

    await f.service.evaluate({ id: 'helpful', context_id: 'context', proof_id: 'context:2' });
    result = await report();
    assert.equal(result.use.used, 1);
    assert.equal(result.usefulness.verified_helpful, 1);
    assert.equal(result.usefulness.helpful_rate_verified, 1);

    await f.service.evaluate({ id: 'unknown', context_id: 'context', supersedes_id: 'helpful', feedback: { contribution: 'unknown', statement: 'Benefit is uncertain.' } });
    result = await report();
    assert.equal(result.use.used, 1);
    assert.equal(result.usefulness.verified_helpful, 0);
    assert.equal(result.usefulness.unconfirmed, 1);
    assert.equal(result.usefulness.helpful_rate_verified, null);

    await f.service.evaluate({ id: 'negative', context_id: 'context', supersedes_id: 'unknown', feedback: { contribution: 'negative', statement: 'This lookup sent the task to the wrong component.' } });
    result = await report();
    assert.equal(result.usefulness.verified_helpful, 0);
    assert.equal(result.usefulness.verified_not_helpful, 1);
    assert.equal(result.usefulness.helpful_rate_verified, 0);

    await f.service.revoke('context');
    result = await report();
    assert.equal(result.use.used, 0);
    assert.equal(result.usefulness.verified_not_helpful, 0);
  } finally { await f.close(); }
});

test('avoided operations survive compact MCP receipt collection without claiming causal savings', async () => {
  const f = await fixture();
  try {
    const accepted = await receipt(f, {usage_item_id:'item', action_call_id:'act', task:'check current revision',
      target:'test suite', avoided_operation:avoidedOperation()});
    assert.deepEqual(accepted.observation.context.avoided_operation, avoidedOperation());
    const args={rows:wrappedRows(f,accepted),tenantId:'t',projectId:'p',taskId:'prior-task',turnId:'turn'};
    await collectMemoryUse(f.store,args);
    await collectMemoryUse(f.store,args);
    const report=await f.store.useHistory('report',{tenant_id:'t'});
    assert.equal(report.avoided_operations.reported_operations,1);
    assert.equal(report.avoided_operations.by_kind.result_reuse,1);
    assert.equal(report.avoided_operations.by_kind.failure_avoidance,0);
    assert.equal(report.avoided_operations.measured_time_saved_ms,null);
    assert.equal(report.verified_positive_effects,0);
    const history=await f.service.history({source_id:f.id});
    assert.ok(JSON.stringify(history).includes('test receipt at revision abc123'));
  } finally { await f.close(); }
});

test('avoided-operation reporting respects periods, deduplication, purpose, conflicts and revocation', async () => {
  const f=await fixture();
  try {
    const context={...f.payload.context,avoided_operation:avoidedOperation('failure_avoidance')};
    await f.service.record({...f.payload,context});
    await f.service.record({...f.payload,id:'duplicate',context});
    f.db.prepare("UPDATE memory_usage_events SET usage_purpose='task'").run();
    let report=await f.store.useHistory('report',{tenant_id:'t',since:new Date(f.now).toISOString(),until:new Date(f.now+1).toISOString()});
    assert.equal(report.avoided_operations.reported_operations,1);
    assert.equal(report.avoided_operations.linked_use_records,2);
    assert.equal(report.avoided_operations.by_purpose.task,1);
    assert.equal(report.avoided_operations.by_kind.failure_avoidance,1);
    assert.equal((await f.store.useHistory('report',{tenant_id:'t',until:new Date(f.now).toISOString()})).avoided_operations.reported_operations,0);
    assert.equal((await f.store.useHistory('report',{tenant_id:'t',project_id:'other'})).avoided_operations.reported_operations,0);
    f.db.prepare("UPDATE memory_usage_items SET used_state='not_used'").run();
    assert.equal((await f.store.useHistory('report',{tenant_id:'t'})).avoided_operations.reported_operations,0);
    f.db.prepare("UPDATE memory_usage_items SET used_state='unknown'").run();
    await f.service.revoke('context');
    await f.service.revoke('duplicate');
    assert.equal((await f.store.useHistory('report',{tenant_id:'t'})).avoided_operations.reported_operations,0);
  } finally { await f.close(); }
});

test('avoided-operation claims require a category, operation, prior evidence and applicability check', async () => {
  const f=await fixture();
  try {
    for(const claim of [{...avoidedOperation(),kind:'saved'}, {...avoidedOperation(),prior_evidence:''},
      {...avoidedOperation(),applicability_check:''}, {...avoidedOperation(),reason:'api_key=secret-value'}]) {
      await assert.rejects(f.service.record({...f.payload,context:{...f.payload.context,avoided_operation:claim}}),/invalid_use_|sensitive_use_context/);
    }
  } finally { await f.close(); }
});

test('an operation observed for both audit and task remains visible in each purpose', async () => {
  const f=await fixture();
  try {
    const context={...f.payload.context,avoided_operation:avoidedOperation()};
    f.db.prepare("UPDATE memory_usage_events SET usage_purpose='audit'").run();
    await f.service.record({...f.payload,context});
    await f.store.recordUsage({id:'task-use',tenant_id:'t',project_id:'p',task_id:'prior-task',usage_purpose:'task',
      items:[{id:'task-item',source_type:'memory',source_id:f.id,source_version:1}]});
    const evidence=await storeLocalUseProof(f.db,{tenant_id:'t',principal:'local',project_id:'p',task_id:'prior-task',
      source_id:f.id,usage_item_id:'task-item',created_at:f.now,role:'action',text:'used prior result for current task'});
    await f.service.record({...f.payload,id:'task-context',usage_item_id:'task-item',context,evidence:[evidence]});
    const result=(await f.store.useHistory('report',{tenant_id:'t'})).avoided_operations;
    assert.equal(result.reported_operations,1);
    assert.equal(result.by_purpose.audit,1);
    assert.equal(result.by_purpose.task,1);
  } finally { await f.close(); }
});

test('usage report filters retrieval and collection periods, including the start and excluding the end', async () => {
  const f = await fixture();
  try {
    f.db.prepare('UPDATE memory_usage_events SET created_at=0').run();
    for (const [id, at, items] of [
      ['before', Date.parse('2026-11-08T23:59:59Z'), []],
      ['start', Date.parse('2026-11-09T00:00:00Z'), [{id:'start-item',source_type:'memory',source_id:f.id,source_version:1,reference_type:'returned'}]],
      ['empty-period', Date.parse('2026-11-10T00:00:00Z'), []],
      ['end', Date.parse('2026-11-16T00:00:00Z'), []]
    ]) {
      await f.store.recordUsage({id,tenant_id:'t',project_id:'p',task_id:id,usage_purpose:'task',items});
      f.db.prepare('UPDATE memory_usage_events SET created_at=? WHERE id=?').run(at,id);
    }
    const report = await f.store.useHistory('report', {tenant_id:'t',since:'2026-11-09T09:00:00+09:00',until:'2026-11-16T00:00:00Z'});
    assert.equal(report.total.events,2);
    assert.equal(report.total.tasks,2);
    assert.equal(report.total.tasks_with_references,1);
    assert.equal(report.total.references,1);
    assert.equal(report.total.not_assessed,1);
    assert.equal(report.period.since,'2026-11-09T00:00:00.000Z');
    assert.equal(report.period.until,'2026-11-16T00:00:00.000Z');
    assert.equal((await f.store.useHistory('report',{tenant_id:'t'})).total.events,5);
    for (const options of [{since:'2026-11-09'}, {since:'2026-02-30T00:00:00Z'}, {since:'2026-11-16T00:00:00Z',until:'2026-11-09T00:00:00Z'}]) {
      await assert.rejects(f.store.useHistory('report',{tenant_id:'t',...options}),/usage_report_/);
    }
  } finally { await f.close(); }
});

test('period reports distinguish retrieval cohorts from later action and collection records', async () => {
  const f = await fixture();
  try {
    const since = new Date(f.now - 10000).toISOString();
    const until = new Date(f.now - 1000).toISOString();
    f.db.prepare('UPDATE memory_usage_events SET created_at=?').run(f.now - 5000);
    await f.service.record(f.payload);
    await f.service.evaluate({id:'late-rating',context_id:'context',proof_id:'context:2'});
    await collectMemoryUse(f.store,{rows:[],tenantId:'t',projectId:'p',taskId:'prior-task',turnId:'late-turn',readReason:'transcript_path_missing'});
    const period = await f.store.useHistory('report',{tenant_id:'t',since,until});
    assert.equal(period.total.action_observed,1);
    assert.equal(period.action_observations_in_period.references,0);
    assert.equal(period.verified_positive_effects,0);
    assert.equal(period.total.usefulness.verified_helpful,1);
    assert.equal(period.collection_metrics.runs,0);
    const later = await f.store.useHistory('report',{tenant_id:'t',since:until});
    assert.equal(later.total.references,0);
    assert.equal(later.action_observations_in_period.references,1);
    assert.equal(later.action_observations_in_period.tasks,1);
    assert.equal(later.verified_positive_effects,1);
    assert.equal(later.collection_metrics.runs,1);
    assert.equal(later.collection_metrics.gap_reasons.transcript_path_missing,1);
  } finally { await f.close(); }
});

test('period action observations include repeated use of a reference within the selected period', async () => {
  const f = await fixture();
  try {
    await f.service.record(f.payload);
    await f.service.record({...f.payload,id:'another-use'});
    f.db.prepare('UPDATE memory_use_contexts SET created_at=? WHERE id=?').run(f.now - 2000,'context');
    const report = await f.store.useHistory('report',{tenant_id:'t',since:new Date(f.now - 1).toISOString(),until:new Date(f.now + 1000).toISOString()});
    assert.equal(report.action_observations_in_period.references,1);
    assert.equal(report.action_observations_in_period.tasks,1);
    const earlier = await f.store.useHistory('report',{tenant_id:'t',since:new Date(f.now - 2001).toISOString(),until:new Date(f.now - 1000).toISOString()});
    assert.equal(earlier.action_observations_in_period.references,1);
    assert.equal(earlier.action_observations_in_period.tasks,1);
  } finally { await f.close(); }
});
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
