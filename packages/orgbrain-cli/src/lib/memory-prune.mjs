import { isTransientMemory } from '../../../shared/src/memory-admission-runtime.mjs';

export async function pruneTransientMemories(store, {tenantId='default', projectId=null, apply=false, actorId=process.env.USER || 'local', limit=1000}={}) {
  await store.init();
  const db=store.open({readOnly:true});
  let selected;
  try {
    selected=db.prepare(`SELECT * FROM memories WHERE tenant_id=? AND lifecycle_state='active' AND deleted_at IS NULL
      AND (? IS NULL OR project_id=?) ORDER BY id LIMIT ?`).all(tenantId,projectId,projectId,Math.min(1000,Math.max(1,limit)))
      .map(row=>({...row,learning:JSON.parse(row.learning_json||'null'),conflicts:JSON.parse(row.conflicts_json||'[]')}))
      .filter(isTransientMemory).map(row=>({id:row.id,project_id:row.project_id,summary:row.summary.slice(0,160),version:row.current_version,content_hash:row.content_hash}));
  } finally {db.close();}
  const suppressed=[];
  if(apply) for(const item of selected) {
    const check=store.open({readOnly:true});
    try {
      const current=check.prepare('SELECT current_version,content_hash,lifecycle_state FROM memories WHERE tenant_id=? AND id=?').get(tenantId,item.id);
      if(!current||current.lifecycle_state!=='active'||current.current_version!==item.version||current.content_hash!==item.content_hash) throw new Error('prune_candidate_changed');
    } finally {check.close();}
    await store.suppress(tenantId,item.id,'transient_completion_report',{actor_type:'principal',actor_id:actorId});
    suppressed.push(item.id);
  }
  return {selected,suppressed,apply,disposition:'suppressed_recoverable',usage_history_preserved:true};
}
