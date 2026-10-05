import { describe, it, expect, vi, afterEach } from 'vitest';
import { memoryD1Fixture } from './fixtures/memory-d1';
import { handleDeviceOAuth, deviceHash, deviceBearer, pollDevice, refreshDevice, deviceRateLimit, DEVICE_CLIENT, DEVICE_GRANT } from '../src/device-oauth';
import { assertMcpToolAllowed, createOrgBrainMcpServer } from '../src/mcp';
import type { Env } from '../src/types';

vi.mock('../src/mcp-security',async importOriginal=>({ ...await importOriginal<typeof import('../src/mcp-security')>(),
  authorizeMcpRequest:vi.fn(async(request:Request)=>({source:request.headers.get('test-source')??'access-user',tenantId:request.headers.get('test-tenant')??'synthetic',
    allowedTenants:['synthetic'],principal:request.headers.get('test-user')??'user:synthetic@example.test',defaultRole:'tenant_admin',runtimeActor:'synthetic'})) }));
const origin='https://orgbrain.example.test', resource=`${origin}/mcp`, now=2_000_000_000_000;
const context={} as ExecutionContext;
function fixture() {const f=memoryD1Fixture();Object.assign(f.env,{ORGBRAIN_DEVICE_OAUTH_ENABLED:'true',MCP_AUTH_MODE:'dual',MCP_OAUTH_RESOURCE:resource});return f;}
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
    for(const headers of [{cookie:''},{origin:'https://evil.example.test'},{'test-user':'user:other@example.test'},{'test-tenant':'other'},{'test-source':'access-service'}]) {
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
    for(const extra of [{scope:'orgbrain:admin'},{client_id:'other'},{resource:'https://evil.example.test/mcp'}]) expect((await refreshDevice(env,refreshForm(t,extra),now+10000)).status).toBe(400);
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
