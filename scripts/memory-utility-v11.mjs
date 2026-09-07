#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {validateManifest, hash} from './memory-extraction-router-v33-core.mjs';
import {filesUnder} from './memory-learning-corpus.mjs';
import {contextWindowSourceHash} from './memory-extraction-router-context-compare.mjs';
import {buildTurnEvidenceV1} from '../packages/orgbrain-cli/src/lib/turn-evidence-v1.mjs';
import {screenSensitiveMemory} from '../packages/shared/src/memory-capture-v2-runtime.mjs';

export const POLICY = Object.freeze({version:'v1.1',seed:'memory-utility-v1',count:10,calibration_seed:'memory-utility-v1.1-calibration',calibration_count:5,model:'gpt-5.6-sol',effort:'medium',context_turns:2,ttl_days:30,top_k:5,dataset_role:'development',production_eligible:false,baseline_prompt:'frozen_v2_complete',context_policy:'common_host_memory_no_experiment_memory_in_A',execution_transport:'codex_exec_stdin_v1',retention_contract:'long_requires_target_grounded_nonempty_condition_or_reason',user_condition_amendment:'2026-09-06 user explicitly approved common background memory and complete frozen v2 prompt; v1.1 calibrates the revised C retention contract on disjoint eligible cases before the fixed ten. Exact plaintext prompts are dispatched through fresh Codex exec stdin sessions and verified from native session logs.'});
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const save = (p,v) => fs.writeFileSync(p, JSON.stringify(v,null,2)+'\n', {flag:'wx',mode:0o600});
const fail = message => {throw Error(message);};
export function seal(body) {return {...body, content_hash:hash(body)};}
export function verify(value) {const {content_hash,...body}=value; if(hash(body)!==content_hash) fail('content_hash_mismatch');return value;}

