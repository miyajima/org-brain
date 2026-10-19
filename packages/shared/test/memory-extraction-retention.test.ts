import { describe, expect, it } from 'vitest';
import { verifiedCandidates } from '../src/memory-extraction-provider-contract';

const verify = (snippets: any[], fields: any[], extra: any = {}, lesson_type = 'success') => verifiedCandidates({
  project_id: 'org-brain', run_id: 'retention-regression', extraction_profile: 'coverage/v1',
  packet: { schema: 'learning-extraction-proposal/v2', snippets, events: [], ...extra }
}, [{ lesson_type, support_span_ids: snippets.map(s => s.span_id), fields, gaps: [] }]);
const field = (name: string, ...values: string[]) => ({ name, values });

describe('normalized extraction retention', () => {
  it('does not accept an exception that disappears during conversion', async () => {
    const snippets = [{ span_id: 's', role: 'user', text: 'APIを採用する。' }, { span_id: 'c', role: 'user', text: 'ただし本番では使わない。' }];
    const dropped = await verify(snippets, [field('decision', snippets[0].text), field('exceptions', snippets[1].text)], {}, 'decision');
    expect(dropped.candidates).toEqual([]);
    expect(dropped.rejections[0].reason_codes).toContain('normalized_qualifier_not_retained');
    const kept = await verify(snippets, [field('decision', snippets[0].text), field('constraints', snippets[1].text)], {}, 'decision');
    expect(kept.candidates[0].observation.constraints).toEqual([snippets[1].text]);
  });

  it('keeps every exact quote supplied for a scalar content field', async () => {
    const snippets = [{ span_id: 'a', role: 'user', text: 'キャッシュを使う。' }, { span_id: 'b', role: 'user', text: '障害時のみ再取得する。' }];
    const result = await verify(snippets, [field('procedure', ...snippets.map(s => s.text))]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].observation.procedure).toBe(snippets.map(s => s.text).join(' '));
  });

  it('requires an explicit source reason to survive, including dependency spans', async () => {
    const snippets = [{ span_id: 'a', role: 'user', text: 'APIを採用する。' }, { span_id: 'r', role: 'user', text: '理由は互換性を維持できるため。' }];
    const missing = await verify(snippets, [field('decision', snippets[0].text)], {}, 'decision');
    expect(missing.candidates).toEqual([]);
    expect(missing.rejections[0].reason_codes).toContain('normalized_reason_not_retained');
    const kept = await verify(snippets, [field('decision', snippets[0].text), field('rationale', snippets[1].text)], {}, 'decision');
    expect(kept.candidates[0].observation.rationale).toBe(snippets[1].text);
  });

  it('rejects a success that drops a cited completed tool result', async () => {
    const snippets = [{ span_id: 'a', role: 'user', text: '検証を実行する。' }, { span_id: 't', role: 'tool', source: 'tool_result', call_id: 'c', text: '27 tests passed; 2 skipped' }];
    const extra = { events: [{ event_id: 'e', call_id: 'c', status: 'completed', exit_code: 0 }] };
    const missing = await verify(snippets, [field('procedure', snippets[0].text)], extra);
    expect(missing.candidates).toEqual([]);
    expect(missing.rejections[0].reason_codes).toContain('normalized_outcome_not_retained');
    const kept = await verify(snippets, [field('procedure', snippets[0].text), field('observed_outcome', snippets[1].text)], extra);
    expect(kept.candidates[0].observation.observed_outcome).toBe(snippets[1].text);
  });

  it('does not accept loss introduced by the final field length limit', async () => {
    const text = `利用条件は${'安全な範囲で'.repeat(210)}、ただし本番は禁止。`;
    const result = await verify([{ span_id: 'a', role: 'user', text }], [field('procedure', '利用条件は'), field('reuse_when', text)]);
    expect(result.candidates).toEqual([]);
  });

  it('protects the ordinary v2 route as well as optional profiles', async () => {
    const packet = {schema:'learning-extraction-proposal/v2',snippets:[{span_id:'a',role:'user',text:'APIを採用する。'},
      {span_id:'r',role:'user',text:'理由は既存契約を維持するため。'}],events:[]};
    const result = await verifiedCandidates({packet,project_id:'org-brain',run_id:'ordinary'}, [{
      lesson_type:'decision',support_span_ids:['a','r'],fields:[field('decision',packet.snippets[0].text)],gaps:['rationale_missing']
    }]);
    expect(result.candidates).toEqual([]);
    expect(result.rejections[0].reason_codes).toContain('normalized_reason_not_retained');
  });

  it('does not treat an assistant report as tool verification on ordinary v2', async () => {
    const packet = {schema:'learning-extraction-proposal/v2',snippets:[{span_id:'a',role:'assistant',source:'assistant',text:'27 tests passed'}],events:[]};
    const result = await verifiedCandidates({packet,project_id:'org-brain',run_id:'reported'}, [{
      lesson_type:'success',support_span_ids:['a'],fields:[field('observed_outcome','27 tests passed')],gaps:[]
    }]);
    expect(result.candidates).toEqual([]);
    expect(result.rejections[0].reason_codes).toContain('verified_tool_outcome_missing');
  });

  it('does not silently drop a reason in an uncited atomic dependency', async () => {
    const packet = {schema:'learning-extraction-proposal/v2',snippets:[{span_id:'a',role:'user',text:'APIを採用する。'},
      {span_id:'r',role:'user',text:'理由は互換性を保つため。'}],events:[],coverage:{groups:[{span_ids:['a','r']}]}};
    const result = await verifiedCandidates({packet,project_id:'org-brain',run_id:'dependency',extraction_profile:'coverage/v1'}, [{
      lesson_type:'decision',support_span_ids:['a'],fields:[field('decision',packet.snippets[0].text)],gaps:[]
    }]);
    expect(result.candidates).toEqual([]);
    expect(result.rejections[0].reason_codes).toContain('normalized_reason_not_retained');
  });
});
