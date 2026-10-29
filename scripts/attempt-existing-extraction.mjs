// Bounded explicit attempts against the existing budget. Never resets a ledger,
// enables a project, promotes a candidate, or retries a held call.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {spawnSync} from 'node:child_process';import {DatabaseSync} from 'node:sqlite';import readline from 'node:readline';
import {loadEnvFallbacks} from '../packages/orgbrain-cli/src/hook-memory-bridge.mjs';
import {buildTurnEvidenceV1,discoverLearningEpisodes} from '../packages/orgbrain-cli/src/lib/turn-evidence-v1.mjs';
import {extractDurableMemoryDrafts} from '../packages/shared/src/memory-capture-v2-runtime.mjs';
const args=process.argv.slice(2),get=k=>args[args.indexOf(k)+1];const cli=path.resolve(get('--cli')),output=path.resolve(get('--output'));
await loadEnvFallbacks();
const home=os.homedir(),queue=process.env.ORGBRAIN_SESSION_EXTRACTION_QUEUE??path.join(home,'.org-brain/session-extraction'),db=process.env.ORGBRAIN_LOCAL_DB??path.join(home,'.org-brain/memory.sqlite');
const q=new DatabaseSync(path.join(queue,'queue.sqlite'),{readOnly:true});const budget=()=>q.prepare('SELECT COALESCE(sum(charged),0) n FROM jobs WHERE tenant_id=? AND month=?').get('default',new Date().toISOString().slice(0,7)).n;
const before=budget();if(before+2800<=500000)throw Error('This bounded audit expects the already observed insufficient budget; inspect before a new paid run');
const selected=q.prepare("SELECT id,packet_hash,packet_json FROM jobs WHERE tenant_id='default' AND project_id='org-brain' AND status='completed' ORDER BY created_at DESC").all().find(r=>JSON.parse(r.packet_json).snippets?.some(s=>s.source==='tool_result'));
if(!selected)throw Error('existing_session_packet_unavailable');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'orgbrain-existing-extraction-')),calls=path.join(temp,'calls'),loader=path.join(temp,'observe-fetch.mjs');
fs.writeFileSync(loader,`import fs from 'node:fs';const run=globalThis.fetch;globalThis.fetch=async(...args)=>{fs.appendFileSync(${JSON.stringify(calls)},'1\\n');return run(...args);};`);
const env={...process.env,NODE_OPTIONS:`--import=${loader}`};
function invoke(argv){const r=spawnSync(process.execPath,['--no-warnings',cli,...argv],{encoding:'utf8',env,timeout:30000});return r.status===0?{ok:true,value:JSON.parse(r.stdout.trim())}:{ok:false,error:(r.stderr.match(/pipeline_[a-z_]+|wiki_[a-z_]+|session_[a-z_]+/)??['CLI_failed'])[0]};}
try{
 const pageId='22b14a09-1eed-4367-be58-71347257514a',page=invoke(['wiki','read','--page-id',pageId]);if(!page.ok)throw Error(page.error);
 const wiki=invoke(['pipeline','run','--db',db,'--json',JSON.stringify({source:'wiki',page_id:pageId,expected_hash:page.value.hash,project_id:'org-brain',queue_dir:queue})]);
 const historical=invoke(['pipeline','run','--db',db,'--json',JSON.stringify({source:'session',job_id:selected.id,project_id:'org-brain',queue_dir:queue})]);
 const sourceRef=page.value.content.match(/source:([a-f0-9-]+)@(\d+)/);const original=invoke(['wiki','source-read','--source-id',sourceRef[1],'--version',sourceRef[2],'--max-chars','16000']);if(!original.ok||original.value.truncated)throw Error('wiki_original_unavailable');
 const wikiRules=extractDurableMemoryDrafts({source:'personal-wiki-source',project_id:'org-brain',event_id:'bounded-existing-wiki',text:original.value.text},{workspace_root:process.cwd()});
 const packet=JSON.parse(selected.packet_json);const rows=packet.snippets.map(s=>({type:'response_item',payload:{type:'message',role:s.role==='user'?'user':'assistant',phase:'final',content:[{type:'text',text:s.text}]}}));
 // Tool rows remain tools: never relabel retained outputs as assistant reports.
 const narrativeRows=rows.filter((_,i)=>packet.snippets[i].source!=='tool_result');
 const e=await buildTurnEvidenceV1({rows:narrativeRows,project_id:'org-brain'},{preserve_snippet_text:true});const sessionRules=await discoverLearningEpisodes(e);
 const active=new DatabaseSync(db,{readOnly:true});const pipeline=active.prepare("SELECT source_key,status,error,memory_id FROM memory_pipeline_runs WHERE project_id='org-brain' ORDER BY created_at DESC LIMIT 2").all();const total=active.prepare("SELECT count(*) n FROM memories WHERE lifecycle_state='active'").get().n;active.close();
 const providerCalls=fs.existsSync(calls)?fs.readFileSync(calls,'utf8').trim().split('\n').filter(Boolean).length:0;
 const result={schema:'existing-source-extraction-attempt/v1',runtime:fs.realpathSync(cli).replace(home,'~'),budget:{limit:500000,before,after:budget(),remaining:500000-budget(),next_session_reservation:2800},api_key_present:Boolean(process.env.OPENROUTER_API_KEY),wiki:{page_id:pageId,page_hash:page.value.hash,source_ref:`source:${sourceRef[1]}@${sourceRef[2]}`,source_hash:original.value.hash,attempt:wiki,rule_candidates:wikiRules.drafts.length+wikiRules.review_drafts.length},historical:{job_id:selected.id,packet_hash:selected.packet_hash,attempt:historical,rule_review_candidates:sessionRules.review_drafts.length},pipeline,active_memory_count:total,provider_calls:providerCalls,new_memories_activated:0,quality:{new_memory_reuse_observed:null,token_savings:null,time_savings_ms:null,reason:'Model extraction and source review cannot fit the unchanged monthly budget; rule-only drafts are not active memories or evidence of reuse.'},rule_drafts_persisted:false};
 if(before!==budget()||providerCalls!==0||pipeline.some(r=>r.memory_id))throw Error('unexpected_budget_or_activation_change');
 fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}finally{q.close();fs.rmSync(temp,{recursive:true,force:true});}
