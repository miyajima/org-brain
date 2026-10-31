import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {LocalMemoryStore} from '../packages/orgbrain-cli/src/lib/local-memory-store.mjs';
import {MemoryReuse} from '../packages/orgbrain-cli/src/lib/memory-reuse.mjs';
async function fixture(fn){
 const root=await mkdtemp(join(tmpdir(),'reuse-freshness-'));await mkdir(join(root,'docs'));
 const file=join(root,'docs/source.json');await writeFile(file,'{"batch":8}');
 const validator=join(root,'validate.mjs');await writeFile(validator,`import {readFile,appendFile} from 'node:fs/promises';const p=JSON.parse(process.argv.at(-1));await appendFile(${JSON.stringify(join(root,'validated.jsonl'))},'executed\\n');console.log(JSON.stringify({ok:p.memories[0].content.includes((await readFile(p.source_files[0],'utf8')))}));`);
 const store=new LocalMemoryStore(join(root,'memory.sqlite'),{denseEmbeddingProvider:null});await store.init();
 const seed=extra=>store.capture({id:'rule',external_key:'test:freshness',tenant_id:'default',project_id:'org-brain',work_type:'implementation',kind:'fact',content:'Use this source exactly: {"batch":8}',rationale:'Preserve source constraints.',reuse_rule:'Only this target and current input.',verification_state:'verified',verified_at:Date.now(),learning:{fixture:true},source:'unit-test-fixture',capture_origin:'observed',source_references:[{ref:'docs/source.json'}],...extra});await seed({});
 const reuse=new MemoryReuse(store,{tenant_id:'default',project_id:'org-brain',principal_id:'alice',work_type:'implementation'}),input={target:'rules',records:25};
 const config={freshness_mode:'validated',freshness_profiles:{plan:{argv:[process.execPath,validator],refs:[{source_id:'rule',source_version:1}],source_files:['docs/source.json'],environment:{service_version:'test-v1'},valid_for_ms:60000}}};
 try{const mod=await import('../packages/orgbrain-cli/src/lib/memory-reuse-freshness.mjs');await fn({root,file,validator,store,seed,reuse,input,config,...mod});}finally{await rm(root,{recursive:true,force:true});}
}
test('a real successful validator primes a proof; a matching check reuses it without executing validation again',()=>fixture(async f=>{
 const proof=await f.primeFreshness({...f,profile_id:'plan'});assert.equal(proof.primed,true);
 const checked=await f.checkFreshness({...f,profile_id:'plan'});assert.equal(checked.fresh,true);assert.deepEqual(checked.source_refs,[{source_id:'rule',source_version:1}]);
 assert.equal((await readFile(join(f.root,'validated.jsonl'),'utf8')).trim().split('\n').length,1);
}));
test('changed input, environment, validator or source bytes never pass a prior freshness proof',()=>fixture(async f=>{
 await f.primeFreshness({...f,profile_id:'plan'});
 assert.equal((await f.checkFreshness({...f,profile_id:'plan',input:{...f.input,records:26}})).fresh,false);
 const config=structuredClone(f.config);config.freshness_profiles.plan.environment.service_version='test-v2';assert.equal((await f.checkFreshness({...f,config,profile_id:'plan'})).fresh,false);
 await writeFile(f.file,'{"batch":9}');assert.equal((await f.checkFreshness({...f,profile_id:'plan'})).fresh,false);
 await writeFile(f.file,'{"batch":8}');await writeFile(f.validator,'throw Error("changed validator");');assert.equal((await f.checkFreshness({...f,profile_id:'plan'})).fresh,false);
}));
test('current memory version and expiry are required at check time',()=>fixture(async f=>{
 await f.primeFreshness({...f,profile_id:'plan',now:()=>1000});assert.equal((await f.checkFreshness({...f,profile_id:'plan',now:()=>62000})).fresh,false);
 await f.seed({content:'The rule changed.'});assert.equal((await f.checkFreshness({...f,profile_id:'plan',now:()=>2000})).fresh,false);
}));
test('a proof is principal scoped and a missing proof stays unknown rather than verified',()=>fixture(async f=>{
 assert.equal((await f.checkFreshness({...f,profile_id:'plan'})).fresh,false);await f.primeFreshness({...f,profile_id:'plan'});
 const reuse=new MemoryReuse(f.store,{...f.reuse.scope,principal_id:'bob'});assert.equal((await f.checkFreshness({...f,reuse,profile_id:'plan'})).fresh,false);
}));
test('failed validator and escaping source path produce no reusable proof',()=>fixture(async f=>{
 await writeFile(f.validator,'console.log(JSON.stringify({ok:false}));');await assert.rejects(f.primeFreshness({...f,profile_id:'plan'}),/validation_failed/);
 assert.equal((await f.checkFreshness({...f,profile_id:'plan'})).fresh,false);
 f.config.freshness_profiles.plan.source_files=['../outside.json'];await assert.rejects(f.primeFreshness({...f,profile_id:'plan'}),/source_outside/);
}));
