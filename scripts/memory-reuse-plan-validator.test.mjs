import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
test('planning validator attests matching original constraints, never a stored task answer',async()=>{
 const root=await mkdtemp(join(tmpdir(),'plan-validator-'));
 try{
  const rule={mode:'serial',batch_size:8,region:'east',retain_days:14,version:2},file=join(root,'corpus.json');await writeFile(file,JSON.stringify({rules:{queue:rule}}));
  const memory={id:'synthetic-queue',current_version:2,content:`Synthetic queue planning rules: ${JSON.stringify(rule)}. For records=N, partitions=ceil(N/batch_size). Always deduplicate.`,reuse_rule:'Only for queue.plan, using this source version.'};
  const request={input:{target:'queue',records:657},memories:[memory],source_files:[file]};
  const run=p=>{const x=spawnSync(process.execPath,[resolve('scripts/memory-reuse-plan-validator.mjs'),JSON.stringify(p)],{encoding:'utf8'});assert.equal(x.status,0,x.stderr);return JSON.parse(x.stdout);};
  assert.equal(run(request).ok,true);assert.equal(run({...request,memories:[{...memory,content:memory.content.replace('batch_size":8','batch_size":9')}]}).ok,false);
  assert.equal(run({...request,input:{...request.input,records:-1}}).ok,false);
 }finally{await rm(root,{recursive:true,force:true});}
});
