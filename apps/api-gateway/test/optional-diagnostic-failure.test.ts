import { describe, expect, it } from 'vitest';
import event from './fixtures/optional-diagnostic-failure.json';
import { stageConversationMemories } from '../src/conversation-memory-service';
import { confirmProposedMemory } from '../src/rationale-service';
import { searchMemories } from '../src/memory-search-service';
import { retrieveMemoryContext } from '../src/memory-context-service';
import { upsertTaskCommitment, getTaskCommitmentContext } from '../src/memory-contract-service';
import { recordActionAttempt, preflightAction } from '../src/action-attempt-service';
import { memoryD1Fixture } from './fixtures/memory-d1';

const owner = 'user:fixture-owner';
const scope = { tenant_id: 'fixture', project_id: 'workflow-fixture' };
const query = { ...scope, q: 'What Job skill prerequisites should we use?', limit: 5 };
function fixture() {
  const result = memoryD1Fixture();
  result.env.HYBRID_V4_MODE = 'on';
  result.env.EVIDENCE_DISPOSITION_MODE = 'on';
  result.sql.prepare('INSERT INTO principal_role_assignments(id,tenant_id,project_id,principal,role,created_by_principal,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('fixture-role', 'fixture', 'workflow-fixture', owner, 'project_owner', owner, 1, 1);
  return result;
}
async function stage(env: ReturnType<typeof fixture>['env'], input: unknown = event) {
  const preview = await stageConversationMemories(env, 'fixture', input, { principal: owner });
  return stageConversationMemories(env, 'fixture', input, { principal: owner, execute: true, expectedPlanHash: preview.plan_hash });
}

describe('synthetic optional diagnostics lesson and task scope', () => {
  it('requires review of the exact assistant capsule and delivers minimal steps without granting command verification', async () => {
    const { env, sql } = fixture();
    try {
      const pending = await stage(env);
      const confirmation = { tenant_id: 'fixture', confirmation_token: pending.receipts[0].confirmation_token, expected_candidate_hash: pending.receipts[0].candidate_hash, expected_revision: pending.receipts[0].revision, approved: true };
      expect((await searchMemories(env, query, { actorPrincipal: owner })).results).toEqual([]);
      expect((await retrieveMemoryContext(env, { ...query, top_k: 2, token_budget: 512 }, { actorPrincipal: owner })).evidence_bundle.evidence).toEqual([]);
      await expect(confirmProposedMemory(env, confirmation, owner)).rejects.toThrow('actual user answer');
      await expect(confirmProposedMemory(env, { ...confirmation, review_answer: event.sources[0].text }, owner)).rejects.toThrow('does not approve');
      // Synthetic review of this displayed fixture only. No real user's choice is inferred.
      const saved = await confirmProposedMemory(env, { ...confirmation, review_answer: '3' }, owner);
      expect(saved.saved).toBe(true);
      const row = sql.prepare('SELECT * FROM memories WHERE id=?').get(saved.memory_id);
      expect(row.verification_state).toBe('unverified');
      expect(row.reuse_rule).toBe(event.candidates[0].reuse_rule);
      expect(JSON.parse(row.source_refs_json).map((ref: any) => ref.role)).toEqual(expect.arrayContaining(['user', 'assistant', 'supplied_unverified']));
      const context = await retrieveMemoryContext(env, { ...query, top_k: 2, token_budget: 512 }, { actorPrincipal: owner });
      const text = context.evidence_bundle.evidence.map(item => item.text).join('\n');
      expect(context.meta.task_query?.coverage).toBe('covered');
      for (const required of ['skills/job/SKILL.md', 'mandatory safe read gate', 'optional unless', '<current-job-id>', 'stop on mismatch', 'without expanding IAM', 'Refresh', 'unverified']) {
        expect(text).toContain(required);
      }
      expect(text.length).toBeLessThan(1_000);
      expect(sql.prepare('SELECT count(*) AS n FROM memories').get().n).toBe(1);
      // A fixture-only oversized current capsule must not deliver a command without its conditions.
      sql.prepare('UPDATE memories SET content=content || ?, current_version=current_version+1 WHERE id=?').run(' Additional fixture detail.'.repeat(80), saved.memory_id);
      const insufficient = await retrieveMemoryContext(env, { ...query, top_k: 2, token_budget: 512 }, { actorPrincipal: owner });
      expect(insufficient.evidence_bundle.evidence).toEqual([]);
      expect(insufficient.meta.task_query?.coverage).toBe('missing');
      expect(insufficient.meta.usage_items).toEqual([]);
    } finally { sql.close(); }
  });

  it('keeps a current task ceiling and expiry out of the reusable lesson and other tasks', async () => {
    const { env, sql } = fixture();
    try {
      const pending = await stage(env);
      await confirmProposedMemory(env, { tenant_id: 'fixture', confirmation_token: pending.receipts[0].confirmation_token, expected_candidate_hash: pending.receipts[0].candidate_hash, expected_revision: pending.receipts[0].revision, approved: true, review_answer: '3' }, owner);
      const now = Date.now();
      await upsertTaskCommitment(env, { ...scope, task_key: 'task-current', decision_key: 'call-ceiling',
        question_fingerprint: 'sha256:' + 'a'.repeat(64), question: 'What is the ceiling for this synthetic task?',
        answer: { label: 'At most three fixture attempts during this task; stop when the ceiling or expiry is reached.' },
        confirmation_state: 'user_confirmed', evidence: { type: 'request_user_input_result', digest: 'sha256:' + 'b'.repeat(64) }, expires_at: now + 60_000 });
      expect((await getTaskCommitmentContext(env, { ...scope, task_key: 'task-current' })).commitments).toHaveLength(1);
      expect((await getTaskCommitmentContext(env, { ...scope, task_key: 'task-next' })).commitments).toEqual([]);
      expect((await getTaskCommitmentContext(env, { ...scope, project_id: 'other', task_key: 'task-current' })).commitments).toEqual([]);
      // Isolated SQLite fixture clock expiry, never an operational pending DB mutation.
      sql.prepare('UPDATE task_commitments SET expires_at=?').run(now - 1);
      expect((await getTaskCommitmentContext(env, { ...scope, task_key: 'task-current' })).commitments).toEqual([]);
      const context = await retrieveMemoryContext(env, { ...query, top_k: 2, token_budget: 512 }, { actorPrincipal: owner });
      expect(context.evidence_bundle.evidence).toHaveLength(1);
      expect(JSON.stringify(context.evidence_bundle.evidence)).not.toContain('three fixture attempts');
      expect(sql.prepare('SELECT count(*) AS n FROM memories').get().n).toBe(1);
    } finally { sql.close(); }
  });

  it('does not promote a supplied IAM failure into verified Job authorization or a mandatory diagnostic', async () => {
    const { env, sql } = fixture();
    try {
      const conditions = { skill_checked: 'no', read_gate: 'not_checked', diagnostic: 'optional' };
      const attempt = await recordActionAttempt(env, 'fixture', owner, { id: 'fixture-optional-diagnostic',
        project_id: 'workflow-fixture', action_key: 'diagnostic:project-describe', action_label: 'Synthetic optional project diagnostic', target: 'fixture-project', conditions,
        outcome: 'failure', result_summary: 'Synthetic IAM denial on optional project diagnostics', failure_kind: 'unknown',
        performed_at: Date.now() - 1_000, evidence: [{ ref_type: 'task_event', ref_id: 'fixture:diagnostic', content_hash: 'c'.repeat(64) }],
        source: 'fixture', source_key: 'fixture:diagnostic' });
      expect(attempt.verification_state).toBe('reported');
      expect(attempt.executed_by_type).toBe('unknown');
      expect((await preflightAction(env, 'fixture', { project_id: 'workflow-fixture', action_key: 'diagnostic:project-describe', conditions })).decision).toBe('warn');
      // The action-history hint is not Job permission; the Job skill's required read gate still applies.
      expect((await preflightAction(env, 'fixture', { project_id: 'workflow-fixture', action_key: 'job:run', conditions })).decision).toBe('allow');
      expect(sql.prepare('SELECT count(*) AS n FROM memory_failure_patterns WHERE is_active=1').get().n).toBe(0);
    } finally { sql.close(); }
  });

  it('keeps independent events separate unless an explicit revision names a predecessor', async () => {
    const { env, sql } = fixture();
    try {
      const old = await stage(env);
      const revision = structuredClone(event);
      revision.event_id = 'synthetic-failure-lesson-r2';
      revision.candidates[0].rationale += ' Revised synthetic explanation.';
      const newer = await stage(env, revision);
      expect(newer.receipts[0].confirmation_token).not.toBe(old.receipts[0].confirmation_token);
      // Independent events do not establish a replacement lineage; explicit revision is required.
      const saved = await confirmProposedMemory(env, { tenant_id: 'fixture', confirmation_token: old.receipts[0].confirmation_token, expected_candidate_hash: old.receipts[0].candidate_hash, expected_revision: old.receipts[0].revision, approved: true, review_answer: '3' }, owner);
      expect(saved.saved).toBe(true);
      expect(sql.prepare('SELECT count(*) AS n FROM memory_confirmations WHERE consumed_at IS NULL').get().n).toBe(1);
    } finally { sql.close(); }
  });
});
