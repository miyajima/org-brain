import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {LocalMemoryStore} from '../packages/orgbrain-cli/src/lib/local-memory-store.mjs';
import {MemoryReuse} from '../packages/orgbrain-cli/src/lib/memory-reuse.mjs';

test('registered validator reuses only a prior identical successful proposal, with native completion proof',async()=>{
 const root=await mkdtemp(join(tmpdir(),'reuse-adapter-'));
 const command=(name,id='',value)=>{
  const p=spawnSync(process.execPath,[resolve('scripts/memory-reuse-loop-adapter.mjs'),name,root,id,...(value===undefined?[]:[JSON.stringify(value)])],{encoding:'utf8'});
  assert.equal(p.status,0,p.stderr);return JSON.parse(p.stdout);
 };
 const post=(id,result,call)=>{
  const p=spawnSync(process.execPath,[resolve('scripts/memory-reuse-loop-adapter.mjs'),'hook',root,id],{encoding:'utf8',input:JSON.stringify({tool_use_id:call,tool_response:{stdout:JSON.stringify(result)}})});
  assert.equal(p.status,0,p.stderr);
 };
 try {
  command('setup');
  command('prepare','prior',{channel:'object',condition:'memory',case_id:1,revision:1});
  const plan={target:'queue',mode:'serial',batch_size:8,region:'east',retain_days:14,deduplicate:true,partitions:3};
  const prior=command('api','prior',{op:'apply',plan});assert.equal(prior.ok,true);post('prior',prior,'fixture-prior-native');
  command('prepare','matching',{channel:'result',condition:'memory',case_id:1,revision:1});
  const hit=command('api','matching',{op:'apply',plan});
  assert.equal(hit.validation_source,'prior_verified_identical_input');assert.deepEqual(hit.applied_plan,plan);
  const store=new LocalMemoryStore(join(root,'memory.sqlite'),{denseEmbeddingProvider:null});
  const reuse=new MemoryReuse(store,{tenant_id:'default',project_id:'org-brain',principal_id:'alice',work_type:'implementation'});
  assert.equal((await reuse.applications('matching')).length,0);
  post('matching',hit,'fixture-matching-native');assert.equal((await reuse.applications('matching')).length,1);
  command('prepare','mismatch',{channel:'result',condition:'memory',case_id:1,revision:1});
  const miss=command('api','mismatch',{op:'apply',plan:{...plan,retain_days:999}});
  assert.equal(miss.ok,false);assert.equal(miss.reuse_applied,false);assert.equal(miss.derived_application_token,undefined);
  post('mismatch',miss,'fixture-mismatch-native');assert.equal((await reuse.applications('mismatch')).length,0);
 }finally{await rm(root,{recursive:true,force:true});}
});
