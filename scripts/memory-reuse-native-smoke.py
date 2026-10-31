"""One synthetic live CLI test of the installed project hook/receipt path."""
import importlib.util,json,os,shlex,signal,sqlite3,subprocess,tempfile,time,uuid
from pathlib import Path
spec=importlib.util.spec_from_file_location('evaluation',Path(__file__).with_name('memory-reuse-loop.py'))
e=importlib.util.module_from_spec(spec);spec.loader.exec_module(e)
attempts=e.load(e.ROOT/'attempts.json',[])
if len(attempts)>=240 or any(a['status']=='started' for a in attempts):raise RuntimeError('budget_or_active_run')
session=str(uuid.uuid4());rid='claude:'+session
root=Path(tempfile.mkdtemp(prefix='orgbrain-native-smoke-',dir='/private/tmp'))
prepared=e.adapter('prepare',rid,{'channel':'object','condition':'none','case_id':1,'revision':1})
source=sqlite3.connect(e.ROOT/'memory.sqlite');target=sqlite3.connect(root/'memory.sqlite');source.backup(target);target.close();source.close()
rule=e.load(e.ROOT/'corpus.json')['rules']['queue']
(root/'queue.json').write_text(json.dumps(rule))
(root/'.local/memory-reuse').mkdir(parents=True)
e.save(root/'.local/memory-reuse/config.json',{'version':1,'tenant_id':'default','project_id':'org-brain','db_path':str(root/'memory.sqlite'),'flags':{'object':True},'observation_purpose':'test'})
script=e.REPO/'scripts/memory-reuse-claude.mjs'
code=f"""import {{LocalMemoryStore}} from {json.dumps((e.REPO/'packages/orgbrain-cli/src/lib/local-memory-store.mjs').as_uri())};
import {{MemoryReuse}} from {json.dumps((e.REPO/'packages/orgbrain-cli/src/lib/memory-reuse.mjs').as_uri())};
import {{mergeReuseHooks}} from {json.dumps((e.REPO/'packages/orgbrain-cli/src/lib/memory-reuse-claude.mjs').as_uri())};
import {{writeFile}} from 'node:fs/promises';
const store=new LocalMemoryStore({json.dumps(str(root/'memory.sqlite'))},{{denseEmbeddingProvider:null}});
await new MemoryReuse(store,{{tenant_id:'default',project_id:'org-brain',principal_id:'alice',work_type:'implementation'}}).link({{source_id:'synthetic-queue',source_version:{rule['version']},object_type_key:'file',object_id:'queue.json'}});
await writeFile({json.dumps(str(root/'settings.json'))},JSON.stringify(mergeReuseHooks({{autoMemoryEnabled:false,promptSuggestionEnabled:false}},{json.dumps(e.NODE+' '+str(script))})));
"""
subprocess.run([e.NODE,'--input-type=module','-e',code],check=True)
d=e.ROOT/'runs'/rid;e.save(d/'mcp.json',{'mcpServers':{}})
prefix=shlex.join([e.NODE,str(e.ADAPTER),'api',str(e.ROOT),rid])
prompt='This is a synthetic integration test. Check queue.json. First consult applicable project knowledge using the recall command supplied by the project hook. Use the retrieved constraints to construct the plan, confirm applicability against the current source if needed, then plan target=queue for records=17. Apply a plan with all seven fields target, mode, batch_size, region, retain_days, deduplicate, partitions through this adapter: '+prefix+" '<JSON>'. Supported operations: {\"op\":\"read\",\"document\":\"queue.json\"} and {\"op\":\"apply\",\"plan\":{...}}. If the reference actually informs an action, report use with the project report command and native action ID. Print the returned use_receipt. This is a test, not natural usage."
system='Perform only this synthetic integration test. Use Bash for the supplied source/plan adapter and project recall/report commands. Generate the current plan yourself. Do not run other commands, agents, or external services. Never infer usefulness from a receipt.'
argv=['claude','-p','--verbose','--include-hook-events','--input-format','stream-json','--output-format','stream-json','--session-id',session,'--setting-sources','','--settings',str(root/'settings.json'),'--strict-mcp-config','--mcp-config',str(d/'mcp.json'),'--tools','Bash','--allowedTools',f'Bash({e.NODE} {e.ADAPTER} api *)',f'Bash({e.NODE} {script} recall *)',f'Bash({e.NODE} {script} report *)','--disable-slash-commands','--model',e.MODEL,'--effort','medium','--max-turns','8','--max-budget-usd','1','--system-prompt',system,'--prompt-suggestions','false']
env=os.environ.copy();env.update({'ORGBRAIN_REUSE_ROOT':str(root),'ORGBRAIN_USE_PRINCIPAL':'alice','CLAUDE_CODE_DISABLE_AUTO_MEMORY':'1','CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC':'1','CLAUDE_CODE_DISABLE_BACKGROUND_TASKS':'1','ENABLE_TOOL_SEARCH':'false'})
a={'id':rid,'channel':'native_hook','phase':'integration','status':'started','order':len(attempts)+1,'argv':argv,'workspace':str(root),'source':'synthetic only'}
attempts.append(a);e.save(e.ROOT/'attempts.json',attempts);(d/'prompt.txt').write_text(prompt)
started=time.monotonic();timeout=False
with (d/'events.jsonl').open('w') as out,(d/'stderr.txt').open('w') as err:
 p=subprocess.Popen(argv,stdin=subprocess.PIPE,stdout=out,stderr=err,cwd=root,env=env,text=True,start_new_session=True)
 try:p.communicate(json.dumps({'type':'user','message':{'role':'user','content':prompt}})+'\n',timeout=180)
 except subprocess.TimeoutExpired:timeout=True;os.killpg(p.pid,signal.SIGTERM);p.wait(timeout=10)
events=e.rows(d/'events.jsonl');result=next((x for x in reversed(events) if x.get('type')=='result'),{})
usage=result.get('usage');keys=['input_tokens','cache_creation_input_tokens','cache_read_input_tokens','output_tokens']
tokens=sum(usage[k] for k in keys) if isinstance(usage,dict) and all(isinstance(usage.get(k),(int,float)) for k in keys) else None
observation=e.load(root/'.local/memory-reuse/last-observation.json',{})
calls=e.rows(d/'calls.jsonl');good=any(c['result'].get('ok') is True for c in calls)
same_model=bool(result.get('modelUsage')) and all(k==e.MODEL for k in result['modelUsage'])
a.update(status='observed' if result and tokens is not None and not timeout and same_model else 'infrastructure_failed',success=good and same_model and isinstance(observation.get('collection',{}).get('recorded'),int) and observation['collection']['recorded']>0,
 total_tokens=tokens,usage=usage,api_equivalent_usd=result.get('total_cost_usd'),actual_enterprise_charge_usd=None,total_ms=(time.monotonic()-started)*1000,
 native_hook_observation=observation,model_usage=result.get('modelUsage'),timeout=timeout,returncode=p.returncode,permission_denials=result.get('permission_denials',[]))
e.save(e.ROOT/'attempts.json',attempts);e.save(d/'result.json',result);e.save(e.ROOT/'native-hook-smoke.json',a)
print(json.dumps(a,ensure_ascii=False))
if not a['success']:raise RuntimeError('native hook integration not verified; actual attempt retained')
