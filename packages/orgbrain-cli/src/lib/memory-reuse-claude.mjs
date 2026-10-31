import {isAbsolute,relative,resolve,basename} from 'node:path';
import {mkdir,writeFile,appendFile,readFile,stat,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {reuseContentAllowed} from './memory-reuse.mjs';
const journalPath=(dir,session)=>resolve(dir,createHash('sha256').update(session).digest('hex')+'.jsonl');
export async function connectProjectKnowledge(reuse,root,bindings=[]) {
  root=await realpath(root);
  const started=performance.now(),db=await reuse.open(),s=reuse.scope;let candidates;
  try{candidates=db.prepare(`SELECT id,current_version,source_refs_json,updated_at FROM memories
    WHERE tenant_id=? AND project_id=? AND lifecycle_state='active' AND verification_state='verified'
    ORDER BY updated_at DESC,id LIMIT 200`).all(s.tenant_id,s.project_id);}finally{db.close();}
  const connected=[],skipped=[];
  for(const candidate of candidates){
    const refs=JSON.parse(candidate.source_refs_json||'[]');
    const explicit=bindings.filter(b=>b.source_id===candidate.id);
    const direct=refs.filter(ref=>typeof ref.ref==='string'&&!/^[\w-]+:/u.test(ref.ref)).map(ref=>({source_id:candidate.id,source_version:candidate.current_version,
      source_ref:ref.ref,targets:[ref.ref.replace(/#.*$/u,'').replace(/:\d+(?:-\d+)?$/u,'')],phrases:[]}));
    for(const binding of [...direct,...explicit]){
      if(binding.source_version!==candidate.current_version||!refs.some(ref=>ref.ref===binding.source_ref)){
        skipped.push({source_id:candidate.id,reason:'binding_source_changed'});continue;
      }
      for(const target of binding.targets??[]){
        if(typeof target!=='string'||isAbsolute(target)||target.split('/').includes('..')){skipped.push({source_id:candidate.id,reason:'target_outside_project'});continue;}
        const path=resolve(root,target),file=relative(root,path);let canonical;
        try{canonical=await realpath(path);}catch(error){if(error.code==='ENOENT'){skipped.push({source_id:candidate.id,reason:'target_missing'});continue;}throw error;}
        if(!canonical.startsWith(root+'/')||!(await stat(canonical)).isFile()){skipped.push({source_id:candidate.id,reason:'target_outside_project'});continue;}
        try{await reuse.link({source_id:candidate.id,source_version:candidate.current_version,object_type_key:'file',object_id:file,updated_at:candidate.updated_at});}
        catch(error){if(['memory_detail_unavailable','reuse_source_conflicted','sensitive_reuse_source_denied'].includes(error.message)){
          skipped.push({source_id:candidate.id,reason:error.message});continue;}throw error;}
        connected.push({source_id:candidate.id,source_version:candidate.current_version,source_ref:binding.source_ref,target:file,phrases:binding.phrases??[]});
      }
    }
  }
  return {connected,skipped,elapsed_ms:performance.now()-started,model_calls:0};
}
export function connectedTargets(prompt,root,connection) {
  const text=String(prompt),files=targetsFromPrompt(text,root);
  for(const entry of connection.connected)for(const phrase of entry.phrases){
    if(typeof phrase!=='string'||phrase.length<4)continue;
    const at=text.toLowerCase().indexOf(phrase.toLowerCase());if(at<0)continue;
    if(/[a-z0-9_]$/iu.test(phrase)&&/[a-z0-9_]/iu.test(text[at+phrase.length]??''))continue;
    if(/^[a-z0-9_]/iu.test(phrase)&&/[a-z0-9_]/iu.test(text[at-1]??''))continue;
    if(!files.includes(entry.target))files.push(entry.target);
  }
  return files.slice(0,3);
}
export async function beginClaudeJournal(dir,session) {
  await mkdir(dir,{recursive:true,mode:0o700});
  await writeFile(journalPath(dir,session),'',{mode:0o600});
}
export async function recordClaudeContext(dir,session,result) {
  if(!result.context||!result.meta?.usage_id||!reuseContentAllowed(result.context))throw Error('invalid_hook_context');
  const row={payload:{type:'message',role:'developer',content:result.context},hook_context_references:result.references};
  const path=journalPath(dir,session),text=JSON.stringify(row)+'\n';
  if((await stat(path)).size+Buffer.byteLength(text)>4*1024*1024)throw Error('native_hook_evidence_limit');
  await appendFile(path,text,{mode:0o600});
}
export async function appendClaudeJournal(dir,input) {
  if(!input.session_id||!input.tool_use_id)throw Error('native_hook_identity_missing');
  const result=input.tool_response??{},failed=input.hook_event_name==='PostToolUseFailure'||result.is_error||result.exitCode>0||result.exit_code>0;
  const output=typeof result.stdout==='string'?result.stdout:JSON.stringify(result);
  const rows=[{payload:{type:'function_call',call_id:input.tool_use_id,name:input.tool_name,arguments:JSON.stringify(input.tool_input)}},
    {payload:{type:'function_call_output',call_id:input.tool_use_id,output:failed?JSON.stringify({isError:true,content:output}):output}}];
  const text=rows.map(row=>JSON.stringify(row)).join('\n')+'\n',path=journalPath(dir,input.session_id);
  if(!reuseContentAllowed(text))throw Error('sensitive_native_evidence_omitted');
  if((await stat(path)).size+Buffer.byteLength(text)>4*1024*1024)throw Error('native_hook_evidence_limit');
  await appendFile(path,text,{mode:0o600});
  const injected=(await readClaudeJournal(dir,input.session_id)).flatMap(row=>row.hook_context_references??[]);
  if(injected.length){
    const visible=await readClaudeVisible(dir,input.session_id);
    for(const ref of injected)if(!visible.some(v=>v.source_id===ref.source_id&&v.source_version===ref.source_version))visible.push(ref);
    await writeFile(path+'.visible.json',JSON.stringify(visible),{mode:0o600});
  }
  if(!failed&&reuseControlCall(input)&&/\srecall\b/u.test(input.tool_input.command)) {
    const response=JSON.parse(output),visible=await readClaudeVisible(dir,input.session_id);
    for(const ref of response.references??[])if(response.meta?.usage_items?.some(item=>item.source_id===ref.source_id&&item.source_version===ref.source_version)
      &&!visible.some(item=>item.source_id===ref.source_id&&item.source_version===ref.source_version))visible.push(ref);
    await writeFile(path+'.visible.json',JSON.stringify(visible),{mode:0o600});
  }
}
export async function readClaudeVisible(dir,session) {
  try{return JSON.parse(await readFile(journalPath(dir,session)+'.visible.json','utf8'));}catch(error){if(error.code==='ENOENT')return [];throw error;}
}
export async function clearClaudeVisible(dir,session) {
  await mkdir(dir,{recursive:true,mode:0o700});
  await writeFile(journalPath(dir,session)+'.visible.json','[]',{mode:0o600});
}
export async function readClaudeJournal(dir,session) {
  const path=journalPath(dir,session);
  if((await stat(path)).size>4*1024*1024)throw Error('native_hook_evidence_limit');
  return (await readFile(path,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));
}
export function operationKey(input) {
  if(['Read','Write','Edit'].includes(input.tool_name))return input.tool_name;
  if(input.tool_name!=='Bash')return null;
  const match=(input.tool_input?.command??'').match(/^\s*([\w./-]+)\s+(--test|test|check|run|status|diff|build|lint)(?:\s|$)/u);
  return match?`Bash:${basename(match[1])}:${match[2]}`:null;
}
export function toolObject(input,root) {
  const path=input.tool_input?.file_path??input.tool_input?.path;
  const file=typeof path==='string'?relative(root,resolve(root,path)):targetsFromPrompt(input.tool_input?.command??'',root)[0];
  return file&&!file.startsWith('..')&&!isAbsolute(file)?{object_type_key:'file',object_id:file}:null;
}
export function reuseControlCall(input) {
  return input.tool_name==='Bash'&&/memory-reuse-claude\.mjs['"]?\s+(?:recall|report|resolve)\b/u.test(input.tool_input?.command??'');
}

export function targetsFromPrompt(prompt,root) {
  const files=[];
  for(const match of String(prompt).matchAll(/(?:^|[\s`('"])\b([\w./-]+\.(?:mjs|cjs|js|ts|tsx|jsx|md|py|json|yaml|yml|txt))(?=$|[\s`'"),:;!?。をのにで]|\.(?=\s|$))/gu)) {
    const p=match[1],rel=relative(root,resolve(root,p));
    if(isAbsolute(p)||rel.startsWith('..')||p.split('/').includes('..'))continue;
    if(!files.includes(rel))files.push(rel);
  }
  return files.slice(0,3);
}
export function normalizeClaudeTurn(native,sessionId) {
  const eligible=native.filter(e=>['user','assistant'].includes(e.type)&&!e.isSidechain&&!e.agentId
    &&(!e.sessionId||e.sessionId===sessionId)&&(!e.session_id||e.session_id===sessionId));
  const start=eligible.findLastIndex(e=>e.type==='user'&&(typeof e.message?.content==='string'
    ||Array.isArray(e.message?.content)&&e.message.content.some(b=>b.type==='text')));
  if(start<0)return [];
  return eligible.slice(start).flatMap(e=>(Array.isArray(e.message?.content)?e.message.content:[]).flatMap(b=>{
    if(b.type==='tool_use')return [{payload:{type:'function_call',call_id:b.id,name:b.name,arguments:JSON.stringify(b.input)}}];
    if(b.type==='tool_result')return [{payload:{type:'function_call_output',call_id:b.tool_use_id,output:b.is_error?JSON.stringify({isError:true,content:b.content}):typeof b.content==='string'?b.content:JSON.stringify({content:b.content})}}];
    return [];
  }));
}
export function mergeReuseHooks(existing,prefix,{bundled=false,taskConfirmation=false}={}) {
  const result=structuredClone(existing);
  result.hooks??={};result.permissions??={};result.permissions.allow??=[];
  for(const [event,command] of [['UserPromptSubmit','context'],['PostToolUse','post'],['PreCompact','compact'],['Stop','stop']]) {
    result.hooks[event]??=[];
    const full=`${prefix} ${command}`;
    const own=result.hooks[event].flatMap(g=>g.hooks??[]).find(h=>h.command?.replaceAll("'",'')===full.replaceAll("'",''));
    if(own)own.command=full;
    else result.hooks[event].push({hooks:[{type:'command',command:full,timeout:20}]});
  }
  if(taskConfirmation){
    result.hooks.PreToolUse??=[];
    if(!result.hooks.PreToolUse.some(g=>g.hooks?.some(h=>h.command===prefix+' pre')))result.hooks.PreToolUse.push({matcher:'*',hooks:[{type:'command',command:prefix+' pre',timeout:20}]});
  }
  for(const operation of ['recall','report',...(bundled?['run',...(taskConfirmation?['task']:[])]:[])]){
    const allow=`Bash(${prefix} ${operation} *)`;
    const own=result.permissions.allow.findIndex(rule=>rule.replaceAll("'",'')===allow.replaceAll("'",''));
    if(own>=0)result.permissions.allow[own]=allow;else result.permissions.allow.push(allow);
  }
  return result;
}
