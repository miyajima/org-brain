// Offline paired replay of already approved assistant-final inputs. Never enqueue
// or promote memory. Raw inputs and candidates remain in the private output.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {extractDurableMemoryDrafts as after} from '../packages/shared/src/memory-capture-v2-runtime.mjs';
import {MEMORY_CAPTURE_HOOK_PROFILE} from '../packages/shared/src/memory-capture-profile.generated.mjs';
import {verifiedCandidates as verifyAfter} from '../packages/shared/src/memory-extraction-verifier-runtime.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((rows, value, index, all) => {
  if (index % 2 === 0) rows.push([value.replace(/^--/, ''), all[index + 1]]);
  return rows;
}, []));
for (const key of ['corpus', 'baseline-dir', 'private-output', 'summary-output']) if (!args[key]) throw new Error(`missing:${key}`);
for (const key of ['private-output', 'summary-output']) if (fs.existsSync(args[key])) throw new Error(`output_exists:${key}`);
globalThis.fetch = () => { throw new Error('offline_evaluation_network_forbidden'); };
const {extractDurableMemoryDrafts: before} = await import(pathToFileURL(path.join(args['baseline-dir'], 'packages/shared/src/memory-capture-v2-runtime.mjs')));
const {verifiedCandidates: verifyBefore} = await import(pathToFileURL(path.join(args['baseline-dir'], 'packages/shared/src/memory-extraction-verifier-runtime.mjs')));
const bytes = fs.readFileSync(args.corpus);
const corpus = JSON.parse(bytes);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const allowed = new Set(['consentside','org-brain','AIma','socia','sfk-shinsa','jrg','factoreview','smart-block','tsugi']);
const canonical = text => String(text ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
const inputs = new Map();
for (const row of corpus) {
  if (!allowed.has(row.project)) throw new Error('project_out_of_scope');
  for (const input of row.task_inputs ?? []) {
    if (input.role !== 'assistant') continue;
    const id = sha(`${row.project}\0${input.evidence_id}`);
    if (inputs.has(id) && inputs.get(id).text !== input.verbatim) throw new Error('conflicting_input');
    inputs.set(id, {id, project: row.project, text: input.verbatim});
  }
}
const patterns = {
  reason: /(?:\b(?:reason|rationale|because|root cause)\b|理由|なぜなら|原因は)/iu,
  exception_condition: /(?:\b(?:if|when|unless|except|only|never|must not)\b|ただし|但し|例外|条件|場合|禁止|のみ)/iu,
  reported_verification: /(?:\b(?:tests? passed|passed|verified|verification|failures?|skipped)\b|検証|確認済み|未確認|成功|失敗)/iu
};
function units(text) {
  return text.split(/\r?\n/u).map(line => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/u, '').trim())
    .filter(line => line && !/^#{1,6}\s/u.test(line)).flatMap(line => Object.entries(patterns)
      .filter(([, pattern]) => pattern.test(line)).map(([facet]) => ({facet, text: canonical(line.replace(/^(?:reason|rationale|reuse(?: rule)?|applicability|conditions?|exceptions?|evidence|理由|根拠|条件|例外|再利用条件|適用条件)\s*[:：]\s*/iu, ''))})));
}
function countRetention(drafts, sourceUnits) {
  // Do not credit provenance, tags, gaps or a referenced source as retained lesson text.
  const content = drafts.map(d => canonical([d.content,d.rationale,d.reuse_rule,d.reported_verification?.text].filter(Boolean).join(' ')));
  return Object.fromEntries(Object.keys(patterns).map(facet => [facet, sourceUnits.filter(u => u.facet === facet && content.some(c => c.includes(u.text))).length]));
}
const privateRows = [];
const projects = Object.fromEntries([...allowed].map(p => [p, {inputs:0, hard_excluded:0, source_units:Object.fromEntries(Object.keys(patterns).map(k=>[k,0])), before:{drafts:0,review_drafts:0,retained:{reason:0,exception_condition:0,reported_verification:0}}, after:{drafts:0,review_drafts:0,retained:{reason:0,exception_condition:0,reported_verification:0}}}]));
const verifierProbes = Object.fromEntries([...allowed].map(p => [p, {multi_quote_checks:0,before_multi_quote_retained:0,after_multi_quote_retained:0,
  drop_checks:0,before_silent_drop:0,after_silent_drop:0,after_drop_rejected:0,
  reported_result_checks:0,before_unproven_outcome_accepted:0,after_unproven_outcome_accepted:0}]));
