import { Hono } from 'hono';
import { describe,expect,it } from 'vitest';
import { registerMemoryRoutes } from '../src/memory-routes';
import type { ApiContextEnv } from '../src/auth';
import event from './fixtures/optional-diagnostic-failure.json';
import { memoryD1Fixture } from './fixtures/memory-d1';

describe('conversation REST actual project authorization',()=>{
  it('checks the token project, bound scope and current role for every lifecycle route',async()=>{
    const {env,sql}=memoryD1Fixture();const principal='user:fixture-owner';
    let projectId:string|null='workflow-fixture';
    sql.prepare('INSERT INTO principal_role_assignments(id,tenant_id,project_id,principal,role,created_by_principal,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('role','fixture','workflow-fixture',principal,'project_owner',principal,1,1);
    const app=new Hono<ApiContextEnv>();
    // This fixture supplies a resolved auth context, not a new credential.
    app.use('*',async(c,next)=>{c.set('apiAuth',{principal,allowedTenants:['fixture'],source:'scoped-token',defaultRole:'reader',scopes:['read','write'],projectId});await next();});
    registerMemoryRoutes(app);
    app.onError((error,c)=>c.json({message:error.message},((error as any).status??500)));
    const post=(path:string,body:unknown)=>app.fetch(new Request('https://example.invalid/v1/memories/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),env);
    try {
      const preview=await (await post('conversation-stage',{tenant_id:'fixture',conversation:event})).json() as any;
      const staged=await (await post('conversation-stage',{tenant_id:'fixture',conversation:event,execute:true,expected_plan_hash:preview.data.plan_hash})).json() as any;
      const r=staged.data.receipts[0],guard={tenant_id:'fixture',confirmation_token:r.confirmation_token,expected_candidate_hash:r.candidate_hash,expected_revision:r.revision};
      const operations=[['confirmation-status',guard],['confirm',{...guard,approved:true,review_answer:'3'}],['confirmation-cancel',{...guard,reason:'Fixture withdrawal'}],['conversation-revise',{...guard,conversation:event}]] as const;
      projectId='foreign-project';
      for(const [path,body] of operations)expect((await post(path,body)).status).toBe(403);
      expect((await post('conversation-stage',{tenant_id:'fixture',conversation:event})).status).toBe(403);
      projectId=null;sql.prepare('DELETE FROM principal_role_assignments').run();
      for(const [path,body] of operations.filter(([path])=>path!=='confirmation-status'))expect((await post(path,body)).status).toBe(403);
      expect(sql.prepare('SELECT count(*) AS n FROM memories').get().n).toBe(0);
      expect(sql.prepare('SELECT lifecycle_state FROM memory_confirmations').get().lifecycle_state).toBe('pending');
    } finally {sql.close();}
  });
});
