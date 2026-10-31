"""Real CLI comparison. Existing completion uses no model; human review is separate."""
import argparse
import importlib.util
import json
import os
import shlex
import shutil
import subprocess
import time
import uuid
from pathlib import Path
from claude_reuse_execution import execute_cli

spec=importlib.util.spec_from_file_location('full_eval',Path(__file__).with_name('memory-task-full-eval.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
REPO=m.REPO;ROOT=REPO/'artifacts/memory-task-human-20261031';LEDGER=m.LEDGER
CAP=484;LIMIT=3.60;CHANNEL='task_human_v1';MODEL=m.MODEL;NODE=m.NODE
MAX_STARTS=24
CONFIG_OVERRIDES={}
load,save,rows,sha=m.load,m.save,m.rows,m.sha
m.ROOT=ROOT


def prepare():
 c=m.prepare()
 cases=load(ROOT/'cases.json')
 if cases and 'route' not in cases[0]:
  cases=[{'id':kind+'-'+route+'-'+str(i),'kind':kind,'workflow':'project-'+kind,'route':route,'units':c['task_workflows']['project-'+kind]['default_units'][:2] if route=='existing' else c['task_workflows']['project-'+kind]['default_units'],'assignment':c['task_workflows']['project-'+kind]['assignment']+(' コマンド例の引用符も保持してください。' if i==2 else '')} for kind in ['research','analysis','document'] for route in ['existing','delta'] for i in [1,2]]
  save(ROOT/'cases.json',cases)
 owned=['scripts/memory-task-human-host.mjs','scripts/memory-task-human-eval.py']
 manifest={p:sha(REPO/p) for p in owned}
 if (ROOT/'evaluation-manifest.json').exists():
  if load(ROOT/'evaluation-manifest.json')!=manifest:raise RuntimeError('evaluation_changed_after_freeze')
 else:save(ROOT/'evaluation-manifest.json',manifest)
 return c


def setup(case,condition,phase):
 c=prepare();began=time.monotonic();sid=str(uuid.uuid4());d=ROOT/'runs'/('claude:'+sid if not(condition=='improved' and case['route']=='existing') else 'host:'+sid);d.mkdir(parents=True)
 db=ROOT/'seed.sqlite' if phase=='seed' else d/'memory.sqlite'
 if phase!='seed':m.backup(ROOT/'seed.sqlite',db)
 cfg={**c,'db_path':str(db),'observation_purpose':'test','task_confirmation_mode':'ask','task_local_mode':'on','task_observation_mode':'on','task_request_mode':'sections_stdin','task_compact_receipts':'on','task_full_checks':'current_sources_only',**CONFIG_OVERRIDES}
 path=REPO/'.local/memory-reuse/evaluation/configs'/(sid+'.json');save(path,cfg);os.chmod(path,0o600)
 for name,value in [('config.json',cfg),('settings.json',m.settings(sid)),('mcp.json',{'mcpServers':{}})]:save(d/name,value)
 prompt=case['assignment']+'\n対象の単位: '+','.join(case['units'])+'。不足単位だけの作業が承認された場合は、その単位だけを作成してください。\n<reuse_task>'+json.dumps({'workflow':case['workflow'],'units':case['units']},ensure_ascii=False,separators=(',',':'))+'</reuse_task>'
 save(d/'request.json',{'session_id':sid,'prompt':prompt,'condition':condition,'choice':case['route'] if condition=='improved' else 'full'})
 harness_ms=(time.monotonic()-began)*1000;start=time.monotonic();p=subprocess.run([NODE,str(REPO/'scripts/memory-task-human-host.mjs'),str(d/'request.json')],cwd=REPO,env=m.env(path),capture_output=True,text=True,timeout=60);host_ms=(time.monotonic()-start)*1000
 save(d/'prepare-process.json',{'returncode':p.returncode,'elapsed_ms':host_ms,'stdout':p.stdout,'stderr':p.stderr})
 if p.returncode:raise RuntimeError('prepare_failed_without_model: '+p.stderr[-1000:])
 host=json.loads(p.stdout);save(d/'host.json',host)
 a={'id':d.name,'label':phase+'-'+case['id']+'-'+condition,'case':case['id'],'kind':case['kind'],'route':case['route'],'condition':condition,'phase':phase,'channel':CHANNEL,'setup_ms':host_ms,'harness_setup_ms':harness_ms,'workspace':str(REPO),'expected_prior_id':host['prior_id'],'driver_sha256':sha(Path(__file__)),'source_manifest_sha256':sha(ROOT/'manifest.json')}
 envelope=Path(host['source_envelope_path']).read_text() if host.get('source_envelope_path') else None
 if envelope:
  a['source_envelope_digest']=host['source_envelope_digest'];a['argv']=['claude','-p','--verbose','--include-hook-events','--input-format','stream-json','--output-format','stream-json','--model',MODEL,'--effort','medium','--tools','Bash','--allowedTools','Bash','--strict-mcp-config','--mcp-config',str(d/'mcp.json'),'--setting-sources','','--settings',str(d/'settings.json'),'--disable-slash-commands','--session-id',sid,'--max-budget-usd','0.25','--append-system-prompt',m.SYSTEM+'\n'+envelope]
 save(d/'prepared.json',a);return a,prompt,m.env(path)|({'ORGBRAIN_TASK_SOURCE_ENVELOPE_DIGEST':host['source_envelope_digest']} if envelope else {}),d,host


def one(case,condition,phase='comparison'):
 label=phase+'-'+case['id']+'-'+condition;ledger=load(LEDGER);existing=[x for x in ledger if x.get('channel')==CHANNEL and x['label']==label]
 nonmodel=load(ROOT/'nonmodel-routes.json',[]);done=[x for x in nonmodel if x['label']==label]
 if existing or done:
  if (existing or done)[-1].get('success'):return
  review=load(ROOT/'recoveries.json',{}).get((existing or done)[-1]['id'])
  if not isinstance(review,str) or not review.strip():raise RuntimeError('failure_requires_diagnosis_no_automatic_retry')
 approval=load(ROOT/'budget-proposal.json',{});assert approval.get('approved_cumulative_cap')==CAP and approval.get('approved_api_equivalent_usd')==LIMIT
 group=[x for x in ledger if x.get('channel')==CHANNEL]
 if len(ledger)>=CAP or len(group)>=MAX_STARTS or any(x.get('api_equivalent_usd') is None for x in group) or sum(x['api_equivalent_usd'] for x in group)+0.30>LIMIT:raise RuntimeError('budget_stop')
 a,prompt,env,d,host=setup(case,condition,phase);a['recovery_from']=(existing or done)[-1]['id'] if existing or done else None;sid=a['id'].split(':',1)[1]
 if 'argv' not in a:
  completion=host['completion'];state=load(REPO/'.local/memory-reuse/task-confirmations'/(sid+'.json'));assert completion['status']=='completed_with_existing_result' and not state['operations']
  a.update(success=True,status='verified_existing_no_model',total_tokens=0,api_equivalent_usd=0,total_ms=a['setup_ms'],task_completion=completion,model_starts=0,artifact_path=state['prior']['path']);save(d/'state.json',state);save(d/'outcome.json',a);shutil.copyfile(REPO/a['artifact_path'],d/'deliverable.md');nonmodel.append(a);save(ROOT/'nonmodel-routes.json',nonmodel);print(json.dumps({'existing_no_model':a['case'],'total_ms':a['total_ms']}),flush=True);return
 records=execute_cli(a['argv'],prompt,REPO,env,d,LEDGER,a,CAP);events=rows(d/'events.jsonl');result=next((x for x in reversed(events) if x.get('type')=='result'),{});state=load(REPO/'.local/memory-reuse/task-confirmations'/(sid+'.json'));observation=load(REPO/'.local/memory-reuse/last-observation.json',{});completion=observation.get('task_completion') or {};tokens,usage=m.accounting(result)
 invocations=[];seen=set()
 for event in events:
  if event.get('type')!='user':continue
  for block in event.get('message',{}).get('content',[]):
   if block.get('type')!='tool_result' or block.get('is_error'):continue
   try:value=json.loads(block['content']);invocation=value.get('reuse_invocation_id')
   except (TypeError,ValueError):continue
   if not invocation or invocation in seen:continue
   p=REPO/'.local/memory-reuse/invocations'/(invocation+'.json');private=load(p);assert private['request']['task_id']==a['id'];shutil.copyfile(p,d/p.name);invocations.append(private);seen.add(invocation)
 times=rows(REPO/'.local/memory-reuse/phase-timing'/(sid+'.jsonl'))
 for name,value in [('state.json',state),('result.json',result),('observation.json',observation),('phase-timing.json',times)]:save(d/name,value)
 expected='completed_delta' if condition=='improved' else 'completed_full';good=a['returncode']==0 and not a['timeout'] and not result.get('is_error') and completion.get('status')==expected and tokens is not None and bool(state['created_results'])
 a.update(status='observed' if good else 'observed_failed',success=good,total_tokens=tokens,usage=usage,api_equivalent_usd=result.get('total_cost_usd'),actual_billing_usd=None,total_ms=a['setup_ms']+a['cli_ms'],api_ms=result.get('duration_api_ms'),task_completion=completion,permission_denials=len(result.get('permission_denials',[])),phase_times_ms={p:sum(x['child_process_ms'] for x in times if x['phase']==p) for p in ['context','pre','post','stop']},invocation_timings=[v.get('timings') for v in invocations],model_starts=1)
 if state['created_results']:a['artifact_path']=state['created_results'][-1]['path'];shutil.copyfile(REPO/a['artifact_path'],d/'deliverable.md')
 save(d/'outcome.json',a);save(LEDGER,records);print(json.dumps({k:a[k] for k in ['label','success','total_tokens','total_ms','api_equivalent_usd','permission_denials']},ensure_ascii=False),flush=True)
 if not good:raise RuntimeError('retain_failure_stop_for_diagnosis')


def main(action):
 prepare()
 if action=='prepare':print(json.dumps({'prepared':True,'model_starts':0}));return
 auth=subprocess.run(['claude','auth','status'],capture_output=True,text=True);assert json.loads(auth.stdout).get('loggedIn') is True,'auth_preflight_failed_no_model_start'
 cases=load(ROOT/'cases.json')
 if action=='seed':
  for kind in ['research','analysis','document']:
   c=next(x for x in cases if x['kind']==kind and x['route']=='existing');one(c,'none','seed')
 else:
  for i,c in enumerate(cases):
   for condition in (['none','improved'] if i%2==0 else ['improved','none']):one(c,condition)


if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('action',choices=['prepare','seed','run']);main(p.parse_args().action)
