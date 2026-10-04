import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, chmod, symlink, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { OrgBrainRemoteClient, loopbackReceiver } from '../packages/orgbrain-cli/src/remote-oauth-client.mjs';
import { RemotePrivateStore } from '../packages/orgbrain-cli/src/lib/remote-private-store.mjs';
import { DEVICE_GRANT } from '../packages/orgbrain-cli/src/lib/remote-oauth-http.mjs';
import { planConversationMemory } from '../packages/shared/src/conversation-memory-runtime.mjs';

const origin = 'https://orgbrain.example'; const resource = `${origin}/mcp`;
const binding = { resource, tenant_id: 'fixture', project_id: 'project-a', principal: 'user:fixture' };
const scopes = ['orgbrain:read', 'orgbrain:write'];
const execFileAsync = promisify(execFile);
const cli = process.env.ORGBRAIN_REMOTE_CLI_ENTRY ?? new URL('../packages/orgbrain-cli/src/local-memory.mjs', import.meta.url).pathname;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fixture = () => ({ schema_version: 'conversation-memory/v1', tenant_id: 'fixture', project_id: 'project-a',
  session_id: 'fixture-session', event_id: 'fixture-event', occurred_at: '2026-10-04T09:00:00Z', producer: 'manual',
  sources: [{ id: 'fixture-source', role: 'user', ref: 'fixture:synthetic', text: 'Use synthetic shared-memory checks.' }],
  candidates: [{ id: 'fixture-decision', kind: 'decision', claim_type: 'user_decision',
    conclusion: 'Use synthetic shared-memory checks.', rationale: 'The fixture contains no private data.',
    reuse_rule: 'Synthetic tests only.', source_ids: ['fixture-source'] }] });

