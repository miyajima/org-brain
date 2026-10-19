import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import Ajv from 'ajv';
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const canonical=s=>String(s??'').normalize('NFKC').replace(/\s+/gu,' ').trim();
const controls=new Set(['persistence','memory_kind','action','target_memory_id','decision_type']);
const semanticFields={success:['procedure','why_it_worked','observed_outcome','reuse_when'],decision:['question','selected_value','decision','constraints','rationale','alternatives','reuse_when'],failure:['symptom','failed_approach','root_cause','correction','verified_outcome','avoidance_rule']};
const strings=v=>typeof v==='string'?[v]:Array.isArray(v)?v.flatMap(strings):v&&typeof v==='object'?Object.values(v).flatMap(strings):[];
const facetPatterns={reason:/\b(?:because|reason|rationale|root cause)\b|理由|なぜなら|原因は/iu,
 condition:/\b(?:if|when|unless|except|only|never|must not)\b|ただし|但し|条件|例外|場合|禁止|のみ/iu,
 reported_verification:/\b(?:passed|verified|verification|failures?|skipped)\b|検証|確認済み|未確認|成功|失敗/iu};
export function facetSentences(snippets){return snippets.flatMap(s=>s.text.split(/(?<=[。！？])|(?:\r?\n)+|(?<=[.!?])\s+(?=[A-Z])/u).map(text=>text.trim()).filter(Boolean).flatMap(text=>Object.entries(facetPatterns).filter(([,re])=>re.test(text)).map(([facet])=>({...s,text,facet,verified_tool:false}))));}
export function quotedCoverage(source,values){
 const text=canonical(source);const quotes=values.map(canonical).filter(Boolean);if(quotes.some(q=>q.includes(text)))return 1;
 const covered=new Uint8Array(text.length);for(const q of quotes){let at=0;while(at<=text.length-q.length){const i=text.indexOf(q,at);if(i<0)break;covered.fill(1,i,i+q.length);at=i+Math.max(1,q.length);}}
 let numerator=0,denominator=0;for(let i=0;i<text.length;){const c=String.fromCodePoint(text.codePointAt(i));if(!/[\p{P}\p{Z}\s]/u.test(c)){denominator++;if(covered[i])numerator++;}i+=c.length;}return denominator?numerator/denominator:0;
}
export function quotedUnitRetained(source,values){
 const text=canonical(source);const quotes=values.map(canonical).filter(Boolean);
 if(quotes.some(q=>q.includes(text)))return true;
 const covered=new Uint8Array(text.length);
 for(const q of quotes){let at=0;while(at<=text.length-q.length){const i=text.indexOf(q,at);if(i<0)break;covered.fill(1,i,i+q.length);at=i+Math.max(1,q.length);}}
 for(let i=0;i<text.length;){const c=String.fromCodePoint(text.codePointAt(i));if(!/[\p{P}\p{Z}\s]/u.test(c)&&!covered[i])return false;i+=c.length;}return true;
}
export const rawContent=candidates=>candidates.flatMap(c=>(c.fields??[]).filter(f=>!controls.has(f.name)).flatMap(f=>f.values??[])).filter(value=>typeof value==='string'&&value.trim());
export const acceptedContent=candidates=>candidates.flatMap(c=>(semanticFields[c.observation?.lesson_type]??[]).flatMap(k=>strings(c.observation[k])));
export const matchedRows=rows=>rows.filter(row=>['before','after'].every(arm=>row.arms[arm]?.status==='valid_output'));
const unitCounts=units=>Object.fromEntries(['reason','condition','reported_verification','verified_tool'].map(k=>[k,units.filter(u=>k==='verified_tool'?u.verified_tool:u.facet===k).length]));
const retainedCounts=(units,content)=>unitCounts(units.filter(u=>quotedUnitRetained(u.text,content)));
const zero=()=>({reason:0,condition:0,reported_verification:0,verified_tool:0});
const armZero=()=>({responses:0,valid_outputs:0,statuses:{},raw_candidates:0,raw_empty_fields:0,raw_field_values:0,raw_exact_cited_values:0,accepted_candidates:0,accepted_empty_semantic_content:0,retained_raw:zero(),retained_accepted:zero(),rejections:{},unproven_raw_outcomes:0,unproven_accepted_outcomes:0,prompt_tokens:0,completion_tokens:0,cached_tokens:0,cost_usd:0,usage_unknown:0});
function unproven(candidate,packet,normalized=false){
 const fields=normalized?Object.entries(candidate.observation??{}).filter(([k])=>['observed_outcome','verified_outcome'].includes(k)).flatMap(([,v])=>strings(v)):(candidate.fields??[]).filter(f=>['observed_outcome','verified_outcome'].includes(f.name)).flatMap(f=>f.values);
 return fields.some(value=>!packet.snippets.some(s=>s.source==='tool_result'&&s.call_id&&s.text.includes(value)&&(packet.events??[]).some(e=>e.call_id===s.call_id&&e.status==='completed'&&(e.exit_code===0||e.http_status>=200&&e.http_status<300))));
}
function addCounts(target,value){for(const[k,v]of Object.entries(value))target[k]=(target[k]??0)+v;}
export async function analyze(directory,{partial=false}={}){
 const plan=JSON.parse(fs.readFileSync(path.join(directory,'plan.json')));const base=path.dirname(directory);
 const before=await import(pathToFileURL(path.join(base,'before/packages/shared/src/memory-extraction-verifier-runtime.mjs')));
 const after=await import(pathToFileURL(path.join(base,'after/packages/shared/src/memory-extraction-verifier-runtime.mjs')));
 const contract=await import(pathToFileURL(path.join(base,'after/packages/shared/src/memory-extraction-provider-contract-runtime.mjs')));
 const validate=new Ajv({allErrors:true,strict:false}).compile(contract.MEMORY_EXTRACTION_OUTPUT_SCHEMA);
 const projects=Object.fromEntries(['consentside','org-brain','AIma','socia','sfk-shinsa','jrg','factoreview','smart-block','tsugi'].map(p=>[p,{cases:0,hard_excluded:0,budget_empty:0,eligible_pairs:0,complete_pairs:0,source_units:zero(),presented_units:zero(),before:armZero(),after:armZero()}]));
 const matrix=Object.fromEntries(['before','after'].map(rawArm=>[rawArm,{before:{accepted_candidates:0,retained:zero()},after:{accepted_candidates:0,retained:zero()}}]));
 const sentenceSummary=Object.fromEntries(Object.keys(projects).map(p=>[p,{presented:zero(),before:{retained_raw:zero(),retained_accepted:zero()},after:{retained_raw:zero(),retained_accepted:zero()}}]));
 const privateRows=[];let completePairs=0;
 for(const c of plan.cases){
  const p=projects[c.project];p.cases++;if(c.hard_exclusion){p.hard_excluded++;continue;}
  addCounts(p.source_units,unitCounts(c.source_units));
  if(!c.packet.snippets.length){p.budget_empty++;continue;}p.eligible_pairs++;addCounts(p.presented_units,unitCounts(c.presented_units));
  const sentences=facetSentences(c.packet.snippets);addCounts(sentenceSummary[c.project].presented,unitCounts(sentences));
  const row={case_key:c.case_key,project:c.project,cohort:c.cohort,arms:{}};let complete=true;
  for(const arm of ['before','after']){
   const prefix=path.join(directory,'calls',`${c.case_key}-${arm}`);if(!fs.existsSync(prefix+'.result.json')){complete=false;row.arms[arm]={status:fs.existsSync(prefix+'.intent.json')?'unsettled':'not_sent'};continue;}
   const r=JSON.parse(fs.readFileSync(prefix+'.result.json'));const a=p[arm];a.responses++;
   for(const k of ['prompt_tokens','completion_tokens','cached_tokens','cost_usd'])a[k]+=r[k]??0;if(r.cost_usd===null)a.usage_unknown++;
   let status=r.status,parsed=null;
   if(r.status==='response_received'){
    const response=JSON.parse(fs.readFileSync(prefix+'.response.txt'));const text=response.choices?.[0]?.message?.content;
    try{parsed=JSON.parse(text);status=validate(parsed)?(r.finish_reason==='stop'?'valid_output':'incomplete_finish'):'schema_invalid';}catch{status=text?'invalid_json':'empty_output';}
   }
   a.statuses[status]=(a.statuses[status]??0)+1;
   if(status!=='valid_output'){complete=false;row.arms[arm]={status};continue;}
   a.valid_outputs++;a.raw_candidates+=parsed.candidates.length;addCounts(a.retained_raw,retainedCounts(c.presented_units,rawContent(parsed.candidates)));
   a.raw_empty_fields+=parsed.candidates.filter(candidate=>!rawContent([candidate]).length).length;
   a.raw_field_values+=rawContent(parsed.candidates).length;
   a.raw_exact_cited_values+=parsed.candidates.reduce((n,candidate)=>n+rawContent([candidate]).filter(value=>c.packet.snippets.some(s=>candidate.support_span_ids.includes(s.span_id)&&s.text.includes(value))).length,0);
   addCounts(sentenceSummary[c.project][arm].retained_raw,retainedCounts(sentences,rawContent(parsed.candidates)));
   a.unproven_raw_outcomes+=parsed.candidates.filter(candidate=>unproven(candidate,c.packet)).length;
   row.arms[arm]={status,raw_candidates:parsed.candidates,normalizations:{}};
   for(const[normalizer,module]of [['before',before],['after',after]]){
    const verified=await module.verifiedCandidates({packet:c.packet,project_id:c.project,run_id:c.case_key},parsed.candidates);
    row.arms[arm].normalizations[normalizer]=verified;matrix[arm][normalizer].accepted_candidates+=verified.candidates.length;addCounts(matrix[arm][normalizer].retained,retainedCounts(c.presented_units,acceptedContent(verified.candidates)));
    if(normalizer===arm){a.accepted_candidates+=verified.candidates.length;addCounts(a.retained_accepted,retainedCounts(c.presented_units,acceptedContent(verified.candidates)));
     a.accepted_empty_semantic_content+=verified.candidates.filter(candidate=>!acceptedContent([candidate]).some(value=>value.trim())).length;
     addCounts(sentenceSummary[c.project][arm].retained_accepted,retainedCounts(sentences,acceptedContent(verified.candidates)));
     for(const rejection of verified.rejections)for(const code of rejection.reason_codes)a.rejections[code]=(a.rejections[code]??0)+1;
     a.unproven_accepted_outcomes+=verified.candidates.filter(candidate=>unproven(candidate,c.packet,true)).length;}
   }
  }
  if(complete){p.complete_pairs++;completePairs++;}privateRows.push(row);
 }
 const probe=JSON.parse(fs.readFileSync(path.join(directory,'calls','probe.result.json')));
 const pairedProjects=Object.fromEntries(Object.keys(projects).map(p=>[p,{pairs:0,presented_units:zero(),presented_sentences:zero(),before:armZero(),after:armZero()}]));
 const pairedMatrix=Object.fromEntries(['before','after'].map(a=>[a,{before:{accepted_candidates:0,retained:zero()},after:{accepted_candidates:0,retained:zero()}}]));
 for(const row of matchedRows(privateRows)){
  const c=plan.cases.find(c=>c.case_key===row.case_key);const p=pairedProjects[c.project];p.pairs++;addCounts(p.presented_units,unitCounts(c.presented_units));addCounts(p.presented_sentences,unitCounts(facetSentences(c.packet.snippets)));
  for(const arm of ['before','after']){
   const raw=row.arms[arm].raw_candidates;const verified=row.arms[arm].normalizations[arm];const a=p[arm];
   a.raw_candidates+=raw.length;a.raw_empty_fields+=raw.filter(candidate=>!rawContent([candidate]).length).length;
   a.accepted_candidates+=verified.candidates.length;a.accepted_empty_semantic_content+=verified.candidates.filter(candidate=>!acceptedContent([candidate]).some(v=>v.trim())).length;
   addCounts(a.retained_raw,retainedCounts(c.presented_units,rawContent(raw)));addCounts(a.retained_accepted,retainedCounts(c.presented_units,acceptedContent(verified.candidates)));
   a.retained_sentences_raw??=zero();a.retained_sentences_accepted??=zero();addCounts(a.retained_sentences_raw,retainedCounts(facetSentences(c.packet.snippets),rawContent(raw)));addCounts(a.retained_sentences_accepted,retainedCounts(facetSentences(c.packet.snippets),acceptedContent(verified.candidates)));
   for(const norm of ['before','after']){const v=row.arms[arm].normalizations[norm];pairedMatrix[arm][norm].accepted_candidates+=v.candidates.length;addCounts(pairedMatrix[arm][norm].retained,retainedCounts(c.presented_units,acceptedContent(v.candidates)));}
  }
 }
 const intents=fs.readdirSync(path.join(directory,'calls')).filter(f=>f.endsWith('.intent.json')).map(f=>JSON.parse(fs.readFileSync(path.join(directory,'calls',f))));
 const unresolvedReserve=intents.reduce((n,i)=>{const f=path.join(directory,'calls',i.call_key+'.result.json');return n+(!fs.existsSync(f)||JSON.parse(fs.readFileSync(f)).cost_usd===null?i.reserved_usd:0);},0);
 const eligible=plan.cases.filter(c=>!c.hard_exclusion&&c.packet.snippets.length);
 const lengths=eligible.map(c=>c.packet.snippets.reduce((n,s)=>n+[...s.text].length,0)).sort((a,b)=>a-b);
 const toolSpans=eligible.flatMap(c=>c.packet.snippets.filter(s=>s.source==='tool_result').map(s=>({snippet:s,events:c.packet.events})));
 const sameCallSuccess=toolSpans.filter(({snippet:s,events})=>s.call_id&&events.some(e=>e.call_id===s.call_id&&e.status==='completed'&&(e.exit_code===0||e.http_status>=200&&e.http_status<300))).length;
 const summary={schema:'orgbrain-qwen-live-results/v1',observed_at:new Date().toISOString(),partial,model:plan.model,provider:plan.provider,plan_sha256:sha(JSON.stringify(plan)),source_versions:plan.source_versions,
  input_diagnostics:{input_upper_max:Math.max(...eligible.map(c=>c.input_upper_bound)),evidence_characters_median:(lengths[Math.floor((lengths.length-1)/2)]+lengths[Math.ceil((lengths.length-1)/2)])/2,evidence_characters_min:lengths[0],tool_spans:toolSpans.length,tool_spans_with_successful_same_call_event:sameCallSuccess},
  experimental_scope:plan.experiment,projects,normalizer_crosscheck:matrix,matched_pairs:{projects:pairedProjects,normalizer_crosscheck:pairedMatrix,rule:'Both arms must have valid schema and stop finish; all other pairs excluded symmetrically.'},exploratory_sentence_coverage:{method:'Post-hoc deterministic sentence splitting and facet regex, exact quote coverage only, not human semantic labels; does not replace preregistered whole-span metric.',projects:sentenceSummary},complete_pairs:completePairs,probe:{status:probe.status,prompt_tokens:probe.prompt_tokens,completion_tokens:probe.completion_tokens,cost_usd:probe.cost_usd},
  costs:{total_usd:probe.cost_usd+Object.values(projects).reduce((n,p)=>n+p.before.cost_usd+p.after.cost_usd,0),usage_unknown:Object.values(projects).reduce((n,p)=>n+p.before.usage_unknown+p.after.usage_unknown,0),unresolved_reserved_usd:unresolvedReserve,basis:'Known OpenRouter response usage.cost only; unknown calls are not zero-cost. Excludes payment/funding fees.'},
  constraints:{production_activation:false,memory_writes:0,automatic_retries:0,actual_tool_verified_units_presented:Object.values(projects).reduce((n,p)=>n+p.presented_units.verified_tool,0),human_gold:false,model_judge:false},
  interpretation:'Quoted-unit coverage is mechanical, not semantic recall/precision. Raw model output and accepted review candidates are separate. No candidate is a saved/verified memory.'};
 return {summary,privateRows};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const directory=path.join(os.homedir(),'.org-brain/evaluations/extraction-retention-20261018/qwen-live-20261018');
 const {summary,privateRows}=await analyze(directory,{partial:process.argv.includes('--partial')});
 const suffix=process.argv.includes('--partial')?'partial':'final';
 fs.writeFileSync(path.join(directory,`analysis-${suffix}.json`),JSON.stringify(privateRows,null,2),{mode:0o600});
 fs.writeFileSync(path.join(directory,`summary-${suffix}.json`),JSON.stringify(summary,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({complete_pairs:summary.complete_pairs,costs:summary.costs,totals:Object.fromEntries(['before','after'].map(arm=>[arm,{responses:Object.values(summary.projects).reduce((n,p)=>n+p[arm].responses,0),accepted:Object.values(summary.projects).reduce((n,p)=>n+p[arm].accepted_candidates,0)}]))}));
}
