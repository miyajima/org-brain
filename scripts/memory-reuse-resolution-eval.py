"""Bounded real-Claude comparison; preparation and audit never start a model."""
import argparse,hashlib,importlib.util,json,os,shlex,shutil,sqlite3,subprocess,tempfile,time,uuid
from pathlib import Path
from claude_reuse_execution import execute_cli
spec=importlib.util.spec_from_file_location('actions',Path(__file__).with_name('memory-reuse-actions-eval.py'));a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
REPO=a.REPO;ROOT=REPO/'artifacts/memory-reuse-resolution-20261027';PRIOR=a.ROOT;LEDGER=a.LEDGER;NODE=a.e.NODE;MODEL=a.e.MODEL
BASE=ROOT/'runtime/r22';HELPER=BASE/'scripts/memory-reuse-claude.mjs';ADAPTER=BASE/'scripts/memory-reuse-loop-adapter.mjs';CAP=360;CHANNEL='source_result_v2';ARMS=['none','knowledge','results'];FIELDS=['target','mode','batch_size','region','retain_days','deduplicate','partitions']
SYSTEM='Complete the synthetic maintenance task using only the supplied resolve/run commands. Use a current complete memory reference or a matching validated previous result when offered. Otherwise resolve the current source. Only usage_item_id values explicitly supplied by the memory hook belong in uses. With no such values, uses=[]; adapter_call_id and source_resolution_id are tracking IDs, never memory usage IDs. A derived result application is distinct from reading an original. Use one exact Bash invocation with single-quoted JSON per call. Do not use other commands, agents, files or services. Return a short final status.'
load=a.e.load;save=a.save;rows=a.e.rows
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def prepare():
 started=time.monotonic();records=load(LEDGER);assert len(records)>=330 and not any(x['status']=='started' for x in records)
 if not BASE.exists():
  (BASE/'scripts').mkdir(parents=True);shutil.copytree(REPO/'packages/orgbrain-cli/src',BASE/'packages/orgbrain-cli/src');shutil.copytree(REPO/'packages/shared/src',BASE/'packages/shared/src')
  for n in ['memory-reuse-claude.mjs','memory-reuse-source-validator.mjs','memory-reuse-loop-adapter.mjs','memory-reuse-result-import.mjs']:shutil.copyfile(REPO/'scripts'/n,BASE/'scripts'/n)
  save(BASE/'manifest.json',{str(p.relative_to(BASE)):sha(p) for p in BASE.rglob('*') if p.is_file()})
  for n in ['orgbrain-cli','shared']:(BASE/'packages'/n/'node_modules').symlink_to(REPO/'packages'/n/'node_modules',target_is_directory=True)
 for f,h in load(BASE/'manifest.json').items():assert sha(BASE/f)==h,f
 if not (ROOT/'cases.json').exists():
  for n in ['corpus.json','bindings.json']:shutil.copyfile(PRIOR/n,ROOT/n)
  src=sqlite3.connect(PRIOR/'memory.sqlite');dst=sqlite3.connect(ROOT/'memory.sqlite');src.backup(dst);dst.close();src.close()
  cases=load(PRIOR/'cases.json')['2']
  for c in cases:
   if c['audience']=='team':c['principal']='teammate'
  save(ROOT/'cases.json',cases)
  save(ROOT/'preparation.json',{'model_calls':0,'runtime_freeze_ms':(time.monotonic()-started)*1000,'source':'synthetic only','prior_results':'actual successful stage2 freshness actions','fixed_model_response_replay':False})
def helper(work,principal,cmd,value):
 env=os.environ.copy();env.update(ORGBRAIN_REUSE_ROOT=str(work),ORGBRAIN_USE_PRINCIPAL=principal)
 p=subprocess.run([NODE,str(HELPER),cmd,json.dumps(value)],cwd=work,env=env,capture_output=True,text=True,timeout=60)
 if p.returncode:raise RuntimeError(p.stderr[-2500:])
 return json.loads(p.stdout)
