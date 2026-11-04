import {mkdir,readFile,writeFile,appendFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {reuseDigest,reuseContentAllowed} from './memory-reuse.mjs';
import {checkFreshness} from './memory-reuse-freshness.mjs';
import {findResult,rememberResult} from './memory-reuse-results.mjs';
import {assertTaskOperation,captureCompletedWork,taskExecutionInput,taskSectionRequest} from './memory-reuse-task-confirmation.mjs';
import {parseTaskSectionsCommand} from './memory-task-transport.mjs';
const execute=promisify(execFile);
const directory=root=>join(root,'.local/memory-reuse/invocations');
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const context={task:'current Claude project task',target:'explicitly selected project object',constraints:'current source and native action scope',conditions:'explicit reference selection bundled with the native action'};
export function configuredAction(config,key){
 const a=config.action_adapters?.[key];
 if(!a||!Array.isArray(a.argv)||!a.argv.length||a.argv.some(x=>typeof x!=='string'||!x)||!a.object_id||!a.object_type_key||!Array.isArray(a.operations))throw Error('unconfigured_action_adapter');
 return a;
}
export async function bundledItems(reuse,request,action){
 if(!request.task_id?.startsWith('claude:')||!Array.isArray(request.uses)||request.uses.length>3||new Set(request.uses).size!==request.uses.length)throw Error('invalid_bundled_attribution');
 const db=await reuse.open(),s=reuse.scope,items=[];
 try{for(const id of request.uses){
  const item=db.prepare(`SELECT i.id,i.source_id,i.source_version FROM memory_usage_items i JOIN memory_usage_events e ON e.id=i.usage_event_id AND e.tenant_id=i.tenant_id
   JOIN memory_reuse_links l ON l.tenant_id=i.tenant_id AND l.project_id=e.project_id AND l.source_id=i.source_id AND l.source_version=i.source_version
   WHERE e.tenant_id=? AND e.project_id=? AND e.actor_principal=? AND e.task_id=? AND i.id=? AND l.object_type_key=? AND l.object_id=?`)
   .get(s.tenant_id,s.project_id,s.principal_id,request.task_id,id,action.object_type_key,action.object_id);
  if(!item)throw Error('reference_not_delivered_to_action');
  if((await reuse.detail(item)).verification_state!=='verified')throw Error('unverified_action_source');items.push(item);
 }}finally{db.close();}return items;
}
export async function runBundledAction({root,reuse,config,request,rawRequest,requestProtocol}){
 const started=performance.now();
 if(config.tracking_mode!=='bundled')throw Error('bundled_tracking_disabled');
 if(Object.keys(request).some(k=>!['task_id','adapter','input','uses','freshness_profile','result_id'].includes(k)))throw Error('invalid_bundled_request');
 const action=configuredAction(config,request.adapter);let input=request.input,cached;
 const task=await assertTaskOperation({root,reuse,config,request});
 if(task)input=taskExecutionInput(task,input);
 if(request.result_id){
  if(input!==undefined||request.uses?.length||request.freshness_profile!==action.freshness_profile||!request.task_id?.startsWith('claude:'))throw Error('invalid_result_request');
  cached=await findResult({root,reuse,config,action},request.result_id);if(!cached)throw Error('result_conditions_mismatch');
  const journal=join(root,'.local/memory-reuse/native-evidence',createHash('sha256').update(request.task_id.slice(7)).digest('hex')+'.jsonl');
  let rows=[];try{rows=(await readFile(journal,'utf8')).split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!rows.some(r=>r.payload?.type==='host_result_offer'&&r.payload.task_id===request.task_id&&r.payload.adapter===request.adapter&&r.payload.artifact_id===request.result_id))throw Error('result_not_offered_to_task');
 }
 if(cached)input={op:action.result_contract.operation};
 if(!input||!action.operations.includes(input.op))throw Error('action_operation_denied');
 if(!cached&&action.target_field&&action.target_field.split('.').reduce((v,k)=>v?.[k],input)!==action.target_value)throw Error('action_target_mismatch');
 if(!reuseContentAllowed(request)||Buffer.byteLength(rawRequest)>65536)throw Error('unsafe_action_input');
 const selected=await bundledItems(reuse,request,action);let freshness_check;
 if(config.source_resolution==='verified'&&selected.length&&action.freshness_profile&&!request.freshness_profile)throw Error('freshness_reference_requires_validation');
 if(request.freshness_profile){
  if(request.freshness_profile!==action.freshness_profile||!action.conditions)throw Error('freshness_action_mismatch');
  freshness_check=await checkFreshness({root,reuse,config,profile_id:request.freshness_profile,input:action.conditions,phase:'before_action'});
  if(!freshness_check.fresh)return {ok:false,error:'freshness_validation_required',freshness_check,required_action:'read_current_source; then act without the freshness profile'};
  const expected=freshness_check.source_refs.map(r=>r.source_id+'@'+r.source_version).sort();
  if(!cached&&JSON.stringify(selected.map(r=>r.source_id+'@'+r.source_version).sort())!==JSON.stringify(expected))throw Error('freshness_reference_mismatch');
 }
 const validated=performance.now(),id=randomUUID(),path=join(directory(root),id+'.json'),scope=reuse.scope;
 const record={request,rawRequest,scope,status:'started',created_at:Date.now(),freshness_check,...(requestProtocol?{request_protocol:requestProtocol}:{}),...(task?{work_source_fingerprint:task.source_fingerprint}:{})};
 await mkdir(directory(root),{recursive:true,mode:0o700});await writeFile(path,JSON.stringify(record),{mode:0o600});
 let exit_code=0,adapter_call_id,adapterMs=0;
 const perform=async value=>{
  if(action.target_field&&action.target_field.split('.').reduce((v,k)=>v?.[k],value)!==action.target_value)throw Error('action_target_mismatch');
  const before=performance.now();let stdout;try{({stdout}=await execute(action.argv[0],[...action.argv.slice(1),JSON.stringify(value)],{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:1024*1024}));}
  catch(error){stdout=error.stdout??'';exit_code=Number.isInteger(error.code)?error.code:1;}
  finally{adapterMs+=performance.now()-before;}
  let out;try{out=JSON.parse(stdout);}catch{out={ok:false,error:'adapter_result_unavailable'};exit_code=exit_code||1;}
  if(cached&&out.adapter_call_id){adapter_call_id=out.adapter_call_id;const {adapter_call_id:ignored,...stable}=out;void ignored;out=stable;}
  return out.ok===false?{...out,reuse_applied:false}:out;
 };
 const result=cached?await reuse.applyArtifact({artifact_id:cached.artifact_id,fingerprint:cached.fingerprint,task_id:request.task_id},payload=>perform({op:action.result_contract.operation,[action.result_contract.payload_field]:payload})):await perform(input);
 if(!reuseContentAllowed(result))throw Error('unsafe_action_output');
 const fullOutput={...result,...(adapter_call_id?{adapter_call_id}:{}),reuse_invocation_id:id,exit_code},w=task?config.task_workflows?.[task.workflow_id]:null;
 const compact=config.task_compact_receipts==='on'&&task?.local&&w?.source_mode==='project_files'&&!w.source_refs.length&&fullOutput.ok===true&&fullOutput.artifact?.path&&fullOutput.artifact.sha256;
 const output=compact?{ok:true,artifact:{path:fullOutput.artifact.path,sha256:fullOutput.artifact.sha256},reuse_invocation_id:id,exit_code,receipt_route:'completed_work_file'}:fullOutput;
 Object.assign(record,{status:'completed',output,digest:reuseDigest(output),...(compact?{backend_output:fullOutput,backend_digest:reuseDigest(fullOutput)}:{}),timings:{validation_ms:validated-started,adapter_ms:adapterMs,helper_body_ms:performance.now()-started},completed_at:Date.now()});await writeFile(path,JSON.stringify(record),{mode:0o600});
 return output;
}
export async function confirmBundledAction({root,reuse,config,input,prefix,journal}){
 if(config.tracking_mode!=='bundled'||input.tool_name!=='Bash')return null;
 let output;try{output=JSON.parse(input.tool_response?.stdout??'');}catch{return null;}
 if(!output.reuse_invocation_id)return null;
 if(!/^[0-9a-f-]{36}$/u.test(output.reuse_invocation_id))throw Error('invalid_action_invocation');
 const path=join(directory(root),output.reuse_invocation_id+'.json'),r=JSON.parse(await readFile(path,'utf8')),s=reuse.scope;
 if(r.backend_output&&r.backend_digest!==reuseDigest(r.backend_output))throw Error('action_invocation_backend_mismatch');
 if(r.status!=='completed'||r.request.task_id!=='claude:'+input.session_id||['tenant_id','project_id','principal_id'].some(k=>r.scope[k]!==s[k]))throw Error('action_invocation_scope_mismatch');
 let argumentsMatch=input.tool_input?.command===prefix+' run '+quote(r.rawRequest);
 if(r.request_protocol){const parsed=parseTaskSectionsCommand(input.tool_input?.command,prefix);argumentsMatch=r.request_protocol.kind==='task_sections_stdin'&&parsed?.session_id===input.session_id&&parsed.raw_stdin===r.request_protocol.raw_stdin&&reuseDigest(await taskSectionRequest({root,reuse,config,...parsed}))===reuseDigest(r.request);}
 if(Date.now()-r.completed_at>30*60000||r.digest!==reuseDigest(output)||!argumentsMatch)throw Error('action_invocation_mismatch');
 if(r.native_call_id&&r.native_call_id!==input.tool_use_id)throw Error('action_invocation_replayed');
 if(output.exit_code!==0||output.ok!==true||input.hook_event_name!=='PostToolUse'||input.tool_response?.is_error||input.tool_response?.exitCode>0||input.tool_response?.exit_code>0)return [];
 const action=configuredAction(config,r.request.adapter);await bundledItems(reuse,r.request,action);
 if(r.request.freshness_profile&&!(await checkFreshness({root,reuse,config,profile_id:r.request.freshness_profile,input:action.conditions,phase:'native_completion'})).fresh)throw Error('freshness_changed_before_completion');
 if(r.receipts)return r.receipts;
 if(r.request.result_id){
  Object.assign(r,{native_call_id:input.tool_use_id,native_input:input.tool_input,receipts:[]});await writeFile(path,JSON.stringify(r),{mode:0o600});
  const line=JSON.stringify({payload:{type:'host_result_application',task_id:r.request.task_id,action_call_id:input.tool_use_id,invocation_id:output.reuse_invocation_id,token:output.derived_application_token}})+'\n';
  if((await stat(journal)).size+Buffer.byteLength(line)>4*1024*1024)throw Error('native_hook_evidence_limit');await appendFile(journal,line,{mode:0o600});return [];
 }
 const receipts=[];
 for(const usage_item_id of r.request.uses){
  const receipt=await reuse.reportUse({used:true,usage_item_id,action_call_id:input.tool_use_id},r.request.task_id,context);
  receipts.push(receipt.use_receipt);
  const line=JSON.stringify({payload:{type:'host_memory_use_attribution',receipt_id:receipt.use_receipt,action_call_id:input.tool_use_id,invocation_id:output.reuse_invocation_id}})+'\n';
  if((await stat(journal)).size+Buffer.byteLength(line)>4*1024*1024)throw Error('native_hook_evidence_limit');
  await appendFile(journal,line,{mode:0o600});
 }
 const artifact=await rememberResult({root,reuse,config,action,record:r,native:input});
 const completed_work=await captureCompletedWork({root,reuse,config,action,record:r,native:input});
 Object.assign(r,{native_call_id:input.tool_use_id,receipts,...(artifact?{created_result:artifact}: {}),...(completed_work?{completed_work}:{})});await writeFile(path,JSON.stringify(r),{mode:0o600});return receipts;
}
export async function bundledAttributions({root,reuse,config,rows}){
 const attributions=[];
 for(const [order,row] of rows.entries()){
  if(row.payload?.type!=='host_memory_use_attribution')continue;
  const p=row.payload;let invalidated_reason;
  if(!/^[0-9a-f-]{36}$/u.test(p.invocation_id??'')){invalidated_reason='host_invocation_missing';}
  else {
   const r=JSON.parse(await readFile(join(directory(root),p.invocation_id+'.json'),'utf8'));
   if(r.native_call_id!==p.action_call_id||!r.receipts?.includes(p.receipt_id))invalidated_reason='host_invocation_mismatch';
   else if(r.request.freshness_profile){
    const action=configuredAction(config,r.request.adapter);
    if(!(await checkFreshness({root,reuse,config,profile_id:r.request.freshness_profile,input:action.conditions,phase:'stop'})).fresh)invalidated_reason='freshness_changed_before_stop';
   }
  }
  attributions.push({...p,order,invalidated_reason});
 }return attributions;
}
