import {test,expect} from 'vitest';
import {fixture} from './lib/memory-use-fixture.mjs';
import {memoryUseService,memoryUseOperation} from '../apps/api-gateway/src/memory-use-service';
import {signMemoryUseAttestation} from '../packages/shared/src/memory-use-attestation.mjs';
import type {Env} from '../apps/api-gateway/src/types';

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
  try {
    f.db.prepare('INSERT INTO principal_role_assignments(id,tenant_id,project_id,principal,role,created_by_principal,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('grant','t','p','local','reader','test',f.now,f.now);
    const secret='fixture-only-key-not-a-production-credential';
    const env={OPEN_BRAIN_DB:d1(f.db),ORGBRAIN_USE_ATTESTATION_KEY:secret,ORGBRAIN_USE_ATTESTATION_TENANT:'t',ORGBRAIN_USE_ATTESTATION_PRINCIPAL:'local'} as unknown as Env;
    const cloud=memoryUseService(env,'t','local');
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
    await f.service.revoke('context');
    expect((await cloud.record({...f.payload,id:'cloud',evidence})).verification_state).toBe('verified');
    expect((await cloud.evaluate({id:'cloud-eval',context_id:'cloud',proof_id:'cloud:2'})).outcome).toBe('positive');
    const result=await cloud.search(q);
    expect(result.results.map(x=>x.id)).toEqual(local.results.map(x=>x.id));
    expect(result.results[0].score).toBeCloseTo(local.results[0].score,8);
    expect(result.results[0].use_history.evaluation_count).toBe(1);
    // An authorized writer elsewhere cannot supply that project to edit a read-only context.
    f.db.prepare('INSERT INTO principal_role_assignments(id,tenant_id,project_id,principal,role,created_by_principal,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('other-grant','t','other','local','contributor','test',f.now,f.now);
    await expect(memoryUseOperation({...env,ORGBRAIN_USE_COLLECT:'on'},'t',{id:'forged-eval',context_id:'cloud',project_id:'other',supersedes_id:'cloud-eval',feedback:{contribution:'positive',statement:'forged project scope'}},'local','evaluate')).rejects.toThrow('Write permission required');

    // Trust configuration revocation invalidates both history and ranking contribution.
    const untrusted=memoryUseService({...env,ORGBRAIN_USE_ATTESTATION_KEY:undefined},'t','local');
    expect((await untrusted.search(q)).results).toHaveLength(0);
    f.db.prepare('DELETE FROM principal_role_assignments').run();
    expect((await memoryUseService(env,'t','local').history()).items).toHaveLength(0);
  } finally {await f.close();}
});
