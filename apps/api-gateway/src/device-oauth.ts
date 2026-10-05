import { HttpError } from '@org-brain/shared';
import { resolveVerifiedAccessUser } from './auth';
import type { OrgBrainOAuthScope, OrgRole } from '@org-brain/contracts';
import { authorizeMcpRequest, type McpAuthResult } from './mcp-security';
import { assertPermission } from './rbac-service';
import { handleOrgBrainMcpRequest } from './mcp';
import type { Env } from './types';

export const DEVICE_CLIENT = 'orgbrain-cloud-cli';
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
export const DEVICE_TOOLS = ['orgbrain_memories_search', 'orgbrain_memories_propose', 'orgbrain_memories_confirm',
  'orgbrain_memories_confirmation_status', 'orgbrain_conversation_memories_stage'];
const DEVICE_TTL = 600_000, ACCESS_TTL = 600_000, FAMILY_TTL = 30 * 86400_000;
const enc = new TextEncoder();
export async function deviceHash(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}
const random = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
const result = (body: unknown, status = 200, extra: Record<string,string> = {}) => Response.json(body, {
  status, headers: { 'cache-control': 'no-store', pragma: 'no-cache', ...extra }
});
const error = (code: string, status = 400) => result({ error: code }, status);
const escapeHtml = (s: string) => s.replace(/[&<>"']/gu, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const validId = (s: string) => /^[A-Za-z0-9_.:-]{1,128}$/u.test(s);
function resourceFor(env: Env, origin: string) {
  const resource = env.MCP_OAUTH_RESOURCE;
  if (!resource || resource !== `${origin}/mcp`) throw new Error('device_resource_misconfigured');
  return resource;
}
function enabled(env: Env) {
  return env.ORGBRAIN_DEVICE_OAUTH_ENABLED === 'true' && ['oauth','dual'].includes(env.MCP_AUTH_MODE ?? '');
}
// A primary session prevents read replication/KV staleness from reviving credentials.
function primary(env: Env) {
  return env.OPEN_BRAIN_DB.withSession?.('first-primary') ?? env.OPEN_BRAIN_DB;
}
export async function deviceRateLimit(env: Env, action: string, key: string, now = Date.now(), limit = 10) {
  const db = primary(env), bucket = Math.floor(now / 60_000);
  const row = await db.prepare(`INSERT INTO oauth_device_limits(key,count,expires_at) VALUES(?,1,?)
    ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count`).bind(`${action}:${bucket}:${await deviceHash(key)}`, now+120_000).first<{count:number}>();
  return Boolean(row && row.count <= limit);
}
type DeviceRow = { device_hash:string; user_hash:string; client_id:string; tenant_id:string; project_id:string;
  resource:string; scopes:string; expires_at:number; state:string; interval_ms:number; poll_after:number;
  version:number; principal:string|null; role:OrgRole|null; identity_issuer:string|null; identity_subject:string|null; identity_email:string|null; csrf_hash:string|null; csrf_expires_at:number|null };
type Family = { id:string; client_id:string; tenant_id:string; project_id:string; resource:string; scopes:string;
  principal:string; role:OrgRole; identity_issuer:string; identity_subject:string; identity_email:string|null; expires_at:number; revoked_at:number|null };
type TokenRow = Family & { token_expires_at:number; consumed_at:number|null; kind:string };
// Re-evaluate registered identity, active profile, current tenant grant and role.
// These fields came from verified Access claims, never from the device client.
async function currentDeviceIdentity(env: Env, row: Pick<DeviceRow, 'tenant_id'|'project_id'|'principal'|'identity_issuer'|'identity_subject'|'identity_email'|'scopes'>) {
  if (!row.principal || !row.identity_issuer || !row.identity_subject) return null;
  const identityEnv = { ...env, OPEN_BRAIN_DB: primary(env) as unknown as D1Database };
  try {
    const grant = await resolveVerifiedAccessUser(identityEnv, {iss:row.identity_issuer,sub:row.identity_subject,
      ...(row.identity_email ? {email:row.identity_email} : {})}, 'access-jwt', {requireExistingIdentity:true});
    if (grant.principal !== row.principal || !grant.allowedTenants.includes(row.tenant_id)) return null;
    for (const scope of JSON.parse(row.scopes) as OrgBrainOAuthScope[]) {
      await assertPermission(identityEnv,{tenantId:row.tenant_id,projectId:row.project_id,principal:grant.principal,
        permission:scope==='orgbrain:read' ? 'read' : 'write',fallbackRole:grant.defaultRole});
    }
    return grant;
  } catch (failure) {
    if (failure instanceof HttpError && [401,403,409].includes(failure.status)) return null;
    throw failure; // D1 outage or policy misconfiguration is not valid authentication.
  }
}
async function activeFamily(env: Env, row: TokenRow, now: number) {
  const grant=await currentDeviceIdentity(env,row);
  if (!grant) await primary(env).prepare('UPDATE oauth_device_families SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').bind(now,row.id).run();
  return grant;
}
async function tokenRow(env: Env, token: string) {
  return primary(env).prepare(`SELECT f.*,t.expires_at AS token_expires_at,t.consumed_at,t.kind FROM oauth_device_tokens t
    JOIN oauth_device_families f ON f.id=t.family_id WHERE t.hash=?`).bind(await deviceHash(token)).first<TokenRow>();
}
export async function deviceBearer(env: Env, token: string, now = Date.now()): Promise<McpAuthResult|null> {
  if (!enabled(env) || !/^odb_a_[a-f0-9]{64}$/u.test(token)) return null;
  const row = await tokenRow(env, token);
  if (!row || row.kind !== 'access' || row.revoked_at !== null || row.expires_at <= now || row.token_expires_at <= now) return null;
  const grant=await activeFamily(env,row,now);
  if (!grant) return null;
  return { tenantId:row.tenant_id, principal:row.principal, allowedTenants:[row.tenant_id], projectId:row.project_id,
    source:'oauth', defaultRole:grant.defaultRole, runtimeActor:`principal:${row.principal}`,
    scopes:JSON.parse(row.scopes), allowedTools:DEVICE_TOOLS };
}
async function makeTokens() {
  const access = `odb_a_${random()}`, refresh = `odb_r_${random()}`;
  return { access, refresh, accessHash:await deviceHash(access), refreshHash:await deviceHash(refresh) };
}
function tokenResponse(t: Awaited<ReturnType<typeof makeTokens>>, f: Family) {
  return result({ access_token:t.access, refresh_token:t.refresh, token_type:'Bearer', expires_in:ACCESS_TTL/1000,
    refresh_expires_at:f.expires_at, scope:JSON.parse(f.scopes).join(' '), tenant_id:f.tenant_id,
    project_id:f.project_id, resource:f.resource });
}
export async function refreshDevice(env: Env, form: URLSearchParams, now = Date.now()) {
  const token = form.get('refresh_token') ?? '';
  if (!/^odb_r_[a-f0-9]{64}$/u.test(token)) return error('invalid_grant');
  const old = await tokenRow(env, token);
  if (!old || old.kind !== 'refresh' || old.client_id !== form.get('client_id') || old.resource !== form.get('resource')) return error('invalid_grant');
  const db = primary(env);
  if (old.consumed_at !== null) {
    await db.prepare('UPDATE oauth_device_families SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').bind(now,old.id).run();
    return error('invalid_grant');
  }
  if (old.revoked_at !== null || old.expires_at <= now || old.token_expires_at <= now) return error('invalid_grant');
  if (!await activeFamily(env,old,now)) return error('invalid_grant');
  if (form.has('scope') && form.get('scope') !== JSON.parse(old.scopes).join(' ')) return error('invalid_scope');
  const t = await makeTokens(), claim = random(), hash = await deviceHash(token);
  const guard = `SELECT ? ,family_id,?,? FROM oauth_device_tokens WHERE hash=? AND claim_id=?
    AND EXISTS(SELECT 1 FROM oauth_device_families WHERE id=family_id AND revoked_at IS NULL AND expires_at>?)`;
  const writes = await db.batch([
    db.prepare(`UPDATE oauth_device_tokens SET consumed_at=?,claim_id=? WHERE hash=? AND consumed_at IS NULL AND expires_at>?
      AND EXISTS(SELECT 1 FROM oauth_device_families WHERE id=family_id AND revoked_at IS NULL AND expires_at>?)`).bind(now,claim,hash,now,now),
    db.prepare(`INSERT INTO oauth_device_tokens(hash,family_id,kind,expires_at) ${guard}`).bind(t.accessHash,'access',now+ACCESS_TTL,hash,claim,now),
    db.prepare(`INSERT INTO oauth_device_tokens(hash,family_id,kind,expires_at) ${guard}`).bind(t.refreshHash,'refresh',old.expires_at,hash,claim,now)
  ]);
  if (writes[0].meta.changes !== 1) {
    // A concurrent use of this same token is a replay, not a grace period.
    await db.prepare('UPDATE oauth_device_families SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').bind(now,old.id).run();
    return error('invalid_grant');
  }
  return tokenResponse(t, old);
}
export async function pollDevice(env: Env, form: URLSearchParams, now = Date.now()) {
  const code = form.get('device_code') ?? '';
  if (!/^[a-f0-9]{64}$/u.test(code)) return error('invalid_grant');
  const db = primary(env), hash = await deviceHash(code);
  for (let retry=0;retry<3;retry++) {
    const row = await db.prepare('SELECT * FROM oauth_device_requests WHERE device_hash=?').bind(hash).first<DeviceRow>();
    if (!row || row.client_id !== form.get('client_id') || row.resource !== form.get('resource')) return error('invalid_grant');
    if (row.expires_at <= now) return error('expired_token');
    if (row.state === 'denied') return error('access_denied');
    if (row.state === 'consumed') return error('invalid_grant');
    if (now < row.poll_after || row.state === 'pending') {
      const fast = now < row.poll_after, interval = row.interval_ms + (fast ? 5000 : 0);
      const update = await db.prepare(`UPDATE oauth_device_requests SET interval_ms=?,poll_after=?,version=version+1
        WHERE device_hash=? AND version=? AND state=?`).bind(interval,now+interval,hash,row.version,row.state).run();
      if (update.meta.changes !== 1) continue;
      return error(fast ? 'slow_down' : 'authorization_pending');
    }
    const grant=await currentDeviceIdentity(env,row);
    if (!grant) {
      await db.prepare("UPDATE oauth_device_requests SET state='denied',csrf_hash=NULL,version=version+1 WHERE device_hash=? AND state='approved'").bind(hash).run();
      return error('access_denied');
    }
    const t = await makeTokens(), familyId = random(), claim = random();
    const writes = await db.batch([
      db.prepare(`UPDATE oauth_device_requests SET state='consumed',claim_id=?,csrf_hash=NULL,version=version+1
        WHERE device_hash=? AND version=? AND state='approved' AND expires_at>?`).bind(claim,hash,row.version,now),
      db.prepare(`INSERT INTO oauth_device_families(id,client_id,tenant_id,project_id,principal,role,identity_issuer,identity_subject,identity_email,resource,scopes,expires_at)
        SELECT ?,client_id,tenant_id,project_id,principal,role,identity_issuer,identity_subject,identity_email,resource,scopes,? FROM oauth_device_requests WHERE device_hash=? AND claim_id=? AND state='consumed'`)
        .bind(familyId,now+FAMILY_TTL,hash,claim),
      db.prepare(`INSERT INTO oauth_device_tokens(hash,family_id,kind,expires_at) SELECT ?,id,'access',? FROM oauth_device_families WHERE id=?`)
        .bind(t.accessHash,now+ACCESS_TTL,familyId),
      db.prepare(`INSERT INTO oauth_device_tokens(hash,family_id,kind,expires_at) SELECT ?,id,'refresh',expires_at FROM oauth_device_families WHERE id=?`)
        .bind(t.refreshHash,familyId)
    ]);
    if (writes[0].meta.changes !== 1) continue;
    return tokenResponse(t,{...row,id:familyId,principal:row.principal!,role:grant.defaultRole,identity_issuer:row.identity_issuer!,identity_subject:row.identity_subject!,expires_at:now+FAMILY_TTL,revoked_at:null});
  }
  return error('slow_down');
}
async function body(request: Pick<Request, 'headers' | 'body'>) {
  if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) return null;
  if (!request.body) return null;
  const reader = request.body.getReader(), chunks:Uint8Array[]=[]; let size=0;
  try { for (;;) { const {done,value}=await reader.read(); if(done) break; size+=value.byteLength;
    if(size>8192) {await reader.cancel();return null;} chunks.push(value); } }
  finally {reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  const raw = new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  const form = new URLSearchParams(raw);
  if ([...form.keys()].some(k => form.getAll(k).length !== 1)) return null;
  return form;
}
async function verify(request: Request, env: Env, now: number) {
  const url = new URL(request.url), form = request.method === 'POST' ? await body(request) : url.searchParams;
  if (!form) return error('invalid_request');
  if (request.method === 'GET' && !form.has('user_code')) {
    return new Response('<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>OrgBrain Cloud接続</title><main><h1>OrgBrain Cloud接続</h1><p>自分が開始したCloud接続のコードを入力してください。</p><form method="get" action="/oauth/device/verify"><label>Code <input name="user_code" maxlength="14" required autocomplete="off"></label><button>接続先を確認</button></form></main></html>',{headers:{'content-type':'text/html;charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','x-frame-options':'DENY','content-security-policy':"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"}});
  }
  const code = (form.get('user_code') ?? '').toUpperCase().replace(/-/gu,'');
  if (!/^[A-Z2-7]{12}$/u.test(code)) return error('invalid_request');
  const db = primary(env), hash = await deviceHash(code);
  const row = await db.prepare('SELECT * FROM oauth_device_requests WHERE user_hash=?').bind(hash).first<DeviceRow>();
  if (!row || row.state !== 'pending' || row.expires_at <= now) return error('access_denied',403);
  // The device's requested tenant must pass the existing identity grant check.
  // A mobile form cannot send custom headers, and the user's first tenant may differ.
  const identityHeaders = new Headers(request.headers);
  identityHeaders.set('x-orgbrain-tenant',row.tenant_id);
  const access = await authorizeMcpRequest(new Request(request.url,{headers:identityHeaders}),{...env,MCP_AUTH_MODE:'access'});
  if (access.source !== 'access-user' || !access.identityIssuer || !access.identitySubject || !access.allowedTenants.includes(row.tenant_id) || row.tenant_id !== access.tenantId ||
    row.principal && row.principal !== access.principal) return error('access_denied',403);
  const scopes:OrgBrainOAuthScope[] = JSON.parse(row.scopes);
  for (const scope of scopes) await assertPermission(env,{tenantId:row.tenant_id,projectId:row.project_id,
    principal:access.principal,permission:scope === 'orgbrain:read' ? 'read' : 'write',fallbackRole:access.defaultRole});
  if (request.method === 'POST') {
    const csrf = form.get('csrf') ?? '', cookie = request.headers.get('cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith('__Host-orgbrain_device_csrf='))?.split('=')[1];
    if (request.headers.get('origin') !== url.origin || !csrf || csrf !== cookie || !row.csrf_hash ||
      row.csrf_expires_at! <= now || await deviceHash(csrf) !== row.csrf_hash || row.principal !== access.principal ||
      !['approve','deny'].includes(form.get('decision') ?? '')) return error('access_denied',403);
    const update = await db.prepare(`UPDATE oauth_device_requests SET state=?,csrf_hash=NULL,version=version+1
      WHERE user_hash=? AND state='pending' AND principal=? AND csrf_hash=? AND expires_at>?`)
      .bind(form.get('decision') === 'approve' ? 'approved':'denied',hash,access.principal,row.csrf_hash,now).run();
    if (update.meta.changes !== 1) return error('access_denied',403);
    return result({approved:form.get('decision') === 'approve'},200,{'set-cookie':'__Host-orgbrain_device_csrf=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict'});
  }
  const csrf = random();
  const update = await db.prepare(`UPDATE oauth_device_requests SET principal=?,role=?,identity_issuer=?,identity_subject=?,identity_email=?,csrf_hash=?,csrf_expires_at=?,version=version+1
    WHERE user_hash=? AND state='pending' AND expires_at>? AND (principal IS NULL OR principal=?)`)
    .bind(access.principal,access.defaultRole,access.identityIssuer,access.identitySubject,access.identityEmail ?? null,await deviceHash(csrf),Math.min(row.expires_at,now+DEVICE_TTL),hash,now,access.principal).run();
  if (update.meta.changes !== 1) return error('access_denied',403);
  return new Response(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>OrgBrain Cloud接続</title><main><h1>OrgBrain Cloud接続</h1><p>自分が開始したCloud接続だけを許可してください。</p><p>Client: ${DEVICE_CLIENT}</p><p>Tenant: ${escapeHtml(row.tenant_id)} / Project: ${escapeHtml(row.project_id)}</p><p>権限: ${escapeHtml(scopes.join(' '))}</p><p>Code: ${escapeHtml(code)}</p><form method="post" action="/oauth/device/verify"><input type="hidden" name="user_code" value="${code}"><input type="hidden" name="csrf" value="${csrf}"><button name="decision" value="approve">確認して許可</button><button name="decision" value="deny">拒否</button></form></main></html>`,{headers:{'content-type':'text/html;charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','x-frame-options':'DENY','content-security-policy':"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",'set-cookie':`__Host-orgbrain_device_csrf=${csrf}; Max-Age=600; Path=/; Secure; HttpOnly; SameSite=Strict`}});
}
// Runs before the KV OAuth provider. Its token prefix never falls through to KV.
export async function handleDeviceOAuth(request: Request, env: Env, ctx: ExecutionContext): Promise<Response|null> {
  const url = new URL(request.url), path = url.pathname, bearer = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/iu)?.[1] ?? '';
  if (path === '/mcp' && bearer.startsWith('odb_')) {
    let auth:McpAuthResult|null;
    try { auth = await deviceBearer(env,bearer); } catch { return error('device_request_failed',503); }
    if (!auth || auth && env.MCP_OAUTH_RESOURCE !== url.href) return error('invalid_token',401);
    return handleOrgBrainMcpRequest(request,env,ctx,auth);
  }
  let form:URLSearchParams|null = null;
  if (request.method === 'POST' && ['/oauth/token','/oauth/revoke'].includes(path)) {
    form = await body(request.clone()).catch(()=>null);
    if (form?.get('client_id') !== DEVICE_CLIENT && form?.get('grant_type') !== DEVICE_GRANT &&
      !form?.get('refresh_token')?.startsWith('odb_') && !form?.get('token')?.startsWith('odb_')) return null;
  } else if (!path.startsWith('/oauth/device/')) return null;
  if (!enabled(env)) return error('device_flow_disabled',404);
  if (url.protocol !== 'https:') return error('invalid_request');
  try { resourceFor(env,url.origin); } catch { return error('device_request_failed',503); }
  if (path === '/oauth/device/verify') {
    if (!['GET','POST'].includes(request.method)) return error('invalid_request',405);
  } else if (request.method !== 'POST') return error('invalid_request',405);
  const now = Date.now(), ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  try {
    if (!await deviceRateLimit(env,path,ip,now,path === '/oauth/token' ? 120 : 10)) return error('slow_down',429);
  } catch { return error('device_request_failed',503); }
  try {
    if (path === '/oauth/device/verify') return await verify(request,env,now);
    form ??= await body(request);
    if (!form || form.get('client_id') !== DEVICE_CLIENT) return error('invalid_client');
    if (path === '/oauth/revoke') {
      const row = await tokenRow(env,form.get('token') ?? '');
      if (row && row.client_id === DEVICE_CLIENT) await primary(env).prepare('UPDATE oauth_device_families SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').bind(now,row.id).run();
      return new Response(null,{status:200,headers:{'cache-control':'no-store'}});
    }
    if (form.get('resource') !== env.MCP_OAUTH_RESOURCE) return error('invalid_target');
    if (path === '/oauth/token') {
      if (form.get('grant_type') === DEVICE_GRANT) return pollDevice(env,form,now);
      if (form.get('grant_type') === 'refresh_token') return refreshDevice(env,form,now);
      return error('unsupported_grant_type');
    }
    if (path !== '/oauth/device/code') return error('invalid_request',404);
    const tenant = form.get('tenant_id') ?? '', project = form.get('project_id') ?? '';
    if (!validId(tenant) || !validId(project)) return error('invalid_request');
    const scopes = [...new Set((form.get('scope') ?? 'orgbrain:read orgbrain:write').split(' '))];
    if (!scopes.length || scopes.some(s=>!['orgbrain:read','orgbrain:write'].includes(s))) return error('invalid_scope');
    const code = random(), alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const user = Array.from(crypto.getRandomValues(new Uint8Array(12)), b=>alphabet[b&31]).join('');
    await primary(env).prepare(`INSERT INTO oauth_device_requests(device_hash,user_hash,client_id,tenant_id,project_id,resource,scopes,expires_at,poll_after)
      VALUES(?,?,?,?,?,?,?,?,?)`).bind(await deviceHash(code),await deviceHash(user),DEVICE_CLIENT,tenant,project,env.MCP_OAUTH_RESOURCE!,JSON.stringify(scopes),now+DEVICE_TTL,now+5000).run();
    return result({device_code:code,user_code:user.match(/.{4}/gu)!.join('-'),verification_uri:`${url.origin}/oauth/device/verify`,
      verification_uri_complete:`${url.origin}/oauth/device/verify?user_code=${user}`,expires_in:DEVICE_TTL/1000,interval:5});
  } catch { return error('device_request_failed',503); }
}

// Keep refresh tombstones until family expiry so replay never becomes valid again.
export async function cleanupDeviceOAuth(env: Env, now = Date.now()) {
  if (!enabled(env)) return;
  const db=primary(env);
  await db.batch([
    db.prepare('DELETE FROM oauth_device_limits WHERE expires_at<=?').bind(now),
    db.prepare('DELETE FROM oauth_device_requests WHERE expires_at<=?').bind(now-86400_000),
    db.prepare("DELETE FROM oauth_device_tokens WHERE (kind='access' AND expires_at<=?) OR family_id IN (SELECT id FROM oauth_device_families WHERE expires_at<=?)").bind(now,now),
    db.prepare('DELETE FROM oauth_device_families WHERE expires_at<=?').bind(now)
  ]);
}
