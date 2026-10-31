"""Native Claude paired evaluations. Fixtures never substitute for model responses."""
import argparse, hashlib, json, os, shlex, signal, subprocess, tempfile, time, math
from pathlib import Path

REPO=Path(__file__).resolve().parents[1]
ROOT=REPO/'artifacts/memory-reuse-loop-20261026'
NODE='/Users/miyajimakazuhiro/.local/share/nodejs/node-v26.12.1-darwin-arm64/bin/node'
ADAPTER=REPO/'scripts/memory-reuse-loop-adapter.mjs'
CHANNELS=['object','operation','recent','changes','procedure','result']
MODEL='claude-sonnet-5-5'
SYSTEM='Complete the bounded synthetic planning task using only the provided Bash adapter. All adapter responses execute real local code. Generate the plan for the current task; preserve every source constraint. Treat memory as a conditional reference. Explicitly report its use only when it actually informed a completed action. Never infer usefulness from a receipt. Do not use agents, other commands, files, or external services.'
def save(p,v):p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
def load(p,default=None):return json.loads(p.read_text()) if p.exists() else default
def arguments(c):return c['args'] if isinstance(c['args'],dict) else {}
def provider_tokens(usage):
 keys=['input_tokens','cache_creation_input_tokens','cache_read_input_tokens','output_tokens']
 if not isinstance(usage,dict) or not all(isinstance(usage.get(k),(int,float)) and not isinstance(usage[k],bool) and math.isfinite(usage[k]) and usage[k]>=0 for k in keys):return None
 return sum(usage[k] for k in keys)
def native_adapter_arguments(command,rid):
 lexer=shlex.shlex(command,posix=True,punctuation_chars=';&|');lexer.whitespace_split=True
 tokens=list(lexer);variables={};allowed={NODE,str(ADAPTER),str(ROOT),rid}
 for token in tokens:
  if '=' in token:
   key,value=token.split('=',1)
   if key.isidentifier() and value in allowed:variables[key]=value
 resolved=[variables.get(t[1:],t) if t.startswith('$') else t for t in tokens]
 prefix=[NODE,str(ADAPTER),'api',str(ROOT),rid];found=[]
 for i in range(len(resolved)-5):
  if resolved[i:i+5]==prefix:
   try:found.append(json.loads(resolved[i+5]))
   except ValueError:continue
 return found
def rows(p):return [json.loads(x) for x in p.read_text().splitlines() if x.strip()] if p.exists() else []
def adapter(cmd,rid='',value=None):
 p=subprocess.run([NODE,str(ADAPTER),cmd,str(ROOT),rid]+([json.dumps(value)] if value is not None else []),capture_output=True,text=True,timeout=40)
 if p.returncode:raise RuntimeError(p.stderr[-2500:])
 return json.loads(p.stdout)
