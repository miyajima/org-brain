import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';

const modulePath='../packages/orgbrain-cli/src/lib/session-extraction.mjs';
const makeRows=text=>[{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}}];
const lesson='今後は抽出の失敗状態を必ず確認する手順として実行してください。理由は誤った成功表示を避けるためです。ただし不明ジョブは再送しない。検査結果は3項目成功、実運用は未検証。';
const response=()=>new Response(JSON.stringify({model:'anthropic/claude-haiku-5.5',provider:'Google',choices:[{finish_reason:'stop',message:{content:'{"candidates":[]}'}}],usage:{prompt_tokens:100,completion_tokens:10,cost:0.001}}));
const environment={ORGBRAIN_SESSION_EXTRACTION_MODE:'on',ORGBRAIN_SESSION_EXTRACTION_AUTORUN:'true',ORGBRAIN_LOCAL_HOOK_CAPTURE:'true',ORGBRAIN_SESSION_EXTRACTION_PROJECTS:'org-brain',OPENROUTER_API_KEY:'test'};
async function fixture(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'auto-extraction-'));return {root,queueDir:path.join(root,'q'),dbPath:path.join(root,'m.sqlite'),projectId:'org-brain',tenantId:'default',env:{...environment}};}

test('automatic wake is explicit, scoped, detached and contains no credential arguments',async()=>{
 const {wakeSessionExtraction,enqueueSessionExtraction}=await import(modulePath);let invocation;const f=await fixture();
 await enqueueSessionExtraction({...f,client:'claude',workspace:f.root,rows:makeRows(lesson)});
 const spawnImpl=(...args)=>{invocation=args;const child=new EventEmitter();child.pid=999;child.unref=()=>{};queueMicrotask(()=>child.emit('spawn'));return child;};
 const args={...f,cliPath:path.resolve('packages/orgbrain-cli/src/local-memory.mjs'),spawnImpl};
 for(const env of [{...environment,ORGBRAIN_SESSION_EXTRACTION_AUTORUN:'false'},{...environment,ORGBRAIN_SESSION_EXTRACTION_MODE:'off'},{...environment,ORGBRAIN_LOCAL_HOOK_CAPTURE:'false'},{...environment,ORGBRAIN_SESSION_EXTRACTION_PROJECTS:'other'}]){
  invocation=null;assert.equal((await wakeSessionExtraction({...args,env})).started,false);assert.equal(invocation,null);
 }
 const result=await wakeSessionExtraction(args);assert.equal(result.started,true);assert.equal(invocation[0],process.execPath);
 assert.ok(invocation[1].includes('auto-run'));assert.ok(invocation[1].includes('--execute'));assert.ok(invocation[1].includes(f.queueDir));
 assert.equal(invocation[2].detached,true);assert.equal(invocation[2].stdio,'ignore');assert.equal(invocation[2].shell,undefined);
 assert.equal(invocation[1].includes('test'),false);assert.equal(invocation[2].env.OPENROUTER_API_KEY,'test');
 await fs.rm(f.root,{recursive:true,force:true});
});

