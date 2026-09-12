import { localUseFlags, localUseService, storeLocalUseProof } from './local-memory-use.mjs';
import { useHash, observeMemoryUse } from '../../../shared/src/memory-use-history-runtime.mjs';

function decode(value) {
  if(typeof value==='string') {try{return decode(JSON.parse(value));}catch{return value;}}
  if(value?.Ok) return decode(value.Ok);
  if(value?.data) return decode(value.data);
  if(Array.isArray(value?.content)) {
    const text=value.content.filter(x=>x.type==='text').map(x=>x.text).join('\n');
    return decode(text);
  }
  return value;
}
function name(value) { return String(value??'').split('__').at(-1); }

/** Only real transcript events count. Embedded code/quoted tool calls are not parsed. */
export function memoryUseTranscriptEvents(rows) {
  const calls=new Map(), users=[];
  for(const [order,row] of rows.entries()) {
    const p=row.payload??row;
    if(p.type==='user_message'&&typeof p.message==='string') users.push({order,text:p.message});
    if(p.type==='message'&&p.role==='user') {
      const text=typeof p.content==='string'?p.content:(p.content??[]).map(x=>x.text??'').join('\n');
      users.push({order,text});
    }
    if(['function_call','custom_tool_call'].includes(p.type)) calls.set(p.call_id,{id:p.call_id,name:name(p.name),args:decode(p.arguments??p.input),order,done:false});
    if(['function_call_output','custom_tool_call_output'].includes(p.type)&&calls.has(p.call_id)) {
      const call=calls.get(p.call_id), output=decode(p.output);
      Object.assign(call,{output,done:!output?.isError&&!output?.error,output_order:order});
    }
    if(p.type==='mcp_tool_call_end') {
      const invocation=p.invocation??{};
      calls.set(p.call_id??p.id??`mcp:${order}`,{id:p.call_id??p.id??`mcp:${order}`,name:name(invocation.tool??invocation.name),
        args:decode(invocation.arguments??invocation.args??{}),output:decode(p.result),done:!p.result?.Err&&!decode(p.result)?.isError,order,output_order:order});
    }
  }
  return {calls:[...calls.values()],users};
}

