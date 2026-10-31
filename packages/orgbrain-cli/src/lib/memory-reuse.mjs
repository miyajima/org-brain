import {createHash, randomUUID} from 'node:crypto';
import {countContextTokens} from './compact-memory-context.mjs';
import {receiveLocalUseObservation} from './local-use-observations.mjs';
import {screenSensitiveMemory} from '../../../shared/src/memory-capture-v2-runtime.mjs';

// Additive, feature-owned tables. They do not change the base DB's schema version
// or cause older installed clients to downgrade/rebuild that schema.
const schema=`
CREATE TABLE IF NOT EXISTS memory_reuse_links (
 tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, object_type_key TEXT NOT NULL,
 object_id TEXT NOT NULL, source_id TEXT NOT NULL, source_version INTEGER NOT NULL,
 operation TEXT, unresolved INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(tenant_id,project_id,object_type_key,object_id,source_id));
CREATE TABLE IF NOT EXISTS memory_reuse_seen (
 tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, principal TEXT NOT NULL,
 object_type_key TEXT NOT NULL, object_id TEXT NOT NULL, source_id TEXT NOT NULL,
 source_version INTEGER NOT NULL, PRIMARY KEY(tenant_id,project_id,principal,object_type_key,object_id,source_id));
CREATE TABLE IF NOT EXISTS memory_reuse_artifacts (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, principal TEXT NOT NULL,
 kind TEXT NOT NULL, object_type_key TEXT NOT NULL, object_id TEXT NOT NULL,
 refs_json TEXT NOT NULL, payload_json TEXT NOT NULL, fingerprint TEXT, action_ref TEXT,
 created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS memory_reuse_deliveries (
 usage_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, principal TEXT NOT NULL,
 task_id TEXT NOT NULL, channel TEXT NOT NULL, representation TEXT NOT NULL,
 source_digest TEXT NOT NULL, elapsed_ms REAL NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS memory_reuse_actions (
 call_id TEXT NOT NULL, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, principal TEXT NOT NULL,
 task_id TEXT NOT NULL, completed INTEGER NOT NULL, ok INTEGER NOT NULL, digest TEXT NOT NULL,
 PRIMARY KEY(tenant_id,project_id,principal,task_id,call_id));
CREATE UNIQUE INDEX IF NOT EXISTS idx_reuse_project_card ON memory_reuse_artifacts(tenant_id,project_id,principal,kind,object_type_key,object_id) WHERE kind='card' AND object_type_key='project';
CREATE TABLE IF NOT EXISTS memory_reuse_applications (
 token TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, principal TEXT NOT NULL,
 task_id TEXT NOT NULL, artifact_id TEXT NOT NULL, channel TEXT NOT NULL, refs_json TEXT NOT NULL,
 output_digest TEXT NOT NULL, native_call_id TEXT, verified_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS memory_reuse_artifact_grants (
 artifact_id TEXT NOT NULL, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, principal TEXT NOT NULL,
 PRIMARY KEY(artifact_id,tenant_id,project_id,principal));`;
export const REUSE_CHANNELS=Object.freeze(['object','operation','recent','changes','procedure','result']);
export const reuseDigest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function reuseContentAllowed(value) {
  const serialized=typeof value==='string'?value:JSON.stringify(value);
  const credentialText=serialized.replace(/\\(["'])/gu,'$1').replace(/["'](api[_-]?key|client[_-]?secret|password|passwd|token)["']\s*:/giu,'$1=');
  if(screenSensitiveMemory(credentialText).hard_reject)return false;
  // UUID metadata is not a phone number. Credential detection above still sees
  // the complete value, including credentials whose value happens to be a UUID.
  return screenSensitiveMemory(serialized.replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/giu,'[UUID]')).allowed;
}
function text(value,name) {if(typeof value!=='string'||!value.trim()||value.length>1000)throw Error(`invalid_reuse_${name}`);return value;}
function memoryBody(m) {return {source_id:m.id,source_version:m.current_version,verification_state:m.verification_state,
  conclusion:m.content,rationale:m.rationale,reuse_when:m.reuse_rule,sources:m.source_references};}

