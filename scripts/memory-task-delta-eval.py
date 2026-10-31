"""Prospective three-condition delta comparison; preparation never starts a model."""
import argparse,hashlib,importlib.util,json,os,shutil,subprocess,time
from pathlib import Path
from claude_reuse_execution import execute_cli

spec=importlib.util.spec_from_file_location('task_eval',Path(__file__).with_name('memory-task-confirmation-eval.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
REPO=m.REPO;PRIOR=m.ROOT;ROOT=REPO/'artifacts/memory-task-delta-20261030';BASE=ROOT/'runtime/v3';LEDGER=m.LEDGER;NODE=m.NODE;MODEL=m.MODEL
ADAPTER=PRIOR/'runtime/r32/scripts/memory-task-confirmation-adapter.mjs';CAP=419;CHANNEL='task_delta_v2';LIMIT_USD=1.00
SYSTEM='Complete the bounded synthetic task using only the configured run command and the scope given by the hook. Ask the exact native AskUserQuestion only if the hook requires it; never supply an answer yourself. If current source is supplied by the host, use it directly. Otherwise read the requested source units with run. For patch, author only the new approved sections; the host preserves prior sections and produces the complete deliverable. For write, provide every requested section. Use an exact Bash invocation with single-quoted JSON, no compound commands and no other tools or services. Keep the final status short. Write English. Analysis sections must contain revenue=N, cost=N, profit=N using current data. Research and document sections must retain all source fact sentences verbatim.'
load=m.load;save=m.save;rows=m.rows;sha=m.sha

def prepare():
 ROOT.mkdir(parents=True,exist_ok=True)
 if not BASE.exists():
  (BASE/'scripts').mkdir(parents=True)
  for name in ['orgbrain-cli','shared']:shutil.copytree(REPO/'packages'/name/'src',BASE/'packages'/name/'src')
  for name in ['memory-reuse-claude.mjs','memory-reuse-task-local.mjs','memory-task-simulated-answer.mjs']:shutil.copyfile(REPO/'scripts'/name,BASE/'scripts'/name)
  save(BASE/'manifest.json',{str(p.relative_to(BASE)):sha(p) for p in BASE.rglob('*') if p.is_file()})
  for name in ['orgbrain-cli','shared']:(BASE/'packages'/name/'node_modules').symlink_to(REPO/'packages'/name/'node_modules',target_is_directory=True)
 for name,digest in load(BASE/'manifest.json').items():assert sha(BASE/name)==digest,name
 assert sha(ADAPTER)==load(PRIOR/'runtime/r32/manifest.json')['scripts/memory-task-confirmation-adapter.mjs']
 if not (ROOT/'memory.sqlite').exists():
  m.sqlite_copy(PRIOR/'memory.sqlite',ROOT/'memory.sqlite');shutil.copyfile(PRIOR/'source.json',ROOT/'source.json');shutil.copytree(PRIOR/'results',ROOT/'results')
  prior=[x for x in load(LEDGER) if x.get('channel')=='task_confirmation_v1' and x.get('phase')=='preparation' and x.get('success')]
  assert len(prior)==3
  save(ROOT/'prior-result-provenance.json',[{'kind':x['kind'],'original_attempt':x['id'],'artifact_id':x['task_completion']['artifact_id'],'native_call_id':x['task_completion']['native_call_id'],'model':MODEL,'original_api_equivalent_usd':x['api_equivalent_usd'],'evidence_path':str((PRIOR/'runs'/x['id']).relative_to(REPO))} for x in prior])
  save(ROOT/'cases.json',[{'id':i+1,'kind':['research','analysis','document'][i%3],'workflow':['research','analysis','document'][i%3],'choice':'delta','units':['a','b','c'],'group':'personal' if i%2==0 else 'team'} for i in range(10)])

def setup(case,condition):
 m.ROOT=ROOT;m.BASE=BASE;m.HELPER=BASE/'scripts/memory-reuse-claude.mjs';m.ADAPTER=ADAPTER;m.SYSTEM=SYSTEM
 a,prompt,env=m.setup(case,'confirmation' if condition=='current' else 'control','comparison')
 a.update(label=f"delta-{case['id']:02d}-{condition}",channel=CHANNEL,condition=condition,group=case['group'],principal='author' if case['group']=='personal' else 'member',driver_sha256=sha(Path(__file__)))
 w=Path(a['workspace']);config=load(w/'.local/memory-reuse/config.json');config['task_local_mode']='on' if condition=='improved' else 'off';config['task_workflows'][case['kind']]['local_source_field']='source_sections'
 if condition=='improved':config['task_confirmation_mode']='ask'
 save(w/'.local/memory-reuse/config.json',config);env['ORGBRAIN_USE_PRINCIPAL']=a['principal']
 d=ROOT/'runs'/a['id'];save(d/'prepared.json',a)
 if condition=='improved':
  save(d/'local-request.json',{'session_id':a['id'].removeprefix('claude:'),'prompt':prompt})
  argv=[NODE,str(BASE/'scripts/memory-reuse-task-local.mjs'),'--request',str(d/'local-request.json'),'--prepare-only','--simulate-answer','差分だけ実施'];start=time.monotonic();p=subprocess.run(argv,cwd=w,env=env,capture_output=True,text=True,timeout=60);elapsed=(time.monotonic()-start)*1000
  save(d/'pre-model.json',{'argv':argv,'elapsed_ms':elapsed,'returncode':p.returncode,'stdout':p.stdout,'stderr':p.stderr,'participant':'simulated_local_user'})
  if p.returncode:raise RuntimeError('local_preparation_failed: '+p.stderr[-1000:])
  receipt=json.loads(p.stdout);assert receipt['model_starts']==0 and receipt['human_wait_ms']==0
  a['setup_ms']+=elapsed;a['local_preparation_ms']=elapsed;save(d/'prepared.json',a)
 return a,prompt,env

def finalize(a,records):
 d=ROOT/'runs'/a['id'];w=Path(a['workspace']);events=rows(d/'events.jsonl');result=next((e for e in reversed(events) if e.get('type')=='result'),{});calls=rows(w/'calls.jsonl')
 state=load(next((w/'.local/memory-reuse/task-confirmations').glob('*.json')));observation=load(w/'.local/memory-reuse/last-observation.json',{});completion=observation.get('task_completion') or {}
 native=[b for e in events if e.get('type')=='assistant' for b in e.get('message',{}).get('content',[]) if b.get('type')=='tool_use'];outputs={b['tool_use_id']:b for e in events if e.get('type')=='user' for b in e.get('message',{}).get('content',[]) if b.get('type')=='tool_result'}
 backend=[];matched=True
 if a['condition']=='improved':backend.append(state['local']['source']['input'])
 for b in native:
  if b['name']=='AskUserQuestion':continue
  try:
   import shlex
   argv=shlex.split(b['input']['command']);assert b['name']=='Bash' and len(argv)==4 and argv[:3]==[NODE,str(m.HELPER),'run'];request=json.loads(argv[3]);out=outputs[b['id']];assert not out.get('is_error');value=json.loads(out['content']);private=load(w/'.local/memory-reuse/invocations'/(value['reuse_invocation_id']+'.json'));assert private['request']==request and private['output']==value and private['native_call_id']==b['id']
   x=request['input']
   if x['op']=='patch':x={'op':'write','units':state['requested_units'],'sections':{u:x['sections'][u] if u in state['allowed_units'] else state['prior']['sections'][u] for u in state['requested_units']}}
   backend.append(x)
  except (ValueError,KeyError,AssertionError,FileNotFoundError):matched=False
 matched=matched and backend==[x['args'] for x in calls]
 tokens,usage=m.accounting(result);hook_errors=[e for e in events if e.get('subtype')=='hook_response' and e.get('exit_code')!=0]
 good=completion.get('status')==('completed_full' if a['condition']=='control' else 'completed_delta') and all(c['result'].get('ok') for c in calls)
 m.sqlite_copy(w/'memory.sqlite',d/'evidence.sqlite');shutil.copytree(w/'.local/memory-reuse',d/'reuse',dirs_exist_ok=True);shutil.copytree(w/'results',d/'results',dirs_exist_ok=True)
 for name in ['source.json','case.json']:shutil.copyfile(w/name,d/name)
 for name,value in [('result.json',result),('calls.json',calls),('observation.json',observation),('config.json',load(w/'.local/memory-reuse/config.json')),('simulated-answers.json',rows(w/'simulated-answers.jsonl'))]:save(d/name,value)
 a.update(status='observed' if tokens is not None and matched and not hook_errors and not a['timeout'] else 'infrastructure_failed',success=good,total_tokens=tokens,usage=usage,api_equivalent_usd=result.get('total_cost_usd'),model_usage=result.get('modelUsage'),hook_errors=hook_errors,native_arguments_match=matched,task_completion=completion,questions=sum(b['name']=='AskUserQuestion' for b in native),native_bash_calls=sum(b['name']=='Bash' for b in native),host_read_calls=1 if a['condition']=='improved' else 0,read_calls=sum(c['args']['op']=='read' for c in calls),write_calls=sum(c['args']['op']=='write' for c in calls),read_units=[u for c in calls if c['args']['op']=='read' for u in c['args']['units']],model_responses=len({e['message']['id'] for e in events if e.get('type')=='assistant'}),total_ms=a['setup_ms']+a['cli_ms'],actual_billing_usd=None)
 save(LEDGER,records);save(d/'outcome.json',a);print(json.dumps({k:a[k] for k in ['label','status','success','total_tokens','questions','native_bash_calls','host_read_calls','total_ms','api_equivalent_usd']},ensure_ascii=False),flush=True)
 if a['status']!='observed' or not good:raise RuntimeError('retain_failure_no_automatic_retry')

def run(limit):
 approval=load(ROOT/'budget-proposal.json');assert approval.get('approved_cumulative_cap')==CAP and approval.get('approved_api_equivalent_usd')==LIMIT_USD,'No new model starts before explicit budget approval'
 prepare();done=0
 for case in load(ROOT/'cases.json'):
  order=['control','current','improved'];offset=(case['id']-1)%3;order=order[offset:]+order[:offset]
  for condition in order:
   records=load(LEDGER);existing=[x for x in records if x.get('label')==f"delta-{case['id']:02d}-{condition}" and x.get('channel')==CHANNEL]
   if existing:
    if not existing[-1].get('success'):raise RuntimeError('failed_attempt_requires_explicit_recovery')
    continue
   if done>=limit:return
   current=[x for x in records if x.get('channel')==CHANNEL]
   if any(x.get('api_equivalent_usd') is None for x in current):raise RuntimeError('missing_fee_stop')
   if sum(x['api_equivalent_usd'] for x in current)+0.07>LIMIT_USD:raise RuntimeError('cost_stop_before_start')
   a,prompt,env=setup(case,condition);records=execute_cli(a['argv'],prompt,Path(a['workspace']),env,ROOT/'runs'/a['id'],LEDGER,a,CAP);finalize(a,records);done+=1

def canary(serial=False):
 approval=load(ROOT/'budget-proposal.json');assert approval.get('approved_cumulative_cap')==CAP and approval.get('approved_api_equivalent_usd')==LIMIT_USD
 prepare();case=load(ROOT/'cases.json')[0]
 for condition in ['control','current','improved']:
  records=load(LEDGER);label=('delta-serial-01-' if serial else 'delta-canary-01-')+condition
  existing=[x for x in records if x.get('channel')==CHANNEL and x.get('label')==label]
  if existing:
   if not existing[-1].get('success'):raise RuntimeError('failed_canary_requires_review')
   continue
  current=[x for x in records if x.get('channel')==CHANNEL]
  if any(x.get('api_equivalent_usd') is None for x in current) or sum(x['api_equivalent_usd'] for x in current)+0.07>LIMIT_USD:raise RuntimeError('canary_cost_stop')
  a,prompt,env=setup(case,condition);a.update(label=label,phase='serial_validation_canary' if serial else 'validation_canary');save(ROOT/'runs'/a['id']/'prepared.json',a)
  records=execute_cli(a['argv'],prompt,Path(a['workspace']),env,ROOT/'runs'/a['id'],LEDGER,a,CAP);finalize(a,records)

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--prepare',action='store_true');p.add_argument('--dry-prepare',action='store_true');p.add_argument('--canary',action='store_true');p.add_argument('--serial-canary',action='store_true');p.add_argument('--limit',type=int,default=30);args=p.parse_args()
 if args.prepare:prepare()
 elif args.serial_canary:canary(serial=True)
 elif args.canary:canary()
 elif args.dry_prepare:
  prepare();case=load(ROOT/'cases.json')[0];a,prompt,env=setup(case,'improved');state=load(next((Path(a['workspace'])/'.local/memory-reuse/task-confirmations').glob('*.json')));assert state['prior']['id']==next(x['artifact_id'] for x in load(ROOT/'prior-result-provenance.json') if x['kind']==case['kind']);assert state['local']['source']['input']['units']==['c'];print(json.dumps({'dry_preparation':'passed','prior_actual_result_reused':state['prior']['id'],'source_route':'host_context','model_starts':0,'cumulative_starts':len(load(LEDGER))}))
 else:run(args.limit)
