import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {reuseDigest,recordReuseAction} from './memory-reuse.mjs';
import {checkFreshness} from './memory-reuse-freshness.mjs';

// A result is a derived application. It never attests that the model read its originals.
export async function resultBasis({root,reuse,config,action,phase}){
 if(config.result_mode!=='validated'||!action.result_contract||!action.conditions||!action.freshness_profile)return null;
 const c=action.result_contract;
 if(!action.operations.includes(c.operation)||![c.payload_field,c.result_field].every(x=>typeof x==='string'&&/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(x)))throw Error('invalid_result_contract');
 const checked=await checkFreshness({root,reuse,config,profile_id:action.freshness_profile,input:action.conditions,phase});if(!checked.fresh)return null;
 const p=JSON.parse(await readFile(join(root,'.local/memory-reuse/freshness',action.freshness_profile+'.json'),'utf8'));
 const {scope:ignored,...basis}=p.basis;void ignored;
 if(action.argv[0]!==process.execPath||!action.argv[1])throw Error('result_action_requires_node');
 const implementation=reuseDigest(await readFile(action.argv[1],'utf8'));
 return {fingerprint:reuseDigest({basis,adapter:action.argv,implementation,contract:c,object_type_key:action.object_type_key,object_id:action.object_id}),refs:checked.source_refs};
}
export async function findResult(args,id){
 const b=await resultBasis({...args,phase:'result_lookup'});if(!b)return null;
 const {reuse,action}=args,s=reuse.scope,db=await reuse.open();let rows;
 try{rows=db.prepare(`SELECT a.* FROM memory_reuse_artifacts a WHERE a.kind='result' AND a.tenant_id=? AND a.project_id=? AND a.object_type_key=? AND a.object_id=? AND a.fingerprint=?
 AND(a.principal=? OR EXISTS(SELECT 1 FROM memory_reuse_artifact_grants g WHERE g.artifact_id=a.id AND g.tenant_id=a.tenant_id AND g.project_id=a.project_id AND g.principal=?)) ORDER BY a.created_at DESC`)
 .all(s.tenant_id,s.project_id,action.object_type_key,action.object_id,b.fingerprint,s.principal_id,s.principal_id);}finally{db.close();}
 const row=rows.find(x=>(!id||x.id===id)&&reuseDigest(JSON.parse(x.refs_json))===reuseDigest(b.refs));
 if(!row)return null;for(const ref of b.refs)await reuse.detail(ref);
 return {artifact_id:row.id,fingerprint:b.fingerprint,source_refs:b.refs,owner:row.principal};
}
export async function rememberResult({root,reuse,config,action,record,native}){
 if(record.request.result_id||record.request.freshness_profile!==action.freshness_profile)return null;
 const b=await resultBasis({root,reuse,config,action,phase:'result_capture'});if(!b)return null;
 const c=action.result_contract,payload=record.output[c.result_field];
 if(record.request.input?.op!==c.operation||!payload||reuseDigest(record.request.input[c.payload_field])!==reuseDigest(payload))return null;
 await recordReuseAction(reuse.store,reuse.scope,{call_id:native.tool_use_id,task_id:record.request.task_id,completed:true,ok:true,args:native.tool_input,result:native.tool_response,
 cache:{payload,fingerprint:b.fingerprint,refs:b.refs,object_type_key:action.object_type_key,object_id:action.object_id}});
 return reuse.createArtifact({kind:'result',object_type_key:action.object_type_key,object_id:action.object_id,refs:b.refs,payload,fingerprint:b.fingerprint,action_ref:native.tool_use_id,allowed_principals:action.result_allowed_principals??[]});
}
export async function confirmResultApplications({root,reuse,config,rows}){
 const applications=[];
 for(const row of rows){
  const p=row.payload;if(p?.type!=='host_result_application')continue;
  const r=JSON.parse(await readFile(join(root,'.local/memory-reuse/invocations',p.invocation_id+'.json'),'utf8'));
  if(r.native_call_id!==p.action_call_id||r.request.task_id!==p.task_id||r.output.derived_application_token!==p.token)throw Error('result_native_evidence_mismatch');
  const action=config.action_adapters?.[r.request.adapter];if(!action||!await findResult({root,reuse,config,action},r.request.result_id))continue;
  const {reuse_invocation_id:ignored,exit_code:ignoredExit,...result}=r.output;void ignored;void ignoredExit;
  await recordReuseAction(reuse.store,reuse.scope,{call_id:p.action_call_id,task_id:r.request.task_id,completed:true,ok:true,args:r.native_input,result});
  await reuse.confirmApplication(p.token,{call_id:p.action_call_id,task_id:r.request.task_id,args:r.native_input,result});
  applications.push({channel:'result',artifact_id:r.request.result_id,native_call_id:p.action_call_id,source_refs:result.source_refs});
 }
 return applications;
}
