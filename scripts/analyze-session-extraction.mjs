import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {parseSessionExtractionResponse,sessionExtractionPrompt,SESSION_EXTRACTION_MODEL,SESSION_EXTRACTION_SCHEMA} from '../packages/orgbrain-cli/src/lib/session-extraction.mjs';
import {verifiedCandidates} from '../packages/shared/src/memory-extraction-verifier-runtime.mjs';
import {splitCoverageSentences} from '../packages/shared/src/memory-extraction-coverage-runtime.mjs';
import {buildTurnEvidenceV1} from '../packages/orgbrain-cli/src/lib/turn-evidence-v1.mjs';
import {TaskCommitmentStore} from '../packages/orgbrain-cli/src/lib/task-commitment-store.mjs';
const review=process.argv.includes('--review-v4');const revision=review?'v4':'v3';
const root=path.join(os.homedir(),'.org-brain/evaluations/shared-extraction-20261019');const plan=JSON.parse(fs.readFileSync(path.join(root,review?'plan-review-v4.json':'plan-v2.json')));const results=JSON.parse(fs.readFileSync(path.join(root,'results.json')));
const sha=x=>crypto.createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');const canonical=s=>String(s??'').normalize('NFKC').replace(/\s+/gu,' ').trim();
const facets={reason:/\b(?:because|reason|rationale|root cause)\b|理由|なぜなら|原因は/iu,exception:/\b(?:if|when|unless|except|only|never|must not)\b|ただし|但し|条件|例外|場合|禁止|のみ/iu,verification_report:/\b(?:passed|verified|verification|failures?|skipped)\b|検証|確認済み|未確認|成功|失敗/iu};
const bodyFields=['procedure','why_it_worked','observed_outcome','reuse_when','decision','selected_value','rationale','constraints','alternatives','symptom','failed_approach','root_cause','correction','verified_outcome','avoidance_rule','reported_verification'];
function strings(v){return typeof v==='string'?[v]:Array.isArray(v)?v.flatMap(strings):v&&typeof v==='object'?Object.values(v).flatMap(strings):[];}
const body=c=>bodyFields.flatMap(f=>strings(c.observation?.[f])).map(canonical).join(' ');
const readSaved=file=>{const db=new DatabaseSync(file,{readOnly:true});try{return db.prepare('SELECT project_id,status,payload_json FROM memory_learning_candidates').all().map(r=>({...r,candidate:JSON.parse(r.payload_json)}));}finally{db.close();}};
const replayFile=path.join(root,`after-body-retention-${revision}.sqlite`);const store=new TaskCommitmentStore(replayFile);await store.init();
const perCase=[];let calls=0,cost=0,replayed=0,failed=0,rawCandidates=0,storageHeld=0;const failures={};
for(const c of plan.cases){
 const candidates=[];const rejections=[];
 for(const [i,packet]of c.after.packets.entries()){
  const body={model:SESSION_EXTRACTION_MODEL,reasoning:{effort:'low',exclude:true},max_tokens:800,provider:{only:['google-vertex/global'],allow_fallbacks:false,require_parameters:true,data_collection:'deny',zdr:true,max_price:{prompt:2,completion:10}},response_format:{type:'json_schema',json_schema:{name:'session_extraction',strict:true,schema:SESSION_EXTRACTION_SCHEMA}},messages:[{role:'user',content:sessionExtractionPrompt(packet)}]};
  const key=`${c.id}-after-${sha(body).slice(0,16)}`;const intent=JSON.parse(fs.readFileSync(path.join(root,'calls',key+'.intent.json')));if(intent.request_hash!==sha(body))throw Error('request_hash_mismatch');
  const raw=JSON.parse(fs.readFileSync(path.join(root,'calls',key+'.response.json')));calls++;cost+=raw.usage?.cost??0;
  try{const generated=parseSessionExtractionResponse(packet,raw);rawCandidates+=generated.candidates.length;const checked=await verifiedCandidates({packet,project_id:c.project,run_id:`response-replay:${c.id}:${i}`},generated.candidates);rejections.push(...checked.rejections);const saved=checked.candidates.map(candidate=>({...candidate,automatic_promotion:false,source_client:'codex',extraction_model:SESSION_EXTRACTION_MODEL,extraction_effort:'low',response_replay:true}));const admitted=await store.saveLearningCandidates({tenantId:'default',projectId:c.project,taskKey:c.id,candidates:saved,requireExactBody:true});storageHeld+=admitted.filter(r=>r.status==='held').length;candidates.push(...saved.filter(s=>admitted.some(r=>r.status==='quarantine'&&r.external_key===s.external_key)));replayed++;}catch(e){failed++;failures[e.message]=(failures[e.message]??0)+1;}
 }
 perCase.push({id:c.id,project:c.project,candidates,rejections});
}
fs.writeFileSync(path.join(root,`response-replay-candidates-${revision}.json`),JSON.stringify(perCase,null,2),{mode:0o600});
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const semanticHash=c=>sha(stable(Object.fromEntries(bodyFields.filter(k=>c.observation?.[k]!==undefined).map(k=>[k,c.observation[k]]))));
const persisted=readSaved(replayFile);const allProjected=perCase.flatMap(c=>c.candidates);
if(persisted.length!==allProjected.length||persisted.some(r=>r.status!=='quarantine')||persisted.some(r=>!allProjected.some(c=>c.external_key===r.candidate.external_key&&semanticHash(c)===semanticHash(r.candidate))))throw Error('semantic_body_readback_mismatch');
const beforeSaved=readSaved(path.join(root,'before.sqlite'));const initialSaved=readSaved(path.join(root,'after.sqlite'));
const projects={};const examples=[];
for(const project of ['consentside','org-brain','AIma','socia','sfk-shinsa','jrg','factoreview','smart-block','tsugi']){
 const cases=plan.cases.filter(c=>c.project===project);const row={cases:cases.length,before_candidates:beforeSaved.filter(s=>s.project_id===project).length,initial_after_candidates:initialSaved.filter(s=>s.project_id===project).length,after_candidates:persisted.filter(s=>s.project_id===project).length,facets:{},input_held_groups:cases.reduce((n,c)=>n+c.after.held.length,0),status:cases.length?'observed':'unacquired'};
 for(const facet of Object.keys(facets))row.facets[facet]={source_units:0,before_presented:0,after_presented:0,before_retained:0,after_retained:0};
 for(const c of cases){
  // Retention denominator excludes the whole source if the full evidence guard excludes it.
  if(c.after.status==='excluded')continue;
  const evidence=await buildTurnEvidenceV1({rows:c.rows,project_id:project},{workspace_root:c.workspace,sensitive_policy:{mode:'deny',allowed_principals:[]},preserve_snippet_text:true});
  const units=splitCoverageSentences(evidence.snippets);const beforeText=canonical((c.before.packet?.snippets??[]).map(s=>s.text).join(' '));const afterText=canonical(c.after.packets.flatMap(p=>p.snippets.map(s=>s.text)).join(' '));
  const b=beforeSaved.filter(s=>s.project_id===project).map(s=>body(s.candidate)).join(' ');const a=perCase.find(r=>r.id===c.id).candidates.map(body).join(' ');
  for(const u of units)for(const [facet,re]of Object.entries(facets))if(re.test(u.text)){
   const n=canonical(u.text);const m=row.facets[facet];m.source_units++;m.before_presented+=Number(beforeText.includes(n));m.after_presented+=Number(afterText.includes(n));m.before_retained+=Number(b.includes(n));m.after_retained+=Number(a.includes(n));
  }
 }
 projects[project]=row;
 for(const saved of persisted.filter(s=>s.project_id===project)){
  const o=saved.candidate.observation;if(o.reported_verification&&examples.filter(e=>e.project===project).length<2)examples.push({project,lesson_type:o.lesson_type,has_reason:Boolean(o.why_it_worked||o.rationale||o.root_cause),has_conditions:Boolean(o.reuse_when||o.constraints?.length||o.avoidance_rule),report_state:o.reported_verification.state,report_text_sha256:sha(o.reported_verification.text),private_candidate_id_hash:sha(saved.candidate.external_key)});
 }
}
const beforeCalls=fs.readdirSync(path.join(root,'calls')).filter(f=>f.includes('-before-')&&f.endsWith('.response.json'));for(const f of beforeCalls)cost+=JSON.parse(fs.readFileSync(path.join(root,'calls',f))).usage?.cost??0;
const summary={schema:'session-extraction-retention-summary/v1',measured_at:new Date().toISOString(),model:SESSION_EXTRACTION_MODEL,effort:'low',provider:'Google (google-vertex/global), ZDR',same_source_cases:118,baseline_mode:'frozen pre-change normal router and v2 packing/verifier',after_mode:'normal shared session queue; saved real responses reparsed after optional-empty fix; no model resend',body_metric:'mechanical exact full-sentence containment in semantic body, not provenance; no semantic gold labels',before_calls:beforeCalls.length,after_calls:calls,known_cost_usd:cost,after_parse_success:replayed,after_parse_failed:failed,after_parse_failures:failures,before_persisted:beforeSaved.length,initial_after_persisted:initialSaved.length,after_persisted:persisted.length,raw_after_candidates:rawCandidates,nonempty_after_body:persisted.filter(s=>body(s.candidate).trim()).length,reported_verification_objects:persisted.filter(s=>s.candidate.observation?.reported_verification).length,storage_state:'quarantine, unverified, automatic promotion disabled',readback_exact_semantic_body_match:true,storage_redaction_held:storageHeld,source_sha256:plan.source_sha256,original_bodies_copied_to_repository:false,projects,examples,limits:{input_byte_upper_bound:2000,output_tokens:800,turn_calls:32,monthly_tokens:500000},production_writes:false,client_adapters:'Claude/Cursor synthetic hook/CLI regression; real historical sources are approved Codex sources',independent_tool_verification:'only matching completed successful tool event can support observed/verified outcome; no blanket claim of verified source reports'};
fs.writeFileSync(path.join(root,`response-replay-${revision}.json`),JSON.stringify(perCase,null,2),{flag:'wx',mode:0o600});fs.writeFileSync('artifacts/shared-extraction-20261019/summary.json',JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary));
