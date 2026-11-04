import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {LocalMemoryStore} from '../packages/orgbrain-cli/src/lib/local-memory-store.mjs';
import {MemoryReuse} from '../packages/orgbrain-cli/src/lib/memory-reuse.mjs';
import {connectProjectKnowledge,connectedTargets} from '../packages/orgbrain-cli/src/lib/memory-reuse-claude.mjs';
async function fixture(fn){
 const root=await mkdtemp(join(tmpdir(),'reuse-connect-')),store=new LocalMemoryStore(join(root,'memory.sqlite'),{denseEmbeddingProvider:null});
 await store.init();await mkdir(join(root,'docs'));await writeFile(join(root,'docs/intake.md'),'Synthetic source');
 const scope={tenant_id:'default',project_id:'org-brain',principal_id:'alice',work_type:'implementation'},reuse=new MemoryReuse(store,scope);
 const seed=extra=>store.capture({id:'existing',external_key:'test:existing',tenant_id:'default',project_id:'org-brain',work_type:'implementation',kind:'fact',content:'Starting is distinct from activation.',source:'test',verification_state:'verified',verified_at:Date.now(),learning:{fixture:true},capture_origin:'observed',source_references:[{ref:'source:11111111-1111-4111-8111-111111111111@1'}],...extra});
 const binding={source_id:'existing',source_version:1,source_ref:'source:11111111-1111-4111-8111-111111111111@1',targets:['docs/intake.md'],phrases:['intake status','受付の確認']};
 try{await seed({});await fn({root,store,reuse,scope,seed,binding});}finally{await rm(root,{recursive:true,force:true});}
}
test('existing Wiki references connect to work targets without duplicating knowledge',()=>fixture(async({root,store,reuse,binding})=>{
 const before=await store.get('default','existing'),a=await connectProjectKnowledge(reuse,root,[binding]);
 assert.equal(a.connected.length,1,JSON.stringify(a));assert.deepEqual(connectedTargets('受付の確認を続ける',root,a),['docs/intake.md']);
 assert.deepEqual(connectedTargets('intake statusbackup',root,a),[]);
 assert.deepEqual(connectedTargets('unrelated task',root,a),[]);
 assert.equal((await reuse.recall({channel:'object',flags:{object:true},task_id:'normal',object_type_key:'file',object_id:'docs/intake.md'})).references[0].source_id,'existing');
 await connectProjectKnowledge(reuse,root,[binding]);const db=await reuse.open();
 try{assert.equal(db.prepare('select count(*) n from memories').get().n,1);assert.equal(db.prepare('select count(*) n from memory_reuse_links').get().n,1);}finally{db.close();}
 assert.equal((await store.get('default','existing')).current_version,before.current_version);
}));
test('connection rejects wrong provenance, stale versions, unverified sources and revoked access',()=>fixture(async({root,store,reuse,scope,seed,binding})=>{
 assert.equal((await connectProjectKnowledge(reuse,root,[{...binding,source_ref:'source:other@1'}])).connected.length,0);
 await seed({content:'Revision 2',permissions:[{principal_type:'principal',principal_id:'alice',permissions:['read']}]});
 assert.equal((await connectProjectKnowledge(reuse,root,[binding])).connected.length,0);
 const b={...binding,source_version:2};assert.equal((await connectProjectKnowledge(new MemoryReuse(store,{...scope,principal_id:'bob'}),root,[b])).connected.length,0);
 await seed({content:'Unverified revision',verification_state:'unverified'});
 assert.equal((await connectProjectKnowledge(reuse,root,[{...binding,source_version:3}])).connected.length,0);
}));
test('targets are existing files within the project; missing and escaping links fail closed',()=>fixture(async({root,reuse,binding})=>{
 await symlink('/etc/hosts',join(root,'docs/outside.md'));
 for(const target of ['../outside.md','/etc/hosts','docs/missing.md','docs/outside.md']){
  const a=await connectProjectKnowledge(reuse,root,[{...binding,targets:[target]}]);assert.equal(a.connected.length,0,target);
 }
}));
test('expired original knowledge is never connected',()=>fixture(async({root,reuse,seed,binding})=>{
 await seed({content:'Expired',valid_until:Date.now()-1000});
 assert.equal((await connectProjectKnowledge(reuse,root,[{...binding,source_version:2}])).connected.length,0);
}));
test('normal context does not advertise another principal\'s existing private link',()=>fixture(async({root,reuse,seed,binding})=>{
 await seed({content:'Private source',permissions:[{principal_type:'principal',principal_id:'alice',permissions:['read']}]});
 await connectProjectKnowledge(reuse,root,[{...binding,source_version:2}]);
 await mkdir(join(root,'.local/memory-reuse'),{recursive:true});
 await writeFile(join(root,'.local/memory-reuse/config.json'),JSON.stringify({tenant_id:'default',project_id:'org-brain',db_path:join(root,'memory.sqlite'),flags:{object:true}}));
 const r=spawnSync(process.execPath,[resolve('scripts/memory-reuse-claude.mjs'),'context'],{env:{...process.env,ORGBRAIN_REUSE_ROOT:root,ORGBRAIN_USE_PRINCIPAL:'bob'},encoding:'utf8',input:JSON.stringify({cwd:root,session_id:'private',prompt:'Check docs/intake.md'})});
 assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),{});
}));
test('reinstall preserves project bindings and the selected local database',()=>fixture(async({root,binding})=>{
 await mkdir(join(root,'.local/memory-reuse'),{recursive:true});await mkdir(join(root,'artifacts/memory-reuse-loop-20261026'),{recursive:true});
 await writeFile(join(root,'artifacts/memory-reuse-loop-20261026/report.json'),JSON.stringify({stages:{object:{adopted:true}}}));
 const config={version:1,tenant_id:'default',project_id:'org-brain',db_path:join(root,'memory.sqlite'),bindings:[binding]};
 await writeFile(join(root,'.local/memory-reuse/config.json'),JSON.stringify(config));
 const r=spawnSync(process.execPath,[resolve('scripts/memory-reuse-claude.mjs'),'install'],{env:{...process.env,ORGBRAIN_REUSE_ROOT:root},encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);const current=JSON.parse(await readFile(join(root,'.local/memory-reuse/config.json'),'utf8'));
 assert.deepEqual(current.bindings,config.bindings);assert.equal(current.db_path,config.db_path);
}));