export class MemoryReuse {
  constructor(store, scope) {
    this.store=store;
    this.scope={...scope,principal_id:scope.principal_id||'local',work_type:scope.work_type||'implementation'};
    for(const k of ['tenant_id','project_id','principal_id'])text(this.scope[k],k);
  }
  async open() {await this.store.init();const db=this.store.open();db.exec(schema);return db;}
  async detail(ref) {
    const {memory}=await this.store.getMemoryDetail({...this.scope,memory_id:ref.source_id,expected_version:ref.source_version});
    if(memory.conflicts?.length||memory.verification_state==='rejected')throw Error('reuse_source_conflicted');
    if(!reuseContentAllowed({content:memory.content,rationale:memory.rationale,reuse_rule:memory.reuse_rule}))throw Error('sensitive_reuse_source_denied');
    return memory;
  }
  async link(input) {
    const memory=await this.detail(input);
    const db=await this.open(),s=this.scope;
    try {db.prepare(`INSERT INTO memory_reuse_links VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id,project_id,object_type_key,object_id,source_id) DO UPDATE SET
      source_version=excluded.source_version,
      operation=CASE WHEN memory_reuse_links.source_version=excluded.source_version THEN COALESCE(excluded.operation,memory_reuse_links.operation) ELSE excluded.operation END,
      unresolved=CASE WHEN ? THEN excluded.unresolved ELSE memory_reuse_links.unresolved END,updated_at=excluded.updated_at`)
      .run(s.tenant_id,s.project_id,text(input.object_type_key,'object_type'),text(input.object_id,'object_id'),input.source_id,input.source_version,
        input.operation??null,input.unresolved?1:0,input.updated_at??memory.updated_at??Date.now(),Number(input.unresolved!==undefined));
      return {linked:true,source_id:input.source_id,source_version:input.source_version};
    }finally{db.close();}
  }
  async createArtifact(input) {
    const fileWork=input.kind==='result'&&input.object_type_key==='completed_work'&&input.payload?.source_mode==='project_files'&&Array.isArray(input.payload.file_sources)&&input.payload.file_sources.length>0&&input.payload.file_sources.every(f=>typeof f.path==='string'&&!f.path.startsWith('/')&&!f.path.split('/').includes('..')&&/^[a-f0-9]{64}$/u.test(f.sha256));
    if(!['procedure','result'].includes(input.kind)||!Array.isArray(input.refs)||!input.refs.length&&!fileWork)throw Error('invalid_reuse_artifact');
    // File-backed work is an output with byte provenance, not a new memory.
    // Its native completed action must attest the exact payload below; OS file
    // access has not established another principal's read permission.
    if(fileWork&&!input.refs.length&&input.allowed_principals?.length)throw Error('file_work_sharing_requires_source_permissions');
    for(const ref of input.refs)await this.detail(ref);
    if(!reuseContentAllowed(input.payload))throw Error('sensitive_artifact_denied');
    if(input.allowed_principals!==undefined&&!Array.isArray(input.allowed_principals))throw Error('invalid_artifact_grants');
    const grantees=[...new Set(input.allowed_principals??[])];
    for(const principal of grantees){
      text(principal,'grantee');
      for(const ref of input.refs)await this.store.getMemoryDetail({...this.scope,principal_id:principal,memory_id:ref.source_id,expected_version:ref.source_version});
    }
    const db=await this.open(),s=this.scope;
    try {
      if(input.kind==='procedure')for(const ref of input.refs){
        const n=db.prepare(`SELECT count(DISTINCT c.task_id) AS n FROM memory_use_contexts c
          WHERE c.tenant_id=? AND c.project_id=? AND c.source_id=? AND c.source_version=?
          AND c.source_type='memory' AND c.verification_state='verified' AND c.revoked_at IS NULL`).get(s.tenant_id,s.project_id,ref.source_id,ref.source_version).n;
        if(n<2)throw Error('insufficient_verified_use');
      }
      if(input.kind==='result') {
        const action=db.prepare(`SELECT ok,digest FROM memory_reuse_actions WHERE tenant_id=? AND project_id=? AND principal=? AND call_id=? AND completed=1`)
          .get(s.tenant_id,s.project_id,s.principal_id,input.action_ref??'');
        if(!action?.ok||!input.fingerprint)throw Error('completed_action_required');
        if(!action.digest.startsWith('{'))throw Error('result_proof_mismatch');
        const proof=JSON.parse(action.digest);
        if(proof.payload!==reuseDigest(input.payload)||proof.fingerprint!==input.fingerprint||proof.refs!==reuseDigest(input.refs)
          ||proof.object_type_key!==input.object_type_key||proof.object_id!==input.object_id)throw Error('result_proof_mismatch');
      }
      const id=randomUUID();
      db.prepare('INSERT INTO memory_reuse_artifacts VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,s.tenant_id,s.project_id,s.principal_id,input.kind,
        text(input.object_type_key,'object_type'),text(input.object_id,'object_id'),JSON.stringify(input.refs),JSON.stringify(input.payload),input.fingerprint??null,input.action_ref??null,Date.now());
      for(const principal of grantees)db.prepare('INSERT INTO memory_reuse_artifact_grants VALUES(?,?,?,?)').run(id,s.tenant_id,s.project_id,principal);
      return {id,kind:input.kind,owner:s.principal_id,allowed_principals:grantees};
    }finally{db.close();}
  }
  async reportUse(signal,taskId,context) {
    const db=await this.open(),s=this.scope;let item,action;
    try {
      item=db.prepare(`SELECT i.id AS usage_item_id,i.source_id,i.source_version,e.id AS usage_id,
        e.tenant_id,e.project_id,e.task_id,e.requested_work_type AS work_type FROM memory_usage_items i
        JOIN memory_usage_events e ON e.tenant_id=i.tenant_id AND e.id=i.usage_event_id
        WHERE e.tenant_id=? AND e.project_id=? AND e.actor_principal=? AND e.task_id=? AND i.id=?`)
        .get(s.tenant_id,s.project_id,s.principal_id,taskId,signal.usage_item_id);
      action=db.prepare(`SELECT tenant_id,project_id,task_id,completed FROM memory_reuse_actions
        WHERE tenant_id=? AND project_id=? AND principal=? AND task_id=? AND call_id=?`)
        .get(s.tenant_id,s.project_id,s.principal_id,taskId,signal.action_call_id);
    }finally{db.close();}
    return reportCompactUse({store:this.store,scope:s,task_id:taskId,context,
      delivered:new Map(item?[[item.usage_item_id,item]]:[]),actions:new Map(action?[[signal.action_call_id,action]]:[])},signal);
  }
  async applyArtifact(input,execute) {
    text(input.task_id,'task_id');const db=await this.open(),s=this.scope;let artifact;
    try{artifact=db.prepare(`SELECT a.* FROM memory_reuse_artifacts a WHERE a.id=? AND a.tenant_id=? AND a.project_id=? AND a.kind IN ('procedure','result')
      AND(a.principal=? OR EXISTS(SELECT 1 FROM memory_reuse_artifact_grants g WHERE g.artifact_id=a.id AND g.tenant_id=a.tenant_id AND g.project_id=a.project_id AND g.principal=?))`)
      .get(input.artifact_id,s.tenant_id,s.project_id,s.principal_id,s.principal_id);}finally{db.close();}
    if(!artifact)throw Error('artifact_unavailable');
    const refs=JSON.parse(artifact.refs_json);for(const ref of refs)await this.detail(ref);
    if(artifact.kind==='result'&&(!input.fingerprint||artifact.fingerprint!==input.fingerprint))throw Error('artifact_conditions_mismatch');
    const output={...await execute(JSON.parse(artifact.payload_json),artifact.kind),reuse_channel:artifact.kind,source_refs:refs};
    if(output.reuse_applied===false)return {...output,reuse_status:'not_applied'};
    const token=randomUUID(),write=await this.open();
    try{write.prepare('INSERT INTO memory_reuse_applications VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(token,s.tenant_id,s.project_id,s.principal_id,
      input.task_id,artifact.id,artifact.kind,artifact.refs_json,reuseDigest(output),null,null,Date.now());}finally{write.close();}
    return {...output,derived_application_token:token};
  }
  async confirmApplication(token,action) {
    const db=await this.open(),s=this.scope;
    try {
      const native=db.prepare('SELECT digest FROM memory_reuse_actions WHERE tenant_id=? AND project_id=? AND principal=? AND task_id=? AND call_id=? AND completed=1')
        .get(s.tenant_id,s.project_id,s.principal_id,action.task_id,action.call_id);
      if(!native)throw Error('native_action_required');
      const digest=native.digest.startsWith('{')?JSON.parse(native.digest).action:native.digest;
      if(digest!==reuseDigest({args:action.args,result:action.result}))throw Error('native_action_mismatch');
      const row=db.prepare('SELECT * FROM memory_reuse_applications WHERE token=? AND tenant_id=? AND project_id=? AND principal=? AND task_id=?')
        .get(token,s.tenant_id,s.project_id,s.principal_id,action.task_id);
      const output=Object.fromEntries(Object.entries(action.result).filter(([k])=>!['derived_application_token','adapter_call_id'].includes(k)));
      if(!row||row.output_digest!==reuseDigest(output))throw Error('artifact_output_mismatch');
      for(const ref of JSON.parse(row.refs_json))await this.detail(ref);
      db.prepare('UPDATE memory_reuse_applications SET native_call_id=?,verified_at=? WHERE token=? AND native_call_id IS NULL').run(action.call_id,Date.now(),token);
      return {verified:true,channel:row.channel,source_refs:JSON.parse(row.refs_json)};
    }finally{db.close();}
  }
  async applications(taskId) {
    const db=await this.open(),s=this.scope;
    try{return db.prepare(`SELECT x.channel,x.refs_json,x.native_call_id,a.principal AS artifact_owner FROM memory_reuse_applications x JOIN memory_reuse_artifacts a ON a.id=x.artifact_id
      WHERE x.tenant_id=? AND x.project_id=? AND x.principal=? AND x.task_id=? AND x.native_call_id IS NOT NULL`)
      .all(s.tenant_id,s.project_id,s.principal_id,taskId).map(({refs_json,...row})=>({...row,source_refs:JSON.parse(refs_json)}));}finally{db.close();}
  }
  async recall(input) {
    const started=performance.now(),channel=input.channel??'object',s=this.scope;
    const empty={channel,references:[],items:[],context:'',results:[],meta:{usage_items:[]}};
    if(!REUSE_CHANNELS.includes(channel)||input.flags?.[channel]!==true)return {...empty,reason:'disabled'};
    text(input.task_id,'task_id');text(input.object_type_key,'object_type');text(input.object_id,'object_id');
    const db=await this.open();let candidates=[],artifact=null,derivation=null;
    try {
      const links=channel==='recent'?db.prepare('SELECT * FROM memory_reuse_links WHERE tenant_id=? AND project_id=? ORDER BY unresolved DESC,updated_at DESC,source_id LIMIT 200').all(s.tenant_id,s.project_id):
        db.prepare(`SELECT * FROM memory_reuse_links WHERE tenant_id=? AND project_id=? AND object_type_key=? AND object_id=? ORDER BY updated_at DESC,source_id`)
          .all(s.tenant_id,s.project_id,input.object_type_key,input.object_id);
      const visible=input.visible_versions??[];
      for(const link of links) {
        if(channel==='operation'&&(!input.operation||link.operation!==input.operation))continue;
        if(channel==='recent'&&!link.unresolved&&link.updated_at<Date.now()-7*86400000)continue;
        if(channel!=='recent'&&visible.some(v=>v.source_id===link.source_id&&v.source_version===link.source_version))continue;
        if(channel==='changes'){
          const seen=db.prepare(`SELECT source_version FROM memory_reuse_seen WHERE tenant_id=? AND project_id=? AND principal=? AND object_type_key=? AND object_id=? AND source_id=?`)
            .get(s.tenant_id,s.project_id,s.principal_id,input.object_type_key,input.object_id,link.source_id);
          if(seen?.source_version===link.source_version)continue;
        }
        try {candidates.push({link,memory:await this.detail(link)});}catch(error){
          if(!['memory_detail_unavailable','reuse_source_conflicted','sensitive_reuse_source_denied'].includes(error.message))throw error;
        }
      }
      if(channel==='recent') {
        const began=performance.now(),grouped=new Map();
        for(const c of candidates){
          const key=c.memory.id+'@'+c.memory.current_version;
          if(!grouped.has(key))grouped.set(key,{...memoryBody(c.memory),targets:[]});
          grouped.get(key).targets.push({object_type_key:c.link.object_type_key,object_id:c.link.object_id});
        }
        let entries=[];for(const entry of grouped.values())if(countContextTokens([...entries,entry])<=Math.max(512,input.token_budget??1500))entries.push(entry);
        const digest=reuseDigest(entries);
        const previous=db.prepare("SELECT * FROM memory_reuse_artifacts WHERE tenant_id=? AND project_id=? AND principal=? AND kind='card' AND object_type_key='project' AND object_id=?")
          .get(s.tenant_id,s.project_id,s.principal_id,s.project_id);
        const hit=previous?.fingerprint===digest&&reuseDigest(JSON.parse(previous.payload_json))===digest;
        if(hit)entries=JSON.parse(previous.payload_json);
        else db.prepare(`INSERT INTO memory_reuse_artifacts VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO UPDATE SET refs_json=excluded.refs_json,payload_json=excluded.payload_json,fingerprint=excluded.fingerprint,created_at=excluded.created_at`)
          .run(previous?.id??randomUUID(),s.tenant_id,s.project_id,s.principal_id,'card','project',s.project_id,JSON.stringify(entries.map(e=>({source_id:e.source_id,source_version:e.source_version}))),JSON.stringify(entries),digest,null,Date.now());
        const card=db.prepare("SELECT id FROM memory_reuse_artifacts WHERE tenant_id=? AND project_id=? AND principal=? AND kind='card' AND object_type_key='project' AND object_id=?")
          .get(s.tenant_id,s.project_id,s.principal_id,s.project_id);
        const target=candidates.filter(c=>c.link.object_type_key===input.object_type_key&&c.link.object_id===input.object_id
          &&!visible.some(v=>v.source_id===c.memory.id&&v.source_version===c.memory.current_version));
        const selected=entries.filter(e=>e.targets.some(t=>t.object_type_key===input.object_type_key&&t.object_id===input.object_id));
        candidates=selected.length?target.filter(c=>selected.some(e=>e.source_id===c.memory.id)).map(c=>{
          const entry=selected.find(e=>e.source_id===c.memory.id);
          return {...c,memory:{...c.memory,content:entry.conclusion,rationale:entry.rationale,reuse_rule:entry.reuse_when}};
        }):target;
        derivation={card_id:card.id,cache_hit:hit,source_digest:digest,elapsed_ms:performance.now()-began,model_calls:0,fallback:!selected.length&&target.length>0};
      }
      if(['procedure','result'].includes(channel)){
        const artifacts=db.prepare(`SELECT a.* FROM memory_reuse_artifacts a WHERE a.tenant_id=? AND a.project_id=? AND a.kind=? AND a.object_type_key=? AND a.object_id=?
          AND(a.principal=? OR EXISTS(SELECT 1 FROM memory_reuse_artifact_grants g WHERE g.artifact_id=a.id AND g.tenant_id=a.tenant_id AND g.project_id=a.project_id AND g.principal=?))
          ORDER BY CASE WHEN ? AND a.principal<>? THEN 0 ELSE 1 END,a.created_at DESC LIMIT 100`)
          .all(s.tenant_id,s.project_id,channel,input.object_type_key,input.object_id,s.principal_id,s.principal_id,input.cross_principal?1:0,s.principal_id);
        artifact=artifacts.find(a=>(!input.artifact_cutoff_ms||a.created_at<input.artifact_cutoff_ms)&&(channel!=='result'||a.fingerprint===input.fingerprint)
          &&JSON.parse(a.refs_json).every(r=>candidates.some(c=>c.memory.id===r.source_id&&c.memory.current_version===r.source_version)));
        if(!artifact)return {...empty,reason:'artifact_unavailable'};
        const refs=JSON.parse(artifact.refs_json);
        candidates=candidates.filter(c=>refs.some(r=>r.source_id===c.memory.id));
      }
    }finally{db.close();}
    const representation=channel==='recent'?(derivation?.fallback?'target_reference':'card'):artifact?channel:'original';
    const chosen=[],bodies=[];
    const budget=Math.max(512,Math.min(16000,input.token_budget??1500));
    for(const c of candidates.slice(0,3)) {
      const m=c.memory;
      const body=memoryBody(m);
      const candidateBody=artifact?{artifact_id:artifact.id,refs:JSON.parse(artifact.refs_json),payload:JSON.parse(artifact.payload_json),representation,
        validated_conditions:{source_versions_current:true,linked_target_match:true,fingerprint_match:channel==='result'?true:null,verification_action:artifact.action_ref}}:body;
      if(countContextTokens([...bodies,candidateBody])>budget-350)continue;
      chosen.push(c);bodies.push(candidateBody);
    }
    if(!chosen.length)return {...empty,reason:'no_eligible_reference'};
    const usageId=randomUUID();
    const usage=await this.store.recordUsage({id:usageId,tenant_id:s.tenant_id,project_id:s.project_id,task_id:input.task_id,
      actor_principal:s.principal_id,requested_work_type:s.work_type,usage_purpose:input.usage_purpose??'task',
      capability:'hook_context',access_path:'context',request_source:'local',items:chosen.map(({memory:m},i)=>({
        source_type:'memory',source_id:m.id,source_version:m.current_version,rank:i+1,reference_type:'injected',
        injected_token_estimate:countContextTokens(bodies[i])}))});
    const refs=chosen.map(({memory:m})=>({source_id:m.id,source_version:m.current_version}));
    const receipt=`Use tracking: receipt; task_id=${input.task_id}; project_id=${s.project_id}; work_type=${s.work_type}; usage_id=${usageId}; items=${JSON.stringify(usage.usage_items)}`;
    const context=JSON.stringify({channel,representation,references:bodies})+'\n\n'+receipt+'\n';
    const write=await this.open();
    try {
      write.prepare('INSERT INTO memory_reuse_deliveries VALUES(?,?,?,?,?,?,?,?,?,?)').run(usageId,s.tenant_id,s.project_id,s.principal_id,input.task_id,
        channel,representation,reuseDigest(refs),performance.now()-started,Date.now());
      for(const r of refs)write.prepare(`INSERT INTO memory_reuse_seen VALUES(?,?,?,?,?,?,?) ON CONFLICT(tenant_id,project_id,principal,object_type_key,object_id,source_id) DO UPDATE SET source_version=excluded.source_version`)
        .run(s.tenant_id,s.project_id,s.principal_id,input.object_type_key,input.object_id,r.source_id,r.source_version);
    }finally{write.close();}
    return {channel,representation,derivation,artifact_id:artifact?.id??null,artifact_meta:artifact?{owner:artifact.principal,created_at:artifact.created_at,verification_action:artifact.action_ref}:null,references:refs,items:usage.usage_items,usage_id:usageId,context,
      results:chosen.map(c=>({memory:{id:c.memory.id,current_version:c.memory.current_version}})),meta:usage,elapsed_ms:performance.now()-started,
      evidence_bundle:{evidence_status:'reference',estimated_tokens:countContextTokens(context),guidance:'Check applicability and source validity; delivery is not use or benefit.'}};
  }
}

