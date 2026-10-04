import { describe, expect, it } from 'vitest';
import { memoryD1Fixture } from './fixtures/memory-d1';
import { createCloudflareMcpOAuthProvider, oauthProviderSubject } from '../src/mcp-oauth-cloudflare';
import type { Env } from '../src/types';
import { captureMemoryItems } from '../src/memory-lifecycle-service';
import { updateAccessPolicy } from '../src/access-policy-service';

// Exercise shipped JavaScript clients without widening the gateway tsconfig.
const clientModule = '../../../packages/orgbrain-cli/src/remote-oauth-client.mjs';
const storeModule = '../../../packages/orgbrain-cli/src/lib/remote-private-store.mjs';
const runtime = (globalThis as any).process;
const { mkdtemp, rm } = runtime.getBuiltinModule('node:fs/promises');
const { tmpdir } = runtime.getBuiltinModule('node:os');
const { join } = runtime.getBuiltinModule('node:path');

class FixtureKV {
  values = new Map<string, string>();
  async get(key: string, options?: string | { type: string }) {
    const value = this.values.get(key) ?? null;
    return value && (options === 'json' || typeof options === 'object' && options.type === 'json') ? JSON.parse(value) : value;
  }
  async put(key: string, value: string) { this.values.set(key, value); }
  async delete(key: string) { this.values.delete(key); }
  async list(options: { prefix?: string } = {}) {
    return { keys: [...this.values.keys()].filter(key => key.startsWith(options.prefix ?? '')).map(name => ({ name })), list_complete: true, cursor: '' };
  }
}

