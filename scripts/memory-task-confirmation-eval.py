"""Real-Claude task confirmation pilot. --prepare and --dry-prepare never start a model."""
import argparse,hashlib,importlib.util,json,os,shlex,shutil,sqlite3,subprocess,tempfile,time,uuid
from pathlib import Path
from claude_reuse_execution import execute_cli
spec=importlib.util.spec_from_file_location('resolution',Path(__file__).with_name('memory-reuse-resolution-eval.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
REPO=m.REPO;ROOT=REPO/'artifacts/memory-task-confirmation-20261029';BASE=ROOT/'runtime/r32';LEDGER=m.LEDGER;NODE=m.NODE;MODEL=m.MODEL;CAP=384;CHANNEL='task_confirmation_v1';HELPER=BASE/'scripts/memory-reuse-claude.mjs';ADAPTER=BASE/'scripts/memory-task-confirmation-adapter.mjs';load=m.load;save=m.save;rows=m.rows
SYSTEM='Complete the bounded synthetic research, analysis, or document task using only the configured run command. Respect the task confirmation hook. When it requests AskUserQuestion, ask exactly that native question and wait for its result. Never supply an answer yourself. If the user accepts existing work, end with the result link and do no work. For delta, read only the approved new units and preserve every other existing section exactly. For full execution, read and produce every requested unit. Use one exact Bash invocation with single-quoted JSON and no compound commands. Do not use agents, other commands, files or services. Keep final status short. Write section bodies in English. For analysis include revenue=N, cost=N, profit=N using the current data. For research/documents retain all source fact sentences verbatim within your authored section.'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def accounting(result):
 models=result.get('modelUsage')
 if not isinstance(models,dict) or list(models)!=[MODEL]:return None,None
 model=models[MODEL];keys={'input_tokens':'inputTokens','cache_creation_input_tokens':'cacheCreationInputTokens','cache_read_input_tokens':'cacheReadInputTokens','output_tokens':'outputTokens'}
 if any(type(model.get(k)) is not int or model[k]<0 for k in keys.values()):return None,None
 usage={k:model[v] for k,v in keys.items()};return sum(usage.values()),usage
def sqlite_copy(src,dst):
 a=sqlite3.connect(src);b=sqlite3.connect(dst);a.backup(b);b.close();a.close()
def node(code):
 p=subprocess.run([NODE,'--input-type=module','-e',code],cwd=REPO,capture_output=True,text=True,timeout=60)
 if p.returncode:raise RuntimeError(p.stderr[-2000:])
 return json.loads(p.stdout)
def prepare():
 ROOT.mkdir(exist_ok=True)
 if not BASE.exists():
  (BASE/'scripts').mkdir(parents=True);shutil.copytree(REPO/'packages/orgbrain-cli/src',BASE/'packages/orgbrain-cli/src');shutil.copytree(REPO/'packages/shared/src',BASE/'packages/shared/src')
  for n in ['memory-reuse-claude.mjs','memory-task-confirmation-adapter.mjs','memory-task-simulated-answer.mjs']:shutil.copyfile(REPO/'scripts'/n,BASE/'scripts'/n)
  save(BASE/'manifest.json',{str(p.relative_to(BASE)):sha(p) for p in BASE.rglob('*') if p.is_file()})
  for n in ['orgbrain-cli','shared']:(BASE/'packages'/n/'node_modules').symlink_to(REPO/'packages'/n/'node_modules',target_is_directory=True)
 for f,h in load(BASE/'manifest.json').items():assert sha(BASE/f)==h,f
 if not (ROOT/'source.json').exists():
  data={'research':{'title':'Vendor comparison','labels':{'a':'Vendor A','b':'Vendor B','c':'Vendor C'},'units':{'a':{'facts':['Vendor A supports local processing.','The price is 8 units.']},'b':{'facts':['Vendor B retains logs for 14 days.']},'c':{'facts':['Vendor C requires manual approval.']}}},'analysis':{'title':'Monthly performance','labels':{'a':'January','b':'February','c':'March'},'units':{'a':{'revenue':120,'cost':80},'b':{'revenue':200,'cost':90},'c':{'revenue':170,'cost':100}}},'document':{'title':'Atlas guide','labels':{'a':'Overview','b':'Workflow','c':'Limits'},'units':{'a':{'facts':['Project Atlas runs locally.']},'b':{'facts':['Use the review command before export.']},'c':{'facts':['Exports are limited to 64 items.']}}}}
  save(ROOT/'source.json',data);cases=[{'id':i*3+j+1,'kind':kind,'workflow':kind,'choice':choice,'units':['a','b'] if choice=='existing' else ['a','b','c']} for i,kind in enumerate(data) for j,choice in enumerate(['existing','delta','full'])];save(ROOT/'cases.json',cases)
  store=(BASE/'packages/orgbrain-cli/src/lib/local-memory-store.mjs').as_uri();db=str(ROOT/'memory.sqlite')
  node(f"import {{LocalMemoryStore}} from {json.dumps(store)};const s=new LocalMemoryStore({json.dumps(db)},{{denseEmbeddingProvider:null}});await s.init();for(const kind of ['research','analysis','document'])await s.capture({{id:'task-source-'+kind,external_key:'task-source:'+kind,tenant_id:'default',project_id:'org-brain',work_type:'implementation',kind:'fact',content:'Confirmed synthetic '+kind+' source facts.',rationale:'Controlled local task fixture.',reuse_rule:'Only the corresponding synthetic workflow and source version.',source:'evaluation-fixture',verification_state:'verified',verified_at:Date.now(),capture_origin:'observed',learning:{{fixture:true}}}});console.log(JSON.stringify({{seeded:true,model_calls:0}}));")
def setup(case,condition,phase):
 started=time.monotonic();session=str(uuid.uuid4());rid='claude:'+session;d=ROOT/'runs'/rid;d.mkdir(parents=True);work=Path(tempfile.mkdtemp(prefix='orgbrain-task-confirm-',dir='/private/tmp'));(work/'.local/memory-reuse').mkdir(parents=True)
 shutil.copyfile(ROOT/'source.json',work/'source.json');save(work/'case.json',case);sqlite_copy(ROOT/'memory.sqlite',work/'memory.sqlite')
 if (ROOT/'results').exists():shutil.copytree(ROOT/'results',work/'results')
 principal='author' if phase=='preparation' else 'member';data=load(ROOT/'source.json')[case['workflow']]
 workflow={'kind':case['kind'],'title':data['title'],'target':case['workflow'],'phrases':[case['workflow']+'.task'],'units':data['labels'],'default_units':['a','b','c'],'source_refs':[{'source_id':'task-source-'+case['kind'],'source_version':1}],'source_files':['source.json'],'environment':{'workflow':'task_confirmation_v1'},'valid_for_ms':604800000,'allowed_principals':['member'],'adapter':'work'}
 config={'tenant_id':'default','project_id':'org-brain','db_path':str(work/'memory.sqlite'),'flags':{},'delivery_mode':'inline','tracking_mode':'bundled','observation_purpose':'test','task_confirmation_mode':'ask' if condition=='confirmation' else 'off','task_workflows':{case['workflow']:workflow},'action_adapters':{'work':{'argv':[NODE,str(ADAPTER)],'operations':['read','write'],'object_type_key':'completed_work','object_id':case['workflow'],'task_workflow':case['workflow']}}};save(work/'.local/memory-reuse/config.json',config)
 prefix=shlex.join([NODE,str(HELPER)]);lib=(BASE/'packages/orgbrain-cli/src/lib/memory-reuse-claude.mjs').as_uri();settings=node(f"import {{mergeReuseHooks}} from {json.dumps(lib)};console.log(JSON.stringify(mergeReuseHooks({{autoMemoryEnabled:false,promptSuggestionEnabled:false}},{json.dumps(prefix)},{{bundled:true,taskConfirmation:true}})));")
 settings['hooks']['PreToolUse'].append({'matcher':'AskUserQuestion','hooks':[{'type':'command','command':shlex.join([NODE,str(BASE/'scripts/memory-task-simulated-answer.mjs')]),'timeout':20}]});save(work/'settings.json',settings);save(d/'mcp.json',{'mcpServers':{}})
 prompt=f"Complete the {case['kind']} task '{data['title']}' for units {json.dumps(case['units'])}. The hook defines the allowed scope and run commands. A write input contains units and sections mapping each unit ID to its report body. Produce a complete deliverable for all requested units, or finish with an existing result only if the native user answer accepts it.\n<reuse_task>"+json.dumps({'workflow':case['workflow'],'units':case['units']},separators=(',',':'))+'</reuse_task>'
 cli=['claude','-p','--verbose','--include-hook-events','--input-format','stream-json','--output-format','stream-json','--permission-prompt-tool','stdio','--no-session-persistence','--session-id',session,'--setting-sources','','--settings',str(work/'settings.json'),'--strict-mcp-config','--mcp-config',str(d/'mcp.json'),'--tools','Bash,AskUserQuestion','--allowedTools',f'Bash({NODE} {HELPER} run *)','AskUserQuestion','--disable-slash-commands','--model',MODEL,'--effort','medium','--max-turns','10','--max-budget-usd','0.05','--system-prompt',SYSTEM,'--prompt-suggestions','false']
 env=os.environ.copy();env.update(ORGBRAIN_REUSE_ROOT=str(work),ORGBRAIN_USE_PRINCIPAL=principal,ORGBRAIN_TASK_EVAL_SIMULATION='1',CLAUDE_CODE_DISABLE_AUTO_MEMORY='1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1',CLAUDE_CODE_DISABLE_BACKGROUND_TASKS='1',ENABLE_TOOL_SEARCH='false')
 attempt={'id':rid,'label':('task-prepare-'+case['kind'] if phase=='preparation' else f"task-{case['id']:02d}-{condition}-host-v2"),'channel':CHANNEL,'phase':phase,'condition':condition,'case':case['id'],'kind':case['kind'],'choice':case['choice'],'units':case['units'],'principal':principal,'workspace':str(work),'argv':cli,'setup_ms':(time.monotonic()-started)*1000,'runtime_manifest_sha256':sha(BASE/'manifest.json')};save(d/'prepared.json',attempt);return attempt,prompt,env
def finalize(attempt,records):
 d=ROOT/'runs'/attempt['id'];w=Path(attempt['workspace']);events=rows(d/'events.jsonl');result=next((x for x in reversed(events) if x.get('type')=='result'),{});save(d/'result.json',result);calls=rows(w/'calls.jsonl');save(d/'calls.json',calls);observation=load(w/'.local/memory-reuse/last-observation.json',{});completion=observation.get('task_completion') or {};answers=rows(w/'simulated-answers.jsonl');save(d/'simulated-answers.json',answers)
 native=[b for e in events if e.get('type')=='assistant' for b in e.get('message',{}).get('content',[]) if b.get('type')=='tool_use'];outputs={b['tool_use_id']:b for e in events if e.get('type')=='user' for b in e.get('message',{}).get('content',[]) if b.get('type')=='tool_result'};backend=[];match=True
 for b in native:
  if b['name']=='AskUserQuestion':continue
  try:
   assert b['name']=='Bash';argv=shlex.split(b['input']['command']);assert len(argv)==4 and argv[:3]==[NODE,str(HELPER),'run'];req=json.loads(argv[3]);tr=outputs[b['id']];assert not tr.get('is_error');out=json.loads(tr['content']);entry=load(w/'.local/memory-reuse/invocations'/(out['reuse_invocation_id']+'.json'));assert entry['request']==req and entry['output']==out and entry['native_call_id']==b['id'];backend.append(req['input'])
  except (AssertionError,KeyError,ValueError,FileNotFoundError):match=False
 match=match and sorted(json.dumps(x,sort_keys=True) for x in backend)==sorted(json.dumps(x['args'],sort_keys=True) for x in calls)
 expected_status='completed_full' if attempt['condition']=='control' else {'existing':'completed_with_existing_result','delta':'completed_delta','full':'completed_full'}[attempt['choice']]
 good=completion.get('status')==expected_status and all(c['result'].get('ok') for c in calls);tokens,usage=accounting(result);model_ok=list(result.get('modelUsage',{}))==[MODEL];hook_errors=[x for x in events if x.get('subtype')=='hook_response' and x.get('exit_code')!=0]
 sqlite_copy(w/'memory.sqlite',d/'evidence.sqlite');shutil.copytree(w/'.local/memory-reuse',d/'reuse',dirs_exist_ok=True)
 if (w/'results').exists():shutil.copytree(w/'results',d/'results',dirs_exist_ok=True)
 save(d/'observation.json',observation);save(d/'case.json',load(w/'case.json'));save(d/'config.json',load(w/'.local/memory-reuse/config.json'));shutil.copyfile(w/'source.json',d/'source.json')
 attempt.update(status='observed' if tokens is not None and model_ok and match and not hook_errors and not attempt['timeout'] else 'infrastructure_failed',success=good,total_tokens=tokens,usage=usage,api_equivalent_usd=result.get('total_cost_usd'),model_usage=result.get('modelUsage'),hook_errors=hook_errors,native_arguments_match=match,task_completion=completion,questions=sum(b['name']=='AskUserQuestion' for b in native),read_calls=sum(c['args']['op']=='read' for c in calls),write_calls=sum(c['args']['op']=='write' for c in calls),read_units=[u for c in calls if c['args']['op']=='read' for u in c['args']['units']],model_responses=len({e['message']['id'] for e in events if e.get('type')=='assistant'}),total_ms=attempt['setup_ms']+attempt['cli_ms'],actual_billing_usd=None)
 save(LEDGER,records);save(d/'outcome.json',attempt);print(json.dumps({k:attempt[k] for k in ['label','status','success','total_tokens','questions','read_calls','write_calls','task_completion']},ensure_ascii=False),flush=True)
 if attempt['status']!='observed' or not good:raise RuntimeError('retain_failure_no_automatic_retry')
 if attempt['phase']=='preparation':
  sqlite_copy(w/'memory.sqlite',ROOT/'memory.sqlite');shutil.copytree(w/'results',ROOT/'results',dirs_exist_ok=True)
def launch(case,condition,phase):
 records=load(LEDGER);current=[x for x in records if x.get('channel')==CHANNEL];fee=m.a.m.strict_total(current,'api_equivalent_usd') if current else 0
 if fee is None or fee+0.05>0.75:raise RuntimeError('evaluation_cost_stop_threshold')
 if len(records)>=CAP:raise RuntimeError('cumulative_budget_exhausted')
 attempt,prompt,env=setup(case,condition,phase);records=execute_cli(attempt['argv'],prompt,Path(attempt['workspace']),env,ROOT/'runs'/attempt['id'],LEDGER,attempt,CAP);finalize(attempt,records)
def run(limit):
 prepare();assert load(ROOT/'budget-proposal.json')['approved_cumulative_cap']==CAP;done=0
 for i,kind in enumerate(['research','analysis','document']):
  label='task-prepare-'+kind;existing=[x for x in load(LEDGER) if x.get('label')==label]
  if existing:
   if not existing[-1].get('success'):raise RuntimeError('failed_preparation_requires_review')
   continue
  if done>=limit:return
  launch({'id':-i-1,'kind':kind,'workflow':kind,'choice':'preparation','units':['a','b']},'control','preparation');done+=1
 for case in load(ROOT/'cases.json'):
  for condition in (['control','confirmation'] if case['id']%2 else ['confirmation','control']):
   if any(x.get('label')==f"task-{case['id']:02d}-{condition}-host-v2" for x in load(LEDGER)):continue
   if done>=limit:return
   launch(case,condition,'comparison');done+=1
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--prepare',action='store_true');p.add_argument('--dry-prepare',action='store_true');p.add_argument('--limit',type=int,default=21);args=p.parse_args()
 if args.prepare:prepare()
 elif args.dry_prepare:prepare();setup({'id':0,'kind':'research','workflow':'research','choice':'preparation','units':['a','b']},'control','preparation');print('Local setup passed; model starts 0')
 else:run(args.limit)