def setup(case,condition):
 started=time.monotonic();session=str(uuid.uuid4());rid='claude:'+session;directory=ROOT/'runs'/rid
 directory.mkdir(parents=True)
 p=subprocess.run([NODE,str(ADAPTER),'prepare',str(ROOT),rid,json.dumps({'channel':'object','condition':'none','case_id':case['id'],'revision':1})],cwd=REPO,capture_output=True,text=True,timeout=60)
 if p.returncode:raise RuntimeError(p.stderr[-2000:])
 state=load(directory/'state.json');state.update(records=case['records'],principal=case['principal']);state['scope']['principal_id']=case['principal'];state['expected']['partitions']=(case['records']+state['rule']['batch_size']-1)//state['rule']['batch_size'];save(directory/'state.json',state)
 work=Path(tempfile.mkdtemp(prefix='orgbrain-resolve-',dir='/private/tmp'));(work/'.local/memory-reuse').mkdir(parents=True);(work/'docs').mkdir()
 for target in ['queue','ledger','archive','billing']:(work/'docs'/f'{target}.md').write_text('Synthetic maintenance object.\n')
 src=sqlite3.connect(ROOT/'memory.sqlite');dst=sqlite3.connect(work/'memory.sqlite');src.backup(dst);dst.close();src.close()
 argv=[NODE,str(ADAPTER),'api',str(ROOT),rid]
 action={'argv':argv,'operations':['apply'],'object_type_key':'file','object_id':f"docs/{case['target']}.md",'target_field':'plan.target','target_value':case['target'],'source_argv':argv,'source_requests':[{'op':'read','document':case['target']+'.json'}]}
 config={'tenant_id':'default','project_id':'org-brain','db_path':str(work/'memory.sqlite'),'flags':{'object':condition!='none'},'delivery_mode':'inline','tracking_mode':'bundled','bindings':load(ROOT/'bindings.json'),'observation_purpose':'test','action_adapters':{'plan':action},'evaluation_consumer':case['principal']}
 prior=None;prime=[];import_ms=0
 if condition!='none' and case['eligible']:
  binding=next(x for x in config['bindings'] if action['object_id'] in x['targets']);action.update(freshness_profile='plan',conditions={'target':case['target'],'records':case['records']},required_fields=FIELDS)
  config.update(source_resolution='verified',freshness_mode='validated',freshness_profiles={'plan':{'argv':[NODE,str(BASE/'scripts/memory-reuse-source-validator.mjs')],'refs':[{'source_id':binding['source_id'],'source_version':binding['source_version']}],'source_root':str(ROOT),'source_files':['corpus.json'],'dependency_files':[str(ADAPTER),str(BASE/'packages/orgbrain-cli/src/lib/memory-reuse.mjs')],'environment':{'workflow':'synthetic_plan_v1'},'valid_for_ms':600000,'coverage_contract':{'kind':'complete_source','fields':FIELDS}}})
  if condition=='results':
   config['result_mode']='validated';action['result_contract']={'operation':'apply','payload_field':'plan','result_field':'applied_plan'}
  save(work/'.local/memory-reuse/config.json',config)
  previous=next(x for x in load(LEDGER) if x.get('channel')=='bundled_freshness' and x.get('revision')==2 and x['condition']=='freshness' and x['case']==case['id'])
  owner=previous['principal'] if condition=='results' else case['principal'];prime.append(helper(work,owner,'prime',{'profile_id':'plan','input':action['conditions']}))
  if condition=='results':
   import_started=time.monotonic()
   imp=subprocess.run([NODE,str(BASE/'scripts/memory-reuse-result-import.mjs'),json.dumps({'root':str(work),'prior':str(PRIOR/'runs'/previous['id']),'adapter_sha256':sha(ADAPTER)})],cwd=work,capture_output=True,text=True,timeout=60)
   if imp.returncode:raise RuntimeError(imp.stderr[-2500:])
   prior=json.loads(imp.stdout)
   import_ms=(time.monotonic()-import_started)*1000
   if owner!=case['principal']:prime.append(helper(work,case['principal'],'prime',{'profile_id':'plan','input':action['conditions']}))
 else:save(work/'.local/memory-reuse/config.json',config)
 lib=BASE/'packages/orgbrain-cli/src/lib/memory-reuse-claude.mjs';prefix=shlex.join([NODE,str(HELPER)])
 settings=a.m.node(f"import {{mergeReuseHooks}} from {json.dumps(lib.as_uri())};console.log(JSON.stringify(mergeReuseHooks({{autoMemoryEnabled:false,promptSuggestionEnabled:false}},{json.dumps(prefix)},{{bundled:true}})));")
 save(work/'settings.json',settings);save(directory/'mcp.json',{'mcpServers':{}})
 task={'target':case['target'],'records':case['records']};query=json.dumps({'task_id':rid,'adapter':'plan'},separators=(',',':'));run=json.dumps({'task_id':rid,'adapter':'plan','input':{'op':'apply','plan':{}},'uses':[]},separators=(',',':'))
 prompt=f"Perform {case['target']}.plan maintenance for records={case['records']}. Apply a plan with all seven fields: {', '.join(FIELDS)}. Preserve all current source constraints. Use a supplied complete reference or matching previous result directly; resolve only missing or invalid information. Resolve command: {prefix} resolve '{query}'. Action shape: {prefix} run '{run}'. Follow the supplied reference instruction for explicit uses and freshness_profile when applicable. Return a short final status.\n<task_input>"+json.dumps(task,separators=(',',':'))+'</task_input>'
 cli=['claude','-p','--verbose','--include-hook-events','--input-format','stream-json','--output-format','stream-json','--no-session-persistence','--session-id',session,'--setting-sources','','--settings',str(work/'settings.json'),'--strict-mcp-config','--mcp-config',str(directory/'mcp.json'),'--tools','Bash','--allowedTools',*[f'Bash({NODE} {HELPER} {c} *)' for c in ['resolve','run']],'--disable-slash-commands','--model',MODEL,'--effort','medium','--max-turns','8','--max-budget-usd','0.10','--system-prompt',SYSTEM,'--prompt-suggestions','false']
 env=os.environ.copy();env.update(ORGBRAIN_REUSE_ROOT=str(work),ORGBRAIN_USE_PRINCIPAL=case['principal'],CLAUDE_CODE_DISABLE_AUTO_MEMORY='1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1',CLAUDE_CODE_DISABLE_BACKGROUND_TASKS='1',ENABLE_TOOL_SEARCH='false')
 attempt={'id':rid,'label':f"resolution-{case['id']:02d}-{condition}",'channel':CHANNEL,'phase':'resolution','prompt_revision':2,'condition':condition,'case':case['id'],'audience':case['audience'],'eligible':case['eligible'],'principal':case['principal'],'target':case['target'],'workspace':str(work),'argv':cli,'setup_ms':(time.monotonic()-started)*1000,'result_import_ms':import_ms,'freshness_prime':prime,'prior_result':prior,'runtime_manifest_sha256':sha(BASE/'manifest.json'),'adapter_sha256':sha(ADAPTER)}
 save(directory/'prepared.json',attempt);return attempt,prompt,env
