import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryD1Fixture } from './fixtures/memory-d1';
import { createCloudflareMcpOAuthProvider } from '../src/mcp-oauth-cloudflare';
import { DEVICE_GRANT } from '../src/oauth-security-utils';
import type { Env } from '../src/types';

class FixtureKV {
  values = new Map<string, string>();
  expires = new Map<string, number>();
  async get(key: string, options?: string | { type: string }) {
    if ((this.expires.get(key) ?? Infinity) <= Date.now()) return null;
    const value = this.values.get(key) ?? null;
    return value && (options === 'json' || typeof options === 'object' && options.type === 'json') ? JSON.parse(value) : value;
  }
  async put(key: string, value: string, options?: { expirationTtl?: number }) {
    this.values.set(key, value);
    this.expires.set(key, options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : Infinity);
  }
  async delete(key: string) { this.values.delete(key); }
  async list(options: { prefix?: string } = {}) {
    return { keys: [...this.values.keys()].filter(key => key.startsWith(options.prefix ?? '') && (this.expires.get(key) ?? Infinity) > Date.now()).map(name => ({ name })), list_complete: true, cursor: '' };
  }
}
const origin = 'https://device.example', resource = `${origin}/mcp`;
const context = () => ({ waitUntil() {}, passThroughOnException() {}, props: {} }) as ExecutionContext;
afterEach(() => vi.restoreAllMocks());
const b64 = (value: ArrayBuffer | string) => btoa(typeof value === 'string' ? value : String.fromCharCode(...new Uint8Array(value))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const formOptions = (fields: Record<string, string>, headers: Record<string, string> = {}) => ({ method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields).toString() });
async function fixture() {
  let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
  const { sql, env: base } = memoryD1Fixture();
  const principal = 'user:fixture';
  const issuer = 'https://team.cloudflareaccess.com';
  sql.prepare('INSERT INTO user_profiles(tenant_id,principal,status,created_at,updated_at) VALUES(?,?,?,?,?)').run('fixture', principal, 'active', 1, 1);
  sql.prepare("INSERT INTO user_identities(id,tenant_id,principal,provider_type,issuer,subject,created_at,updated_at) VALUES(?,?,?,'oidc',?,?,?,?)").run('fixture-id', 'fixture', principal, issuer, 'synthetic-subject', 1, 1);
  for (const project of ['project-a', 'project-b']) sql.prepare('INSERT INTO principal_role_assignments(id,tenant_id,project_id,principal,role,created_by_principal,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(project, 'fixture', project, principal, 'project_owner', principal, 1, 1);
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1,0,1]), hash: 'SHA-256' }, true, ['sign','verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const head = b64(JSON.stringify({ alg: 'RS256', kid: 'device-fixture' }));
  const payload = b64(JSON.stringify({ iss: issuer, sub: 'synthetic-subject', email: 'fixture@example.test', aud: 'fixture-audience', exp: Math.floor(now/1000) + 3600 }));
  const signature = b64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${head}.${payload}`)));
  const jwt = `${head}.${payload}.${signature}`;
  const env = { ...base, OAUTH_KV: new FixtureKV(), MCP_OAUTH_RESOURCE: resource, MCP_AUTH_MODE: 'oauth',
    ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', MCP_ACCESS_AUD: 'fixture-audience',
    ACCESS_TENANT_POLICY_JSON: JSON.stringify({ default_tenants: ['fixture'], default_role: 'reader' }),
    ACCESS_JWKS_JSON: JSON.stringify({ keys: [{ ...jwk, kid: 'device-fixture', alg: 'RS256', use: 'sig' }] }),
    ORGBRAIN_OAUTH_SECURITY_V2: 'true', API_RATE_LIMITER: { limit: async () => ({ success: true }) } } as unknown as Env;
  const provider = await createCloudflareMcpOAuthProvider(env, () => new Response('fixture', { status: 404 }));
  const fetch = (path: string, options: RequestInit = {}) => provider.fetch(new Request(`${origin}${path}`, options), env, context());
  const browserHeaders = { 'cf-access-jwt-assertion': jwt, 'x-orgbrain-tenant': 'fixture' };
  const register = async () => {
    const response = await fetch('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Synthetic headless client', token_endpoint_auth_method: 'none', grant_types: [DEVICE_GRANT, 'refresh_token'], response_types: [], redirect_uris: [] }) });
    expect(response.status).toBe(201); return (await response.json<any>()).client_id as string;
  };
  const begin = async (clientId: string, fields: Record<string, string> = {}) => {
    const response = await fetch('/oauth/device', formOptions({ client_id: clientId, resource, tenant_id: 'fixture', project_id: 'project-a', principal_id: principal,
      scope: 'orgbrain:read orgbrain:write', ...fields }));
    expect(response.status).toBe(200); return response.json<any>();
  };
  const consent = async (device: any) => {
    const response = await fetch(`/oauth/authorize/device?user_code=${device.user_code}`, { headers: browserHeaders });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('project-a'); expect(html).toContain('orgbrain:write');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    return { fields: { user_code: device.user_code, csrf: html.match(/name="csrf" value="([^"]+)"/)![1], decision: 'approve', confirmed: 'yes' },
      headers: { ...browserHeaders, origin, cookie: response.headers.get('set-cookie')!.split(';')[0] } };
  };
  const approve = async (device: any) => { const c = await consent(device); return fetch('/oauth/authorize/device', formOptions(c.fields, c.headers)); };
  const poll = (clientId: string, device: any, fields: Record<string, string> = {}) => fetch('/oauth/token', formOptions({ grant_type: DEVICE_GRANT, client_id: clientId, device_code: device.device_code, resource, ...fields }));
  const issue = async () => { const id = await register(), device = await begin(id); expect((await approve(device)).status).toBe(200); now += 5000;
    const response = await poll(id, device); expect(response.status).toBe(200); return { id, device, tokens: await response.json<any>() }; };
  const identity = (token: string, project = 'project-a') => fetch(`/mcp/identity?tenant_id=fixture&project_id=${project}`, { headers: { authorization: `Bearer ${token}` } });
  const refresh = (id: string, token: string, fields: Record<string, string> = {}) => fetch('/oauth/token', formOptions({ grant_type: 'refresh_token', client_id: id, refresh_token: token, resource, ...fields }));
  const nativeAuthorization = async (existingId?: string) => {
    let id = existingId;
    if (!id) {
      const registration = await fetch('/oauth/register',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({client_name:'Synthetic native client',token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code'],redirect_uris:['http://127.0.0.1:12345/callback']})});
      expect(registration.status).toBe(201); id = (await registration.json<any>()).client_id;
    }
    const verifier = 'v'.repeat(43), challenge = b64(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier)));
    const url = `/oauth/authorize?${new URLSearchParams({client_id:id!,response_type:'code',redirect_uri:'http://127.0.0.1:12345/callback',resource,scope:'orgbrain:read orgbrain:write',state:'synthetic-state',code_challenge:challenge,code_challenge_method:'S256'})}`;
    const consent = await fetch(url,{headers:browserHeaders}); expect(consent.status).toBe(200);
    const html = await consent.text(), csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
    const authorized = await fetch(url,formOptions({csrf,confirmed:'yes'},{...browserHeaders,origin,cookie:consent.headers.get('set-cookie')!.split(';')[0]}));
    expect(authorized.status).toBe(302); const code = new URL(authorized.headers.get('location')!).searchParams.get('code')!;
    const exchange = () => fetch('/oauth/token',formOptions({client_id:id!,grant_type:'authorization_code',code,code_verifier:verifier,redirect_uri:'http://127.0.0.1:12345/callback',resource}));
    return { id: id!, exchange };
  };
  return { sql, env, provider, fetch, register, begin, consent, approve, poll, issue, identity, refresh, principal, browserHeaders, nativeAuthorization, advance: (ms: number) => { now += ms; } };
}
describe('opt-in device authorization and strict refresh security', () => {
  it('advertises RFC8628 only when enabled and registers a public device-only client', async () => {
    const f = await fixture();
    try {
      const metadata = await (await f.fetch('/.well-known/oauth-authorization-server')).json<any>();
      expect(metadata.device_authorization_endpoint).toBe(`${origin}/oauth/device`);
      expect(metadata.grant_types_supported).toContain(DEVICE_GRANT);
      const registered = await f.fetch('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'Synthetic headless client', token_endpoint_auth_method: 'none',
          grant_types: [DEVICE_GRANT, 'refresh_token'], response_types: [], redirect_uris: [] }) });
      expect(registered.status).toBe(201);
      const client = await registered.json<any>();
      expect(client.grant_types).toEqual([DEVICE_GRANT, 'refresh_token']);
      expect(client.client_secret).toBeUndefined();
      expect(f.sql.prepare('SELECT count(*) AS n FROM oauth_device_clients').get()!.n).toBe(1);
    } finally { f.sql.close(); }
  });
  it('hashes codes, enforces polling intervals/slow_down and consumes approved authorization once', async () => {
    const f = await fixture();
    try {
      const id = await f.register(), d = await f.begin(id);
      const row = f.sql.prepare('SELECT * FROM oauth_device_requests').get()!;
      expect(row.device_hash).not.toBe(d.device_code); expect(row.user_hash).not.toBe(d.user_code);
      expect((await (await f.poll(id,d)).json<any>()).error).toBe('slow_down');
      expect(f.sql.prepare('SELECT interval_seconds FROM oauth_device_requests').get()!.interval_seconds).toBe(10);
      f.advance(10_000);
      expect((await (await f.poll(id,d)).json<any>()).error).toBe('authorization_pending');
      expect(f.sql.prepare('SELECT count(*) AS n FROM oauth_grant_families').get()!.n).toBe(0);
      expect((await f.approve(d)).status).toBe(200); f.advance(10_000);
      const redeemed = await Promise.all([f.poll(id,d),f.poll(id,d)]);
      expect(redeemed.filter(response => response.status === 200)).toHaveLength(1);
      expect(f.sql.prepare('SELECT count(*) AS n FROM oauth_grant_families').get()!.n).toBe(1);
      expect((await (await f.poll(id,d)).json<any>()).error).toBe('invalid_grant');
    } finally { f.sql.close(); }
  });
  it('requires authenticated, bound, explicit consent with one-use CSRF and same origin', async () => {
    const f = await fixture();
    try {
      const id = await f.register(), d = await f.begin(id);
      expect((await f.fetch(`/oauth/authorize/device?user_code=${d.user_code}`)).status).toBe(401);
      const c = await f.consent(d);
      for (const [fields,headers] of [[{...c.fields,csrf:'wrong'},c.headers],[{...c.fields,confirmed:'no'},c.headers],
        [c.fields,{...c.headers,origin:'https://evil.example'}],[c.fields,{...c.headers,cookie:''}]] as const) {
        expect((await f.fetch('/oauth/authorize/device',formOptions(fields,headers))).status).toBe(403);
      }
      expect(f.sql.prepare('SELECT state FROM oauth_device_requests').get()!.state).toBe('pending');
      expect((await f.fetch('/oauth/authorize/device',formOptions(c.fields,c.headers))).status).toBe(200);
      expect((await f.fetch('/oauth/authorize/device',formOptions(c.fields,c.headers))).status).toBe(400);
      const wrong = await f.begin(id,{principal_id:'user:another'});
      expect((await f.fetch(`/oauth/authorize/device?user_code=${wrong.user_code}`,{headers:f.browserHeaders})).status).toBe(403);
    } finally { f.sql.close(); }
  });
  it('rejects denied, expired, wrong-client/resource and guessed device credentials', async () => {
    const f = await fixture();
    try {
      const a = await f.register(), b = await f.register(), d = await f.begin(a);
      expect((await (await f.poll(b,d)).json<any>()).error).toBe('invalid_grant');
      expect((await (await f.poll(a,d,{resource:'https://evil.example/mcp'})).json<any>()).error).toBe('invalid_grant');
      expect((await (await f.poll(a,{device_code:'unrecognized'})).json<any>()).error).toBe('invalid_grant');
      const c = await f.consent(d);
      expect((await f.fetch('/oauth/authorize/device',formOptions({...c.fields,decision:'deny',confirmed:'no'},c.headers))).status).toBe(200);
      f.advance(5000); expect((await (await f.poll(a,d)).json<any>()).error).toBe('access_denied');
      const exp = await f.begin(a); f.advance(600_000);
      expect((await (await f.poll(a,exp)).json<any>()).error).toBe('expired_token');
      expect((await f.fetch(`/oauth/authorize/device?user_code=${exp.user_code}`,{headers:f.browserHeaders})).status).toBe(400);
      expect(f.sql.prepare('SELECT count(*) AS n FROM oauth_grant_families').get()!.n).toBe(0);
    } finally { f.sql.close(); }
  });
  it('budgets unknown user-code guesses and fails closed if platform limiting or D1 is unavailable', async () => {
    const f = await fixture();
    try {
      for (let n=0;n<10;n++) expect((await f.fetch(`/oauth/authorize/device?user_code=AAAAAAA${String.fromCharCode(65+n)}`,{headers:f.browserHeaders})).status).toBe(400);
      expect((await f.fetch('/oauth/authorize/device?user_code=BBBBBBBB',{headers:f.browserHeaders})).status).toBe(429);
      f.advance(60_000); f.env.API_RATE_LIMITER = { limit: async () => ({success:false}) } as any;
      expect((await f.fetch('/oauth/authorize/device?user_code=CCCCCCCC',{headers:f.browserHeaders})).status).toBe(429);
      f.env.API_RATE_LIMITER = { limit: async () => ({success:true}) } as any;
      vi.spyOn(f.env.OPEN_BRAIN_DB,'prepare').mockImplementation(() => { throw Error('synthetic storage unavailable'); });
      expect((await f.fetch('/oauth/authorize/device?user_code=CCCCCCCC',{headers:f.browserHeaders})).status).not.toBe(200);
    } finally { f.sql.close(); }
  });
  it('blocks device-client public auth-code paths even after disabling the flag', async () => {
    const f = await fixture();
    try {
      const id = await f.register();
      for (const flag of ['true','false'] as const) {
        f.env.ORGBRAIN_OAUTH_SECURITY_V2 = flag;
        expect((await (await f.fetch(`/oauth/authorize?client_id=${id}`)).json<any>()).error).toBe('unauthorized_client');
        expect((await (await f.fetch('/oauth/token',formOptions({client_id:id,grant_type:'authorization_code',code:'guessed'}))).json<any>()).error).toBe('unauthorized_client');
      }
      const metadata = await (await f.fetch('/.well-known/oauth-authorization-server')).json<any>();
      expect(metadata.device_authorization_endpoint).toBeUndefined();
    } finally { f.sql.close(); }
  });
  it('rotates refresh tokens, ignores unrelated client/unknown hash, and revokes the whole family on known reuse', async () => {
    const f = await fixture();
    try {
      const a = await f.issue(), b = await f.issue();
      expect((await f.refresh(b.id,a.tokens.refresh_token)).status).toBe(400);
      const guessed = `${a.tokens.refresh_token.split(':').slice(0,2).join(':')}:guessed`;
      expect((await f.refresh(a.id,guessed)).status).toBe(400);
      expect((await f.identity(a.tokens.access_token)).status).toBe(200);
      const rotated = await f.refresh(a.id,a.tokens.refresh_token); expect(rotated.status).toBe(200);
      const next = await rotated.json<any>(); expect(next.refresh_token).not.toBe(a.tokens.refresh_token);
      expect((await f.identity(next.access_token)).status).toBe(200);
      expect((await f.refresh(a.id,a.tokens.refresh_token)).status).toBe(400);
      expect((await f.identity(next.access_token)).status).toBe(401);
      expect((await f.refresh(a.id,next.refresh_token)).status).toBe(400);
      expect((await f.identity(b.tokens.access_token)).status).toBe(200);
      expect(f.sql.prepare("SELECT count(*) AS n FROM oauth_grant_families WHERE state='revoked'").get()!.n).toBe(1);
    } finally { f.sql.close(); }
  });
  it('prevents in-flight refresh from reviving a family when replay revokes it and KV resurrects its grant', async () => {
    const f = await fixture();
    try {
      const a = await f.issue();
      const kv = f.env.OAUTH_KV as unknown as FixtureKV;
      let release!: () => void, reached!: () => void;
      const arrived = new Promise<void>(resolve => { reached = resolve; });
      const paused = new Promise<void>(resolve => { release = resolve; });
      const put = kv.put.bind(kv); let delayed = false;
      vi.spyOn(kv,'put').mockImplementation(async (key,value) => {
        if (key.startsWith('grant:') && !delayed) { delayed = true; reached(); await paused; }
        await put(key,value);
      });
      const first = f.refresh(a.id,a.tokens.refresh_token);
      await arrived;
      expect((await f.refresh(a.id,a.tokens.refresh_token)).status).toBe(400);
      release(); expect((await first).status).toBe(400);
      expect(f.sql.prepare('SELECT state FROM oauth_grant_families').get()!.state).toBe('revoked');
      expect((await f.identity(a.tokens.access_token)).status).toBe(401);
      expect(f.sql.prepare("SELECT count(*) AS n FROM oauth_refresh_tokens WHERE state='active'").get()!.n).toBe(0);
    } finally { f.sql.close(); }
  });
  it('enforces active users and existing project permissions again after approval and on refresh', async () => {
    const f = await fixture();
    try {
      const a = await f.issue();
      f.sql.prepare("UPDATE user_profiles SET status='suspended'").run();
      expect((await f.identity(a.tokens.access_token)).status).toBe(401);
      expect((await f.refresh(a.id,a.tokens.refresh_token)).status).toBe(400);
      f.sql.prepare("UPDATE user_profiles SET status='active'").run();
      const id = await f.register(), d = await f.begin(id); expect((await f.approve(d)).status).toBe(200);
      f.sql.prepare("DELETE FROM principal_role_assignments WHERE project_id='project-a'").run(); f.advance(5000);
      expect((await (await f.poll(id,d)).json<any>()).error).toBe('access_denied');
      expect(f.sql.prepare('SELECT count(*) AS n FROM oauth_grant_families').get()!.n).toBe(1);
    } finally { f.sql.close(); }
  });
  it('two independently authorized headless JS clients share reviewed project memory, refresh and logout, while direct project escapes are rejected', async () => {
    const f = await fixture();
    const runtime = (globalThis as any).process;
    const { mkdtemp, rm } = runtime.getBuiltinModule('node:fs/promises');
    const { tmpdir } = runtime.getBuiltinModule('node:os');
    const { join } = runtime.getBuiltinModule('node:path');
    const directory = await mkdtemp(join(tmpdir(),'orgbrain-device-client-'));
    try {
      const clientModule = '../../../packages/orgbrain-cli/src/remote-oauth-client.mjs';
      const storeModule = '../../../packages/orgbrain-cli/src/lib/remote-private-store.mjs';
      const requestModule = '../../../packages/orgbrain-cli/src/lib/mcp-modern-request.mjs';
      const { OrgBrainRemoteClient } = await import(clientModule), { RemotePrivateStore } = await import(storeModule);
      const { modernMcpHeaders, modernMcpRequest } = await import(requestModule);
      const makeClient = (profile: string) => {
        const store = new RemotePrivateStore({ directory, profile });
        const client = new OrgBrainRemoteClient({ store, fetchImpl: (url: string, options: RequestInit) => {
          expect(new URL(url).origin).toBe(origin); return f.fetch(new URL(url).pathname + new URL(url).search,options);
        }, sleep: async (ms: number) => f.advance(ms), now: Date.now,
          receiver: async () => { throw Error('headless device login must never open loopback'); } });
        const onAuthorize = async (d: any) => { expect(d.mode).toBe('device'); expect(d.url).toBe(`${origin}/oauth/authorize/device`);
          // Signed synthetic user JWT visits the actual consent GET+POST. No
          // trusted completeAuthorization helper substitutes for this consent.
          expect((await f.approve(d)).status).toBe(200); };
        return { client, store, onAuthorize };
      };
      const a = makeClient('a'), b = makeClient('b');
      const binding = { resource, tenant_id:'fixture', principal:f.principal, project_id:'project-a' };
      await a.client.login(binding,{mode:'device',onAuthorize:a.onAuthorize});
      await b.client.login(binding,{mode:'device',onAuthorize:b.onAuthorize});
      const pa = await a.store.read(), pb = await b.store.read(); expect(pa.client_id).not.toBe(pb.client_id);
      const conversation = { schema_version:'conversation-memory/v1',tenant_id:'fixture',project_id:'project-a',session_id:'fixture-session',
        event_id:'fixture-device-event',occurred_at:'2026-10-04T09:00:00Z',producer:'manual',
        sources:[{id:'fixture-source',role:'user',ref:'fixture:synthetic',text:'Use synthetic shared-memory checks.'}],
        candidates:[{id:'fixture-decision',kind:'decision',claim_type:'user_decision',conclusion:'Use synthetic shared-memory checks.',
          rationale:'The fixture contains no private data.',reuse_rule:'Synthetic tests only.',source_ids:['fixture-source']}] };
      const preview = await a.client.stage(conversation);
      const staged = await a.client.stage(conversation,{execute:true,expectedPlanHash:preview.plan_hash});
      expect(staged.active_memories_created).toBe(0); expect(staged.pending_created).toBe(1);
      expect((await b.client.search('synthetic')).results).toHaveLength(0);
      const receipt = staged.receipts[0];
      await expect(b.client.confirm({confirmation_token:receipt.confirmation_token,approved:true})).rejects.toThrow('actual_review_and_guard_required');
      const confirmed = await b.client.confirm({confirmation_token:receipt.confirmation_token,approved:true,review_answer:'保存する',
        expected_candidate_hash:receipt.candidate_hash,expected_revision:receipt.revision});
      expect(confirmed.saved).toBe(true);
      expect((await a.client.search('synthetic')).results.map((r:any)=>r.id)).toContain(confirmed.memory_id);
      await a.client.refresh();
      expect((await b.client.search('synthetic')).results.map((r:any)=>r.id)).toContain(confirmed.memory_id);
      const access = (await a.store.read()).access_token;
      expect((await f.identity(access,'project-b')).status).toBe(403);
      const call = (name: string,args: any) => f.fetch('/mcp',{method:'POST',headers:{...modernMcpHeaders('tools/call',name),authorization:`Bearer ${access}`},
        body:JSON.stringify(modernMcpRequest({id:1,method:'tools/call',name,params:{arguments:args}}))});
      expect((await call('orgbrain_memories_search',{tenant_id:'fixture',project_id:'project-b',strict_project:true,search_scope:'evidence',q:'synthetic'})).status).toBe(403);
      expect((await call('orgbrain_memories_search',{tenant_id:'fixture',project_id:'project-a',q:'synthetic'})).status).toBe(403);
      expect((await call('orgbrain_memories_search',{tenant_id:'fixture',project_id:'project-a',strict_project:true,search_scope:'both',q:'synthetic'})).status).toBe(403);
      expect((await call('orgbrain_conversation_memories_stage',{tenant_id:'fixture',conversation:{...conversation,project_id:'project-b'}})).status).toBe(403);
      expect((await call('orgbrain_memories_upsert',{tenant_id:'fixture',items:[]})).status).toBe(403);
      // The user owns both projects: only the device grant's fixed project is
      // limiting this direct request, not absence of project-b role assignment.
      const qid = await f.register(), qd = await f.begin(qid,{project_id:'project-b'});
      const qr = await f.fetch(`/oauth/authorize/device?user_code=${qd.user_code}`,{headers:f.browserHeaders}); expect(qr.status).toBe(200);
      const qhtml = await qr.text();
      expect((await f.fetch('/oauth/authorize/device',formOptions({user_code:qd.user_code,csrf:qhtml.match(/name="csrf" value="([^"]+)"/)![1],decision:'approve',confirmed:'yes'},
        {...f.browserHeaders,origin,cookie:qr.headers.get('set-cookie')!.split(';')[0]}))).status).toBe(200);
      f.advance(5000); const qt = await (await f.poll(qid,qd)).json<any>();
      const qstatus = await f.fetch('/mcp',{method:'POST',headers:{...modernMcpHeaders('tools/call','orgbrain_memories_confirmation_status'),authorization:`Bearer ${qt.access_token}`},
        body:JSON.stringify(modernMcpRequest({id:1,method:'tools/call',name:'orgbrain_memories_confirmation_status',params:{arguments:{tenant_id:'fixture',confirmation_token:receipt.confirmation_token}}}))});
      expect(qstatus.status).toBe(403);
      const qconfirm = await f.fetch('/mcp',{method:'POST',headers:{...modernMcpHeaders('tools/call','orgbrain_memories_confirm'),authorization:`Bearer ${qt.access_token}`},
        body:JSON.stringify(modernMcpRequest({id:1,method:'tools/call',name:'orgbrain_memories_confirm',params:{arguments:{tenant_id:'fixture',confirmation_token:receipt.confirmation_token,
          approved:true,review_answer:'保存する',expected_candidate_hash:receipt.candidate_hash,expected_revision:receipt.revision}}}))});
      expect(qconfirm.status).toBe(403);
      const fetchA = a.client.fetch;
      a.client.fetch = async (url: string, options: RequestInit) => {
        const response = await fetchA(url, options);
        if (new URL(url).pathname === '/oauth/token' && new URLSearchParams(String(options.body)).get('grant_type') === 'refresh_token') {
          throw Error('synthetic lost rotated response');
        }
        return response;
      };
      await expect(a.client.refresh()).rejects.toThrow('reauthentication_required');
      expect((await a.store.read()).access_token).toBeUndefined();
      expect((await a.store.read()).revocation.refresh_token).toBeDefined();
      await expect(a.client.refresh()).rejects.toThrow('login_required');
      expect((await a.client.logout()).remote_revoked).toBe(true);
      expect((await f.identity(access)).status).toBe(401);
      expect((await b.client.search('synthetic')).results).toHaveLength(1);
      expect(f.sql.prepare('SELECT count(*) AS n FROM memories').get()!.n).toBe(1);
    } finally { f.sql.close(); await rm(directory,{recursive:true,force:true}); }
  },15_000);
  it('durable family denial blocks a valid access token despite a completely stale KV and rejects revocation through guessed prefixes', async () => {
    const f = await fixture();
    try {
      const a = await f.issue();
      const kv = f.env.OAUTH_KV as unknown as FixtureKV;
      const snapshot = new Map(kv.values);
      const guessed = `${a.tokens.refresh_token.split(':').slice(0,2).join(':')}:guessed`;
      expect((await f.fetch('/oauth/token',formOptions({client_id:a.id,token:guessed,token_type_hint:'refresh_token'}))).status).toBe(200);
      expect((await f.identity(a.tokens.access_token)).status).toBe(200);
      expect((await f.refresh(a.id,a.tokens.refresh_token)).status).toBe(200);
      expect((await f.refresh(a.id,a.tokens.refresh_token)).status).toBe(400);
      kv.values = snapshot;
      expect(await f.env.OAUTH_PROVIDER!.unwrapToken(a.tokens.access_token)).not.toBeNull();
      expect((await f.identity(a.tokens.access_token)).status).toBe(401);
      f.env.ORGBRAIN_OAUTH_SECURITY_V2 = 'false';
      expect((await f.identity(a.tokens.access_token)).status).toBe(401);
    } finally { f.sql.close(); }
  });
  it('revokes after upstream refresh failure and accepts revocation of a used old refresh token', async () => {
    const f = await fixture();
    try {
      const a = await f.issue(), b = await f.issue();
      const kv = f.env.OAUTH_KV as unknown as FixtureKV;
      const get = kv.get.bind(kv);
      vi.spyOn(kv,'get').mockImplementation(async(key,options)=> { if(key.startsWith('grant:')) throw Error('synthetic unavailable'); return get(key,options); });
      expect((await f.refresh(a.id,a.tokens.refresh_token)).status).toBe(400);
      vi.mocked(kv.get).mockRestore();
      expect((await f.identity(a.tokens.access_token)).status).toBe(401);
      expect((await f.refresh(b.id,b.tokens.refresh_token)).status).toBe(200);
      expect((await f.fetch('/oauth/token',formOptions({client_id:b.id,token:b.tokens.refresh_token,token_type_hint:'refresh_token'}))).status).toBe(200);
      expect(f.sql.prepare("SELECT count(*) AS n FROM oauth_grant_families WHERE state='revoked'").get()!.n).toBe(2);
    } finally { f.sql.close(); }
  });
  it('keeps native V2 refresh replay enforcement and revocation when the feature is disabled', async () => {
    const f = await fixture();
    try {
      const auth = await f.nativeAuthorization();
      const initial = await auth.exchange(); expect(initial.status).toBe(200); const old = await initial.json<any>();
      f.env.ORGBRAIN_OAUTH_SECURITY_V2 = 'false';
      const refreshed = await f.refresh(auth.id,old.refresh_token); expect(refreshed.status).toBe(200); const next = await refreshed.json<any>();
      expect((await f.identity(next.access_token)).status).toBe(200);
      expect((await f.refresh(auth.id,old.refresh_token)).status).toBe(400);
      const kv = f.env.OAUTH_KV as unknown as FixtureKV;
      // D1 failure must not silently reopen the SDK path either.
      vi.spyOn(f.env.OPEN_BRAIN_DB,'prepare').mockImplementation(() => { throw Error('synthetic unavailable'); });
      expect((await f.refresh(auth.id,next.refresh_token)).status).toBe(503);
      vi.mocked(f.env.OPEN_BRAIN_DB.prepare).mockRestore();
      expect((await f.identity(next.access_token)).status).toBe(401);
      expect(kv.values.size).toBeGreaterThanOrEqual(1); // native registration survives, revoked credentials do not.
    } finally { f.sql.close(); }
  });
  it('rejects an unmarked pre-cutover authorization code and retains ordinary flag-off reauthorization revocation', async () => {
    const f = await fixture();
    try {
      f.env.ORGBRAIN_OAUTH_SECURITY_V2 = 'false';
      const before = await f.nativeAuthorization();
      f.env.ORGBRAIN_OAUTH_SECURITY_V2 = 'true';
      expect((await before.exchange()).status).toBe(400);
      expect(f.sql.prepare('SELECT count(*) AS n FROM oauth_grant_families').get()!.n).toBe(0);
      f.env.ORGBRAIN_OAUTH_SECURITY_V2 = 'false';
      const ordinary = await f.nativeAuthorization(); const tokens = await (await ordinary.exchange()).json<any>();
      expect((await f.identity(tokens.access_token)).status).toBe(200);
      await f.nativeAuthorization(ordinary.id);
      expect((await f.identity(tokens.access_token)).status).toBe(401);
    } finally { f.sql.close(); }
  });
  it('rejects confidential registration and excess scopes in the explicit public-client V2 mode', async () => {
    const f = await fixture();
    try {
      const metadata = await (await f.fetch('/.well-known/oauth-authorization-server')).json<any>();
      expect(metadata.token_endpoint_auth_methods_supported).toEqual(['none']);
      expect(metadata.scopes_supported).toEqual(['orgbrain:read','orgbrain:write']);
      const response = await f.fetch('/oauth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
        client_name:'Synthetic confidential',token_endpoint_auth_method:'client_secret_basic',grant_types:['authorization_code','refresh_token'],redirect_uris:['https://example.test/callback'],response_types:['code']})});
      expect((await response.json<any>()).error).toBe('invalid_client_metadata');
      const id = await f.register();
      const scopes = await f.fetch('/oauth/device',formOptions({client_id:id,resource,tenant_id:'fixture',project_id:'project-a',principal_id:f.principal,scope:'orgbrain:read orgbrain:write orgbrain:admin'}));
      expect((await scopes.json<any>()).error).toBe('invalid_scope');
      expect(f.sql.prepare('SELECT count(*) AS n FROM oauth_device_requests').get()!.n).toBe(0);
    } finally { f.sql.close(); }
  });
  it('expires displayed consent and SDK access tokens and fails closed after replacement storage failure', async () => {
    const f = await fixture();
    try {
      const a = await f.issue();
      const originalBatch = f.env.OPEN_BRAIN_DB.batch.bind(f.env.OPEN_BRAIN_DB);
      vi.spyOn(f.env.OPEN_BRAIN_DB,'batch').mockImplementationOnce(async()=> { throw Error('synthetic replacement storage failed'); });
      expect((await f.refresh(a.id,a.tokens.refresh_token)).status).toBe(400);
      vi.mocked(f.env.OPEN_BRAIN_DB.batch).mockRestore();
      expect(typeof originalBatch).toBe('function');
      expect(f.sql.prepare('SELECT state FROM oauth_grant_families').get()!.state).toBe('revoked');
      const id = await f.register(), d = await f.begin(id), c = await f.consent(d);
      f.advance(600_000);
      expect((await f.fetch('/oauth/authorize/device',formOptions(c.fields,c.headers))).status).toBe(400);
      expect(f.sql.prepare('SELECT state FROM oauth_device_requests WHERE client_id=?').get(id)!.state).toBe('pending');
      const b = await f.issue(); f.advance(600_001);
      expect((await f.identity(b.tokens.access_token)).status).toBe(401);
    } finally { f.sql.close(); }
  });
  it('durably revokes prior native V2 families on flag-off reauthorization despite concurrent refresh and stale KV', async () => {
    const f = await fixture();
    try {
      const auth = await f.nativeAuthorization(), initial = await auth.exchange(), tokens = await initial.json<any>();
      const kv = f.env.OAUTH_KV as unknown as FixtureKV, snapshot = new Map(kv.values);
      let release!:()=>void,reached!:()=>void;
      const paused = new Promise<void>(resolve=> {release=resolve;}), arrived = new Promise<void>(resolve=> {reached=resolve;});
      const put = kv.put.bind(kv); let delayed=false;
      vi.spyOn(kv,'put').mockImplementation(async(key,value,options)=> { if(key.startsWith('grant:')&&!delayed) {delayed=true;reached();await paused;} await put(key,value,options); });
      const refresh = f.refresh(auth.id,tokens.refresh_token); await arrived;
      f.env.ORGBRAIN_OAUTH_SECURITY_V2 = 'false';
      await f.nativeAuthorization(auth.id);
      expect(f.sql.prepare('SELECT state FROM oauth_grant_families').get()!.state).toBe('revoked');
      release(); expect((await refresh).status).toBe(400);
      kv.values = snapshot;
      expect(await f.env.OAUTH_PROVIDER!.unwrapToken(tokens.access_token)).not.toBeNull();
      expect((await f.identity(tokens.access_token)).status).toBe(401);
    } finally { f.sql.close(); }
  });
  it('allows at most one active refresh credential if SDK native auth-code exchanges race against eventual KV', async () => {
    const f = await fixture();
    try {
      const auth = await f.nativeAuthorization(), kv = f.env.OAUTH_KV as unknown as FixtureKV;
      const get = kv.get.bind(kv); let reads=0,release!:()=>void;
      const paused = new Promise<void>(resolve=> {release=resolve;});
      vi.spyOn(kv,'get').mockImplementation(async(key,options)=> {
        const value = await get(key,options);
        if(key.startsWith('grant:')&&reads<2) { reads++; if(reads===2) release(); await paused; }
        return value;
      });
      const results = await Promise.all([auth.exchange(),auth.exchange()]);
      expect(reads).toBe(2);
      expect(results.filter(r=>r.status===200).length).toBeLessThanOrEqual(1);
      expect(f.sql.prepare("SELECT count(*) AS n FROM oauth_refresh_tokens WHERE state='active'").get()!.n).toBeLessThanOrEqual(1);
      expect(f.sql.prepare('SELECT state FROM oauth_grant_families').get()!.state).toBe('revoked');
      for (const r of results.filter(r=>r.status===200)) expect((await f.identity((await r.json<any>()).access_token)).status).toBe(401);
    } finally { f.sql.close(); }
  });
});


const revocationChanges = ['identity-delete','identity-rebind','tenant-grant','suspend','default-role','project-role'] as const;
type RevocationChange = typeof revocationChanges[number];
function prepareChange(f: Awaited<ReturnType<typeof fixture>>, change: RevocationChange) {
 if(change==='default-role') {
  f.sql.prepare('DELETE FROM principal_role_assignments').run();
  f.env.ACCESS_TENANT_POLICY_JSON=JSON.stringify({default_tenants:['fixture'],default_role:'contributor'});
 }
}
function revokeIdentityOrRole(f: Awaited<ReturnType<typeof fixture>>, change: RevocationChange) {
 if(change==='identity-delete') f.sql.prepare('DELETE FROM user_identities').run();
 if(change==='identity-rebind') f.sql.prepare("UPDATE user_identities SET principal='user:other'").run();
 if(change==='tenant-grant') f.env.ACCESS_TENANT_POLICY_JSON=JSON.stringify({default_tenants:['other'],default_role:'reader'});
 if(change==='suspend') f.sql.prepare("UPDATE user_profiles SET status='suspended'").run();
 if(change==='default-role') f.env.ACCESS_TENANT_POLICY_JSON=JSON.stringify({default_tenants:['fixture'],default_role:'reader'});
 if(change==='project-role') f.sql.prepare("UPDATE principal_role_assignments SET role='reader' WHERE project_id='project-a'").run();
}

describe('current verified identity and authorization lifecycle',()=>{
 it('revokes fixed-project families on direct refresh without a prior bearer request',async()=>{
  for(const change of revocationChanges) {const f=await fixture();try {
   prepareChange(f,change); const a=await f.issue(); revokeIdentityOrRole(f,change);
   expect((await f.refresh(a.id,a.tokens.refresh_token)).status,change).toBe(400);
   expect(f.sql.prepare('SELECT state FROM oauth_grant_families').get()!.state,change).toBe('revoked');
   expect((await f.identity(a.tokens.access_token)).status,change).toBe(401);
  }finally{f.sql.close();vi.restoreAllMocks();}}
 },15000);
 it('revokes fixed-project families at bearer acceptance after identity or permission loss',async()=>{
  for(const change of revocationChanges) {const f=await fixture();try {
   prepareChange(f,change); const a=await f.issue(); revokeIdentityOrRole(f,change);
   expect((await f.identity(a.tokens.access_token)).status,change).toBe(401);
   expect(f.sql.prepare('SELECT state FROM oauth_grant_families').get()!.state,change).toBe('revoked');
   expect((await f.refresh(a.id,a.tokens.refresh_token)).status,change).toBe(400);
  }finally{f.sql.close();vi.restoreAllMocks();}}
 },15000);
 it('rechecks identity and fixed-project permissions between approval and exchange',async()=>{
  for(const change of revocationChanges) {const f=await fixture();try {
   prepareChange(f,change); const id=await f.register(),device=await f.begin(id);
   expect((await f.approve(device)).status).toBe(200); revokeIdentityOrRole(f,change); f.advance(5000);
   const response=await f.poll(id,device); expect(response.status,change).toBe(400);
   expect((await response.json<any>()).error,change).toBe('access_denied');
   expect(f.sql.prepare('SELECT count(*) AS n FROM oauth_grant_families').get()!.n).toBe(0);
  }finally{f.sql.close();vi.restoreAllMocks();}}
 },15000);
 it('native V2 identity/grant loss denies exchange and revokes issued families even on rollback',async()=>{
  for(const change of ['identity-delete','identity-rebind','tenant-grant','suspend'] as const) {
   for(const route of ['exchange','bearer','refresh']) {const f=await fixture();try {
    const auth=await f.nativeAuthorization();
    if(route==='exchange') {revokeIdentityOrRole(f,change);expect((await auth.exchange()).status,change).toBe(400);}
    else {const response=await auth.exchange();expect(response.status).toBe(200);const tokens=await response.json<any>();
     revokeIdentityOrRole(f,change);f.env.ORGBRAIN_OAUTH_SECURITY_V2='false';
     if(route==='refresh') expect((await f.refresh(auth.id,tokens.refresh_token)).status,change).toBe(400);
     else expect((await f.identity(tokens.access_token)).status,change).toBe(401);
     expect(f.sql.prepare('SELECT state FROM oauth_grant_families').get()!.state).toBe('revoked');
    }
   }finally{f.sql.close();vi.restoreAllMocks();}}
  }
 },20000);
 it('uses current native role at the actual target without requiring tenant-wide project permission',async()=>{
  const modulePath='../../../packages/orgbrain-cli/src/lib/mcp-modern-request.mjs';
  const {modernMcpHeaders,modernMcpRequest}=await import(modulePath);
  for(const mode of ['project-assignment','policy-default']) {const f=await fixture();try {
   if(mode==='policy-default') prepareChange(f,'default-role');
   const auth=await f.nativeAuthorization(),response=await auth.exchange();expect(response.status).toBe(200);
   const tokens=await response.json<any>();
   const call=async(token:string)=>{const name='orgbrain_conversation_memories_stage';
    const conversation={schema_version:'conversation-memory/v1',tenant_id:'fixture',project_id:'project-a',session_id:'fixture-session',
     event_id:'native-role-event',occurred_at:'2026-10-04T09:00:00Z',producer:'manual',
     sources:[{id:'source',role:'user',ref:'fixture:synthetic',text:'Use synthetic checks.'}],
     candidates:[{id:'decision',kind:'decision',claim_type:'user_decision',conclusion:'Use synthetic checks.',rationale:'No private data.',reuse_rule:'Tests only.',source_ids:['source']}]};
    const rpc=await f.fetch('/mcp',{method:'POST',headers:{...modernMcpHeaders('tools/call',name),authorization:`Bearer ${token}`},
     body:JSON.stringify(modernMcpRequest({id:1,method:'tools/call',name,params:{arguments:{tenant_id:'fixture',conversation}}}))});
    return rpc.json<any>();
   };
   const before=await call(tokens.access_token);expect(before.error).toBeUndefined();expect(before.result.isError).not.toBe(true);
   if(mode==='project-assignment') f.sql.prepare("UPDATE principal_role_assignments SET role='reader' WHERE project_id='project-a'").run();
   else revokeIdentityOrRole(f,'default-role');
   const denied=await call(tokens.access_token);expect(Boolean(denied.error||denied.result?.isError)).toBe(true);
   // An unbound native scope is only an upper limit. Refresh has no target:
   // it stays valid, while old and new bearer writes use current target RBAC.
   const refreshed=await f.refresh(auth.id,tokens.refresh_token);expect(refreshed.status).toBe(200);
   const after=await call((await refreshed.json<any>()).access_token);expect(Boolean(after.error||after.result?.isError)).toBe(true);
   expect(f.sql.prepare('SELECT count(*) AS n FROM memories').get()!.n).toBe(0);
  }finally{f.sql.close();vi.restoreAllMocks();}}
 },15000);
});
