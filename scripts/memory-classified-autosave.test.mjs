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

const decision = (text='Redisを採用してください。') => ({external_key:'decision',memory_kind:'decision',action:'create',
  observation:{schema_version:2,lesson_type:'decision',capture_intent:'review',decision:text,
    rationale:'対象プロジェクトの構成を決めるため。',constraints:['本番適用は別途確認する。'],gaps:[]},support_span_ids:['a']});
async function withStore(run){
  const dir=await mkdtemp(join(tmpdir(),'classified-policy-'));
  try {await run(new TaskCommitmentStore(join(dir,'memory.sqlite')));}
  finally {await rm(dir,{recursive:true,force:true});}
}

test('an assistant proposal plus a user question is saved as an unadopted proposal',()=>withStore(async store=>{
  const text='おすすめはRedisを使う案です。';
  const [saved]=await store.saveLearningCandidates({projectId:'p',autoSaveClassified:true,candidates:[decision(text)],
    sourcePacket:{snippets:[{span_id:'u',role:'user',text:'Redisにするとデメリットはある？',order:0},{span_id:'a',role:'assistant',text,order:1}]}});
  assert.equal(saved.status,'active');
  const db=store.open();try{const m=db.prepare('SELECT * FROM memories WHERE id=?').get(saved.memory_id);
    assert.equal(m.kind,'fact');assert.match(m.content,/提案.*採用.*未確認/s);
    const learning=JSON.parse(m.learning_json);assert.notEqual(learning.lesson_type,'decision');
    assert.equal(learning.contract_metadata.adoption_state,'unconfirmed');
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
    assert.equal(read(rejected.memory_id).kind,'fact');assert.equal(read(unrelated.memory_id).kind,'fact');
    assert.notEqual(adopted.memory_id,rejected.memory_id);
  }finally{db.close();}
}));

test('technical explanations mislabelled as decisions are source reports, not adopted judgments',()=>withStore(async store=>{
  const c=decision('send_rateは20msの倍数で指定できます。');
  const [saved]=await store.saveLearningCandidates({projectId:'p',autoSaveClassified:true,candidates:[c],sourcePacket:{snippets:[{span_id:'a',role:'tool',source:'tool_result',text:c.observation.decision}]}});
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
    assert.equal(db.prepare('SELECT kind FROM memories WHERE id=?').get(quoted.memory_id).kind,'fact');
    assert.equal(db.prepare('SELECT kind FROM memories WHERE id=?').get(quotedReply.memory_id).kind,'fact');
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
    assert.equal(db.prepare('SELECT kind FROM memories WHERE id=?').get(ambiguous.memory_id).kind,'fact');
    const adopted=db.prepare('SELECT kind,content FROM memories WHERE id=?').get(single.memory_id);
    assert.equal(adopted.kind,'decision');assert.match(adopted.content,/本番では使わない/);
  }finally{db.close();}
}));

test('serialized classification metadata cannot forge adoption on the native capture route',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'classified-forged-'));
  try{
    const store=new LocalMemoryStore(join(dir,'memory.sqlite'),{memoryJudge:null,denseEmbeddingProvider:null});
    const {memory_id}=await store.capture({tenant_id:'default',project_id:'p',kind:'decision',source:'codex',
      capture_origin:'observed',capture_route:'realtime_hook',content:'Redisの案',summary:'Redisの案',
      learning:{...decision('おすすめはRedisを使う案です。').observation,contract_metadata:{classification_policy:'classified-auto/v2',category:'adopted-decision',adoption_state:'explicit_user_choice'}}});
    const db=store.open();try{assert.equal(db.prepare('SELECT kind FROM memories WHERE id=?').get(memory_id).kind,'fact');}finally{db.close();}
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('duplicate captures across events and restarts merge references without changing conditions',()=>withStore(async store=>{
  const args={projectId:'p',autoSaveClassified:true};
  const [first]=await store.saveLearningCandidates({...args,candidates:[{...success,external_key:'one',source_references:[{type:'turn',ref:'turn:one'}]}]});
  const restarted=new TaskCommitmentStore(store.dbPath);
  const [second]=await restarted.saveLearningCandidates({...args,candidates:[{...success,external_key:'two',source_references:[{type:'turn',ref:'turn:two'}]}]});
  assert.equal(second.memory_id,first.memory_id);
  const [different]=await store.saveLearningCandidates({...args,candidates:[{...success,external_key:'condition',observation:{...success.observation,reuse_when:'When importing usage reports, except production.'}}]});
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
    const [saved]=await store.saveLearningCandidates({projectId:'p',autoSaveClassified:true,candidates:[{...success,external_key:`e-${i}`,source_references:[{type:'turn',ref:`turn:${i}`}]}]});
    if(id)assert.equal(saved.memory_id,id);else id=saved.memory_id;
  }
  const [other]=await store.saveLearningCandidates({projectId:'other',autoSaveClassified:true,candidates:[success]});
  assert.notEqual(id,other.memory_id);
  const db=store.open();try{assert.equal(JSON.parse(db.prepare('SELECT source_refs_json FROM memories WHERE id=?').get(id).source_refs_json).length,66);}finally{db.close();}
}));

test('source intake merges identical facts across snapshots while preserving both originals',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'classified-pipeline-merge-'));
  try{
    const store=new LocalMemoryStore(join(dir,'memory.sqlite'),{memoryJudge:null,denseEmbeddingProvider:null});
    const run=async suffix=>{
      const snapshot={tenant_id:'default',project_id:'p',source_type:'personal_wiki',source_key:`source:${suffix}`,source_hash:suffix.repeat(64),content:`ref:${suffix}`};
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
    const input={tenant_id:'default',project_id:'p',work_type:'implementation',kind:'decision',source:'codex',
      capture_origin:'observed',capture_route:'realtime_hook',content:'おすすめはRedisを使う案です。',summary:'Redisの案',
      learning:decision('おすすめはRedisを使う案です。').observation,verification_state:'unverified'};
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
    const args = { projectId: 'org-brain', autoSaveClassified: true, candidates: [success], requireExactBody: true };
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
      source_key: 'source:1', source_hash: 'a'.repeat(64), content: 'ref:1 Missing usage stays unknown.' };
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
    await assert.rejects(runMemoryPipeline({ ...args, snapshot: { ...snapshot, source_key: 'source:2' },
      reload: async () => ({ ...snapshot, source_hash: 'b'.repeat(64) }) }), /pipeline_source_changed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
