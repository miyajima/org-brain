import { describe, expect, it } from 'vitest';
import { proposeMemoryWithRationale, confirmProposedMemory, getMemoryConfirmationStatus, listMemoryConfirmationReviews } from '../src/rationale-service';

import { memoryD1Fixture as fixture } from './fixtures/memory-d1';

describe('human review persistence', () => {
  it('preserves dated repo references, UUID spans and calendar dates through cloud review', async () => {
    const { sql, env } = fixture();
    try {
      const refs = [{ type: 'conversation', ref: 'repo:org-brain/docs/review-2026-10-03.md',
        span_id: '01a0f285-c310-73da-a4fc-cad36b0bb02f', role: 'user', content_hash: `sha256:${'a'.repeat(64)}` }];
      const proposed = await proposeMemoryWithRationale(env, { tenant_id: 'default', actor_id: 'user:alice',
        item: { content: '2026-10-03 に互換性を確認する', project_id: 'org-brain' },
        review_context: { candidate_id: 'dated-review', candidate_hash: 'b'.repeat(64), source_references: refs,
          conclusion: '2026-10-03 に互換性を確認する', reason_summary: '同日の変更を追跡する', reuse_rule: 'この版のみ' } });
      expect(sql.prepare('SELECT count(*) AS n FROM memories').get().n).toBe(0);
      const receipt = await confirmProposedMemory(env, { tenant_id: 'default', confirmation_token: proposed.confirmation_token,
        approved: true, review_answer: '保存する' }, 'user:alice');
      const memory = sql.prepare('SELECT content, source_refs_json FROM memories WHERE id = ?').get(receipt.memory_id);
      expect(memory.content).toContain('2026-10-03');
      expect(JSON.parse(memory.source_refs_json)).toEqual(refs);
    } finally { sql.close(); }
  });

  it.each(['repo:org-brain/docs/../review.md', 'repo:org-brain/docs/review-2026-02-30.md',
    'repo:org-brain/docs/review-090-1234-5678.md', 'repo:org-brain/docs/review.md?token=value'])
  ('rejects an unsafe review reference without persisting a proposal: %s', async ref => {
    const { sql, env } = fixture();
    try {
      await expect(proposeMemoryWithRationale(env, { tenant_id: 'default', actor_id: 'user:alice',
        item: { content: 'Keep the review bounded', project_id: 'org-brain' },
        review_context: { candidate_id: 'unsafe-review', candidate_hash: 'b'.repeat(64), source_references: [{ ref }],
          conclusion: 'Keep the review bounded', reason_summary: 'Preserve scope' } })).rejects.toThrow();
      expect(sql.prepare('SELECT count(*) AS n FROM memory_confirmations').get().n).toBe(0);
    } finally { sql.close(); }
  });

  it.each([
    { ref: 'https://example.invalid/docs?ｔｏｋｅｎ＝ｆｉｘｔｕｒｅ' },
    { ref: 'repo:org-brain/docs/review.md', role: 'ｐａｓｓｗｏｒｄ＝ｆｉｘｔｕｒｅ' }
  ])('rejects NFKC credentials in review provenance before staging: %j', async source => {
    const { sql, env } = fixture();
    try {
      await expect(proposeMemoryWithRationale(env, { tenant_id: 'default', actor_id: 'user:alice',
        item: { content: 'Keep the review bounded', project_id: 'org-brain' },
        review_context: { candidate_id: 'provenance-screen', candidate_hash: 'd'.repeat(64), source_references: [source],
          conclusion: 'Keep the review bounded', reason_summary: 'Preserve scope' } })).rejects.toThrow();
      expect(sql.prepare('SELECT count(*) AS n FROM memory_confirmations').get().n).toBe(0);
    } finally { sql.close(); }
  });

  it('rejects sensitive corrected prose before claiming the confirmation or writing memory', async () => {
    const { sql, env } = fixture();
    try {
      const proposed = await proposeMemoryWithRationale(env, { tenant_id: 'default', actor_id: 'user:alice',
        item: { content: 'Keep the review bounded', project_id: 'org-brain' },
        review_context: { candidate_id: 'correct-review', candidate_hash: 'b'.repeat(64), source_references: [],
          conclusion: 'Keep the review bounded', reason_summary: 'Preserve scope' } });
      await expect(confirmProposedMemory(env, { tenant_id: 'default', confirmation_token: proposed.confirmation_token,
        approved: true, review_answer: '修正: 保存内容を修正する', corrected_content: 'ｐａｓｓｗｏｒｄ＝synthetic-secret-value' },
      'user:alice')).rejects.toThrow();
      expect(sql.prepare('SELECT count(*) AS n FROM memories').get().n).toBe(0);
      expect(sql.prepare('SELECT count(*) AS n FROM memory_confirmation_reviews').get().n).toBe(0);
      expect((await getMemoryConfirmationStatus(env, proposed, 'user:alice')).status).toBe('pending');
    } finally { sql.close(); }
  });

  it('preserves original evidence and corrected searchable text with one immutable receipt', async () => {
    const { sql, env } = fixture();
    try {
      const refs = [{ type: 'turn_evidence', ref: 'turn:source#s1', span_id: 's1', role: 'user', content_hash: `sha256:${'a'.repeat(64)}` }];
      const proposed = await proposeMemoryWithRationale(env, { tenant_id: 'default', actor_id: 'user:alice', source: 'codex',
        item: { content: '表示外の文章を追加しない', project_id: 'org-brain' },
        review_context: { candidate_id: 'candidate-a', candidate_hash: 'b'.repeat(64), source_references: refs,
          conclusion: 'このプロジェクトはRESTを採用する', reason_summary: '未確認', reuse_rule: 'このプロジェクトのみ' } });
      expect(proposed.proposed_memory.content).not.toContain('表示外');
      const request = { tenant_id: 'default', confirmation_token: proposed.confirmation_token, approved: true,
        review_answer: '修正: このプロジェクトはOAuthを採用する。\n理由: 互換性を維持するため', review_label: 'corrected',
        corrected_content: 'このプロジェクトはOAuthを採用する。\n理由: 互換性を維持するため', corrected_summary: 'OAuthを採用する' };
      const receipt = await confirmProposedMemory(env, request, 'user:alice');
      expect(await confirmProposedMemory(env, request, 'user:alice')).toEqual(receipt);
      expect(await getMemoryConfirmationStatus(env, request, 'user:alice')).toEqual({ ...receipt, project_id: 'org-brain' });
      expect(JSON.parse(sql.prepare('SELECT response_json FROM memory_confirmation_reviews WHERE confirmation_id=?')
        .get(proposed.confirmation_token).response_json)).toEqual(receipt);
      const memory = sql.prepare('SELECT content, summary, source_refs_json, rationale, reuse_rule FROM memories WHERE id = ?').get(receipt.memory_id);
      expect(memory.content).toBe(request.corrected_content);
      expect(memory.summary).toBe(request.corrected_summary);
      expect(memory.rationale).toBe('互換性を維持するため');
      expect(memory.reuse_rule).toBeNull();
      expect(JSON.parse(memory.source_refs_json)).toEqual(refs);
      expect(sql.prepare("SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH 'このプロジェクトはOAuthを採用する'").get().n).toBe(1);
      expect(sql.prepare('SELECT count(*) AS n FROM memories').get().n).toBe(1);
      const reviews = await listMemoryConfirmationReviews(env, 'default', { principal: 'user:alice', projectId: 'org-brain' });
      expect(reviews.items).toHaveLength(1);
      expect(reviews.items[0].source_references).toEqual(refs);
      expect(reviews.items[0].original.memory.content).toContain('REST');
      expect(reviews.items[0].usefulness.axes.task_contribution.status).toBe('unknown');
      expect((await listMemoryConfirmationReviews(env, 'default', { principal: 'user:bob' })).items).toEqual([]);
      await expect(confirmProposedMemory(env, { ...request, corrected_content: '異なる回答' }, 'user:alice')).rejects.toThrow('different answer');
    } finally { sql.close(); }
  });

  it('persists the category selected in the human confirmation answer', async () => {
    const { sql, env } = fixture();
    try {
      const proposed = await proposeMemoryWithRationale(env, { tenant_id: 'default', actor_id: 'user:alice', source: 'codex',
        item: { content: '再発時は原因を記録する', project_id: 'org-brain', tags: ['user-confirmed-learning', 'decision'] },
        review_context: { candidate_id: 'candidate-category', candidate_hash: 'c'.repeat(64), source_references: [],
          conclusion: '再発時は原因を記録する', reason_summary: '同じ障害を避けるため', reuse_rule: '障害対応時' } });
      const receipt = await confirmProposedMemory(env, { tenant_id: 'default', confirmation_token: proposed.confirmation_token,
        approved: true, review_label: 'accepted', review_answer: '3' }, 'user:alice');
      expect(receipt.memory_category).toBe('failure');
      const memory = sql.prepare('SELECT tags_json FROM memories WHERE id = ?').get(receipt.memory_id);
      expect(JSON.parse(memory.tags_json)).toEqual(expect.arrayContaining(['failure', 'memory-category:failure']));
      expect(JSON.parse(memory.tags_json)).not.toContain('decision');
    } finally { sql.close(); }
  });
});
