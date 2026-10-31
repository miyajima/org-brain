import { screenSensitiveMemory } from '../../../shared/src/memory-capture-v2-runtime.mjs';
import { createHash } from 'node:crypto';

export const CLASSIFIED_AUTO_POLICY = 'classified-auto/v2';
export const CLASSIFIED_PROVENANCE_LIMIT = 4096;
const classifiedInput = Symbol('classified-auto-input');
export const hasClassifiedAutoInput = input => input[classifiedInput] === true;
const hash = value => createHash('sha256').update(value).digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])) : value;
const key = value => JSON.stringify(stable(value));
const normalized = value => String(value??'').normalize('NFKC').replace(/\s+/gu,' ').trim();
const identityText = value => String(value??'');
const union = (...arrays) => [...new Map(arrays.flat().map(value=>[key(value),value])).values()];

const kinds = {
  success: ['fact', 'org_knowledge'],
  failure: ['pitfall'],
  decision: ['decision', 'constraint', 'preference']
};
const present = value => typeof value === 'string' && value.trim().length > 0;
const usefulPrimary=value=>present(value)&&!/^(?:未確認|不明|未定|unknown|none|null|n\/a)$/iu.test(value.trim());
export const classifiedAutoSaveEnabled = (env = process.env) => env.ORGBRAIN_MEMORY_AUTO_SAVE_CLASSIFIED !== 'false';

