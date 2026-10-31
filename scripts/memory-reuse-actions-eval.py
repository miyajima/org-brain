"""Sequential real-Claude evaluations. --prepare and --summarize never launch models."""
import argparse,hashlib,importlib.util,json,os,shlex,shutil,sqlite3,tempfile,time,uuid,subprocess
from pathlib import Path
from claude_reuse_execution import execute_cli
spec=importlib.util.spec_from_file_location('connected',Path(__file__).with_name('memory-reuse-connected.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
e=m.e;REPO=e.REPO;ROOT=REPO/'artifacts/memory-reuse-bundled-20261027';SOURCE=REPO/'artifacts/memory-reuse-efficiency-20261027';LEDGER=m.LEDGER;e.ROOT=ROOT
CAP=330;CHANNEL='bundled_freshness';ARMS={1:['none','inline','bundled'],2:['none','bundled','freshness']}
SYSTEM='Complete this bounded synthetic maintenance task using only the supplied source adapter and project recall/report/run/check commands. Generate the plan yourself from current applicable constraints. If memory informs an action, explicitly select its reference in the configured action request, or use the standalone report when that is the offered route. Never infer usefulness from a receipt. Do not use agents, other commands, files or services. Use one exact command invocation per Bash call, without shell variables, compound commands or quoting command paths. JSON arguments must use single quotes.'
def save(p,v):p.parent.mkdir(parents=True,exist_ok=True);e.save(p,v)
def freeze(name,baseline=False):
 base=ROOT/'runtime'/name
 if base.exists():
  for package in ['orgbrain-cli','shared']:
   p=base/'packages'/package/'node_modules'
   if not p.exists():p.symlink_to(REPO/'packages'/package/'node_modules',target_is_directory=True)
  return
 (base/'scripts').mkdir(parents=True)
 shutil.copytree(REPO/'packages/orgbrain-cli/src',base/'packages/orgbrain-cli/src')
 shutil.copytree(REPO/'packages/shared/src',base/'packages/shared/src')
 helper=SOURCE/'runtime/r02/scripts/memory-reuse-claude.mjs' if baseline else REPO/'scripts/memory-reuse-claude.mjs'
 shutil.copyfile(helper,base/'scripts/memory-reuse-claude.mjs')
 if baseline:
  shutil.copyfile(SOURCE/'runtime/r02/packages/orgbrain-cli/src/lib/memory-reuse-claude.mjs',base/'packages/orgbrain-cli/src/lib/memory-reuse-claude.mjs')
  import subprocess
  original=subprocess.check_output(['git','show','HEAD:packages/orgbrain-cli/src/lib/memory-use-collector.mjs'],cwd=REPO)
  expected=e.load(SOURCE/'protocol.json')['dependencies']['packages/orgbrain-cli/src/lib/memory-use-collector.mjs']
  assert hashlib.sha256(original).hexdigest()==expected
  (base/'packages/orgbrain-cli/src/lib/memory-use-collector.mjs').write_bytes(original)
 manifest={str(p.relative_to(base)):hashlib.sha256(p.read_bytes()).hexdigest() for p in base.rglob('*') if p.is_file()}
 save(base/'manifest.json',manifest)
 for package in ['orgbrain-cli','shared']:(base/'packages'/package/'node_modules').symlink_to(REPO/'packages'/package/'node_modules',target_is_directory=True)
def prepare(stage):
 started=time.monotonic();ROOT.mkdir(exist_ok=True)
 if not (ROOT/'cases.json').exists():
  a=e.load(LEDGER);assert len(a)==270 and not any(x['status']=='started' for x in a)
  for n in ['corpus.json','bindings.json']:shutil.copyfile(SOURCE/n,ROOT/n)
  src=sqlite3.connect(SOURCE/'memory.sqlite');dst=sqlite3.connect(ROOT/'memory.sqlite');src.backup(dst);dst.close();src.close()
  cases=e.load(SOURCE/'cases.json');save(ROOT/'cases.json',{str(s):[{**c,'records':c['records']+(313 if s==1 else 619)} for c in cases] for s in [1,2]})
  save(ROOT/'preparation.json',{'model_calls':0,'initial_setup_ms':(time.monotonic()-started)*1000,'source':'synthetic only; previous real-data DB never copied','fixed_provider_response_replay':False})
 if stage==1:freeze('r10',True);freeze('r11')
 else:freeze('r12')
def parsed_arguments(command,rid):
 try:tokens=shlex.split(command)
 except ValueError:return []
 api=[e.NODE,str(e.ADAPTER),'api',str(ROOT),rid]
 if tokens[:5]==api and len(tokens)==6:
  try:return [json.loads(tokens[5])]
  except ValueError:return []
 helpers={str(ROOT/'runtime'/v/'scripts/memory-reuse-claude.mjs') for v in ['r10','r11','r12']}
 if len(tokens)==4 and tokens[0]==e.NODE and tokens[2]=='run' and tokens[1] in helpers:
  try:
   request=json.loads(tokens[3]);return [request['input']] if request.get('task_id')==rid and request.get('adapter')=='plan' else []
  except (ValueError,KeyError):return []
 return []
e.native_adapter_arguments=parsed_arguments
def finalize(a,records):
 m.finish(a,records,ROOT)
 d=ROOT/'runs'/a['id'];w=Path(a['workspace']);db=sqlite3.connect(w/'memory.sqlite');db.row_factory=sqlite3.Row
 receipts=[dict(v) for v in db.execute('select * from local_use_observation_receipts where task_id=?',(a['id'],))];db.close();save(d/'evidence-receipts.json',receipts)
 for name in ['native-evidence','invocations','freshness']:
  p=w/'.local/memory-reuse'/name
  if p.exists():shutil.copytree(p,d/name,dirs_exist_ok=True)
 save(d/'config.json',e.load(w/'.local/memory-reuse/config.json'))
 events=e.rows(d/'events.jsonl');messages={v['message']['id']:v['message'] for v in events if v.get('type')=='assistant' and isinstance(v.get('message'),dict)}
 a['model_responses']=len(messages);a['bundled_action_calls']=sum(' run ' in b.get('input',{}).get('command','') and 'memory-reuse-claude.mjs' in b.get('input',{}).get('command','') for b in m.native_calls(events,set()))
 checks=e.rows(d/'freshness/check-events.jsonl');a['freshness_checks']=len(checks);a['freshness_check_ms']=sum(x['elapsed_ms'] for x in checks);a['freshness_source_bytes_read']=sum(x['source_bytes_read'] for x in checks)
 save(LEDGER,records);save(d/'outcome.json',a)
def run(stage,limit):
 if stage==2 and not e.load(ROOT/'report.json',{}).get('decisions',{}).get('1',{}).get('quality_and_reuse_pass'):raise RuntimeError('stage1_quality_review_required')
 prepare(stage);done=0;cases=e.load(ROOT/'cases.json')[str(stage)]
 for case in cases:
  rotation=(case['id']-1)%3;arms=ARMS[stage][rotation:]+ARMS[stage][:rotation]
  for condition in arms:
   label=f"actions-{stage}-{case['id']:02d}-{condition}";records=e.load(LEDGER)
   if any(x.get('label')==label for x in records):continue
   if done>=limit:return
   current=[x for x in records if x['channel']==CHANNEL]
   if any(x['status']=='started' for x in records):raise RuntimeError('active_or_unresolved_cli_attempt')
   if len(records)>=CAP:raise RuntimeError('cumulative_budget_exhausted')
   fees=m.strict_total(current,'api_equivalent_usd') if current else 0
   if fees is None or fees+0.10>2.0:raise RuntimeError('evaluation_cost_stop_threshold')
   started=time.monotonic();session=str(uuid.uuid4());rid='claude:'+session;directory=ROOT/'runs'/rid
   e.adapter('prepare',rid,{'channel':'object','condition':'none','case_id':case['id'],'revision':1})
   state=e.load(directory/'state.json');state['records']=case['records'];state['expected']['partitions']=(case['records']+state['rule']['batch_size']-1)//state['rule']['batch_size'];save(directory/'state.json',state)
   work=Path(tempfile.mkdtemp(prefix='orgbrain-actions-',dir='/private/tmp'));(work/'.local/memory-reuse').mkdir(parents=True);(work/'docs').mkdir()
   for target in ['queue','ledger','archive','billing']:(work/'docs'/f'{target}.md').write_text('Synthetic maintenance target; authoritative rule is available from the adapter.\n')
   src=sqlite3.connect(ROOT/'memory.sqlite');dst=sqlite3.connect(work/'memory.sqlite');src.backup(dst);dst.close();src.close()
   variant='r10' if stage==1 and condition in ('none','inline') else 'r12' if condition=='freshness' else 'r11'
   base=ROOT/'runtime'/variant;helper=base/'scripts/memory-reuse-claude.mjs';lib=base/'packages/orgbrain-cli/src/lib/memory-reuse-claude.mjs'
   manifest=e.load(base/'manifest.json');assert all(hashlib.sha256((base/f).read_bytes()).hexdigest()==h for f,h in manifest.items())
   action={'argv':[e.NODE,str(e.ADAPTER),'api',str(ROOT),rid],'operations':['apply'],'object_type_key':'file','object_id':f"docs/{case['target']}.md",'target_field':'plan.target','target_value':case['target']}
   config={'version':1,'tenant_id':'default','project_id':'org-brain','db_path':str(work/'memory.sqlite'),'flags':{'object':condition!='none'},'delivery_mode':'inline','bindings':e.load(ROOT/'bindings.json'),'observation_purpose':'test','action_adapters':{'plan':action}}
   if condition in ('bundled','freshness'):config['tracking_mode']='bundled'
   prime=None
   if condition=='freshness' and case['eligible']:
    config['freshness_mode']='validated';action.update(freshness_profile='plan',conditions={'target':case['target'],'records':case['records']})
    binding=next(x for x in config['bindings'] if action['object_id'] in x['targets'])
    config['freshness_profiles']={'plan':{'argv':[e.NODE,str(REPO/'scripts/memory-reuse-plan-validator.mjs')],'refs':[{'source_id':binding['source_id'],'source_version':binding['source_version']}],'source_root':str(ROOT),'source_files':['corpus.json'],'dependency_files':[str(e.ADAPTER),str(REPO/'packages/orgbrain-cli/src/lib/memory-reuse.mjs')],'environment':{'workflow':'synthetic_plan_v1'},'valid_for_ms':600000}}
   save(work/'.local/memory-reuse/config.json',config)
   if condition=='freshness' and case['eligible']:
    prime_env=os.environ.copy();prime_env.update(ORGBRAIN_REUSE_ROOT=str(work),ORGBRAIN_USE_PRINCIPAL=case['principal'])
    p=subprocess.run([e.NODE,str(helper),'prime',json.dumps({'profile_id':'plan','input':action['conditions']})],cwd=work,env=prime_env,capture_output=True,text=True,timeout=30)
    if p.returncode:raise RuntimeError(p.stderr[-2000:])
    prime=json.loads(p.stdout);assert prime['primed'] and prime['model_calls']==0
   prefix=shlex.join([e.NODE,str(helper)]);settings=m.node(f"import {{mergeReuseHooks}} from {json.dumps(lib.as_uri())};console.log(JSON.stringify(mergeReuseHooks({{autoMemoryEnabled:false,promptSuggestionEnabled:false}},{json.dumps(prefix)},{{bundled:true}})));")
   save(work/'settings.json',settings);save(directory/'mcp.json',{'mcpServers':{}})
   command=shlex.join([e.NODE,str(e.ADAPTER),'api',str(ROOT),rid])
   prompt=f"Perform {case['target']}.plan maintenance for records={case['records']}. Apply a plan with all seven fields: target (service name without extension), mode, batch_size, region, retain_days, deduplicate, partitions. Preserve current source constraints. Investigate through this adapter: "+command+" '<JSON>'. Operations: {\"op\":\"index\"}, {\"op\":\"read\",\"document\":\"NAME.json\"}, {\"op\":\"apply\",\"plan\":{...}}. Use exact single invocations, not shell aliases or compound commands. Report a short final status."
   argv=['claude','-p','--verbose','--include-hook-events','--input-format','stream-json','--output-format','stream-json','--no-session-persistence','--session-id',session,'--setting-sources','','--settings',str(work/'settings.json'),'--strict-mcp-config','--mcp-config',str(directory/'mcp.json'),'--tools','Bash','--allowedTools',f'Bash({e.NODE} {e.ADAPTER} api *)',*[f'Bash({e.NODE} {helper} {c} *)' for c in ['recall','report','run','check']],'--disable-slash-commands','--model',e.MODEL,'--effort','medium','--max-turns','8','--max-budget-usd','0.10','--system-prompt',SYSTEM,'--prompt-suggestions','false']
   env=os.environ.copy();env.update(ORGBRAIN_REUSE_ROOT=str(work),ORGBRAIN_USE_PRINCIPAL=case['principal'],CLAUDE_CODE_DISABLE_AUTO_MEMORY='1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1',CLAUDE_CODE_DISABLE_BACKGROUND_TASKS='1',ENABLE_TOOL_SEARCH='false')
   attempt={'id':rid,'label':label,'channel':CHANNEL,'phase':'actions','revision':stage,'condition':condition,'case':case['id'],'audience':case['audience'],'eligible':case['eligible'],'principal':case['principal'],'target':case['target'],'workspace':str(work),'argv':argv,'runtime_variant':variant,'setup_ms':(time.monotonic()-started)*1000,'freshness_prime':prime,'runtime_manifest_sha256':hashlib.sha256((base/'manifest.json').read_bytes()).hexdigest(),'adapter_sha256':hashlib.sha256(e.ADAPTER.read_bytes()).hexdigest()}
   records=execute_cli(argv,prompt,work,env,directory,LEDGER,attempt,CAP);finalize(attempt,records);done+=1

def summarize():
 allrows=e.load(LEDGER);runs=[x for x in allrows if x['channel']==CHANNEL];stages={}
 for stage in [1,2]:
  arms={}
  for condition in ARMS[stage]:
   g=[x for x in runs if x['revision']==stage and x['condition']==condition];uses=[x for x in g if (x.get('collection') or {}).get('recorded',0)>0]
   arms[condition]={'n':len(g),'success':sum(x.get('success',False) for x in g),'meaning_preserved':sum(x.get('meaning_preserved',False) for x in g),'unique_knowledge':len({r['source_id'] for x in uses for r in x['verified_sources']}),'use_tasks':len(uses),'personal_uses':sum(x['audience']=='personal' for x in uses),'team_uses':sum(x['audience']=='team' for x in uses),'ineligible_uses':sum(not x['eligible'] for x in uses),'missing_observation_tasks':sum(not isinstance((x.get('collection') or {}).get('recorded'),int) for x in g),**{k:m.strict_total(g,k) if g else None for k in ['total_tokens','api_equivalent_usd','read_calls','apply_calls','report_calls','recall_calls','model_responses','bundled_action_calls','total_ms']}}
  stages[str(stage)]=arms
 report={'cumulative_cli_starts':len(allrows),'new_cli_starts':len(runs),'max_cli_starts':CAP,'stages':stages,'new_api_equivalent_usd':m.strict_total(runs,'api_equivalent_usd') if runs else 0,'actual_billing_usd':None};save(ROOT/'report.json',report);print(json.dumps(report,ensure_ascii=False))
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--stage',type=int,choices=[1,2],default=1);p.add_argument('--limit',type=int,default=30);p.add_argument('--prepare',action='store_true');p.add_argument('--summarize',action='store_true');p.add_argument('--recover',action='store_true');a=p.parse_args()
 if a.prepare:prepare(a.stage)
 elif a.summarize:summarize()
 elif a.recover:
  records=e.load(LEDGER)
  for x in records:
   if x['channel']==CHANNEL and x['status']=='started':finalize(x,records)
 else:run(a.stage,a.limit)
