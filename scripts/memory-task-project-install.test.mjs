import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {installProjectWork,projectWorkRequest,projectWorkProfiles} from './memory-task-project-install.mjs';

test('project workflows declare retained fact topics for the actual cross-section failures',()=>{
 const profiles=projectWorkProfiles('/project');
 assert.deepEqual(profiles['project-research'].retained_fact_topics.evidence,['measured_effect']);
 assert.deepEqual(profiles['project-analysis'].retained_fact_topics.totals,['sample_size','denominator']);
 assert.deepEqual(profiles['project-document'].retained_fact_topics.start,['configuration_paths']);
});

test('project installation preserves existing flags, adapters, hooks and permissions, and dry run is read only',async()=>{
 const root=await mkdtemp(join(tmpdir(),'work-install-'));try{
  await mkdir(join(root,'.local/memory-reuse'),{recursive:true});await mkdir(join(root,'.claude'));
  await writeFile(join(root,'source.md'),'Actual original.');
  const config={tenant_id:'default',project_id:'project',db_path:join(root,'db.sqlite'),flags:{result:true,recent:false},action_adapters:{old:{argv:['old']}},bindings:[{source_id:'keep'}]};
  const settings={permissions:{allow:['Read']},hooks:{Stop:[{hooks:[{type:'command',command:'keep-original'}]}]}};
  await writeFile(join(root,'.local/memory-reuse/config.json'),JSON.stringify(config));await writeFile(join(root,'.claude/settings.local.json'),JSON.stringify(settings));
  const profiles={research:{kind:'research',title:'Research',source_mode:'project_files',source_files:['source.md'],source_refs:[],units:{scope:'Scope'},default_units:['scope'],document_units:{scope:[{path:'source.md'}]},valid_for_ms:60000,adapter:'project-research'}};
  const dry=await installProjectWork({root,profiles,dry_run:true});assert.equal(dry.installed,false);assert.deepEqual(JSON.parse(await readFile(join(root,'.local/memory-reuse/config.json'),'utf8')),config);
  await installProjectWork({root,profiles,dry_run:false});const actual=JSON.parse(await readFile(join(root,'.local/memory-reuse/config.json'),'utf8')),hooks=JSON.parse(await readFile(join(root,'.claude/settings.local.json'),'utf8'));
  assert.deepEqual(actual.flags,config.flags);assert.deepEqual(actual.action_adapters.old,config.action_adapters.old);assert.deepEqual(actual.bindings,config.bindings);assert.equal(actual.task_local_mode,'on');assert.equal(actual.observation_purpose,'task');
  assert.ok(settings.permissions.allow.every(x=>hooks.permissions.allow.includes(x)));assert.ok(hooks.permissions.allow.slice(1).every(x=>x.startsWith('Bash(')&&/ (recall|report) \*\)$/u.test(x)));assert.ok(hooks.hooks.Stop.some(x=>x.hooks.some(h=>h.command==='keep-original')));assert.ok(hooks.hooks.PreToolUse.length);
  await installProjectWork({root,profiles,dry_run:false});const repeated=JSON.parse(await readFile(join(root,'.claude/settings.local.json'),'utf8'));assert.deepEqual(repeated,hooks);
  const request=projectWorkRequest(actual,'research',{prompt:'Real assignment',units:['scope']});assert.match(request.prompt,/Real assignment/);assert.match(request.prompt,/<reuse_task>/);assert.throws(()=>projectWorkRequest(actual,'research',{units:['unknown']}));
 }finally{await rm(root,{recursive:true,force:true});}
});
