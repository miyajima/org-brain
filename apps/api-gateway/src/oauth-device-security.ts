import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { sha256, type OrgRole } from '@org-brain/shared';
import { authorizeMcpRequest } from './mcp-security';
import { oauthProviderSubject, type OAuthProps } from './mcp-oauth-cloudflare';
import { OAuthGrantLedger } from './oauth-grant-ledger';
import { remoteClientIdentity } from './remote-client-identity';
import { getMemoryConfirmationProject } from './rationale-service';
import { DEVICE_GRANT, DEVICE_SCOPES, attemptLimit, boundedJson, escapeHtml, formBody, identifier, noStore, oauthError, opaque, randomCode } from './oauth-security-utils';
import type { Env } from './types';

type Device = { device_hash: string; user_hash: string; client_id: string; resource: string; tenant_id: string;
  project_id: string; principal: string; default_role: OrgRole; state: string; expires_at: number;
  interval_seconds: number; next_poll_at: number; version: number; csrf_hash: string | null; csrf_principal: string | null };
type ProviderFetch = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;
const csrfName = '__Host-orgbrain_device_csrf';
const normalizeUserCode = (value: string | null) => value?.toUpperCase().replace(/-/gu, '') ?? '';
const b64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

// This adapter uses only the SDK's public helpers and HTTP token endpoint. It
// never issues or verifies its own bearer token. D1 holds strongly consistent
// security state; SDK encrypted grants/tokens remain in KV.
export class OAuthDeviceSecurity {
  readonly ledger: OAuthGrantLedger;
  private origin: string;
  private redirect: string;
  constructor(private env: Env, private helpers: OAuthHelpers, private upstream: ProviderFetch, private now = Date.now) {
    this.origin = new URL(env.MCP_OAUTH_RESOURCE!).origin;
    this.redirect = `${this.origin}/oauth/device/internal-return`;
    this.ledger = new OAuthGrantLedger(env, helpers, now);
  }
  private get enabled() { return this.env.ORGBRAIN_OAUTH_SECURITY_V2 === 'true'; }
  private async deviceClient(clientId: string) {
    // SDK registration is the durable marker even with the flag disabled or
    // without the additive D1 tables. Never reopen its internal auth-code lane.
    const client = await this.helpers.lookupClient(clientId);
    return client?.redirectUris.includes(this.redirect) ? client : null;
  }
  private async budget(request: Request, purpose: string, key: string, max: number) {
    return attemptLimit(this.env, purpose, `${request.headers.get('cf-connecting-ip') ?? 'unknown'}:${key}`, this.now(), max);
  }
  async fetch(request: Request, _env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.origin !== this.origin) return oauthError('invalid_request');
      if (url.pathname === '/oauth/authorize') {
        const id = url.searchParams.get('client_id');
        if (id && await this.deviceClient(id)) return oauthError('unauthorized_client');
      }
      if (url.pathname === '/oauth/token' && request.method === 'POST') return await this.token(request, ctx);
      if (!this.enabled) return await this.upstream(request, this.env, ctx);
      if (url.pathname === '/oauth/register' && request.method === 'POST') return await this.registerClient(request, ctx);
      if (url.pathname === '/oauth/device') return await this.begin(request);
      // Reuse the existing Access-protected /oauth/authorize* login boundary;
      // no new Access application or expanded authentication policy is needed.
      if (url.pathname === '/oauth/authorize/device') return await this.verify(request);
      const response = await this.upstream(request, this.env, ctx);
      if (response.ok && url.pathname === '/.well-known/oauth-authorization-server') {
        const metadata = await response.json<Record<string, unknown>>();
        return Response.json({ ...metadata, device_authorization_endpoint: `${this.origin}/oauth/device`,
          token_endpoint_auth_methods_supported: ['none'],
          scopes_supported: [...DEVICE_SCOPES],
          grant_types_supported: [...new Set([...(metadata.grant_types_supported as string[] ?? []), DEVICE_GRANT])] }, { headers: noStore });
      }
      return response;
    } catch {
      // Storage, crypto or upstream exceptions never leak credentials or allow
      // fallback to the SDK-only lane. Clients must start a new authorization.
      return oauthError('temporarily_unavailable', 503);
    }
  }
  private async registerClient(request: Request, ctx: ExecutionContext) {
    let body: Record<string, any>;
    try { body = await boundedJson(request.clone() as Request); } catch { return oauthError('invalid_client_metadata'); }
    // V2 is an explicit public-client mode. The SDK has no public helper for
    // authenticating a confidential client before the strong-state transition.
    // Reject it at registration/consent as well as refresh; do not advertise an
    // unusable newly registered flow or invent a secret verifier.
    if (body.token_endpoint_auth_method !== 'none') return oauthError('invalid_client_metadata');
    if (!Array.isArray(body.grant_types) || !body.grant_types.includes(DEVICE_GRANT)) return this.upstream(request, this.env, ctx);
    if (body.grant_types.length !== 2 || !body.grant_types.includes('refresh_token') || body.token_endpoint_auth_method !== 'none' ||
      !Array.isArray(body.redirect_uris) || body.redirect_uris.length || !Array.isArray(body.response_types) || body.response_types.length ||
      typeof body.client_name !== 'string' || body.client_name.length < 1 || body.client_name.length > 128 || /[\x00-\x1f\x7f]/u.test(body.client_name)) return oauthError('invalid_client_metadata');
    if (!await this.budget(request, 'register', 'device', 10)) return oauthError('slow_down', 429);
    const client = await this.helpers.createClient({ clientName: body.client_name, tokenEndpointAuthMethod: 'none',
      redirectUris: [this.redirect], grantTypes: ['authorization_code', 'refresh_token'], responseTypes: ['code'] });
    // Failure before this row is written returns no client ID and leaves the
    // SDK marker permanently blocked from public auth-code use.
    await this.env.OPEN_BRAIN_DB.prepare('INSERT INTO oauth_device_clients(client_id,created_at) VALUES(?,?)').bind(client.clientId, this.now()).run();
    return Response.json({ client_id: client.clientId, client_name: client.clientName, token_endpoint_auth_method: 'none',
      grant_types: [DEVICE_GRANT, 'refresh_token'], response_types: [], redirect_uris: [], client_id_issued_at: Math.floor(this.now() / 1000) }, { status: 201, headers: noStore });
  }
  private async begin(request: Request) {
    if (request.method !== 'POST') return oauthError('invalid_request', 405);
    let form: URLSearchParams;
    try { form = await formBody(request); } catch { return oauthError('invalid_request'); }
    const clientId = form.get('client_id'), resource = form.get('resource'), tenant = form.get('tenant_id'),
      project = form.get('project_id'), principal = form.get('principal_id');
    if (!identifier(clientId, 256) || resource !== this.env.MCP_OAUTH_RESOURCE || !identifier(tenant) || !identifier(project) || !identifier(principal)) return oauthError('invalid_request');
    const scopes = form.get('scope')?.split(' ') ?? [];
    if (scopes.length !== 2 || DEVICE_SCOPES.some(scope => !scopes.includes(scope))) return oauthError('invalid_scope');
    if (!await this.budget(request, 'begin', clientId, 10)) return oauthError('slow_down', 429);
    if (!await this.deviceClient(clientId) || !await this.env.OPEN_BRAIN_DB.prepare('SELECT client_id FROM oauth_device_clients WHERE client_id=?').bind(clientId).first()) return oauthError('invalid_client');
    const device = randomCode();
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const user = Array.from(crypto.getRandomValues(new Uint8Array(8)), byte => alphabet[byte & 31]).join('');
    const now = this.now();
    await this.env.OPEN_BRAIN_DB.prepare(`INSERT INTO oauth_device_requests
      (device_hash,user_hash,client_id,resource,tenant_id,project_id,principal,state,created_at,expires_at,next_poll_at)
      VALUES(?,?,?,?,?,?,?,'pending',?,?,?)`)
      .bind(await sha256(device), await sha256(user), clientId, resource, tenant, project, principal, now, now + 600_000, now + 5000).run();
    return Response.json({ device_code: device, user_code: `${user.slice(0,4)}-${user.slice(4)}`,
      verification_uri: `${this.origin}/oauth/authorize/device`, expires_in: 600, interval: 5 }, { headers: noStore });
  }
  private async access(request: Request, device: Device) {
    const headers = new Headers(request.headers); headers.set('x-orgbrain-tenant', device.tenant_id);
    let auth;
    try { auth = await authorizeMcpRequest(new Request(request.url, { headers }), { ...this.env, MCP_AUTH_MODE: 'access' }); }
    catch { return null; }
    if (auth.source !== 'access-user' || auth.principal !== device.principal || auth.tenantId !== device.tenant_id) return null;
    const props: OAuthProps = { tenantId: auth.tenantId, principal: auth.principal, projectId: device.project_id,
      defaultRole: auth.defaultRole, scopes: [...DEVICE_SCOPES], securityV2: true };
    return (await this.checkProject(props)).ok ? props : null;
  }
  private checkProject(props: OAuthProps) {
    const url = new URL(`${this.env.MCP_OAUTH_RESOURCE}/identity`);
    url.searchParams.set('tenant_id', props.tenantId); url.searchParams.set('project_id', props.projectId!);
    return remoteClientIdentity(new Request(url), this.env, props);
  }
  private async csrfHash(device: Device, nonce: string) {
    return sha256(`${device.device_hash}:${device.principal}:${device.tenant_id}:${device.project_id}:${nonce}`);
  }
  private async verify(request: Request) {
    if (request.method !== 'GET' && request.method !== 'POST') return oauthError('invalid_request', 405);
    // Authenticate and budget even nonexistent codes: distributed guesses may
    // not bypass the limiter by selecting a different row on every request.
    let auth;
    try { auth = await authorizeMcpRequest(request, { ...this.env, MCP_AUTH_MODE: 'access' }); }
    catch { return oauthError('access_denied', request.headers.has('cf-access-jwt-assertion') ? 403 : 401); }
    if (auth.source !== 'access-user') return oauthError('access_denied', 403);
    if (!await attemptLimit(this.env, 'verify-user', auth.principal, this.now(), 10) ||
        !await this.budget(request, 'verify-ip', 'codes', 10)) return oauthError('slow_down', 429);
    let form: URLSearchParams;
    try { form = request.method === 'POST' ? await formBody(request) : new URL(request.url).searchParams; }
    catch { return oauthError('invalid_request'); }
    if (form.getAll('user_code').length !== 1) {
      if (request.method !== 'GET' || form.has('user_code')) return oauthError('invalid_request');
      return this.page('<h1>OrgBrain 接続コード</h1><form method="get"><label>端末に表示されたコード <input name="user_code" required autocomplete="off"></label><button>確認する</button></form>');
    }
    const code = normalizeUserCode(form.get('user_code'));
    if (!/^[A-Z2-7]{8}$/u.test(code)) return oauthError('invalid_request');
    const row = await this.env.OPEN_BRAIN_DB.prepare('SELECT * FROM oauth_device_requests WHERE user_hash=?').bind(await sha256(code)).first<Device>();
    if (!row || row.state !== 'pending' || row.expires_at <= this.now()) return oauthError('invalid_request');
    const props = await this.access(request, row);
    if (!props) return oauthError('access_denied', 403);
    if (request.method === 'GET') {
      const nonce = randomCode();
      const result = await this.env.OPEN_BRAIN_DB.prepare(`UPDATE oauth_device_requests SET csrf_hash=?,csrf_principal=?
        WHERE device_hash=? AND state='pending' AND expires_at>?`)
        .bind(await this.csrfHash(row, nonce), props.principal, row.device_hash, this.now()).run();
      if (result.meta.changes !== 1) return oauthError('invalid_request');
      const client = await this.deviceClient(row.client_id);
      return this.page(`<h1>OrgBrain MCP 接続許可</h1><p>ご自身が開始した端末のコードと一致することを確認してください。</p><dl>
        <dt>コード</dt><dd>${escapeHtml(code)}</dd><dt>クライアント</dt><dd>${escapeHtml(client?.clientName ?? row.client_id)}</dd>
        <dt>接続先</dt><dd>${escapeHtml(row.resource)}</dd><dt>ユーザー</dt><dd>${escapeHtml(row.principal)}</dd>
        <dt>Tenant</dt><dd>${escapeHtml(row.tenant_id)}</dd><dt>Project</dt><dd>${escapeHtml(row.project_id)}</dd>
        <dt>権限</dt><dd>${DEVICE_SCOPES.join(', ')}</dd></dl><form method="post" action="/oauth/authorize/device">
        <input type="hidden" name="user_code" value="${escapeHtml(code)}"><input type="hidden" name="csrf" value="${nonce}">
        <label><input type="checkbox" name="confirmed" value="yes"> コード、接続先と権限を確認しました</label>
        <button name="decision" value="approve">許可する</button><button name="decision" value="deny">拒否する</button></form>`, nonce);
    }
    const nonce = form.get('csrf');
    const cookie = request.headers.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith(`${csrfName}=`))?.slice(csrfName.length + 1);
    if (request.headers.get('origin') !== this.origin || !opaque(nonce) || nonce !== cookie ||
        row.csrf_principal !== props.principal || row.csrf_hash !== await this.csrfHash(row, nonce) ||
        !['approve', 'deny'].includes(form.get('decision') ?? '') || form.get('decision') === 'approve' && form.get('confirmed') !== 'yes') return oauthError('access_denied', 403);
    const state = form.get('decision') === 'approve' ? 'approved' : 'denied';
    const changed = await this.env.OPEN_BRAIN_DB.prepare(`UPDATE oauth_device_requests SET state=?,default_role=?,csrf_hash=NULL,csrf_principal=NULL,version=version+1
      WHERE device_hash=? AND state='pending' AND expires_at>? AND csrf_hash=? AND csrf_principal=?`)
      .bind(state, props.defaultRole, row.device_hash, this.now(), row.csrf_hash, props.principal).run();
    if (changed.meta.changes !== 1) return oauthError('invalid_request');
    return this.page(`<h1>${state === 'approved' ? '接続を許可しました' : '接続を拒否しました'}</h1><p>端末へ戻ってください。</p>`);
  }
  private page(content: string, nonce?: string) {
    return new Response(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>OrgBrain 接続許可</title></head><body><main>${content}</main></body></html>`, {
      headers: { ...noStore, 'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        'x-frame-options': 'DENY', ...(nonce ? { 'set-cookie': `${csrfName}=${nonce}; Max-Age=600; Path=/; Secure; HttpOnly; SameSite=Lax` } : {}) }
    });
  }
  private async token(request: Request, ctx: ExecutionContext) {
    let form: URLSearchParams;
    try { form = await formBody(request.clone() as Request); } catch { return oauthError('invalid_request'); }
    let clientId = form.get('client_id');
    const basic = request.headers.get('authorization')?.match(/^Basic ([A-Za-z0-9+/=]+)$/u)?.[1];
    if (basic) {
      let basicId: string;
      try { basicId = decodeURIComponent(atob(basic).split(':')[0]); } catch { return oauthError('invalid_client'); }
      if (clientId && clientId !== basicId) return oauthError('invalid_client');
      clientId = basicId;
    }
    if (!identifier(clientId, 256)) return oauthError('invalid_client');
    const isDevice = !!await this.deviceClient(clientId);
    if (isDevice && form.get('grant_type') === 'authorization_code') return oauthError('unauthorized_client');
    const refresh = form.get('grant_type') === 'refresh_token';
    const revocation = !form.has('grant_type') && form.has('token');
    const credential = refresh ? form.get('refresh_token') : revocation ? form.get('token') : null;
    let tracked = null;
    if ((refresh || revocation) && opaque(credential) && (this.enabled || await this.ledger.schemaAvailable())) {
      tracked = await this.ledger.refreshRecord(credential);
      if (!this.enabled && refresh && !tracked && await this.ledger.claimsTrackedFamily(credential)) return oauthError('invalid_grant');
    }
    // Already issued V2 grants never return to SDK-only refresh/revocation on
    // rollback. Legacy clients with no tracked family retain the default mode.
    if (!this.enabled && !tracked) return isDevice ? oauthError('unauthorized_client') : this.upstream(request, this.env, ctx);
    if (form.get('grant_type') === DEVICE_GRANT) {
      if (basic || request.headers.has('authorization') || form.has('client_secret')) return oauthError('invalid_client');
      return this.poll(request, clientId, form, ctx);
    }
    if (refresh) {
      if (form.get('resource') !== this.env.MCP_OAUTH_RESOURCE || !opaque(form.get('refresh_token'))) return oauthError('invalid_grant');
      // Authenticate confidential clients BEFORE a ledger mutation. Otherwise
      // an unauthenticated known-token attempt could revoke their grant family.
      const client = await this.helpers.lookupClient(clientId);
      if (!client || client.tokenEndpointAuthMethod !== 'none') return oauthError('unauthorized_client');
      const existing = await this.ledger.consumeRefresh(form.get('refresh_token')!, clientId, form.get('resource')!);
      if (!existing) return oauthError('invalid_grant');
      try { return await this.ledger.register(await this.upstream(request, this.env, ctx), clientId, existing); }
      catch { await this.ledger.revoke(existing); return oauthError('invalid_grant'); }
    }
    if (revocation) {
      const client = await this.helpers.lookupClient(clientId);
      if (client?.tokenEndpointAuthMethod === 'none' && await this.ledger.revokeRefresh(form.get('token')!, clientId)) return new Response(null, { status: 200, headers: noStore });
    }
    const response = await this.upstream(request, this.env, ctx);
    return form.get('grant_type') === 'authorization_code' ? this.ledger.register(response, clientId) : response;
  }
  private async poll(request: Request, clientId: string, form: URLSearchParams, ctx: ExecutionContext) {
    if (!await this.budget(request, 'poll', clientId, 100)) return oauthError('slow_down', 429);
    const code = form.get('device_code');
    if (!opaque(code) || form.get('resource') !== this.env.MCP_OAUTH_RESOURCE || !await this.deviceClient(clientId)) return oauthError('invalid_grant');
    const row = await this.env.OPEN_BRAIN_DB.prepare('SELECT * FROM oauth_device_requests WHERE device_hash=?').bind(await sha256(code)).first<Device>();
    if (!row || row.client_id !== clientId || row.resource !== form.get('resource') || row.state === 'consumed') return oauthError('invalid_grant');
    if (row.expires_at <= this.now()) return oauthError('expired_token');
    if (row.state === 'denied') return oauthError('access_denied');
    const slow = this.now() < row.next_poll_at;
    const interval = row.interval_seconds + (slow ? 5 : 0);
    const state = !slow && row.state === 'approved' ? 'consumed' : row.state;
    const result = await this.env.OPEN_BRAIN_DB.prepare(`UPDATE oauth_device_requests SET state=?,interval_seconds=?,next_poll_at=?,version=version+1
      WHERE device_hash=? AND version=? AND state=? AND expires_at>?`)
      .bind(state, interval, this.now() + interval * 1000, row.device_hash, row.version, row.state, this.now()).run();
    if (result.meta.changes !== 1) return oauthError('slow_down');
    if (slow) return oauthError('slow_down');
    if (state !== 'consumed') return oauthError('authorization_pending');
    const props: OAuthProps = { tenantId: row.tenant_id, principal: row.principal, projectId: row.project_id,
      defaultRole: row.default_role, scopes: [...DEVICE_SCOPES], securityV2: true };
    if (!(await this.checkProject(props)).ok) return oauthError('access_denied');
    const verifier = randomCode();
    const challenge = b64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const { redirectTo } = await this.helpers.completeAuthorization({ request: {
      responseType: 'code', clientId, redirectUri: this.redirect, scope: [...DEVICE_SCOPES], state: randomCode(),
      codeChallenge: challenge, codeChallengeMethod: 'S256', resource: row.resource, issuer: this.origin
    }, userId: await oauthProviderSubject(row.principal), metadata: { tenant_id: row.tenant_id, project_id: row.project_id },
      scope: [...DEVICE_SCOPES], props, revokeExistingGrants: false });
    const authorizationCode = new URL(redirectTo).searchParams.get('code');
    if (!authorizationCode) return oauthError('invalid_grant');
    const response = await this.upstream(new Request(`${this.origin}/oauth/token`, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
        grant_type: 'authorization_code', client_id: clientId, code: authorizationCode, code_verifier: verifier,
        redirect_uri: this.redirect, resource: row.resource }).toString() }), this.env, ctx);
    return this.ledger.register(response, clientId);
  }
  async guardProject(request: Request, props: OAuthProps): Promise<boolean> {
    if (!props.projectId) return true;
    if (!(await this.checkProject(props)).ok) return false;
    const path = new URL(request.url).pathname;
    if (path === '/mcp/identity') return new URL(request.url).searchParams.get('project_id') === props.projectId;
    if (path !== '/mcp' || request.method !== 'POST') return false;
    let body: Record<string, any>;
    try { body = await boundedJson(request.clone() as Request, 96 * 1024); } catch { return false; }
    if (['initialize', 'notifications/initialized', 'ping', 'tools/list', 'server/discover'].includes(body.method)) return true;
    if (body.method !== 'tools/call') return false;
    const args = body.params?.arguments;
    if (!args || args.tenant_id !== props.tenantId) return false;
    switch (body.params.name) {
      case 'orgbrain_memories_search': return args.project_id === props.projectId && args.strict_project === true && args.search_scope === 'evidence';
      case 'orgbrain_conversation_memories_stage': return args.conversation?.tenant_id === props.tenantId && args.conversation?.project_id === props.projectId;
      case 'orgbrain_memories_confirm':
      case 'orgbrain_memories_confirmation_status':
        if (!identifier(args.confirmation_token, 64)) return false;
        try { return await getMemoryConfirmationProject(this.env, props.tenantId, args.confirmation_token, props.principal) === props.projectId; }
        catch { return false; }
      default: return false;
    }
  }
}