for (const input of inputs.values()) {
  const params = {event_id:`offline:${input.id}`,tenant_id:'default',project_id:input.project,source:'codex',occurred_at:1786000000000,text:input.text};
  const options = {sensitive_policy:{mode:'deny',allowed_principals:[]},capture_profile:MEMORY_CAPTURE_HOOK_PROFILE};
  const a = before(params, options), b = after(params, options);
  if (a.sensitivity.allowed !== b.sensitivity.allowed) throw new Error('safety_gate_changed');
  const stat = projects[input.project]; stat.inputs++;
  if (!a.sensitivity.allowed || a.excluded.some(x=>x.reason==='unsafe_instruction')) { stat.hard_excluded++; privateRows.push({id:input.id,project:input.project,hard_excluded:true});continue; }
  const sourceUnits = units(input.text);
  for (const u of sourceUnits) stat.source_units[u.facet]++;
  for (const [name,result] of [['before',a],['after',b]]) {
    stat[name].drafts += result.drafts.length;stat[name].review_drafts += result.review_drafts.length;
    const retained = countRetention([...result.drafts,...result.review_drafts], sourceUnits);
    for (const [facet,count] of Object.entries(retained)) stat[name].retained[facet] += count;
  }
  const lines = [...new Set(input.text.split(/\r?\n/u).map(s=>s.trim()).filter(s=>s && s.length<=400 && !/^#{1,6}\s/u.test(s)))];
  const probes = [];
  const verify = async fields => {
    const snippets = lines.slice(0,2).map((text,index)=>({span_id:`q${index}`,role:'assistant',source:'assistant',text}));
    const request = {project_id:input.project,run_id:input.id,packet:{schema:'learning-extraction-proposal/v2',snippets,events:[]}};
    const candidate = {lesson_type:'success',support_span_ids:snippets.map(s=>s.span_id),fields,gaps:[]};
    return [await verifyBefore(request,[candidate]),await verifyAfter(request,[candidate])];
  };
  const vp = verifierProbes[input.project];
  if (lines.length>=2) {
    const multi = await verify([{name:'procedure',values:lines.slice(0,2)}]);
    vp.multi_quote_checks++;
    for (const [index,name] of ['before','after'].entries()) {
      if (multi[index].candidates.some(c=>lines.slice(0,2).every(line=>canonical(c.observation.procedure).includes(canonical(line))))) vp[`${name}_multi_quote_retained`]++;
    }
    const drop = await verify([{name:'procedure',values:[lines[0]]},{name:'exceptions',values:[lines[1]]}]);
    vp.drop_checks++;
    for (const [index,name] of ['before','after'].entries()) {
      if (drop[index].candidates.some(c=>!canonical([c.observation.procedure,c.observation.reuse_when].join(' ')).includes(canonical(lines[1])))) vp[`${name}_silent_drop`]++;
    }
    if (!drop[1].candidates.length) vp.after_drop_rejected++;
    probes.push({type:'multi_quote',results:multi},{type:'dropped_field',results:drop});
  }
  const report = lines.find(line=>patterns.reported_verification.test(line));
  if (report) {
    // Deliberate negative control: these source inputs have no tool result.
    const snippets = [{span_id:'report',role:'assistant',source:'assistant',text:report}];
    const request = {project_id:input.project,run_id:input.id,packet:{schema:'learning-extraction-proposal/v2',snippets,events:[]}};
    const candidate = {lesson_type:'success',support_span_ids:['report'],fields:[{name:'observed_outcome',values:[report]}],gaps:[]};
    const results=[await verifyBefore(request,[candidate]),await verifyAfter(request,[candidate])];
    vp.reported_result_checks++;vp.before_unproven_outcome_accepted+=Number(results[0].candidates.length>0);vp.after_unproven_outcome_accepted+=Number(results[1].candidates.length>0);
    probes.push({type:'unproven_outcome',results});
  }
  privateRows.push({...input,source_units:sourceUnits,before:a,after:b,verifier_probes:probes});
}
const summary = {schema:'orgbrain-extraction-retention-replay/v1', corpus_sha256:sha(bytes), inputs:inputs.size, projects,
  verifier_probes:verifierProbes, verifier_probe_design:'controlled exact-quote candidates from real safe inputs; not model-generated candidates or semantic-quality labels',
  before_source_sha256:sha(fs.readFileSync(path.join(args['baseline-dir'],'packages/shared/src/memory-capture-v2-runtime.mjs'))),
  after_source_sha256:sha(fs.readFileSync(new URL('../packages/shared/src/memory-capture-v2-runtime.mjs', import.meta.url))),
  evaluation_stage:'actual_deterministic_rule_output_and_review_drafts', provider_calls:0, memory_writes:0,
  verified_execution_results:0, labels:'mechanical exact full-line matching, not human gold or semantic recall',
  caveats:['Review drafts are not persisted memories.','Reported verification is assistant text, not independent execution evidence.','No model output quality, live enqueue, deployment or production activation is established.','AIma has no acquired input.']};
fs.mkdirSync(path.dirname(args['private-output']),{recursive:true,mode:0o700});
fs.writeFileSync(args['private-output'],JSON.stringify(privateRows,null,2),{mode:0o600,flag:'wx'});
fs.writeFileSync(args['summary-output'],JSON.stringify(summary,null,2)+'\n',{mode:0o600,flag:'wx'});
console.log(JSON.stringify(summary));
