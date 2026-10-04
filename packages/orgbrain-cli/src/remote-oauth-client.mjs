import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { RemotePrivateStore } from './lib/remote-private-store.mjs';
import { REMOTE_SCOPES, DEVICE_GRANT, RemoteOAuthError, canonicalResource, identifier,
  exactScopes, discoverOrgBrain, jsonRequest, tokenRequest, safeFetch, httpsUrl } from './lib/remote-oauth-http.mjs';
import { modernMcpHeaders, modernMcpRequest } from './lib/mcp-modern-request.mjs';
import { readResponse, ingestRemoteConversationMemory } from './remote-conversation-import.mjs';

const opaque = value => typeof value === 'string' && value.length <= 8192 && /^[\x21-\x7e]+$/u.test(value);
const nonce = () => randomBytes(32).toString('base64url');
const matches = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Authorization-code flow requires a browser that can reach this host's loopback.
// No callback URL/code is accepted through stdin, chat, arguments or a file.
export async function loopbackReceiver({ state, issuer, requireIssuer = false, timeout = 120_000 } = {}) {
  let finish, reject, used = false, timer;
  const result = new Promise((ok, no) => { finish = ok; reject = no; });
  // Avoid an unhandled rejection while DCR/discovery is in progress.
  result.catch(() => {});
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    let url;
    try { url = new URL(request.url, redirectUri); } catch { response.writeHead(400).end('Invalid callback'); return; }
    if (used || request.method !== 'GET' || url.pathname !== '/callback' || request.url.length > 16_384 ||
        request.headers.host !== new URL(redirectUri).host ||
        (request.headers.origin && request.headers.origin !== issuer) ||
        url.searchParams.getAll('state').length !== 1 || !matches(url.searchParams.get('state'), state) ||
        url.searchParams.getAll('iss').length > 1 ||
        (requireIssuer || url.searchParams.has('iss')) && url.searchParams.get('iss') !== issuer) {
      response.writeHead(400).end('Invalid callback'); return;
    }
    if (url.searchParams.has('error')) {
      used = true; response.writeHead(400).end('Authorization was declined');
      reject(new RemoteOAuthError('access_denied')); return;
    }
    if (url.searchParams.getAll('code').length !== 1 || !opaque(url.searchParams.get('code'))) {
      response.writeHead(400).end('Invalid callback'); return;
    }
    used = true; response.writeHead(200).end('Authorization received. Close this window.');
    finish(url.searchParams.get('code'));
  });
  await new Promise((ok, no) => { server.once('error', () => no(new RemoteOAuthError('loopback_unavailable'))); server.listen(0, '127.0.0.1', ok); });
  const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
  timer = setTimeout(() => reject(new RemoteOAuthError('authorization_expired')), timeout);
  return { redirectUri, result, close: async () => {
    clearTimeout(timer); reject(new RemoteOAuthError('authorization_cancelled'));
    server.closeAllConnections(); await new Promise(ok => server.close(ok));
  } };
}

export class OrgBrainRemoteClient {
  constructor({ store = new RemotePrivateStore(), fetchImpl = globalThis.fetch,
    now = Date.now, sleep = ms => new Promise(ok => setTimeout(ok, ms)), receiver = loopbackReceiver } = {}) {
    this.store = store; this.fetch = fetchImpl; this.now = now; this.sleep = sleep; this.receiver = receiver;
  }

  binding(input) {
    return { resource: canonicalResource(input.resource), tenant_id: identifier(input.tenant_id),
      project_id: identifier(input.project_id), principal: identifier(input.principal) };
  }

  validateProfile(profile) {
    if (!profile || profile.version !== 1 || profile.state !== 'authenticated') throw new RemoteOAuthError('login_required');
    const bound = this.binding(profile);
    exactScopes(profile.scopes);
    if (!opaque(profile.access_token) || !opaque(profile.refresh_token) || !opaque(profile.client_id) ||
        !Number.isSafeInteger(profile.expires_at) || profile.issuer !== new URL(bound.resource).origin) {
      throw new RemoteOAuthError('invalid_profile');
    }
    return profile;
  }

