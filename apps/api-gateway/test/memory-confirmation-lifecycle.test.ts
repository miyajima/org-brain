import { describe, expect, it } from 'vitest';
import { sha256 } from '@org-brain/shared';
import event from './fixtures/optional-diagnostic-failure.json';
import { stageConversationMemories } from '../src/conversation-memory-service';
import { cancelMemoryConfirmation, confirmProposedMemory, getMemoryConfirmationStatus, proposeMemoryWithRationale } from '../src/rationale-service';
import { memoryD1Fixture } from './fixtures/memory-d1';
const owner = 'user:fixture-owner';
function fixture() {
  const result = memoryD1Fixture();
  result.sql.prepare('INSERT INTO principal_role_assignments(id,tenant_id,project_id,principal,role,created_by_principal,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('role','fixture','workflow-fixture',owner,'project_owner',owner,1,1);
  return result;
}
async function stage(env: ReturnType<typeof fixture>['env'], input = event, revisionOf?: any) {
  const options = { principal: owner, revisionOf };
  const preview = await stageConversationMemories(env,'fixture',input,options);
  return (await stageConversationMemories(env,'fixture',input,{ ...options,execute:true,expectedPlanHash:preview.plan_hash })).receipts[0];
}
const guard = (r: any) => ({ confirmation_token:r.confirmation_token, expected_candidate_hash:r.candidate_hash,expected_revision:r.revision });
const revision = (r: any) => ({ confirmationToken:r.confirmation_token,expectedCandidateHash:r.candidate_hash,expectedRevision:r.revision });
const answer = (r: any) => ({ tenant_id:'fixture', ...guard(r),approved:true,review_answer:'3' });
const nextEvent = (id = 'r2') => { const e=structuredClone(event);e.event_id=id;e.candidates[0].rationale+=' Revised fixture.';return e; };

describe('atomic pending confirmation lifecycle', () => {
  it('atomically revises, deduplicates retries and prevents an older token from activating', async () => {
    const { env,sql }=fixture();try {
      const old=await stage(env); const input=nextEvent();const current=await stage(env,input,revision(old));
      expect(current.revision).toBe(2);
      expect((await getMemoryConfirmationStatus(env,{ tenant_id:'fixture',confirmation_token:old.confirmation_token },owner)).status).toBe('superseded');
      expect((await stage(env,input,revision(old))).created).toBe(false);
      await expect(confirmProposedMemory(env,answer(old),owner)).rejects.toThrow('superseded or cancelled');
      await expect(confirmProposedMemory(env,{ ...answer(current),expected_revision:1 },owner)).rejects.toThrow('hash or revision');
      await expect(confirmProposedMemory(env,{ ...answer(current),expected_candidate_hash:'a'.repeat(64) },owner)).rejects.toThrow('hash or revision');
      await expect(confirmProposedMemory(env,{ tenant_id:'fixture',confirmation_token:current.confirmation_token,approved:true,review_answer:'3' },owner)).rejects.toThrow('displayed candidate');
      const saved=await confirmProposedMemory(env,answer(current),owner);
      expect(saved.saved).toBe(true);expect(await confirmProposedMemory(env,answer(current),owner)).toEqual(saved);
      expect(sql.prepare('SELECT count(*) AS n FROM memories').get().n).toBe(1);
      expect(sql.prepare('SELECT count(*) AS n FROM memory_confirmations').get().n).toBe(2);
      await expect(stage(env,nextEvent('r3'),revision(current))).rejects.toThrow('no longer pending');
    } finally {sql.close();}
  });
  it('cancels idempotently with an immutable reason and fails closed on wrong scope/owner/hash', async () => {
    const { env,sql }=fixture();try {
      const current=await stage(env);const input={ ...guard(current),reason:'Withdraw this synthetic candidate' };
      await expect(cancelMemoryConfirmation(env,'fixture',{...input,reason:'x'.repeat(501)},owner)).rejects.toThrow('1–500');
      await expect(cancelMemoryConfirmation(env,'other',input,owner)).rejects.toThrow('not found');
      await expect(cancelMemoryConfirmation(env,'fixture',input,'user:other')).rejects.toThrow('owner');
      await expect(cancelMemoryConfirmation(env,'fixture',{...input,expected_revision:2},owner)).rejects.toThrow('revision');
      const wrong=nextEvent();wrong.project_id='other-project';
      await expect(stage(env,wrong,revision(current))).rejects.toThrow();
      const cancelled=await cancelMemoryConfirmation(env,'fixture',input,owner);
      expect(cancelled.status).toBe('cancelled');expect(await cancelMemoryConfirmation(env,'fixture',input,owner)).toEqual(cancelled);
      await expect(cancelMemoryConfirmation(env,'fixture',{...input,reason:'Different reason'},owner)).rejects.toThrow('different reason');
      await expect(confirmProposedMemory(env,answer(current),owner)).rejects.toThrow('superseded or cancelled');
      await expect(stage(env,nextEvent(),revision(current))).rejects.toThrow('no longer pending');
      expect(sql.prepare('SELECT count(*) AS n FROM memories').get().n).toBe(0);
      expect(sql.prepare('SELECT count(*) AS n FROM memory_confirmations').get().n).toBe(1);
    } finally {sql.close();}
  });
  it('deduplicates identical concurrent revisions and allows only one distinct successor',async()=>{
    const {env,sql}=fixture();try{
      const old=await stage(env),input=nextEvent('same-concurrent');
      const identical=await Promise.all([stage(env,input,revision(old)),stage(env,input,revision(old))]);
      expect(identical.filter(r=>r.created)).toHaveLength(1);
      expect(identical[0].confirmation_token).toBe(identical[1].confirmation_token);
      const current=identical[0];
      const distinct=await Promise.allSettled([stage(env,nextEvent('left'),revision(current)),stage(env,nextEvent('right'),revision(current))]);
      expect(distinct.filter(r=>r.status==='fulfilled')).toHaveLength(1);
      expect(sql.prepare('SELECT count(*) AS n FROM memory_confirmations WHERE previous_confirmation_id=?').get(current.confirmation_token).n).toBe(1);
      expect(sql.prepare('SELECT count(*) AS n FROM memories').get().n).toBe(0);
    }finally{sql.close();}
  });
  it.each(['revise','cancel','duplicate'] as const)('has one atomic winner when confirm races %s', async action => {
    const { env,sql }=fixture();try {
      const current=await stage(env);
      const other=action==='revise'?stage(env,nextEvent(),revision(current)):action==='cancel'?
        cancelMemoryConfirmation(env,'fixture',{...guard(current),reason:'Fixture cancellation'},owner):confirmProposedMemory(env,answer(current),owner);
      const results=await Promise.allSettled([confirmProposedMemory(env,answer(current),owner),other]);
      const row=sql.prepare('SELECT lifecycle_state FROM memory_confirmations WHERE id=?').get(current.confirmation_token);
      const memories=sql.prepare('SELECT count(*) AS n FROM memories').get().n;
      expect(results.some(r=>r.status==='fulfilled')).toBe(true);
      if(row.lifecycle_state==='saved'){expect(memories).toBe(1);}else{expect(['superseded','cancelled']).toContain(row.lifecycle_state);expect(memories).toBe(0);}
      if(action==='duplicate'){expect(row.lifecycle_state).toBe('saved');expect(sql.prepare('SELECT count(*) AS n FROM memory_confirmation_reviews').get().n).toBe(1);}
      expect(row.lifecycle_state).not.toBe('processing');
    } finally {sql.close();}
  });
  it('recovers a lost final receipt without repeating the active write or allowing cancellation during processing', async () => {
    const {env,sql}=fixture();try {
      const current=await stage(env);
      const db=env.OPEN_BRAIN_DB,originalBatch=db.batch.bind(db);let injected=false;
      db.batch=(async (statements:any[])=>{if(!injected&&statements.some(s=>s._query?.includes('response_json = ?'))){injected=true;throw new Error('fixture receipt failure');}return originalBatch(statements);}) as typeof db.batch;
      await expect(confirmProposedMemory(env,answer(current),owner)).rejects.toThrow('fixture receipt failure');
      const before=sql.prepare('SELECT id,current_version FROM memories').get();
      expect(sql.prepare('SELECT lifecycle_state FROM memory_confirmations WHERE id=?').get(current.confirmation_token).lifecycle_state).toBe('processing');
      await expect(cancelMemoryConfirmation(env,'fixture',{...guard(current),reason:'Fixture cancellation'},owner)).rejects.toThrow('Only a current pending');
      const saved=await confirmProposedMemory(env,answer(current),owner);expect(saved.saved).toBe(true);
      expect(sql.prepare('SELECT id,current_version FROM memories').get()).toEqual(before);
      expect(await confirmProposedMemory(env,answer(current),owner)).toEqual(saved);
      expect(sql.prepare('SELECT count(*) AS n FROM memories').get().n).toBe(1);
    } finally {sql.close();}
  });

  it('migrates pre-0047 pending payloads without changing identity or immutable receipts', async () => {
    const { env,sql }=memoryD1Fixture(46);try {
      const payload={ tenant_id:'fixture',source:'fixture',actor_type:'principal',actor_id:owner,
        proposed_memory:{external_key:null,content:'Legacy fixture',summary:'Legacy fixture',tags:[],created_at:1,project_id:'workflow-fixture',business_category_id:null,work_type:null},
        proposed_rationale:{decision_type:'policy',conclusion:'Legacy fixture',reason_summary:'Old review',status:'accepted',confidence_score:0.5},proposed_entities:[],proposed_evidence:[],
        review_context:{candidate_id:'legacy',candidate_hash:'b'.repeat(64),source_references:[],conclusion:'Legacy fixture',reason_summary:'Old review'} };
      const original=JSON.stringify(payload),token='CL000000000000000000000001';
      sql.prepare('INSERT INTO memory_confirmations(id,tenant_id,source,payload_json,created_at,expires_at) VALUES(?,?,?,?,?,?)').run(token,'fixture','fixture',original,1,Date.now()+60_000);
      const completed='CL000000000000000000000002';
      sql.prepare('INSERT INTO memory_confirmations(id,tenant_id,source,payload_json,created_at,expires_at,consumed_at) VALUES(?,?,?,?,?,?,?)').run(completed,'fixture','fixture',original,1,1,1);
      const oldParsed={tenantId:'fixture',confirmationToken:completed,approved:true,conclusion:null,reasonSummary:null,decisionType:null,status:null,entities:[],evidence:[],correctedContent:null,correctedSummary:null,reviewLabel:null,reviewAnswer:'3'};
      const receipt={tenant_id:'fixture',approved:true,saved:true,memory_id:'fixture-old-memory',rationale_id:'fixture-old-rationale'};
      sql.prepare(`INSERT INTO memory_confirmation_reviews(confirmation_id,tenant_id,project_id,owner_principal,candidate_id,candidate_hash,original_json,source_refs_json,answer_label,answer_text,assessment_json,request_hash,save_state,response_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(completed,'fixture','workflow-fixture',owner,'legacy','b'.repeat(64),'{}','[]','accepted','3','{}',await sha256(JSON.stringify(oldParsed)),'saved',JSON.stringify(receipt),1,1);
      const runtime=(globalThis as any).process;const fs=runtime.getBuiltinModule('node:fs');
      sql.exec(fs.readFileSync(new URL('../../../migrations/0047_memory_confirmation_lifecycle.sql',import.meta.url),'utf8'));
      const row=sql.prepare('SELECT * FROM memory_confirmations WHERE id=?').get(token);
      expect(row.payload_json).toBe(original);expect(row.revision).toBe(1);expect(row.managed_review).toBe(0);expect(row.candidate_hash).toBe('b'.repeat(64));
      expect(sql.prepare('SELECT lifecycle_state FROM memory_confirmations WHERE id=?').get(completed).lifecycle_state).toBe('saved');
      expect(await confirmProposedMemory(env,{tenant_id:'fixture',confirmation_token:completed,approved:true,review_answer:'3'},owner)).toEqual(receipt);
      expect(await getMemoryConfirmationStatus(env,{tenant_id:'fixture',confirmation_token:completed},owner)).toEqual(receipt);
      const request={tenant_id:'fixture',confirmation_token:token,approved:true,review_answer:'3'};
      const saved=await confirmProposedMemory(env,request,owner);
      expect(saved.saved).toBe(true);expect(await confirmProposedMemory(env,request,owner)).toEqual(saved);
    } finally {sql.close();}
  });

  it('retains legacy unguarded review compatibility and requires a guard after explicit revision', async () => {
    const { env,sql }=fixture();try {
      const old=await proposeMemoryWithRationale(env,{ tenant_id:'fixture',actor_id:owner,item:{ content:'Legacy synthetic review',project_id:'workflow-fixture' },
        review_context:{candidate_id:'legacy',candidate_hash:'b'.repeat(64),source_references:[],conclusion:'Legacy synthetic review',reason_summary:'Keep old payload intact'} });
      const saved=await confirmProposedMemory(env,{tenant_id:'fixture',confirmation_token:old.confirmation_token,approved:true,review_answer:'3'},owner);
      expect(saved.saved).toBe(true);
      const pending=await proposeMemoryWithRationale(env,{ tenant_id:'fixture',actor_id:owner,item:{content:'Legacy pending',project_id:'workflow-fixture'} });
      const status=await getMemoryConfirmationStatus(env,{tenant_id:'fixture',confirmation_token:pending.confirmation_token},owner);
      const next=await stage(env,nextEvent('legacy-revised'),{confirmationToken:pending.confirmation_token,expectedCandidateHash:status.candidate_hash,expectedRevision:status.revision});
      expect(next.revision).toBe(2);expect(next.confirmation_guard_required).toBe(true);
      await expect(confirmProposedMemory(env,{tenant_id:'fixture',confirmation_token:pending.confirmation_token,approved:true},owner)).rejects.toThrow('superseded');
    } finally {sql.close();}
  });
});
