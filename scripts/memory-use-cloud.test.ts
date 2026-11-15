import {test,expect} from 'vitest';
import {fixture} from './lib/memory-use-fixture.mjs';
import {memoryUseService,memoryUseOperation} from '../apps/api-gateway/src/memory-use-service';
import {signMemoryUseAttestation} from '../packages/shared/src/memory-use-attestation.mjs';
import type {Env} from '../apps/api-gateway/src/types';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';

function d1(sqlite:any) {
  return {
    prepare(sql:string) {
      const make=(args:any[]=[])=>({
        bind:(...values:any[])=>make(values),
        all:async()=>({results:sqlite.prepare(sql).all(...args),success:true}),
        first:async()=>sqlite.prepare(sql).get(...args)??null,
        run:async()=>({meta:sqlite.prepare(sql).run(...args),success:true})
      });
      return make();
    },
    async batch(commands:any[]) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {const results=[];for(const command of commands)results.push(await command.run());sqlite.exec('COMMIT');return results;}
      catch(error){sqlite.exec('ROLLBACK');throw error;}
    }
  };
}

test('Cloud D1 adapter and Local share candidate, verification, score and ordering contracts',async()=>{
  const f=await fixture();
  const sql=new DatabaseSync(':memory:');
  try {
    const migrations=new URL('../migrations/',import.meta.url);
    for(const file of readdirSync(migrations).filter(name=>name.endsWith('.sql')).sort()) sql.exec(readFileSync(new URL(file,migrations),'utf8'));
    // Seed the same source and usage data, but never copy local proof rows into Cloud.
    for(const [table,columns] of [
      ['memories','id,tenant_id,project_id,content,summary,tags_json,created_at,kind,lifecycle_state,scope_type,scope_key,current_version,source,work_type'],
      ['memory_versions','id,memory_id,tenant_id,version,operation,content,summary,tags_json,kind,lifecycle_state,scope_type,scope_key,actor_type,actor_id,confidence_score,utility_score,canonical_key,created_at'],
      ['memory_usage_events','id,tenant_id,project_id,task_id,access_path,request_source,requested_work_type,created_at,actor_principal'],
      ['memory_usage_items','id,usage_event_id,tenant_id,source_type,source_id,source_version,reference_type,created_at']
    ]) {
      const rows=f.db.prepare(`SELECT ${columns} FROM ${table}`).all();
      const names=columns.split(',');
      const insert=sql.prepare(`INSERT INTO ${table}(${columns}) VALUES(${names.map(()=>'?').join(',')})`);
      for(const row of rows) insert.run(...names.map(name=>row[name]));
    }
    sql.prepare('INSERT INTO principal_role_assignments(id,tenant_id,project_id,principal,role,created_by_principal,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('grant','t','p','local','reader','test',f.now,f.now);
    sql.prepare("INSERT INTO resource_access_policies(id,tenant_id,resource_type,resource_id,scope,owner_principal,project_id,created_by_principal,created_at,updated_at) VALUES(?,?,'memory',?,'project',?,?,?, ?,?)").run('policy','t',f.id,'owner','p','test',f.now,f.now);
    const secret='fixture-only-key-not-a-production-credential';
    const env={OPEN_BRAIN_DB:d1(sql),ORGBRAIN_USE_ATTESTATION_KEY:secret,ORGBRAIN_USE_ATTESTATION_TENANT:'t',ORGBRAIN_USE_ATTESTATION_PRINCIPAL:'local'} as unknown as Env;
    const cloud=memoryUseService(env,'t','local',()=>f.now);
    // Local proof flags alone do not establish Cloud verification.
    expect((await cloud.record({...f.payload,id:'untrusted'})).verification_state).toBe('unverified');
    const evidence=[];
    for(const ref of f.evidence) {
      const proof=f.db.prepare('SELECT * FROM local_use_proofs WHERE id=?').get(ref.ref_id);
      evidence.push({...ref,ref_type:'local_attestation',ref_id:await signMemoryUseAttestation({...proof,expires_at:f.now+86400000},secret)});
    }
    await f.service.record(f.payload);
    await f.service.evaluate({id:'local-eval',context_id:'context',proof_id:'context:2'});
    const q={query:'duplicate transaction',project_id:'p',work_type:'implementation',task_id:'future-task',context_enabled:true,ranking_enabled:true};
    const local=await f.service.search(q);
    expect((await cloud.record({...f.payload,id:'cloud',evidence})).verification_state).toBe('verified');
    expect((await cloud.evaluate({id:'cloud-eval',context_id:'cloud',proof_id:'cloud:2'})).outcome).toBe('positive');
    const result=await cloud.search(q);
    expect(result.results.map(x=>x.id)).toEqual(local.results.map(x=>x.id));
    expect(result.results[0].score).toBeCloseTo(local.results[0].score,8);
    expect(result.results[0].use_history.evaluation_count).toBe(1);
    // An authorized writer elsewhere cannot supply that project to edit a read-only context.
    sql.prepare('INSERT INTO principal_role_assignments(id,tenant_id,project_id,principal,role,created_by_principal,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('other-grant','t','other','local','contributor','test',f.now,f.now);
    await expect(memoryUseOperation({...env,ORGBRAIN_USE_COLLECT:'on'},'t',{id:'forged-eval',context_id:'cloud',project_id:'other',supersedes_id:'cloud-eval',feedback:{contribution:'positive',statement:'forged project scope'}},'local','evaluate')).rejects.toThrow('Write permission required');

    // Trust configuration revocation invalidates both history and ranking contribution.
    const untrusted=memoryUseService({...env,ORGBRAIN_USE_ATTESTATION_KEY:undefined},'t','local',()=>f.now);
    expect((await untrusted.search(q)).results).toHaveLength(0);
    sql.prepare('DELETE FROM principal_role_assignments').run();
    expect((await memoryUseService(env,'t','local',()=>f.now).history()).items).toHaveLength(0);
  } finally {sql.close();await f.close();}
});
