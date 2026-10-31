"""Audit real delta runs without starting a model; host actions are never native model calls."""
import hashlib,importlib.util,json,shlex,sqlite3,time,statistics
from pathlib import Path

spec=importlib.util.spec_from_file_location('prior_report',Path(__file__).with_name('memory-task-confirmation-report.py'));p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
REPO=p.REPO;ROOT=REPO/'artifacts/memory-task-delta-20261030';LEDGER=p.LEDGER;CHANNEL='task_delta_v2';MODEL=p.MODEL
load=p.load;rows=p.rows;save=p.save;digest=p.digest
def js_digest(value):return hashlib.sha256(json.dumps(value,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()

def materialize(state,x):
 if x['op']!='patch':return x
 allowed=state['allowed_units']
 if len(x['units'])!=len(allowed) or set(x['units'])!=set(allowed) or set(x['sections'])!=set(allowed):raise ValueError('patch_scope_mismatch')
 return {'op':'write','units':state['requested_units'],'sections':{u:x['sections'][u] if u in allowed else state['prior']['sections'][u] for u in state['requested_units']}}

def context_verified(state,context,backend):
 source=state['local']['source'];bound={k:source[k] for k in ['input','output','field','source_fingerprint']}
 return source['digest']==js_digest(bound) and source['source_fingerprint']==state['source_fingerprint'] and set(source['input']['units'])==set(state['allowed_units']) and state['local']['delivered_digest']==js_digest(context) and backend['args']==source['input'] and backend['result']==source['output']

def audit(a,provenance):
 d=ROOT/'runs'/a['id'];ev=rows(d/'events.jsonl');state=load(next((d/'reuse/task-confirmations').glob('*.json')));config=load(d/'config.json');result=load(d/'result.json');calls=load(d/'calls.json');answers=load(d/'simulated-answers.json')
 native=[b for e in ev if e.get('type')=='assistant' for b in e.get('message',{}).get('content',[]) if b.get('type')=='tool_use'];outputs={b['tool_use_id']:(i,b,e.get('tool_use_result')) for i,e in enumerate(ev) if e.get('type')=='user' for b in e.get('message',{}).get('content',[]) if b.get('type')=='tool_result'};positions={b['id']:i for i,e in enumerate(ev) if e.get('type')=='assistant' for b in e.get('message',{}).get('content',[]) if b.get('type')=='tool_use'}
 questions=[b for b in native if b['name']=='AskUserQuestion'];bash=[b for b in native if b['name']=='Bash'];checks={};requests=[];expected_backend=[]
 checks['provider_model']=list(result.get('modelUsage',{}))==[MODEL]
 model=result.get('modelUsage',{}).get(MODEL,{})
 bins=['inputTokens','cacheCreationInputTokens','cacheReadInputTokens','outputTokens']
 checks['whole_call_usage']=all(type(model.get(k)) is int and model[k]>=0 for k in bins) and a['total_tokens']==sum(model.get(k,0) for k in bins)
 checks['success']=a.get('success') and result.get('subtype')=='success' and not result.get('is_error') and not a['hook_errors']
 checks['canonical_native_arguments']=True
 for b in bash:
  try:
   argv=shlex.split(b['input']['command']);assert len(argv)==4 and argv[:3]==shlex.split(a['argv'][a['argv'].index('--allowedTools')+1].removeprefix('Bash(').removesuffix(' *)'))
   request=json.loads(argv[3]);out=outputs[b['id']][1];value=json.loads(out['content']);private=load(d/'reuse/invocations'/(value['reuse_invocation_id']+'.json'))
   assert private['request']==request and private['output']==value and private['native_call_id']==b['id'] and not out.get('is_error')
   requests.append(request['input']);expected_backend.append(materialize(state,request['input']))
  except (AssertionError,KeyError,ValueError,FileNotFoundError):checks['canonical_native_arguments']=False
 reads=[u for c in calls if c['args']['op']=='read' for u in c['args']['units']]
 writes=[c for c in calls if c['args']['op']=='write'];checks['one_successful_write']=len(writes)==1 and all(c['result'].get('ok') for c in calls)
 artifact=writes[-1]['result'].get('artifact',{}) if writes else {};sections=artifact.get('sections',{});source=load(d/'source.json')[a['kind']]
 checks['required_meaning']=p.accepts(a['kind'],a['units'],sections,source)
 checks['actual_deliverable']=bool(artifact.get('path')) and digest(d/artifact['path'])==artifact.get('sha256') and all(v in (d/artifact['path']).read_text() for v in sections.values())
 checks['native_output_proof']=len(state['created_results'])==1 and state['created_results'][0]['content_digest']==artifact.get('sha256') and state['created_results'][0]['native_call_id'] in outputs
 if a['condition']=='control':
  checks['fresh_scope']=state['choice']=='full' and set(reads)==set(a['units']) and not state.get('prior') and not questions and not state.get('local')
 else:
  checks['delta_scope']=state['choice']=='delta' and state['allowed_units']==['c'] and reads==['c']
  prior=state['prior'];proof=next(x for x in provenance if x['kind']==a['kind']);old=load(REPO/proof['evidence_path']/'outcome.json')
  checks['actual_prior_model_result']=prior['id']==proof['artifact_id']==old['task_completion']['artifact_id'] and proof['native_call_id']==old['task_completion']['native_call_id'] and old['success'] and list(old['model_usage'])==[MODEL] and old['native_arguments_match']
  checks['prior_bytes']=digest(d/prior['path'])==prior['content_digest']
  checks['preserved_prior_sections']=p.delta_valid(a['units'],['c'],prior['sections'],sections,reads)
  with sqlite3.connect(d/'evidence.sqlite') as db:
   row=db.execute('select principal,fingerprint,created_at,refs_json,action_ref from memory_reuse_artifacts where id=?',(prior['id'],)).fetchone()
   grant=db.execute('select 1 from memory_reuse_artifact_grants where artifact_id=? and principal=?',(prior['id'],a['principal'])).fetchone()
  checks['permission_version_fingerprint_expiry']=bool(row and (row[0]==a['principal'] or grant) and row[1]==state['source_fingerprint'] and 0<=state['created_at']-row[2]<=config['task_workflows'][a['kind']]['valid_for_ms'] and json.loads(row[3])==config['task_workflows'][a['kind']]['source_refs'] and row[4]==proof['native_call_id'])
  if a['condition']=='current':
   checks['one_native_question']=len(questions)==len(answers)==1
   if len(questions)==len(answers)==1:
    q=questions[0];sim=answers[0];actual=outputs.get(q['id'],(None,{},None))[2]
    checks['native_answer_proof']=sim['tool_use_id']==q['id']==state['answer_evidence']['call_id'] and sim['answer']=='差分だけ実施' and not q['input'].get('answers') and isinstance(actual,dict) and actual.get('answers',{}).get(sim['question']['question'])==sim['answer']
    checks['no_work_before_answer']=all(positions[b['id']]>outputs[q['id']][0] for b in bash)
  else:
   local=state['local'];receipt=load(d/'reuse/local-launch.json');pre=load(d/'pre-model.json')
   checks['local_answer_no_native_question']=not questions and not answers and state['decision_source']=='simulated_local_user' and local['decision']['answer']=='差分だけ実施' and receipt['model_starts']==0 and receipt['human_wait_ms']==0 and pre['returncode']==0
   bound={'session_id':state['session_id'],'scope':state['scope'],'workflow_id':state['workflow_id'],'requested_units':state['requested_units'],'allowed_units':state['allowed_units'],'choice':state['choice'],'source_fingerprint':state['source_fingerprint'],'prior_id':state['prior']['id'],'prompt_digest':local['prompt_digest'],'decision':local['decision']}
   checks['decision_bound']=local['decision_digest']==js_digest(bound) and local['prompt_digest']==js_digest((d/'prompt.txt').read_text()) and receipt['session_id']==state['session_id'] and 0<=local['consumed_at']-local['created_at']<=30*60000
   contexts=[]
   for e in ev:
    if e.get('subtype')=='hook_response' and e.get('hook_event')=='UserPromptSubmit':
     try:contexts.append(json.loads(e['stdout'])['hookSpecificOutput']['additionalContext'])
     except (ValueError,KeyError):pass
   checks['actual_context_delivery']=len(contexts)==1 and bool(calls) and context_verified(state,contexts[0],calls[0])
   journal=[row for f in (d/'reuse/native-evidence').glob('*.jsonl') for row in rows(f) if row.get('payload',{}).get('type')=='host_task_context']
   checks['host_route_separate']=len(journal)==1 and journal[0]['payload']['source_receipt_id']==local['source']['id'] and journal[0]['payload']['local_confirmation_id']==local['decision']['id'] and journal[0]['payload']['delivered_context_digest']==local['delivered_digest']
   checks['only_native_patch']=len(requests)==1 and requests[0]['op']=='patch' and requests[0]['units']==['c']
   expected_backend.insert(0,local['source']['input'])
 checks['actual_backend_operations']=expected_backend==[c['args'] for c in calls]
 with sqlite3.connect(d/'evidence.sqlite') as db:
  checks['verified_current_sources']=all(db.execute("select 1 from memories where id=? and current_version=? and verification_state='verified' and deleted_at is null",(ref['source_id'],ref['source_version'])).fetchone() for ref in config['task_workflows'][a['kind']]['source_refs'])
  checks['no_false_original_use']=db.execute('select count(*) from memory_reuse_applications').fetchone()[0]==0
 return {'id':a['id'],'label':a['label'],'condition':a['condition'],'pass':all(checks.values()),'checks':checks}

def aggregate(items):
 fields=['total_tokens','total_ms','api_equivalent_usd','setup_ms','cli_ms','questions','native_bash_calls','host_read_calls','read_calls','write_calls','model_responses']
 if any(x.get(k) is None for x in items for k in fields):return {'n':len(items),'status':'missing_measurement'}
 return {'n':len(items),**{k:sum(x[k] for x in items) for k in fields},'read_unit_count':sum(len(x['read_units']) for x in items),'usage':{k:sum(x['usage'][k] for x in items) for k in ['input_tokens','cache_creation_input_tokens','cache_read_input_tokens','output_tokens']}}

def matched(triple):
 configs=[];fingerprints=[]
 for a in triple:
  d=ROOT/'runs'/a['id'];config=load(d/'config.json')
  for key in ['db_path','task_local_mode','task_confirmation_mode']:config.pop(key,None)
  init=next(e for e in rows(d/'events.jsonl') if e.get('subtype')=='init')
  configs.append(config);fingerprints.append((a['runtime_manifest_sha256'],digest(d/'source.json'),load(d/'case.json'),a['principal'],a['argv'][a['argv'].index('--system-prompt')+1],init.get('claude_code_version'),init.get('tools')))
 return configs[1:]==configs[:-1] and fingerprints[1:]==fingerprints[:-1]

def main():
 started=time.monotonic();ledger=load(LEDGER);attempts=[x for x in ledger if x.get('channel')==CHANNEL];provenance=load(ROOT/'prior-result-provenance.json');audits=[]
 for a in attempts:
  if a.get('status')=='started':continue
  try:audits.append(audit(a,provenance))
  except (KeyError,ValueError,FileNotFoundError,StopIteration,IndexError) as error:audits.append({'id':a['id'],'label':a['label'],'condition':a['condition'],'pass':False,'error':type(error).__name__+': '+str(error)})
 save(ROOT/'audit.json',audits);conditions=['control','current','improved'];triples=[]
 for case in load(ROOT/'cases.json'):
  triple=[next((x for x in attempts if x.get('phase')=='comparison' and x.get('case')==case['id'] and x['condition']==condition and x.get('success')),None) for condition in conditions]
  if all(triple):triples.append(triple)
 groups={c:aggregate([t[i] for t in triples]) for i,c in enumerate(conditions)}
 changes={}
 if triples:
  for c in ['current','improved']:
   changes[c]={k:(groups[c][k]/groups['control'][k]-1)*100 for k in ['total_tokens','total_ms','api_equivalent_usd']}
 selected_ids={a['id'] for triple in triples for a in triple};comparison_audits=[x for x in audits if x['id'] in selected_ids]
 comparison_complete=len(triples)==10 and len(comparison_audits)==30 and all(x['pass'] for x in comparison_audits) and all(matched(t) for t in triples)
 plan=load(ROOT/'post-review-plan.json') if (ROOT/'post-review-plan.json').exists() else {}
 supplemental=[x for x in audits if x['id'] not in selected_ids];expected_canaries=plan.get('supplemental_starts',0)+plan.get('serial_validation_starts',0)
 complete=comparison_complete and len(supplemental)>=expected_canaries and all(x['pass'] for x in supplemental)
 report={'status':'complete' if complete else 'incomplete_or_failed','model':MODEL,'effort':'medium','additional_starts':len(attempts),'cumulative_starts':len(ledger),'matched_triples':len(triples),'matched_conditions':all(matched(t) for t in triples),'audit_passed':sum(x['pass'] for x in audits),'audit_total':len(audits),'groups':groups,'change_vs_control_pct':changes,'by_group':{g:{c:aggregate([x for t in triples for x in t if x['condition']==c and x['group']==g]) for c in conditions} for g in ['personal','team']},'all_starts':aggregate(attempts),'all_api_equivalent_usd':sum(x['api_equivalent_usd'] for x in attempts) if all(x.get('api_equivalent_usd') is not None for x in attempts) else None,'prior_creation_already_charged_usd':sum(x['original_api_equivalent_usd'] for x in provenance),'real_human_wait_ms':None,'actual_billing_usd':None,'parent_implementation_and_audit_cost':None,'offline_audit_ms':(time.monotonic()-started)*1000,'cloud_deploy':False}
 if complete:report['meets_efficiency_goal']=all(changes['improved'][k]<0 for k in ['total_tokens','total_ms'])
 report['comparison_phase_complete']=comparison_complete
 report['post_review_canaries']={'audit_passed':sum(x['pass'] for x in supplemental),'audit_total':len(supplemental),'costs':aggregate([x for x in attempts if x.get('phase')=='validation_canary'])}
 report['post_review_canaries']['note']='These first three canaries overlapped local regression tests. Retain their wall time/cost but do not use them as a clean performance replication.'
 serial=[x for x in attempts if x.get('phase')=='serial_validation_canary']
 report['serial_validation_canaries']={'groups':{c:aggregate([x for x in serial if x['condition']==c]) for c in conditions},'runs':[{k:x.get(k) for k in ['id','label','condition','total_tokens','total_ms','setup_ms','cli_ms','api_equivalent_usd']} for x in serial]}
 if len(serial)==3:
  sa=report['serial_validation_canaries']['groups']['control'];sb=report['serial_validation_canaries']['groups']['improved'];report['serial_validation_canaries']['change_vs_control_pct']={k:(sb[k]/sa[k]-1)*100 for k in ['total_tokens','total_ms','api_equivalent_usd']};report['serial_validation_canaries']['matched']=matched([next(x for x in serial if x['condition']==c) for c in conditions])
 report['by_kind']={kind:{c:aggregate([x for t in triples for x in t if x['condition']==c and x['kind']==kind]) for c in conditions} for kind in ['research','analysis','document']}
 report['comparison_audit_passed']=sum(x['pass'] for x in comparison_audits);report['comparison_audit_total']=len(comparison_audits)
 report['pairs']=[{'case':t[0]['case'],'kind':t[0]['kind'],'group':t[0]['group'],'matched':matched(t),'runs':{x['condition']:{k:x[k] for k in ['id','label','total_tokens','usage','total_ms','setup_ms','cli_ms','api_equivalent_usd','model_responses','native_bash_calls','host_read_calls','read_units','questions']} for x in t}} for t in triples]
 report['overhead_accounting']={'local_search_confirmation_and_source_preparation':'included in setup_ms and total_ms for improved runs','context_injection_hash_checks_tracking_merge':'included in CLI wall time and all four model token bins; no separate model calls','human_wait':'simulated zero wait; actual human wait and adoption unobserved','prior_creation':'0.0597015 USD already counted in prior experiment; not charged again','global_fixture_copy_runtime_freeze_and_implementation_checks':'preparation outside paired task; no model starts; CPU time/money not separately measured','parent_implementation_and_audit_money':None,'invoice':None}
 if complete:
  old=load(REPO/'artifacts/memory-task-confirmation-20261029/report.json')['preparation'];allocation={k:groups['improved'][k]+old[{'total_tokens':'tokens','total_ms':'total_ms','api_equivalent_usd':'api_equivalent_usd'}[k]] for k in ['total_tokens','total_ms','api_equivalent_usd']}
  allocation['change_vs_control_pct']={k:(allocation[k]/groups['control'][k]-1)*100 for k in ['total_tokens','total_ms','api_equivalent_usd']};allocation['note']='Reference allocation of prior measured creation cost from the previous experiment, not a new creation run or actual invoice.';report['prior_creation_allocation_reference']=allocation
  report['paired_improvement_checks']={k:{'better_cases':sum(t[2][k]<t[0][k] for t in triples),'median_change_pct':statistics.median((t[2][k]/t[0][k]-1)*100 for t in triples)} for k in ['total_tokens','total_ms']}
  states=[load(next((ROOT/'runs'/t[2]['id']/'reuse/task-confirmations').glob('*.json'))) for t in triples]
  report['reuse_counts']={'distinct_completed_results':len({s['prior']['id'] for s in states}),'result_task_pairs':len({(s['prior']['id'],s['task_id']) for s in states}),'cross_principal_simulated_team_reuses':sum(s['prior']['owner']!=s['scope']['principal_id'] for s in states),'reused_units':sum(len(s['requested_units'])-len(s['allowed_units']) for s in states),'original_model_memory_use_claims':0}
 save(ROOT/'report.json',report);print(json.dumps(report,ensure_ascii=False,indent=2))
 for x in audits:
  if not x['pass']:print('FAILED_AUDIT',x['label'],x.get('error') or [k for k,v in x.get('checks',{}).items() if not v])

if __name__=='__main__':main()
