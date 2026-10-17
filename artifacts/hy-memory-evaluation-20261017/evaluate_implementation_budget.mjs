// Offline paired source experiment. No API, store, enqueue or promotion.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const name=process.argv[2];
if(!/^implementation-v\d+$/.test(name??''))throw new Error('supply a fresh implementation-vN run name');
const workspace=path.resolve(new URL('../..',import.meta.url).pathname);
const base=path.join(os.homedir(),'.org-brain/evaluations/extraction-coverage-20261017');
const root=path.join(base,name);
fs.mkdirSync(root,{mode:0o700}); // Never overwrite a preserved run.
const corpusBytes=fs.readFileSync(path.join(base,'full-turn-v2/corpus.json'));
const corpus=JSON.parse(corpusBytes);
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const save=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value,null,2),{mode:0o600});};
const files=execFileSync('git',['ls-files','packages/shared/src','packages/orgbrain-cli/src/lib'],{cwd:workspace,encoding:'utf8'}).trim().split('\n').filter(file=>file.endsWith('.mjs'));
const original='292268b3b93c9b9457beeece69a9bfc299b56402';
const variants=[['before',2000,true],['after-2000',2000,false],['after-4000',4000,false],['after-8000',8000,false]];
const manifests={};
for(const [variant,ceiling,historical] of variants){
  const hashes={};
  for(const file of files){
    let text=historical?execFileSync('git',['show',`${original}:${file}`],{cwd:workspace,encoding:'utf8'}):fs.readFileSync(path.join(workspace,file),'utf8');
    if(!historical&&ceiling!==2000){
      // These are evaluation-only source copies, never production settings.
      const replacements=file.endsWith('/memory-extraction-provider-contract-runtime.mjs')?['MEMORY_EXTRACTION_MAX_INPUT_TOKENS = 2_000',`MEMORY_EXTRACTION_MAX_INPUT_TOKENS = ${ceiling}`]
        :file.endsWith('/turn-evidence-v1.mjs')?['MEMORY_EXTRACTION_INPUT_TOKEN_LIMIT = 2_000',`MEMORY_EXTRACTION_INPUT_TOKEN_LIMIT = ${ceiling}`]:null;
      if(replacements){if(!text.includes(replacements[0]))throw new Error('ceiling_anchor_changed');text=text.replace(...replacements);}
      if(file.endsWith('/memory-extraction-coverage-runtime.mjs')){
        if(!text.includes('> 2_000'))throw new Error('coverage_ceiling_anchor_changed');
        text=text.replaceAll('> 2_000',`> ${ceiling}`).replaceAll('input_ceiling: 2_000',`input_ceiling: ${ceiling}`);
      }
    }
    hashes[file]=sha(text);save(path.join(root,variant,file),text);
  }
  // Reuse installed local dependencies; do not install packages or models.
  fs.symlinkSync(path.join(workspace,'packages/shared/node_modules'),path.join(root,variant,'packages/shared/node_modules'),'dir');
  manifests[variant]={ceiling,source_files:hashes,provider_calls:0,production_settings_changed:false};
}
save(path.join(root,'freeze.json'),{schema:'memory-extraction-offline-source-pair/v1',original_commit:original,corpus_sha256:sha(corpusBytes),variants:manifests,
  labels_source:'none; mechanical text retention only',provider:'recorded original per case; no transport',existing_memories:[]});
globalThis.fetch=()=>{throw new Error('offline_evaluation_transport_forbidden');};
const canonical=t=>String(t).normalize('NFKC').replace(/\s+/gu,' ').trim();
const tags={reason:/because|reason|therefore|原因|理由|ため|ので|により|ことで/iu,condition:/unless|except|only|\bif\b|\bwhen\b|ただし|例外|場合|条件|のみ|限り|未確認|未検証|対象外/iu,
  verification:/\bpass(?:ed)?\b|\bverified\b|exit.?code|検証|確認|テスト|通過|成功|未検証/iu,negation:/\bnot\b|\bnever\b|\bcannot\b|ない|ません|未確認|未検証|未取得|禁止|対象外|停止/iu,numeric:/[0-9０-９]/u};