def run(channel,revision,limit,case_ids=None,only=None,phase='primary',cohort='A',actor=None):
 ROOT.mkdir(parents=True,exist_ok=True)
 attempts=load(ROOT/'attempts.json',[])
 if any(a['status']=='started' for a in attempts):raise RuntimeError('unresolved_prior_attempt')
 revisions={a['revision'] for a in attempts if a['channel']==channel and a.get('phase','primary')=='primary'}
 if phase=='primary' and revision not in revisions and len(revisions)>=2:raise RuntimeError('one_remeasurement_per_channel_exhausted')
 if not (ROOT/'corpus.json').exists():adapter('setup')
 manifest={'model':MODEL,'effort':'medium','max_cli_executions':240,'conditions':['none','memory'],'per_condition':10,'personal_cases':5,'simulated_team_cases':5,'four_knowledge_units':True,'eligible_cases':8,'ineligible_cases':2,'channels_in_order':CHANNELS,'real_models_only':True,'task_origin':'synthetic','meaning_check':'all seven plan constraints match independently derived current source values','automatic_task_retries':False,'actual_enterprise_charge_usd':None,'paid_memory_provider_calls':0,'one_run_max_turns':6,'one_run_timeout_seconds':180}
 if not (ROOT/'manifest.json').exists():save(ROOT/'manifest.json',manifest)
 if channel=='procedure' and not (ROOT/f'procedures-r{revision}.json').exists():save(ROOT/f'procedures-r{revision}.json',adapter('promote'))
 cutoff=None
 if channel=='result' and cohort=='B':
  p=ROOT/f'result-r{revision}-cutoff.json'
  if not p.exists():save(p,{'artifact_cutoff_ms':int(time.time()*1000),'reason':'Exclude every result produced within this comparison, including the paired control.'})
  cutoff=load(p)['artifact_cutoff_ms']
 count=0
 for case in (case_ids or range(1,11)):
  pair_ids=[f'{channel}-r{revision}-{case:02d}-{c}' for c in ['none','memory']]
  if channel=='changes' and not any(a['id'] in pair_ids for a in attempts):adapter('revise',str(case))
  for condition in ([only] if only else ['none','memory'] if case%2 else ['memory','none']):
   rid=f'{channel}-r{revision}-{case:02d}-{condition}'
   if any(a['id']==rid for a in attempts):continue
   if limit is not None and count>=limit:return
   if len(attempts)>=240:raise RuntimeError('CLI_execution_budget_exhausted')
   start=time.monotonic();prepared=adapter('prepare',rid,{'channel':channel,'condition':condition,'case_id':case,'revision':revision,'phase':phase,'cohort':cohort,'actor':actor,'artifact_cutoff_ms':cutoff})
   setup_ms=(time.monotonic()-start)*1000
   d=ROOT/'runs'/rid;c=prepared['case'];recall=prepared['recall']
   prefix=shlex.join([NODE,str(ADAPTER),'api',str(ROOT),rid])
   prompt=f'Plan a synthetic batch job for target={c["target"]}, records={c["records"]}. Apply the plan using the adapter. All seven fields are required: target, mode, batch_size, region, retain_days, deduplicate, partitions. Derive partitions from current records and source batch size. You may consult the same source documents through the adapter in either condition.\nAdapter command: '+prefix+" '<JSON>'\nOperations: {\"op\":\"index\"}; {\"op\":\"read\",\"document\":\"NAME.json\"}; {\"op\":\"apply\",\"plan\":{...}}. If a provided artifact has an artifact_id and its validated conditions match this task, you may explicitly choose {\"op\":\"apply_artifact\",\"artifact_id\":\"ID\"} to apply that stored procedure or result through real code. No artifact can be used when none is provided. Such code use is traced separately and needs no model-memory use report. For an original reference that actually informs a manual action, invoke the compact use report from the post-tool context and print use_receipt. Finish with a short status.\n"
   if recall.get('context'):prompt+='Provided reference:\n'+recall['context']
   save(d/'mcp.json',{'mcpServers':{}})
   settings={'autoMemoryEnabled':False,'promptSuggestionEnabled':False,'hooks':{'PostToolUse':[{'matcher':'Bash','hooks':[{'type':'command','command':shlex.join([NODE,str(ADAPTER),'hook',str(ROOT),rid]),'timeout':20}]}]}}
   save(d/'settings.json',settings);(d/'prompt.txt').write_text(prompt)
   argv=['claude','-p','--verbose','--input-format','stream-json','--output-format','stream-json','--no-session-persistence','--setting-sources','','--settings',str(d/'settings.json'),'--strict-mcp-config','--mcp-config',str(d/'mcp.json'),'--tools','Bash','--allowedTools',f'Bash({NODE} {ADAPTER} api *)','--disable-slash-commands','--model',MODEL,'--effort','medium','--max-turns','6','--max-budget-usd','1','--system-prompt',SYSTEM,'--prompt-suggestions','false']
   env=os.environ.copy();env.update({'CLAUDE_CODE_DISABLE_AUTO_MEMORY':'1','CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC':'1','CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS':'1','CLAUDE_CODE_DISABLE_BACKGROUND_TASKS':'1','ENABLE_TOOL_SEARCH':'false'})
   cwd=tempfile.mkdtemp(prefix='claude-reuse-loop-')
   attempt={'id':rid,'channel':channel,'condition':condition,'case':case,'audience':c['audience'],'eligible':c['eligible'],'target':c['target'],'principal':c['principal'],'cohort':cohort,'status':'started','phase':phase,'revision':revision,'order':len(attempts)+1,'setup_ms':setup_ms,'prepare_ms':prepared['prepare_ms'],'prompt_sha256':hashlib.sha256(prompt.encode()).hexdigest(),'argv':argv,
     'implementation_sha256':{str(p.relative_to(REPO)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [ADAPTER,REPO/'packages/orgbrain-cli/src/lib/memory-reuse.mjs',REPO/'packages/orgbrain-cli/src/local-mcp.mjs']}}
   attempts.append(attempt);save(ROOT/'attempts.json',attempts)
   print(json.dumps({'starting':rid,'order':attempt['order']}),flush=True)
   started=time.monotonic();timeout=False
   with (d/'events.jsonl').open('w') as out,(d/'stderr.txt').open('w') as err:
    p=subprocess.Popen(argv,stdin=subprocess.PIPE,stdout=out,stderr=err,text=True,cwd=cwd,env=env,start_new_session=True)
    try:p.communicate(json.dumps({'type':'user','message':{'role':'user','content':prompt}})+'\n',timeout=180)
    except subprocess.TimeoutExpired:
     timeout=True;os.killpg(p.pid,signal.SIGTERM)
     try:p.wait(timeout=5)
     except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
   cli_ms=(time.monotonic()-started)*1000
   attempt.update(cli_ms=cli_ms,timeout=timeout,returncode=p.returncode);save(ROOT/'attempts.json',attempts)
   finish(attempt,attempts,cli_ms,timeout,p.returncode);count+=1

def finish(attempt,attempts,cli_ms,timeout,returncode):
 d=ROOT/'runs'/attempt['id'];rid=attempt['id'];state=load(d/'state.json');recall=state['recall'];setup_ms=attempt['setup_ms']
 events=rows(d/'events.jsonl');result=next((e for e in reversed(events) if e.get('type')=='result'),{})
 calls=rows(d/'calls.jsonl');applies=[c for c in calls if arguments(c).get('op') in ['apply','apply_artifact']];good=[c for c in applies if c['result'].get('ok') is True]
 meaning=any(all(c['result'].get('applied_plan',{}).get(k)==v for k,v in state['expected'].items()) for c in good)
 collect_start=time.monotonic();collection=adapter('collect',rid);collection_ms=(time.monotonic()-collect_start)*1000
 usage=result.get('usage');tokens=provider_tokens(usage)
 denied={x.get('tool_use_id') for x in result.get('permission_denials',[])}
 native=[b for e in events if isinstance(e.get('message'),dict) for b in e['message'].get('content',[]) if b.get('type')=='tool_use' and b['id'] not in denied]
 native_args=[args for b in native for args in native_adapter_arguments(b['input']['command'],rid)]
 matches=sorted(json.dumps(a,sort_keys=True) for a in native_args if a is not None)==sorted(json.dumps(c['args'],sort_keys=True) for c in calls)
 observed=bool(result) and tokens is not None and matches and not timeout and bool(result.get('modelUsage')) and all(k==MODEL for k in result['modelUsage'])
 attempt.update(status='observed' if observed else 'infrastructure_failed',success=bool(good) and meaning,api_accepted=bool(good),meaning_preserved=meaning,first_attempt_success=bool(applies and applies[0]['result'].get('ok')),cli_ms=cli_ms,collector_process_ms=collection_ms,total_ms=setup_ms+cli_ms+collection_ms,total_tokens=tokens,usage=usage,api_equivalent_usd=result.get('total_cost_usd'),actual_enterprise_charge_usd=None,model_usage=result.get('modelUsage'),collection=collection,tracking_calls=sum(arguments(c).get('used') is True for c in calls),apply_calls=len(applies),read_calls=sum(arguments(c).get('op') in ['read','index'] for c in calls),injected_tokens_estimate=recall.get('evidence_bundle',{}).get('estimated_tokens',0),references=recall.get('references',[]),native_arguments_match=matches,timeout=timeout,result_subtype=result.get('subtype'),permission_denials=result.get('permission_denials',[]),returncode=returncode)
 save(d/'result.json',result);save(ROOT/'attempts.json',attempts)
 print(json.dumps({k:attempt[k] for k in ['id','status','success','total_tokens','tracking_calls','read_calls']})+' collection='+json.dumps(collection),flush=True)
 if not observed:raise RuntimeError('infrastructure failure; no automatic retry')
def summarize():
 a=load(ROOT/'attempts.json',[]);report={'executions':len(a),'max_executions':240,'stages':{},'limits':['Synthetic source-backed seeded knowledge; capture/admission is not evaluated.','Team results are simulated principals and sessions, not human team adoption.','API equivalent cost is not the enterprise invoice.','Parent implementation tokens and actual subscription charges are unavailable.']}
 for channel in CHANNELS:
  history=[x for x in a if x['channel']==channel and x.get('phase','primary')=='primary']
  revision=max((x['revision'] for x in history),default=0)
  r=[x for x in history if x['revision']==revision];groups={}
  for condition in ['none','memory']:
   g=[x for x in r if x['condition']==condition];n=len(g)
   def total(k):return sum(x[k] for x in g) if g and all(isinstance(x.get(k),(int,float)) for x in g) else None
   groups[condition]={'n':n,'success':sum(x.get('success',False) for x in g),'meaning_preserved':sum(x.get('meaning_preserved',False) for x in g),'total_tokens':total('total_tokens'),'mean_tokens':total('total_tokens')/n if n and total('total_tokens') is not None else None,'mean_ms':total('total_ms')/n if n and total('total_ms') is not None else None,'api_equivalent_usd':total('api_equivalent_usd'),'read_calls':total('read_calls'),
     'verified_model_use_reports':sum(x.get('collection',{}).get('recorded',0) for x in g),'verified_derived_applications':sum(len(x.get('collection',{}).get('applications',[])) for x in g),
     'verified_use_tasks':sum(bool(x.get('collection',{}).get('recorded',0) or x.get('collection',{}).get('applications',[])) for x in g)}
  used=[x for x in r if x['condition']=='memory' and (x.get('collection',{}).get('recorded',0)>0 or x.get('collection',{}).get('applications',[]))]
  unique={ref['source_id'] for x in used for ref in x.get('references',[])}
  wrong=sum(not x['eligible'] for x in used)
  personal=sum(x['audience']=='personal' for x in used);team=sum(x['audience']=='team' for x in used)
  complete=all(groups[c]['n']==10 for c in groups) and all(x['status']=='observed' for x in r)
  adopted=complete and len(unique)>=3 and personal>=2 and team>=2 and wrong==0 and groups['memory']['success']>=groups['none']['success'] and groups['memory']['meaning_preserved']==10
  report['stages'][channel]={'selected_revision':revision,'earlier_primary_executions':len(history)-len(r),'groups':groups,'unique_knowledge_reused':len(unique),'knowledge_task_pairs':len(used),'personal_reuse_tasks':personal,'simulated_team_reuse_tasks':team,'cross_principal_derived_tasks':sum(any(y.get('artifact_owner')!=x.get('principal') for y in x.get('collection',{}).get('applications',[])) for x in used),'ineligible_uses':wrong,'complete':complete,'adopted':adopted}
 report['all_executions']={'observed':sum(x['status']=='observed' for x in a),'infrastructure_failed':sum(x['status']=='infrastructure_failed' for x in a),'pending':sum(x['status']=='started' for x in a),'total_tokens':sum(x['total_tokens'] for x in a) if all(isinstance(x.get('total_tokens'),(int,float)) for x in a) else None,'api_equivalent_usd':sum(x['api_equivalent_usd'] for x in a) if all(isinstance(x.get('api_equivalent_usd'),(int,float)) for x in a) else None,'phase_counts':{phase:sum(x.get('phase','primary')==phase for x in a) for phase in sorted({x.get('phase','primary') for x in a})}}
 report['maintenance_components']=rows(ROOT/'lifecycle.jsonl')
 report['initial_setup_actual_ms']=None
 save(ROOT/'report.json',report);print(json.dumps(report,ensure_ascii=False))
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--channel',choices=CHANNELS);p.add_argument('--revision',type=int,default=1);p.add_argument('--limit',type=int);p.add_argument('--summarize',action='store_true');p.add_argument('--recover',action='store_true');p.add_argument('--phase',default='primary',choices=['primary','preparation']);p.add_argument('--case-ids');p.add_argument('--only',choices=['none','memory']);p.add_argument('--cohort',choices=['A','B'],default='A');p.add_argument('--actor',choices=['alice','bob','author']);args=p.parse_args()
 if args.recover:
  attempts=load(ROOT/'attempts.json',[])
  for a in attempts:
   if a['status']=='started':
    result=next(e for e in reversed(rows(ROOT/'runs'/a['id']/'events.jsonl')) if e.get('type')=='result')
    a['elapsed_basis']='cli_reported_after_analysis_crash' if 'cli_ms' not in a else 'parent_wall_clock'
    finish(a,attempts,a.get('cli_ms',result['duration_ms']),a.get('timeout',False),a.get('returncode',0))
 elif args.summarize:summarize()
 elif args.channel:run(args.channel,args.revision,args.limit,[int(x) for x in args.case_ids.split(',')] if args.case_ids else None,args.only,args.phase,args.cohort,args.actor)
