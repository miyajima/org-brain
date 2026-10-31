import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {LocalMemoryStore} from '../packages/orgbrain-cli/src/lib/local-memory-store.mjs';
import {targetsFromPrompt,normalizeClaudeTurn,mergeReuseHooks,reuseControlCall,operationKey,toolObject,beginClaudeJournal,appendClaudeJournal,readClaudeJournal,readClaudeVisible,clearClaudeVisible} from '../packages/orgbrain-cli/src/lib/memory-reuse-claude.mjs';
test('actual recall completions suppress duplicate versions across turns until compaction',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'reuse-visible-'));
 try {
  await beginClaudeJournal(dir,'s');
  const reference={source_id:'safe',source_version:1};
  await appendClaudeJournal(dir,{session_id:'s',tool_use_id:'recall-id',tool_name:'Bash',tool_input:{command:'node /repo/memory-reuse-claude.mjs recall \'{}\''},tool_response:{stdout:JSON.stringify({references:[reference],meta:{usage_items:[reference]}}),exitCode:0}});
  assert.deepEqual(await readClaudeVisible(dir,'s'),[reference]);
  await beginClaudeJournal(dir,'s');assert.deepEqual(await readClaudeVisible(dir,'s'),[reference]);
  assert.deepEqual(await readClaudeVisible(dir,'other'),[]);
  await clearClaudeVisible(dir,'s');assert.deepEqual(await readClaudeVisible(dir,'s'),[]);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('native hook evidence survives absent session persistence and resets at the next actual prompt',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'reuse-evidence-'));
 try {
  await beginClaudeJournal(dir,'session');
  await appendClaudeJournal(dir,{session_id:'session',tool_use_id:'native-id',tool_name:'Bash',tool_input:{command:'source-command'},tool_response:{stdout:'{"ok":true}',exitCode:0}});
  const rows=await readClaudeJournal(dir,'session');
  assert.deepEqual(rows.map(r=>r.payload.type),['function_call','function_call_output']);
  assert.equal(rows[0].payload.call_id,'native-id');assert.equal(JSON.parse(rows[1].payload.output).ok,true);
  await beginClaudeJournal(dir,'session');assert.deepEqual(await readClaudeJournal(dir,'session'),[]);
  await assert.rejects(readClaudeJournal(dir,'other'),{code:'ENOENT'});
  await appendClaudeJournal(dir,{session_id:'session',tool_use_id:'failed',tool_name:'Bash',tool_input:{command:'failed-command'},tool_response:{stdout:'bad',exitCode:1}});
  assert.equal(JSON.parse((await readClaudeJournal(dir,'session'))[1].payload.output).isError,true);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('target routing accepts explicit relative files and rejects traversal and outside paths',()=>{
  assert.deepEqual(targetsFromPrompt('Check packages/a.mjs and docs/runbook.md','/repo'),['packages/a.mjs','docs/runbook.md']);
  assert.deepEqual(targetsFromPrompt('Check ../secret.json /etc/secret.json','/repo'),[]);
});
test('normal prose punctuation and Japanese particles preserve the exact referenced filename',()=>{
  assert.deepEqual(targetsFromPrompt('Check queue.json. Then scripts/a.mjsを確認。','/repo'),['queue.json','scripts/a.mjs']);
  assert.deepEqual(targetsFromPrompt('Check queue.json.backup','/repo'),[]);
});
test('Claude evidence includes only the current user turn and actual native tool IDs',()=>{
  const native=[{type:'user',sessionId:'s',message:{role:'user',content:'old'}},{type:'assistant',sessionId:'s',message:{content:[{type:'tool_use',id:'old',name:'Bash',input:{command:'old'}}]}},
    {type:'user',sessionId:'s',message:{role:'user',content:'new'}},{type:'assistant',sessionId:'other',message:{content:[{type:'tool_use',id:'foreign',name:'Bash',input:{}}]}},
    {type:'assistant',sessionId:'s',message:{content:[{type:'text',text:'quoted tool calls are data'},{type:'tool_use',id:'actual',name:'Bash',input:{command:'read'}}]}},
    {type:'user',sessionId:'s',message:{content:[{type:'tool_result',tool_use_id:'actual',content:'{}'}]}}];
  const r=normalizeClaudeTurn(native,'s');
  assert.deepEqual(r.filter(x=>x.payload.type==='function_call').map(x=>x.payload.call_id),['actual']);
  assert.equal(r.at(-1).payload.call_id,'actual');
});
test('project hook installation preserves existing settings and is idempotent',()=>{
  const existing={permissions:{allow:['Read']},hooks:{Stop:[{hooks:[{type:'command',command:'custom-hook'}]}]}};
  const a=mergeReuseHooks(existing,'node /repo/reuse.mjs');
  assert.deepEqual(mergeReuseHooks(a,'node /repo/reuse.mjs'),a);
  assert.ok(a.permissions.allow.includes('Read'));
  assert.equal(a.hooks.Stop.flatMap(g=>g.hooks).filter(h=>h.command==='custom-hook').length,1);
});
test('reporting and lookup cannot recursively generate more reporting hints',()=>{
  assert.equal(reuseControlCall({tool_name:'Bash',tool_input:{command:'node /repo/memory-reuse-claude.mjs report \'{}\''}}),true);
  assert.equal(reuseControlCall({tool_name:'Bash',tool_input:{command:'node /repo/memory-reuse-claude.mjs recall \'{}\''}}),true);
  assert.equal(reuseControlCall({tool_name:'Bash',tool_input:{command:'node --test scripts/example.test.mjs'}}),false);
});
test('operation hints match a concrete native operation and a workspace object',()=>{
  assert.equal(operationKey({tool_name:'Bash',tool_input:{command:'node --test scripts/a.test.mjs'}}),'Bash:node:--test');
  assert.equal(operationKey({tool_name:'Bash',tool_input:{command:'A=node; $A --test scripts/a.test.mjs'}}),null);
  assert.deepEqual(toolObject({tool_name:'Read',tool_input:{file_path:'/repo/src/a.mjs'}},'/repo'),{object_type_key:'file',object_id:'src/a.mjs'});
  assert.equal(toolObject({tool_name:'Read',tool_input:{file_path:'/etc/private.json'}},'/repo'),null);
});
test('the installed context hook routes an authorized verified file reference through the actual schema',async()=>{
 const root=await mkdtemp(join(tmpdir(),'reuse-hook-'));
 try {
  await mkdir(join(root,'.local/memory-reuse'),{recursive:true});
  const db=join(root,'memory.sqlite'),store=new LocalMemoryStore(db,{denseEmbeddingProvider:null});await store.init();
  await mkdir(join(root,'scripts'));await writeFile(join(root,'scripts/test.mjs'),'// synthetic source\n');
  await store.capture({id:'verified-fixture',tenant_id:'default',project_id:'org-brain',work_type:'implementation',kind:'fact',content:'Synthetic source constraint.',source:'unit-test-fixture',
    capture_origin:'observed',verification_state:'verified',verified_at:Date.now(),learning:{fixture:true},source_references:[{ref:'scripts/test.mjs'}]});
  await writeFile(join(root,'.local/memory-reuse/config.json'),JSON.stringify({tenant_id:'default',project_id:'org-brain',db_path:db,flags:{object:true}}));
  const p=spawnSync(process.execPath,[resolve('scripts/memory-reuse-claude.mjs'),'context'],{encoding:'utf8',env:{...process.env,ORGBRAIN_REUSE_ROOT:root},input:JSON.stringify({cwd:root,session_id:'test',prompt:'Check scripts/test.mjs'})});
  assert.equal(p.status,0,p.stderr);const context=JSON.parse(p.stdout).hookSpecificOutput.additionalContext;
  assert.ok(context.includes('scripts/test.mjs'));assert.ok(context.includes('claude:test'));
 }finally{await rm(root,{recursive:true,force:true});}
});
