"""Independent artifact/native-call audit; never launches a model or reads reasoning blocks."""
import hashlib, json, re, shlex, sqlite3, time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
ROOT = REPO / 'artifacts/memory-task-confirmation-20261029'
LEDGER = REPO / 'artifacts/memory-reuse-loop-20261026/attempts.json'
CHANNEL = 'task_confirmation_v1'
MODEL = 'claude-sonnet-5-5'
LABELS = {'existing':'既存成果で完了','delta':'差分だけ実施','full':'全体を実施'}
def load(p): return json.loads(p.read_text())
def rows(p): return [json.loads(s) for s in p.read_text().splitlines() if s.strip()]
def digest(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def save(p, x): p.write_text(json.dumps(x, ensure_ascii=False, indent=2)+'\n')

def accepts(kind, requested, sections, source):
    if not set(requested).issubset(sections): return False
    for u in requested:
        text = sections[u]; data = source['units'][u]
        if not isinstance(text, str): return False
        if kind == 'analysis':
            # Anchored numeric values prevent profit=4 from matching profit=40.
            for key, value in [('revenue',data['revenue']),('cost',data['cost']),('profit',data['revenue']-data['cost'])]:
                if not re.search(r'\b'+key+'='+str(value)+r'(?!\d|\.\d)',text): return False
        elif any(fact not in text for fact in data['facts']): return False
        if re.search(r'\b(?:not|never|unknown|unverified)\b',text,re.I): return False
    return True

def delta_valid(requested, allowed, prior, result, reads):
    return set(reads)==set(allowed) and all(result.get(u)==prior.get(u) for u in requested if u not in allowed)

def audit(a, all_attempts):
    d=ROOT/'runs'/a['id']; events=rows(d/'events.jsonl'); config=load(d/'config.json')
    state=load(next((d/'reuse/task-confirmations').glob('*.json')))
    calls=load(d/'calls.json'); answers=load(d/'simulated-answers.json'); case=load(d/'case.json')
    source=load(d/'source.json')[a['kind']]; result=load(d/'result.json')
    native=[b for e in events if e.get('type')=='assistant' for b in e.get('message',{}).get('content',[]) if b.get('type')=='tool_use']
    outputs={b['tool_use_id']:(i,b,e.get('tool_use_result')) for i,e in enumerate(events) if e.get('type')=='user' for b in e.get('message',{}).get('content',[]) if b.get('type')=='tool_result'}
    positions={b['id']:i for i,e in enumerate(events) if e.get('type')=='assistant' for b in e.get('message',{}).get('content',[]) if b.get('type')=='tool_use'}
    questions=[b for b in native if b['name']=='AskUserQuestion']; bash=[b for b in native if b['name']=='Bash']
    checks={}; checks['model_and_accounting']=list(result.get('modelUsage',{}))==[MODEL] and a.get('total_tokens') is not None and result.get('total_cost_usd')==a.get('api_equivalent_usd')
    init=next((e for e in events if e.get('subtype')=='init'),{})
    if a['label'].endswith('host-v2'): checks['question_tool_exposed']='AskUserQuestion' in init.get('tools',[])
    checks['successful_cli']=a.get('status')=='observed' and not result.get('is_error') and result.get('subtype')=='success'
    checks['no_hook_errors']=not a.get('hook_errors')
    checks['native_operations']=len(bash)==len(calls)==len(state['operations'])
    inputs=[]
    for b in bash:
        try:
            argv=shlex.split(b['input']['command']); request=json.loads(argv[3]); index,out,_=outputs[b['id']]
            value=json.loads(out['content']); record=load(d/'reuse/invocations'/(value['reuse_invocation_id']+'.json'))
            good=len(argv)==4 and argv[:3]==shlex.split(a['argv'][a['argv'].index('--allowedTools')+1].removeprefix('Bash(').removesuffix(' *)'))
            # Exact canonical command prefix is independently bound to the saved runtime.
            good=good and record['native_call_id']==b['id'] and record['request']==request and record['output']==value and not out.get('is_error')
            checks['native:'+b['id']]=good
            inputs.append(request['input'])
        except (ValueError,KeyError,IndexError,FileNotFoundError): checks['native:'+b['id']]=False
    checks['backend_arguments']=sorted(json.dumps(x,sort_keys=True) for x in inputs)==sorted(json.dumps(c['args'],sort_keys=True) for c in calls)
    checks['backend_success']=all(c['result'].get('ok') for c in calls)
    reads=[u for x in inputs if x['op']=='read' for u in x['units']]
    expected='full' if a['condition']=='control' else a['choice']
    checks['choice']=state['choice']==expected
    if a['condition']=='confirmation':
        checks['one_native_question']=len(questions)==len(answers)==1
        if len(questions)==len(answers)==1:
            q=questions[0]; answer=answers[0]; actual=outputs.get(q['id'],(None,{},None))[2]
            checks['answer_provenance']=answer['tool_use_id']==q['id']==state['answer_evidence']['call_id'] and answer['provenance']=='synthetic_participant' and answer['answer']==LABELS[a['choice']] and state['decision_source']=='simulated' and isinstance(actual,dict) and actual.get('answers',{}).get(answer['question']['question'])==answer['answer']
            checks['no_work_before_answer']=all(positions[b['id']]>outputs[q['id']][0] for b in bash)
        prior=state.get('prior',{}); checks['prior_scope']=prior.get('owner')=='author' and set(prior.get('covered_units',[]))=={'a','b'}
        prep=[x for x in all_attempts if x.get('phase')=='preparation' and x.get('kind')==a['kind'] and x.get('success')]
        checks['prior_real_model_provenance']=len(prep)==1 and prior.get('id')==prep[0]['task_completion'].get('artifact_id') and digest(d/'source.json')==digest(ROOT/'runs'/prep[0]['id']/'source.json')
        with sqlite3.connect(d/'evidence.sqlite') as db:
            row=db.execute('select principal,fingerprint,created_at,refs_json,action_ref from memory_reuse_artifacts where id=?',(prior.get('id'),)).fetchone()
            grant=db.execute('select 1 from memory_reuse_artifact_grants where artifact_id=? and principal=?',(prior.get('id'),'member')).fetchone()
        checks['grant_fingerprint_expiry']=bool(row and grant and row[0]=='author' and row[1]==state['source_fingerprint'] and 0<=state['created_at']-row[2]<=config['task_workflows'][a['kind']]['valid_for_ms'] and json.loads(row[3])==config['task_workflows'][a['kind']]['source_refs'] and row[4]==prep[0]['task_completion']['native_call_id'])
        checks['prior_bytes']=digest(d/prior['path'])==prior['content_digest']
    else: checks['no_control_confirmation']=not questions and not answers and not state.get('prior')
    if expected=='existing':
        sections=state['prior']['sections']; checks['work_skipped']=len(inputs)==0
    else:
        writes=[c for c in calls if c['args']['op']=='write']; checks['single_write']=len(writes)==1
        artifact=writes[-1]['result'].get('artifact',{}) if writes else {}; sections=artifact.get('sections',{})
        checks['actual_output_bytes']=bool(artifact.get('path')) and digest(d/artifact['path'])==artifact['sha256']
        checks['native_output_capture']=len(state['created_results'])==1 and state['created_results'][0]['content_digest']==artifact.get('sha256')
        checks['read_scope']=set(reads)==set(['c'] if expected=='delta' else a['units'])
        if expected=='delta': checks['preserved_prior_sections']=delta_valid(a['units'],['c'],state['prior']['sections'],sections,reads)
    checks['all_required_meaning']=accepts(a['kind'],a['units'],sections,source)
    workflow=config['task_workflows'][a['kind']]
    with sqlite3.connect(d/'evidence.sqlite') as db:
        checks['verified_current_sources']=all(db.execute("select 1 from memories where id=? and current_version=? and verification_state='verified' and deleted_at is null",(r['source_id'],r['source_version'])).fetchone() for r in workflow['source_refs'])
        checks['no_false_original_use']=db.execute('select count(*) from memory_reuse_applications').fetchone()[0]==0
    return {'id':a['id'],'label':a['label'],'pass':all(checks.values()),'checks':checks,'read_units':reads,'backend_ms':sum(c['elapsed_ms'] for c in calls),'simulated_human_wait_ms':sum(x['human_wait_ms'] for x in answers)}

def aggregate(items):
    return {'n':len(items),'tokens':sum(x['total_tokens'] for x in items),'usage':{k:sum(x['usage'][k] for x in items) for k in ['input_tokens','cache_creation_input_tokens','cache_read_input_tokens','output_tokens']},'total_ms':sum(x['total_ms'] for x in items),'api_equivalent_usd':sum(x['api_equivalent_usd'] for x in items),'read_calls':sum(x['read_calls'] for x in items),'read_unit_count':sum(len(x['read_units']) for x in items),'write_calls':sum(x['write_calls'] for x in items),'questions':sum(x['questions'] for x in items),'model_responses':sum(x['model_responses'] for x in items),'setup_ms':sum(x['setup_ms'] for x in items),'cli_ms':sum(x['cli_ms'] for x in items)}

def matched(pair):
    a,b=pair['control'],pair['confirmation']; da=ROOT/'runs'/a['id']; db=ROOT/'runs'/b['id']
    ca,cb=load(da/'config.json'),load(db/'config.json')
    for c in [ca,cb]:
        c.pop('db_path');c.pop('task_confirmation_mode')
    # Only the intended presentation/confirmation treatment differs.
    return a['units']==b['units'] and a['principal']==b['principal'] and a['runtime_manifest_sha256']==b['runtime_manifest_sha256'] and digest(da/'source.json')==digest(db/'source.json') and load(da/'case.json')==load(db/'case.json') and ca==cb and a['argv'][a['argv'].index('--system-prompt')+1]==b['argv'][b['argv'].index('--system-prompt')+1]

def main():
    started=time.monotonic()
    ledger=load(LEDGER); attempts=[x for x in ledger if x.get('channel')==CHANNEL]
    audits=[audit(a,attempts) for a in attempts if (ROOT/'runs'/a['id']/'result.json').exists()]
    save(ROOT/'audit.json',audits)
    pairs=[]
    for case in load(ROOT/'cases.json'):
        pair={c:next((x for x in attempts if x['label']==f"task-{case['id']:02d}-{c}-host-v2" and x.get('success')),None) for c in ['control','confirmation']}
        if all(pair.values()): pairs.append({'case':case,**pair})
    groups={}
    for choice in LABELS:
        selected=[p for p in pairs if p['case']['choice']==choice]
        group={c:aggregate([p[c] for p in selected]) for c in ['control','confirmation']}
        for metric in ['tokens','total_ms','api_equivalent_usd']:
            old=group['control'][metric]; group[metric+'_change_pct']=100*(group['confirmation'][metric]/old-1) if old else None
        groups[choice]=group
    main_audits=[x for x in audits if x['label'].endswith('host-v2')]
    preparation=[x for x in attempts if x.get('phase')=='preparation' and x.get('total_tokens') is not None]
    paired_ids={p[c]['id'] for p in pairs for c in ['control','confirmation']}
    diagnostics=[x for x in attempts if x.get('phase')!='preparation' and x['id'] not in paired_ids and x.get('total_tokens') is not None]
    report={'status':'complete_with_retained_diagnostics' if len(pairs)==9 and len(main_audits)==18 and all(a['pass'] for a in main_audits) and all(matched(p) for p in pairs) else 'incomplete_or_failed','model':MODEL,'effort':'medium','additional_starts':len(attempts),'cumulative_starts':len(ledger),'audit_passed':sum(x['pass'] for x in audits),'audit_total':len(audits),'comparison_audit_passed':sum(x['pass'] for x in main_audits),'comparison_audit_total':len(main_audits),'paired_cases':len(pairs),'matched_conditions':all(matched(p) for p in pairs),'groups':groups,'by_kind':{kind:{c:aggregate([p[c] for p in pairs if p['case']['kind']==kind]) for c in ['control','confirmation']} for kind in ['research','analysis','document']},'preparation':aggregate(preparation),'diagnostics':aggregate(diagnostics),'all_api_equivalent_usd':sum(x['api_equivalent_usd'] for x in attempts if x.get('api_equivalent_usd') is not None),'missing_fee_starts':sum(x.get('api_equivalent_usd') is None for x in attempts),'failures':[{'id':x['id'],'label':x['label'],'status':x['status']} for x in attempts if not x.get('success')],'actual_billing_usd':None,'implementation_cost':None,'real_human_wait_ms':None,'offline_audit_ms':(time.monotonic()-started)*1000,'cloud_deploy':False}
    report['all_starts']=aggregate([x for x in attempts if x.get('total_tokens') is not None])
    report['comparison_all_choices']={c:aggregate([p[c] for p in pairs]) for c in ['control','confirmation']}
    report['overhead_accounting']={'search_presentation_question_hashing_tracking':'included in CLI wall time and all four model token bins; no standalone model calls for these steps','individual_hook_cpu_ms':None,'local_seed_creation_ms':None,'local_seed_model_calls':0,'source_update_model_calls':0,'simulated_human_wait_ms':0,'real_human_wait_ms':None,'billing_note':'CLI list-price estimate, not actual invoice; parent implementation and audit money unmeasured'}
    report['pairs']=[{'case':p['case'],'matched':matched(p),**{c:{k:p[c][k] for k in ['id','label','total_tokens','usage','total_ms','api_equivalent_usd','read_calls','read_units','write_calls','questions']} for c in ['control','confirmation']}} for p in pairs]
    save(ROOT/'report.json',report); print(json.dumps(report,ensure_ascii=False,indent=2))
    for a in audits:
        if not a['pass']: print('FAILED_CHECKS',a['label'],[k for k,v in a['checks'].items() if not v])

if __name__=='__main__': main()
