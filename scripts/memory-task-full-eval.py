"""Three matched full-work conditions, isolated evaluation DB/config, real CLI only."""
import argparse,hashlib,json,os,shlex,shutil,sqlite3,subprocess,time,uuid
from pathlib import Path
from claude_reuse_execution import execute_cli
REPO=Path(__file__).resolve().parents[1];ROOT=REPO/'artifacts/memory-task-full-20261031';LEDGER=REPO/'artifacts/memory-reuse-loop-20261026/attempts.json';NODE=str(Path(shutil.which('node')).resolve());CHANNEL='task_full_v2';MODEL='claude-sonnet-5-5';CAP=461;LIMIT=3.60
SYSTEM='Complete this real bounded project task using only the exact Bash command shape supplied by the hook. Current source is provided in the bound source envelope. Write useful Japanese sections, about 300-700 characters per section, cite relative source paths and preserve factual values, units, conditions and unknowns. If given a quoted heredoc, replace only its JSON section values, keep the delimiter quoted and on its own line, and do not add shell commands. If given a run JSON argument, uses must be a root field beside task_id, adapter and input. Preserve literal quotes and command examples from the source. Do not investigate other files or use other services. Finish with a short status and deliverable path.'
def load(p,default=None):return json.loads(p.read_text()) if p.exists() else default
def save(p,x):p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n')
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def rows(p):return [json.loads(s) for s in p.read_text().splitlines() if s.strip()] if p.exists() else []
def env(path=None):return {**os.environ,'ORGBRAIN_REUSE_ROOT':str(REPO),'ORGBRAIN_USE_PRINCIPAL':'local','ORGBRAIN_TASK_EVAL_SIMULATION':'1',**({'ORGBRAIN_TASK_EVAL_CONFIG':str(path)} if path else {})}
def backup(src,dst):
 a=sqlite3.connect(src);b=sqlite3.connect(dst);a.backup(b);a.close();b.close()
def prepare():
 ROOT.mkdir(parents=True,exist_ok=True);c=load(REPO/'.local/memory-reuse/config.json');files=set()
 for w in c['task_workflows'].values():files.update(w['source_files']);files.update(str(Path(x).relative_to(REPO)) for x in w['dependency_files'])
 files.update(['scripts/memory-task-full-host.mjs','scripts/memory-task-phase-timer.py','packages/orgbrain-cli/src/lib/memory-reuse-claude.mjs','packages/orgbrain-cli/src/lib/memory-task-observation.mjs']);manifest={p:sha(REPO/p) for p in sorted(files)}
 if not (ROOT/'manifest.json').exists():
  save(ROOT/'manifest.json',manifest);save(ROOT/'base-config.json',c)
  for f in files:
   p=ROOT/'originals'/f;p.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(REPO/f,p)
 else:
  if load(ROOT/'manifest.json')!=manifest:raise RuntimeError('source_or_runtime_changed_after_freeze')
 if not (ROOT/'seed.sqlite').exists():
  code='import {LocalMemoryStore} from '+json.dumps((REPO/'packages/orgbrain-cli/src/lib/local-memory-store.mjs').as_uri())+';await new LocalMemoryStore('+json.dumps(str(ROOT/'seed.sqlite'))+',{denseEmbeddingProvider:null,memoryJudge:null,relevanceSelector:null}).init();'
  subprocess.run([NODE,'--input-type=module','-e',code],cwd=REPO,check=True,capture_output=True)
 if not (ROOT/'cases.json').exists():
  save(ROOT/'cases.json',[{'id':kind+'-'+str(i),'kind':kind,'workflow':'project-'+kind,'units':c['task_workflows']['project-'+kind]['default_units'],'assignment':c['task_workflows']['project-'+kind]['assignment']+(' 元資料のコマンド例と引用符を正しく保持してください。' if i==2 else '')} for kind in ['research','analysis','document'] for i in [1,2]])
 return c
def settings(sid):
 x=load(REPO/'.claude/settings.local.json');prefix=str(REPO/'scripts/memory-reuse-claude.mjs')
 for event,groups in x['hooks'].items():
  for g in groups:
   for h in g.get('hooks',[]):
    if prefix in h.get('command',''):
     argv=shlex.split(h['command']);h['command']=shlex.join([shutil.which('python3'),str(REPO/'scripts/memory-task-phase-timer.py'),str(REPO),argv[-1],*argv])
 return x
