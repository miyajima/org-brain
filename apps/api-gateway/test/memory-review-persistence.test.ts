import { describe, expect, it } from 'vitest';
import { proposeMemoryWithRationale, confirmProposedMemory, getMemoryConfirmationStatus, listMemoryConfirmationReviews } from '../src/rationale-service';
import type { Env } from '../src/types';

const runtime = (globalThis as unknown as { process: { getBuiltinModule(name: string): any } }).process;
const { DatabaseSync } = runtime.getBuiltinModule('node:sqlite');
const { readFileSync, readdirSync } = runtime.getBuiltinModule('node:fs');

function fixture() {
  const sql = new DatabaseSync(':memory:');
  const directory = new URL('../../../migrations/', import.meta.url);
  for (const file of readdirSync(directory).filter((name: string) => name.endsWith('.sql')).sort()) sql.exec(readFileSync(new URL(file, directory), 'utf8'));
  const database = { prepare(query: string) {
    let args: any[] = [];
    return { bind(...values: any[]) { args = values; return this; },
      async first() { return sql.prepare(query).get(...args) ?? null; },
      async all() { return { results: sql.prepare(query).all(...args) }; },
      async run() { const result = sql.prepare(query).run(...args); return { success: true, meta: { changes: Number(result.changes) } }; }
    };
  }, async batch(statements: any[]) { sql.exec('BEGIN'); try { const results = []; for (const statement of statements) results.push(await statement.run()); sql.exec('COMMIT'); return results; } catch (error) { sql.exec('ROLLBACK'); throw error; } } };
  return { sql, env: { OPEN_BRAIN_DB: database } as unknown as Env };
}

describe('human review persistence', () => {
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
      expect(await getMemoryConfirmationStatus(env, request, 'user:alice')).toEqual(receipt);
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
});
