import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runDocumentWork} from '../packages/orgbrain-cli/src/lib/memory-task-document-adapter.mjs';
import {confirmationTiming,readSessionUsage,appendWorkObservation,workObservationSummary} from '../packages/orgbrain-cli/src/lib/memory-task-observation.mjs';

async function fixture(fn){const root=await mkdtemp(join(tmpdir(),'ordinary-work-'));try{
 await mkdir(join(root,'docs'));await writeFile(join(root,'docs/source.md'),'# Title\n\n## Scope\nReal project fact.\n\n## Other\nDo not select.\n');
 await writeFile(join(root,'data.json'),JSON.stringify({groups:{base:{n:10,tokens:120}},actual_bill:null}));
 const workflow={title:'Actual project document',source_mode:'project_files',source_files:['docs/source.md','data.json'],units:{scope:'Scope',data:'Data'},document_units:{scope:[{path:'docs/source.md',heading:'Scope'}],data:[{path:'data.json',pointer:'/groups/base'}]}};
 await fn({root,workflow});
}finally{await rm(root,{recursive:true,force:true});}}

test('adapter reads configured original sections and writes a real complete result',()=>fixture(async ({root,workflow})=>{
 const x=await runDocumentWork({root,workflow,workflow_id:'real',input:{op:'read',units:['scope','data']}});
 assert.match(x.source_sections.scope,/Real project fact/);assert.doesNotMatch(x.source_sections.scope,/Do not select/);assert.match(x.source_sections.data,/120/);
 const y=await runDocumentWork({root,workflow,workflow_id:'real',input:{op:'write',units:['scope'],sections:{scope:'A useful scope summary.'}}});
 assert.match(await readFile(join(root,y.artifact.path),'utf8'),/A useful scope summary/);assert.match(y.artifact.sha256,/^[a-f0-9]{64}$/);
}));
test('adapter rejects unknown scope, absent sections and paths outside the project',()=>fixture(async ({root,workflow})=>{
 await assert.rejects(runDocumentWork({root,workflow,workflow_id:'real',input:{op:'read',units:['other']}}));
 workflow.document_units.scope=[{path:'docs/source.md',heading:'Missing'}];await assert.rejects(runDocumentWork({root,workflow,workflow_id:'real',input:{op:'read',units:['scope']}}),/section_not_found/);
 await symlink('/etc/hosts',join(root,'outside'));workflow.source_files.push('outside');workflow.document_units.scope=[{path:'outside'}];
 await assert.rejects(runDocumentWork({root,workflow,workflow_id:'real',input:{op:'read',units:['scope']}}),/outside_project/);
 await assert.rejects(runDocumentWork({root,workflow,workflow_id:'real',input:{op:'write',units:['scope'],sections:{scope:'ok',other:'extra'}}}));
}));
test('human time distinguishes real elapsed time, explicit attention and simulated answers',()=>{
 assert.deepEqual(confirmationTiming({displayed_ms:100,answered_ms:2600,simulated:false}),{confirmation_elapsed_ms:2500,human_active_ms:null,human_time_source:'real_answer_elapsed'});
 assert.equal(confirmationTiming({displayed_ms:100,answered_ms:2600,simulated:false,active_seconds:1}).human_active_ms,1000);
 assert.equal(confirmationTiming({displayed_ms:100,answered_ms:2600,simulated:true}).confirmation_elapsed_ms,null);
 assert.throws(()=>confirmationTiming({displayed_ms:100,answered_ms:2600,simulated:false,active_seconds:3}));
});
test('session accounting deduplicates assistant messages and leaves missing usage unknown',()=>fixture(async ({root})=>{
 const p=join(root,'session.jsonl'),usage={input_tokens:10,cache_creation_input_tokens:20,cache_read_input_tokens:30,output_tokens:4};
 const row={type:'assistant',sessionId:'s',message:{id:'m',model:'claude-sonnet-5-5',usage}};
 await writeFile(p,[row,row,{...row,sessionId:'other',message:{...row.message,id:'x'}}].map(x=>JSON.stringify(x)).join('\n'));
 assert.equal((await readSessionUsage(p,'s')).total_tokens,64);
 await writeFile(p,JSON.stringify({...row,message:{...row.message,usage:{input_tokens:10}}}));assert.equal((await readSessionUsage(p,'s')).total_tokens,null);
 await writeFile(p,'broken json');assert.equal((await readSessionUsage(p,'s')).total_tokens,null);
}));
test('observations retain cancellation and zero-model completion; missing human time stays missing',()=>fixture(async ({root})=>{
 await appendWorkObservation(root,{session_id:'cancel',event:'cancelled',purpose:'task',confirmation_elapsed_ms:1000,human_active_ms:null,model_starts:0});
 await appendWorkObservation(root,{session_id:'done',event:'completed_existing',purpose:'task',confirmation_elapsed_ms:500,human_active_ms:400,model_starts:0});
 await appendWorkObservation(root,{session_id:'test',event:'completed_existing',purpose:'test',confirmation_elapsed_ms:null,human_active_ms:null,model_starts:0});
 const s=await workObservationSummary(root);assert.equal(s.real_answer_count,2);assert.equal(s.completed_existing,1);assert.equal(s.model_starts,0);assert.equal(s.human_active_ms,null);assert.equal(s.human_time_missing_count,1);
}));
test('one native UI confirmation batch is timed once across its separate task decisions',()=>fixture(async ({root})=>{
 for(const session_id of ['first','second'])await appendWorkObservation(root,{session_id,event:'confirmed',purpose:'task',human_timing_group_id:'same-question',confirmation_elapsed_ms:2500,human_active_ms:null});
 const summary=await workObservationSummary(root);assert.equal(summary.real_answer_count,2);assert.equal(summary.confirmation_elapsed_ms,2500);assert.equal(summary.human_timing_groups,1);
}));
test('no real human answers means confirmation time is unknown, not zero',()=>fixture(async ({root})=>{
 await appendWorkObservation(root,{session_id:'prepared-only',event:'prepared',purpose:'task',model_starts:0});
 const summary=await workObservationSummary(root);assert.equal(summary.real_answer_count,0);assert.equal(summary.confirmation_elapsed_ms,null);
}));