def setup(case,condition,phase,recovery_hint=''):
 c=prepare();started=time.monotonic();sid=str(uuid.uuid4());d=ROOT/'runs'/('claude:'+sid);d.mkdir(parents=True)
 db=ROOT/'seed.sqlite' if phase=='seed' else d/'memory.sqlite'
 if phase!='seed':backup(ROOT/'seed.sqlite',db)
 cfg={**c,'db_path':str(db),'observation_purpose':'test','task_confirmation_mode':'ask','task_local_mode':'on','task_observation_mode':'on','task_request_mode':'json_cli' if condition=='current' else 'sections_stdin','task_compact_receipts':'off' if condition=='current' else 'on','task_full_checks':'legacy' if condition=='current' else 'current_sources_only'}
 path=REPO/'.local/memory-reuse/evaluation/configs'/(sid+'.json');save(path,cfg);os.chmod(path,0o600);save(d/'config.json',cfg);save(d/'settings.json',settings(sid));save(d/'mcp.json',{'mcpServers':{}})
 prompt=case['assignment']+'\n対象の全単位を現在の資料から作成してください。\n<reuse_task>'+json.dumps({'workflow':case['workflow'],'units':case['units']},ensure_ascii=False,separators=(',',':'))+'</reuse_task>';request={'session_id':sid,'prompt':prompt,'condition':condition};save(d/'request.json',request)
 harness_ms=(time.monotonic()-started)*1000;start=time.monotonic();p=subprocess.run([NODE,str(REPO/'scripts/memory-task-full-host.mjs'),str(d/'request.json')],cwd=REPO,env=env(path),capture_output=True,text=True,timeout=60);workflow_ms=(time.monotonic()-start)*1000
 save(d/'prepare-process.json',{'returncode':p.returncode,'elapsed_ms':workflow_ms,'stderr':p.stderr,'stdout':p.stdout})
 if p.returncode:raise RuntimeError('prepare_failed_no_model_start: '+p.stderr[-1200:])
 host=json.loads(p.stdout);save(d/'host.json',host);envelope=Path(host['source_envelope_path']).read_text();e=env(path);e['ORGBRAIN_TASK_SOURCE_ENVELOPE_DIGEST']=host['source_envelope_digest']
 argv=['claude','-p','--verbose','--include-hook-events','--input-format','stream-json','--output-format','stream-json','--model',MODEL,'--effort','medium','--tools','Bash','--allowedTools','Bash','--strict-mcp-config','--mcp-config',str(d/'mcp.json'),'--setting-sources','','--settings',str(d/'settings.json'),'--disable-slash-commands','--session-id',sid,'--max-budget-usd','0.25','--append-system-prompt',SYSTEM+recovery_hint+'\n'+envelope]
 a={'id':'claude:'+sid,'label':phase+'-'+case['id']+'-'+condition,'channel':CHANNEL,'case':case['id'],'kind':case['kind'],'condition':condition,'phase':phase,'argv':argv,'setup_ms':workflow_ms,'harness_setup_ms':harness_ms,'source_manifest_sha256':sha(ROOT/'manifest.json'),'driver_sha256':sha(Path(__file__)),'source_envelope_digest':host['source_envelope_digest'],'config_path':str(path),'workspace':str(REPO),'expected_prior_id':host['prior_id']};save(d/'prepared.json',a);return a,prompt,e,d
def accounting(result):
 m=result.get('modelUsage',{}).get(MODEL);keys={'input_tokens':'inputTokens','cache_creation_input_tokens':'cacheCreationInputTokens','cache_read_input_tokens':'cacheReadInputTokens','output_tokens':'outputTokens'}
 if list(result.get('modelUsage',{}))!=[MODEL] or any(type(m.get(k)) is not int or m[k]<0 for k in keys.values()):return None,None
 usage={k:m[v] for k,v in keys.items()};return sum(usage.values()),usage
