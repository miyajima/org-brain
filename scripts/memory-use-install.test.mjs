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
    assert.equal(run('usage','status').flags.ranking,true);
    const result=run('memory','search','duplicate transaction','--tenant-id','t','--project-id','p','--work-type','implementation','--task-id','new-task');
    assert.equal(result.results[0].memory.id,f.id);
    assert.equal(result.results[0].use_history.evaluation_count,1);
    assert.equal(result.meta.usage_items[0].source_id,f.id);
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
    const context=await invoke('orgbrain_memory_retrieve_context',{tenant_id:'t',project_id:'p',work_type:'implementation',task_id:'new-task',query:'duplicate transaction',top_k:1});
    assert.equal(context.meta.usage_items[0].source_id,f.id);
    const assessment={tenant_id:'t',payload:{id:'correction',context_id:'context',supersedes_id:'evaluation',feedback:{contribution:'unknown',statement:'The incremental contribution has not been established.'}}};
    assert.equal((await invoke('orgbrain_memory_use_evaluate',assessment)).outcome,'unknown');
    assert.equal((await invoke('orgbrain_memory_use_evaluate',assessment)).created,false);
    const history=await invoke('orgbrain_memory_use_history',{tenant_id:'t',payload:{source_id:f.id}});
    assert.equal(history.items[0].stages.outcome_confirmed,true);
    assert.equal(history.items[0].evaluations.length,2);
  } finally {await client?.close().catch(()=>{});await transport?.close().catch(()=>{});await f.close();}
});
