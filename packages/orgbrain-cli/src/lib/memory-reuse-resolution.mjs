import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {configuredAction} from './memory-reuse-bundled.mjs';
import {checkFreshness} from './memory-reuse-freshness.mjs';
import {reuseDigest,reuseContentAllowed} from './memory-reuse.mjs';
const execute=promisify(execFile);
const refsKey=refs=>JSON.stringify(refs.map(x=>x.source_id+'@'+x.source_version).sort());
const equal=(a,b)=>JSON.stringify(Object.entries(a??{}).sort())===JSON.stringify(Object.entries(b??{}).sort());
export function taskInput(prompt){
 const matches=[...String(prompt).matchAll(/<task_input>([^\n]*?)<\/task_input>/gu)];if(matches.length!==1)return null;
 try{const x=JSON.parse(matches[0][1]);return x&&typeof x==='object'&&!Array.isArray(x)?x:null;}catch{return null;}
}
export async function sourceContextStatus({root,reuse,config,adapter_key,references,prompt,input=taskInput(prompt),phase='context'}){
 const action=configuredAction(config,adapter_key),p=config.freshness_profiles?.[action.freshness_profile];
 if(config.source_resolution!=='verified'||config.freshness_mode!=='validated'||!p?.coverage_contract||!action.required_fields?.length)return {current:false,reason:'coverage_not_declared'};
 if(!input||!equal(input,action.conditions))return {current:false,reason:'task_input_not_bound'};
 if(p.coverage_contract.kind!=='complete_source'||!Array.isArray(p.coverage_contract.fields)||JSON.stringify([...p.coverage_contract.fields].sort())!==JSON.stringify([...action.required_fields].sort()))return {current:false,reason:'coverage_incomplete'};
 if(refsKey(references)!==refsKey(p.refs))return {current:false,reason:'reference_mismatch'};
 const checked=await checkFreshness({root,reuse,config,profile_id:action.freshness_profile,input:action.conditions,phase});
 return checked.fresh&&checked.coverage&&reuseDigest(checked.coverage)===reuseDigest(p.coverage_contract)?{current:true,profile_id:action.freshness_profile,source_refs:checked.source_refs,conditions:action.conditions}:{current:false,reason:checked.reason??'coverage_missing'};
}
export async function resolveActionSource({root,reuse,config,request,rawRequest}){
 const started=performance.now();
 if(Object.keys(request).some(k=>!['task_id','adapter','refresh'].includes(k))||!request.task_id?.startsWith('claude:')||(request.refresh!==undefined&&typeof request.refresh!=='boolean'))throw Error('invalid_source_resolution_request');
 const action=configuredAction(config,request.adapter);
 if(!Array.isArray(action.source_argv)||!action.source_argv.length||action.source_argv.some(x=>typeof x!=='string'||!x)||!Array.isArray(action.source_requests)||!action.source_requests.length)throw Error('unconfigured_source_adapter');
 const journal=join(root,'.local/memory-reuse/native-evidence',createHash('sha256').update(request.task_id.slice(7)).digest('hex')+'.jsonl');let rows=[];
 try{rows=(await readFile(journal,'utf8')).split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code!=='ENOENT')throw error;}
 const context=rows.find(x=>x.verified_source_context?.task_id===request.task_id&&x.verified_source_context.adapter===request.adapter),delivery=rows.find(x=>x.hook_context_references&&x.payload?.content?.includes('task_id='+request.task_id+';'));
 let status={current:false,reason:'context_not_delivered'};
 if(!request.refresh&&context&&delivery)status=await sourceContextStatus({root,reuse,config,adapter_key:request.adapter,references:delivery.hook_context_references,input:context.verified_source_context.input,phase:'resolve'});
 const id=randomUUID(),results=[],backend_requests=[];
 if(!status.current){
  for(const input of action.source_requests){
   const {stdout}=await execute(action.source_argv[0],[...action.source_argv.slice(1),JSON.stringify(input)],{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
   const result=JSON.parse(stdout);if(result.error||result.ok===false)throw Error('source_adapter_denied_or_failed');if(!reuseContentAllowed(result))throw Error('unsafe_source_output');results.push(result);backend_requests.push(input);
  }
 }
 const output={source:status.current?'verified_context':'current_source',...(status.current?{source_refs:status.source_refs,note:'The complete current original is already in this task context; generate the action from it.'}:{results}),source_resolution_id:id};
 const dir=join(root,'.local/memory-reuse/resolutions');await mkdir(dir,{recursive:true,mode:0o700});
 await writeFile(join(dir,id+'.json'),JSON.stringify({request,rawRequest,scope:reuse.scope,backend_requests,output,elapsed_ms:performance.now()-started}),{mode:0o600});return output;
}
