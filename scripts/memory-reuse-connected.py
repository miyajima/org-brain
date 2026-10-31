"""Live-model comparison through normal project hooks. Synthetic material only."""
import importlib.util,json,os,shlex,sqlite3,subprocess,tempfile,time,uuid,hashlib,argparse,math
from claude_reuse_execution import execute_cli
from pathlib import Path
spec=importlib.util.spec_from_file_location('evaluation',Path(__file__).with_name('memory-reuse-loop.py'));e=importlib.util.module_from_spec(spec);spec.loader.exec_module(e)
LEDGER=e.ROOT/'attempts.json';ROOT=e.REPO/'artifacts/memory-reuse-connected-20261027';e.ROOT=ROOT
HELPER=e.REPO/'scripts/memory-reuse-claude.mjs';LIB=e.REPO/'packages/orgbrain-cli/src/lib/memory-reuse-claude.mjs'
OWN=[HELPER,LIB,e.REPO/'packages/orgbrain-cli/src/lib/memory-reuse.mjs',e.ADAPTER,Path(__file__).resolve()]
def native_calls(events,denied):
 return [b for v in events if isinstance(v.get('message'),dict) and isinstance(v['message'].get('content'),list) for b in v['message']['content'] if isinstance(b,dict) and b.get('type')=='tool_use' and b['id'] not in denied]
def strict_total(rows,key):
 return sum(x[key] for x in rows) if rows and all(isinstance(x.get(key),(int,float)) and not isinstance(x[key],bool) and math.isfinite(x[key]) and x[key]>=0 for x in rows) else None
def node(code):
 p=subprocess.run([e.NODE,'--input-type=module','-e',code],capture_output=True,text=True,check=True);return json.loads(p.stdout)
def setup():
 ROOT.mkdir(parents=True,exist_ok=True)
 if (ROOT/'protocol.json').exists():return
 start=time.monotonic();e.adapter('setup');code=f"""import {{LocalMemoryStore}} from {json.dumps((e.REPO/'packages/orgbrain-cli/src/lib/local-memory-store.mjs').as_uri())};
 const store=new LocalMemoryStore({json.dumps(str(ROOT/'memory.sqlite'))},{{denseEmbeddingProvider:null}});
 const bindings=[];
 for(const target of ['queue','ledger','archive','billing']){{const m=await store.get('default','synthetic-'+target);
 const result=await store.capture({{...m,external_key:'reuse-loop:'+target,verification_state:'verified',verified_at:Date.now(),capture_origin:'observed',learning:{{fixture:true,origin:'synthetic'}},source_references:[{{ref:'source:synthetic-'+target+'@1'}}]}});
 const current=await store.get('default',result.memory_id);
 bindings.push({{source_id:current.id,source_version:current.current_version,source_ref:current.source_references[0].ref,targets:['docs/'+target+'.md'],phrases:[target+'.plan']}});}}
 console.log(JSON.stringify(bindings));"""
 bindings=node(code);e.save(ROOT/'bindings.json',bindings)
 corpus=e.load(ROOT/'corpus.json');cases=[]
 for c in corpus['cases']:cases.append({**c,'prompt':f"Perform the {c['target']}.plan maintenance task for records={c['records']}."})
 e.save(ROOT/'cases.json',cases);e.save(ROOT/'holdout.json',[{**c,'records':c['records']+101,'prompt':f"Continue {c['target']}.plan maintenance with records={c['records']+101}."} for c in cases])
 e.save(ROOT/'protocol.json',{'max_cumulative_cli_starts':240,'prior_cli_starts':len(e.load(LEDGER)),'model':e.MODEL,'effort':'medium','per_condition':10,'positive_cases':8,'negative_cases':2,'personal_cases':5,'team_cases':5,'conditions':'same prompt and original tool sources, only object flag enabled/disabled; no provided memory in user prompt','material':'synthetic only; real memory DB is never copied or sent to Claude','max_comparisons':2,'setup_model_calls':0,'setup_ms':(time.monotonic()-start)*1000,'implementation_sha256':{str(p.relative_to(e.REPO)):hashlib.sha256(p.read_bytes()).hexdigest() for p in OWN}})
