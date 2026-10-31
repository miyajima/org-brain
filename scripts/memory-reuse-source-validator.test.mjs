import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
test('complete-source attestation requires every task constraint and the exact scoped original',async()=>{
 const root=await mkdtemp(join(tmpdir(),'source-coverage-'));
 try{
  const rule={mode:'serial',batch_size:8,region:'east',retain_days:14,version:1},file=join(root,'source.json');await writeFile(file,JSON.stringify({rules:{queue:rule}}));
  const memory={id:'synthetic-queue',current_version:2,content:`Synthetic queue planning rules: ${JSON.stringify(rule)}. For records=N, partitions=ceil(N/batch_size). Always deduplicate.`,reuse_rule:'Only for queue.plan, using this source version.'};
  const req={input:{target:'queue',records:37},source_files:[file],memories:[memory]};
  const invoke=x=>{const p=spawnSync(process.execPath,[resolve('scripts/memory-reuse-source-validator.mjs'),JSON.stringify(x)],{encoding:'utf8'});assert.equal(p.status,0,p.stderr);return JSON.parse(p.stdout);};
  const good=invoke(req);assert.equal(good.ok,true);assert.equal(good.coverage.kind,'complete_source');assert.equal(good.coverage.fields.length,7);
  assert.equal(invoke({...req,memories:[{...memory,content:memory.content.replace('Always deduplicate.','')}]}).ok,false);
  const partial={batch_size:8,retain_days:14,version:1};await writeFile(file,JSON.stringify({rules:{queue:partial}}));
  assert.equal(invoke({...req,memories:[{...memory,content:`Synthetic queue planning rules: ${JSON.stringify(partial)}. For records=N, partitions=ceil(N/batch_size). Always deduplicate.`}]}).ok,false);
 }finally{await rm(root,{recursive:true,force:true});}
});