test('competing manual and automatic drains serialize model calls in one project',async()=>{
 const {enqueueSessionExtraction,drainSessionExtraction,inspectSessionExtractionWorker}=await import(modulePath);const f=await fixture();
 try{
  await enqueueSessionExtraction({...f,client:'claude',workspace:f.root,rows:makeRows(lesson)});
  let enter;const entered=new Promise(r=>enter=r);let release;const wait=new Promise(r=>release=r);let calls=0;
  const first=drainSessionExtraction({...f,fetchImpl:async()=>{calls++;enter();await wait;return response();}});await entered;
  const concurrent=await drainSessionExtraction({...f,fetchImpl:async()=>{calls++;return response();}});assert.equal(concurrent.status,'worker_busy');assert.equal(calls,1);
  const active=await inspectSessionExtractionWorker(f);assert.equal(active.active,true);
  release();await first;const last=await inspectSessionExtractionWorker(f);assert.equal(last.active,false);assert.equal(last.latest.processed>0,true);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('batch release hands off late queued work without resending completed calls',async()=>{
 const {enqueueSessionExtraction,drainSessionExtraction,inspectSessionExtraction}=await import(modulePath);const f=await fixture();let wakes=0,calls=0;
 try{
  await enqueueSessionExtraction({...f,client:'claude',workspace:f.root,rows:makeRows(lesson)});
  const late=lesson.replace('3項目','4項目');
  const first=await drainSessionExtraction({...f,limit:1,wakeImpl:async()=>{wakes++;return {started:true};},fetchImpl:async()=>{calls++;await enqueueSessionExtraction({...f,client:'cursor',workspace:f.root,rows:makeRows(late)});return response();}});
  assert.equal(first.processed,1);assert.equal(wakes,1);assert.ok((await inspectSessionExtraction(f)).some(j=>j.status==='pending'));
  await drainSessionExtraction({...f,wakeImpl:async()=>{wakes++;return {started:true};},fetchImpl:async()=>{calls++;return response();}});
  assert.equal(calls,2);assert.equal(wakes,1);assert.ok((await inspectSessionExtraction(f)).every(j=>j.status==='completed'));
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('unknown running calls stay untouched; failed calls do not cause an automatic retry loop',async()=>{
 const {enqueueSessionExtraction,drainSessionExtraction,inspectSessionExtraction}=await import(modulePath);const f=await fixture();let calls=0,wakes=0;
 try{
  await enqueueSessionExtraction({...f,client:'claude',workspace:f.root,rows:makeRows(lesson)});
  const {DatabaseSync}=await import('node:sqlite');let db=new DatabaseSync(path.join(f.queueDir,'queue.sqlite'));db.prepare("UPDATE jobs SET status='running',charged=2800").run();db.close();
  const opts={...f,fetchImpl:async()=>{calls++;throw Error('timeout');},wakeImpl:async()=>{wakes++;return {started:true};}};
  await drainSessionExtraction(opts);assert.equal(calls,0);assert.equal(wakes,0);
  await enqueueSessionExtraction({...f,client:'cursor',workspace:f.root,rows:makeRows(lesson.replace('3項目','4項目'))});await drainSessionExtraction(opts);await drainSessionExtraction(opts);
  assert.equal(calls,1);assert.equal(wakes,0);assert.deepEqual(new Set((await inspectSessionExtraction(f)).map(j=>j.status)),new Set(['running','held']));
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('native Stop wakes after insertion and duplicate delivery, but explicit config cannot inherit autorun',async()=>{
 const {ingestHookEvent}=await import('../packages/orgbrain-cli/src/hook-memory-bridge.mjs');const f=await fixture();const before={...process.env};
 try{
  const map=path.join(f.root,'workspaces.json'),envfile=path.join(f.root,'hooks.env'),transcript=path.join(f.root,'t.jsonl');
  await fs.writeFile(map,JSON.stringify({version:3,workspaces:{[f.root]:{project_id:'org-brain',tenant_id:'default',memory_learning_mode:'eager'}}}));
  await fs.writeFile(transcript,[{type:'user',sessionId:'s',message:{role:'user',content:lesson}},{type:'assistant',sessionId:'s',message:{role:'assistant',content:'Require a failure check before reuse.',stop_reason:'end_turn'}}].map(JSON.stringify).join('\n'));
  const config='ORGBRAIN_LOCAL_HOOK_CAPTURE=true\nORGBRAIN_SESSION_EXTRACTION_MODE=on\nORGBRAIN_SESSION_EXTRACTION_PROJECTS=org-brain\n';
  await fs.writeFile(envfile,config+'ORGBRAIN_SESSION_EXTRACTION_AUTORUN=true\n');
  Object.assign(process.env,{ORGBRAIN_HOOK_ENV_FILES:envfile,ORGBRAIN_WORKSPACES_FILE:map,ORGBRAIN_LOCAL_DB:f.dbPath,ORGBRAIN_SESSION_EXTRACTION_QUEUE:f.queueDir});let wakes=0;
  const payload=JSON.stringify({hook_event_name:'Stop',cwd:f.root,session_id:'s',transcript_path:transcript,last_assistant_message:'Done.'});
  const options={emit:false,wakeSessionExtraction:async()=>{wakes++;return {started:true,status:'started'};}};
  await ingestHookEvent('claude',payload,options);assert.equal(wakes,1);
  await ingestHookEvent('claude',payload,options);assert.equal(wakes,2);
  await fs.writeFile(envfile,config);process.env.ORGBRAIN_SESSION_EXTRACTION_AUTORUN='true';
  await ingestHookEvent('claude',payload,options);assert.equal(wakes,2);assert.equal(process.env.ORGBRAIN_SESSION_EXTRACTION_AUTORUN,'false');
 }finally{for(const key of Object.keys(process.env))if(!(key in before))delete process.env[key];Object.assign(process.env,before);await fs.rm(f.root,{recursive:true,force:true});}
});

test('real CLI Stop detaches the worker and saves through the ordinary path without manual run',async()=>{
 const {spawnSync}=await import('node:child_process');const {DatabaseSync}=await import('node:sqlite');const {inspectSessionExtraction,inspectSessionExtractionWorker}=await import(modulePath);const f=await fixture();
 try{
  const map=path.join(f.root,'map.json'),envfile=path.join(f.root,'hooks.env'),transcript=path.join(f.root,'claude.jsonl'),loader=path.join(f.root,'fetch-fixture.mjs'),calls=path.join(f.root,'calls.jsonl');
  await fs.writeFile(map,JSON.stringify({version:3,workspaces:{[f.root]:{project_id:'org-brain',tenant_id:'default',memory_learning_mode:'eager'}}}));
  await fs.writeFile(envfile,Object.entries(environment).map(([k,v])=>`${k}=${v}`).join('\n')+'\n');
  await fs.writeFile(transcript,[{type:'user',sessionId:'auto-native',message:{role:'user',content:lesson}},{type:'assistant',sessionId:'auto-native',message:{role:'assistant',content:'This ongoing check is required because false success is misleading. Except unknown jobs must not be resent. Three document checks passed.',stop_reason:'end_turn'}}].map(JSON.stringify).join('\n'));
  await fs.writeFile(loader,`import fs from 'node:fs';globalThis.fetch=async(url,opts)=>{const req=JSON.parse(opts.body);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({pid:process.pid,model:req.model})+'\\n');await new Promise(r=>setTimeout(r,150));const table=JSON.parse(req.messages[0].content.split('\\n').slice(1).join('\\n'));return new Response(JSON.stringify({model:req.model,provider:'Google',choices:[{finish_reason:'stop',message:{content:JSON.stringify({candidates:[{lesson_type:'decision',fields:[{name:'decision',refs:table.s.flatMap((s,i)=>s[0]==='user'?[i]:[])}]}]})}}],usage:{prompt_tokens:100,completion_tokens:40,cost:0.001}}));};`);
  const cli=process.env.ORGBRAIN_TEST_CLI_PATH??path.resolve('packages/orgbrain-cli/src/local-memory.mjs');
  const env={HOME:f.root,PATH:'',NODE_OPTIONS:`--import=${loader}`,ORGBRAIN_WORKSPACES_FILE:map,ORGBRAIN_HOOK_ENV_FILES:envfile,ORGBRAIN_LOCAL_DB:f.dbPath,ORGBRAIN_SESSION_EXTRACTION_QUEUE:f.queueDir};
  const payload={hook_event_name:'Stop',cwd:f.root,session_id:'auto-native',transcript_path:transcript,last_assistant_message:'Done.'};
  const hook=spawnSync(process.execPath,['--no-warnings',cli,'hook','claude-stop'],{env,input:JSON.stringify(payload),encoding:'utf8',timeout:5000});assert.equal(hook.status,0,hook.stderr);
  let state;for(let i=0;i<150;i++){state=await inspectSessionExtractionWorker(f);const jobs=await inspectSessionExtraction(f);if(jobs.length&&jobs.every(j=>j.status==='completed')&&!state.active)break;await new Promise(r=>setTimeout(r,25));}
  assert.equal(state.active,false);assert.ok(state.latest?.processed>0);assert.ok(state.latest?.saved>0,JSON.stringify(state));
  const requests=(await fs.readFile(calls,'utf8')).trim().split('\n').map(JSON.parse);assert.ok(requests.every(r=>r.pid===state.latest.pid));
  let db=new DatabaseSync(f.dbPath,{readOnly:true});const saved=db.prepare('SELECT status,payload_json FROM memory_learning_candidates').all();db.close();assert.ok(saved.length);assert.ok(saved.every(s=>s.status==='quarantine'));assert.ok(saved.some(s=>s.payload_json.includes('不明ジョブは再送しない')));
  const duplicate=spawnSync(process.execPath,['--no-warnings',cli,'hook','claude-stop'],{env,input:JSON.stringify(payload),encoding:'utf8',timeout:5000});assert.equal(duplicate.status,0,duplicate.stderr);
  assert.equal((await fs.readFile(calls,'utf8')).trim().split('\n').length,requests.length);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('dead worker ownership can recover, while budget exhaustion never starts a continuation',async()=>{
 const {enqueueSessionExtraction,drainSessionExtraction,inspectSessionExtractionWorker}=await import(modulePath);const {DatabaseSync}=await import('node:sqlite');const f=await fixture();let wakes=0;
 try{
  await enqueueSessionExtraction({...f,client:'claude',workspace:f.root,rows:makeRows(lesson)});await inspectSessionExtractionWorker(f);
  let db=new DatabaseSync(path.join(f.queueDir,'queue.sqlite'));db.prepare('INSERT INTO worker_leases(tenant_id,project_id,token,pid) VALUES(?,?,?,?)').run('default','org-brain','dead',2147483647);db.close();
  const result=await drainSessionExtraction({...f,fetchImpl:async()=>response()});assert.ok(result.processed>0);
  await enqueueSessionExtraction({...f,client:'claude',workspace:f.root,rows:makeRows(lesson.replace('3項目','4項目'))});
  db=new DatabaseSync(path.join(f.queueDir,'queue.sqlite'));db.prepare('UPDATE jobs SET charged=500000,month=? WHERE status=?').run(new Date().toISOString().slice(0,7),'completed');db.close();
  const exhausted=await drainSessionExtraction({...f,fetchImpl:async()=>{throw Error('must not call');},wakeImpl:async()=>{wakes++;}});assert.equal(exhausted.status,'budget_exhausted');assert.equal(wakes,0);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('an old lease cannot mistake a reused live PID for its original owner',async()=>{
 const {enqueueSessionExtraction,drainSessionExtraction,inspectSessionExtractionWorker}=await import(modulePath);const {DatabaseSync}=await import('node:sqlite');const f=await fixture();
 try{
  await enqueueSessionExtraction({...f,client:'claude',workspace:f.root,rows:makeRows(lesson)});await inspectSessionExtractionWorker(f);
  const db=new DatabaseSync(path.join(f.queueDir,'queue.sqlite'));
  if(!db.prepare('PRAGMA table_info(worker_leases)').all().some(c=>c.name==='owner_identity'))db.exec('ALTER TABLE worker_leases ADD COLUMN owner_identity TEXT');
  db.prepare('INSERT INTO worker_leases(tenant_id,project_id,token,pid,owner_identity) VALUES(?,?,?,?,?)').run('default','org-brain','old-boot',process.pid,'previous-process-incarnation');db.close();
  const result=await drainSessionExtraction({...f,fetchImpl:async()=>response()});assert.ok(result.processed>0,JSON.stringify(result));
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('missing provider cost remains unknown in worker status',async()=>{
 const {enqueueSessionExtraction,drainSessionExtraction,inspectSessionExtractionWorker}=await import(modulePath);const f=await fixture();
 try{
  await enqueueSessionExtraction({...f,client:'claude',workspace:f.root,rows:makeRows(lesson)});
  await drainSessionExtraction({...f,fetchImpl:async()=>{const value=await response().json();delete value.usage.cost;return new Response(JSON.stringify(value));}});
  assert.equal((await inspectSessionExtractionWorker(f)).latest.cost_usd,null);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('a provider failure stops the automatic batch and leaves later pending work unsent',async()=>{
 const {enqueueSessionExtraction,drainSessionExtraction,inspectSessionExtraction}=await import(modulePath);const f=await fixture();let calls=0,wakes=0;
 try{
  for(const n of [3,4])await enqueueSessionExtraction({...f,client:'claude',workspace:f.root,rows:makeRows(lesson.replace('3項目',`${n}項目`))});
  await drainSessionExtraction({...f,fetchImpl:async()=>{calls++;throw Error('timeout');},wakeImpl:async()=>{wakes++;}});
  assert.equal(calls,1);assert.equal(wakes,0);assert.deepEqual(new Set((await inspectSessionExtraction(f)).map(j=>j.status)),new Set(['pending','held']));
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('busy first project cannot bypass the configured all-project batch limit',async()=>{
 const {enqueueSessionExtraction,drainSessionExtraction,drainConfiguredSessionExtraction}=await import(modulePath);const f=await fixture();f.env.ORGBRAIN_SESSION_EXTRACTION_AUTORUN='false';f.env.ORGBRAIN_SESSION_EXTRACTION_PROJECTS='org-brain,second,third';
 let unblock,entered;const wait=new Promise(r=>unblock=r),entry=new Promise(r=>entered=r);let owner;
 try{
  for(const projectId of ['org-brain','second','third'])for(const n of [3,4])await enqueueSessionExtraction({...f,projectId,client:'claude',workspace:f.root,rows:makeRows(lesson.replace('3項目',`${n}項目`))});
  owner=drainSessionExtraction({...f,limit:1,fetchImpl:async()=>{entered();await wait;return response();}});await entry;let calls=0;
  const result=await drainConfiguredSessionExtraction({...f,limit:1,fetchImpl:async()=>{calls++;return response();}});assert.equal(calls,1);assert.equal(result.processed,1);assert.equal(result.failed,0);
 }finally{unblock();await owner;await fs.rm(f.root,{recursive:true,force:true});}
});