// Only a native PostToolUse adapter should call this function, never model input.
export async function recordReuseAction(store,scope,action) {
  text(action.call_id,'call_id');
  const db=await new MemoryReuse(store,scope).open();
  const proof=action.cache?JSON.stringify({action:reuseDigest({args:action.args,result:action.result}),payload:reuseDigest(action.cache.payload),
    fingerprint:action.cache.fingerprint,refs:reuseDigest(action.cache.refs),object_type_key:action.cache.object_type_key,object_id:action.cache.object_id}):reuseDigest({args:action.args,result:action.result});
  try {db.prepare('INSERT OR REPLACE INTO memory_reuse_actions VALUES(?,?,?,?,?,?,?,?)').run(action.call_id,scope.tenant_id,scope.project_id,
    scope.principal_id||'local',text(action.task_id,'task_id'),action.completed?1:0,action.ok?1:0,proof);
  }finally{db.close();}
}

export async function reportCompactUse(host,signal) {
  if(signal?.used!==true)return {state:'unassessed'};
  const item=host.delivered.get(signal.usage_item_id);
  if(!item)throw Error('reference_not_delivered');
  const action=host.actions.get(signal.action_call_id);
  if(!action?.completed)throw Error('action_not_observed');
  const s=host.scope;
  for(const [key,value] of Object.entries({tenant_id:s.tenant_id,project_id:s.project_id,task_id:host.task_id}))
    if(item[key]!==value||action[key]!==value)throw Error('reuse_scope_mismatch');
  await host.store.getMemoryDetail({...s,memory_id:item.source_id,expected_version:item.source_version,work_type:item.work_type});
  const observation={usage_id:item.usage_id,usage_item_id:signal.usage_item_id,source_id:item.source_id,source_version:item.source_version,
    project_id:s.project_id,task_id:host.task_id,work_type:item.work_type,action_call_id:signal.action_call_id,context:host.context};
  const result=await receiveLocalUseObservation(host.store,s.tenant_id,observation,s.principal_id||'local');
  if(!result.use_receipt)throw Error('use_tracking_disabled');
  return {use_receipt:result.use_receipt,tracking:result.tracking};
}