const outputs=[];const minimal={};
for(const [variant,ceiling] of variants){
  const modulePath=file=>pathToFileURL(path.join(root,variant,file)).href;
  const turn=await import(modulePath('packages/orgbrain-cli/src/lib/turn-evidence-v1.mjs'));
  const coverage=await import(modulePath('packages/shared/src/memory-extraction-coverage-runtime.mjs'));
  const provider=await import(modulePath('packages/shared/src/memory-extraction-provider-contract-runtime.mjs'));
  const normalizer=await import(modulePath('packages/shared/src/memory-capture-v2-runtime.mjs'));
  const citations=await import(modulePath('packages/shared/src/memory-extraction-review-text-runtime.mjs'));
  minimal[variant]={};
  for(const profile of ['legacy','coverage']){
    const p={schema:'learning-extraction-proposal/v2',snippets:[],events:[],routing:{primary_route:'llm_candidate'},rule_proposals:[],existing_memories:[],...(profile==='coverage'?{extraction_profile:'coverage/v1',coverage:{groups:[]}}:{})};
    minimal[variant][profile]=provider.memoryExtractionProviderInputUpperBound(provider.buildMemoryExtractionPrompt(p));
  }
  for(const c of corpus){
    const inputFile=path.join(root,'inputs',`${c.id}.jsonl`);
    if(!fs.existsSync(inputFile))save(inputFile,c.rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
    const rows=await turn.loadTurnEvidenceRows({transcript_path:inputFile,turn_id:c.turn_id});
    const rawParents=c.rows.filter(r=>r.payload?.type==='message'&&(r.payload.role==='user'||['final','final_answer'].includes(r.payload.phase))).map((r,i)=>({span_id:`raw${i}`,role:r.payload.role,
      text:citations.stripMemoryCitationBlocks(normalizer.normalizeMemoryPaths(r.payload.content.map(v=>v.text??'').join('\n'),c.cwd))}));
    const units=coverage.splitCoverageSentences(rawParents).map(s=>({...s,tags:Object.entries(tags).filter(([,pattern])=>pattern.test(s.text)).map(([tag])=>tag)})).filter(s=>s.tags.length);
    for(const profile of ['legacy','coverage']){
      const evidence=await turn.buildTurnEvidenceV1({rows,project_id:c.project,provider:c.source.provider,model:c.model,session_hash:sha(c.source.id),turn_hash:sha(c.turn_id)},
        {workspace_root:c.cwd,sensitive_policy:{mode:'deny',allowed_principals:[]},preserve_snippet_text:profile==='coverage'});
      const discovery=await turn.discoverLearningEpisodes(evidence,{workspace_root:c.cwd,sensitive_policy:{mode:'deny',allowed_principals:[]}});
      let packet=null,request=null,error=null;
      if(discovery.llm_recommended){
        try{
          packet=turn.buildLearningExtractionPacket(evidence,discovery,profile==='coverage'?{extraction_profile:'coverage/v1'}:{});
          request=packet;
          if(profile==='coverage'){
            const selected=new Set(packet.coverage.pass1_group_ids);
            const groups=coverage.buildCoverageEvidenceGroups(evidence.snippets,evidence.events,{hash_text:t=>`sha256:${sha(t)}`});
            request=coverage.packCoverageGroups({...packet,snippets:[],coverage_pass:1},groups.filter(g=>selected.has(g.group_id)),{reserve_bytes:0,max_snippets:8,
              upper_bound:p=>provider.memoryExtractionProviderInputUpperBound(provider.buildMemoryExtractionPrompt(p))}).packet;
          }
        }catch(cause){error=cause.message;}
      }
      const snippets=request?.snippets??[];
      const bound=request?provider.memoryExtractionProviderInputUpperBound(provider.buildMemoryExtractionPrompt(request)):null;
      if(bound!==null&&bound>ceiling)throw new Error('source_replay_ceiling_exceeded');
      const row={case_id:c.id,project:c.project,variant,profile,ceiling,source_rows:c.rows.length,loaded_rows:rows.length,
        safety_stop:evidence.hard_exclusion_reason,route:discovery.routing.primary_route??discovery.routing.disposition,packet_error:error,
        packet_ready:!!request,input_spans:snippets.length,input_text_bytes:snippets.reduce((n,s)=>n+Buffer.byteLength(s.text),0),input_upper_bound:bound,
        source_units:units.length,retained_units:units.filter(u=>snippets.some(s=>canonical(s.text).includes(canonical(u.text)))).length,
        category_units:Object.fromEntries(Object.keys(tags).map(tag=>[tag,{source:units.filter(u=>u.tags.includes(tag)).length,
          retained:units.filter(u=>u.tags.includes(tag)&&snippets.some(s=>canonical(s.text).includes(canonical(u.text)))).length}])),
        provider_calls:0,measured_provider_tokens:null,measured_provider_fee:null,semantic_quality:'not_assessed'};
      outputs.push(row);
      save(path.join(root,variant,`${c.id}-${profile}.json`),{row,evidence,discovery,packet,request});
    }
  }
}
const aggregate=[];
for(const [variant,ceiling] of variants)for(const profile of ['legacy','coverage']){
  const rows=outputs.filter(r=>r.variant===variant&&r.profile===profile);
  aggregate.push({variant,profile,ceiling,cases:rows.length,source_rows:rows.reduce((n,r)=>n+r.source_rows,0),loaded_rows:rows.reduce((n,r)=>n+r.loaded_rows,0),
    safety_stops:rows.filter(r=>r.safety_stop).length,packets_ready:rows.filter(r=>r.packet_ready).length,input_spans:rows.reduce((n,r)=>n+r.input_spans,0),
    input_text_bytes:rows.reduce((n,r)=>n+r.input_text_bytes,0),retained_source_units:rows.reduce((n,r)=>n+r.retained_units,0),
    categories:Object.fromEntries(Object.keys(tags).map(tag=>[tag,rows.reduce((n,r)=>n+r.category_units[tag].retained,0)])),
    provider_calls:0,measured_provider_tokens:null,measured_provider_fee:null,semantic_quality:'not_assessed'});
}
const summary={schema:'memory-extraction-offline-budget-results/v1',run:name,status:'local_source_experiment_only',corpus_sha256:sha(corpusBytes),minimal_upper_bounds:minimal,aggregate,cases:outputs,
  human_labels:0,full_provider_path:'not_run',formal_memory_writes:0,production_settings_changed:false};
save(path.join(root,'summary.json'),summary);
save(path.join(workspace,'artifacts/hy-memory-evaluation-20261017',`${name}-summary.json`),summary);
console.log(JSON.stringify({run:name,minimal,aggregate}));
