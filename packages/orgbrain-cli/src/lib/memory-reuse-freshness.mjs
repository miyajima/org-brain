import {mkdir,readFile,writeFile,appendFile,realpath} from 'node:fs/promises';
import {resolve,join,isAbsolute} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {reuseDigest,reuseContentAllowed} from './memory-reuse.mjs';
const execute=promisify(execFile);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function profile(config,id){
 if(config.freshness_mode!=='validated')throw Error('freshness_disabled');
 if(!/^[a-zA-Z0-9_-]{1,64}$/u.test(id))throw Error('invalid_freshness_profile');
 const p=config.freshness_profiles?.[id];
 if(!p||!p.refs?.length||!p.source_files?.length||p.argv?.[0]!==process.execPath||!p.argv[1])throw Error('unconfigured_freshness_profile');
 if(!Number.isInteger(p.valid_for_ms)||p.valid_for_ms<1||p.valid_for_ms>7*86400000)throw Error('invalid_freshness_expiry');return p;
}
const proofPath=(root,id)=>join(root,'.local/memory-reuse/freshness',id+'.json');
async function snapshot({root,reuse,config,profile_id,input}){
 const p=profile(config,profile_id),base=await realpath(p.source_root??root),files=[],memories=[];
 for(const ref of p.refs){const memory=await reuse.detail(ref);if(memory.verification_state!=='verified')throw Error('freshness_source_unverified');memories.push(memory);}
 for(const name of p.source_files){
  if(isAbsolute(name)||name.split('/').includes('..'))throw Error('freshness_source_outside_project');
  const path=await realpath(resolve(base,name));if(!path.startsWith(base+'/'))throw Error('freshness_source_outside_project');
  const bytes=await readFile(path);files.push({name,path,sha256:digest(bytes),bytes:bytes.length});
 }
 const dependencies=[];for(const path of [...new Set([p.argv[1],...(p.dependency_files??[])])])dependencies.push({path,sha256:digest(await readFile(path))});
 const source=memories.map(x=>({id:x.id,version:x.current_version,body:reuseDigest({content:x.content,rationale:x.rationale,reuse_rule:x.reuse_rule,source_references:x.source_references})}));
 const basis={scope:reuse.scope,input,refs:p.refs,files,source,environment:{node:process.version,executable:process.execPath,declared:p.environment,validator_argv:p.argv,dependencies},valid_for_ms:p.valid_for_ms,coverage_contract:p.coverage_contract??null};
 return {p,basis,digest:reuseDigest(basis),memories,files};
}
async function log(root,name,value){const dir=join(root,'.local/memory-reuse/freshness');await mkdir(dir,{recursive:true,mode:0o700});await appendFile(join(dir,name+'.jsonl'),JSON.stringify(value)+'\n',{mode:0o600});}
export async function primeFreshness({root,reuse,config,profile_id,input,now=Date.now}){
 const started=performance.now(),before=await snapshot({root,reuse,config,profile_id,input}),p=before.p;
 const request={input,memories:before.memories,source_files:before.files.map(x=>x.path)};if(!reuseContentAllowed(request))throw Error('unsafe_freshness_validation');
 const {stdout}=await execute(p.argv[0],[...p.argv.slice(1),JSON.stringify(request)],{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
 const validation=JSON.parse(stdout);if(validation.ok!==true)throw Error('freshness_validation_failed');
 if(p.coverage_contract&&(!validation.coverage||reuseDigest(validation.coverage)!==reuseDigest(p.coverage_contract)))throw Error('freshness_validation_coverage_mismatch');
 const after=await snapshot({root,reuse,config,profile_id,input});if(after.digest!==before.digest)throw Error('freshness_changed_during_validation');
 const proof={digest:after.digest,basis:after.basis,created_at:now(),expires_at:now()+p.valid_for_ms,validator_result_digest:reuseDigest(stdout),...(p.coverage_contract?{coverage:validation.coverage}:{})};
 await mkdir(join(root,'.local/memory-reuse/freshness'),{recursive:true,mode:0o700});await writeFile(proofPath(root,profile_id),JSON.stringify(proof),{mode:0o600});
 const result={primed:true,profile_id,source_refs:p.refs,elapsed_ms:performance.now()-started,source_bytes_read:before.files.reduce((n,x)=>n+x.bytes,0)+after.files.reduce((n,x)=>n+x.bytes,0),validator_source_bytes_read:Number.isInteger(validation.source_bytes_read)?validation.source_bytes_read:null,validator_calls:1,model_calls:0};await log(root,'prime-events',result);return result;
}
export async function checkFreshness({root,reuse,config,profile_id,input,phase='check',now=Date.now}){
 const started=performance.now();profile(config,profile_id);let proof,result;
 try{proof=JSON.parse(await readFile(proofPath(root,profile_id),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;result={fresh:false,reason:'proof_missing'};}
 if(!result&&proof.expires_at<=now())result={fresh:false,reason:'proof_expired'};
 let current;
 if(!result){
  try{current=await snapshot({root,reuse,config,profile_id,input});}
  catch(error){if(!['memory_detail_unavailable','reuse_source_conflicted','sensitive_reuse_source_denied','freshness_source_unverified'].includes(error.message))throw error;result={fresh:false,reason:'source_no_longer_available'};}
  if(!result)result=current.digest===proof.digest?{fresh:true,source_refs:current.p.refs,...(proof.coverage?{coverage:proof.coverage}:{})}:{fresh:false,reason:'conditions_changed'};
 }
 const full={...result,profile_id,phase,elapsed_ms:performance.now()-started,source_bytes_read:current?.files.reduce((n,x)=>n+x.bytes,0)??0,validator_calls:0,model_calls:0};await log(root,'check-events',full);return full;
}
