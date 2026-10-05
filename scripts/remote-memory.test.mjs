import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,chmod,stat,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {remoteIdentity,loginRemote,refreshRemote,logoutRemote,remoteStatus,callRemoteMemory} from '../packages/orgbrain-cli/src/remote-memory.mjs';
const endpoint='https://orgbrain.example.test/mcp', origin='https://orgbrain.example.test', epoch=2000000000000;
const hex=n=>n.toString(16).padStart(64,'0');
const token=(n=1)=>({access_token:`odb_a_${hex(n)}`,refresh_token:`odb_r_${hex(n+1)}`,token_type:'Bearer',expires_in:600,
  refresh_expires_at:epoch+30*86400000,scope:'orgbrain:read orgbrain:write',tenant_id:'synthetic',project_id:'project-a',resource:endpoint});
const device=()=>({device_code:hex(99),user_code:'AAAA-BBBB-CCCC',verification_uri:`${origin}/oauth/device/verify`,
  verification_uri_complete:`${origin}/oauth/device/verify?user_code=AAAABBBBCCCC`,expires_in:600,interval:5});
const json=(body,status=200)=>Response.json(body,{status});
async function fixture(t) {const dir=await mkdtemp(join(tmpdir(),'orgbrain-remote-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const options={endpoint,tenantId:'synthetic',projectId:'project-a',credentialDir:join(dir,'private')};let clock=epoch;
  const deps={now:()=>clock,sleep:async ms=>{clock+=ms;}};
  async function login(extra={}) {return loginRemote(options,{...deps,fetchImpl:async url=>url.endsWith('/code')?json(device()):json(token()),...extra});}
  return {options,deps,login,id:remoteIdentity(options),setTime:n=>{clock=n;}};
}
test('project and tenant are explicit; endpoints and managed Codex paths are rejected',()=>{
  for(const endpoint of ['http://unsafe.test/mcp','https://user:pass@safe.test/mcp','https://safe.test/mcp?q=x','https://safe.test/other']) assert.throws(()=>remoteIdentity({endpoint,tenantId:'synthetic',projectId:'project-a'}));
  assert.throws(()=>remoteIdentity({endpoint,projectId:'project-a'}),/explicit/);
  assert.throws(()=>remoteIdentity({endpoint,tenantId:'synthetic',projectId:'project-a',credentialDir:'/workspace/.codex/credentials'}),/forbidden/);
});
test('device login honors pending, persistent slowdown, timeout backoff; output contains no credentials',async t=>{
  const f=await fixture(t), waits=[];let clock=epoch,count=0,verification;
  const result=await f.login({now:()=>clock,sleep:async ms=>{clock+=ms;waits.push(ms);},onVerification:r=>{verification=r;},fetchImpl:async(url,init)=>{
    assert.equal(init.redirect,'error');const form=new URLSearchParams(init.body);assert.equal(form.get('resource'),endpoint);
    if(url.endsWith('/code')) return json(device());
    if(count++===0)return json({error:'authorization_pending'},400);if(count===2)return json({error:'slow_down'},400);
    if(count===3)throw new Error('secret=never-output');return json(token());
  }});
  assert.deepEqual(waits,[5000,5000,10000,20000]);assert.equal(verification.user_code,'AAAA-BBBB-CCCC');
  assert.equal(result.logged_in,true);assert.doesNotMatch(JSON.stringify(result),/odb_[ar]_/);
  assert.equal((await stat(f.id.file)).mode&0o777,0o600);assert.equal((await stat(f.id.directory)).mode&0o777,0o700);
  assert.match(await readFile(f.id.file,'utf8'),/odb_a_/);
});
test('terminal denial/expiry stop polling and never create credentials',async t=>{
  const f=await fixture(t);for(const error of ['access_denied','expired_token']) {
    let calls=0;await assert.rejects(f.login({fetchImpl:async url=>{if(url.endsWith('/code'))return json(device());calls++;return json({error},400);}}),new RegExp(error));assert.equal(calls,1);
  }
  assert.equal((await remoteStatus(f.options)).logged_in,false);
});
test('verification URI substitution, bad scope, project or resource responses fail closed',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.login({fetchImpl:async()=>json({...device(),verification_uri_complete:'https://evil.example.test/verify'})}),/mismatch/);
  for(const extra of [{scope:'orgbrain:admin'},{project_id:'other'},{resource:'https://evil.example.test/mcp'}]) await assert.rejects(f.login({fetchImpl:async url=>url.endsWith('/code')?json(device()):json({...token(),...extra})}),/mismatch/);
});
test('refresh replaces both credentials; concurrent operations cannot resend the refresh token',async t=>{
  const f=await fixture(t);await f.login();let entered,finish;
  const gate=new Promise(r=>{entered=r;}),wait=new Promise(r=>{finish=r;});
  const first=refreshRemote(f.options,{...f.deps,fetchImpl:async()=>{entered();await wait;return json(token(3));}});
  await gate;await assert.rejects(refreshRemote(f.options,{...f.deps,fetchImpl:async()=>{throw new Error('must not run');}}),/in_progress/);
  finish();await first;assert.equal(JSON.parse(await readFile(f.id.file)).refresh_token,token(3).refresh_token);
});
test('ambiguous refresh is quarantined; repeat refresh/memory calls require logout, which can revoke',async t=>{
  const f=await fixture(t);await f.login();await assert.rejects(refreshRemote(f.options,{...f.deps,fetchImpl:async()=>{throw new Error('secret=hidden');}}),/connection_failed/);
  assert.equal((await remoteStatus(f.options,f.deps)).local_state,'quarantined');
  let calls=0;const deps={...f.deps,fetchImpl:async()=>{calls++;return json(token());}};
  await assert.rejects(refreshRemote(f.options,deps),/uncertain/);await assert.rejects(callRemoteMemory('search',{q:'synthetic'},f.options,deps),/uncertain/);assert.equal(calls,0);
  const r=await logoutRemote(f.options,{fetchImpl:async()=>new Response(null,{status:200})});assert.equal(r.revoked,true);
});
test('search and propose fix the project; confirm requires explicit review; errors are redacted',async t=>{
  const f=await fixture(t);await f.login();let sent;
  const deps={...f.deps,fetchImpl:async(_url,init)=>{sent=JSON.parse(init.body);return json({jsonrpc:'2.0',id:1,result:{structuredContent:{tenant_id:'synthetic',project_id:'project-a',status:'pending'}}});}};
  await callRemoteMemory('search',{q:'synthetic'},f.options,deps);assert.equal(sent.params.arguments.project_id,'project-a');assert.equal(sent.params.arguments.scope,'mine');
  await callRemoteMemory('propose',{item:{content:'Synthetic choice.'}},f.options,deps);assert.equal(sent.params.arguments.item.project_id,'project-a');assert.equal(sent.params.arguments.approved,undefined);
  await assert.rejects(callRemoteMemory('search',{q:'synthetic',project_id:'other'},f.options,deps),/boundary/);
  await assert.rejects(callRemoteMemory('confirm',{confirmation_token:'synthetic'},f.options,deps),/explicit/);
  await assert.rejects(callRemoteMemory('search',{q:'synthetic'},f.options,{...deps,fetchImpl:async()=>json({id:1,error:{message:'odb_a_secret-leak'}})}),/invalid_or_failed/);
});
test('automatic refresh sends only a single refresh and uses the successor access credential',async t=>{
  const f=await fixture(t);await f.login();f.setTime(epoch+580000);const calls=[];
  await callRemoteMemory('search',{q:'synthetic'},f.options,{...f.deps,fetchImpl:async(url,init)=>{calls.push(url);
    if(url.endsWith('/token'))return json(token(3));assert.equal(init.headers.authorization,`Bearer ${token(3).access_token}`);
    return json({id:1,result:{structuredContent:{items:[]}}});}});assert.deepEqual(calls,[`${origin}/oauth/token`,endpoint]);
});
test('credential permissions, symlinks, and mismatched identities are rejected',async t=>{
  const f=await fixture(t);await f.login();await chmod(f.id.file,0o644);await assert.rejects(remoteStatus(f.options),/unsafe/);await chmod(f.id.file,0o600);
  const c=JSON.parse(await readFile(f.id.file));c.project_id='other';await writeFile(f.id.file,JSON.stringify(c));await assert.rejects(remoteStatus(f.options),/unsafe/);
  const linked=join(f.id.directory,'link');await symlink(f.id.directory,linked);await assert.rejects(loginRemote({...f.options,credentialDir:linked}),/unsafe/);
});
test('logout retains credentials on revocation failure and removes only its own file on success',async t=>{
  const f=await fixture(t);await f.login();await assert.rejects(logoutRemote(f.options,{fetchImpl:async()=>json({},503)}),/revocation_failed/);assert.equal((await remoteStatus(f.options)).logged_in,true);
  const other=join(f.id.directory,'unrelated');await writeFile(other,'synthetic');await logoutRemote(f.options,{fetchImpl:async()=>new Response(null,{status:200})});assert.equal((await remoteStatus(f.options)).logged_in,false);assert.equal(await readFile(other,'utf8'),'synthetic');
});

test('status distinguishes expired and refresh-required credentials without secrets',async t=>{
  const f=await fixture(t);await f.login();assert.equal((await remoteStatus(f.options,f.deps)).local_state,'active');
  f.setTime(epoch+605001);assert.equal((await remoteStatus(f.options,f.deps)).local_state,'refresh_required');
  f.setTime(epoch+30*86400000);const status=await remoteStatus(f.options,f.deps);assert.equal(status.local_state,'expired');assert.doesNotMatch(JSON.stringify(status),/odb_[ar]_/);
});
