import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {rawMessages,segments,resolveSegments,selectCases,boundaryPacket,seal,verify,main} from './memory-utility-v1.mjs';
const row=(message,at='2026-01-01T00:00:00Z',type='user_message')=>({timestamp:at,payload:{type,message,phase:'final_answer'}});
test('raw text, newlines, full long body and distinct proposal/adoption remain intact',()=>{
  const proposal='  提案のみ。採用は未定。\n'+'x'.repeat(9000)+'\n';
  const messages=rawMessages([row(proposal),row(proposal),row('採用した。','2026-01-01T00:01:00Z','agent_message')]);
  assert.equal(messages.length,2);assert.equal(messages[0].text,proposal);
  const spans=segments(messages,'target');
  assert.equal(spans.filter(s=>s.message_id===messages[0].id).map(s=>s.text).join(''),proposal);
  for(const s of spans)assert.equal(messages.find(m=>m.id===s.message_id).text.slice(s.start,s.end),s.text);
  assert.deepEqual(resolveSegments([spans[0].id],spans,'target'),[spans[0]]);
  assert.throws(()=>resolveSegments([spans[0].id+'.fake'],spans,'target'),/unknown_span/);
  assert.throws(()=>resolveSegments(['context:r1b1:1'],segments(messages,'context'),'target'),/target_evidence/);
});
test('boundary excludes subsequent answers, retains first actual task and rejects future evidence',()=>{
  const groups=[{rows:[row('前提')]},{rows:[row('過去の修正','2026-01-02T00:00:00Z','agent_message')]},{rows:[row('次を実装して','2026-01-03T00:00:00Z'),row('未来の正解','2026-01-04T00:00:00Z','agent_message')]}];
  const packet=boundaryPacket(groups,1);
  assert.equal(packet.task.text,'次を実装して');assert.ok(!JSON.stringify(packet).includes('未来の正解'));
  groups[1].rows[0].timestamp='2026-01-03T00:00:00Z';
  assert.throws(()=>boundaryPacket(groups,1),/invalid_time_boundary/);
});
test('selection is seed deterministic, group bounded and independent of labels',()=>{
  const cases=Array.from({length:30},(_,i)=>({id:'case-'+i,group_id:'g'+Math.floor(i/2)}));
  const a=selectCases(cases);
  assert.equal(a.length,10);assert.equal(new Set(a.map(c=>c.group_id)).size,10);
  assert.deepEqual(a.map(c=>c.id),selectCases(cases.reverse().map(c=>({...c,label:Math.random()}))).map(c=>c.id));
});
test('safety fails closed instead of altering source text',()=>{
  assert.throws(()=>boundaryPacket([{rows:[row('連絡先 test@example.com')]},{rows:[row('続けて','2026-01-02T00:00:00Z')]}],0),/unsafe_source/);
});
test('integrity and manifest are mandatory',async()=>{
  const m=seal({status:'pending'});assert.equal(verify(m),m);
  assert.throws(()=>verify({...m,status:'complete'}),/hash_mismatch/);
  await assert.rejects(()=>main(['extract']),/manifest_required/);
});
import {validateC,buildStore,retrieve,reviewPayload,nativeResult,heldJobs} from './memory-utility-stages.mjs';
const item=(id,changes={})=>({id,content:'テスト前に確認する',condition:'次回の修正時',reason:'前回の失敗を避ける',support_ids:['target:r1b1:1'],status:'proposed',storage:'short',storage_reason:'今回の作業用',relation:'create',target_ids:[],...changes});
test('TTL boundary is exclusive, future/inactive/expired records never enter retrieval',()=>{
  const {records}=buildStore([item('i1')],'2026-01-01T00:00:00Z','C','c');
  assert.equal(retrieve('確認',records,'2026-01-30T23:59:59Z').selected_ids.length,1);
  assert.equal(retrieve('確認',records,'2026-01-31T00:00:00Z').selected_ids.length,0);
  assert.equal(retrieve('確認',records,'2026-01-01T00:00:00Z').selected_ids.length,0);
});
test('updates preserve history and conflicts retain both records',()=>{
  const store=buildStore([item('i1'),item('i2',{relation:'update',target_ids:['i1']}),item('i3',{relation:'conflict',target_ids:['i2']})],'2026-01-01T00:00:00Z','C','c');
  assert.equal(store.history.length,1);assert.equal(store.history[0].previous.status,'proposed');
  assert.deepEqual(store.records.map(r=>r.active),[false,true,true]);
  assert.throws(()=>buildStore([item('i1',{relation:'update',target_ids:['other']})],'2026-01-01','C','c'),/target_missing/);
});
test('C requires target grounding, known relationships and supported retention fields',()=>{
  const spans=segments(rawMessages([row('採用は未定です。')]),'target');
  assert.equal(validateC({items:[item('i1')]},spans).items[0].status,'proposed');
  assert.throws(()=>validateC({items:[item('i1',{storage:'long',reason:'',condition:''})]},spans),/long_requires/);
  assert.throws(()=>validateC({items:[item('i1',{relation:'update',target_ids:['invented']})]},spans),/target_id/);
});
test('search is deterministic with id tie breaks and top 5',()=>{
  const records=Array.from({length:9},(_,i)=>({...buildStore([item('i1')],'2026-01-01','C','case-'+i).records[0],storage:'long',expires_at:null}));
  const a=retrieve('確認',records,'2026-01-02');
  assert.deepEqual(a,retrieve('確認',[...records].reverse(),'2026-01-02'));assert.equal(a.selected_ids.length,5);
});
test('blinded review contains only task and independently shuffled response text',()=>{
  const cases=[{id:'x',task:{text:'タスク'},secret:'forbidden'}];
  const output=reviewPayload('test',cases,{x:{A:{answer:'no memory',score:3},B:{answer:'baseline',score:4},C:{answer:'units',score:5}}});
  assert.deepEqual(Object.keys(output.cases[0]),['id','task','answers']);
  assert.ok(!JSON.stringify(output).includes('score'));assert.ok(!JSON.stringify(output).includes('forbidden'));
  assert.deepEqual(output,reviewPayload('test',cases,{x:{A:{answer:'no memory'},B:{answer:'baseline'},C:{answer:'units'}}}));
});
test('native runtime cannot be substituted by fabricated metadata',()=>{
  assert.throws(()=>nativeResult('/path-that-does-not-exist','/root/fake'));
});
test('held initial results are identified independently from accepted results',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'memory-utility-held-'));
  fs.writeFileSync(path.join(root,'initial-extract-c-case-a.json'),'{}');
  fs.writeFileSync(path.join(root,'initial-extract-b-case-b.json'),'{}');
  fs.writeFileSync(path.join(root,'accepted-extract-b-case-b.json'),'{}');
  assert.deepEqual(heldJobs(root),['extract-c-case-a']);
});
import {frozenV2Candidates} from './memory-utility-v2-adapter.mjs';
test('different observed occurrences are retained even when text repeats',()=>{
  assert.equal(rawMessages([row('同じ確認'),row('同じ確認','2026-01-02T00:00:00Z')]).length,2);
});
test('baseline uses the frozen verifier including unresolved/ungrounded rejection',async()=>{
  const packet={schema:'learning-extraction-proposal/v2',snippets:[{span_id:'s1.1',role:'user',text:'必ずテストする。'}],events:[]};
  const r=await frozenV2Candidates({packet,run_id:'test',project_id:null},[{lesson_type:'decision',support_span_ids:['fake'],gaps:[],fields:[]}]);
  assert.equal(r.candidates.length,0);assert.deepEqual(r.rejections[0].reason_codes,['support_id_unresolved']);
  const skipped=await frozenV2Candidates({packet,run_id:'test'},[{lesson_type:'decision',support_span_ids:['s1.1'],gaps:[],fields:[{name:'action',values:['skip']}]}]);
  assert.deepEqual(skipped.rejections[0].reason_codes,['provider_skip']);
});