function serverFixture() {
  const state = { clock: 1000, registrations: 0, grants: 0, refreshes: 0, revokes: 0, rpcCalls: [],
    challenge: null, identityPatch: {}, tokenPatch: {}, metadataPatch: {}, tokens: new Map(), active: [],
    confirmations: new Map(), pendingPolls: [], device: false, refreshError: null, beforeRefresh: null };
  const tokens = clientId => {
    const index = ++state.grants;
    const result = { access_token: `usr_fixture:grant${index}:access`, refresh_token: `usr_fixture:grant${index}:refresh`,
      token_type: 'Bearer', scope: scopes.join(' '), expires_in: 600, resource, ...state.tokenPatch };
    state.tokens.set(result.access_token, clientId); return result;
  };
  const fetchImpl = async (raw, options = {}) => {
    assert.equal(options.redirect, 'error');
    const url = new URL(raw);
    assert.equal(url.origin, origin, 'credentials cannot reach an unpinned origin');
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp') return json({ resource, authorization_servers: [origin] });
    if (url.pathname === '/.well-known/oauth-authorization-server') return json({ issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`, revocation_endpoint: `${origin}/oauth/token`,
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: scopes,
      ...(state.device ? { device_authorization_endpoint: `${origin}/oauth/device`, grant_types_supported: [DEVICE_GRANT] } : {}),
      ...state.metadataPatch });
    if (url.pathname === '/oauth/register') {
      const body = JSON.parse(options.body); assert.equal(body.token_endpoint_auth_method, 'none');
      return json({ client_id: `fixture-client-${++state.registrations}`, token_endpoint_auth_method: 'none' });
    }
    if (url.pathname === '/oauth/device') return json({ device_code: 'fixture-device-secret', user_code: 'ABCD-EFGH',
      verification_uri: `${origin}/oauth/verify`, interval: 1, expires_in: 60 });
    if (url.pathname === '/oauth/token') {
      const form = new URLSearchParams(options.body);
      if (form.has('token')) { state.revokes++; return new Response('', { status: 200 }); }
      assert.equal(form.get('resource'), resource);
      if (form.get('grant_type') === 'authorization_code') {
        assert.equal(form.get('code'), 'fixture-code');
        assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), state.challenge);
      } else if (form.get('grant_type') === 'refresh_token') {
        state.refreshes++; if (state.beforeRefresh) await state.beforeRefresh();
        if (state.refreshError) return json({ error: state.refreshError, error_description: 'NEVER-LOG-fixture-secret' }, 400);
      } else {
        assert.equal(form.get('grant_type'), DEVICE_GRANT);
        assert.equal(form.get('device_code'), 'fixture-device-secret');
        const error = state.pendingPolls.shift(); if (error) return json({ error }, 400);
      }
      return json(tokens(form.get('client_id')));
    }
    assert.ok(state.tokens.has(options.headers.authorization?.slice(7)), 'requires an issued synthetic access token');
    if (url.pathname === '/mcp/identity') return json({ ...binding, project_id: url.searchParams.get('project_id'), scopes, ...state.identityPatch });
    assert.equal(url.pathname, '/mcp');
    const rpc = JSON.parse(options.body); const args = rpc.params.arguments; state.rpcCalls.push(rpc);
    assert.equal(options.headers['MCP-Protocol-Version'], '2026-07-28');
    let result;
    if (rpc.params.name === 'orgbrain_conversation_memories_stage') {
      const plan = planConversationMemory(args.conversation);
      const token = 'C' + 'A'.repeat(25);
      state.confirmations.set(token, { tenant_id: args.tenant_id, project_id: plan.project_id,
        candidate_hash: plan.candidates[0].candidate_hash, revision: 1, status: 'pending' });
      result = { ...plan, executed: true, pending_created: 1, active_memories_created: 0,
        receipts: [{ id: plan.candidates[0].id, candidate_hash: plan.candidates[0].candidate_hash,
          confirmation_token: token, status: 'pending', revision: 1, confirmation_guard_required: true }] };
    } else if (rpc.params.name === 'orgbrain_memories_confirmation_status') result = state.confirmations.get(args.confirmation_token);
    else if (rpc.params.name === 'orgbrain_memories_confirm') {
      const status = state.confirmations.get(args.confirmation_token);
      assert.equal(args.expected_candidate_hash, status.candidate_hash); assert.equal(args.expected_revision, status.revision);
      assert.equal(args.review_answer, 'Synthetic fixture approval only.');
      status.status = 'saved';
      state.active.push({ project_id: status.project_id, id: 'synthetic-memory', content: 'synthetic-marker' });
      result = { saved: true, memory_id: 'synthetic-memory', tenant_id: args.tenant_id };
    } else if (rpc.params.name === 'orgbrain_memories_search') {
      assert.equal(args.scope, 'mine');
      assert.equal(args.strict_project, true);
      result = { tenant_id: args.tenant_id, project_id: args.project_id,
        results: state.active.filter(row => row.project_id === args.project_id) };
    } else throw new Error('Unexpected tool');
    return json({ jsonrpc: '2.0', id: 1, result: { structuredContent: result } });
  };
  const receiver = async () => ({ redirectUri: 'http://127.0.0.1:12345/callback', result: Promise.resolve('fixture-code'), close: async () => {} });
  const onAuthorize = ({ url, mode, ...visible }) => {
    if (mode === 'loopback') {
      const u = new URL(url); assert.equal(u.origin, origin); assert.equal(u.searchParams.get('resource'), resource);
      assert.equal(u.searchParams.get('scope'), scopes.join(' ')); assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(u.searchParams.get('state').length, 43); state.challenge = u.searchParams.get('code_challenge');
    } else assert.equal(visible.user_code, 'ABCD-EFGH');
    assert.ok(!JSON.stringify({ url, ...visible }).includes('fixture-device-secret'));
  };
  return { state, fetchImpl, receiver, onAuthorize };
}

async function setup(t, server = serverFixture()) {
  const directory = await mkdtemp(join(tmpdir(), 'orgbrain-oauth-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new RemotePrivateStore({ directory });
  const client = new OrgBrainRemoteClient({ store, fetchImpl: server.fetchImpl, receiver: server.receiver,
    now: () => server.state.clock, sleep: async ms => { server.state.clock += ms; } });
  return { ...server, client, store, directory };
}

test('PKCE login binds resource/user/tenant/project, persists private credentials, and redacts status', async t => {
  const f = await setup(t); const result = await f.client.login(binding, { onAuthorize: f.onAuthorize });
  assert.equal(result.principal, binding.principal); assert.equal(result.project_id, binding.project_id);
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(f.store.path)).mode & 0o777, 0o600);
  assert.ok((await f.store.read()).access_token.includes(':'));
  assert.ok(!JSON.stringify(await f.client.status()).includes('access_token'));
  await assert.rejects(f.client.login(binding, { onAuthorize: f.onAuthorize }), /logout_existing_profile_first/);
});

test('login rejects metadata origin/resource substitution before registering a client', async t => {
  const f = await setup(t); f.state.metadataPatch.token_endpoint = 'https://evil.example/token';
  await assert.rejects(f.client.login(binding, { onAuthorize: f.onAuthorize }), /invalid_endpoint/);
  assert.equal(f.state.registrations, 0); assert.equal(await f.store.read(), null);
});

test('wrong user, tenant or project fails closed and revokes the freshly issued grant', async t => {
  for (const identityPatch of [{ principal: 'user:other' }, { tenant_id: 'other' }, { project_id: 'other' }]) {
    const f = await setup(t); f.state.identityPatch = identityPatch;
    await assert.rejects(f.client.login(binding, { onAuthorize: f.onAuthorize }), /identity_mismatch/);
    assert.equal(f.state.revokes, 1); assert.equal(await f.store.read(), null);
  }
});

test('a wider scope is rejected rather than saved or silently accepted', async t => {
  const f = await setup(t); f.state.tokenPatch.scope = [...scopes, 'orgbrain:admin'].join(' ');
  await assert.rejects(f.client.login(binding, { onAuthorize: f.onAuthorize }), /scope_mismatch/);
  assert.equal(await f.store.read(), null);
  assert.equal(f.state.revokes, 1);
});

test('refresh rejects repeated credentials or substituted identity and revokes new credentials', async t => {
  for (const corrupt of ['repeated', 'identity']) {
    const f = await setup(t); await f.client.login(binding, { onAuthorize: f.onAuthorize });
    if (corrupt === 'repeated') f.state.tokenPatch.refresh_token = (await f.store.read()).refresh_token;
    else f.state.identityPatch.principal = 'user:other';
    await assert.rejects(f.client.refresh(), /reauthentication_required/);
    assert.equal(f.state.revokes, 1);
    assert.equal((await f.store.read()).access_token, undefined);
    const status = await f.client.status();
    assert.equal(status.state, 'reauthentication_required');
    assert.ok(!JSON.stringify(status).includes('token'));
    await assert.rejects(f.client.search('fixture'), /login_required/);
  }
});

test('CLI dry-run is isolated, rejects profile binding overrides and refuses headless live login', async t => {
  const f = await setup(t); const remote = join(f.directory, 'not-created'), sqlite = join(f.directory, 'not-created.sqlite');
  const run = args => execFileAsync(process.execPath, [cli, 'remote', ...args, '--remote-directory', remote],
    { env: { ...process.env, ORGBRAIN_LOCAL_DB: sqlite } });
  const login = ['login', '--mcp-url', resource, '--tenant-id', binding.tenant_id, '--project-id', binding.project_id,
    '--principal-id', binding.principal];
  assert.equal(JSON.parse((await run(login)).stdout).dry_run, true);
  assert.deepEqual(JSON.parse((await run(['status'])).stdout), { state: 'logged_out' });
  await assert.rejects(run(['search', 'fixture', '--project-id', 'other']), error => error.stderr.includes('remote_unsupported_option'));
  await assert.rejects(run([...login, '--execute']), error => error.stderr.includes('remote_user_terminal_required'));
  await assert.rejects(run([...login, '--execute=false']), error => error.stderr.includes('remote_unsupported_option'));
  await assert.rejects(run([...login, '--project-id', 'other']), error => error.stderr.includes('remote_unsupported_option'));
  assert.equal(await stat(remote).catch(error => error.code), 'ENOENT');
  assert.equal(await stat(sqlite).catch(error => error.code), 'ENOENT');
});

test('refresh rotation stores uncertainty before exchange and atomically replaces credentials', async t => {
  const f = await setup(t); await f.client.login(binding, { onAuthorize: f.onAuthorize });
  const before = await f.store.read();
  f.state.beforeRefresh = async () => {
    const tombstone = await f.store.read(); assert.equal(tombstone.state, 'reauthentication_required');
    assert.equal(tombstone.refresh_token, undefined); assert.equal(tombstone.access_token, undefined);
  };
  await f.client.refresh(); const after = await f.store.read();
  assert.notEqual(after.refresh_token, before.refresh_token); assert.equal(f.state.refreshes, 1);
  f.state.clock = after.expires_at - 1000;
  await f.client.search('synthetic-marker'); assert.equal(f.state.refreshes, 2);
});

test('invalid/revoked refresh requires fresh authorization; no old token or mutation retry', async t => {
  const f = await setup(t); await f.client.login(binding, { onAuthorize: f.onAuthorize });
  f.state.refreshError = 'invalid_grant';
  await assert.rejects(f.client.refresh(), error => error.message === 'remote_reauthentication_required');
  assert.equal((await f.store.read()).refresh_token, undefined);
  await assert.rejects(f.client.search('fixture'), /login_required/);
  assert.equal(f.state.refreshes, 1); assert.equal(f.state.rpcCalls.length, 0);
});

test('private storage rejects symlinks, permissive credentials and concurrent refresh locks', async t => {
  const f = await setup(t); await f.client.login(binding, { onAuthorize: f.onAuthorize });
  await chmod(f.store.path, 0o644); await assert.rejects(f.store.read(), /private_store_unavailable/);
  await chmod(f.store.path, 0o600);
  const alias = join(f.directory, 'alias'); await symlink(f.directory, alias);
  await assert.rejects(new RemotePrivateStore({ directory: alias }).read(), /private_store_unavailable/);
  let release;
  const blocked = new Promise(ok => { release = ok; });
  let locked; const acquired = new Promise(ok => { locked = ok; });
  const first = f.store.withLock(async () => { locked(); await blocked; });
  await acquired; await assert.rejects(f.client.refresh(), /profile_locked/);
  release(); await first; assert.equal(f.state.refreshes, 0);
  await f.store.clear(); await execFileAsync('mkfifo', ['-m', '600', f.store.path]);
  await assert.rejects(f.client.status(), /private_store_unavailable/);
});

test('two independently authorized synthetic clients stage/review/read the same project and isolate another', async t => {
  const server = serverFixture(); const a = await setup(t, server), b = await setup(t, server), q = await setup(t, server);
  await a.client.login(binding, { onAuthorize: server.onAuthorize });
  await b.client.login(binding, { onAuthorize: server.onAuthorize });
  await q.client.login({ ...binding, project_id: 'project-b' }, { onAuthorize: server.onAuthorize });
  assert.notEqual((await a.store.read()).client_id, (await b.store.read()).client_id);
  assert.notEqual((await a.store.read()).refresh_token, (await b.store.read()).refresh_token);
  const input = fixture(); const preview = await a.client.stage(input);
  const staged = await a.client.stage(input, { execute: true, expectedPlanHash: preview.plan_hash });
  const receipt = staged.receipts[0]; assert.equal((await b.client.search('synthetic-marker')).results.length, 0);
  await assert.rejects(b.client.confirm({ confirmation_token: receipt.confirmation_token, approved: true }), /actual_review_and_guard/);
  await assert.rejects(q.client.confirmationStatus(receipt.confirmation_token), /confirmation_binding_mismatch/);
  await b.client.confirm({ confirmation_token: receipt.confirmation_token, approved: true,
    expected_candidate_hash: receipt.candidate_hash, expected_revision: 1, review_answer: 'Synthetic fixture approval only.' });
  assert.equal((await a.client.search('synthetic-marker')).results[0].id, 'synthetic-memory');
  assert.equal((await b.client.search('synthetic-marker')).results[0].id, 'synthetic-memory');
  assert.equal((await q.client.search('synthetic-marker')).results.length, 0);
  await assert.rejects(q.client.stage(input), /conversation_binding_mismatch/);
});

test('network/server error bodies containing secrets are never returned, and logout still clears locally', async t => {
  const f = await setup(t); await f.client.login(binding, { onAuthorize: f.onAuthorize });
  f.client.fetch = async () => { throw Error('access-token=NEVER-LOG-fixture-secret'); };
  await assert.rejects(f.client.search('fixture'), error => error.message === 'remote_network_failed');
  assert.deepEqual(await f.client.logout(), { state: 'logged_out', remote_revoked: false });
  assert.equal(await f.store.read(), null);
});

test('logout revokes this client grant and removes its local credentials', async t => {
  const f = await setup(t); await f.client.login(binding, { onAuthorize: f.onAuthorize });
  assert.equal((await f.client.logout()).remote_revoked, true);
  assert.equal(f.state.revokes, 1); assert.equal(await f.store.read(), null);
});

test('existing server without device grant fails before registration/credential issuance', async t => {
  const f = await setup(t);
  await assert.rejects(f.client.login(binding, { mode: 'device', onAuthorize: f.onAuthorize }), /device_flow_not_supported/);
  assert.equal(f.state.registrations, 0); assert.equal(f.state.grants, 0); assert.equal(await f.store.read(), null);
});

test('RFC8628 synthetic server exercises pending/slow_down polling without revealing device_code', async t => {
  const f = await setup(t); f.state.device = true; f.state.pendingPolls = ['authorization_pending', 'slow_down'];
  await f.client.login(binding, { mode: 'device', onAuthorize: f.onAuthorize });
  assert.equal(f.state.clock, 9000); assert.equal((await f.store.read()).principal, binding.principal);
});

test('loopback requires exact state, issuer, host and one-use code, including malformed UTF8 state', async t => {
  const state = 'a'.repeat(43);
  const receiver = await loopbackReceiver({ state, issuer: origin, requireIssuer: true, timeout: 2000 });
  t.after(() => receiver.close());
  for (const query of [{ state: 'é'.repeat(43), iss: origin, code: 'fixture' }, { state, iss: 'https://evil.example', code: 'fixture' }]) {
    assert.equal((await fetch(`${receiver.redirectUri}?${new URLSearchParams(query)}`)).status, 400);
  }
  const uri = `${receiver.redirectUri}?${new URLSearchParams({ state, iss: origin, code: 'fixture-code' })}`;
  assert.equal((await fetch(uri)).status, 200); assert.equal(await receiver.result, 'fixture-code');
  assert.equal((await fetch(uri)).status, 400);
});

test('remote store status/preview do not touch SQLite or Codex directories', async t => {
  const f = await setup(t); assert.deepEqual(await f.client.status(), { state: 'logged_out' });
  assert.equal(await readFile(f.store.path).catch(error => error.code), 'ENOENT');
  const shared = join(f.directory, 'shared'); await mkdir(shared, { mode: 0o755 }); await chmod(shared, 0o755);
  await assert.rejects(new RemotePrivateStore({ directory: shared }).withLock(async () => {}), /private_store_unavailable/);
});
