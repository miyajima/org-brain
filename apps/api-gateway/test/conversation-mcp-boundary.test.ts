import { beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryD1Fixture } from './fixtures/memory-d1';

const handlers = vi.hoisted(() => new Map<string, (input: any) => Promise<any>>());
vi.mock('@modelcontextprotocol/server', () => ({ McpServer: class {
  registerTool(name: string, _config: unknown, handler: (input: any) => Promise<any>) { handlers.set(name, handler); }
} }));

const event = () => ({ schema_version: 'conversation-memory/v1', tenant_id: 'fixture', project_id: 'project-a',
  session_id: 'test-session', event_id: 'test-event', occurred_at: '2026-10-03T09:00:00Z', producer: 'manual',
  sources: [{ id: 'test-source', role: 'user', ref: 'fixture:user-choice', text: 'Use synthetic staging.' }],
  candidates: [{ id: 'test-decision', kind: 'decision', claim_type: 'user_decision', conclusion: 'Use synthetic staging.',
    rationale: 'The fixture controls inputs.', reuse_rule: 'Synthetic tests only.', source_ids: ['test-source'] }] });
const decode = (result: any) => JSON.parse(result.content[0].text);

describe('conversation MCP authorization and project-scoped confirmation', () => {
  beforeEach(() => handlers.clear());

  it('allows a project owner to stage/confirm only their project without a tenant-wide grant', async () => {
    const { sql, env } = memoryD1Fixture();
    try {
      sql.prepare('INSERT INTO principal_role_assignments(id,tenant_id,project_id,principal,role,created_by_principal,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
        .run('test-role', 'fixture', 'project-a', 'user:alice', 'project_owner', 'user:alice', 1, 1);
      const { createOrgBrainMcpServer } = await import('../src/mcp');
      await createOrgBrainMcpServer(env, { tenantId: 'fixture', allowedTenants: ['fixture'], principal: 'user:alice',
        defaultRole: 'reader', authSource: 'oauth', scopes: ['orgbrain:read', 'orgbrain:write'] });
      const stage = handlers.get('orgbrain_conversation_memories_stage')!;
      const preview = decode(await stage({ conversation: event() }));
      const saved = decode(await stage({ conversation: event(), execute: true, expected_plan_hash: preview.plan_hash }));
      expect(saved.pending_created).toBe(1);
      await expect(stage({ conversation: { ...event(), project_id: 'project-b' } })).rejects.toThrow('lacks write');
      await expect(stage({ tenant_id: 'other', conversation: event() })).rejects.toThrow('tenant not allowed');
      const revise=handlers.get('orgbrain_conversation_memories_revise')!;
      const cancel=handlers.get('orgbrain_memories_confirmation_cancel')!;
      const guard={confirmation_token:saved.receipts[0].confirmation_token,expected_candidate_hash:saved.receipts[0].candidate_hash,expected_revision:saved.receipts[0].revision};
      await expect(revise({...guard,conversation:{...event(),project_id:'project-b'}})).rejects.toThrow();
      const token = saved.receipts[0].confirmation_token;
      const status = handlers.get('orgbrain_memories_confirmation_status')!;
      expect(decode(await status({ confirmation_token: token })).status).toBe('pending');
      const confirm = handlers.get('orgbrain_memories_confirm')!;
      const receipt = decode(await confirm({ confirmation_token: token, expected_candidate_hash: saved.receipts[0].candidate_hash, expected_revision: saved.receipts[0].revision, approved: true, review_answer: '保存する' }));
      expect(receipt.saved).toBe(true);
      sql.prepare('DELETE FROM principal_role_assignments').run();
      await expect(revise({...guard,conversation:event()})).rejects.toThrow('lacks write');
      await expect(cancel({...guard,reason:'Synthetic withdrawal'})).rejects.toThrow('lacks write');
      await expect(confirm({ confirmation_token: token, expected_candidate_hash: saved.receipts[0].candidate_hash, expected_revision: saved.receipts[0].revision, approved: true, review_answer: '保存する' })).rejects.toThrow('lacks write');
      expect(sql.prepare('SELECT count(*) AS n FROM memories').get().n).toBe(1);
    } finally { sql.close(); }
  });

  it('requires OAuth write scope and preserves the hook allowlist', async () => {
    const { env, sql } = memoryD1Fixture();
    try {
      const { createOrgBrainMcpServer, assertMcpToolAllowed } = await import('../src/mcp');
      const {stageConversationMemories}=await import('../src/conversation-memory-service');
      const preview=await stageConversationMemories(env,'fixture',event(),{principal:'user:alice',fallbackRole:'tenant_admin'});
      const staged=await stageConversationMemories(env,'fixture',event(),{principal:'user:alice',fallbackRole:'tenant_admin',execute:true,expectedPlanHash:preview.plan_hash});
      const props = { tenantId: 'fixture', allowedTenants: ['fixture'], principal: 'user:alice',
        defaultRole: 'service_agent' as const, authSource: 'oauth' as const, scopes: ['orgbrain:read' as const] };
      await createOrgBrainMcpServer(env, props);
      await expect(handlers.get('orgbrain_conversation_memories_stage')!({ conversation: event() })).rejects.toThrow('does not grant write');
      for (const name of ['orgbrain_conversation_memories_revise','orgbrain_memories_confirmation_cancel']) {
        await expect(handlers.get(name)!({conversation:event(),confirmation_token:staged.receipts[0].confirmation_token,expected_candidate_hash:staged.receipts[0].candidate_hash,expected_revision:1,reason:'Synthetic withdrawal'})).rejects.toThrow('does not grant write');
        const request=new Request('https://example.invalid/mcp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method:'tools/call',params:{name}})});
        await expect(assertMcpToolAllowed(request,{...props,authSource:'access-service',allowedTools:['orgbrain_memories_capture_rationale','orgbrain_memory_extraction_enqueue']})).rejects.toThrow('cannot call');
      }
      const request = new Request('https://example.invalid/mcp', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'tools/call', params: { name: 'orgbrain_conversation_memories_stage' } }) });
      await expect(assertMcpToolAllowed(request, { ...props, authSource: 'access-service',
        allowedTools: ['orgbrain_memories_capture_rationale', 'orgbrain_memory_extraction_enqueue'] })).rejects.toThrow('cannot call');
      expect(sql.prepare('SELECT count(*) AS n FROM memory_confirmations').get().n).toBe(1);
      expect(sql.prepare('SELECT lifecycle_state FROM memory_confirmations').get().lifecycle_state).toBe('pending');
    } finally { sql.close(); }
  });
});
