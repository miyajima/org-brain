import { describe, expect, it } from 'vitest';
import { planConversationMemory } from '@org-brain/shared';
import { stageConversationMemories } from '../src/conversation-memory-service';
import { confirmProposedMemory, getMemoryConfirmationStatus } from '../src/rationale-service';
import { memoryD1Fixture } from './fixtures/memory-d1';

const input = () => ({ schema_version: 'conversation-memory/v1', tenant_id: 'fixture', project_id: 'test-project',
  session_id: 'test-session', event_id: 'test-event', occurred_at: '2026-10-03T09:00:00Z', producer: 'manual',
  sources: [{ id: 'test-source', role: 'user', ref: 'repo:test-project/docs/review-2026-10-03.md',
    text: 'Use the synthetic local staging fixture and check its digest before reuse.' }],
  candidates: [{ id: 'test-decision', kind: 'decision', claim_type: 'user_decision',
    conclusion: 'Use the synthetic local staging fixture.', rationale: 'The fixture owns the synthetic inputs.',
    reuse_rule: 'Synthetic tests only; check the fixture digest before reuse.', source_ids: ['test-source'] }] });
const owner = 'user:fixture-owner';

function fixture() {
  const result = memoryD1Fixture();
  result.sql.prepare('INSERT INTO principal_role_assignments(id,tenant_id,project_id,principal,role,created_by_principal,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('test-role', 'fixture', 'test-project', owner, 'project_owner', owner, 1, 1);
  return result;
}

describe('Cloud conversation candidates (synthetic SQLite D1 adapter)', () => {
  it('shares the local plan hash, stages pending proposals idempotently and waits for an actual answer', async () => {
    const { sql, env } = fixture();
    try {
      const event = input();
      const preview = await stageConversationMemories(env, 'fixture', event, { principal: owner });
      expect(preview.plan_hash).toBe(planConversationMemory(event).plan_hash);
      expect(sql.prepare('SELECT count(*) AS n FROM memory_confirmations').get().n).toBe(0);
      const options = { principal: owner, execute: true, expectedPlanHash: preview.plan_hash };
      const staged = await stageConversationMemories(env, 'fixture', event, options);
      expect(staged.pending_created).toBe(1);
      expect((await stageConversationMemories(env, 'fixture', event, options)).pending_created).toBe(0);
      expect(sql.prepare('SELECT count(*) AS n FROM memory_confirmations').get().n).toBe(1);
      expect(sql.prepare('SELECT count(*) AS n FROM memories').get().n).toBe(0);
      expect(sql.prepare('SELECT count(*) AS n FROM memories_fts').get().n).toBe(0);
      const token = staged.receipts[0].confirmation_token;
      const request = { tenant_id: 'fixture', confirmation_token: token, expected_candidate_hash: staged.receipts[0].candidate_hash, expected_revision: staged.receipts[0].revision, approved: true, review_answer: '保存する' };
      await expect(confirmProposedMemory(env, { ...request, review_answer: undefined }, owner)).rejects.toThrow('actual user answer');
      await expect(confirmProposedMemory(env, request, 'user:another-owner')).rejects.toThrow('another principal');
      const saved = await confirmProposedMemory(env, request, owner);
      expect(saved.saved).toBe(true);
      expect(await confirmProposedMemory(env, request, owner)).toEqual(saved);
      expect(await getMemoryConfirmationStatus(env, request, owner)).toEqual({ ...saved, project_id: 'test-project' });
      const memory = sql.prepare('SELECT * FROM memories WHERE id = ?').get(saved.memory_id);
      expect(memory.tenant_id).toBe('fixture');
      expect(memory.project_id).toBe('test-project');
      expect(memory.verification_state).toBe('unverified');
      expect(memory.verified_at).toBeNull();
      expect(JSON.parse(memory.source_refs_json)).toEqual(preview.candidates[0].source_references);
      expect(memory.reuse_rule).toBe(event.candidates[0].reuse_rule);
      expect(JSON.parse(memory.learning_json).conversation_provenance).toEqual(preview.candidates[0].provenance);
      expect((await stageConversationMemories(env, 'fixture', event, options)).receipts[0].status).toBe('saved');
      expect(sql.prepare('SELECT count(*) AS n FROM memories').get().n).toBe(1);
    } finally { sql.close(); }
  });

  it('rejects tenant, project, principal, hash, role and oversized input before staging', async () => {
    const { sql, env } = fixture();
    try {
      const event = input();
      const preview = planConversationMemory(event);
      await expect(stageConversationMemories(env, 'other-tenant', event, { principal: owner })).rejects.toThrow();
      await expect(stageConversationMemories(env, 'fixture', { ...event, project_id: 'other-project' }, { principal: owner })).rejects.toThrow();
      await expect(stageConversationMemories(env, 'fixture', event, { principal: 'user:reader' })).rejects.toThrow();
      await expect(stageConversationMemories(env, 'fixture', event, { principal: owner, execute: true, expectedPlanHash: 'a'.repeat(64) })).rejects.toThrow('hash');
      const wrongRole = input(); wrongRole.sources[0].role = 'assistant';
      await expect(stageConversationMemories(env, 'fixture', wrongRole, { principal: owner })).rejects.toThrow();
      const oversized = input(); oversized.sources[0].text = 'x'.repeat(65_537);
      await expect(stageConversationMemories(env, 'fixture', oversized, { principal: owner })).rejects.toThrow();
      expect(preview.requires_confirmation).toBe(true);
      expect(sql.prepare('SELECT count(*) AS n FROM memory_confirmations').get().n).toBe(0);
      expect(sql.prepare('SELECT count(*) AS n FROM memories').get().n).toBe(0);
    } finally { sql.close(); }
  });

  it('keeps an expired proposal expired instead of silently renewing it', async () => {
    const { sql, env } = fixture();
    try {
      const event = input(); const options = { principal: owner, execute: true, expectedPlanHash: planConversationMemory(event).plan_hash };
      const first = await stageConversationMemories(env, 'fixture', event, options);
      sql.prepare('UPDATE memory_confirmations SET expires_at = 1 WHERE id = ?').run(first.receipts[0].confirmation_token);
      const repeated = await stageConversationMemories(env, 'fixture', event, options);
      expect(repeated.pending_created).toBe(0);
      expect(repeated.receipts[0].status).toBe('expired');
      expect(sql.prepare('SELECT count(*) AS n FROM memories').get().n).toBe(0);
    } finally { sql.close(); }
  });
});
