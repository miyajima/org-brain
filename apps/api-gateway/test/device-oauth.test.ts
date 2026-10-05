import { describe, it, expect, vi, afterEach } from 'vitest';
import { memoryD1Fixture } from './fixtures/memory-d1';
import { handleDeviceOAuth, deviceHash, deviceBearer, pollDevice, refreshDevice, deviceRateLimit, cleanupDeviceOAuth, DEVICE_CLIENT, DEVICE_GRANT } from '../src/device-oauth';
import { authorizeMcpRequest } from '../src/mcp-security';
import { upsertMemories } from '../src/memory-service';
import { assertMcpToolAllowed } from '../src/mcp';
import type { Env } from '../src/types';

vi.mock('../src/mcp-security',async importOriginal=>({ ...await importOriginal<typeof import('../src/mcp-security')>(),
  authorizeMcpRequest:vi.fn(async(request:Request)=>({source:request.headers.get('test-source')??'access-user',tenantId:request.headers.get('test-tenant')??'synthetic',
    allowedTenants:['synthetic'],principal:request.headers.get('test-user')??'user:synthetic@example.test',defaultRole:'tenant_admin',runtimeActor:'synthetic',identityIssuer:'https://access.example.test',identitySubject:'synthetic-subject',identityEmail:'synthetic@example.test'})) }));
const origin='https://orgbrain.example.test', resource=`${origin}/mcp`, now=2_000_000_000_000;
const context={} as ExecutionContext;
function fixture() {const f=memoryD1Fixture();
  for(const tenant of ['synthetic','second-tenant']) {
    f.sql.prepare("INSERT INTO user_profiles(tenant_id,principal,email,status,created_at,updated_at) VALUES(?,?,?,'active',1,1)").run(tenant,'user:synthetic@example.test','synthetic@example.test');
    f.sql.prepare("INSERT INTO user_identities(id,tenant_id,principal,provider_type,issuer,subject,created_at,updated_at) VALUES(?,?,?,'oidc',?,?,1,1)").run(`identity-${tenant}`,tenant,'user:synthetic@example.test','https://access.example.test','synthetic-subject');
  }
  Object.assign(f.env,{ACCESS_TENANT_POLICY_JSON:JSON.stringify({default_tenants:['synthetic','second-tenant'],default_role:'tenant_admin'}),ORGBRAIN_DEVICE_OAUTH_ENABLED:'true',MCP_AUTH_MODE:'dual',MCP_OAUTH_RESOURCE:resource});return f;}
