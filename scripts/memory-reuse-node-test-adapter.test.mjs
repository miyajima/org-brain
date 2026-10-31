import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
test('managed test adapter executes the fixed test and preserves pass/fail outcomes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'reuse-node-test-'));
 try{
  const file=join(root,'fixture.test.mjs');const invoke=input=>spawnSync(process.execPath,[resolve('scripts/memory-reuse-node-test-adapter.mjs'),file,JSON.stringify(input)],{cwd:root,encoding:'utf8'});
  await writeFile(file,"import test from 'node:test';test('real pass',()=>{});");let r=invoke({op:'test'});assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).ok,true);
  await writeFile(file,"import test from 'node:test';test('real failure',()=>{throw Error('fixture failure');});");r=invoke({op:'test'});assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).ok,false);
  assert.notEqual(invoke({op:'delete'}).status,0);
 }finally{await rm(root,{recursive:true,force:true});}
});
