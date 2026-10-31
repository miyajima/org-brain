"""Three-arm native Claude comparison. Explicit extension: cumulative limit 270."""
import argparse,hashlib,importlib.util,json,os,shlex,sqlite3,tempfile,time,uuid,itertools
from pathlib import Path
from claude_reuse_execution import execute_cli
spec=importlib.util.spec_from_file_location('workflow',Path(__file__).with_name('memory-reuse-connected.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
e=m.e;ROOT=e.REPO/'artifacts/memory-reuse-efficiency-20261027';SOURCE=e.REPO/'artifacts/memory-reuse-connected-20261027';e.ROOT=ROOT
ARMS=['none','current','improved'];CAP=270
SYSTEM='Complete this bounded synthetic maintenance task using only the supplied source adapter and project recall/report commands. Generate the plan yourself from applicable current constraints. Report memory use only if it actually informed a completed action, printing the use_receipt. Do not use agents, other commands, files or services. A receipt does not establish usefulness. Use one exact command invocation per Bash call, without shell variables, compound commands, or quoting command paths.'
def setup():
 ROOT.mkdir(exist_ok=True)
 if (ROOT/'protocol.json').exists():return
 started=time.monotonic()
 a=e.load(m.LEDGER);assert len(a)==240 and not any(x['status']=='started' for x in a)
 for name in ['corpus.json','bindings.json']:(ROOT/name).write_bytes((SOURCE/name).read_bytes())
 src=sqlite3.connect(SOURCE/'memory.sqlite');dst=sqlite3.connect(ROOT/'memory.sqlite');src.backup(dst);dst.close();src.close()
 cases=[{**x,'records':x['records']+211} for x in e.load(SOURCE/'cases.json')];e.save(ROOT/'cases.json',cases)
 variants=e.load(ROOT/'runtime-manifest.json')
 for variant,files in variants.items():
  for f,h in files.items():assert hashlib.sha256((ROOT/'runtime'/variant/f).read_bytes()).hexdigest()==h
 dependencies={str(p.relative_to(e.REPO)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [e.ADAPTER,e.REPO/'packages/orgbrain-cli/src/lib/memory-reuse.mjs',e.REPO/'packages/orgbrain-cli/src/lib/memory-use-collector.mjs',Path(__file__).resolve()]}
 e.save(ROOT/'protocol.json',{'max_cumulative_cli_starts':CAP,'prior_cli_starts':240,'new_executions':30,'arms':ARMS,'per_arm':10,'model':e.MODEL,'effort':'medium','source':'synthetic only; no personal DB copied','order':'cyclic rotation of the three arms per case','acceptance':'at least 3 knowledge units, personal/team >=2 use tasks, no ineligible use, no quality regression; compare full tokens and elapsed separately','initial_setup_ms':(time.monotonic()-started)*1000,'initial_setup_model_calls':0,'runtime_variants':variants,'dependencies':dependencies,'prompt_guidance_change':'same shell-command constraints in all three arms; historical trials are not the control for this new comparison'})
def run(limit):
 setup();done=0;cases=e.load(ROOT/'cases.json')
 for case in cases:
  rotation=(case['id']-1)%3
  for condition in ARMS[rotation:]+ARMS[:rotation]:
   label=f"efficiency-{case['id']:02d}-{condition}";a=e.load(m.LEDGER)
   if any(x.get('label')==label for x in a):continue
   if done>=limit:return
   if any(x['status']=='started' for x in a):raise RuntimeError('active_or_unresolved_cli_attempt')
   if len(a)>=CAP:raise RuntimeError('cumulative_budget_exhausted')
   started=time.monotonic();session=str(uuid.uuid4());rid='claude:'+session;directory=ROOT/'runs'/rid
   e.adapter('prepare',rid,{'channel':'object','condition':'none','case_id':case['id'],'revision':1})
   state=e.load(directory/'state.json');state['records']=case['records'];state['expected']['partitions']=(case['records']+state['rule']['batch_size']-1)//state['rule']['batch_size'];e.save(directory/'state.json',state)
   work=Path(tempfile.mkdtemp(prefix='orgbrain-efficiency-',dir='/private/tmp'));(work/'.local/memory-reuse').mkdir(parents=True);(work/'docs').mkdir()
   for target in ['queue','ledger','archive','billing']:(work/'docs'/f'{target}.md').write_text('Synthetic maintenance target; current source is available through the adapter.\n')
   src=sqlite3.connect(ROOT/'memory.sqlite');dst=sqlite3.connect(work/'memory.sqlite');src.backup(dst);dst.close();src.close()
   variant='r02' if condition=='improved' else 'r01';base=ROOT/'runtime'/variant;helper=base/'scripts/memory-reuse-claude.mjs';lib=base/'packages/orgbrain-cli/src/lib/memory-reuse-claude.mjs'
   e.save(work/'.local/memory-reuse/config.json',{'version':1,'tenant_id':'default','project_id':'org-brain','db_path':str(work/'memory.sqlite'),'flags':{'object':condition!='none'},'delivery_mode':'inline' if condition=='improved' else 'lookup','bindings':e.load(ROOT/'bindings.json'),'observation_purpose':'test'})
   prefix=shlex.join([e.NODE,str(helper)])
   settings=m.node(f"import {{mergeReuseHooks}} from {json.dumps(lib.as_uri())};console.log(JSON.stringify(mergeReuseHooks({{autoMemoryEnabled:false,promptSuggestionEnabled:false}},{json.dumps(prefix)})));")
   e.save(work/'settings.json',settings);e.save(directory/'mcp.json',{'mcpServers':{}})
   command=shlex.join([e.NODE,str(e.ADAPTER),'api',str(ROOT),rid])
   prompt=f"Perform {case['target']}.plan maintenance for records={case['records']}. Apply a plan with all seven fields: target (service name without extension), mode, batch_size, region, retain_days, deduplicate, partitions. Preserve current source constraints. Investigate through this adapter: "+command+" '<JSON>'. Operations: {\"op\":\"index\"}, {\"op\":\"read\",\"document\":\"NAME.json\"}, {\"op\":\"apply\",\"plan\":{...}}. Use exact single invocations, not shell aliases or compound commands. Report a short final status."
   argv=['claude','-p','--verbose','--include-hook-events','--input-format','stream-json','--output-format','stream-json','--no-session-persistence','--session-id',session,'--setting-sources','','--settings',str(work/'settings.json'),'--strict-mcp-config','--mcp-config',str(directory/'mcp.json'),'--tools','Bash','--allowedTools',f'Bash({e.NODE} {e.ADAPTER} api *)',f'Bash({e.NODE} {helper} recall *)',f'Bash({e.NODE} {helper} report *)','--disable-slash-commands','--model',e.MODEL,'--effort','medium','--max-turns','8','--max-budget-usd','1','--system-prompt',SYSTEM,'--prompt-suggestions','false']
   env=os.environ.copy();env.update(ORGBRAIN_REUSE_ROOT=str(work),ORGBRAIN_USE_PRINCIPAL=case['principal'],CLAUDE_CODE_DISABLE_AUTO_MEMORY='1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1',CLAUDE_CODE_DISABLE_BACKGROUND_TASKS='1',ENABLE_TOOL_SEARCH='false')
   attempt={'id':rid,'label':label,'channel':'efficiency','phase':'efficiency','revision':1,'condition':condition,'case':case['id'],'audience':case['audience'],'eligible':case['eligible'],'principal':case['principal'],'target':case['target'],'workspace':str(work),'argv':argv,'runtime_variant':variant,'setup_ms':(time.monotonic()-started)*1000,'implementation_sha256':{str(p.relative_to(e.REPO)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [helper,lib,e.ADAPTER,e.REPO/'packages/orgbrain-cli/src/lib/memory-reuse.mjs']}}
   records=execute_cli(argv,prompt,work,env,directory,m.LEDGER,attempt,CAP)
   m.finish(attempt,records,ROOT);done+=1

def summarize():
 a=e.load(m.LEDGER);runs=[x for x in a if x['channel']=='efficiency'];report={'cumulative_cli_starts':len(a),'max_cli_starts':CAP,'runs':len(runs),'arms':{}}
 for condition in ARMS:
  g=[x for x in runs if x['condition']==condition];valid=[x for x in g if x.get('status')=='observed'];uses=[x for x in valid if isinstance((x.get('collection') or {}).get('recorded'),int) and x['collection']['recorded']>0]
  report['arms'][condition]={'n':len(g),'observed':len(valid),'complete':len(g)==10 and len(valid)==10,'success':sum(x.get('success',False) for x in valid),'meaning_preserved':sum(x.get('meaning_preserved',False) for x in valid),'total_tokens':m.strict_total(g,'total_tokens'),'mean_ms':m.strict_total(g,'total_ms')/len(g) if g and m.strict_total(g,'total_ms') is not None else None,'api_equivalent_usd':m.strict_total(g,'api_equivalent_usd'),'unique_knowledge_reused':len({r['source_id'] for x in uses for r in x['verified_sources']}),'verified_use_tasks':len(uses),'personal_uses':sum(x['audience']=='personal' for x in uses),'team_uses':sum(x['audience']=='team' for x in uses),'ineligible_uses':sum(not x['eligible'] for x in uses),'read_calls':m.strict_total(g,'read_calls'),'apply_calls':m.strict_total(g,'apply_calls'),'recall_calls':m.strict_total(g,'recall_calls'),'report_calls':m.strict_total(g,'report_calls'),'permission_denials':sum(len(x.get('permission_denials',[])) for x in g),'hook_errors':sum(len(x.get('hook_errors',[])) for x in g),'observation_missing_tasks':sum(not isinstance((x.get('collection') or {}).get('recorded'),int) for x in g),'usage':{k:sum(x['usage'][k] for x in g) if all(isinstance(x.get('usage',{}).get(k),(int,float)) for x in g) else None for k in ['input_tokens','cache_creation_input_tokens','cache_read_input_tokens','output_tokens']}}
 report['all_cli_tokens']=m.strict_total(a,'total_tokens');report['all_cli_api_equivalent_usd']=m.strict_total(a,'api_equivalent_usd')
 e.save(ROOT/'report.json',report);print(json.dumps(report,ensure_ascii=False))
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--limit',type=int,default=30);p.add_argument('--summarize',action='store_true');p.add_argument('--recover',action='store_true');args=p.parse_args()
 if args.summarize:summarize()
 elif args.recover:
  aa=e.load(m.LEDGER)
  for x in aa:
   if x['channel']=='efficiency' and x['status']=='started':m.finish(x,aa,ROOT)
 else:run(args.limit)