describe('real provider / modern MCP / synthetic D1 client lifecycle', () => {
  it('keeps the canonical owner across later edits and mirrors an authorized policy ownership change', async () => {
    const { sql, env } = memoryD1Fixture();
    try {
      const item = { external_key: 'fixture-owner', content: 'Synthetic owner continuity.', project_id: 'project-a', actor_id: 'user:owner' };
      const initial = await captureMemoryItems(env, { tenantId: 'fixture', source: 'fixture', items: [item] });
      const id = initial.items[0].memory_id;
      await captureMemoryItems(env, { tenantId: 'fixture', source: 'fixture', items: [{ ...item, actor_id: 'user:editor' }] });
      expect(sql.prepare('SELECT owner_principal,actor_id FROM memories WHERE id=?').get(id))
        .toMatchObject({ owner_principal: 'user:owner', actor_id: 'user:editor' });
      await updateAccessPolicy(env, { resource_type: 'memory', resource_id: id, scope: 'project', project_id: 'project-a',
        owner_principal: 'user:new-owner', expected_policy_version: 1 },
      { tenantId: 'fixture', actorPrincipal: 'user:synthetic-admin', isAdmin: true });
      expect(sql.prepare('SELECT owner_principal FROM memories WHERE id=?').get(id)!.owner_principal).toBe('user:new-owner');
      await captureMemoryItems(env, { tenantId: 'fixture', source: 'fixture', items: [item] });
      expect(sql.prepare('SELECT owner_principal FROM memories WHERE id=?').get(id)!.owner_principal).toBe('user:new-owner');
    } finally { sql.close(); }
  });
  it('two independent clients stage, require actual-answer guards, confirm, refresh, search and revoke without crossing projects', async () => {
    const { sql, env: base } = memoryD1Fixture();
    const directory = await mkdtemp(join(tmpdir(), 'orgbrain-provider-client-'));
    const origin = 'https://fixture.example', resource = `${origin}/mcp`;
    const scopes = ['orgbrain:read', 'orgbrain:write'];
    const props = { tenantId: 'fixture', principal: 'user:fixture', defaultRole: 'reader', scopes };
    const binding = { resource, tenant_id: props.tenantId, principal: props.principal, project_id: 'project-a' };
    sql.prepare('INSERT INTO user_profiles(tenant_id,principal,status,created_at,updated_at) VALUES(?,?,?,?,?)')
      .run(props.tenantId, props.principal, 'active', 1, 1);
    for (const project of ['project-a', 'project-b']) {
      sql.prepare('INSERT INTO principal_role_assignments(id,tenant_id,project_id,principal,role,created_by_principal,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(`fixture-${project}`, props.tenantId, project, props.principal, 'project_owner', props.principal, 1, 1);
    }
    const env = { ...base, OAUTH_KV: new FixtureKV(), MCP_OAUTH_RESOURCE: resource,
      MCP_AUTH_MODE: 'oauth', API_RATE_LIMITER: { limit: async () => ({ success: true }) } } as unknown as Env;
    const context = () => ({ waitUntil() {}, passThroughOnException() {}, props: {} }) as ExecutionContext;
    try {
      const provider = await createCloudflareMcpOAuthProvider(env, () => new Response('fixture', { status: 404 }));
      await provider.fetch(new Request(`${origin}/fixture-helper`), env, context());
      const phases: string[] = [];
      const fetchImpl = async (url: string, options: RequestInit = {}) => {
        expect(new URL(url).origin).toBe(origin);
        const response = await provider.fetch(new Request(url, options), env, context());
        phases.push(`${new URL(url).pathname}:${response.status}`);
        return response;
      };
      const { OrgBrainRemoteClient } = await import(clientModule);
      const { RemotePrivateStore } = await import(storeModule);
      const makeClient = (profile: string) => {
        const store = new RemotePrivateStore({ directory, profile });
        let receive: (code: string) => void;
        const client = new OrgBrainRemoteClient({ store, fetchImpl, receiver: async () => ({
          redirectUri: 'http://127.0.0.1:12345/callback',
          result: new Promise<string>(resolve => { receive = resolve; }), close: async () => {}
        }) });
        // Trusted synthetic authorization fixture, not browser login or live consent.
        const onAuthorize = async ({ url }: { url: string }) => {
          const helpers = (env as any).OAUTH_PROVIDER;
          const request = await helpers.parseAuthRequest(new Request(url));
          phases.push('authorization-parsed');
          const { redirectTo } = await helpers.completeAuthorization({ request,
            userId: await oauthProviderSubject(props.principal), metadata: {}, scope: scopes, props });
          phases.push('authorization-completed');
          receive(new URL(redirectTo).searchParams.get('code')!);
        };
        return { client, store, onAuthorize };
      };
      const a = makeClient('a'), b = makeClient('b'), q = makeClient('q');
      await a.client.login(binding, { onAuthorize: a.onAuthorize }).catch((error: any) => {
        throw new Error(`${error.message}; synthetic phases: ${phases.join(',')}`);
      });
      await b.client.login(binding, { onAuthorize: b.onAuthorize });
      await q.client.login({ ...binding, project_id: 'project-b' }, { onAuthorize: q.onAuthorize });
      expect((await a.store.read()).client_id).not.toBe((await b.store.read()).client_id);
      const conversation = { schema_version: 'conversation-memory/v1', tenant_id: 'fixture', project_id: 'project-a',
        session_id: 'fixture-session', event_id: 'fixture-event', occurred_at: '2026-10-04T09:00:00Z', producer: 'manual',
        sources: [{ id: 'fixture-source', role: 'user', ref: 'fixture:synthetic', text: 'Use synthetic shared-memory checks.' }],
        candidates: [{ id: 'fixture-decision', kind: 'decision', claim_type: 'user_decision',
          conclusion: 'Use synthetic shared-memory checks.', rationale: 'The fixture contains no private data.',
          reuse_rule: 'Synthetic tests only.', source_ids: ['fixture-source'] }] };
      const preview = await a.client.stage(conversation);
      const staged = await a.client.stage(conversation, { execute: true, expectedPlanHash: preview.plan_hash });
      expect(staged.pending_created).toBe(1); expect(staged.active_memories_created).toBe(0);
      const receipt = staged.receipts[0];
      expect((await b.client.search('synthetic')).results).toHaveLength(0);
      await expect(b.client.confirm({ confirmation_token: receipt.confirmation_token, approved: true })).rejects.toThrow('actual_review_and_guard_required');
      await expect(q.client.confirmationStatus(receipt.confirmation_token)).rejects.toThrow('confirmation_binding_mismatch');
      const review = { confirmation_token: receipt.confirmation_token, approved: true,
        expected_candidate_hash: receipt.candidate_hash, expected_revision: receipt.revision, review_answer: '保存する' };
      await expect(b.client.confirm({ ...review, expected_candidate_hash: '0'.repeat(64) })).rejects.toThrow('stale_confirmation');
      await expect(b.client.confirm({ ...review, review_answer: '保存しない' })).rejects.toThrow('mcp_failed');
      expect(sql.prepare('SELECT count(*) AS n FROM memories').get()!.n).toBe(0);
      const confirmed = await b.client.confirm({ confirmation_token: receipt.confirmation_token, approved: true,
        expected_candidate_hash: receipt.candidate_hash, expected_revision: receipt.revision, review_answer: '保存する' });
      expect(confirmed.saved).toBe(true);
      expect(sql.prepare('SELECT owner_principal, actor_id, lifecycle_state, project_id, content FROM memories').get())
        .toMatchObject({ owner_principal: props.principal, project_id: binding.project_id, lifecycle_state: 'active' });
      expect((await a.client.confirmationStatus(receipt.confirmation_token)).saved).toBe(true);
      const before = (await b.store.read()).refresh_token;
      await b.client.refresh(); expect((await b.store.read()).refresh_token).not.toBe(before);
      const searched = await a.client.search('synthetic');
      expect(searched.results.map((row: any) => row.id), JSON.stringify(searched.meta)).toContain(confirmed.memory_id);
      expect((await b.client.search('synthetic')).results.map((row: any) => row.id)).toContain(confirmed.memory_id);
      expect((await q.client.search('synthetic')).results).toHaveLength(0);
      await expect(q.client.stage(conversation)).rejects.toThrow('conversation_binding_mismatch');
      expect((await b.client.logout()).remote_revoked).toBe(true);
      expect((await a.client.search('synthetic')).results).toHaveLength(1);
      expect(sql.prepare('SELECT count(*) AS n FROM memories').get()!.n).toBe(1);
    } finally { sql.close(); await rm(directory, { recursive: true, force: true }); }
  }, 15_000);
});
