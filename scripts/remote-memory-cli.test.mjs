import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {remoteIdentity} from '../packages/orgbrain-cli/src/remote-memory.mjs';
const cli=resolve(process.env.ORGBRAIN_TEST_CLI??'packages/orgbrain-cli/src/local-memory.mjs');
const base=['remote','status','--mcp-url','https://orgbrain.example.test/mcp','--tenant-id','synthetic','--project-id','project-a'];
async function privateDir(t) {const dir=await mkdtemp(join(tmpdir(),'orgbrain-cli-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
test('executable remote status never opens a local DB and prints no credential values',async t=>{
  const dir=await privateDir(t),out=execFileSync(process.execPath,[cli,...base,'--credential-dir',join(dir,'private')],{encoding:'utf8',env:{...process.env,ORGBRAIN_LOCAL_DB:join(dir,'must-not-create.sqlite')}});
  assert.equal(JSON.parse(out).logged_in,false);assert.deepEqual(await readdir(dir),[]);assert.doesNotMatch(out,/odb_[ar]_/);
});
test('executable reports a synthetic private credential without revealing tokens',async t=>{
  const dir=await privateDir(t),options={endpoint:'https://orgbrain.example.test/mcp',tenantId:'synthetic',projectId:'project-a',credentialDir:join(dir,'private')};
  const id=remoteIdentity(options);await mkdir(id.directory,{mode:0o700});
  await writeFile(id.file,JSON.stringify({version:1,endpoint:options.endpoint,tenant_id:'synthetic',project_id:'project-a',scopes:['orgbrain:read'],access_token:`odb_a_${'a'.repeat(64)}`,refresh_token:`odb_r_${'b'.repeat(64)}`,access_expires_at:2000000000000,refresh_expires_at:2000000600000}),{mode:0o600});
  const out=execFileSync(process.execPath,[cli,...base,'--credential-dir',id.directory],{encoding:'utf8'});
  assert.equal(JSON.parse(out).logged_in,true);assert.doesNotMatch(out,/odb_[ar]_/);assert.match(out,/orgbrain:read/);
});
test('executable rejects a missing project before network or storage',async t=>{
  const dir=await privateDir(t);const r=spawnSync(process.execPath,[cli,'remote','login','--mcp-url','https://orgbrain.example.test/mcp','--tenant-id','synthetic','--credential-dir',join(dir,'private')],{encoding:'utf8'});
  assert.notEqual(r.status,0);assert.match(r.stderr,/explicit_tenant_and_project_required/);assert.deepEqual(await readdir(dir),[]);
});
test('executable missing login cannot create local state or fall back to environment OAuth',async t=>{
  const dir=await privateDir(t);const r=spawnSync(process.execPath,[cli,...base.map(x=>x==='status'?'search':x),'synthetic','--credential-dir',join(dir,'private')],{encoding:'utf8',env:{...process.env,ORGBRAIN_LOCAL_DB:join(dir,'must-not-create.sqlite'),ORGBRAIN_MCP_ACCESS_TOKEN:'synthetic-untrusted-env-token'}});
  assert.notEqual(r.status,0);assert.match(r.stderr,/remote_login_required/);assert.doesNotMatch(r.stderr,/synthetic-untrusted-env-token/);assert.deepEqual(await readdir(join(dir,'private')),[]);
});
