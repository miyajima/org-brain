import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {seal} from './memory-utility-v11.mjs';
import {runSyntheticSmoke} from './memory-utility-v11-evaluation-only-smoke.mjs';
import {EVALUATION_ONLY_SCHEMA_HASH} from './memory-utility-v11-evaluation-only.mjs';

test('evaluation transport smoke prepares the current Luna/medium request',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'smoke-model-'));fs.chmodSync(root,0o700);
 try{
  const manifest=path.join(root,'manifest.json');fs.writeFileSync(manifest,JSON.stringify(seal({evaluation_schema_hash:EVALUATION_ONLY_SCHEMA_HASH})),{mode:0o600});
  // No model is called: stop at an ordinary unsuccessful local executable.
  await assert.rejects(()=>runSyntheticSmoke(manifest,{executable:'/usr/bin/false',sessionsRoot:path.join(root,'sessions')}));
  const request=JSON.parse(fs.readFileSync(path.join(root,'synthetic-smoke/cli-request.json'),'utf8'));
  assert.equal(request.model,'gpt-6-luna');assert.equal(request.effort,'medium');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