// Text blocks remain byte-for-byte intact; offsets use JavaScript UTF-16 indices.
export function rawMessages(rows) {
  const messages=[]; const seen=new Set();
  rows.forEach((r,index)=>{
    const p=r.payload??r;
    let role, blocks;
    if(p.type==='user_message') {role='user';blocks=[p.message];}
    else if(p.type==='agent_message' && ['final','final_answer'].includes(p.phase)) {role='assistant';blocks=[p.message];}
    else if(p.type==='message' && (p.role==='user'||p.role==='assistant'&&['final','final_answer'].includes(p.phase))) {
      role=p.role; blocks=typeof p.content==='string'?[p.content]:(p.content??[]).filter(b=>['input_text','output_text','text'].includes(b.type)).map(b=>b.text);
    } else return;
    blocks.forEach((text,block)=>{
      if(typeof text!=='string'||!text.trim()) return;
      const key=role+'\0'+r.timestamp+'\0'+text;
      if(seen.has(key)) return;
      seen.add(key);
      messages.push({id:`r${index+1}b${block+1}`,role,text,at:r.timestamp,row:index,block});
    });
  });
  return messages;
}
export function segments(messages,prefix) {
  return messages.flatMap(m=>[...m.text.matchAll(/[^\n]*\n|[^\n]+$/gu)].map((match,i)=>({id:`${prefix}:${m.id}:${i+1}`,message_id:m.id,role:m.role,at:m.at,start:match.index,end:match.index+match[0].length,text:match[0]})));
}
export function resolveSegments(ids, spans, targetPrefix) {
  if(!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length) fail('evidence_required');
  const resolved=ids.map(id=>spans.find(s=>s.id===id)??fail('unknown_span_id'));
  if(!resolved.some(s=>s.id.startsWith(targetPrefix+':'))) fail('target_evidence_required');
  return resolved;
}
export function selectCases(cases) {
  const groups=new Set();
  return [...cases].sort((a,b)=>digest(POLICY.seed+':'+a.id).localeCompare(digest(POLICY.seed+':'+b.id))||a.id.localeCompare(b.id)).filter(c=>{if(groups.has(c.group_id))return false;groups.add(c.group_id);return true;}).slice(0,POLICY.count);
}
export function selectCalibrationCases(cases,selected) {
  const blockedGroups=new Set(selected.map(c=>c.group_id)),groups=new Set();
  return [...cases].filter(c=>!blockedGroups.has(c.group_id)).sort((a,b)=>digest(POLICY.calibration_seed+':'+a.id).localeCompare(digest(POLICY.calibration_seed+':'+b.id))||a.id.localeCompare(b.id)).filter(c=>{if(groups.has(c.group_id))return false;groups.add(c.group_id);return true;}).slice(0,POLICY.calibration_count);
}
export function boundaryPacket(groups,index) {
  const target=rawMessages(groups[index].rows);
  const context=groups.slice(Math.max(0,index-2),index).map(g=>rawMessages(g.rows));
  let task;
  for(let j=index+1;j<groups.length&&!task;j++) task=rawMessages(groups[j].rows).find(m=>m.role==='user');
  if(!task) fail('no_following_user_request');
  const boundary=Date.parse(task.at);
  if(!Number.isFinite(boundary)||!target.length) fail('missing_time_or_target');
  for(const m of [...context.flat(),...target]) if(!Number.isFinite(Date.parse(m.at))||Date.parse(m.at)>=boundary) fail('invalid_time_boundary');
  for(const m of [...context.flat(),...target,task]) if(!screenSensitiveMemory(m.text).allowed) fail('unsafe_source');
  return {target,context,task:{text:task.text,at:task.at},boundary:task.at};
}
async function readGroups(file) {
  const before=fs.statSync(file); const groups=[];let rows=[];let meta;
  const input=fs.createReadStream(file,{encoding:'utf8'});
  for await(const line of readline.createInterface({input,crlfDelay:Infinity})) {
    if(!line.trim())continue;
    const row=JSON.parse(line);
    if(row.type==='session_meta')meta=row.payload;
    if(row.type==='turn_context') {if(rows.length)groups.push({rows});rows=[];}
    // Reasoning and tool payloads are never persisted in utility artifacts.
    rows.push(row);
  }
  if(rows.length)groups.push({rows});
  const after=fs.statSync(file);
  if(before.size!==after.size||before.mtimeMs!==after.mtimeMs)fail('session_changed_during_scan');
  return {meta,groups};
}
async function sessionIndex(roots, hashes) {
  const index=new Map();
  for(const root of roots) if(fs.existsSync(root)) for(const file of filesUnder(root)) {
    const stream=fs.createReadStream(file,{encoding:'utf8'}); const lines=readline.createInterface({input:stream,crlfDelay:Infinity});
    try {for await(const line of lines) {if(!line.trim())continue;const r=JSON.parse(line);if(r.type==='session_meta'&&typeof r.payload?.id==='string') {const h=digest(r.payload.id);if(hashes.has(h)){const files=index.get(h)??[];files.push(file);index.set(h,files);}}break;}}
    finally {lines.close();stream.destroy();}
  }
  return index;
}
export async function prepare(sourcePath,out,roots=[path.join(os.homedir(),'.codex/sessions'),path.join(os.homedir(),'.codex/archived_sessions')]) {
  const m=validateManifest(read(sourcePath));
  for(const s of Object.values(m.sources))if(hash(fs.readFileSync(s.path,'utf8'))!==s.hash)fail('source_changed');
  fs.mkdirSync(out,{mode:0o700});
  const index=await sessionIndex(roots,new Set(m.cases.map(c=>c.session_hash)));
  const eligible=[],audit=[];
  for(const sessionHash of new Set(m.cases.map(c=>c.session_hash))) {
    const items=m.cases.filter(c=>c.session_hash===sessionHash), files=index.get(sessionHash)??[];
    if(files.length!==1){for(const c of items)audit.push({id:c.id,reason:files.length?'ambiguous_session':'session_missing'});continue;}
    let session;
    try {session=await readGroups(files[0]);}catch(error){for(const c of items)audit.push({id:c.id,reason:error.message});continue;}
    if(digest(session.meta.id)!==sessionHash)fail('session_identity_changed');
    const projected=[], baseline=[];
    for(const g of session.groups) {
      const last=[...g.rows].reverse().find(r=>r.payload?.type==='agent_message'&&r.payload.phase==='final_answer');
      if(!last){projected.push(null);baseline.push(null);continue;}
      const e=await buildTurnEvidenceV1({rows:g.rows,session_hash:sessionHash},{workspace_root:session.meta.cwd,sensitive_policy:{mode:'restricted_7d',allowed_principals:['reviewer-local']}});
      const turns=e.snippets.map(s=>({id:s.span_id,role:s.role,content:s.text,observed_at:new Date(last.timestamp).toISOString()}));
      projected.push(contextWindowSourceHash(turns));baseline.push(e);
    }
    for(const c of items) {
      try {
        const matches=projected.flatMap((h,i)=>h===c.source_hash?[i]:[]);
        if(matches.length!==1)fail(matches.length?'ambiguous_source_order':'source_hash_unreproducible');
        const i=matches[0], packet=boundaryPacket(session.groups,i);
        const all=[...packet.context.flat(),...packet.target,{role:'user',text:packet.task.text}];
        const safety=await buildTurnEvidenceV1({rows:all.map(x=>({payload:{type:'user_message',message:x.text}}))},{workspace_root:session.meta.cwd});
        if(safety.hard_exclusion_reason)fail('unsafe_instruction');
        const baseline_source_map={};
        for(const message of packet.target){
          const projection=await buildTurnEvidenceV1({rows:[{payload:{type:message.role==='user'?'user_message':'agent_message',message:message.text,phase:'final_answer'}}]},{workspace_root:session.meta.cwd,sensitive_policy:{mode:'restricted_7d',allowed_principals:['reviewer-local']}});
          for(const span of baseline[i].snippets)if(span.role===message.role&&projection.snippets[0]?.text===span.text)(baseline_source_map[span.span_id]??=[]).push(message.id);
        }
        eligible.push({id:c.id,group_id:c.group_id,session_hash:sessionHash,source_hash:c.source_hash,source_order:i,workspace_root:session.meta.cwd,baseline_source_map,baseline_evidence:baseline[i],...packet});
        audit.push({id:c.id,reason:'eligible'});
      }catch(error){audit.push({id:c.id,reason:error.message});}
    }
  }
  const cases=selectCases(eligible),calibration_cases=selectCalibrationCases(eligible,cases);
  const ready=cases.length===POLICY.count&&calibration_cases.length===POLICY.calibration_count;
  const manifest=seal({contract:'memory-utility-manifest/v1.1',experiment_id:path.basename(out),policy:POLICY,source_manifest:path.resolve(sourcePath),source_manifest_hash:m.manifest_hash,status:ready?'calibration_required':'source_reconstruction_insufficient',eligible_count:eligible.length,selected_count:cases.length,calibration_count:calibration_cases.length,audit,cases:ready?cases:[],calibration_cases:ready?calibration_cases:[],privacy:'Private artifacts 0700/0600. Exact plaintext inputs and execution remain in private Codex exec session logs. No memory DB, provider API, app server, embeddings or production changes.'});
  save(path.join(out,'manifest.json'),manifest);
  return {manifest:path.join(out,'manifest.json'),status:manifest.status,eligible_count:eligible.length,selected_count:cases.length,calibration_count:calibration_cases.length,reasons:Object.fromEntries([...new Set(audit.map(r=>r.reason))].map(k=>[k,audit.filter(r=>r.reason===k).length]))};
}
export function loadManifest(p) {
  const m=verify(read(p));
  if(m.contract!=='memory-utility-manifest/v1.1'||hash(m.policy)!==hash(POLICY))fail('utility_contract_mismatch');
  const source=validateManifest(read(m.source_manifest));
  if(source.manifest_hash!==m.source_manifest_hash)fail('source_manifest_changed');
  for(const s of Object.values(source.sources))if(hash(fs.readFileSync(s.path,'utf8'))!==s.hash)fail('source_changed');
  return m;
}
export async function main(argv=process.argv.slice(2)) {
  const {values:v,positionals:[command]}=parseArgs({args:argv,allowPositionals:true,options:{manifest:{type:'string'},out:{type:'string'},job:{type:'string'},response:{type:'string'},metadata:{type:'string'},human:{type:'string'},'sessions-root':{type:'string',multiple:true}}});
  if(!v.manifest)fail('manifest_required');
  if(command==='prepare'){if(!v.out)fail('out_required');return prepare(v.manifest,v.out,v['sessions-root']);}
  const m=loadManifest(v.manifest);
  if(command==='report'&&m.status==='source_reconstruction_insufficient')return {status:m.status,selected_count:m.selected_count,calibration_count:m.calibration_count,eligible_count:m.eligible_count};
  if(m.status==='source_reconstruction_insufficient')fail('source_reconstruction_insufficient');
  const {stage}=await import('./memory-utility-v11-stages.mjs');
  return stage(command,v.manifest,v);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().then(x=>console.log(JSON.stringify(x,null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});
