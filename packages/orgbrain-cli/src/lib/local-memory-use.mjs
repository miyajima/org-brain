import { MemoryUseHistory, memoryUseFlags, useHash } from '../../../shared/src/memory-use-history-runtime.mjs';

export const LOCAL_USE_SCHEMA = `
CREATE TABLE IF NOT EXISTS local_use_settings (id INTEGER PRIMARY KEY CHECK(id=1), settings_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS local_use_proofs (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, principal TEXT NOT NULL, project_id TEXT NOT NULL,
 task_id TEXT NOT NULL, source_id TEXT NOT NULL, usage_item_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, contribution TEXT,
 revoked_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS local_use_decision_deleted AFTER DELETE ON decision_memories_local BEGIN
 UPDATE memory_use_contexts SET revoked_at=unixepoch()*1000 WHERE tenant_id=OLD.tenant_id AND source_type='decision_memory' AND source_id=OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS local_use_decision_changed AFTER UPDATE ON decision_memories_local BEGIN
 DELETE FROM memory_use_statistics WHERE tenant_id=NEW.tenant_id AND source_type='decision_memory' AND source_id=NEW.id;
 DELETE FROM memory_use_context_fts WHERE context_id IN(SELECT id FROM memory_use_contexts WHERE tenant_id=NEW.tenant_id AND source_type='decision_memory' AND source_id=NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS local_use_proof_revoked AFTER UPDATE OF revoked_at ON local_use_proofs WHEN NEW.revoked_at IS NOT NULL BEGIN
 UPDATE memory_use_contexts SET revoked_at=NEW.revoked_at WHERE id IN(SELECT context_id FROM memory_use_evidence WHERE tenant_id=NEW.tenant_id AND ref_type='local_event' AND ref_id=NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS local_use_proof_deleted AFTER DELETE ON local_use_proofs BEGIN
 UPDATE memory_use_contexts SET revoked_at=unixepoch()*1000 WHERE id IN(SELECT context_id FROM memory_use_evidence WHERE tenant_id=OLD.tenant_id AND ref_type='local_event' AND ref_id=OLD.id);
END;
`;

export function localUseDb(db) {
  return {
    all: async (sql,args=[]) => db.prepare(sql).all(...args),
    batch: async commands => {
      db.exec('BEGIN IMMEDIATE');
      try { for (const {sql,args} of commands) db.prepare(sql).run(...args); db.exec('COMMIT'); }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  };
}
export function localUseFlags(db, env=process.env) {
  const stored=JSON.parse(db.prepare('SELECT settings_json FROM local_use_settings WHERE id=1').get()?.settings_json??'{}');
  return memoryUseFlags({...stored,...env});
}
export function configureLocalUse(db, {mode='off',collect=false,sync=false}={}) {
  if (!['off','a','b','c'].includes(mode)) throw new Error('invalid_use_mode');
  const settings={ORGBRAIN_USE_COLLECT:collect?'on':'off',ORGBRAIN_USE_CONTEXT:['b','c'].includes(mode)?'on':'off',ORGBRAIN_USE_RANKING:mode==='c'?'on':'off',ORGBRAIN_USE_SYNC:sync?'on':'off'};
  db.prepare('INSERT INTO local_use_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET settings_json=excluded.settings_json').run(JSON.stringify(settings));
  return {mode,...memoryUseFlags(settings)};
}
export function localUseService(db, tenantId, principal='local', now=Date.now, filters={}) {
  return new MemoryUseHistory({db:localUseDb(db),tenantId,principal,now,
    resolveSource:async(type,id)=>{
      if(type==='decision_memory') {
        const row=db.prepare('SELECT * FROM decision_memories_local WHERE tenant_id=? AND id=?').get(tenantId,id);
        if(!row||row.status!=='active'||!['user_confirmed','user_corrected','reviewed'].includes(row.confirmation_state)||(row.valid_until!=null&&row.valid_until<=now())||(row.valid_from!=null&&row.valid_from>now())) return null;
        let allowed;try{allowed=JSON.parse(row.allowed_principals_json??'[]');}catch{return null;}
        if(!Array.isArray(allowed)||((row.visibility==='restricted'||allowed.length)&&!allowed.includes(principal))) return null;
        const version=db.prepare('SELECT count(*) AS n FROM decision_memory_versions_local WHERE tenant_id=? AND decision_memory_id=?').get(tenantId,id).n;
        return {id,kind:'decision_memory',memory_kind:'decision',current_version:version||null,project_id:row.project_id,summary:row.title,content_preview:row.decision.slice(0,600),created_at:row.created_at};
      }
      if(type!=='memory') return null;
      const row=db.prepare('SELECT * FROM memories WHERE tenant_id=? AND id=?').get(tenantId,id);
      if(row&&((filters.work_type&&row.work_type!==filters.work_type)||(filters.business_category_id&&row.business_category_id!==filters.business_category_id)||(filters.project_id&&row.project_id&&row.project_id!==filters.project_id))) return null;
      if(!row || row.deleted_at || row.lifecycle_state==='suppressed' || (row.valid_until!=null&&row.valid_until<=now()) || (row.valid_from!=null&&row.valid_from>now())) return null;
      let grants;
      try {grants=JSON.parse(row.permissions_json??'[]');if(!Array.isArray(grants)) return null;} catch {return null;}
      if(grants.length && !grants.some(p=>p.principal_type==='principal'&&p.principal_id===principal&&p.permissions?.includes('read'))) return null;
      return {id:row.id,kind:'memory',memory_kind:row.kind,current_version:row.current_version,source:row.source,
        summary:row.summary,content_preview:row.content.slice(0,600),created_at:row.created_at,project_id:row.project_id};
    },
    resolveEvidence:async(type,id)=>{
      if(type!=='local_event') return null;
      const row=db.prepare('SELECT * FROM local_use_proofs WHERE tenant_id=? AND principal=? AND id=? AND revoked_at IS NULL').get(tenantId,principal,id);
      return row?{...row,verified:true}:null;
    }
  });
}

// Only the trusted transcript collector calls this. It is NOT exposed via API/MCP payloads.
export async function storeLocalUseProof(db, input) {
  const {created_at:_createdAt,...identity}=input;
  const id=await useHash(identity);
  db.prepare('INSERT OR IGNORE INTO local_use_proofs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,input.tenant_id,input.principal,input.project_id,input.task_id,input.source_id,input.usage_item_id,input.role,input.text,input.contribution??null,null,input.created_at);
  return {role:input.role,ref_type:'local_event',ref_id:id,span_start:0,span_end:input.text.length,content_hash:await useHash(input.text)};
}
