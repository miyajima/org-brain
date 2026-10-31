"""Evaluation-only hook wrapper. Preserve exact hook I/O; store timings only."""
import json,os,re,subprocess,sys,time
from pathlib import Path
root=Path(sys.argv[1]).resolve();phase=sys.argv[2];raw=sys.stdin.buffer.read();started=time.monotonic()
p=subprocess.run(sys.argv[3:],input=raw,stdout=sys.stdout.buffer,stderr=sys.stderr.buffer)
elapsed=(time.monotonic()-started)*1000
try:
 x=json.loads(raw);sid=x.get('session_id','');assert re.fullmatch(r'[\w:-]{1,128}',sid);assert Path(x.get('cwd','')).resolve()==root
 directory=root/'.local/memory-reuse/phase-timing';directory.mkdir(parents=True,exist_ok=True,mode=0o700)
 fd=os.open(directory/(sid+'.jsonl'),os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600)
 with os.fdopen(fd,'a') as f:f.write(json.dumps({'phase':phase,'session_id':sid,'child_process_ms':elapsed,'exit_code':p.returncode})+'\n')
except (ValueError,AssertionError,KeyError,TypeError):pass
sys.exit(p.returncode)