function usableUserText(text) {
  return !/[?？]|デメリット|どういう|できますか|かどうか|(?:テスト|架空)(?:用|の)?(?:入力|指示)|test prompt|fixture|```|^\s*>/imu.test(text);
}
function decisionSources(candidate,observation,sourcePacket) {
  if(sourcePacket?.snippets){
    const ordered=sourcePacket.snippets.filter(s=>!s.context_only).map((s,i)=>({...s,order:s.order??i})).sort((a,b)=>a.order-b.order);
    const messages=[];
    for(const snippet of ordered){
      const last=messages.at(-1);
      if(last&&snippet.parent_span_id&&last.parent_span_id===snippet.parent_span_id&&last.role===snippet.role&&last.source===snippet.source
          &&typeof last.end==='number'&&typeof snippet.start==='number'&&snippet.start<=last.end+2){
        last.text+=' '+snippet.text;last.span_ids.push(snippet.span_id);last.end=snippet.end;
      }else messages.push({...snippet,span_ids:[snippet.span_id]});
    }
    return messages;
  }
  // Transcript-verifier evidence binds the selector text to an observed user
  // message. A bare user_statement selector is not adoption evidence.
  const evidence=candidate.verification?.evidence??candidate.item?.evidence??candidate.evidence??[];
  return (observation.evidence_selectors??[]).filter(s=>s.type==='user_statement'&&typeof s.ref==='string'
    &&evidence.some(e=>e.type==='user_statement'&&e.attestation_ref==='transcript:user'
      &&String(e.ref).replace(/^sha256:/u,'')===hash(s.ref)))
    .map((s,i)=>({role:'user',source:'user',text:s.ref,span_id:s.ref,order:i}));
}
function decisionClassification(candidate,observation,primary,sourcePacket) {
  const sources=decisionSources(candidate,observation,sourcePacket);
  const claim=normalized(primary);
  const proposal=/提案|構成案|おすすめ|推奨|案(?:です|を|で|として)|\b(?:propos\w*|recommend\w*|could)\b/iu.test(primary);
  let chosen=null,chosenProposal=null,rejected=false;
  for(let i=0;i<sources.length;i++){
    const user=sources[i];if(user.role!=='user'||user.source==='tool_result'||!usableUserText(user.text))continue;
    const text=normalized(user.text),previous=sources[i-1];
    const unquoted=text.replace(/「[^」]*」|『[^』]*』|"[^"]*"|“[^”]*”|`[^`]*`/gu,' ');
    const directlyMatches=unquoted.includes(claim)&&/(?:採用|選択|決定|使って|してください|にして|にする|にします|実装して|適用したい|\b(?:use|choose|select|adopt)\b)/iu.test(unquoted);
    const linked=previous?.role==='assistant'&&normalized(previous.text).includes(claim);
    if((unquoted.includes(claim)||linked)&&/(?:採用しない|採用しません|却下|見送|やめて|\b(?:reject|do not adopt|don't adopt)\b)/iu.test(unquoted)){
      rejected=true;chosen=null;chosenProposal=null;continue;
    }
    const multipleOptions=previous&&/(?:[A-ZＡ-Ｚ１-９1-9]案|案[１２12]|\boption [ab12]\b|\balternatively\b|あるいは|または)/iu.test(previous.text);
    const accepts=linked&&!multipleOptions&&/(?:その(?:案|方針|構成|方式|方法)(?:を採用|で(?:進め|実装|お願い))|それで(?:進め|実装|お願い)|\b(?:adopt|approve) (?:that|the) proposal\b)/iu.test(unquoted);
    if(directlyMatches||accepts){chosen=user;chosenProposal=accepts&&!directlyMatches?previous:null;rejected=false;}
  }
  if(chosen&&chosen.text.length<=2000&&screenSensitiveMemory(chosen.text,{mode:'deny',allowed_principals:[]}).allowed
      &&(!chosenProposal||(chosenProposal.text.length<=2000&&screenSensitiveMemory(chosenProposal.text,{mode:'deny',allowed_principals:[]}).allowed)))
    return {kind:'decision',category:'adopted-decision',adoption_state:'explicit_user_choice',adoption_source:chosen,proposal_source:chosenProposal};
  if(rejected)return {kind:'fact',category:'proposal',adoption_state:'rejected'};
  if(proposal)return {kind:'fact',category:'proposal',adoption_state:'unconfirmed'};
  if(/見込み|仮説|推定|かもしれ|\b(?:hypothesis|might|estimate)\b/iu.test(primary))return {kind:'fact',category:'hypothesis',adoption_state:'not_asserted'};
  return {kind:'fact',category:'source-report',adoption_state:'not_asserted'};
}

// Classification admission does not attest the truth or execution of a lesson.
// The extraction/turn verifiers and exact-body screening run before this point.
export function classifiedMemoryInput(candidate, { tenantId, projectId, taskKey, sourcePacket }) {
  const observation = candidate.observation ?? candidate.item?.learning;
  const allowed = candidate.persistence === 'operational_history' && kinds[observation?.lesson_type]
    ? ['episodic'] : kinds[observation?.lesson_type];
  const primary = observation?.lesson_type === 'success' ? observation.procedure ?? observation.conclusion
    : observation?.lesson_type === 'failure' ? observation.symptom ?? observation.failed_approach ?? observation.root_cause ?? observation.correction ?? observation.conclusion
    : observation?.decision ?? observation?.selected_value ?? observation?.conclusion;
  let kind = candidate.memory_kind ?? candidate.item?.kind ?? observation?.kind ?? allowed?.[0];
  const reasons = [...(candidate.reason_codes ?? []), ...(candidate.gaps ?? []), ...(observation?.gaps ?? [])];
  if (!projectId || candidate.item?.project_id && candidate.item.project_id !== projectId || !allowed?.includes(kind) || !usefulPrimary(primary)
      || reasons.some(reason => /(?:classif|lesson_type|memory_kind)/iu.test(reason) && /(?:ambiguous|unclear|unknown|mismatch|missing|invalid)/iu.test(reason))) return null;
  if (candidate.action && candidate.action !== 'create') return null;
  const screened = screenSensitiveMemory(JSON.stringify(observation), { mode: 'deny', allowed_principals: [] });
  if (!screened.allowed) return { held: true, reason_code: screened.reason ?? 'sensitive_content_rejected' };
  const classification=observation.lesson_type==='decision'
    ? decisionClassification(candidate,observation,primary,sourcePacket)
    : {kind,category:observation.lesson_type==='failure'?'failure-report':'success-report',adoption_state:'not_asserted'};
  if(candidate.persistence!=='operational_history')kind=classification.kind;
  const fields = ['procedure', 'why_it_worked', 'observed_outcome', 'reuse_when', 'decision', 'selected_value',
    'rationale', 'constraints', 'symptom', 'failed_approach', 'root_cause', 'correction', 'verified_outcome', 'avoidance_rule',
    'trigger', 'conclusion', 'outcome', 'reuse_rule'];
  const content = fields.flatMap(key => {
    const value = observation[key];
    const label=observation.lesson_type==='decision'&&kind==='fact'&&['decision','selected_value','conclusion'].includes(key)?'reported_statement':key;
    return present(value) ? [`${label}: ${value}`] : Array.isArray(value) && value.length ? [`${label}: ${value.join('\n')}`] : [];
  });
  if(classification.category==='proposal')content.unshift(classification.adoption_state==='rejected'?'提案（不採用の意思表示あり）':'提案（採用・実装は未確認）');
  else if(observation.lesson_type==='decision')content.unshift(kind==='decision'?'原文で確認できるユーザーの判断（実装完了は別途確認）':'出典中の説明・見込み（採用済みの判断ではない）');
  if(classification.adoption_source)content.push(`採用時の条件を含むユーザー原文: ${classification.adoption_source.text}`);
  if(classification.proposal_source)content.push(`採用対象の提案と適用条件: ${classification.proposal_source.text}`);
  if (present(observation.reported_verification?.text)) content.push(`reported_verification (unverified): ${observation.reported_verification.text}`);
  if (content.join('\n').length > 20_000) return { held: true, reason_code: 'storage_body_too_large' };
  const sourceReferences=[...(candidate.item?.source_references ?? candidate.source_references
    ?? (candidate.support_span_ids?.length ? candidate.support_span_ids.map(ref => ({ type: 'turn_evidence', ref:sourcePacket?`${taskKey??candidate.external_key}#${ref}`:ref,...(sourcePacket?.source_hash?{content_hash:sourcePacket.source_hash}:{}) }))
      : (observation.evidence_selectors ?? []).map(selector => ({ type: selector.type, ref: selector.ref, ...(selector.digest ? {content_hash:selector.digest} : {}) }))))];
  if(classification.adoption_source){
    for(const span of classification.adoption_source.span_ids??[classification.adoption_source.span_id])sourceReferences.push({type:'user_statement',ref:sourcePacket?`${taskKey??candidate.external_key}#${span}`:`sha256:${hash(classification.adoption_source.text)}`,...(sourcePacket?.source_hash?{content_hash:sourcePacket.source_hash}:{})});
  }
  if(classification.proposal_source){
    for(const span of classification.proposal_source.span_ids??[classification.proposal_source.span_id])sourceReferences.push({type:'turn_evidence',ref:`${taskKey??candidate.external_key}#${span}`,...(sourcePacket?.source_hash?{content_hash:sourcePacket.source_hash}:{})});
  }
  let learning={...observation};
  if(classification.adoption_source)learning.adoption_statement=classification.adoption_source.text;
  if(classification.proposal_source)learning.proposal_statement=classification.proposal_source.text;
  if(observation.lesson_type==='decision'&&kind==='fact'){
    const {lesson_type,decision,selected_value,decision_type,decision_key,kind:originalKind,conclusion,outcome,...report}=observation;
    learning={...report,record_type:'source_report',original_lesson_type:lesson_type,reported_statement:primary};
  }
  learning.contract_metadata={...learning.contract_metadata,classification_policy:CLASSIFIED_AUTO_POLICY,
    category:classification.category,adoption_state:classification.adoption_state};
  return {
    [classifiedInput]:true,
    tenant_id: tenantId, project_id: projectId, work_type: candidate.item?.work_type ?? 'implementation',
    business_category_id: candidate.item?.business_category_id ?? null,
    kind, lifecycle_state: 'active', scope_type: 'project', scope_key: projectId,
    source: 'classified-auto', external_key: candidate.external_key,
    summary: primary, content: content.join('\n'), learning,
    rationale: observation.why_it_worked ?? observation.rationale ?? observation.root_cause,
    reuse_rule: observation.reuse_when ?? observation.avoidance_rule,
    source_references:union(sourceReferences),
    evidence: candidate.item?.evidence ?? candidate.evidence ?? [],
    capture_origin: 'observed', capture_route: 'realtime_hook',
    // Existing verifier results are not upgraded by classification alone.
    verification_state: 'unverified', verified_at: null,
    tags: ['classified-auto', classification.category],
    capture_batch_id: taskKey, valid_until: candidate.expires_at ?? null
  };
}

export function isClassifiedAuto(input){return input.learning?.contract_metadata?.classification_policy===CLASSIFIED_AUTO_POLICY;}

export function classifySourceMemory(input,{snapshot,candidate}){
  if(!usefulPrimary(input.content))throw Error('classification_ambiguous');
  const selected=snapshot.snippets?.filter(s=>candidate.support_refs.includes(s.span_id??s.id))??[];
  const observation={schema_version:2,lesson_type:'decision',decision:input.content,rationale:input.rationale,reuse_when:input.reuse_rule};
  const classification=decisionClassification({},observation,input.content,{snippets:selected});
  const kind=classification.category==='adopted-decision'?'decision':input.kind==='pitfall'?'pitfall':'fact';
  const heading=classification.category==='proposal'?(classification.adoption_state==='rejected'?'提案（不採用の意思表示あり）\n':'提案（採用・実装は未確認）\n')
    :kind==='fact'&&['decision','constraint','preference'].includes(input.kind)?'出典中の説明（採用済みの判断ではない）\n':'';
  const adoption=classification.adoption_source;
  const proposal=classification.proposal_source;
  const content=heading+input.content+(adoption?`\n採用時の条件を含むユーザー原文: ${adoption.text}`:'')+(proposal?`\n採用対象の提案と適用条件: ${proposal.text}`:'');
  if(content.length>20_000)throw Error('classified_content_too_large');
  return {...input,[classifiedInput]:true,kind,content,canonical_key:null,
    source_references:union(input.source_references??[],adoption?(adoption.span_ids??[adoption.span_id]).map(ref=>({type:'user_statement',ref,content_hash:snapshot.source_hash})):[]),
    learning:{...input.learning,...(adoption?{adoption_statement:adoption.text}:{}),...(proposal?{proposal_statement:proposal.text}:{}),contract_metadata:{...input.learning?.contract_metadata,
      classification_policy:CLASSIFIED_AUTO_POLICY,category:classification.category,adoption_state:classification.adoption_state}},
    tags:union(input.tags??[],['classified-auto',classification.category])};
}

// Only identical content AND conditions can merge. Provenance is accumulated;
// adoption status, project/work scope and verification state remain separate.
export function mergeClassifiedAutoInput(db,input){
  const metadata=input.learning.contract_metadata;
  const identity=hash(key({policy:CLASSIFIED_AUTO_POLICY,tenant:input.tenant_id??'default',project:input.project_id,
    work_type:input.work_type??null,business_category_id:input.business_category_id??null,
    scope_type:input.scope_type??'project',scope_key:input.scope_key??input.project_id,
    capture_origin:input.capture_origin??'legacy',valid_from:input.valid_from??null,
    kind:input.kind,category:metadata.category,adoption:metadata.adoption_state,
    content:identityText(input.content),rationale:identityText(input.rationale),reuse:identityText(input.reuse_rule),
    applicability:input.learning.applicability??null,permissions:input.permissions??[],
    verification_state:input.verification_state??'unverified'}));
  const current=db.prepare(`SELECT * FROM memories WHERE tenant_id=? AND project_id=?
    AND lifecycle_state='active' AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at>?)
    AND CASE WHEN json_valid(learning_json) THEN json_extract(learning_json,'$.contract_metadata.classification_identity') END=?
    ORDER BY updated_at DESC LIMIT 1`).get(input.tenant_id??'default',input.project_id,Date.now(),identity);
  const occurrence={source:input.source,external_key:input.external_key,capture_batch_id:input.capture_batch_id??null};
  const next={...input,canonical_key:null,learning:{...input.learning,contract_metadata:{...metadata,classification_identity:identity,
    occurrences:[occurrence]}}};
  if(!current)return next;
  const refs=union(JSON.parse(current.source_refs_json??'[]'),input.source_references??[]);
  const evidence=union(JSON.parse(current.evidence_json??'[]'),input.evidence??[]);
  if(refs.length>CLASSIFIED_PROVENANCE_LIMIT||evidence.length>CLASSIFIED_PROVENANCE_LIMIT)return next;
  const previousLearning=JSON.parse(current.learning_json);
  return {...next,id:current.id,source:current.source,external_key:current.external_key,created_at:current.created_at,
    valid_until:current.valid_until,expires_at:current.expires_at,source_references:refs,evidence,
    tags:union(JSON.parse(current.tags_json??'[]'),input.tags??[]),
    learning:{...previousLearning,contract_metadata:{...previousLearning.contract_metadata,
      occurrences:union(previousLearning.contract_metadata?.occurrences??[],[occurrence])}}};
}
