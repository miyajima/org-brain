import {readFile,appendFile,mkdir,readdir,stat} from 'node:fs/promises';
import {join} from 'node:path';
const BINS=['input_tokens','cache_creation_input_tokens','cache_read_input_tokens','output_tokens'];
export function confirmationTiming({displayed_ms,answered_ms,simulated,active_seconds}){
 if(simulated)return {confirmation_elapsed_ms:null,human_active_ms:null,human_time_source:'simulated_answer'};
 const elapsed=answered_ms-displayed_ms;if(!Number.isFinite(elapsed)||elapsed<0)throw Error('invalid_confirmation_time');
 if(active_seconds!==undefined&&(!Number.isFinite(active_seconds)||active_seconds<0||active_seconds*1000>elapsed))throw Error('invalid_active_time');
 return {confirmation_elapsed_ms:elapsed,human_active_ms:active_seconds===undefined?null:active_seconds*1000,human_time_source:active_seconds===undefined?'real_answer_elapsed':'self_reported_attention'};
}
export async function appendWorkObservation(root,event){
 if(!/^[\w:-]{1,128}$/u.test(event.session_id))throw Error('invalid_observation_session');
 const directory=join(root,'.local/memory-reuse/work-observations');await mkdir(directory,{recursive:true,mode:0o700});
 const keys=['session_id','event','purpose','origin','condition','workflow_id','kind','choice','confirmation_elapsed_ms','human_active_ms','human_time_source','human_timing_group_id','pre_model_ms','cli_elapsed_ms','session_elapsed_ms','model_starts','exit_code','completion','usage','reason'];
 const value=Object.fromEntries(keys.filter(k=>Object.hasOwn(event,k)).map(k=>[k,event[k]]));
 await appendFile(join(directory,event.session_id+'.jsonl'),JSON.stringify({...value,recorded_at:new Date().toISOString()})+'\n',{mode:0o600});return value;
}
export async function readSessionUsage(path,session_id){
 const missing=reason=>({total_tokens:null,usage:null,models:[],api_equivalent_usd:null,actual_billing_usd:null,reason});
 try{
  if(!path||(await stat(path)).size>16*1024*1024)return missing('transcript_missing_or_too_large');
  const messages=new Map();for(const line of (await readFile(path,'utf8')).split('\n').filter(Boolean)){const row=JSON.parse(line);if(row.type==='assistant'&&row.sessionId===session_id&&row.message?.id)messages.set(row.message.id,row.message);}
  if(!messages.size)return missing('no_current_session_usage');
  const usage=Object.fromEntries(BINS.map(k=>[k,0])),models=new Set();
  for(const m of messages.values()){if(typeof m.model!=='string'||BINS.some(k=>!Number.isInteger(m.usage?.[k])||m.usage[k]<0))return missing('incomplete_usage_bins');models.add(m.model);for(const k of BINS)usage[k]+=m.usage[k];}
  return {total_tokens:Object.values(usage).reduce((a,b)=>a+b,0),usage,models:[...models],api_equivalent_usd:null,actual_billing_usd:null,reason:'token_usage_only_no_verified_price_or_invoice'};
 }catch{return missing('unreadable_session_usage');}
}
export async function workObservationSummary(root){
 const directory=join(root,'.local/memory-reuse/work-observations');let files;try{files=await readdir(directory);}catch(e){if(e.code==='ENOENT')return {sessions:0,real_answer_count:0,completed_existing:0,model_starts:0,human_active_ms:null,human_time_missing_count:0};throw e;}
 const sessions=new Map();for(const f of files.filter(f=>f.endsWith('.jsonl'))){for(const line of (await readFile(join(directory,f),'utf8')).split('\n').filter(Boolean)){const x=JSON.parse(line);if(x.purpose==='test')continue;const s=sessions.get(x.session_id)??[];s.push(x);sessions.set(x.session_id,s);}}
 const rows=[...sessions.values()],answers=rows.flat().filter(x=>x.confirmation_elapsed_ms!==undefined&&x.confirmation_elapsed_ms!==null),groups=new Map();
 for(const x of answers){const key=x.human_timing_group_id??x.session_id;if(groups.has(key)&&(groups.get(key).confirmation_elapsed_ms!==x.confirmation_elapsed_ms||groups.get(key).human_active_ms!==x.human_active_ms))throw Error('conflicting_human_timing_group');groups.set(key,x);}
 const timed=[...groups.values()],missing=timed.filter(x=>x.human_active_ms===null).length;
 return {sessions:rows.length,real_answer_count:answers.length,human_timing_groups:timed.length,completed_existing:rows.filter(xs=>xs.some(x=>x.event==='completed_existing'&&x.completion?.status==='completed_with_existing_result'||x.event==='completed_existing'&&!x.completion)).length,model_starts:rows.flat().reduce((n,x)=>n+(x.model_starts??0),0),confirmation_elapsed_ms:timed.length?timed.reduce((n,x)=>n+x.confirmation_elapsed_ms,0):null,human_time_missing_count:missing,human_active_ms:!timed.length||missing?null:timed.reduce((n,x)=>n+x.human_active_ms,0),organic_sessions:rows.filter(xs=>xs[0].origin==='organic').length,solicited_sessions:rows.filter(xs=>xs[0].origin==='solicited').length};
}
