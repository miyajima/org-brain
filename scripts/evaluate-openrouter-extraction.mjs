// Explicit, isolated evaluation only. Never imports an enqueue/capture client.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import Ajv from 'ajv';
import {runGeneration,readCallLedger,MODEL} from './lib/openrouter-extraction-eval.mjs';
import * as afterContract from '../packages/shared/src/memory-extraction-provider-contract-runtime.mjs';
import {verifiedCandidates as verifyAfter} from '../packages/shared/src/memory-extraction-verifier-runtime.mjs';
import {extractDurableMemoryDrafts,normalizeMemoryPaths} from '../packages/shared/src/memory-capture-v2-runtime.mjs';
import {buildCoverageEvidenceGroups,selectCoverageEvidence,packCoverageGroups} from '../packages/shared/src/memory-extraction-coverage-runtime.mjs';
import {loadTurnEvidenceRows,buildTurnEvidenceV1} from '../packages/orgbrain-cli/src/lib/turn-evidence-v1.mjs';
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const base=path.join(os.homedir(),'.org-brain/evaluations/extraction-retention-20261018');
const root=path.join(base,'qwen-live-20261018');
const callsDir=path.join(root,'calls');
const beforeContract=await import(pathToFileURL(path.join(base,'before/packages/shared/src/memory-extraction-provider-contract-runtime.mjs')));
const {verifiedCandidates:verifyBefore}=await import(pathToFileURL(path.join(base,'before/packages/shared/src/memory-extraction-verifier-runtime.mjs')));
const command=process.argv[2];
const allowed=['consentside','org-brain','AIma','socia','sfk-shinsa','jrg','factoreview','smart-block','tsugi'];
const write=(name,value)=>fs.writeFileSync(path.join(root,name),JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
const canonical=s=>String(s??'').normalize('NFKC').replace(/\s+/gu,' ').trim();
const facets={reason:/\b(?:because|reason|rationale|root cause)\b|理由|なぜなら|原因は/iu,
 condition:/\b(?:if|when|unless|except|only|never|must not)\b|ただし|但し|条件|例外|場合|禁止|のみ/iu,
 reported_verification:/\b(?:passed|verified|verification|failures?|skipped)\b|検証|確認済み|未確認|成功|失敗/iu};
function units(snippets,events){return snippets.flatMap(s=>Object.entries(facets).filter(([,re])=>re.test(s.text)).map(([facet])=>({facet,text:s.text,span_id:s.span_id,role:s.role,source:s.source,
 verified_tool:facet==='reported_verification'&&s.source==='tool_result'&&events.some(e=>e.call_id===s.call_id&&e.status==='completed'&&(e.exit_code===0||e.http_status>=200&&e.http_status<300))})));}
function guard(text){const r=extractDurableMemoryDrafts({event_id:'offline-eval',tenant_id:'default',project_id:'org-brain',source:'codex',occurred_at:1786000000000,text},{sensitive_policy:{mode:'deny',allowed_principals:[]}});return r.excluded.find(x=>['unsafe_instruction','credential_detected','sensitive_default_deny'].includes(x.reason))?.reason??null;}
function pack(snippets,events){
 const groups=buildCoverageEvidenceGroups(snippets,events,{hash_text:t=>`sha256:${sha(t)}`});
 const pool=selectCoverageEvidence(groups);
 const packet={schema:'learning-extraction-proposal/v2',snippets:[],events:[],routing:{primary_route:'llm_candidate',decisions:{durable_candidate:true}},limits:{input_tokens:2000,output_tokens:800,candidates:3,calls:1}};
 const upper=p=>Math.max(beforeContract.memoryExtractionProviderInputUpperBound(beforeContract.buildMemoryExtractionPrompt(p)),afterContract.memoryExtractionProviderInputUpperBound(afterContract.buildMemoryExtractionPrompt(p)));
 const packed=packCoverageGroups(packet,pool.groups,{upper_bound:upper,max_snippets:8,reserve_bytes:0});
 return {packet:packed.packet,source_units:units(snippets,events),presented_units:units(packed.packet.snippets??[],packed.packet.events??[]),diagnostics:packed.diagnostics,
  groups:groups.length,pool_spans:pool.span_count,pool_omitted:pool.omitted.length,input_upper_bound:upper(packed.packet)};
}
if(command==='prepare'){
 if(fs.existsSync(path.join(root,'plan.json')))throw Error('plan_exists');fs.mkdirSync(root,{recursive:true,mode:0o700});
 const corpusPath=path.join(os.homedir(),'.org-brain/memhub-eval/retention-443-20261017/corpus.json');const bytes=fs.readFileSync(corpusPath);const corpus=JSON.parse(bytes);
 if(sha(bytes)!=='52f084e700ade9bf6de986908d22e5611125b707d01707c725058aec025183c5')throw Error('corpus_changed');
 const unique=new Map();
 for(const row of corpus){if(!allowed.includes(row.project))throw Error('project_scope');const assistant=row.task_inputs.find(x=>x.role==='assistant');if(!assistant)continue;
  const key=sha(`${row.project}\0${assistant.evidence_id}`);if(!unique.has(key))unique.set(key,{project:row.project,source_id_hash:key,inputs:row.task_inputs});}
 const cases=[];let n=0;
 for(const c of unique.values()){
  const raw=c.inputs.map(s=>s.verbatim).join('\n');const hard=guard(raw);const snippets=c.inputs.map((s,i)=>({span_id:`s${i+1}`,role:s.role,source:s.role,source_order:i,text:normalizeMemoryPaths(s.verbatim,s.workspace),text_hash:`sha256:${sha(s.verbatim)}`}));
  cases.push({case_key:`c${String(++n).padStart(3,'0')}`,cohort:'final_answers',project:c.project,source_id_hash:c.source_id_hash,hard_exclusion:hard,...(!hard?pack(snippets,[]):{})});
 }
 const fullDir=path.join(os.homedir(),'.org-brain/evaluations/extraction-coverage-20261017/full-turn-v2');const fullBytes=fs.readFileSync(path.join(fullDir,'corpus.json'));const fullCorpus=JSON.parse(fullBytes);
 for(const c of fullCorpus){
  if(!allowed.includes(c.project))throw Error('project_scope');const rows=await loadTurnEvidenceRows({transcript_path:path.join(fullDir,`${c.id}.input.jsonl`),turn_id:c.turn_id,require_final:true});
  const evidence=await buildTurnEvidenceV1({rows,project_id:c.project,provider:c.source.provider,model:c.model,session_hash:sha(c.source.id),turn_hash:sha(c.turn_id)},{workspace_root:c.cwd,sensitive_policy:{mode:'deny',allowed_principals:[]},preserve_snippet_text:true});
  cases.push({case_key:`c${String(++n).padStart(3,'0')}`,cohort:'full_turns',project:c.project,source_id_hash:sha(c.id),hard_exclusion:evidence.hard_exclusion_reason,...(!evidence.hard_exclusion_reason?pack(evidence.snippets,evidence.events):{})});
 }
 const sourceFiles=['packages/shared/src/memory-extraction-provider-contract-runtime.mjs','packages/shared/src/memory-extraction-coverage-runtime.mjs','packages/shared/src/memory-extraction-verifier-runtime.mjs','packages/shared/src/memory-capture-v2-runtime.mjs'];
 const versions=Object.fromEntries(sourceFiles.map(f=>[f,{before:sha(fs.readFileSync(path.join(base,'before',f))),after:sha(fs.readFileSync(f))}]));
 const plan={schema:'orgbrain-qwen-live-paired/v1',model:MODEL,source_corpus_sha256:sha(bytes),full_turn_corpus_sha256:sha(fullBytes),source_versions:versions,
  experiment:'same frozen packet; before prompt+verifier vs after prompt+verifier; optional routing bypassed for isolated evaluation only',
  budget_usd:1,max_output_tokens:800,max_input_upper_bound:2000,max_candidates:3,provider:'DeepInfra',temperature:0,seed:418,
  provider_policy:{only:['DeepInfra'],allow_fallbacks:false,require_parameters:true,data_collection:'deny',zdr:true,max_price:{prompt:0.5,completion:2,request:0}},
  no_model_judge:true,no_auto_retry:true,no_memory_writes:true,labels:'mechanical full quoted-unit retention; not human semantic gold',
  cases};
 write('plan.json',plan);write('freeze.json',{plan_sha256:sha(JSON.stringify(plan)),versions});
 console.log(JSON.stringify({prepared:cases.length,call_eligible:cases.filter(c=>!c.hard_exclusion&&(c.packet?.snippets.length??0)>0).length,projects:Object.fromEntries(allowed.map(p=>[p,{cases:cases.filter(c=>c.project===p).length,hard_excluded:cases.filter(c=>c.project===p&&c.hard_exclusion).length,call_eligible:cases.filter(c=>c.project===p&&!c.hard_exclusion&&c.packet.snippets.length>0).length}]))}));
}else if(command==='probe'||command==='execute'){
 const plan=JSON.parse(fs.readFileSync(path.join(root,'plan.json'),'utf8'));const freeze=JSON.parse(fs.readFileSync(path.join(root,'freeze.json'),'utf8'));if(sha(JSON.stringify(plan))!==freeze.plan_sha256)throw Error('plan_changed');
 for(const[f,v]of Object.entries(plan.source_versions))if(sha(fs.readFileSync(f))!==v.after||sha(fs.readFileSync(path.join(base,'before',f)))!==v.before)throw Error('source_changed');
 const key=process.env.OPENROUTER_API_KEY;if(!key)throw Error('key_missing');
 if(sha(JSON.stringify(beforeContract.MEMORY_EXTRACTION_OUTPUT_SCHEMA))!==sha(JSON.stringify(afterContract.MEMORY_EXTRACTION_OUTPUT_SCHEMA)))throw Error('schema_changed_between_arms');
 const body=prompt=>({model:MODEL,messages:[{role:'user',content:prompt}],temperature:plan.temperature,seed:plan.seed,max_tokens:800,
  provider:plan.provider_policy,response_format:{type:'json_schema',json_schema:{name:'memory_extraction',strict:true,schema:afterContract.MEMORY_EXTRACTION_OUTPUT_SCHEMA}}});
 if(command==='probe'){
  const r=await runGeneration({directory:callsDir,callKey:'probe',body:body('Return {"candidates":[]} only. This is a transport probe; do not extract memories.'),apiKey:key,budgetUsd:1});
  console.log(JSON.stringify({probe:r.status,model:r.model,provider:r.provider,finish_reason:r.finish_reason,prompt_tokens:r.prompt_tokens,completion_tokens:r.completion_tokens,cost_usd:r.cost_usd}));
 }else{
  const probePath=path.join(callsDir,'probe.result.json');if(!fs.existsSync(probePath))throw Error('probe_required');const probe=JSON.parse(fs.readFileSync(probePath));if(probe.status!=='response_received'||probe.provider!=='DeepInfra'||probe.model!==MODEL)throw Error('probe_failed');
  const validate=new Ajv({allErrors:true,strict:false}).compile(afterContract.MEMORY_EXTRACTION_OUTPUT_SCHEMA);
  const probeRaw=JSON.parse(fs.readFileSync(path.join(callsDir,'probe.response.txt'),'utf8'));
  if(probe.finish_reason!=='stop'||!validate(JSON.parse(probeRaw.choices?.[0]?.message?.content)))throw Error('probe_schema_failed');
  const executionFiles=['scripts/evaluate-openrouter-extraction.mjs','scripts/lib/openrouter-extraction-eval.mjs'];
  const executionHash=sha(JSON.stringify(Object.fromEntries(executionFiles.map(f=>[f,sha(fs.readFileSync(f))]))));
  const executionPath=path.join(root,'execution-freeze.json');
  if(fs.existsSync(executionPath)){if(JSON.parse(fs.readFileSync(executionPath)).hash!==executionHash)throw Error('execution_source_changed');}
  else write('execution-freeze.json',{hash:executionHash,files:executionFiles});
  for(const c of plan.cases.filter(c=>!c.hard_exclusion&&c.packet.snippets.length)){
   const order=parseInt(c.source_id_hash.slice(0,2),16)%2?['after','before']:['before','after'];
   for(const arm of order){
    const callKey=`${c.case_key}-${arm}`;const resultPath=path.join(callsDir,`${callKey}.result.json`);if(fs.existsSync(resultPath))continue;
    const contract=arm==='before'?beforeContract:afterContract;
    const r=await runGeneration({directory:callsDir,callKey,body:body(contract.buildMemoryExtractionPrompt(c.packet)),apiKey:key,budgetUsd:1});
    let output={status:r.status};
    if(r.status==='response_received'){
     const raw=JSON.parse(fs.readFileSync(path.join(callsDir,`${callKey}.response.txt`),'utf8'));
     if(r.provider!=='DeepInfra'||r.model!==MODEL)throw Error('provider_model_mismatch');
     const text=raw.choices?.[0]?.message?.content;
     try{const parsed=JSON.parse(text);if(!validate(parsed))output={status:'schema_invalid'};else if(r.finish_reason!=='stop')output={status:'incomplete_finish'};else output={status:'valid_output',raw_candidates:parsed.candidates,verified:await(arm==='before'?verifyBefore:verifyAfter)({packet:c.packet,project_id:c.project,run_id:c.case_key},parsed.candidates)};}catch{output={status:text?'invalid_json':'empty_output'};}
    }
    fs.writeFileSync(path.join(callsDir,`${callKey}.analysis.json`),JSON.stringify(output,null,2),{mode:0o600,flag:'wx'});
    console.log(JSON.stringify({case:c.case_key,project:c.project,arm,status:output.status,candidates:output.raw_candidates?.length??null,accepted:output.verified?.candidates.length??null,cost_usd:r.cost_usd}));
    if([401,402,403,404,429].includes(r.http_status))throw Error(`shared_provider_blocked:${r.http_status}`);
   }
  }
  console.log(JSON.stringify({done:true,calls:readCallLedger(callsDir).length}));
 }
}else throw Error('use_prepare_probe_execute');