def finalize(attempt,records):
 d=ROOT/'runs'/attempt['id'];w=Path(attempt['workspace']);events=rows(d/'events.jsonl');result=next((x for x in reversed(events) if x.get('type')=='result'),{});save(d/'result.json',result)
 calls=rows(d/'calls.jsonl');journals=list((w/'.local/memory-reuse/native-evidence').glob('*.jsonl'));journal=rows(journals[0]) if journals else []
 native=a.m.native_calls(events,{x['tool_use_id'] for x in result.get('permission_denials',[])});outputs={x['payload']['call_id']:x['payload']['output'] for x in journal if x.get('payload',{}).get('type')=='function_call_output'};actual=[];match=True
 for b in native:
  try:
   tokens=shlex.split(b['input']['command']);assert len(tokens)==4 and tokens[:2]==[NODE,str(HELPER)] and tokens[2] in ['run','resolve'];request=json.loads(tokens[3]);assert request['task_id']==attempt['id'] and request['adapter']=='plan';out=json.loads(outputs[b['id']]);key='reuse_invocation_id' if tokens[2]=='run' else 'source_resolution_id';folder='invocations' if tokens[2]=='run' else 'resolutions';r=load(w/'.local/memory-reuse'/folder/(out[key]+'.json'));assert r['request']==request and r['output']==out and r['rawRequest']==tokens[3]
   if tokens[2]=='resolve':actual.extend(r['backend_requests'])
   else:
    if request.get('result_id'):
     db=sqlite3.connect(w/'memory.sqlite');payload=json.loads(db.execute('select payload_json from memory_reuse_artifacts where id=?',(request['result_id'],)).fetchone()[0]);db.close();actual.append({'op':'apply','plan':payload})
    else:actual.append(request['input'])
  except (AssertionError,KeyError,ValueError,TypeError):match=False
 match=match and sorted(json.dumps(x,sort_keys=True) for x in actual)==sorted(json.dumps(x['args'],sort_keys=True) for x in calls)
 state=load(d/'state.json');applies=[x for x in calls if x['args'].get('op')=='apply'];good=bool(applies and all(x['result'].get('ok') and x['result'].get('applied_plan')==state['expected'] for x in applies))
 observation=load(w/'.local/memory-reuse/last-observation.json',{});usage=result.get('usage');tokens=a.e.provider_tokens(usage);model_ok=list(result.get('modelUsage',{}))==[MODEL];hooks=[x for x in events if x.get('subtype')=='hook_response' and x.get('exit_code')!=0]
 db=sqlite3.connect(w/'memory.sqlite');db.row_factory=sqlite3.Row;pairs=[dict(x) for x in db.execute("select distinct source_id,source_version from memory_use_contexts where task_id=? and verification_state='verified' and revoked_at is null",(attempt['id'],))];receipts=[dict(x) for x in db.execute('select * from local_use_observation_receipts where task_id=?',(attempt['id'],))];db.close()
 derived=observation.get('derived_applications');applications=derived if isinstance(derived,list) else []
 for name in ['native-evidence','invocations','freshness','resolutions']:
  p=w/'.local/memory-reuse'/name
  if p.exists():shutil.copytree(p,d/name,dirs_exist_ok=True)
 save(d/'config.json',load(w/'.local/memory-reuse/config.json'));save(d/'evidence-receipts.json',receipts);save(d/'observation.json',observation)
 if (w/'.local/memory-reuse/prior-result-import.json').exists():shutil.copyfile(w/'.local/memory-reuse/prior-result-import.json',d/'prior-result-import.json')
 messages={x['message']['id'] for x in events if x.get('type')=='assistant' and isinstance(x.get('message'),dict)}
 attempt.update(status='observed' if tokens is not None and model_ok and match and not hooks and not attempt['timeout'] else 'infrastructure_failed',success=good,meaning_preserved=good,total_tokens=tokens,usage=usage,api_equivalent_usd=result.get('total_cost_usd'),model_usage=result.get('modelUsage'),native_arguments_match=match,hook_errors=hooks,collection=observation.get('collection'),verified_sources=pairs,derived_applications=derived,read_calls=sum(x['args'].get('op') in ['index','read'] for x in calls),apply_calls=len(applies),model_responses=len(messages),total_ms=attempt['setup_ms']+attempt['cli_ms'],actual_billing_usd=None)
 save(LEDGER,records);save(d/'outcome.json',attempt);print(json.dumps({k:attempt[k] for k in ['label','status','success','total_tokens','read_calls','derived_applications']},ensure_ascii=False),flush=True)
 if attempt['status']!='observed':raise RuntimeError('retain_failure_no_automatic_retry')
