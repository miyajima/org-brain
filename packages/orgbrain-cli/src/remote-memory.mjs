import { mkdir, lstat, chmod, readFile, writeFile, rename, unlink, rmdir } from 'node:fs/promises';
import { resolve, join, dirname, sep } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { modernMcpHeaders, modernMcpRequest } from './lib/mcp-modern-request.mjs';

const CLIENT = 'orgbrain-cloud-cli', GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const validId = s => typeof s === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/u.test(s);
export function remoteIdentity({endpoint, tenantId, projectId, credentialDir} = {}) {
  let url;
  try { url = new URL(endpoint); } catch { throw new Error('invalid_remote_endpoint'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/mcp') throw new Error('invalid_remote_endpoint');
  if (!validId(tenantId) || !validId(projectId)) throw new Error('explicit_tenant_and_project_required');
  const directory = resolve(credentialDir ?? join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'org-brain', 'remote'));
  const managed = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
  if (directory === managed || directory.startsWith(managed+sep) || directory.split(sep).includes('.codex')) throw new Error('managed_codex_directory_forbidden');
  const key = createHash('sha256').update(JSON.stringify([url.href, tenantId, projectId])).digest('hex');
  return { endpoint:url.href, origin:url.origin, tenantId, projectId, directory, file:join(directory,`${key}.json`) };
}
async function checkNode(path, directory = false) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error('unsafe_credential_path');
  if (process.platform !== 'win32' && ((stat.mode & 0o077) || typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('unsafe_credential_permissions');
}
async function ensureDirectory(path) {
  // Check every existing ancestor for symlinks; never follow one to a secret store.
  for (let p=path;;p=dirname(p)) {
    try { if ((await lstat(p)).isSymbolicLink()) throw new Error('unsafe_credential_path'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (dirname(p) === p) break;
  }
  await mkdir(path,{recursive:true,mode:0o700});
  await checkNode(path,true);
}
export async function withCredentialLock(identity, work) {
  await ensureDirectory(identity.directory);
  const lock = `${identity.file}.lock`;
  try { await mkdir(lock,{mode:0o700}); } catch (e) { if (e.code === 'EEXIST') throw new Error('credential_operation_in_progress'); throw e; }
  try { return await work(); } finally { await rmdir(lock); }
}
export async function loadRemoteCredential(identity, {missing = false} = {}) {
  try {
    await checkNode(identity.directory,true); await checkNode(identity.file);
    const c = JSON.parse(await readFile(identity.file,'utf8'));
    if (c.version !== 1 || c.endpoint !== identity.endpoint || c.tenant_id !== identity.tenantId || c.project_id !== identity.projectId ||
      !/^odb_a_[a-f0-9]{64}$/u.test(c.access_token) || !/^odb_r_[a-f0-9]{64}$/u.test(c.refresh_token) ||
      !Number.isSafeInteger(c.access_expires_at) || !Number.isSafeInteger(c.refresh_expires_at) ||
      !Array.isArray(c.scopes) || c.scopes.some(s=>!['orgbrain:read','orgbrain:write'].includes(s))) throw new Error('invalid_remote_credential');
    return c;
  } catch (e) { if (e.code === 'ENOENT' && missing) return null; throw new Error(e.code === 'ENOENT' ? 'remote_login_required' : 'unsafe_or_invalid_remote_credential'); }
}
async function save(identity,c) {
  const tmp = `${identity.file}.${randomBytes(16).toString('hex')}.tmp`;
  try {
    await writeFile(tmp,JSON.stringify(c),{mode:0o600,flag:'wx'});
    await chmod(tmp,0o600); await rename(tmp,identity.file); await checkNode(identity.file);
  } finally { await unlink(tmp).catch(e=>{if(e.code !== 'ENOENT') throw e;}); }
}
async function boundedText(response, max = 256*1024) {
  if (!response.body) throw new Error('remote_empty_response');
  const reader = response.body.getReader(), chunks = []; let size=0;
  try { for (;;) { const {value,done}=await reader.read(); if(done) break; size+=value.byteLength;
    if(size>max) { await reader.cancel(); throw new Error('remote_response_too_large'); } chunks.push(value); } }
  finally {reader.releaseLock();}
  const bytes = new Uint8Array(size); let offset=0;
  for(const part of chunks) {bytes.set(part,offset);offset+=part.length;}
  return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}
async function oauth(identity,path,fields,fetchImpl) {
  let response;
  try { response = await fetchImpl(`${identity.origin}${path}`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10_000),
    headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:CLIENT,resource:identity.endpoint,...fields})}); }
  catch { throw new Error('remote_oauth_connection_failed'); }
  let data;
  try { data=JSON.parse(await boundedText(response,16*1024)); } catch { throw new Error('remote_oauth_invalid_response'); }
  if (!response.ok) {
    const allowed = ['authorization_pending','slow_down','expired_token','access_denied','invalid_grant','device_flow_disabled','invalid_scope','invalid_target','invalid_client'];
    throw new Error(allowed.includes(data.error) ? data.error : `remote_oauth_http_${response.status}`);
  }
  return data;
}
function credential(identity,data,now) {
  if (!/^odb_a_[a-f0-9]{64}$/u.test(data.access_token) || !/^odb_r_[a-f0-9]{64}$/u.test(data.refresh_token) || data.token_type !== 'Bearer' ||
    data.tenant_id !== identity.tenantId || data.project_id !== identity.projectId || data.resource !== identity.endpoint ||
    !Number.isSafeInteger(data.expires_in) || data.expires_in<1 || data.expires_in>600 ||
    !Number.isSafeInteger(data.refresh_expires_at) || data.refresh_expires_at<=now || data.refresh_expires_at>now+30*86400_000 ||
    typeof data.scope !== 'string' || data.scope.split(' ').some(s=>!['orgbrain:read','orgbrain:write'].includes(s))) throw new Error('remote_oauth_token_response_mismatch');
  return {version:1,endpoint:identity.endpoint,tenant_id:identity.tenantId,project_id:identity.projectId,
    scopes:data.scope.split(' '),access_token:data.access_token,refresh_token:data.refresh_token,
    access_expires_at:now+data.expires_in*1000,refresh_expires_at:data.refresh_expires_at};
}
function summary(identity,c) {return {backend:'remote-mcp',endpoint:identity.endpoint,tenant_id:identity.tenantId,project_id:identity.projectId,
  logged_in:Boolean(c),credential_path:identity.file,...(c ? {scopes:c.scopes,access_expires_at:c.access_expires_at,refresh_expires_at:c.refresh_expires_at} : {})};}