export async function collectMemoryUse(store,{rows,tenantId,projectId,taskId,turnId=null,principal=process.env.ORGBRAIN_USE_PRINCIPAL || 'local'}) {
  await store.init();
  const db=store.open();
  try {
    const flags=localUseFlags(db);
    if(!flags.collect) return {queued:0,recorded:0,skipped:'disabled'};
    if(!taskId||!projectId) return {queued:0,recorded:0,skipped:'task_identity_missing'};
    const {calls,users}=memoryUseTranscriptEvents(rows);
    const observations=calls.filter(c=>c.name==='orgbrain_memory_observe'&&c.done&&c.output?.accepted===true&&c.args?.use_observation).slice(0,3);
    let queued=0,recorded=0; const rejected=[];
    for(const call of observations) {
      try {
        const input=observeMemoryUse(call.args.use_observation).observation;
        if(input.task_id!==taskId||input.project_id!==projectId) throw new Error('use_task_mismatch');
        let retrieval=calls.find(c=>c.done&&c.order<call.order&&/orgbrain_(?:memory_search|memories_search|memory_retrieve_context|memories_retrieve_context|context_enrich)$/.test(c.name)
          &&c.output?.meta?.usage_id===input.usage_id&&c.output?.meta?.usage_item_ids?.includes(input.usage_item_id)
          &&c.args?.project_id===projectId&&c.args?.task_id===taskId);
        if(!retrieval && turnId) {
          const injection=db.prepare(`SELECT i.* FROM memory_usage_items i JOIN memory_usage_events e ON e.id=i.usage_event_id AND e.tenant_id=i.tenant_id
            WHERE e.tenant_id=? AND e.actor_principal=? AND e.task_id=? AND e.trace_id=? AND e.capability='hook_context'
            AND e.id=? AND i.id=? AND i.reference_type='injected'`).get(tenantId,principal,taskId,turnId,input.usage_id,input.usage_item_id);
          if(injection) retrieval={order:-1,output:{results:[{id:injection.source_id,current_version:injection.source_version}]}};
        }
        if(!retrieval) throw new Error('use_retrieval_not_observed');
        if(retrieval.output?.meta?.usage_items && !retrieval.output.meta.usage_items.some(x=>x.usage_item_id===input.usage_item_id&&x.source_id===input.source_id&&x.source_version===input.source_version)) throw new Error('use_retrieval_item_mismatch');
        const results=retrieval.output.results??[];
        if(!results.some(x=>(x.memory?.id??x.id)===input.source_id&&(x.memory?.current_version??x.current_version)===input.source_version)) throw new Error('use_version_not_observed');
        const action=calls.find(c=>c.id===input.action_call_id&&c.order>retrieval.order&&c.output_order<call.order&&c.done&&!c.name.startsWith('orgbrain_memory_observe'));
        if(!action) throw new Error('use_action_not_observed');
        const now=Date.now(), scope={tenant_id:tenantId,principal,project_id:projectId,task_id:taskId,source_id:input.source_id,usage_item_id:input.usage_item_id,created_at:now};
        const actionHash=await useHash({arguments:action.args,result:action.output});
        const evidence=[await storeLocalUseProof(db,{...scope,role:'action',text:`memory=${input.source_id}; call=${action.id}; tool=${action.name}; turn=${turnId??'current'}; observed_action_hash=${actionHash}`})];
        const outcome=calls.find(c=>c.id===input.outcome_call_id&&c.order>=action.order&&c.output_order<call.order&&c.done);
        // Require a structured final result. A failed command is a confirmed outcome, not evidence of harm by itself.
        if(outcome&&(Number.isInteger(outcome.output?.exit_code)||['succeeded','failed'].includes(outcome.output?.status)||typeof outcome.output?.ok==='boolean')) {
          evidence.push(await storeLocalUseProof(db,{...scope,role:'outcome',text:`memory=${input.source_id}; call=${outcome.id}; observed_result_hash=${await useHash(outcome.output)}; status=${String(outcome.output.exit_code??outcome.output.status??outcome.output.ok)}`}));
        }
        // Explicit user attribution only; assistant assertions and observation arguments never rate usefulness.
        const assessment=users.find(u=>u.order>action.output_order&&u.order<call.order&&[`${input.source_id}: 役立った`,`${input.source_id}: 有害だった`,`${input.source_id}: was useful`,`${input.source_id}: was harmful`].includes(u.text.trim()));
        if(assessment&&assessment.text.length<=1000) evidence.push(await storeLocalUseProof(db,{...scope,role:'assessment',text:assessment.text,
          contribution:/有害だった|was harmful/iu.test(assessment.text)?'negative':'positive'}));
        const id=await useHash({tenantId,taskId,call:call.id,input});
        const payload={id,usage_item_id:input.usage_item_id,project_id:projectId,task_id:taskId,work_type:input.work_type??'unknown',context:input.context,evidence};
        const localItem=db.prepare('SELECT id FROM memory_usage_items WHERE tenant_id=? AND id=?').get(tenantId,input.usage_item_id);
        if(localItem) {
          const service=localUseService(db,tenantId,principal);
          await service.record(payload); recorded++;
          const index=evidence.findIndex(e=>e.role==='assessment');
          if(index>=0) await service.evaluate({id:`${id}:rating`,context_id:id,proof_id:`${id}:${index}`});
        }
        if(flags.sync) {
          // No transcript, raw command, or proof text is placed in the transport queue.
          const transport={...payload,evidence:evidence.map(({excerpt:_excerpt,...e})=>e)};
          db.prepare("INSERT OR IGNORE INTO memory_use_outbox(id,tenant_id,payload_json,status,created_at) VALUES(?,?,?,'pending',?)").run(id,tenantId,JSON.stringify(transport),now);queued++;
          const assessmentIndex=evidence.findIndex(e=>e.role==='assessment');
          if(assessmentIndex>=0) {
            const evaluation={id:`${id}:rating`,context_id:id,proof_id:`${id}:${assessmentIndex}`,operation:'evaluate'};
            db.prepare("INSERT OR IGNORE INTO memory_use_outbox(id,tenant_id,payload_json,status,created_at) VALUES(?,?,?,'pending',?)").run(`${id}:evaluate`,tenantId,JSON.stringify(evaluation),now+1);
          }
        }
      } catch(error) { rejected.push(error.message); }
    }
    return {queued,recorded,rejected};
  } finally {db.close();}
}

export const MEMORY_USE_OBSERVE_HINT = 'When a retrieved memory actually informs an action, call orgbrain_memory_observe with schema_version=2, lesson_type="success", and use_observation containing the returned usage_id, matching usage_item_id, source_id, source_version, project_id, task_id, work_type, context {task,target,constraints,conditions}, action_call_id and optional outcome_call_id. Only name actual current-turn calls. Do not rate usefulness or infer success. Do not emit an observation for mere citation.';

export { observeMemoryUse };
