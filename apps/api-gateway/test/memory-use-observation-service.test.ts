import { describe, expect, it } from 'vitest';
import { receiveCloudUseObservation } from '../src/memory-use-observation-service';
import { memoryUseService } from '../src/memory-use-service';
import { memoryD1Fixture } from './fixtures/memory-d1';

const input = () => ({ usage_id: 'fixture-usage', usage_item_id: 'fixture-item', source_id: 'fixture-memory', source_version: 1,
  project_id: 'project-a', task_id: 'fixture-task', work_type: 'implementation', action_call_id: 'call_fixture',
  context: { task: 'Exercise synthetic receipt boundaries', target: 'Fixture adapter', constraints: '', conditions: '' } });
function fixture() {
  const result = memoryD1Fixture(), { sql, env } = result;
  env.ORGBRAIN_USE_COLLECT = 'on';
  sql.prepare(`INSERT INTO principal_role_assignments(id,tenant_id,project_id,principal,role,created_by_principal,created_at,updated_at)
    VALUES('fixture-role','fixture','project-a','user:alice','project_owner','user:alice',1,1)`).run();
  sql.prepare(`INSERT INTO memories(id,tenant_id,project_id,content,summary,source,created_at,current_version,scope_type,owner_principal)
    VALUES('fixture-memory','fixture','project-a','Synthetic receipt only','Synthetic receipt only','fixture',1,1,'tenant','user:alice')`).run();
  sql.prepare(`INSERT INTO memory_usage_events(id,tenant_id,project_id,task_id,actor_principal,access_path,request_source,created_at)
    VALUES('fixture-usage','fixture','project-a','fixture-task','user:alice','search','mcp',1)`).run();
  sql.prepare(`INSERT INTO memory_usage_items(id,usage_event_id,tenant_id,source_type,source_id,source_version,reference_type,created_at)
    VALUES('fixture-item','fixture-usage','fixture','memory','fixture-memory',1,'returned',1)`).run();
  return result;
}

describe('Cloud observation receipts are private acknowledgements', () => {
  it('retains default-off stateless behavior without touching D1 or requiring a new grant', async () => {
    const { env, sql } = memoryD1Fixture();
    try {
      const result = await receiveCloudUseObservation(env, 'fixture', null, input());
      expect(result.tracking).toBe('disabled'); expect(result.persisted).toBe(false); expect(result.receipt_persisted).toBe(result.tracking !== 'disabled');
      expect(sql.prepare('SELECT count(*) AS n FROM cloud_use_observation_receipts').get().n).toBe(0);
    } finally { sql.close(); }
  });

  it('acknowledges only a matching owner/project/task/item/version without evaluating or trusting the report', async () => {
    const { env, sql } = fixture();
    try {
      const result = await receiveCloudUseObservation(env, 'fixture', 'user:alice', { ...input(), raw_transcript: 'Discard this extra field' });
      expect(result.tracking).toBe('pending_trusted_event_verification'); expect(result.persisted).toBe(false); expect(result.receipt_persisted).toBe(result.tracking !== 'disabled');
      expect(result).toHaveProperty('use_receipt', expect.stringMatching(/^orgbrain-use-receipt:[a-f0-9-]{36}$/u));
      const row = sql.prepare('SELECT * FROM cloud_use_observation_receipts').get();
      expect(row.expires_at - row.created_at).toBe(86_400_000);
      expect(JSON.parse(row.observation_json)).not.toHaveProperty('raw_transcript');
      for (const table of ['memory_use_contexts', 'memory_use_evaluations', 'memory_effect_events']) {
        expect(sql.prepare(`SELECT count(*) AS n FROM ${table}`).get().n).toBe(0);
      }
      const untrusted = await memoryUseService(env, 'fixture', 'user:alice').record({ id: 'fixture-untrusted', usage_item_id: 'fixture-item',
        project_id: 'project-a', task_id: 'fixture-task', work_type: 'implementation', context: input().context,
        evidence: [{ role: 'action', ref_type: 'cloud_receipt', ref_id: row.id, span_start: 0, span_end: 1, content_hash: 'a'.repeat(64) }] });
      expect(untrusted.verification_state).toBe('unverified');
      expect(untrusted.evidence[0].verification_state).toBe('unverified');
      expect(sql.prepare("SELECT count(*) AS n FROM memory_use_contexts WHERE verification_state='verified'").get().n).toBe(0);
    } finally { sql.close(); }
  });

  it('rejects wrong scopes, lost permissions, changed versions and credentials before persistence', async () => {
    const { env, sql } = fixture();
    try {
      for (const changed of [{ task_id: 'other-task' }, { usage_item_id: 'other-item' }, { source_version: 2 }, { project_id: 'project-b' }]) {
        await expect(receiveCloudUseObservation(env, 'fixture', 'user:alice', { ...input(), ...changed })).rejects.toThrow();
      }
      await expect(receiveCloudUseObservation(env, 'other', 'user:alice', input())).rejects.toThrow();
      await expect(receiveCloudUseObservation(env, 'fixture', 'user:bob', input())).rejects.toThrow();
      await expect(receiveCloudUseObservation(env, 'fixture', 'user:alice', { ...input(), context: { ...input().context,
        target: 'ｐａｓｓｗｏｒｄ＝ｆｉｘｔｕｒｅ' } })).rejects.toThrow();
      sql.prepare('UPDATE memories SET current_version=2').run();
      await expect(receiveCloudUseObservation(env, 'fixture', 'user:alice', input())).rejects.toThrow();
      sql.prepare('DELETE FROM principal_role_assignments').run();
      await expect(receiveCloudUseObservation(env, 'fixture', 'user:alice', input())).rejects.toThrow();
      expect(sql.prepare('SELECT count(*) AS n FROM cloud_use_observation_receipts').get().n).toBe(0);
    } finally { sql.close(); }
  });
});