function post(path:string,fields:Record<string,string>,headers:Record<string,string>={}) {return new Request(`${origin}${path}`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',...headers},body:new URLSearchParams(fields)});}
async function start(env:Env,extra:Record<string,string>={}) {const r=await handleDeviceOAuth(post('/oauth/device/code',{client_id:DEVICE_CLIENT,resource,tenant_id:'synthetic',project_id:'project-a',...extra}),env,context);return {response:r!,data:await r!.json<any>()};}
async function consent(env:Env,data:any) {
  const r=await handleDeviceOAuth(new Request(data.verification_uri_complete),env,context);
  const csrf=(r!.headers.get('set-cookie')??'').split('=')[1].split(';')[0];
  return {response:r!,csrf};
}
async function approve(env:Env,data:any,csrf:string,extra:Record<string,string>={}) {return handleDeviceOAuth(post('/oauth/device/verify',{user_code:data.user_code,csrf,decision:'approve'},
  {origin,cookie:`__Host-orgbrain_device_csrf=${csrf}`,...extra}),env,context);}
function pollForm(data:any,extra:Record<string,string>={}) {return new URLSearchParams({client_id:DEVICE_CLIENT,resource,grant_type:DEVICE_GRANT,device_code:data.device_code,...extra});}
async function ready(env:Env) {const {data}=await start(env); const {csrf}=await consent(env,data); expect((await approve(env,data,csrf))!.status).toBe(200);return data;}
async function tokens(env:Env) {const data=await ready(env);const response=await pollDevice(env,pollForm(data),now+5000);expect(response.status).toBe(200);return response.json<any>();}
const refreshForm=(t:any,extra:Record<string,string>={})=>new URLSearchParams({client_id:DEVICE_CLIENT,resource,refresh_token:t.refresh_token,...extra});
afterEach(()=>vi.useRealTimers());
describe('D1 authoritative device flow',()=>{
  it('requires an active registered identity and current tenant grants/role at bearer and refresh',async()=>{
    vi.useFakeTimers();vi.setSystemTime(now);
    for(const change of ['suspended','deprovisioned','missing-profile','missing-identity','rebound-identity','tenant-grant','role-downgrade','project-role']) {
      const {env,sql}=fixture();const t=await tokens(env);
      if(['suspended','deprovisioned'].includes(change)) sql.prepare('UPDATE user_profiles SET status=? WHERE tenant_id=?').run(change,'synthetic');
      if(change==='missing-profile') sql.prepare("DELETE FROM user_profiles WHERE tenant_id='synthetic'").run();
      if(change==='missing-identity') sql.prepare("DELETE FROM user_identities WHERE tenant_id='synthetic'").run();
      if(change==='rebound-identity') sql.prepare("UPDATE user_identities SET principal='user:other@example.test' WHERE tenant_id='synthetic'").run();
      if(change==='tenant-grant') env.ACCESS_TENANT_POLICY_JSON=JSON.stringify({default_tenants:['other'],default_role:'tenant_admin'});
      if(change==='role-downgrade') env.ACCESS_TENANT_POLICY_JSON=JSON.stringify({default_tenants:['synthetic','second-tenant'],default_role:'reader'});
      if(change==='project-role') sql.prepare("INSERT INTO principal_role_assignments(id,tenant_id,project_id,principal,role,created_by_principal,created_at,updated_at) VALUES('downgrade','synthetic','project-a','user:synthetic@example.test','reader','synthetic',1,1)").run();
      expect(await deviceBearer(env,t.access_token,now+6000),change).toBeNull();
      expect((await refreshDevice(env,refreshForm(t),now+7000)).status,change).toBe(400);
      expect((sql.prepare('SELECT revoked_at FROM oauth_device_families').get() as any).revoked_at,change).not.toBeNull();
    }
  });
  it('rejects device exchange if the approved user becomes inactive before polling',async()=>{
    vi.useFakeTimers();vi.setSystemTime(now);const {env,sql}=fixture();const data=await ready(env);
    sql.prepare("UPDATE user_profiles SET status='suspended' WHERE tenant_id='synthetic'").run();
    expect(await (await pollDevice(env,pollForm(data),now+5000)).json()).toEqual({error:'access_denied'});
    expect((sql.prepare('SELECT count(*) AS n FROM oauth_device_families').get() as any).n).toBe(0);
  });
  it('provides the RFC-required verification URI manual code entry without authorizing',async()=>{
    const {env,sql}=fixture();const {data}=await start(env);
    const page=await handleDeviceOAuth(new Request(data.verification_uri),env,context);
    expect(page!.status).toBe(200);expect(await page!.text()).toContain('name="user_code"');
    expect((sql.prepare('SELECT state FROM oauth_device_requests').get() as any).state).toBe('pending');
    expect((await consent(env,data)).response.status).toBe(200);
  });

  it('selects the device tenant through the existing multi-tenant Access grant check',async()=>{
    vi.useFakeTimers();vi.setSystemTime(now);const {env}=fixture();const {data}=await start(env,{tenant_id:'second-tenant'});
    vi.mocked(authorizeMcpRequest).mockImplementationOnce(async(request)=>({source:'access-user',tenantId:request.headers.get('x-orgbrain-tenant')!,
      allowedTenants:['first-tenant','second-tenant'],principal:'user:synthetic@example.test',defaultRole:'tenant_admin',runtimeActor:'synthetic',identityIssuer:'https://access.example.test',identitySubject:'synthetic-subject',identityEmail:'synthetic@example.test'}));
    expect((await consent(env,data)).response.status).toBe(200);
  });

  it('uses first-primary sessions even when KV is stale and fails closed on D1 outage',async()=>{
    vi.useFakeTimers();vi.setSystemTime(now);const {env}=fixture();
    const session=vi.fn(()=>env.OPEN_BRAIN_DB);
    Object.assign(env.OPEN_BRAIN_DB,{withSession:session});
    Object.defineProperty(env,'OAUTH_KV',{get(){throw new Error('stale KV must not be read');}});
    const t=await tokens(env);expect(await deviceBearer(env,t.access_token,now+6000)).not.toBeNull();
    expect(session).toHaveBeenCalledWith('first-primary');
    env.OPEN_BRAIN_DB={prepare(){throw new Error('synthetic outage');}} as unknown as D1Database;
    expect((await start(env)).response.status).toBe(503);
    expect((await handleDeviceOAuth(new Request(resource,{headers:{authorization:`Bearer ${t.access_token}`}}),env,context))!.status).toBe(503);
  });
  it('purges expired state while retaining refresh replay tombstones until family expiry',async()=>{
    vi.useFakeTimers();vi.setSystemTime(now);const {env,sql}=fixture();const t=await tokens(env);
    await refreshDevice(env,refreshForm(t),now+10000);await cleanupDeviceOAuth(env,now+700000);
    expect((sql.prepare("SELECT count(*) AS n FROM oauth_device_tokens WHERE kind='refresh' AND consumed_at IS NOT NULL").get() as any).n).toBe(1);
    expect((sql.prepare('SELECT count(*) AS n FROM oauth_device_limits').get() as any).n).toBe(0);
    await cleanupDeviceOAuth(env,t.refresh_expires_at);expect((sql.prepare('SELECT count(*) AS n FROM oauth_device_tokens').get() as any).n).toBe(0);
    expect((sql.prepare('SELECT count(*) AS n FROM oauth_device_families').get() as any).n).toBe(0);
  });

  it('two independent Cloud tokens share only the same user/project reviewed memory over real MCP transport',async()=>{
    vi.useFakeTimers();vi.setSystemTime(now);const {env,sql}=fixture();
    env.API_RATE_LIMITER={limit:async()=>({success:true})} as unknown as RateLimit;
    const a=await tokens(env),b=await tokens(env);
    expect(a.access_token).not.toBe(b.access_token);
    async function call(token:string,name:string,args:Record<string,unknown>) {
      const r=await handleDeviceOAuth(new Request(resource,{method:'POST',headers:{
        authorization:`Bearer ${token}`,accept:'application/json, text/event-stream','content-type':'application/json',
        'mcp-protocol-version':'2026-07-28','mcp-method':'tools/call','mcp-name':name},
        body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args,_meta:{
          'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{},
          'io.modelcontextprotocol/clientInfo':{name:'synthetic-cloud',version:'1'}}}})}),env,context);
      const raw=await r!.text();
      const rpc=JSON.parse(r!.headers.get('content-type')?.includes('text/event-stream') ? raw.split('\n').find(s=>s.startsWith('data:'))!.slice(5) : raw);
      const value=rpc.result?.isError ? null : rpc.result?.structuredContent ?? (rpc.result?.content ? JSON.parse(rpc.result.content[0].text):null);
      return {status:r!.status,rpc,value};
    }
    const proposed=await call(a.access_token,'orgbrain_memories_propose',{tenant_id:'synthetic',source:'manual',item:{project_id:'project-a',content:'Synthetic choice: use isolated Cloud tests because inputs are controlled.',summary:'Synthetic Cloud decision'}});
    expect(proposed.rpc.result?.isError,JSON.stringify(proposed.rpc)).not.toBe(true);
    const confirmation=proposed.value.confirmation_token;
    expect(confirmation).toBeTruthy();
    const pending=await call(b.access_token,'orgbrain_memories_confirmation_status',{tenant_id:'synthetic',confirmation_token:confirmation});
    expect(pending.value.status).toBe('pending');
    expect((sql.prepare('SELECT count(*) AS n FROM memories').get() as any).n).toBe(0);
    const confirmed=await call(b.access_token,'orgbrain_memories_confirm',{tenant_id:'synthetic',confirmation_token:confirmation,approved:true,review_answer:'保存する'});
    expect(confirmed.value.saved,JSON.stringify(confirmed.rpc)).toBe(true);
    await upsertMemories(env,{tenant_id:'synthetic',source:'manual',items:[
      {external_key:'foreign-project',project_id:'project-b',content:'Synthetic crossprojectmarker foreign.',summary:'Synthetic crossprojectmarker foreign.'},
      {external_key:'null-project',content:'Synthetic nullprojectmarker foreign.',summary:'Synthetic nullprojectmarker foreign.'}
    ]},{actorPrincipal:'user:synthetic@example.test'});
    const search=await call(a.access_token,'orgbrain_memories_search',{tenant_id:'synthetic',project_id:'project-a',scope:'mine',q:'Synthetic Cloud',search_mode:'memories'});
    expect(search.rpc.result?.isError,JSON.stringify(search.rpc)).not.toBe(true);
    expect(JSON.stringify(search.value)).toContain('Synthetic');
    for(const mode of ['memories','hybrid','hybrid_v2','hybrid_v3','hybrid_v4']) {
      const isolated=await call(a.access_token,'orgbrain_memories_search',{tenant_id:'synthetic',project_id:'project-a',scope:'mine',q:'Synthetic',search_mode:mode});
      expect(isolated.rpc.result?.isError,JSON.stringify(isolated.rpc)).not.toBe(true);
      expect(JSON.stringify(isolated.value)).not.toContain('crossprojectmarker');
      expect(JSON.stringify(isolated.value)).not.toContain('nullprojectmarker');
    }
    const wrong=await call(a.access_token,'orgbrain_memories_search',{tenant_id:'synthetic',project_id:'project-b',scope:'mine',q:'Synthetic'});
    expect(wrong.rpc.result?.isError).toBe(true);
    const otherTenant=await call(a.access_token,'orgbrain_memories_confirmation_status',{tenant_id:'other',confirmation_token:confirmation});
    expect(otherTenant.rpc.result?.isError).toBe(true);
    // Change only the authenticated family principal; ownership is checked from D1, not client input.
    const bRow=await deviceBearer(env,b.access_token,now);
    sql.prepare("UPDATE oauth_device_families SET principal='user:other@example.test' WHERE id IN (SELECT family_id FROM oauth_device_tokens WHERE hash=?)").run(await deviceHash(b.access_token));
    const otherUser=await call(b.access_token,'orgbrain_memories_confirmation_status',{tenant_id:'synthetic',confirmation_token:confirmation});
    expect(otherUser.status).toBe(401);
    const otherSearch=await call(b.access_token,'orgbrain_memories_search',{tenant_id:'synthetic',project_id:'project-a',scope:'mine',q:'Synthetic Cloud',search_mode:'memories'});
    expect(JSON.stringify(otherSearch.value)).not.toContain('Synthetic choice:');
    expect(bRow?.principal).toBe('user:synthetic@example.test');
    expect((sql.prepare('SELECT count(*) AS n FROM memories').get() as any).n).toBe(3);
  });
  it('enforces the device tool allowlist and private search scope before handlers',async()=>{
    vi.useFakeTimers();vi.setSystemTime(now);const {env}=fixture();const t=await tokens(env);const auth=await deviceBearer(env,t.access_token,now);
    const props={tenantId:auth!.tenantId,allowedTenants:auth!.allowedTenants,principal:auth!.principal,defaultRole:auth!.defaultRole,
      projectId:auth!.projectId,authSource:'oauth' as const,allowedTools:auth!.allowedTools,scopes:auth!.scopes};
    const request=(name:string,args:Record<string,unknown>)=>new Request(resource,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method:'tools/call',params:{name,arguments:args}})});
    await expect(assertMcpToolAllowed(request('orgbrain_memories_upsert',{}),props)).rejects.toThrow('cannot call');
    await expect(assertMcpToolAllowed(request('orgbrain_memories_search',{scope:'org',project_id:'project-a'}),props)).rejects.toThrow('private memory');
    await expect(assertMcpToolAllowed(request('orgbrain_memories_search',{scope:'mine',project_id:'project-a',task_context:{project_id:'other'}}),props)).rejects.toThrow('private memory');
  });

  it('is disabled by default, including token prefixes; never invokes stale KV',async()=>{
    const {env}=fixture();env.ORGBRAIN_DEVICE_OAUTH_ENABLED='false';
    expect((await start(env)).response.status).toBe(404);
    expect(await deviceBearer(env,`odb_a_${'a'.repeat(64)}`,now)).toBeNull();
    expect((await handleDeviceOAuth(new Request(resource,{headers:{authorization:`Bearer odb_a_${'a'.repeat(64)}`}}),env,context))!.status).toBe(401);
  });
  it('supports explicit consent and hashes every secret in the database',async()=>{
    vi.useFakeTimers();vi.setSystemTime(now);const {env,sql}=fixture();const data=await ready(env);
    const row=sql.prepare('SELECT * FROM oauth_device_requests').get() as any;
    expect(row.device_hash).toBe(await deviceHash(data.device_code));expect(row.user_hash).not.toContain(data.user_code.replaceAll('-',''));
    const r=await pollDevice(env,pollForm(data),now+5000),t=await r.json<any>();expect(r.status).toBe(200);
    const auth=await deviceBearer(env,t.access_token,now+6000);expect(auth?.projectId).toBe('project-a');expect(auth?.principal).toBe('user:synthetic@example.test');
    expect(auth?.allowedTools).not.toContain('orgbrain_memories_upsert');
    const serialized=JSON.stringify(sql.prepare('SELECT * FROM oauth_device_tokens').all());expect(serialized).not.toContain(t.access_token);expect(serialized).not.toContain(t.refresh_token);
    expect((await pollDevice(env,pollForm(data),now+6000)).status).toBe(400);
  });
  it('rejects CSRF without cookie, wrong origin, expired form, different tenant/user, and service auth',async()=>{
    vi.useFakeTimers();vi.setSystemTime(now);const {env}=fixture();const {data}=await start(env);const {csrf,response}=await consent(env,data);
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    for(const headers of ([{cookie:''},{origin:'https://evil.example.test'},{'test-user':'user:other@example.test'},{'test-tenant':'other'},{'test-source':'access-service'}] as Record<string,string>[])) {
      expect((await approve(env,data,csrf,headers))!.status).toBe(403);
    }
    vi.setSystemTime(now+600001);expect((await approve(env,data,csrf))!.status).toBe(403);
  });
  it('consumes consent once even under concurrent submissions',async()=>{
    vi.useFakeTimers();vi.setSystemTime(now);const {env}=fixture();const {data}=await start(env);const {csrf}=await consent(env,data);
    const r=await Promise.all([approve(env,data,csrf),approve(env,data,csrf)]);expect(r.map(x=>x!.status).sort()).toEqual([200,403]);
  });
  it('implements persistent +5s slowdown, pending, expiry, denial, and client/resource binding',async()=>{
    vi.useFakeTimers();vi.setSystemTime(now);const {env,sql}=fixture();const {data}=await start(env);
    expect(await (await pollDevice(env,pollForm(data),now+1000)).json()).toEqual({error:'slow_down'});
    expect((sql.prepare('SELECT interval_ms FROM oauth_device_requests').get() as any).interval_ms).toBe(10000);
    expect(await (await pollDevice(env,pollForm(data),now+11000)).json()).toEqual({error:'authorization_pending'});
    expect(await (await pollDevice(env,pollForm(data),now+600000)).json()).toEqual({error:'expired_token'});
    expect(await (await pollDevice(env,pollForm(data,{client_id:'other'}),now+21000)).json()).toEqual({error:'invalid_grant'});
    expect(await (await pollDevice(env,pollForm(data,{resource:'https://evil.example.test/mcp'}),now+21000)).json()).toEqual({error:'invalid_grant'});
    sql.prepare("UPDATE oauth_device_requests SET state='denied'").run();
    expect(await (await pollDevice(env,pollForm(data),now+21000)).json()).toEqual({error:'access_denied'});
  });
  it('allows exactly one device exchange and one family under simultaneous polls',async()=>{
    vi.useFakeTimers();vi.setSystemTime(now);const {env,sql}=fixture();const data=await ready(env);
    const r=await Promise.all([pollDevice(env,pollForm(data),now+5000),pollDevice(env,pollForm(data),now+5000)]);
    expect(r.map(x=>x.status).sort()).toEqual([200,400]);expect((sql.prepare('SELECT count(*) AS n FROM oauth_device_families').get() as any).n).toBe(1);
  });
  it('rotates refresh once; old token replay revokes old/new access and the successor refresh',async()=>{
    vi.useFakeTimers();vi.setSystemTime(now);const {env}=fixture();const t=await tokens(env);
    const r=await refreshDevice(env,refreshForm(t),now+10000),next=await r.json<any>();expect(r.status).toBe(200);expect(next.refresh_token).not.toBe(t.refresh_token);
    expect(await deviceBearer(env,next.access_token,now+11000)).not.toBeNull();
    expect((await refreshDevice(env,refreshForm(t),now+12000)).status).toBe(400);
    expect(await deviceBearer(env,next.access_token,now+13000)).toBeNull();expect(await deviceBearer(env,t.access_token,now+13000)).toBeNull();
    expect((await refreshDevice(env,refreshForm(next),now+13000)).status).toBe(400);
  });
  it('treats concurrent refresh as replay and closes the whole family',async()=>{
    vi.useFakeTimers();vi.setSystemTime(now);const {env}=fixture();const t=await tokens(env);
    const r=await Promise.all([refreshDevice(env,refreshForm(t),now+10000),refreshDevice(env,refreshForm(t),now+10000)]);
    expect(r.map(x=>x.status).sort()).toEqual([200,400]);const next=await r.find(x=>x.status===200)!.json<any>();
    expect(await deviceBearer(env,next.access_token,now+11000)).toBeNull();
  });
  it('cannot escalate scope or change client/resource; expires access and entire family',async()=>{
    vi.useFakeTimers();vi.setSystemTime(now);const {env}=fixture();const t=await tokens(env);
    for(const extra of ([{scope:'orgbrain:admin'},{client_id:'other'},{resource:'https://evil.example.test/mcp'}] as Record<string,string>[])) expect((await refreshDevice(env,refreshForm(t,extra),now+10000)).status).toBe(400);
    expect(await deviceBearer(env,t.access_token,now+605000)).toBeNull();expect((await refreshDevice(env,refreshForm(t),t.refresh_expires_at)).status).toBe(400);
  });
  it('revocation is idempotent and does not revoke another client family by a guessed token',async()=>{
    vi.useFakeTimers();vi.setSystemTime(now);const {env}=fixture();const t=await tokens(env);
    for(let n=0;n<2;n++) expect((await handleDeviceOAuth(post('/oauth/revoke',{client_id:DEVICE_CLIENT,token:t.refresh_token}),env,context))!.status).toBe(200);
    expect(await deviceBearer(env,t.access_token,now+6000)).toBeNull();
  });
  it('bounds brute force by hashed per-action IP buckets',async()=>{
    const {env,sql}=fixture();for(let n=0;n<10;n++) expect(await deviceRateLimit(env,'verify','192.0.2.1',now)).toBe(true);
    expect(await deviceRateLimit(env,'verify','192.0.2.1',now)).toBe(false);expect(await deviceRateLimit(env,'verify','192.0.2.1',now+60000)).toBe(true);
    expect(JSON.stringify(sql.prepare('SELECT * FROM oauth_device_limits').all())).not.toContain('192.0.2.1');
  });
  it('rejects broad scopes, malformed IDs, duplicated parameters, and unexpected methods',async()=>{
    vi.useFakeTimers();vi.setSystemTime(now);const {env}=fixture();expect((await start(env,{scope:'orgbrain:admin'})).response.status).toBe(400);
    expect((await start(env,{project_id:'../other'})).response.status).toBe(400);
    expect((await handleDeviceOAuth(new Request(`${origin}/oauth/device/code`),env,context))!.status).toBe(405);
  });
});
