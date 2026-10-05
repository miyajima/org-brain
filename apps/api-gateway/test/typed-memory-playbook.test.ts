import { describe,expect,it } from 'vitest';
import event from './fixtures/optional-diagnostic-failure.json';
import { countContextTokens, planConversationMemory } from '@org-brain/shared';
import { stageConversationMemories } from '../src/conversation-memory-service';
import { confirmProposedMemory } from '../src/rationale-service';
import { searchMemories } from '../src/memory-search-service';
import { retrieveMemoryContext } from '../src/memory-context-service';
import { getTaskCommitmentContext } from '../src/memory-contract-service';
import { memoryD1Fixture } from './fixtures/memory-d1';
const owner='user:fixture-owner';
const playbook=()=>({schema_version:'memory-playbook/v1',sources:[{ref:'repo:workflow-fixture/skills/job/SKILL.md',version:'fixture-v1',content_hash:'sha256:'+'a'.repeat(64)}],
  prerequisites:'Read the Job skill and complete the mandatory safe read gate. Project and queue diagnostics are optional.',
  steps:[{command:{executable:'fixture-jobctl',args:['status','--job','<current-job-id>'],tool_version:'fixture-v1'},expected_output:'Current authorized Job scope and status fields',stop_when:'Scope or tool version differs',on_failure:'On optional diagnostic denial follow the skill without extending IAM'}],refresh_when:'Refresh the cited skill section when source hash or tool version changes'});
