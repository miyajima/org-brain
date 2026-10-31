"""Shared bounded CLI execution. Only the caller interprets real provider output."""
import json,os,signal,subprocess,time

def execute_cli(argv,prompt,work,env,directory,ledger,attempt,max_starts):
    records=json.loads(ledger.read_text())
    if any(x['status']=='started' for x in records):raise RuntimeError('active_or_unresolved_cli_attempt')
    if any(x['id']==attempt['id'] for x in records):raise RuntimeError('duplicate_cli_attempt')
    if len(records)>=max_starts:raise RuntimeError('cumulative_budget_exhausted')
    directory.mkdir(parents=True,exist_ok=True)
    attempt.update(status='started',order=len(records)+1)
    records.append(attempt);ledger.write_text(json.dumps(records,ensure_ascii=False,indent=2)+'\n')
    (directory/'prompt.txt').write_text(prompt)
    print(json.dumps({'starting':attempt.get('label',attempt['id']),'cumulative':len(records)}),flush=True)
    started=time.monotonic();timeout=False
    with (directory/'events.jsonl').open('w') as out,(directory/'stderr.txt').open('w') as err:
        process=subprocess.Popen(argv,stdin=subprocess.PIPE,stdout=out,stderr=err,cwd=work,env=env,text=True,start_new_session=True)
        try:process.communicate(json.dumps({'type':'user','message':{'role':'user','content':prompt}})+'\n',timeout=180)
        except subprocess.TimeoutExpired:
            timeout=True;os.killpg(process.pid,signal.SIGTERM);process.wait(timeout=10)
    attempt.update(cli_ms=(time.monotonic()-started)*1000,returncode=process.returncode,timeout=timeout)
    ledger.write_text(json.dumps(records,ensure_ascii=False,indent=2)+'\n')
    return records