def run(revision,limit):
 setup();attempts=e.load(LEDGER);cases=e.load(ROOT/('cases.json' if revision==1 else 'holdout.json'))
 if any(x['status']=='started' for x in attempts):raise RuntimeError('active_or_unresolved_cli_attempt')
 done=0
 for case in cases:
  for condition in (['none','memory'] if case['id']%2 else ['memory','none']):
   label=f"normal-r{revision}-{case['id']:02d}-{condition}"
   if any(x.get('label')==label for x in attempts):continue
   if done>=limit:return
   attempts=e.load(LEDGER)
   if len(attempts)>=240:raise RuntimeError('cumulative_budget_exhausted')
   start=time.monotonic();session=str(uuid.uuid4());rid='claude:'+session;dir=ROOT/'runs'/rid
   state=e.adapter('prepare',rid,{'channel':'object','condition':'none','case_id':case['id'],'revision':revision})
   # Holdout changes task inputs before model execution, symmetrically in both arms.
   s=e.load(dir/'state.json');s['records']=case['records'];s['expected']['partitions']=(case['records']+s['rule']['batch_size']-1)//s['rule']['batch_size'];e.save(dir/'state.json',s)
   work=Path(tempfile.mkdtemp(prefix='orgbrain-normal-',dir='/private/tmp'));(work/'.local/memory-reuse').mkdir(parents=True);(work/'docs').mkdir()
   for t in ['queue','ledger','archive','billing']:(work/'docs'/f'{t}.md').write_text('Synthetic maintenance target; use the source index for current constraints.\n')
   src=sqlite3.connect(ROOT/'memory.sqlite');dst=sqlite3.connect(work/'memory.sqlite');src.backup(dst);dst.close();src.close()
   e.save(work/'.local/memory-reuse/config.json',{'version':1,'tenant_id':'default','project_id':'org-brain','db_path':str(work/'memory.sqlite'),'flags':{'object':condition=='memory'},'bindings':e.load(ROOT/'bindings.json'),'observation_purpose':'test'})
   prefix=shlex.join([e.NODE,str(HELPER)])
   settings=node(f"import {{mergeReuseHooks}} from {json.dumps(LIB.as_uri())};console.log(JSON.stringify(mergeReuseHooks({{autoMemoryEnabled:false,promptSuggestionEnabled:false}},{json.dumps(prefix)})));")
   e.save(work/'settings.json',settings);e.save(dir/'mcp.json',{'mcpServers':{}})
   api=shlex.join([e.NODE,str(e.ADAPTER),'api',str(ROOT),rid])
   prompt=case['prompt']+' Apply a plan with all seven fields: target (the service name without extension), mode, batch_size, region, retain_days, deduplicate, partitions. Preserve current source constraints. You can investigate through the same source adapter: '+api+" '<JSON>'. Operations: {\"op\":\"index\"}, {\"op\":\"read\",\"document\":\"NAME.json\"}, {\"op\":\"apply\",\"plan\":{...}}. Report a short final status."
   argv=['claude','-p','--verbose','--include-hook-events','--input-format','stream-json','--output-format','stream-json','--no-session-persistence','--session-id',session,'--setting-sources','','--settings',str(work/'settings.json'),'--strict-mcp-config','--mcp-config',str(dir/'mcp.json'),'--tools','Bash','--allowedTools',f'Bash({e.NODE} {e.ADAPTER} api *)',f'Bash({e.NODE} {HELPER} recall *)',f'Bash({e.NODE} {HELPER} report *)','--disable-slash-commands','--model',e.MODEL,'--effort','medium','--max-turns','8','--max-budget-usd','1','--system-prompt','Complete this bounded synthetic maintenance task using only the supplied source adapter and project recall/report commands. Generate the plan yourself from applicable current constraints. Report memory use only if it actually informed a completed action, printing the use_receipt. Do not use agents, other commands, files or services. A receipt does not establish usefulness.','--prompt-suggestions','false']
   env=os.environ.copy();env.update(ORGBRAIN_REUSE_ROOT=str(work),ORGBRAIN_USE_PRINCIPAL=case['principal'],CLAUDE_CODE_DISABLE_AUTO_MEMORY='1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1',CLAUDE_CODE_DISABLE_BACKGROUND_TASKS='1',ENABLE_TOOL_SEARCH='false')
   a={'id':rid,'label':label,'channel':'normal_workflow','phase':'workflow','revision':revision,'status':'started','order':len(attempts)+1,'condition':condition,'case':case['id'],'audience':case['audience'],'eligible':case['eligible'],'principal':case['principal'],'target':case['target'],'workspace':str(work),'argv':argv,'setup_ms':(time.monotonic()-start)*1000,'implementation_sha256':{str(p.relative_to(e.REPO)):hashlib.sha256(p.read_bytes()).hexdigest() for p in OWN}}
   attempts=execute_cli(argv,prompt,work,env,dir,LEDGER,a,240)
   finish(a,attempts);done+=1