function input(): any { const e=structuredClone(event) as any;e.candidates[0].memory_type='playbook';e.candidates[0].scope={level:'project',project_id:e.project_id};e.candidates[0].playbook=playbook();return e; }
function fixture() {const f=memoryD1Fixture();f.env.HYBRID_V4_MODE='on';f.env.EVIDENCE_DISPOSITION_MODE='on';f.sql.prepare('INSERT INTO principal_role_assignments(id,tenant_id,project_id,principal,role,created_by_principal,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('role','fixture','workflow-fixture',owner,'project_owner',owner,1,1);return f;}
async function stage(env:any,e:any) {const p=await stageConversationMemories(env,'fixture',e,{principal:owner});return (await stageConversationMemories(env,'fixture',e,{principal:owner,execute:true,expectedPlanHash:p.plan_hash})).receipts[0];}
const answer=(r:any)=>({tenant_id:'fixture',confirmation_token:r.confirmation_token,expected_candidate_hash:r.candidate_hash,expected_revision:r.revision,approved:true,review_answer:'保存する'});
const request={tenant_id:'fixture',project_id:'workflow-fixture',q:'再開して',task_id:'fixture-current-task',task_context:{project_id:'workflow-fixture',task_key:'fixture-current-task',subject_query:'What Job skill prerequisites should we use?'},top_k:2,token_budget:2500};
describe('typed compatible playbook and task scope',()=>{
  it('delivers minimal current-scope steps on a contextual resume without verifying commands or granting actions',async()=>{const {env,sql}=fixture();try{
    const e=input(),r=await stage(env,e);expect((await searchMemories(env,request,{actorPrincipal:owner})).results).toEqual([]);
    await confirmProposedMemory(env,answer(r),owner);
    const context=await retrieveMemoryContext(env,request,{actorPrincipal:owner});const text=context.evidence_bundle.evidence.map(x=>x.text).join('\n');
    expect(context.meta.task_query?.coverage).toBe('covered');expect(countContextTokens(context)).toBeLessThanOrEqual(request.token_budget);
    for(const required of ['skills/job/SKILL.md','fixture-v1','<current-job-id>','mandatory safe read gate','optional','Stop:','Failure:','Refresh:','unverified','grants no execution permission'])expect(text).toContain(required);
    const row=sql.prepare('SELECT * FROM memories').get();expect(row.verification_state).toBe('unverified');
    expect(JSON.parse(row.learning_json).conversation_provenance.playbook.steps[0].command.validation_state).toBe('template_checked_unverified');
    expect(JSON.parse(row.source_refs_json).some((ref:any)=>ref.type==='playbook_source'&&ref.content_hash==='sha256:'+'a'.repeat(64))).toBe(true);
    const bare={...request,task_context:undefined};expect((await searchMemories(env,bare,{actorPrincipal:owner})).results).toEqual([]);
    expect((await retrieveMemoryContext(env,bare,{actorPrincipal:owner})).evidence_bundle.evidence).toEqual([]);
    expect((await searchMemories(env,{...request,task_context:{...request.task_context,project_id:'other'}},{actorPrincipal:owner})).results).toEqual([]);
    expect((await searchMemories(env,{...request,task_id:'another-task'},{actorPrincipal:owner})).results).toEqual([]);
    expect((await searchMemories(env,{...request,project_id:'other'},{actorPrincipal:owner})).results).toEqual([]);
    expect((await searchMemories(env,{...request,task_context:{...request.task_context,subject_query:'What unknown UnicornDatabase should we use?'}},{actorPrincipal:owner})).results).toEqual([]);
    for(const q of ['再開してください。','resume','resume this task!','resume the task']){
      expect((await retrieveMemoryContext(env,{...request,q},{actorPrincipal:owner})).meta.task_query?.coverage).toBe('covered');
      expect((await retrieveMemoryContext(env,{...bare,q},{actorPrincipal:owner})).evidence_bundle.evidence).toEqual([]);
    }
    const newer=input();newer.candidates[0].playbook.sources[0].version='fixture-v2';expect(planConversationMemory(newer).plan_hash).not.toBe(planConversationMemory(e).plan_hash);
    await expect(confirmProposedMemory(env,{...answer(r),review_answer:'修正: new content',corrected_content:'New content'},owner)).rejects.toThrow('typed candidate');
  }finally{sql.close();}});
  it('abstains for explicit history, suppressed and entity filters on resume using original request flags',async()=>{const {env,sql}=fixture();try{
    const e=input(),r=await stage(env,e);await confirmProposedMemory(env,answer(r),owner);
    for(const filters of [{include_history:true},{include_suppressed:true},{entity_id:'unknown-entity'}]){
      const search=await searchMemories(env,{...request,...filters},{actorPrincipal:owner});expect(search.results).toEqual([]);expect(search.meta.task_query?.coverage).toBe('uncertain');
      expect((await retrieveMemoryContext(env,{...request,...filters},{actorPrincipal:owner})).evidence_bundle.evidence).toEqual([]);
    }
    expect(sql.prepare('SELECT count(*) AS n FROM memory_usage_items').get().n).toBe(0);
  }finally{sql.close();}});
  it('rejects credentials, write commands, fixed targets, unsupported templates and task limits inside a durable playbook',async()=>{const {env,sql}=fixture();try{
    for(const mutate of [(e:any)=>e.candidates[0].playbook.steps[0].command.args=['run','--job','<current-job-id>'],(e:any)=>e.candidates[0].playbook.steps[0].command.args=['status','--job','fixed-target'],(e:any)=>e.candidates[0].playbook.steps[0].command.args=['status','--job','<current-job-id>;rm'],(e:any)=>e.candidates[0].playbook.max_calls=3,(e:any)=>e.candidates[0].playbook.sources[0].ref='repo:workflow-fixture/file?token=fixture',(e:any)=>e.candidates[0].playbook.prerequisites='ｔｏｋｅｎ＝fixture']){
      const e=input();mutate(e);await expect(stageConversationMemories(env,'fixture',e,{principal:owner})).rejects.toThrow();
    }
    expect(sql.prepare('SELECT count(*) AS n FROM memory_confirmations').get().n).toBe(0);
  }finally{sql.close();}});
  it('routes explicitly typed task ceilings to commitments after review, never to searchable durable memories',async()=>{const {env,sql}=fixture();try{
    const e=structuredClone(event) as any;e.sources[0].text='Fixture current task permits at most three attempts until its expiry.';e.candidates[0].claim_type='user_decision';e.candidates[0].memory_type='task_constraint';e.candidates[0].scope={level:'task',project_id:e.project_id,task_key:'fixture-current-task',expires_at:new Date(Date.now()+60_000).toISOString()};e.candidates[0].task_constraint={decision_key:'fixture-call-ceiling',max_calls:3};
    const r=await stage(env,e);expect((await getTaskCommitmentContext(env,{tenant_id:'fixture',project_id:e.project_id,task_key:'fixture-current-task'})).commitments).toEqual([]);
    const saved=await confirmProposedMemory(env,answer(r),owner);expect(saved.saved).toBe(true);expect(saved).toMatchObject({persistence_scope:'task',active_memories_created:0,memory_id:null});
    expect(sql.prepare('SELECT count(*) AS n FROM memories').get().n).toBe(0);
    expect(sql.prepare('SELECT count(*) AS n FROM memories_fts').get().n).toBe(0);
    const commitment=(await getTaskCommitmentContext(env,{tenant_id:'fixture',project_id:e.project_id,task_key:'fixture-current-task'})).commitments[0];
    expect(JSON.parse(commitment.answer.label)).toMatchObject({max_calls:3,grants_execution_permission:false});
    expect((await getTaskCommitmentContext(env,{tenant_id:'fixture',project_id:e.project_id,task_key:'next-task'})).commitments).toEqual([]);
    expect((await getTaskCommitmentContext(env,{tenant_id:'fixture',project_id:'other',task_key:'fixture-current-task'})).commitments).toEqual([]);
    expect((await searchMemories(env,request,{actorPrincipal:owner})).results).toEqual([]);
    sql.prepare('UPDATE task_commitments SET expires_at=1').run();expect((await getTaskCommitmentContext(env,{tenant_id:'fixture',project_id:e.project_id,task_key:'fixture-current-task'})).commitments).toEqual([]);
  }finally{sql.close();}});
});
