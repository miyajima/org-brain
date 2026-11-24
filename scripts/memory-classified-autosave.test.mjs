import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskCommitmentStore } from '../packages/orgbrain-cli/src/lib/task-commitment-store.mjs';
import { LocalMemoryStore } from '../packages/orgbrain-cli/src/lib/local-memory-store.mjs';
import { runMemoryPipeline } from '../packages/orgbrain-cli/src/lib/memory-pipeline.mjs';

const success = {
  external_key: 'classified-success', memory_kind: 'fact', action: 'create',
  observation: { schema_version: 2, lesson_type: 'success', capture_intent: 'review',
    procedure: 'Preserve missing usage as unknown.', why_it_worked: 'Missing usage has no measured value.',
    observed_outcome: null, reuse_when: 'When importing usage reports.',
    reported_verification: { state: 'unverified', text: 'The parser check was reported to pass.' },
    gaps: ['llm_proposed_review_only'] },
  support_span_ids: ['span:1']
};
const originalSuccess = (reuse = success.observation.reuse_when) => ({ snippets:[{ span_id:'span:1',role:'assistant',
  text:`${success.observation.procedure} ${reuse}` }] });

const decision = (text='Redisを採用してください。') => ({external_key:'decision',memory_kind:'decision',action:'create',
  observation:{schema_version:2,lesson_type:'decision',capture_intent:'review',decision:text,
    constraints:[],gaps:[]},support_span_ids:['a']});
async function withStore(run){
  const dir=await mkdtemp(join(tmpdir(),'classified-policy-'));
  try {await run(new TaskCommitmentStore(join(dir,'memory.sqlite')));}
  finally {await rm(dir,{recursive:true,force:true});}
}

