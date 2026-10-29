// Offline, same-input packing comparison. Never calls a model or writes a queue.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import {pathToFileURL} from 'node:url';
import {prepareSessionExtraction} from '../packages/orgbrain-cli/src/lib/session-extraction.mjs';
import {buildTurnEvidenceV1} from '../packages/orgbrain-cli/src/lib/turn-evidence-v1.mjs';
import {splitCoverageSentences} from '../packages/shared/src/memory-extraction-coverage-runtime.mjs';
const argv=process.argv.slice(2);
const option=name=>{const index=argv.indexOf(name);if(index<0||!argv[index+1])throw Error('required_option:'+name);return argv[index+1];};
const manifest=JSON.parse(fs.readFileSync(option('--candidates'),'utf8'));
const baseline=path.resolve(option('--baseline'));
const output=path.resolve(option('--output'));
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const before=await import(pathToFileURL(path.join(baseline,'packages/orgbrain-cli/src/lib/session-extraction.mjs')));
const sourceFiles=['packages/orgbrain-cli/src/lib/session-extraction.mjs','packages/orgbrain-cli/src/lib/turn-evidence-v1.mjs','packages/shared/src/memory-extraction-coverage-runtime.mjs','packages/shared/src/memory-extraction-verifier-runtime.mjs'];
const versions=Object.fromEntries(sourceFiles.map(file=>[file,{before:sha(fs.readFileSync(path.join(baseline,file))),after:sha(fs.readFileSync(new URL('../'+file,import.meta.url)))}]));
const facets={reason:/\b(?:because|reason|cause)\b|理由|原因|ため/iu,condition:/\b(?:if|when|only|unless|except|unverified)\b|条件|場合|ただし|未検証|未測定|限定/iu,verification:/\b(?:passed|verified|restored|resolved|recovered)\b|成功|合格|復旧|検証|再利用/iu};
async function selectedTurn(candidate){
 const input=readline.createInterface({input:fs.createReadStream(candidate.session_source.path),crlfDelay:Infinity});
 let rows=[],line=0,workspace=null,turnId=null;
 for await(const text of input){line++;const row=JSON.parse(text);if(row.type==='turn_context'&&row.payload.turn_id!==turnId){rows=[];workspace=row.payload.cwd;turnId=row.payload.turn_id;}rows.push(row);if(line===candidate.session_source.line){
  if(row.payload?.role!=='assistant'||!['final','final_answer'].includes(row.payload.phase))throw Error('candidate_final_mismatch:'+candidate.id);
  return {rows,workspace,turnId,final_hash:sha(text),selected_rows_hash:sha(JSON.stringify(rows))};
 }}throw Error('candidate_source_missing:'+candidate.id);
}
function metrics(prepared,units){
 const presented=prepared.packets.flatMap(p=>p.snippets).map(s=>s.text).join('\n');
 const heldIds=new Set(prepared.held.flatMap(h=>h.span_ids));
 const count={};for(const [name,pattern] of Object.entries(facets)){
 const selected=units.filter(s=>pattern.test(s.text));count[name]={source:selected.length,presented:selected.filter(s=>presented.includes(s.text)).length,held:selected.filter(s=>heldIds.has(s.span_id)).length};}
 return {status:prepared.status,reason:prepared.reason??null,packets:prepared.packets.length,held_groups:prepared.held.length,source_spans:prepared.source_spans??0,presented_spans:prepared.presented_spans??0,facets:count};
}
const cases=[];
for(const candidate of manifest.candidates){
 const source=await selectedTurn(candidate);
 const input={rows:source.rows,client:'codex',projectId:candidate.project,workspace:source.workspace,sessionId:candidate.session_source.session_id,turnId:source.turnId};
 const b=await before.prepareSessionExtraction(input),a=await prepareSessionExtraction(input);
 const discoveryRows=source.rows.filter(row=>row.payload?.type==='message' && (row.payload.role==='user' || row.payload.role==='assistant'&&['final','final_answer'].includes(row.payload.phase)));
 const discoveryBefore=await before.prepareSessionExtraction({...input,rows:discoveryRows});
 const discoveryAfter=await prepareSessionExtraction({...input,rows:discoveryRows});
 const evidence=await buildTurnEvidenceV1({rows:discoveryRows,project_id:candidate.project},{preserve_snippet_text:true,workspace_root:source.workspace,sensitive_policy:{mode:'deny',allowed_principals:[]}});
 const units=splitCoverageSentences(evidence.snippets);
 let record='not_supplied';if(candidate.verification_artifact){const file=candidate.verification_artifact.path;record=!fs.existsSync(file)?'missing':sha(fs.readFileSync(file))===candidate.verification_artifact.sha256?'hash_matches':'hash_changed';}
 cases.push({id:candidate.id,project:candidate.project,session_id:candidate.session_source.session_id,turn_id:source.turnId,source_final_line:candidate.session_source.line,source_final_sha256:source.final_hash,selected_rows_sha256:source.selected_rows_hash,saved_record_hash_check:record,full_turn:{before:metrics(b,units),after:metrics(a,units)},before:metrics(discoveryBefore,units),after:metrics(discoveryAfter,units)});
}
const result={schema:'session-episodes-offline-comparison/v1',versions,cases,model_calls:0,queue_writes:0,memory_writes:0,limitations:['Exploration-selected review candidates, not gold labels or a recall denominator.','Full-turn safety and a separate native-user/final-only discovery projection are compared; discovery has no independent tool verification.',
 'Only deterministic discovery, safety, packing and literal condition retention are compared.','No model candidate quality, historical execution, current service health, natural reuse, total-cost benefit or activation is attested.','Source role/text projections stay in process memory; output has only hashes/counts.']};
fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(cases.map(c=>({id:c.id,record:c.saved_record_hash_check,before:c.before.status,after:c.after.status,packets:[c.before.packets,c.after.packets],holds:[c.before.held_groups,c.after.held_groups]})),null,2));