def one(case,condition,phase='comparison'):
 current=[a for a in load(LEDGER) if a.get('channel')==CHANNEL];label=phase+'-'+case['id']+'-'+condition;old=[a for a in current if a['label']==label]
 recovery_hint=''
 if old:
  if old[-1].get('success'):return
  if old[-1]['id'] in load(ROOT/'terminal-failures.json',{}):
   print(json.dumps({'retained_terminal_failure':old[-1]['id'],'label':label,'completed':False}),flush=True);return
  recovery_hint=load(ROOT/'recoveries.json',{}).get(old[-1]['id'],'')
  if not recovery_hint:raise RuntimeError('retained_failure_requires_review')
 approval=load(ROOT/'budget-proposal.json',{});assert approval.get('approved_cumulative_cap')==CAP and approval.get('approved_api_equivalent_usd')==LIMIT
 if len(current)>=24 or len(load(LEDGER))>=CAP or any(a.get('api_equivalent_usd') is None for a in current) or sum(a['api_equivalent_usd'] for a in current)+0.30>LIMIT:raise RuntimeError('budget_stop')
 a,prompt,e,d=setup(case,condition,phase,recovery_hint);a['recovery_from']=old[-1]['id'] if old else None;records=execute_cli(a['argv'],prompt,REPO,e,d,LEDGER,a,CAP);events=rows(d/'events.jsonl');result=next((x for x in reversed(events) if x.get('type')=='result'),{});sid=a['id'][7:];s=load(REPO/'.local/memory-reuse/task-confirmations'/(sid+'.json'));observation=load(REPO/'.local/memory-reuse/last-observation.json',{});completion=observation.get('task_completion') or {};tokens,usage=accounting(result)
 invocations=[];seen=set()
 for event in events:
  if event.get('type')!='user':continue
  for block in event.get('message',{}).get('content',[]):
   if block.get('type')!='tool_result' or block.get('is_error'):continue
   try:value=json.loads(block['content']);invocation=value.get('reuse_invocation_id')
   except (ValueError,TypeError):continue
   if not invocation or invocation in seen:continue
   p=REPO/'.local/memory-reuse/invocations'/(invocation+'.json');private=load(p)
   if private['request'].get('task_id')!=a['id']:raise RuntimeError('invocation_scope_mismatch')
   shutil.copyfile(p,d/p.name);invocations.append(private);seen.add(invocation)
 phase_times=rows(REPO/'.local/memory-reuse/phase-timing'/(sid+'.jsonl'));save(d/'phase-timing.json',phase_times);save(d/'state.json',s);save(d/'result.json',result);save(d/'observation.json',observation)
 good=a['returncode']==0 and not a['timeout'] and not result.get('is_error') and completion.get('status')=='completed_full' and tokens is not None and bool(s['created_results'])
 a.update(status='observed' if good else 'observed_failed',success=good,total_tokens=tokens,usage=usage,model_usage=result.get('modelUsage'),api_equivalent_usd=result.get('total_cost_usd'),actual_billing_usd=None,total_ms=a['setup_ms']+a['cli_ms'],api_ms=result.get('duration_api_ms'),task_completion=completion,phase_times_ms={phase:sum(x['child_process_ms'] for x in phase_times if x['phase']==phase) for phase in ['context','pre','post','stop']},invocation_timings=[v.get('timings') for v in invocations],invocation_count=len(invocations),permission_denials=len(result.get('permission_denials',[])),model_responses=len({x['message']['id'] for x in events if x.get('type')=='assistant'}))
 if s['created_results']:
  a['artifact_path']=s['created_results'][-1]['path'];shutil.copyfile(REPO/a['artifact_path'],d/'deliverable.md')
 save(d/'outcome.json',a);save(LEDGER,records);print(json.dumps({k:a[k] for k in ['label','success','total_tokens','total_ms','api_equivalent_usd','phase_times_ms','permission_denials']},ensure_ascii=False),flush=True)
 if not good:raise RuntimeError('retained_cli_failure_no_automatic_retry')
def main(action):
 prepare()
 if action=='prepare':print(json.dumps({'prepared':True,'model_starts':0}));return
 if action=='dry':
  c=load(ROOT/'cases.json')[0];c={**c,'units':c['units'][:2]};a,_,_,_=setup(c,'none','dry');print(json.dumps({'dry_prepared':a['id'],'model_starts':0}));return
 auth=subprocess.run(['claude','auth','status'],capture_output=True,text=True);assert json.loads(auth.stdout).get('loggedIn') is True,'auth_preflight_failed_no_provider_start'
 if action=='seed':
  for c in load(ROOT/'cases.json')[::2]:one({**c,'units':c['units'][:2]},'none','seed')
 elif action=='run':
  for i,c in enumerate(load(ROOT/'cases.json')):
   conditions=['none','current','improved'];order=conditions[i%3:]+conditions[:i%3]
   for condition in order:one(c,condition)
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('action',choices=['prepare','dry','seed','run']);main(p.parse_args().action)