test('an assistant proposal plus a user question never enters long-term memory',()=>withStore(async store=>{
  const text='おすすめはRedisを使う案です。';
  const [saved]=await store.saveLearningCandidates({projectId:'p',autoSaveClassified:true,candidates:[decision(text)],
    sourcePacket:{snippets:[{span_id:'u',role:'user',text:'Redisにするとデメリットはある？',order:0},{span_id:'a',role:'assistant',text,order:1}]}});
  assert.equal(saved.reason_code,'proposal_without_adoption');
  const db=store.open();try{
    assert.equal(db.prepare('SELECT COUNT(*) n FROM memories').get().n,0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM memory_learning_candidates').get().n,0);
  }finally{db.close();}
}));

test('a direct user choice is retained as a decision with the original user reference',()=>withStore(async store=>{
  const c=decision();c.support_span_ids=['u'];
  const [saved]=await store.saveLearningCandidates({projectId:'p',autoSaveClassified:true,candidates:[c],
    sourcePacket:{snippets:[{span_id:'u',role:'user',text:c.observation.decision,source:'user',order:0}]}});
  const db=store.open();try{const m=db.prepare('SELECT * FROM memories WHERE id=?').get(saved.memory_id);
    assert.equal(m.kind,'decision');assert.equal(JSON.parse(m.learning_json).contract_metadata.adoption_state,'explicit_user_choice');
    assert.equal(m.verification_state,'unverified');
  }finally{db.close();}
}));

test('an explicit choice never attests added applicability or exceptions',()=>withStore(async store=>{
  const c=decision('青磁便は青い札を使ってください。');
  const sourcePacket={snippets:[{span_id:'a',role:'user',text:c.observation.decision}]};
  const [fake,valid]=await store.saveLearningCandidates({projectId:'p',autoSaveClassified:true,sourcePacket,candidates:[
    {...c,external_key:'extended',observation:{...c.observation,reuse_when:'すべての支店と国外便にも適用する。',constraints:['経費承認は不要。']}},c]});
  assert.equal(fake.status,'quarantine');
  assert.equal(valid.status,'active');
}));

test('deictic adoption needs the matching preceding proposal; a rejection or unrelated approval never adopts it',()=>withStore(async store=>{
  const text='構造を保った本文を渡す案です。';
  const snippets=[{span_id:'a',role:'assistant',text,order:0},{span_id:'u',role:'user',text:'その案で実装して。',order:1}];
  const [adopted]=await store.saveLearningCandidates({projectId:'p',autoSaveClassified:true,candidates:[decision(text)],sourcePacket:{snippets}});
  const [rejected]=await store.saveLearningCandidates({projectId:'p',autoSaveClassified:true,candidates:[{...decision(text),external_key:'rejected'}],sourcePacket:{snippets:[snippets[0],{...snippets[1],text:'その案は採用しない。'}]}});
  const [unrelated]=await store.saveLearningCandidates({projectId:'p',autoSaveClassified:true,candidates:[{...decision(text),external_key:'unrelated'}],sourcePacket:{snippets:[snippets[0],{span_id:'b',role:'assistant',text:'別のバックアップ案です。',order:1},{...snippets[1],order:2}]}});
  const db=store.open();try{
    const read=id=>db.prepare('SELECT * FROM memories WHERE id=?').get(id);
    assert.equal(read(adopted.memory_id).kind,'decision');
    assert.ok(JSON.parse(read(adopted.memory_id).source_refs_json).some(r=>r.ref.includes('u')));
    assert.equal(rejected.reason_code,'proposal_without_adoption');
    assert.equal(unrelated.reason_code,'proposal_without_adoption');
  }finally{db.close();}
}));

test('technical explanations mislabelled as decisions are source reports, not adopted judgments',()=>withStore(async store=>{
  const c=decision('send_rateは20msの倍数で指定できます。');
  c.observation.reuse_when='send_rateで送信間隔を指定する場合。';
  c.observation.constraints = [];
  const [saved]=await store.saveLearningCandidates({projectId:'p',autoSaveClassified:true,candidates:[c],sourcePacket:{snippets:[{span_id:'a',role:'tool',source:'tool_result',text:`${c.observation.decision} ${c.observation.reuse_when}`}]}});
  const db=store.open();try{const m=db.prepare('SELECT * FROM memories WHERE id=?').get(saved.memory_id);
    assert.equal(m.kind,'fact');assert.equal(JSON.parse(m.learning_json).contract_metadata.adoption_state,'not_asserted');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM memory_learning_candidates').get().n,0);
  }finally{db.close();}
}));

test('quoted instructions never become a user choice, and conditional acceptance retains the condition',()=>withStore(async store=>{
  const text='構造を保った本文を渡す案です。';
  const [quoted]=await store.saveLearningCandidates({projectId:'p',autoSaveClassified:true,candidates:[decision('Redisを採用してください。')],sourcePacket:{snippets:[{span_id:'u',role:'user',text:'資料には「Redisを採用してください。」と書かれている。'}]}});
  const [conditional]=await store.saveLearningCandidates({projectId:'p',autoSaveClassified:true,candidates:[{...decision(text),external_key:'conditional'}],sourcePacket:{snippets:[{span_id:'a',role:'assistant',text,order:0},{span_id:'u',role:'user',text:'その案で進めて。ただし本番には使わない。',order:1}]}});
  const [quotedReply]=await store.saveLearningCandidates({projectId:'p',autoSaveClassified:true,candidates:[{...decision(text),external_key:'quoted-reply'}],sourcePacket:{snippets:[{span_id:'a',role:'assistant',text,order:0},{span_id:'u',role:'user',text:'資料には「その案で進めて」と記載されている。',order:1}]}});
  const db=store.open();try{
    assert.equal(quoted.status,'quarantine');
    assert.equal(quotedReply.reason_code,'proposal_without_adoption');
    assert.match(db.prepare('SELECT content FROM memories WHERE id=?').get(conditional.memory_id).content,/本番には使わない/);
  }finally{db.close();}
}));

test('ambiguous approval of multiple options does not adopt both, and proposal exceptions survive approval',()=>withStore(async store=>{
  const claim='Redisを使う案です。';
  const run=async(key,text)=>store.saveLearningCandidates({projectId:'p',autoSaveClassified:true,
    candidates:[{...decision(claim),external_key:key}],sourcePacket:{snippets:[{span_id:'a',role:'assistant',text,order:0},{span_id:'u',role:'user',text:'その案で進めて。',order:1}]}});
  const [ambiguous]=await run('multiple',`A案は${claim}B案はSQLiteを使う案です。`);
  const [single]=await run('single',`${claim}ただし本番では使わない条件です。`);
  const db=store.open();try{
    assert.equal(ambiguous.reason_code,'proposal_without_adoption');
    const adopted=db.prepare('SELECT kind,content FROM memories WHERE id=?').get(single.memory_id);
    assert.equal(adopted.kind,'decision');assert.match(adopted.content,/本番では使わない/);
  }finally{db.close();}
}));

test('serialized classification metadata cannot forge adoption on the native capture route',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'classified-forged-'));
  try{
    const store=new LocalMemoryStore(join(dir,'memory.sqlite'),{memoryJudge:null,denseEmbeddingProvider:null});
    await assert.rejects(store.capture({tenant_id:'default',project_id:'p',kind:'decision',source:'question-answer',
      capture_origin:'observed',capture_route:'realtime_hook',content:'Redisの案',summary:'Redisの案',
      verification_state:'verified',
      learning:{...decision('おすすめはRedisを使う案です。').observation,contract_metadata:{classification_policy:'classified-auto/v2',category:'adopted-decision',adoption_state:'explicit_user_choice'}}}), /proposal_without_adoption/u);
    assert.equal((await store.search({tenant_id:'default',project_id:'p',query:'Redis'})).length,0);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('automatic capture requires an original and concrete reuse conditions', ()=>withStore(async store=>{
  const primary = 'When importing a usage record, preserve omitted totals as unknown.';
  const base = { ...success, observation: { ...success.observation, procedure: primary } };
  const packet = { snippets: [{ span_id: 'span:1', role: 'assistant', text: `${primary} ${success.observation.reuse_when}` }] };
  const [unanchored] = await store.saveLearningCandidates({ projectId: 'p', autoSaveClassified: true,
    candidates: [{ ...base, external_key: 'unanchored', source_references:[{type:'turn',ref:'unknown-source'}], support_span_ids: [] }] });
  const [underspecified, invented, ready] = await store.saveLearningCandidates({ projectId: 'p', autoSaveClassified: true, sourcePacket: packet,
    candidates: [{ ...base, external_key: 'underspecified', observation: { ...base.observation,
      procedure: 'Import the data.', reuse_when: null }, support_span_ids: [] },
      { ...base, external_key:'invented',observation:{...base.observation,reuse_when:'When publishing an archived invoice from another project.'} },
      { ...base, external_key: 'ready' }] });
  assert.equal(unanchored.status, 'quarantine');
  assert.equal(underspecified.status, 'quarantine');
  assert.equal(invented.status, 'quarantine');
  assert.equal(ready.status, 'active');
  let evaluated = 0;
  await store.maintainLearningCandidates({evaluate: async () => { evaluated++; }});
  assert.equal(evaluated, 0);
  const expired = Date.now() + 8 * 86_400_000;
  await store.maintainLearningCandidates({now: expired});
  await store.saveLearningCandidates({projectId:'p',autoSaveClassified:true,candidates:[{...base,external_key:'unanchored',support_span_ids:[]}]});
  const db = store.open({ readOnly: true });
  try {
    assert.equal(db.prepare('SELECT project_id FROM memories WHERE id=?').get(ready.memory_id).project_id, 'p');
    assert.equal(db.prepare('SELECT count(*) n FROM memories_fts WHERE memory_id=?').get(ready.memory_id).n, 1);
    assert.deepEqual(JSON.parse(db.prepare('SELECT payload_json FROM memory_learning_candidates WHERE id=?').get(unanchored.id).payload_json),{evidence_pending:true});
  } finally { db.close(); }
  const [grounded] = await store.saveLearningCandidates({projectId:'p',autoSaveClassified:true,sourcePacket:packet,candidates:[{...base,external_key:'unanchored'}]});
  assert.equal(grounded.memory_id, ready.memory_id);
}));

test('duplicate captures across events and restarts merge references without changing conditions',()=>withStore(async store=>{
  const args={projectId:'p',autoSaveClassified:true,sourcePacket:originalSuccess()};
  const [first]=await store.saveLearningCandidates({...args,candidates:[{...success,external_key:'one',source_references:[{type:'turn',ref:'turn:one'}]}]});
  const restarted=new TaskCommitmentStore(store.dbPath);
  const [second]=await restarted.saveLearningCandidates({...args,candidates:[{...success,external_key:'two',source_references:[{type:'turn',ref:'turn:two'}]}]});
  assert.equal(second.memory_id,first.memory_id);
  const alternate = 'When importing usage reports, except production.';
  const [different]=await store.saveLearningCandidates({...args,sourcePacket:originalSuccess(alternate),candidates:[{...success,external_key:'condition',source_references:[{type:'turn',ref:'turn:condition'}],observation:{...success.observation,reuse_when:alternate}}]});
  assert.equal(different.status,'active');
  assert.notEqual(different.memory_id,first.memory_id);
  const db=store.open();try{const m=db.prepare('SELECT * FROM memories WHERE id=?').get(first.memory_id);
    assert.deepEqual(JSON.parse(m.source_refs_json).map(s=>s.ref).sort(),['turn:one','turn:two']);
    assert.equal(m.verification_state,'unverified');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM memories').get().n,2);
  }finally{db.close();}
}));

test('more than 64 duplicate source references are retained, and project scope stays separate',()=>withStore(async store=>{
  let id;
  for(let i=0;i<66;i++){
    const [saved]=await store.saveLearningCandidates({projectId:'p',autoSaveClassified:true,sourcePacket:originalSuccess(),candidates:[{...success,external_key:`e-${i}`,source_references:[{type:'turn',ref:`turn:${i}`}]}]});
    if(id)assert.equal(saved.memory_id,id);else id=saved.memory_id;
  }
  const [other]=await store.saveLearningCandidates({projectId:'other',autoSaveClassified:true,sourcePacket:originalSuccess(),candidates:[{...success,source_references:[{type:'turn',ref:'turn:other'}]}]});
  assert.equal(other.status,'active');
  assert.notEqual(id,other.memory_id);
  const db=store.open();try{assert.equal(JSON.parse(db.prepare('SELECT source_refs_json FROM memories WHERE id=?').get(id).source_refs_json).length,66);}finally{db.close();}
}));

test('source intake merges identical facts across snapshots while preserving both originals',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'classified-pipeline-merge-'));
  try{
    const store=new LocalMemoryStore(join(dir,'memory.sqlite'),{memoryJudge:null,denseEmbeddingProvider:null});
    const run=async suffix=>{
      const snapshot={tenant_id:'default',project_id:'p',source_type:'personal_wiki',source_key:`source:${suffix}`,source_hash:suffix.repeat(64),
        sources:[{ref:`ref:${suffix}`,text:'Missing usage stays unknown. For usage import only.'}]};
      return runMemoryPipeline({store,snapshot,autoSaveClassified:true,reload:async()=>snapshot,
        extract:async()=>({candidate:{kind:'fact',content:'Missing usage stays unknown.',rationale:'No measurement is available.',reuse_rule:'For usage import only.',support_refs:[`ref:${suffix}`]}})});
    };
    const first=await run('a'),second=await run('b');assert.equal(second.memory_id,first.memory_id);
    const db=store.open();try{
      assert.equal(db.prepare('SELECT COUNT(*) n FROM memories').get().n,1);
      assert.equal(JSON.parse(db.prepare('SELECT source_refs_json FROM memories').get().source_refs_json).length,2);
    }finally{db.close();}
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('native realtime captures also distinguish proposals and merge duplicate provenance',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'classified-native-'));
  try{
    const store=new LocalMemoryStore(join(dir,'memory.sqlite'),{memoryJudge:null,denseEmbeddingProvider:null});
    const input={tenant_id:'default',project_id:'p',work_type:'implementation',kind:'fact',source:'codex',
      capture_origin:'observed',capture_route:'realtime_hook',content:success.observation.procedure,summary:'Usage import',
      learning:success.observation,verification_state:'verified',verified_at:Date.now(),
      evidence:[{type:'file',ref:'usage-import.mjs',attestation_ref:'transcript:unchanged_file',content_hash:'a'.repeat(64)}]};
    await assert.rejects(store.capture({...input,kind:'decision',learning:decision('おすすめはRedisを使う案です。').observation}),/proposal_without_adoption/u);
    const a=await store.capture({...input,external_key:'a',source_references:[{type:'turn',ref:'a'}]});
    const b=await store.capture({...input,external_key:'b',source_references:[{type:'turn',ref:'b'}]});
    assert.equal(a.memory_id,b.memory_id);
    const db=store.open();try{const m=db.prepare('SELECT * FROM memories').get();assert.equal(m.kind,'fact');assert.equal(JSON.parse(m.source_refs_json).length,2);}finally{db.close();}
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('clear classification saves immediately, preserves unverified evidence, and is idempotent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'classified-save-'));
  try {
    const store = new TaskCommitmentStore(join(dir, 'memory.sqlite'));
    const args = { projectId: 'org-brain', autoSaveClassified: true, candidates: [success], requireExactBody: true,
      sourcePacket: originalSuccess() };
    const [saved] = await store.saveLearningCandidates(args);
    assert.equal(saved.status, 'active');
    const db = store.open();
    try {
      const row = db.prepare('SELECT * FROM memories WHERE id=?').get(saved.memory_id);
      assert.equal(row.kind, 'fact');
      assert.equal(row.lifecycle_state, 'active');
      assert.equal(row.verification_state, 'unverified');
      assert.equal(row.verified_at, null);
      assert.match(row.content, /parser check/);
      assert.equal(JSON.parse(row.learning_json).observed_outcome, null);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM memory_learning_candidates').get().n, 0);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM memories_fts').get().n, 1);
    } finally { db.close(); }
    assert.equal((await store.saveLearningCandidates(args))[0].memory_id, saved.memory_id);
    const reopened = store.open();
    try { assert.equal(reopened.prepare('SELECT COUNT(*) n FROM memories').get().n, 1); }
    finally { reopened.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('only unclear or conflicting classification stays in review', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'classified-review-'));
  try {
    const store = new TaskCommitmentStore(join(dir, 'memory.sqlite'));
    const saved = await store.saveLearningCandidates({ projectId: 'org-brain', autoSaveClassified: true, candidates: [
      { ...success, external_key: 'conflicting-kind', memory_kind: 'pitfall' },
      { ...success, external_key: 'ambiguous', gaps: ['classification_ambiguous'] },
      { external_key: 'unknown', observation: { lesson_type: 'unknown', procedure: 'Something happened.' } }
    ] });
    assert.deepEqual(saved.map(s => s.status), ['quarantine', 'quarantine', 'quarantine']);
    const [missing]=await store.saveLearningCandidates({projectId:'org-brain',autoSaveClassified:true,candidates:[decision('未確認')]});
    assert.equal(missing.status,'quarantine');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('automatic saving rejects secrets without changing the original body', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'classified-sensitive-'));
  try {
    const store = new TaskCommitmentStore(join(dir, 'memory.sqlite'));
    const [saved] = await store.saveLearningCandidates({ projectId: 'org-brain', autoSaveClassified: true, requireExactBody: true,
      candidates: [{ ...success, observation: { ...success.observation, procedure: 'Contact person@example.com.' } }] });
    assert.equal(saved.status, 'held');
    const db = store.open();
    try { assert.equal(db.prepare('SELECT COUNT(*) n FROM memories').get().n, 0); }
    finally { db.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('source intake skips model review for a clear kind and still checks source drift', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'classified-source-'));
  try {
    const store = new LocalMemoryStore(join(dir, 'memory.sqlite'), { memoryJudge: null, denseEmbeddingProvider: null });
    const snapshot = { tenant_id: 'default', project_id: 'org-brain', source_type: 'personal_wiki',
      source_key: 'source:1', source_hash: 'a'.repeat(64), sources:[{ref:'ref:1',text:'Missing usage stays unknown. When reading usage reports.'}] };
    const args = { store, snapshot, autoSaveClassified: true,
      extract: async () => ({ candidate: { kind: 'fact', content: 'Missing usage stays unknown.',
        rationale: 'No value was measured.', reuse_rule: 'When reading usage reports.', support_refs: ['ref:1'] } }),
      review: async () => { throw Error('review must not run'); }, reload: async () => snapshot };
    const saved = await runMemoryPipeline(args);
    assert.equal(saved.status, 'active');
    const db = store.open();
    try { assert.equal(db.prepare('SELECT verification_state FROM memories WHERE id=?').get(saved.memory_id).verification_state, 'unverified'); }
    finally { db.close(); }
    const ambiguous = await runMemoryPipeline({ ...args, snapshot: { ...snapshot, source_key: 'source:ambiguous' },
      extract: async () => ({ candidate: { kind: null } }) });
    assert.equal(ambiguous.status, 'reviewing');
    assert.equal(ambiguous.reason_code, 'classification_ambiguous');
    const changedScope = {...snapshot,source_key:'source:changed-scope'};
    await assert.rejects(runMemoryPipeline({...args,snapshot:changedScope,reload:async()=>changedScope,
      extract:async()=>({candidate:{...(await args.extract()).candidate,reuse_rule:'Apply this rule to invoice payments.'}})}), /original_evidence_required/u);
    await assert.rejects(runMemoryPipeline({ ...args, snapshot: { ...snapshot, source_key: 'source:2' },
      reload: async () => ({ ...snapshot, source_hash: 'b'.repeat(64) }) }), /pipeline_source_changed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
