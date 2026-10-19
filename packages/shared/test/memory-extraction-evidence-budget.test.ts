import {createHash} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {buildCoverageEvidenceGroups,packCoverageGroups,buildMemoryExtractionPrompt,memoryExtractionProviderInputUpperBound,verifiedCandidates} from '../src/memory-extraction-provider-contract';
const hash=(s:string)=>`sha256:${createHash('sha256').update(s).digest('hex')}`;
const upper=(p:any)=>memoryExtractionProviderInputUpperBound(buildMemoryExtractionPrompt(p));

describe('complete evidence within the unchanged input ceiling',()=>{
  it.each(['coverage','refined'])('rejects duplicate field names before %s attribution and normalization',async(profile)=>{
    const snippets=[{span_id:'u',role:'user',text:'PostgreSQLを選ぶ。人の理由。'},
      {span_id:'a',role:'assistant',text:'AIの理由。'}];
    const packet={schema:'learning-extraction-proposal/v2',snippets,events:[],
      ...(profile==='coverage'?{extraction_profile:'coverage/v1'}:{refinement_profile:'a-plus/v1'})};
    const result=await verifiedCandidates({packet,project_id:'example',run_id:'duplicates'},[{
      lesson_type:'decision',support_span_ids:['u','a'],gaps:[],fields:[
        {name:'decision',values:['PostgreSQLを選ぶ。']},
        {name:'rationale',values:['AIの理由。']},{name:'rationale',values:['人の理由。']}]
    }]);
    expect(result.candidates).toHaveLength(0);
    expect(result.rejections[0].reason_codes).toContain('duplicate_field_name');
  });
  it.each(['rationale','reason_rejected','applicability','reuse_when','constraint'])(
    'rejects assistant-only %s and requires grounded human content to survive normalization',async(field)=>{
      const snippets=[{span_id:'u',role:'user',text:'PostgreSQLを選ぶ。'},
        {span_id:'a',role:'assistant',text:'保存費用が安いため。'}];
      const candidate={lesson_type:'decision',support_span_ids:['u','a'],gaps:[],fields:[
        {name:'decision',values:[snippets[0].text]},{name:field,values:[snippets[1].text]}]};
      const run=(rows:typeof snippets)=>verifiedCandidates({packet:{schema:'learning-extraction-proposal/v2',extraction_profile:'coverage/v1',snippets:rows,events:[]},
        extraction_profile:'coverage/v1',project_id:'example',run_id:'attribution'},[candidate]);
      expect((await run(snippets)).candidates).toHaveLength(0);
      const human = await run([snippets[0],{...snippets[1],role:'user'}]);
      if (['rationale', 'reuse_when'].includes(field)) {
        expect(human.candidates).toHaveLength(1);
        expect(human.candidates[0].observation[field]).toBe(snippets[1].text);
      } else {
        // Grounding is necessary, but an unsupported field or orphaned
        // reason_rejected must not be accepted and silently discarded.
        expect(human.candidates).toHaveLength(0);
        expect(human.rejections[0].reason_codes).toContain('normalized_field_not_retained');
      }
    });
  it('packs the selected result and its event without unrelated executions consuming the budget',()=>{
    const snippets=[{span_id:'t',role:'tool',source:'tool_result',call_id:'selected',text:'contract passed',text_hash:hash('contract passed')}];
    const events=[{event_id:'e',call_id:'selected',status:'completed',exit_code:0},...Array.from({length:23},(_,i)=>({event_id:`other${i}`,call_id:`other-call-${i}`,status:'completed',exit_code:0}))];
    const groups=buildCoverageEvidenceGroups(snippets,events,{hash_text:hash});
    const packed=packCoverageGroups({schema:'learning-extraction-proposal/v2',extraction_profile:'coverage/v1',events,snippets:[]},groups,{upper_bound:upper});
    expect(packed.packet.snippets).toHaveLength(1);
    expect(packed.packet.events).toEqual([events[0]]);
    expect(packed.upper_bound).toBeLessThanOrEqual(2000);
    expect(packed.diagnostics.omitted_group_count).toBe(0);
  });
  it('keeps one recovery chain atomic across tool/user/tool parents only for the same operation',()=>{
    const snippets=[
      {span_id:'t1',role:'tool',source:'tool_result',call_id:'failed',source_order:1,text:'contract failed.'},
      {span_id:'u',role:'user',source_order:2,text:'訂正して設定を修正する。'},
      {span_id:'t2',role:'tool',source:'tool_result',call_id:'checked',source_order:3,text:'contract passed.'}
    ];
    const events=[{call_id:'failed',status:'failed',name:'exec_command',argument_hash:'same-operation'},
      {call_id:'checked',status:'completed',exit_code:0,name:'exec_command',argument_hash:'same-operation'}];
    const groups=buildCoverageEvidenceGroups(snippets,events,{hash_text:hash});
    expect(groups).toHaveLength(1);
    expect(groups[0].parent_span_ids).toEqual(['t1','u','t2']);
    const packed=packCoverageGroups({},groups,{max_snippets:2,upper_bound:()=>100});
    expect(packed.packet.snippets).toEqual([]);
    expect(packed.omitted[0].reason).toBe('input_budget');
    const unrelated=buildCoverageEvidenceGroups(snippets,[events[0],{...events[1],argument_hash:'other-operation'}]);
    expect(unrelated.some(g=>g.parent_span_ids.includes('t1')&&g.parent_span_ids.includes('t2'))).toBe(false);
  });
  it('keeps consecutive explicit human reasons and exceptions with the decision',()=>{
    const groups=buildCoverageEvidenceGroups([
      {span_id:'u1',role:'user',text:'APIを採用する。'},
      {span_id:'u2',role:'user',text:'理由は再試行を制限できるため。'},
      {span_id:'u3',role:'user',text:'ただし復旧中は使わない。'}
    ],[],{hash_text:hash});
    expect(groups).toHaveLength(1);
    expect(groups[0].parent_span_ids).toEqual(['u1','u2','u3']);
    const independent=buildCoverageEvidenceGroups([{span_id:'u1',role:'user',text:'APIを採用する。'},
      {span_id:'a',role:'assistant',text:'理由は高速なため。'}]);
    expect(independent).toHaveLength(2);
  });
  it('keeps exact reasons and reuse conditions through grounding and normalization',async()=>{
    const snippets=[{span_id:'p',role:'assistant',text:'Use bounded retries.'},{span_id:'w',role:'assistant',text:'Because the endpoint is idempotent.'},
      {span_id:'r',role:'user',text:'When the same endpoint times out.'},
      {span_id:'t',role:'tool',source:'tool_result',call_id:'checked',text:'contract passed'}];
    const packet={schema:'learning-extraction-proposal/v2',extraction_profile:'coverage/v1',snippets,events:[{event_id:'e',call_id:'checked',status:'completed',exit_code:0}]};
    const result=await verifiedCandidates({packet,extraction_profile:'coverage/v1',project_id:'example',run_id:'bounded'},[{
      lesson_type:'success',support_span_ids:snippets.map(s=>s.span_id),gaps:[],fields:[
        {name:'procedure',values:[snippets[0].text]},{name:'why_it_worked',values:[snippets[1].text]},
        {name:'reuse_when',values:[snippets[2].text]},{name:'observed_outcome',values:[snippets[3].text]}]
    }]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].observation.why_it_worked).toBe(snippets[1].text);
    expect(result.candidates[0].observation.reuse_when).toBe(snippets[2].text);
    expect(result.candidates[0].observation.capture_intent).toBe('review');
  });
});