export async function loginRemote(options,{fetchImpl=globalThis.fetch,now=Date.now,
  sleep=ms=>new Promise(r=>setTimeout(r,ms)),onVerification=()=>{}}={}) {
  const id=remoteIdentity(options);
  return withCredentialLock(id,async()=>{
    if (await loadRemoteCredential(id,{missing:true})) throw new Error('logout_before_replacing_credential');
    const start=now(), response=await oauth(id,'/oauth/device/code',{tenant_id:id.tenantId,project_id:id.projectId,scope:'orgbrain:read orgbrain:write'},fetchImpl);
    let verification;
    try { verification=new URL(response.verification_uri_complete); } catch { throw new Error('remote_device_response_mismatch'); }
    if (!/^[a-f0-9]{64}$/u.test(response.device_code) || !/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/u.test(response.user_code) ||
      response.verification_uri !== `${id.origin}/oauth/device/verify` || verification.origin!==id.origin || verification.pathname!=='/oauth/device/verify' ||
      verification.username || verification.password || verification.hash || [...verification.searchParams.keys()].some(k=>k!=='user_code') ||
      verification.searchParams.get('user_code')!==response.user_code.replaceAll('-','') ||
      !Number.isSafeInteger(response.expires_in) || response.expires_in<1 || response.expires_in>600 ||
      response.interval !== undefined && (!Number.isSafeInteger(response.interval)||response.interval<5||response.interval>60)) throw new Error('remote_device_response_mismatch');
    onVerification({verification_uri:response.verification_uri,verification_uri_complete:verification.href,user_code:response.user_code});
    let interval=(response.interval??5)*1000, deadline=start+response.expires_in*1000;
    while (now()<deadline) {
      await sleep(interval);
      if (now()>=deadline) break;
      try {
        const tokens=await oauth(id,'/oauth/token',{grant_type:GRANT,device_code:response.device_code},fetchImpl);
        const c=credential(id,tokens,now()); await save(id,c); return summary(id,c);
      } catch (e) {
        if (e.message==='slow_down') interval+=5000;
        else if(e.message==='remote_oauth_connection_failed') interval*=2;
        else if(e.message!=='authorization_pending') throw e;
      }
    }
    throw new Error('expired_token');
  });
}
async function refreshLocked(id,c,fetchImpl,now) {
  if(c.refresh_uncertain) throw new Error('remote_refresh_uncertain_logout_required');
  if(c.refresh_expires_at<=now()) throw new Error('remote_login_required');
  // A failed/ambiguous refresh must never resend the consumed token automatically.
  await save(id,{...c,refresh_uncertain:true});
  const data=await oauth(id,'/oauth/token',{grant_type:'refresh_token',refresh_token:c.refresh_token},fetchImpl);
  const next=credential(id,data,now()); await save(id,next); return next;
}
export async function refreshRemote(options,{fetchImpl=globalThis.fetch,now=Date.now}={}) {
  const id=remoteIdentity(options); return withCredentialLock(id,async()=>summary(id,await refreshLocked(id,await loadRemoteCredential(id),fetchImpl,now)));
}
export async function logoutRemote(options,{fetchImpl=globalThis.fetch}={}) {
  const id=remoteIdentity(options); return withCredentialLock(id,async()=>{
    const c=await loadRemoteCredential(id,{missing:true});
    if(c) {
      // Keep the file if revocation failed: retrying logout remains possible.
      let response;
      try { response=await fetchImpl(`${id.origin}/oauth/revoke`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10_000),
        headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:CLIENT,token:c.refresh_token})}); }
      catch {throw new Error('remote_revocation_failed');}
      if(!response.ok) throw new Error('remote_revocation_failed');
      await unlink(id.file);
    }
    return {...summary(id,null),revoked:Boolean(c)};
  });
}
export async function remoteStatus(options) {const id=remoteIdentity(options);return summary(id,await loadRemoteCredential(id,{missing:true}));}
export async function callRemoteMemory(action,payload,options,{fetchImpl=globalThis.fetch,now=Date.now}={}) {
  const id=remoteIdentity(options);
  const tools={search:'orgbrain_memories_search',propose:'orgbrain_memories_propose',confirm:'orgbrain_memories_confirm','confirmation-status':'orgbrain_memories_confirmation_status'};
  if(!tools[action] || !payload || typeof payload!=='object' || Array.isArray(payload)) throw new Error('invalid_remote_memory_action');
  if(payload.tenant_id && payload.tenant_id!==id.tenantId || payload.project_id && payload.project_id!==id.projectId ||
    payload.item?.project_id && payload.item.project_id!==id.projectId) throw new Error('remote_project_boundary');
  let args={...payload,tenant_id:id.tenantId};
  if(action==='search') {if(payload.scope && payload.scope!=='mine') throw new Error('remote_private_scope_required');args={...args,project_id:id.projectId,scope:'mine'};}
  if(action==='propose') {if(!payload.item || typeof payload.item!=='object') throw new Error('remote_proposal_item_required');args={...args,item:{...payload.item,project_id:id.projectId}};}
  // An approved field is explicit human review. No stage/status command adds it.
  if(action==='confirm' && typeof payload.approved!=='boolean') throw new Error('explicit_review_decision_required');
  return withCredentialLock(id,async()=>{
    let c=await loadRemoteCredential(id);
    if(c.refresh_uncertain) throw new Error('remote_refresh_uncertain_logout_required');
    if(!c.scopes.includes(action==='search'||action==='confirmation-status'?'orgbrain:read':'orgbrain:write')) throw new Error('remote_insufficient_scope');
    if(c.access_expires_at<=now()+30_000) c=await refreshLocked(id,c,fetchImpl,now);
    let response;
    try {response=await fetchImpl(id.endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15_000),
      headers:{...modernMcpHeaders('tools/call',tools[action]),authorization:`Bearer ${c.access_token}`},
      body:JSON.stringify(modernMcpRequest({id:1,method:'tools/call',name:tools[action],params:{arguments:args}}))});}
    catch {throw new Error('remote_mcp_request_failed');}
    if(!response.ok) throw new Error(`remote_mcp_http_${response.status}`);
    let rpc;
    try {
      const raw=await boundedText(response);
      if(response.headers.get('content-type')?.includes('text/event-stream')) {
        rpc=raw.split(/\r?\n\r?\n/u).map(e=>e.split(/\r?\n/u).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n')).filter(Boolean).map(e=>JSON.parse(e)).find(e=>e.id===1);
      } else rpc=JSON.parse(raw);
      if(rpc.id!==1 || rpc.error || rpc.result?.isError) throw new Error();
      const data=rpc.result.structuredContent??JSON.parse(rpc.result.content.find(x=>x.type==='text').text);
      if(data.tenant_id && data.tenant_id!==id.tenantId || data.project_id && data.project_id!==id.projectId) throw new Error();
      return {backend:'remote-mcp',tenant_id:id.tenantId,project_id:id.projectId,result:data};
    } catch {throw new Error('remote_mcp_invalid_or_failed_response');}
  });
}
export async function runRemoteCli(action,rest,args,readStdin) {
  const options={endpoint:args.get('--mcp-url',process.env.ORGBRAIN_MCP_URL),tenantId:args.get('--tenant-id'),projectId:args.get('--project-id'),credentialDir:args.get('--credential-dir')};
  if(action==='login') return loginRemote(options,{onVerification:r=>process.stderr.write(`モバイルブラウザで接続先・project・権限を確認して許可してください:\n${r.verification_uri_complete}\n`)});
  if(action==='refresh') return refreshRemote(options);
  if(action==='logout') return logoutRemote(options);
  if(action==='status') return remoteStatus(options);
  const raw=args.get('--input') ? await readFile(args.get('--input'),'utf8') : action==='search' ? null : await readStdin();
  let payload;
  try {payload=action==='search'?{q:rest.join(' ')}:JSON.parse(raw);} catch {throw new Error('invalid_remote_input');}
  return callRemoteMemory(action,payload,options);
}
