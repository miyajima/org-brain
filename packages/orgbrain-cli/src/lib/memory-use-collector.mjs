import { localUseFlags, localUseService, storeLocalUseProof } from './local-memory-use.mjs';
import { useHash, observeMemoryUse } from '../../../shared/src/memory-use-history-runtime.mjs';

function decode(value) {
  if(typeof value==='string') {
    try{return decode(JSON.parse(value));}catch { /* Code-runner output has a transport header. */ }
    const offset=value.indexOf('\nOutput:\n');
    if(offset>=0) {try{return decode(JSON.parse(value.slice(offset+9)));}catch { /* Keep unparsed text as data. */ }}
    return value;
  }
  if(value?.Ok) return decode(value.Ok);
  if(value?.data) return decode(value.data);
  if(Array.isArray(value?.content)) {
    const text=value.content.filter(x=>x.type==='text').map(x=>x.text).join('\n');
    return decode(text);
  }
  return value;
}
function name(value) { return String(value??'').split('__').at(-1); }
function usageItems(items) {
  return Array.isArray(items) ? items.filter(item=>item&&['usage_item_id','source_id'].every(key=>typeof item[key]==='string')&&Number.isInteger(item.source_version)) : [];
}
function receiptIds(value) {
  return [...new Set((typeof value==='string'?value:JSON.stringify(value??null)).match(/orgbrain-use-receipt:[a-f0-9-]{36}/gu)??[])];
}
function resultObjects(value) {
  const decoded=decode(value);
  if(decoded&&typeof decoded==='object') return Array.isArray(decoded)?decoded.flatMap(resultObjects):[decoded];
  // Multiple text() outputs are separate JSON lines. Never parse the call's code.
  return typeof decoded==='string'?decoded.split('\n').flatMap(line=>{try{return resultObjects(JSON.parse(line));}catch{return [];}}):[];
}

/** Only real transcript events count. Embedded code/quoted tool calls are not parsed. */
export function memoryUseTranscriptEvents(rows) {
  const calls=new Map(), users=[], injections=[];
  for(const [order,row] of rows.entries()) {
    const p=row.payload??row;
    if(p.type==='user_message'&&typeof p.message==='string') users.push({order,text:p.message});
    if(p.type==='message'&&p.role==='user') {
      const text=typeof p.content==='string'?p.content:(p.content??[]).map(x=>x.text??'').join('\n');
      users.push({order,text});
    }
    if(p.type==='message'&&p.role==='developer') {
      const text=typeof p.content==='string'?p.content:(p.content??[]).map(x=>x.text??'').join('\n');
      for(const match of text.matchAll(/Use tracking: receipt; task_id=([^;]+); project_id=([^;]+); work_type=([^;]+); usage_id=([^;]+); items=(\[[^\n]*?\])(?:\s|$)/gu)) {
        try { injections.push({order,task_id:match[1],project_id:match[2],usage_id:match[4],items:usageItems(JSON.parse(match[5]))}); } catch { /* Truncated receipts are not proof. */ }
      }
    }
    if(['function_call','custom_tool_call'].includes(p.type)) calls.set(p.call_id,{id:p.call_id,name:name(p.name),args:decode(p.arguments??p.input),order,done:false});
    if(['function_call_output','custom_tool_call_output'].includes(p.type)&&calls.has(p.call_id)) {
      const call=calls.get(p.call_id), output=decode(p.output);
      call.outputs??=[]; call.outputs.push(output);
      Object.assign(call,{output,done:!output?.isError&&!output?.error,output_order:order});
    }
    if(p.type==='mcp_tool_call_end') {
      const invocation=p.invocation??{};
      calls.set(p.call_id??p.id??`mcp:${order}`,{id:p.call_id??p.id??`mcp:${order}`,name:name(invocation.tool??invocation.name),
        args:decode(invocation.arguments??invocation.args??{}),output:decode(p.result),done:!p.result?.Err&&!decode(p.result)?.isError,order,output_order:order});
    }
  }
  return {calls:[...calls.values()],users,injections};
}