  async identity(profile) {
    const url = new URL(`${profile.resource}/identity`);
    url.searchParams.set('tenant_id', profile.tenant_id); url.searchParams.set('project_id', profile.project_id);
    const identity = await jsonRequest(this.fetch, url.href, { headers: { authorization: `Bearer ${profile.access_token}` } });
    if (identity.resource !== profile.resource || identity.tenant_id !== profile.tenant_id ||
        identity.project_id !== profile.project_id || identity.principal !== profile.principal) {
      throw new RemoteOAuthError('identity_mismatch');
    }
    exactScopes(identity.scopes);
    return identity;
  }

  issued(metadata, binding, clientId, tokens, previous) {
    if (!opaque(tokens.access_token) || String(tokens.token_type).toLowerCase() !== 'bearer' ||
        !Number.isSafeInteger(tokens.expires_in) || tokens.expires_in < 1 || tokens.expires_in > 86_400 ||
        !opaque(tokens.refresh_token) || previous && tokens.refresh_token === previous.refresh_token ||
        tokens.resource !== undefined && tokens.resource !== binding.resource) throw new RemoteOAuthError('invalid_token_response');
    exactScopes(tokens.scope ?? (previous ? previous.scopes : null));
    return { version: 1, state: 'authenticated', ...binding, issuer: metadata.issuer,
      client_id: clientId, scopes: [...REMOTE_SCOPES], access_token: tokens.access_token,
      refresh_token: tokens.refresh_token, expires_at: this.now() + tokens.expires_in * 1000 };
  }

