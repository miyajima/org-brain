import {describe, it, expect} from 'vitest';
import {extractDurableMemoryDrafts} from '../src/memory-capture-v2-runtime.mjs';
const extract = (text: string) => extractDurableMemoryDrafts({event_id:'retention',tenant_id:'default',project_id:'org-brain',source:'codex',occurred_at:1786000000000,text});

describe('rule extraction support retention', () => {
  it('keeps multiple scoped reasons and all explicit exceptions in the same lesson', () => {
    const result = extract([
      'We will use the canonical database API for all shared reads.',
      'Reason: Existing clients depend on this contract.',
      'Reason: Deployment checks exercise the same implementation.',
      'Reuse: When the same contract is still supported.',
      'Exception: Never apply the rule to archived installations.',
      'Exception: Only use a local fallback during an outage.',
      'Evidence: docs/SPEC.md',
      '# Separate section',
      'The deployment tool must require a fresh approval for public changes.',
      'Reason: Public changes require a separate decision.'
    ].join('\n'));
    const draft = result.drafts.find((d: any) => d.content.includes('canonical database API'));
    expect(draft.rationale).toContain('Existing clients depend on this contract.');
    expect(draft.rationale).toContain('Deployment checks exercise the same implementation.');
    expect(draft.reuse_rule).toContain('Never apply the rule to archived installations.');
    expect(draft.reuse_rule).toContain('Only use a local fallback during an outage.');
    expect(draft.evidence).toContainEqual({type:'file',ref:'docs/SPEC.md'});
    expect(draft.rationale).not.toContain('Public changes require');
  });
  it('does not separate a Japanese limiting exception into an unconditional lesson', () => {
    const result = extract('共有サービスの接続方式はJSON APIを採用する。\n理由: 既存クライアントとの互換性を維持するため。\nただし障害時のみローカルに切り替え、本番では自動切替は禁止する。\n適用条件: 同じ互換契約が継続している場合。');
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0].reuse_rule).toContain('本番では自動切替は禁止する');
    expect(result.drafts[0].reuse_rule).toContain('同じ互換契約が継続している場合');
  });

  it('retains a scoped test report without turning it into command evidence', () => {
    const result = extract('We decided to use the stable API for shared database reads.\nReason: Existing clients depend on the contract.\nVerification: 27 passed; 2 skipped; production remains unverified.\nReuse: When the same contract applies.\nEvidence: docs/SPEC.md');
    expect(result.drafts[0].reported_verification).toEqual({state:'unverified',text:'Verification: 27 passed; 2 skipped; production remains unverified.'});
    expect(result.drafts[0].evidence.some((e:any)=>e.type==='command')).toBe(false);
  });

  it('retains both structured conditions and exceptions alongside a reuse section', () => {
    const result = extract([
      '## Conclusion','We decided to use the canonical API for shared database reads.',
      '## Reason','Existing clients depend on the stable contract.',
      '## Reuse','When the same API contract applies.',
      '## Conditions','Only use the compatible schema version.',
      '## Exceptions','Never apply this rule to archived installations.',
      '## Result','27 passed; 2 skipped; production remains unverified.'
    ].join('\n'));
    expect(result.drafts[0].reuse_rule).toContain('Only use the compatible schema version.');
    expect(result.drafts[0].reuse_rule).toContain('Never apply this rule to archived installations.');
    expect(result.drafts[0].reported_verification.text).toContain('2 skipped');
  });
});