export async function collectMemoryUse(store,{rows,tenantId,projectId,taskId,turnId=null,principal=process.env.ORGBRAIN_USE_PRINCIPAL || 'local'}) {
  await store.init();
  const db=store.open();
  try {
    const flags=localUseFlags(db);
    if(!flags.collect) return {queued:0,recorded:0,skipped:'disabled'};
    if(!taskId||!projectId) return {queued:0,recorded:0,skipped:'task_identity_missing'};
    const {calls,users,injections}=memoryUseTranscriptEvents(rows);
    const deliveries=[...injections.filter(i=>i.task_id===taskId&&i.project_id===projectId),
      ...calls.filter(c=>c.done).flatMap(c=>resultObjects(c.outputs??c.output)).filter(o=>o.meta?.usage_id&&Array.isArray(o.meta?.usage_items))
        .map(o=>({usage_id:o.meta.usage_id,items:usageItems(o.meta.usage_items)}))];
    for(const delivery of deliveries) for(const candidate of delivery.items) {
      const match=db.prepare(`SELECT i.id FROM memory_usage_items i JOIN memory_usage_events e ON e.id=i.usage_event_id AND e.tenant_id=i.tenant_id
        WHERE e.tenant_id=? AND e.actor_principal=? AND e.project_id=? AND e.task_id=? AND e.id=? AND i.id=? AND i.source_id=? AND i.source_version=?`)
        .get(tenantId,principal,projectId,taskId,delivery.usage_id,candidate.usage_item_id,candidate.source_id,candidate.source_version);
      if(match) db.prepare('INSERT OR IGNORE INTO local_use_deliveries VALUES(?,?,?,?,?,?)').run(tenantId,match.id,principal,taskId,projectId,Date.now());
    }
    const observations=[], seenReceipts=new Set();
    for(const call of calls.filter(c=>c.done)) {
      let hasReceipt=false;
      for(const id of receiptIds(call.outputs??call.output)) {
        const receipt=db.prepare('SELECT * FROM local_use_observation_receipts WHERE id=? AND tenant_id=? AND principal=? AND task_id=? AND project_id=?')
          .get(id,tenantId,principal,taskId,projectId);
        if(!receipt||seenReceipts.has(id)) continue;
        seenReceipts.add(id); hasReceipt=true;
        observations.push({...call,receipt,args:{use_observation:JSON.parse(receipt.observation_json)}});
      }
      if(!hasReceipt&&call.name==='orgbrain_memory_observe'&&call.output?.accepted===true&&call.args?.use_observation) observations.push(call);
    }
    let queued=0,recorded=0; const rejected=[];
    for(const call of observations.slice(0,3)) {
      try {
        if(call.receipt&&call.receipt.expires_at<=Date.now()&&!call.receipt.context_id) throw new Error('use_receipt_expired');
        const input=observeMemoryUse(call.args.use_observation).observation;
        if(input.task_id!==taskId||input.project_id!==projectId) throw new Error('use_task_mismatch');
        const item=db.prepare(`SELECT i.*,e.trace_id,e.capability FROM memory_usage_items i JOIN memory_usage_events e ON e.id=i.usage_event_id AND e.tenant_id=i.tenant_id
          WHERE e.tenant_id=? AND e.actor_principal=? AND e.project_id=? AND e.task_id=? AND e.id=? AND i.id=?`)
          .get(tenantId,principal,projectId,taskId,input.usage_id,input.usage_item_id);
        if(!item||item.source_id!==input.source_id||item.source_version!==input.source_version) throw new Error('use_receipt_scope_mismatch');
        let retrieval=calls.find(c=>c.done&&c.order<call.order&&/orgbrain_(?:memory_search|memories_search|memory_retrieve_context|memories_retrieve_context|context_enrich)$/.test(c.name)
          &&c.output?.meta?.usage_id===input.usage_id&&c.output?.meta?.usage_item_ids?.includes(input.usage_item_id)
          &&c.args?.project_id===projectId&&c.args?.task_id===taskId);
        if(!retrieval&&call.receipt) {
          for(const candidate of calls.filter(c=>c.done&&c.output_order<call.order)) {
            const output=resultObjects(candidate.outputs??candidate.output).find(o=>o.meta?.usage_id===input.usage_id
              &&usageItems(o.meta?.usage_items).some(x=>x.usage_item_id===input.usage_item_id&&x.source_id===input.source_id&&x.source_version===input.source_version));
            if(output) {retrieval={...candidate,output};break;}
          }
        }
        if(!retrieval&&item.capability==='hook_context'&&item.reference_type==='injected') {
          const delivered=injections.find(i=>i.task_id===taskId&&i.project_id===projectId&&i.usage_id===input.usage_id
            &&i.items.some(x=>x.usage_item_id===input.usage_item_id&&x.source_id===input.source_id&&x.source_version===input.source_version));
          if(delivered) retrieval={order:delivered.order,output_order:delivered.order,output:{results:[{id:item.source_id,current_version:item.source_version}]}};
        }
        if(!retrieval) throw new Error('use_retrieval_not_observed');
        if(retrieval.output?.meta?.usage_items && !usageItems(retrieval.output.meta.usage_items).some(x=>x.usage_item_id===input.usage_item_id&&x.source_id===input.source_id&&x.source_version===input.source_version)) throw new Error('use_retrieval_item_mismatch');
        const results=retrieval.output.results??[];
        if(!results.some(x=>(x.memory?.id??x.id)===input.source_id&&(x.memory?.current_version??x.current_version)===input.source_version)
          &&!usageItems(retrieval.output?.meta?.usage_items).some(x=>x.usage_item_id===input.usage_item_id&&x.source_id===input.source_id&&x.source_version===input.source_version)) throw new Error('use_version_not_observed');
        const action=calls.find(c=>c.id===input.action_call_id&&c.order>(retrieval.output_order??retrieval.order)&&c.output_order<call.order&&c.done&&!c.name.startsWith('orgbrain_memory_observe'));
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
        const id=await useHash({tenantId,taskId,call:call.receipt?.id??call.id,input});
        const payload={id,usage_item_id:input.usage_item_id,project_id:projectId,task_id:taskId,work_type:input.work_type??'unknown',context:input.context,evidence};
        const localItem=db.prepare('SELECT id FROM memory_usage_items WHERE tenant_id=? AND id=?').get(tenantId,input.usage_item_id);
        if(localItem) {
          const service=localUseService(db,tenantId,principal);
          const result=await service.record(payload);
          if(result.verification_state!=='verified') throw new Error('use_evidence_not_verified');
          recorded++;
          if(call.receipt) db.prepare('UPDATE local_use_observation_receipts SET context_id=?,rejection_reason=NULL WHERE id=?').run(id,call.receipt.id);
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
      } catch(error) {
        rejected.push(error.message);
        if(call.receipt) db.prepare('UPDATE local_use_observation_receipts SET rejection_reason=? WHERE id=? AND context_id IS NULL').run(error.message,call.receipt.id);
      }
    }
    return {queued,recorded,rejected};
  } finally {db.close();}
}

export const MEMORY_USE_OBSERVE_HINT = 'When a retrieved memory actually informs an action, call orgbrain_memory_observe with schema_version=2, lesson_type="success", and use_observation containing the returned usage_id, matching usage_item_id, source_id, source_version, project_id, task_id, work_type, context {task,target,constraints,conditions}, action_call_id and optional outcome_call_id. Use actual current-turn call IDs (for example call_...), never tool names. For wrapped calls use the outer executed call ID and print the returned use_receipt in tool output. If IDs or evidence are unavailable, leave use unassessed. Do not rate usefulness or infer success. Do not emit an observation for mere citation. Set usage_purpose to task, audit, diagnostic or test on search/context calls.';

export { observeMemoryUse };
