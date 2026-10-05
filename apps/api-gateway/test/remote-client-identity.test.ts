import { describe, expect, it } from 'vitest';
import { memoryD1Fixture } from './fixtures/memory-d1';
import { remoteClientIdentity, type RemoteOAuthIdentity } from '../src/remote-client-identity';
import { createCloudflareMcpOAuthProvider, oauthProviderSubject } from '../src/mcp-oauth-cloudflare';
import type { Env } from '../src/types';

const resource = 'https://fixture.example/mcp';
const props: RemoteOAuthIdentity = { tenantId: 'fixture', principal: 'user:fixture',
  defaultRole: 'reader', scopes: ['orgbrain:read', 'orgbrain:write'] };
const request = (query = 'tenant_id=fixture&project_id=project-a', method = 'GET') => new Request(`${resource}/identity?${query}`, { method });

function seed() {
  const { sql, env } = memoryD1Fixture();
  sql.prepare('INSERT INTO user_profiles(tenant_id,principal,status,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run('fixture', 'user:fixture', 'active', 1, 1);
  sql.prepare('INSERT INTO principal_role_assignments(id,tenant_id,project_id,principal,role,created_by_principal,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('fixture-role', 'fixture', 'project-a', 'user:fixture', 'project_owner', 'user:fixture', 1, 1);
  return { sql, env: { ...env, MCP_OAUTH_RESOURCE: resource } as Env };
}

describe('remote client verified identity', () => {
  it('returns only the authenticated identity and explicit authorized project with no-store', async () => {
    const { sql, env } = seed();
    try {
      const response = await remoteClientIdentity(request(), env, props);
      expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ resource, tenant_id: 'fixture', project_id: 'project-a',
        principal: 'user:fixture', scopes: props.scopes });
    } finally { sql.close(); }
  });
  it('rejects missing/duplicate project, tenant mismatch, missing scope, revoked project and disabled user', async () => {
    const { sql, env } = seed();
    try {
      expect((await remoteClientIdentity(request('tenant_id=fixture'), env, props)).status).toBe(400);
      expect((await remoteClientIdentity(request('tenant_id=fixture&project_id=project-a&project_id=project-b'), env, props)).status).toBe(400);
      expect((await remoteClientIdentity(request('tenant_id=other&project_id=project-a'), env, props)).status).toBe(403);
      expect((await remoteClientIdentity(request(), env, { ...props, scopes: ['orgbrain:write'] })).status).toBe(403);
      expect((await remoteClientIdentity(request('', 'POST'), env, props)).status).toBe(405);
      sql.prepare('DELETE FROM principal_role_assignments').run();
      expect((await remoteClientIdentity(request(), env, props)).status).toBe(403);
      expect((await remoteClientIdentity(request(), env, { ...props, scopes: ['orgbrain:read'] })).status).toBe(200);
      sql.prepare("UPDATE user_profiles SET status='suspended'").run();
      expect((await remoteClientIdentity(request(), env, props)).status).toBe(403);
    } finally { sql.close(); }
  });
});

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

describe('pinned OAuth provider synthetic integration', () => {
  it('verifies real colon tokens, effective downscoped access/revocation, and documents previous-refresh tolerance', async () => {
    const { sql, env: base } = seed();
    const env = { ...base, OAUTH_KV: new FixtureKV(), MCP_AUTH_MODE: 'oauth' } as unknown as Env;
    const context = () => ({ waitUntil() {}, passThroughOnException() {}, props: {} }) as ExecutionContext;
    try {
      const provider = await createCloudflareMcpOAuthProvider(env, () => new Response('fixture', { status: 404 }));
      await provider.fetch(new Request('https://fixture.example/fixture-helper'), env, context());
      const helpers = (env as any).OAUTH_PROVIDER;
      const client = await helpers.createClient({ clientName: 'Synthetic OrgBrain client', redirectUris: ['http://127.0.0.1:12345/callback'],
        grantTypes: ['authorization_code', 'refresh_token'], responseTypes: ['code'], tokenEndpointAuthMethod: 'none' });
      const verifier = 'a'.repeat(43);
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
      const challenge = btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
      const authorization = new URL('https://fixture.example/oauth/authorize');
      for (const [key, value] of Object.entries({ client_id: client.clientId, redirect_uri: 'http://127.0.0.1:12345/callback',
        response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', resource, scope: props.scopes.join(' '), state: 'fixture-state' })) authorization.searchParams.set(key, value);
      const parsed = await helpers.parseAuthRequest(new Request(authorization));
      const { redirectTo } = await helpers.completeAuthorization({ request: parsed,
        userId: await oauthProviderSubject(props.principal), metadata: {}, scope: props.scopes, props });
      const exchange = (fields: Record<string, string>) => provider.fetch(new Request('https://fixture.example/oauth/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: client.clientId, resource, ...fields }).toString() }), env, context());
      const issued = await exchange({ grant_type: 'authorization_code', code: new URL(redirectTo).searchParams.get('code')!,
        code_verifier: verifier, redirect_uri: 'http://127.0.0.1:12345/callback' });
      expect(issued.status).toBe(200);
      const initial = await issued.json() as any;
      expect(initial.access_token.split(':')).toHaveLength(3);
      const identity = (token: string) => provider.fetch(new Request(`${resource}/identity?tenant_id=fixture&project_id=project-a`, {
        headers: { authorization: `Bearer ${token}` } }), env, context());
      expect((await identity(initial.access_token)).status).toBe(200);
      const downscoped = await exchange({ grant_type: 'refresh_token', refresh_token: initial.refresh_token, scope: 'orgbrain:read' });
      expect(downscoped.status).toBe(200);
      const refreshed = await downscoped.json() as any;
      expect(refreshed.refresh_token).not.toBe(initial.refresh_token);
      const verified = await identity(refreshed.access_token);
      expect(verified.status).toBe(200); expect((await verified.json() as any).scopes).toEqual(['orgbrain:read']);
      const deniedWrite = await provider.fetch(new Request(resource, { method: 'POST', headers: {
        authorization: `Bearer ${refreshed.access_token}`, accept: 'application/json, text/event-stream',
        'content-type': 'application/json', 'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/call', 'Mcp-Name': 'orgbrain_conversation_memories_stage'
      }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'orgbrain_conversation_memories_stage', arguments: {}, _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28'
        }
      } }) }), { ...env, API_RATE_LIMITER: { limit: async () => ({ success: true }) } } as Env, context());
      expect(deniedWrite.status).toBe(403);
      expect(deniedWrite.headers.get('www-authenticate')).toContain('orgbrain:write');
      // Existing dependency accepts the immediately preceding refresh token.
      // This test records that limitation; it does not claim replay detection.
      expect((await exchange({ grant_type: 'refresh_token', refresh_token: initial.refresh_token, scope: props.scopes.join(' ') })).status).toBe(200);
      expect((await exchange({ grant_type: 'refresh_token', refresh_token: initial.refresh_token, scope: props.scopes.join(' ') })).status).toBe(200);
      const revoked = await exchange({ token: refreshed.refresh_token, token_type_hint: 'refresh_token' });
      expect(revoked.status).toBe(200);
      // Revoke the current grant through the actual helper as well: the previous
      // token can cease being recognizable after an intervening rotation.
      const unwrapped = await helpers.unwrapToken(initial.access_token);
      if (unwrapped) await helpers.revokeGrant(unwrapped.grantId, unwrapped.userId);
      expect((await identity(initial.access_token)).status).toBe(401);
      expect((await exchange({ grant_type: 'refresh_token', refresh_token: initial.refresh_token })).status).toBe(400);
    } finally { sql.close(); }
  });
});