def finish(a,attempts,root=None):
 dir=(root or ROOT)/'runs'/a['id'];events=e.rows(dir/'events.jsonl');result=next((v for v in reversed(events) if v.get('type')=='result'),{});e.save(dir/'result.json',result)
 calls=e.rows(dir/'calls.jsonl');s=e.load(dir/'state.json');applies=[c for c in calls if c['args'].get('op')=='apply'];good=[c for c in applies if c['result'].get('ok') is True and c['result'].get('applied_plan')==s['expected']]
 observation=e.load(Path(a['workspace'])/'.local/memory-reuse/last-observation.json',{})
 denied={x['tool_use_id'] for x in result.get('permission_denials',[])}
 native=native_calls(events,denied)
 args=[args for b in native for args in e.native_adapter_arguments(b['input']['command'],a['id'])]
 match=sorted(json.dumps(x,sort_keys=True) for x in args)==sorted(json.dumps(x['args'],sort_keys=True) for x in calls)
 hooks=[v for v in events if v.get('subtype')=='hook_response'];hook_errors=[v['hook_name'] for v in hooks if v.get('exit_code')!=0]
 usage=result.get('usage');tokens=e.provider_tokens(usage);model_ok=bool(result.get('modelUsage')) and list(result['modelUsage'])==[e.MODEL]
 db=sqlite3.connect(Path(a['workspace'])/'memory.sqlite');db.row_factory=sqlite3.Row
 pairs=[dict(v) for v in db.execute("select distinct source_id,source_version from memory_use_contexts where task_id=? and verification_state='verified' and revoked_at is null",(a['id'],))];db.close()
 a.update(verified_sources=pairs,status='observed' if tokens is not None and model_ok and match and not a['timeout'] else 'infrastructure_failed',success=bool(good),meaning_preserved=bool(good),total_tokens=tokens,usage=usage,api_equivalent_usd=result.get('total_cost_usd'),actual_enterprise_charge_usd=None,model_usage=result.get('modelUsage'),native_arguments_match=match,native_hook_observation=observation,collection=observation.get('collection'),hook_errors=hook_errors,read_calls=sum(c['args'].get('op') in ('index','read') for c in calls),apply_calls=len(applies),first_attempt_success=bool(applies and applies[0]['result'].get('ok')),total_ms=a['setup_ms']+a['cli_ms'],recall_calls=sum('memory-reuse-claude.mjs recall ' in b['input']['command'] for b in native),report_calls=sum('memory-reuse-claude.mjs report ' in b['input']['command'] for b in native),permission_denials=result.get('permission_denials',[]))
 e.save(LEDGER,attempts);e.save(dir/'outcome.json',a);print(json.dumps({k:a[k] for k in ['label','status','success','total_tokens','collection','hook_errors']}),flush=True)
 if a['status']!='observed' or hook_errors:raise RuntimeError('retain_failure_no_automatic_retry')

def summarize():
 attempts=e.load(LEDGER);runs=[x for x in attempts if x['channel']=='normal_workflow'];report={'cumulative_cli_starts':len(attempts),'max_cli_starts':240,'runs':len(runs),'revisions':{}}
 for rev in sorted({x['revision'] for x in runs}):
  g=[x for x in runs if x['revision']==rev];summary={}
  for condition in ('none','memory'):
   arm=[x for x in g if x['condition']==condition];n=len(arm)
   summary[condition]={'n':n,'complete':n==10 and all(x['status']=='observed' for x in arm),'unique_knowledge_reused':len({v['source_id'] for x in arm for v in x.get('verified_sources',[])}),'observation_missing_tasks':sum(not isinstance((x.get('collection') or {}).get('recorded'),int) for x in arm),'success':sum(x.get('success',False) for x in arm),'meaning_preserved':sum(x.get('meaning_preserved',False) for x in arm),'total_tokens':strict_total(arm,'total_tokens'),'mean_ms':strict_total(arm,'total_ms')/n if n and strict_total(arm,'total_ms') is not None else None,'api_equivalent_usd':strict_total(arm,'api_equivalent_usd'),'read_calls':sum(x.get('read_calls',0) for x in arm),'recall_calls':sum(x.get('recall_calls',0) for x in arm),'report_calls':sum(x.get('report_calls',0) for x in arm),'verified_use_tasks':sum((x.get('collection') or {}).get('recorded',0)>0 for x in arm),'personal_uses':sum(x['audience']=='personal' and (x.get('collection') or {}).get('recorded',0)>0 for x in arm),'team_uses':sum(x['audience']=='team' and (x.get('collection') or {}).get('recorded',0)>0 for x in arm),'ineligible_uses':sum(not x['eligible'] and (x.get('collection') or {}).get('recorded',0)>0 for x in arm),'native_hook_errors':sum(bool(x.get('hook_errors')) for x in arm)}
  report['revisions'][str(rev)]=summary
 report['all_cli_tokens']=sum(x['total_tokens'] for x in attempts) if all(isinstance(x.get('total_tokens'),(int,float)) for x in attempts) else None
 report['all_cli_api_equivalent_usd']=sum(x['api_equivalent_usd'] for x in attempts) if all(isinstance(x.get('api_equivalent_usd'),(int,float)) for x in attempts) else None
 e.save(ROOT/'report.json',report);print(json.dumps(report,ensure_ascii=False))
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--revision',type=int,choices=[1,2],default=1);p.add_argument('--limit',type=int,default=20);p.add_argument('--summarize',action='store_true');p.add_argument('--recover',action='store_true');arg=p.parse_args()
 if arg.summarize:summarize()
 elif arg.recover:
  aa=e.load(LEDGER)
  for a in aa:
   if a['channel']=='normal_workflow' and a['status']=='started':finish(a,aa)
 else:run(arg.revision,arg.limit)