  async revoke(profile, metadata) {
    if (!metadata.revocation_endpoint) throw new RemoteOAuthError('revocation_unsupported');
    const response = await safeFetch(this.fetch, metadata.revocation_endpoint, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: profile.client_id, token: profile.refresh_token,
        token_type_hint: 'refresh_token' }).toString() });
    if (!response.ok) throw new RemoteOAuthError('revocation_failed');
  }

  async login(input, { mode = 'loopback', onAuthorize } = {}) {
    const binding = this.binding(input);
    if (!['loopback', 'device'].includes(mode) || typeof onAuthorize !== 'function') throw new RemoteOAuthError('interactive_login_required');
    return this.store.withLock(async () => {
      if (await this.store.read()) throw new RemoteOAuthError('logout_existing_profile_first');
      const metadata = await discoverOrgBrain(this.fetch, binding.resource);
      if (mode === 'device' && (!metadata.device_authorization_endpoint || !metadata.grant_types_supported?.includes(DEVICE_GRANT))) {
        // Check BEFORE client registration: an unsupported flow creates nothing.
        throw new RemoteOAuthError('device_flow_not_supported');
      }
      const state = nonce(), verifier = nonce();
      let receiver, profile, issuedCredentials;
      try {
        if (mode === 'loopback') receiver = await this.receiver({ state, issuer: metadata.issuer,
          requireIssuer: metadata.authorization_response_iss_parameter_supported === true });
        const registration = await jsonRequest(this.fetch, metadata.registration_endpoint, { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'OrgBrain CLI',
            token_endpoint_auth_method: 'none', grant_types: mode === 'device' ? [DEVICE_GRANT, 'refresh_token'] : ['authorization_code', 'refresh_token'],
            response_types: mode === 'device' ? [] : ['code'], redirect_uris: receiver ? [receiver.redirectUri] : [] }) });
        if (!opaque(registration.client_id) || registration.client_secret || registration.token_endpoint_auth_method !== 'none') {
          throw new RemoteOAuthError('invalid_public_client_registration');
        }
        const clientId = registration.client_id;
        let tokens;
        if (mode === 'loopback') {
          const url = new URL(metadata.authorization_endpoint);
          for (const [key, value] of Object.entries({ client_id: clientId, response_type: 'code',
            redirect_uri: receiver.redirectUri, scope: REMOTE_SCOPES.join(' '), resource: binding.resource,
            state, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') })) url.searchParams.set(key, value);
          await onAuthorize({ mode, url: url.href });
          tokens = await tokenRequest(this.fetch, metadata, { grant_type: 'authorization_code', client_id: clientId,
            code: await receiver.result, code_verifier: verifier, redirect_uri: receiver.redirectUri });
        } else {
          tokens = await this.deviceLogin(metadata, clientId, onAuthorize, binding);
        }
        if (opaque(tokens?.refresh_token)) issuedCredentials = { client_id: clientId, refresh_token: tokens.refresh_token };
        profile = this.issued(metadata, binding, clientId, tokens);
        await this.identity(profile);
        await this.store.write(profile);
        return this.summary(profile);
      } catch (error) {
        if (issuedCredentials) await this.revoke(issuedCredentials, metadata).catch(() => {});
        throw error instanceof RemoteOAuthError ? error : new RemoteOAuthError('login_failed');
      } finally { if (receiver) await receiver.close(); }
    });
  }

  async deviceLogin(metadata, clientId, onAuthorize, binding) {
    const device = await jsonRequest(this.fetch, metadata.device_authorization_endpoint, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, scope: REMOTE_SCOPES.join(' '), resource: metadata.resource,
        tenant_id: binding.tenant_id, project_id: binding.project_id, principal_id: binding.principal }).toString() });
    if (!opaque(device.device_code) || typeof device.user_code !== 'string' || !/^[A-Z0-9-]{4,32}$/u.test(device.user_code) ||
        !Number.isSafeInteger(device.expires_in) || device.expires_in < 1 || device.expires_in > 900 ||
        device.interval !== undefined && (!Number.isSafeInteger(device.interval) || device.interval < 1 || device.interval > 60)) {
      throw new RemoteOAuthError('invalid_device_response');
    }
    const url = httpsUrl(device.verification_uri, metadata.issuer).href;
    // device_code is never displayed. user_code/URI stay in the user's native terminal.
    await onAuthorize({ mode: 'device', url, user_code: device.user_code });
    const deadline = this.now() + device.expires_in * 1000;
    let interval = (device.interval ?? 5) * 1000;
    while (this.now() < deadline) {
      await this.sleep(Math.min(interval, deadline - this.now()));
      if (this.now() >= deadline) break;
      try { return await tokenRequest(this.fetch, metadata, { grant_type: DEVICE_GRANT, client_id: clientId, device_code: device.device_code }); }
      catch (error) {
        if (error.code === 'authorization_pending') continue;
        if (error.code === 'slow_down') { interval += 5000; continue; }
        if (error.code === 'network_failed') { interval = Math.min(interval * 2, 900_000); continue; }
        throw error;
      }
    }
    throw new RemoteOAuthError('authorization_expired');
  }

  summary(profile) {
    return { state: profile.state, resource: profile.resource, tenant_id: profile.tenant_id,
      project_id: profile.project_id, principal: profile.principal, scopes: profile.scopes,
      expires_at: profile.expires_at, expired: profile.expires_at <= this.now() };
  }

  async status() {
    const profile = await this.store.read();
    if (!profile) return { state: 'logged_out' };
    if (profile.version === 1 && profile.state === 'reauthentication_required') {
      exactScopes(profile.scopes);
      return { state: profile.state, ...this.binding(profile), scopes: [...REMOTE_SCOPES] };
    }
    return this.summary(this.validateProfile(profile));
  }

  async refreshLocked(profile) {
    let refreshed, metadata, issuedCredentials;
    // Persist uncertainty BEFORE the external rotation. A crash must not leave
    // an old refresh token on disk that another process could replay.
    await this.store.write({ version: 1, state: 'reauthentication_required', ...this.binding(profile), scopes: [...REMOTE_SCOPES] });
    try {
      metadata = await discoverOrgBrain(this.fetch, profile.resource);
      const tokens = await tokenRequest(this.fetch, metadata, { grant_type: 'refresh_token', client_id: profile.client_id,
        refresh_token: profile.refresh_token, scope: REMOTE_SCOPES.join(' ') });
      if (opaque(tokens?.refresh_token)) issuedCredentials = { client_id: profile.client_id, refresh_token: tokens.refresh_token };
      refreshed = this.issued(metadata, profile, profile.client_id, tokens, profile);
      await this.identity(refreshed);
      await this.store.write(refreshed);
      return refreshed;
    } catch {
      // A network interruption after rotation is ambiguous. Never replay old refresh
      // credentials, retry a mutation, or silently change accounts after uncertainty.
      if (issuedCredentials) await this.revoke(issuedCredentials, metadata).catch(() => {});
      await this.store.write({ version: 1, state: 'reauthentication_required', ...this.binding(profile), scopes: [...REMOTE_SCOPES] });
      throw new RemoteOAuthError('reauthentication_required');
    }
  }

  async refresh() {
    return this.store.withLock(async () => this.summary(await this.refreshLocked(this.validateProfile(await this.store.read()))));
  }

  async logout() {
    return this.store.withLock(async () => {
      const profile = await this.store.read();
      if (!profile) return { state: 'logged_out', remote_revoked: false };
      let revoked = false;
      try {
        if (profile.state === 'authenticated') {
          this.validateProfile(profile);
          await this.revoke(profile, await discoverOrgBrain(this.fetch, profile.resource));
          revoked = true;
        }
      } catch { /* Keep local logout available offline; report remote uncertainty. */ }
      finally { await this.store.clear(); }
      return { state: 'logged_out', remote_revoked: revoked };
    });
  }

  async authenticated(callback) {
    return this.store.withLock(async () => {
      let profile = this.validateProfile(await this.store.read());
      if (profile.expires_at <= this.now() + 30_000) profile = await this.refreshLocked(profile);
      await this.identity(profile);
      return callback(profile);
    });
  }

  async call(profile, name, args) {
    const response = await safeFetch(this.fetch, profile.resource, { method: 'POST',
      headers: { ...modernMcpHeaders('tools/call', name), authorization: `Bearer ${profile.access_token}` },
      body: JSON.stringify(modernMcpRequest({ id: 1, method: 'tools/call', name, params: { arguments: args } })) });
    if (!response.ok) throw new RemoteOAuthError(`http_${response.status}`);
    let rpc, result;
    try {
      rpc = await readResponse(response);
      if (rpc.id !== 1 || rpc.jsonrpc !== '2.0' || rpc.error || rpc.result?.isError) throw new Error();
      result = rpc.result?.structuredContent ?? JSON.parse(rpc.result.content.find(item => item.type === 'text').text);
      if (!result || typeof result !== 'object') throw new Error();
    } catch { throw new RemoteOAuthError('mcp_failed'); }
    return result;
  }

  async search(q, { limit = 10 } = {}) {
    if (typeof q !== 'string' || !q.trim() || q.length > 500 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new RemoteOAuthError('invalid_search');
    return this.authenticated(async profile => {
      const result = await this.call(profile, 'orgbrain_memories_search', {
        tenant_id: profile.tenant_id, project_id: profile.project_id, strict_project: true, scope: 'mine', q, limit, search_mode: 'memories', search_scope: 'evidence' });
      if (result.tenant_id !== profile.tenant_id || result.project_id !== profile.project_id || !Array.isArray(result.results)) {
        throw new RemoteOAuthError('search_binding_mismatch');
      }
      return result;
    });
  }

  async stage(input, { execute = false, expectedPlanHash } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RemoteOAuthError('invalid_conversation');
    return this.authenticated(profile => {
      if (input.tenant_id !== profile.tenant_id || input.project_id !== profile.project_id) throw new RemoteOAuthError('conversation_binding_mismatch');
      return ingestRemoteConversationMemory(input, { execute, expectedPlanHash,
        endpoint: profile.resource, accessToken: profile.access_token, fetchImpl: this.fetch });
    });
  }

  async confirmation(profile, token) {
    identifier(token);
    const status = await this.call(profile, 'orgbrain_memories_confirmation_status', { tenant_id: profile.tenant_id, confirmation_token: token });
    if (status.tenant_id !== profile.tenant_id || status.project_id !== profile.project_id) throw new RemoteOAuthError('confirmation_binding_mismatch');
    return status;
  }

  async confirmationStatus(token) { return this.authenticated(profile => this.confirmation(profile, token)); }

  async confirm(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        typeof input.review_answer !== 'string' || !input.review_answer.trim() || input.review_answer.length > 2000 ||
        !/^[a-f0-9]{64}$/u.test(input.expected_candidate_hash ?? '') ||
        !Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1 || typeof input.approved !== 'boolean') {
      throw new RemoteOAuthError('actual_review_and_guard_required');
    }
    return this.authenticated(async profile => {
      const status = await this.confirmation(profile, input.confirmation_token);
      if (status.candidate_hash !== input.expected_candidate_hash || status.revision !== input.expected_revision) throw new RemoteOAuthError('stale_confirmation');
      return this.call(profile, 'orgbrain_memories_confirm', { tenant_id: profile.tenant_id,
        confirmation_token: input.confirmation_token, expected_candidate_hash: input.expected_candidate_hash,
        expected_revision: input.expected_revision, approved: input.approved, review_answer: input.review_answer });
    });
  }
}
