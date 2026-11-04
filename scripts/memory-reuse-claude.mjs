import {open,readFile,writeFile,mkdir,copyFile,realpath,appendFile,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {LocalMemoryStore,DEFAULT_LOCAL_DB} from '../packages/orgbrain-cli/src/lib/local-memory-store.mjs';
import {MemoryReuse,recordReuseAction,REUSE_CHANNELS,reuseContentAllowed,reuseDigest} from '../packages/orgbrain-cli/src/lib/memory-reuse.mjs';
import {connectProjectKnowledge,connectedTargets,normalizeClaudeTurn,mergeReuseHooks,reuseControlCall,operationKey,toolObject,beginClaudeJournal,recordClaudeContext,appendClaudeJournal,readClaudeJournal,readClaudeVisible,clearClaudeVisible} from '../packages/orgbrain-cli/src/lib/memory-reuse-claude.mjs';
import {constants} from 'node:fs';
import {collectMemoryUse} from '../packages/orgbrain-cli/src/lib/memory-use-collector.mjs';
import {runBundledAction,confirmBundledAction,bundledAttributions} from '../packages/orgbrain-cli/src/lib/memory-reuse-bundled.mjs';
import {createHash} from 'node:crypto';
import {primeFreshness,checkFreshness} from '../packages/orgbrain-cli/src/lib/memory-reuse-freshness.mjs';
import {sourceContextStatus,resolveActionSource,taskInput} from '../packages/orgbrain-cli/src/lib/memory-reuse-resolution.mjs';
import {findResult,confirmResultApplications} from '../packages/orgbrain-cli/src/lib/memory-reuse-results.mjs';
import {beginTaskConfirmation,preTaskConfirmation,postTaskQuestion,taskCompletion,taskSectionRequest} from '../packages/orgbrain-cli/src/lib/memory-reuse-task-confirmation.mjs';
import {appendWorkObservation,readSessionUsage} from '../packages/orgbrain-cli/src/lib/memory-task-observation.mjs';
import {loadTaskRuntimeConfig} from '../packages/orgbrain-cli/src/lib/memory-task-runtime-config.mjs';

const root=await realpath(resolve(process.env.ORGBRAIN_REUSE_ROOT||fileURLToPath(new URL('..',import.meta.url)))),[command,raw]=process.argv.slice(2);
const configPath=join(root,'.local/memory-reuse/config.json');
const load=async p=>JSON.parse(await readFile(p,'utf8'));
const emit=v=>process.stdout.write(JSON.stringify(v)+'\n');
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const commandQuote=s=>/^[\w./:-]+$/u.test(s)?s:quote(s);
if(command==='install') {
  let previous={};try{previous=await load(configPath);}catch(error){if(error.code!=='ENOENT')throw error;}
  const report=await load(join(root,'artifacts/memory-reuse-loop-20261026/report.json'));
  const flags=Object.fromEntries(REUSE_CHANNELS.map(c=>[c,report.stages[c]?.adopted===true]));
  await mkdir(join(root,'.local/memory-reuse'),{recursive:true,mode:0o700});
  const path=join(root,'.claude/settings.local.json');let settings={};
  try{settings=await load(path);try{await copyFile(path,join(root,'.local/memory-reuse/settings.before.json'),constants.COPYFILE_EXCL);}catch(e){if(e.code!=='EEXIST')throw e;}}catch(e){if(e.code!=='ENOENT')throw e;}
  const prefix=[process.execPath,fileURLToPath(import.meta.url)].map(commandQuote).join(' ');
  await mkdir(join(root,'.claude'),{recursive:true});await mkdir(join(root,'.local/memory-reuse'),{recursive:true,mode:0o700});
  await writeFile(path,JSON.stringify(mergeReuseHooks(settings,prefix,{bundled:previous.tracking_mode==='bundled',taskConfirmation:previous.task_confirmation_mode==='ask'&&Object.keys(previous.task_workflows??{}).length>0}),null,2)+'\n');
  await writeFile(configPath,JSON.stringify({...previous,version:1,tenant_id:previous.tenant_id??'default',project_id:previous.project_id??'org-brain',db_path:previous.db_path??DEFAULT_LOCAL_DB,flags,
    tracking:'native Claude tool calls and explicit attribution; Stop verifies each use',automatic_source_index:'verified file references and pinned source-to-target bindings',natural_observation_state:previous.natural_observation_state??'pending'},null,2)+'\n',{mode:0o600});
  emit({installed:true,flags,scope:'project',natural_observation_state:'pending'});
} else {
  let config;try{config=await loadTaskRuntimeConfig(root);}catch(e){if(e.code==='ENOENT'){emit({});process.exit(0);}throw e;}
  process.env.ORGBRAIN_USE_COLLECT='on';process.env.ORGBRAIN_USE_SYNC='off';
  const store=new LocalMemoryStore(config.db_path,{denseEmbeddingProvider:null,memoryJudge:null,relevanceSelector:null});
  const scope={tenant_id:config.tenant_id,project_id:config.project_id,principal_id:process.env.ORGBRAIN_USE_PRINCIPAL||'local',work_type:'implementation'};
  const reuse=new MemoryReuse(store,scope);
  if(config.delivery_mode&&!['lookup','inline'].includes(config.delivery_mode))throw Error('invalid_delivery_mode');
  if(config.tracking_mode&&!['standalone','bundled'].includes(config.tracking_mode))throw Error('invalid_tracking_mode');
  if(config.tracking_mode==='bundled'&&config.delivery_mode!=='inline')throw Error('bundled_tracking_requires_inline');
  if(config.freshness_mode&&!['off','validated'].includes(config.freshness_mode))throw Error('invalid_freshness_mode');
  if(config.source_resolution&&!['off','verified'].includes(config.source_resolution))throw Error('invalid_source_resolution');
  if(config.result_mode&&!['off','validated'].includes(config.result_mode))throw Error('invalid_result_mode');
  if(config.task_confirmation_mode&&!['off','ask'].includes(config.task_confirmation_mode))throw Error('invalid_task_confirmation_mode');
  const recall=async input=>{
    if(!input.task_id)throw Error('task_identity_required');
    if(input.task_id.startsWith('claude:'))input.visible_versions=[...(input.visible_versions??[]),...await readClaudeVisible(join(root,'.local/memory-reuse/native-evidence'),input.task_id.slice(7))];
    const channels=input.channel?[input.channel]:['result','procedure','changes','object','operation','recent'];
    let result={references:[],items:[],context:'',meta:{usage_items:[]}};
    for(const channel of channels){
      if(!config.flags[channel])continue;
      result=await reuse.recall({...input,channel,flags:config.flags,usage_purpose:config.observation_purpose==='test'?'test':'task'});
      if(result.references.length)break;
    }
    if(!reuseContentAllowed(result.context))throw Error('sensitive_reuse_context_denied');
    return result;
  };
  if(command==='connect') {
    const result=await connectProjectKnowledge(reuse,root,config.bindings??[]);
    await writeFile(join(root,'.local/memory-reuse/connection.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});emit(result);
  } else if(command==='link') {
    emit(await reuse.link(JSON.parse(raw)));
  } else if(command==='procedure') {
    if(!config.flags.procedure)throw Error('procedure_feature_not_adopted');
    emit(await reuse.createArtifact({...JSON.parse(raw),kind:'procedure'}));
  } else if(command==='status') {
    const db=await reuse.open();
    try{emit({flags:config.flags,links:db.prepare('SELECT count(*) AS n FROM memory_reuse_links WHERE tenant_id=? AND project_id=?').get(scope.tenant_id,scope.project_id).n,
      verified_claude_knowledge_task_pairs:db.prepare(`SELECT count(*) AS n FROM(SELECT DISTINCT source_id,task_id FROM memory_use_contexts WHERE tenant_id=? AND project_id=? AND principal=? AND task_id LIKE 'claude:%' AND verification_state='verified' AND revoked_at IS NULL)`).get(scope.tenant_id,scope.project_id,scope.principal_id).n});}finally{db.close();}
  } else if(command==='recall') {
    emit(await recall(JSON.parse(raw)));
  } else if(command==='prime'||command==='check') {
    const input=JSON.parse(raw);
    emit(await (command==='prime'?primeFreshness:checkFreshness)({root,reuse,config,profile_id:input.profile_id,input:input.input}));
  } else if(command==='resolve') {
    emit(await resolveActionSource({root,reuse,config,request:JSON.parse(raw),rawRequest:raw}));
  } else if(command==='run') {
    emit(await runBundledAction({root,reuse,config,request:JSON.parse(raw),rawRequest:raw}));
  } else if(command==='task') {
    const raw_stdin=await new Promise((resolve,reject)=>{let s='';process.stdin.on('data',c=>{s+=c;if(Buffer.byteLength(s)>65536)reject(Error('task_sections_too_large'));});process.stdin.on('end',()=>resolve(s));});
    const request=await taskSectionRequest({root,reuse,config,session_id:raw,sections:JSON.parse(raw_stdin)});
    emit(await runBundledAction({root,reuse,config,request,rawRequest:JSON.stringify(request),requestProtocol:{kind:'task_sections_stdin',raw_stdin}}));
  } else if(command==='report') {
    const signal=JSON.parse(raw);const db=await reuse.open();let row;
    try{row=db.prepare(`SELECT e.task_id FROM memory_usage_events e JOIN memory_usage_items i ON i.usage_event_id=e.id AND i.tenant_id=e.tenant_id
      WHERE i.id=? AND e.tenant_id=? AND e.project_id=? AND e.actor_principal=?`).get(signal.usage_item_id,scope.tenant_id,scope.project_id,scope.principal_id);}finally{db.close();}
    if(!row)throw Error('reference_not_delivered');
    emit(await reuse.reportUse(signal,row.task_id,{task:'current Claude project task',target:'explicitly selected project object',constraints:'current source and native action scope',conditions:'current source version and permissions'}));
  } else {
    const input=JSON.parse(await new Promise(resolve=>{let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>resolve(s));}));
    if(await realpath(input.cwd||root)!==root){emit({});process.exit(0);}
    const taskId='claude:'+String(input.session_id||'');if(taskId==='claude:'){emit({});process.exit(0);}
    const journal=join(root,'.local/memory-reuse/native-evidence');
    const helperPrefix=[process.execPath,fileURLToPath(import.meta.url)].map(commandQuote).join(' ');
    if(command==='pre') {
      try{emit(await preTaskConfirmation({root,reuse,config,input,prefix:helperPrefix}));}
      catch(error){emit({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'Task confirmation unavailable: '+error.message}});}
    } else if(command==='compact') {
      await clearClaudeVisible(journal,input.session_id);emit({});
    } else if(command==='context') {
      await beginClaudeJournal(journal,input.session_id);
      const task=await beginTaskConfirmation({root,reuse,config,input,prefix:helperPrefix});
      if(task?.state.local){
        const path=join(journal,createHash('sha256').update(input.session_id).digest('hex')+'.jsonl');
        await appendFile(path,JSON.stringify({payload:{type:'host_task_context',task_id:task.state.task_id,local_confirmation_id:task.state.local.decision?.id??null,source_receipt_id:task.state.local.source.id,source_receipt_digest:task.state.local.source.digest,delivered_context_digest:task.state.local.delivered_digest,source_delivery:task.state.local.source_delivery,source_envelope_digest:task.state.local.source_envelope_digest,route:'host_context'}})+'\n',{mode:0o600});
      }
      if(task){emit({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:task.additionalContext}});process.exit(0);}
      if(!Object.values(config.flags).some(Boolean)){emit({});process.exit(0);}
      const connection=await connectProjectKnowledge(reuse,root,config.bindings??[]),files=connectedTargets(input.prompt,root,connection);
      const db2=await reuse.open();let linked;
      try{linked=files.map(file=>({file,refs:db2.prepare('SELECT source_id,source_version FROM memory_reuse_links WHERE tenant_id=? AND project_id=? AND object_type_key=? AND object_id=?').all(scope.tenant_id,scope.project_id,'file',file)}));}finally{db2.close();}
      const targets=[];
      for(const {file,refs} of linked)for(const ref of refs){
        try{if((await reuse.detail(ref)).verification_state==='verified'){targets.push(file);break;}}
        catch(error){if(!['memory_detail_unavailable','reuse_source_conflicted','sensitive_reuse_source_denied'].includes(error.message))throw error;}
      }
      if(!targets.length){emit({});process.exit(0);}
      if(config.delivery_mode==='inline') {
        const resultAdapter=Object.entries(config.action_adapters??{}).find(([,a])=>a.object_type_key==='file'&&a.object_id===targets[0]);
        if(config.result_mode==='validated'&&resultAdapter&&taskInput(input.prompt)&&reuseDigest(taskInput(input.prompt))===reuseDigest(resultAdapter[1].conditions)){
          const prior=await findResult({root,reuse,config,action:resultAdapter[1]});
          if(prior){
            const path=join(journal,createHash('sha256').update(input.session_id).digest('hex')+'.jsonl'),line=JSON.stringify({payload:{type:'host_result_offer',task_id:taskId,adapter:resultAdapter[0],artifact_id:prior.artifact_id}})+'\n';
            if((await stat(path)).size+Buffer.byteLength(line)>4*1024*1024)throw Error('native_hook_evidence_limit');await appendFile(path,line,{mode:0o600});
            const request={task_id:taskId,adapter:resultAdapter[0],result_id:prior.artifact_id,uses:[],freshness_profile:resultAdapter[1].freshness_profile};
            emit({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:'Source status: validated_result_available. A completed prior result matches the exact task input, current source, implementation, environment, permissions and expiry. To apply it without regenerating a plan, execute '+[process.execPath,fileURLToPath(import.meta.url),'run'].map(commandQuote).join(' ')+' '+quote(JSON.stringify(request))+'. Native completion and Stop verify this derived application separately from reading an original. Resolve current source if validation fails.'}});process.exit(0);
          }
        }
        const result=await recall({object_type_key:'file',object_id:targets[0],task_id:taskId});
        if(!result.context){emit({});process.exit(0);}
        await recordClaudeContext(journal,input.session_id,result);
        const report=[process.execPath,fileURLToPath(import.meta.url),'report'].map(commandQuote).join(' ');
        const adapter=Object.entries(config.action_adapters??{}).find(([,a])=>a.object_type_key==='file'&&a.object_id===targets[0]);
        const bundled=config.tracking_mode==='bundled'&&adapter;
        const freshness=bundled&&config.freshness_mode==='validated'&&adapter[1].freshness_profile;
        const sourceStatus=adapter&&config.source_resolution==='verified'?await sourceContextStatus({root,reuse,config,adapter_key:adapter[0],references:result.references,prompt:input.prompt}):{current:false};
        if(sourceStatus.current){
          const path=join(journal,createHash('sha256').update(input.session_id).digest('hex')+'.jsonl');
          const line=JSON.stringify({verified_source_context:{task_id:taskId,adapter:adapter[0],input:taskInput(input.prompt),source_refs:sourceStatus.source_refs}})+'\n';
          if((await stat(path)).size+Buffer.byteLength(line)>4*1024*1024)throw Error('native_hook_evidence_limit');
          await appendFile(path,line,{mode:0o600});
        }
        const instruction=bundled?'If a reference informs your action, select its usage_item_id in uses when executing '+
          [process.execPath,fileURLToPath(import.meta.url),'run'].map(commandQuote).join(' ')+' '+quote(JSON.stringify({task_id:taskId,adapter:adapter[0],input:{op:adapter[1].operations[0]},uses:[result.items[0].usage_item_id],...(freshness?{freshness_profile:freshness}:{})}))+
          '. Supply the full action input yourself; uses=[] means no attribution. Use one exact invocation with a single-quoted JSON argument. Native completion verifies the selected attribution.':
          'If a reference informs a completed task action, report once with '+report+' '+quote(JSON.stringify({used:true,usage_item_id:result.items[0].usage_item_id,action_call_id:'ACTUAL_ACTION_ID'}))+'. Use the native action ID from PostToolUse. Retrieval alone is not use. Print use_receipt.';
        const freshnessInstruction=freshness&&config.source_resolution!=='verified'?' A prior successful local validator established this input, source and environment. The run command rechecks all dependencies, current source versions and permissions before execution. You may generate the plan from the provided original without repeating index/read. If freshness validation fails, investigate the current source and omit the freshness profile on the next action.':'';
        const sourceInstruction=sourceStatus.current?' Source status: current_for_exact_input. The complete original above covers the declared task constraints. Generate the action directly from it. Resolve only after a freshness mismatch or if additional information is required.':'';
        emit({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:(sourceStatus.current?'Current task reference; preserve every declared constraint.\n':'Prior reference; check applicability and preserve its conditions.\n')+result.context+instruction+freshnessInstruction+sourceInstruction}});
        process.exit(0);
      }
      const prefix=[process.execPath,fileURLToPath(import.meta.url),'recall'].map(commandQuote).join(' ');
      const requests=targets.map(file=>({object_type_key:'file',object_id:file,task_id:taskId}));
      emit({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:'Related project knowledge is available for these explicit files. When prior constraints or procedures are needed, consult it before acting with '+prefix+' '+quote(JSON.stringify(requests[0]))+'. Choose relevant references and verify applicability; a lookup is not use. If a reference informs a later action, report it using the native call ID from PostToolUse.'}});
    } else if(command==='post') {
      await appendClaudeJournal(journal,input);
      const question=await postTaskQuestion({root,reuse,config,input,prefix:helperPrefix});
      if(question){emit({hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:question.additionalContext}});process.exit(0);}
      if(reuseControlCall(input)){emit({});process.exit(0);}
      const result=input.tool_response??{};
      await recordReuseAction(store,scope,{call_id:input.tool_use_id,task_id:taskId,completed:input.hook_event_name!=='PostToolUseFailure',ok:!result.is_error&&(result.exit_code===0||result.exitCode===0||result.ok===true),args:input.tool_input,result});
      const bundled=await confirmBundledAction({root,reuse,config,input,prefix:[process.execPath,fileURLToPath(import.meta.url)].map(commandQuote).join(' '),
        journal:join(journal,createHash('sha256').update(input.session_id).digest('hex')+'.jsonl')});
      if(bundled!==null){emit(bundled.length?{hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:'use_receipt: '+bundled.join(',')+'. Attribution pending Stop verification.'}}:{});process.exit(0);}
      const db=await reuse.open();let items;
      let operationHint='';
      try{items=db.prepare(`SELECT i.id AS usage_item_id,i.source_id,i.source_version FROM memory_usage_items i JOIN memory_usage_events e ON e.id=i.usage_event_id AND e.tenant_id=i.tenant_id
        WHERE e.tenant_id=? AND e.project_id=? AND e.actor_principal=? AND e.task_id=?
        AND NOT EXISTS(SELECT 1 FROM local_use_observation_receipts r WHERE r.tenant_id=i.tenant_id AND r.usage_item_id=i.id AND r.principal=e.actor_principal)
        ORDER BY e.created_at DESC LIMIT 3`).all(scope.tenant_id,scope.project_id,scope.principal_id,taskId);}finally{db.close();}
      const operation=operationKey(input),object=toolObject(input,root);
      if(config.flags.operation&&operation&&object) {
        const lookup=await reuse.open();let link;
        try{link=lookup.prepare(`SELECT 1 FROM memory_reuse_links WHERE tenant_id=? AND project_id=? AND object_type_key=? AND object_id=? AND operation=?`)
          .get(scope.tenant_id,scope.project_id,object.object_type_key,object.object_id,operation);}finally{lookup.close();}
        if(link)operationHint='Knowledge for this same operation and object is available before a follow-up action: '+[process.execPath,fileURLToPath(import.meta.url),'recall'].map(commandQuote).join(' ')+' '+quote(JSON.stringify({...object,task_id:taskId,channel:'operation',operation}))+'. ';
      }
      if(!items.length){emit(operationHint?{hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:operationHint}}:{});process.exit(0);}
      if(config.delivery_mode==='inline') {
        emit({hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:'Action ID: '+input.tool_use_id+'. Report only if a provided reference informed this completed action; otherwise omit.'}});
        process.exit(0);
      }
      const prefix=[process.execPath,fileURLToPath(import.meta.url),'report'].map(commandQuote).join(' ');
      const commands=items.map(item=>`${item.source_id}@${item.source_version}: ${prefix} ${quote(JSON.stringify({used:true,usage_item_id:item.usage_item_id,action_call_id:input.tool_use_id}))}`).join('\n');
      emit({hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:operationHint+'If a retrieved reference actually informed this completed action, choose its matching command below. Each command takes one JSON object. Print use_receipt. Otherwise omit reporting; delivery is not use or benefit.\n'+commands}});
    } else if(command==='stop') {
      try {
      let normalized,evidenceSource='native_transcript',file;
      try{file=config.delivery_mode!=='inline'&&input.transcript_path?await open(input.transcript_path,'r'):null;}catch(error){if(error.code!=='ENOENT')throw error;}
      if(!file){normalized=await readClaudeJournal(journal,input.session_id);evidenceSource=config.delivery_mode==='inline'?'native_post_tool_use_with_hook_context':'native_post_tool_use';}
      else {
      let contents;
      try{const size=(await file.stat()).size,start=Math.max(0,size-4*1024*1024),buffer=Buffer.alloc(size-start);await file.read(buffer,0,buffer.length,start);contents=buffer.toString('utf8');if(start>0)contents=contents.slice(contents.indexOf('\n')+1);}finally{await file.close();}
      const native=contents.split('\n').filter(Boolean).map(line=>JSON.parse(line));
      normalized=normalizeClaudeTurn(native,input.session_id);
      }
      const status=await store.useHistory('status');
      if(!status.flags.collect){emit({});process.exit(0);}
      const attributions=config.tracking_mode==='bundled'?await bundledAttributions({root,reuse,config,rows:normalized}):[];
      const derived_applications=config.result_mode==='validated'?await confirmResultApplications({root,reuse,config,rows:normalized}):[];
      const task_completion=await taskCompletion({root,reuse,config,session_id:input.session_id});
      if(task_completion&&config.task_observation_mode==='on')await appendWorkObservation(root,{session_id:input.session_id,event:'stop_verified',purpose:config.observation_purpose==='test'?'test':'task',completion:task_completion,usage:await readSessionUsage(input.transcript_path,input.session_id)});
      const collection=await collectMemoryUse(store,{tenantId:scope.tenant_id,projectId:scope.project_id,principal:scope.principal_id,taskId,turnId:input.session_id,rows:normalized,attributions});
      if(collection.recorded>0) {
        const db=await reuse.open();let observations;
        try{observations=db.prepare(`SELECT observation_json FROM local_use_observation_receipts WHERE tenant_id=? AND project_id=? AND principal=? AND task_id=? AND context_id IS NOT NULL`)
          .all(scope.tenant_id,scope.project_id,scope.principal_id,taskId);}finally{db.close();}
        for(const row of observations) {
          const use=JSON.parse(row.observation_json),call=normalized.find(r=>r.payload?.type==='function_call'&&r.payload.call_id===use.action_call_id)?.payload;
          if(!call)continue;
          const native={tool_name:call.name,tool_input:JSON.parse(call.arguments)},operation=operationKey(native),object=toolObject(native,root);
          if(operation&&object)await reuse.link({...object,source_id:use.source_id,source_version:use.source_version,operation});
        }
      }
      await writeFile(join(root,'.local/memory-reuse/last-observation.json'),JSON.stringify({collection,derived_applications,task_completion,evidence_source:evidenceSource,natural:config.observation_purpose!=='test',scope:'project'},null,2)+'\n',{mode:0o600});
      emit({});
      } catch(error) {
        await writeFile(join(root,'.local/memory-reuse/last-observation.json'),JSON.stringify({observation_state:'unavailable',collection:{recorded:null},
          error:{name:error.name,code:error.code??null,message:error.message},native_input_keys:Object.keys(input),transcript_path:input.transcript_path??null,
          natural:config.observation_purpose!=='test'},null,2)+'\n',{mode:0o600});
        throw error;
      }
    } else throw Error('unknown_reuse_command');
  }
}
