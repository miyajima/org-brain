import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {LocalMemoryStore} from '../packages/orgbrain-cli/src/lib/local-memory-store.mjs';
import {MemoryReuse,recordReuseAction,reuseDigest} from '../packages/orgbrain-cli/src/lib/memory-reuse.mjs';
import {resultBasis} from '../packages/orgbrain-cli/src/lib/memory-reuse-results.mjs';
const load=async p=>JSON.parse(await readFile(p,'utf8'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function validatePrior(p,input){
 const r=p.invocation,o=p.outcome;
 if(!r.native_call_id||!p.native.some(x=>x.id===r.native_call_id&&x.type==='tool_use'&&x.name==='Bash'))throw Error('prior_native_completion_required');
 if(o.status!=='observed'||!o.success||!o.meaning_preserved||!o.native_arguments_match||o.hook_errors.length||r.status!=='completed'||r.output.ok!==true||r.output.exit_code!==0)throw Error('prior_success_not_verified');
 if(p.state.target!==input.target||p.state.records!==input.records||reuseDigest(r.request.input?.plan)!==reuseDigest(p.state.expected)||reuseDigest(r.output.applied_plan)!==reuseDigest(p.state.expected))throw Error('prior_input_or_output_mismatch');
 return p.native.find(x=>x.id===r.native_call_id);
}
// Evaluation preparation only. This command is never exposed to the evaluated model.
export async function importResult({root,prior,adapter_sha256}){
 const config=await load(join(root,'.local/memory-reuse/config.json')),action=config.action_adapters.plan,input=action.conditions;
 const outcome=await load(join(prior,'outcome.json')),state=await load(join(prior,'state.json'));
 const events=(await readFile(join(prior,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse),native=events.flatMap(x=>x.type==='assistant'&&Array.isArray(x.message?.content)?x.message.content:[]);
 const invocations=(await import('node:fs/promises')).readdir;let invocation;
 for(const name of await invocations(join(prior,'invocations'))){const r=await load(join(prior,'invocations',name));if(r.request.input?.op==='apply'&&r.native_call_id)invocation=r;}
 if(!invocation)throw Error('prior_native_completion_required');
 const call=validatePrior({outcome,state,invocation,native},input);
 if(outcome.adapter_sha256!==adapter_sha256)throw Error('prior_adapter_changed');
 const oldConfig=await load(join(prior,'config.json')),profile=oldConfig.freshness_profiles.plan,proof=await load(join(prior,'freshness/plan.json'));
 if(proof.basis.environment.node!==process.version)throw Error('prior_environment_changed');
 const currentCorpus=await load(action.source_argv[3]+'/corpus.json');if(reuseDigest(currentCorpus.rules[input.target])!==reuseDigest(state.rule))throw Error('prior_source_changed');
 if(reuseDigest(profile.refs)!==reuseDigest(config.freshness_profiles.plan.refs))throw Error('prior_source_version_changed');
 const store=new LocalMemoryStore(config.db_path,{denseEmbeddingProvider:null}),scope={tenant_id:config.tenant_id,project_id:config.project_id,principal_id:outcome.principal,work_type:'implementation'},reuse=new MemoryReuse(store,scope);
 const b=await resultBasis({root,reuse,config,action,phase:'prior_result_import'});if(!b)throw Error('current_result_validation_required');
 const output=events.flatMap(x=>x.type==='user'&&Array.isArray(x.message?.content)?x.message.content:[]).find(x=>x.type==='tool_result'&&x.tool_use_id===call.id);
 if(!output||output.is_error||typeof output.content!=='string'||reuseDigest(JSON.parse(output.content))!==reuseDigest(invocation.output))throw Error('prior_native_output_missing');
 const currentSourceSha=sha(await readFile(action.source_argv[3]+'/corpus.json'));
 if(!proof.basis.files.some(x=>x.sha256===currentSourceSha))throw Error('prior_source_bytes_changed');
 // The original successful native action is retained; no synthetic tool call or response is inserted.
 await recordReuseAction(store,scope,{call_id:call.id,task_id:outcome.id,completed:true,ok:true,args:call.input,result:invocation.output,
 cache:{payload:invocation.output.applied_plan,fingerprint:b.fingerprint,refs:b.refs,object_type_key:action.object_type_key,object_id:action.object_id}});
 const artifact=await reuse.createArtifact({kind:'result',object_type_key:action.object_type_key,object_id:action.object_id,refs:b.refs,payload:invocation.output.applied_plan,fingerprint:b.fingerprint,action_ref:call.id,allowed_principals:config.evaluation_consumer!==outcome.principal?[config.evaluation_consumer]:[]});
 const evidence={artifact_id:artifact.id,owner:outcome.principal,prior_task:outcome.id,native_call_id:call.id,prior_outcome_sha256:sha(await readFile(join(prior,'outcome.json'))),prior_events_sha256:sha(await readFile(join(prior,'events.jsonl'))),adapter_sha256,source_refs:b.refs,fingerprint:b.fingerprint,original_creation_tokens:outcome.total_tokens,original_creation_ms:outcome.total_ms,original_creation_api_equivalent_usd:outcome.api_equivalent_usd,model_calls:0};
 await writeFile(join(root,'.local/memory-reuse/prior-result-import.json'),JSON.stringify(evidence,null,2)+'\n',{mode:0o600});return evidence;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)console.log(JSON.stringify(await importResult(JSON.parse(process.argv[2]))));
