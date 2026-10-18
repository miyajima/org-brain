import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport,getDefaultEnvironment} from '@modelcontextprotocol/client/stdio';
import {fixture} from './lib/memory-use-fixture.mjs';
const cli=process.env.ORGBRAIN_TEST_CLI||resolve('packages/orgbrain-cli/src/local-memory.mjs');

test('installed CLI and strict MCP expose usable C and immutable assessments',async()=>{
  const f=await fixture();let client,transport;
  try {
    await f.service.record(f.payload);
    await f.service.evaluate({id:'evaluation',context_id:'context',proof_id:'context:2'});
    const env={...getDefaultEnvironment(),ORGBRAIN_LOCAL_DB:f.store.dbPath};
    const run=(...args)=>JSON.parse(execFileSync(process.execPath,[cli,...args],{encoding:'utf8',env,stdio:['ignore','pipe','pipe']}));
    assert.equal(run('usage','configure','--mode','c','--collect').collect,true);
    assert.equal(run('usage','status').flags.ranking,true);
    const result=run('memory','search','duplicate transaction','--tenant-id','t','--project-id','p','--work-type','implementation','--task-id','new-task');
    assert.deepEqual(result.results,[]);
    assert.equal(result.meta.local_relevance.status,'pending_host_selection');
    const candidate=result.candidates.find(item=>item.memory_id===f.id);
    assert.ok(candidate,JSON.stringify(result));
    assert.equal(candidate.detail_ref.tool,'orgbrain_memory_get');
    assert.equal(candidate.detail_ref.arguments.memory_id,f.id);
    assert.equal(candidate.detail_ref.arguments.expected_version,candidate.current_version);
    assert.equal(result.meta.usage_items[0].source_id,f.id);
    assert.equal(result.meta.usage_items[0].source_version,candidate.current_version);
    transport=new StdioClientTransport({command:process.execPath,args:[cli,'mcp'],env,stderr:'pipe'});
    client=new Client({name:'memory-use-install-test',version:'1.0.0'},{versionNegotiation:{mode:{pin:'2026-07-28'},probe:{timeoutMs:2000}}});
    await client.connect(transport);
    const tools=await client.listTools();
    for(const name of ['orgbrain_memory_use_context_record','orgbrain_memory_use_history','orgbrain_memory_use_evaluate','orgbrain_memory_use_revoke']) assert.ok(tools.tools.some(t=>t.name===name));
    const invoke=async(name,args)=>{
      const result=await client.callTool({name,arguments:args});
      assert.notEqual(result.isError,true,JSON.stringify(result));
      return JSON.parse(result.content[0].text);
    };
    const detail=await invoke(candidate.detail_ref.tool,candidate.detail_ref.arguments);
    assert.equal(detail.memory.id,f.id);
    assert.equal(detail.memory.current_version,candidate.current_version);
    const priorHistory=await invoke('orgbrain_memory_use_history',{tenant_id:'t',payload:{source_id:f.id}});
    assert.equal(priorHistory.items[0].evaluations.length,1);
    assert.equal(priorHistory.items[0].stages.outcome_confirmed,true);
    const context=await invoke('orgbrain_memory_retrieve_context',{tenant_id:'t',project_id:'p',work_type:'implementation',task_id:'new-task',usage_purpose:'test',query:'duplicate transaction',top_k:1});
    assert.deepEqual(context.results,[]);
    const contextCandidate=context.candidates.find(item=>item.memory_id===f.id);
    assert.ok(contextCandidate,JSON.stringify(context));
    const contextDetail=await invoke(contextCandidate.detail_ref.tool,contextCandidate.detail_ref.arguments);
    assert.equal(contextDetail.memory.id,f.id);
    const db=f.store.open({readOnly:true});
    try {
      const usageItem=context.meta.usage_items[0];
      const row=db.prepare('SELECT reference_type,used_state,injected_token_estimate FROM memory_usage_items WHERE id=?').get(usageItem.usage_item_id);
      assert.deepEqual({...row},{reference_type:'returned',used_state:'unknown',injected_token_estimate:0});
    } finally {db.close();}
    assert.equal(context.meta.usage_items[0].source_id,f.id);
    const observed=await invoke('orgbrain_memory_observe',{tenant_id:'t',schema_version:2,lesson_type:'success',use_observation:{
      ...context.meta.usage_items[0],usage_id:context.meta.usage_id,task_id:'new-task',project_id:'p',work_type:'implementation',
      context:f.payload.context,action_call_id:'call_fixture_action'
    }});
    assert.match(observed.use_receipt,/^orgbrain-use-receipt:/);
    assert.equal(observed.tracking,'pending_transcript_verification');
    const report=run('usage','report','--tenant-id','t');
    assert.equal(report.by_purpose.test.references,1);
    assert.equal(report.by_purpose.test.action_observed,0);
    const assessment={tenant_id:'t',payload:{id:'correction',context_id:'context',supersedes_id:'evaluation',feedback:{contribution:'unknown',statement:'The incremental contribution has not been established.'}}};
    assert.equal((await invoke('orgbrain_memory_use_evaluate',assessment)).outcome,'unknown');
    assert.equal((await invoke('orgbrain_memory_use_evaluate',assessment)).created,false);
    const history=await invoke('orgbrain_memory_use_history',{tenant_id:'t',payload:{source_id:f.id}});
    assert.equal(history.items[0].stages.outcome_confirmed,true);
    assert.equal(history.items[0].evaluations.length,2);
  } finally {await client?.close().catch(()=>{});await transport?.close().catch(()=>{});await f.close();}
});