def run(limit):
 prepare();done=0
 assert load(ROOT/'budget-proposal.json')['approved_cumulative_cap']==CAP
 for case in load(ROOT/'cases.json'):
  r=(case['id']-1)%3
  for condition in ARMS[r:]+ARMS[:r]:
   records=load(LEDGER);label=f"resolution-{case['id']:02d}-{condition}"
   if any(x.get('label')==label for x in records):continue
   if done>=limit:return
   current=[x for x in records if x['channel']==CHANNEL];fees=a.m.strict_total(current,'api_equivalent_usd') if current else 0
   if fees is None or fees+0.10>1.0:raise RuntimeError('evaluation_cost_stop_threshold')
   if len(records)>=CAP:raise RuntimeError('cumulative_budget_exhausted')
   attempt,prompt,env=setup(case,condition);records=execute_cli(attempt['argv'],prompt,Path(attempt['workspace']),env,ROOT/'runs'/attempt['id'],LEDGER,attempt,CAP);finalize(attempt,records);done+=1
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--prepare',action='store_true');p.add_argument('--dry-prepare',action='store_true');p.add_argument('--limit',type=int,default=30);args=p.parse_args()
 if args.prepare:prepare()
 elif args.dry_prepare:
  prepare()
  for c in load(ROOT/'cases.json'):
   for arm in ARMS:setup(c,arm)
  print('30 preparations verified; model starts 0')
 else:run(args.limit)
