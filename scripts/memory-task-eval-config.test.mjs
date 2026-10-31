import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadTaskRuntimeConfig} from '../packages/orgbrain-cli/src/lib/memory-task-runtime-config.mjs';
test('evaluation config requires test purpose, explicit simulation and matching workspace identity',async()=>{
 const root=await mkdtemp(join(tmpdir(),'task-config-'));try{
  const directory=join(root,'.local/memory-reuse/evaluation');await mkdir(directory,{recursive:true});const normal={tenant_id:'t',project_id:'p',db_path:join(root,'db.sqlite'),observation_purpose:'task'};await writeFile(join(root,'.local/memory-reuse/config.json'),JSON.stringify(normal));
  const path=join(directory,'test.json');await writeFile(path,JSON.stringify({...normal,observation_purpose:'test'}));
  assert.deepEqual(await loadTaskRuntimeConfig(root,{}),normal);
  await assert.rejects(loadTaskRuntimeConfig(root,{ORGBRAIN_TASK_EVAL_CONFIG:path}),/explicit_test/);
  await assert.rejects(loadTaskRuntimeConfig(root,{ORGBRAIN_TASK_EVAL_CONFIG:join(root,'outside.json'),ORGBRAIN_TASK_EVAL_SIMULATION:'1'}));
  assert.equal((await loadTaskRuntimeConfig(root,{ORGBRAIN_TASK_EVAL_CONFIG:path,ORGBRAIN_TASK_EVAL_SIMULATION:'1'})).observation_purpose,'test');
  await writeFile(path,JSON.stringify({...normal,observation_purpose:'test',project_id:'other'}));await assert.rejects(loadTaskRuntimeConfig(root,{ORGBRAIN_TASK_EVAL_CONFIG:path,ORGBRAIN_TASK_EVAL_SIMULATION:'1'}),/identity/);
 }finally{await rm(root,{recursive:true,force:true});}
});
