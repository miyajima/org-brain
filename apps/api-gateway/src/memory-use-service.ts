import { readDecisionMemoryForUse } from './context-engine-service';
import { MemoryUseHistory, memoryReadAccessSql, type MemoryReadAccess, memoryUseFlags, verifyMemoryUseAttestation, HttpError, type UseRow } from '@org-brain/shared';
import { authorizePermission } from './rbac-service';
import type { Env } from './types';

export function memoryUseService(env: Env, tenantId: string, principal: string | null, now=Date.now,filters:{readAccess?:MemoryReadAccess;projectId?:string|null;workType?:string|null;businessCategoryId?:string|null}={}) {
  if (!principal) throw new HttpError(403,'use_principal_required','Authenticated principal required');
  const db = env.OPEN_BRAIN_DB;
  const permissionCache = new Map<string,boolean>();
  const readable = async (projectId: string | null) => {
    const key=projectId??'';
    if(!permissionCache.has(key)) permissionCache.set(key,(await authorizePermission(env,{tenantId,projectId,principal,permission:'read'})).allowed);
    return permissionCache.get(key)!;
  };
  return new MemoryUseHistory({tenantId,principal,now,
    db:{all:async(sql,args)=>(await db.prepare(sql).bind(...args).all<UseRow>()).results,
      batch:async commands=>db.batch(commands.map(({sql,args})=>db.prepare(sql).bind(...args)))},
    resolveSource:async(type,id)=>{
      if(type==='decision_memory') {const source=await readDecisionMemoryForUse(env,tenantId,id,principal);return source&&await readable(source.project_id)?source:null;}
      if(type!=='memory') return null;
      const row=await db.prepare(`SELECT * FROM memories WHERE tenant_id=? AND id=? AND ${memoryReadAccessSql("memories", filters.readAccess ?? { principal })}`).bind(tenantId,id).first<UseRow>();
      if(row&&((filters.workType&&row.work_type!==filters.workType)||(filters.businessCategoryId&&row.business_category_id!==filters.businessCategoryId)||(filters.projectId&&row.project_id&&row.project_id!==filters.projectId))) return null;
      if(!row || row.deleted_at || row.lifecycle_state==='suppressed' || (row.valid_until!=null&&row.valid_until<=now()) || (row.valid_from!=null&&row.valid_from>now())
        ) return null;
      return {id:row.id,kind:'memory',memory_kind:row.kind,current_version:row.current_version,source:row.source,
        summary:row.summary,content_preview:row.content.slice(0,600),created_at:row.created_at,project_id:row.project_id};
    },
    resolveEvidence:async(type,id,scope)=>{
      // Local receipts are never trusted by Cloud. Canonical server task events only.
      if(type==='local_attestation') {
        if(env.ORGBRAIN_USE_ATTESTATION_TENANT!==tenantId || env.ORGBRAIN_USE_ATTESTATION_PRINCIPAL!==principal) return null;
        return verifyMemoryUseAttestation(id,{secret:env.ORGBRAIN_USE_ATTESTATION_KEY,tenant:tenantId,principal,now:now()});
      }
      if(type!=='task_event') return null;
      const row=await db.prepare(`SELECT e.*,t.project_id FROM task_events e JOIN tasks t ON t.tenant_id=e.tenant_id AND t.id=e.task_id WHERE e.tenant_id=? AND e.id=?`).bind(tenantId,id).first<UseRow>();
      if(!row || !await readable(row.project_id)) return null;
      let payload: UseRow;
      try { payload=JSON.parse(row.payload??'{}'); } catch { return null; }
      // A generic task success does not attest use. Dedicated canonical evidence must name the item.
      const proof=payload.memory_use;
      if(row.kind!=='memory_use.evidence' || !proof || proof.principal!==principal || proof.source_id!==scope.source_id || typeof proof.text!=='string') return null;
      return {...proof,task_id:row.task_id,project_id:row.project_id,verified:true};
    }
  });
}

export async function memoryUseOperation(env:Env,tenantId:string,raw:unknown,principal:string|null,operation:string) {
  const flags=memoryUseFlags(env as unknown as Record<string,unknown>);
  if(operation!=='history' && !flags.collect) throw new HttpError(409,'memory_use_disabled','Enable ORGBRAIN_USE_COLLECT');
  const service=memoryUseService(env,tenantId,principal);
  const body=(raw??{}) as UseRow;
  try {
    if(operation!=='history') {
      let projectId=typeof body.project_id==='string'?body.project_id:null;
      if(operation==='evaluate'||operation==='revoke') {
        const id=operation==='evaluate'?body.context_id:body.id;
        const row=typeof id==='string' ? await env.OPEN_BRAIN_DB.prepare('SELECT project_id FROM memory_use_contexts WHERE tenant_id=? AND principal=? AND id=?').bind(tenantId,principal,id).first<{project_id:string}>() : null;
        if(!row) throw new HttpError(404,'use_context_not_found','Use context not found');
        projectId=row.project_id;
      }
      if(!principal || !(await authorizePermission(env,{tenantId,principal,projectId,permission:'write'})).allowed) throw new HttpError(403,'forbidden','Write permission required for the use context project');
    }
    if(operation==='record') return await service.record(body);
    if(operation==='evaluate') return await service.evaluate(body);
    if(operation==='revoke') return await service.revoke(body.id);
    if(operation==='rebuild') return await service.rebuild(body.project_id,body.work_type);
    return await service.history(body);
  } catch(error) {
    if(error instanceof HttpError) throw error;
    throw new HttpError(400,'invalid_memory_use',error instanceof Error?error.message:'invalid memory use');
  }
}
