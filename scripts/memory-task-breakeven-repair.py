"""Explicitly diagnosed semantic repairs; all original and repair starts remain costed."""
import argparse
import hashlib
import importlib.util
import json
import subprocess
from pathlib import Path

s=importlib.util.spec_from_file_location('v3',Path(__file__).with_name('memory-task-breakeven-v3-eval.py'))
v=importlib.util.module_from_spec(s);s.loader.exec_module(v)
b=v.base
p=argparse.ArgumentParser();p.add_argument('--execute',action='store_true');args=p.parse_args()
v.prepare()
plan=b.load(v.ROOT/'repair-plan.json');reviews=b.load(v.ROOT/'quality-review.json')['attempts'];ledger=b.load(b.LEDGER);cases=b.load(v.ROOT/'cases.json')
for x in plan:
 a=next(a for a in ledger if a['id']==x['source_attempt'])
 assert a['channel']==v.CHANNEL and a['case']==x['case'] and a['condition']==x['condition']
 assert reviews[a['id']]['passed'] is False
 assert b.sha(v.ROOT/'runs'/a['id']/'deliverable.md')==x['failed_deliverable_sha256']
 assert x['feedback'].strip()
if not args.execute:
 print(json.dumps({'repairs':len(plan),'model_starts':0,'shared_remaining_starts':120-len(ledger[496:]),'shared_remaining_usd':10-sum(a['api_equivalent_usd'] for a in ledger[496:])}));raise SystemExit
assert json.loads(subprocess.run(['claude','auth','status'],capture_output=True,text=True).stdout).get('loggedIn') is True
original_setup=b.setup
for x in plan:
 def setup(case,condition,phase):
  a,prompt,env,d,host=original_setup(case,condition,phase)
  a.update(semantic_repair_of=x['source_attempt'],repair_plan_sha256=b.sha(v.ROOT/'repair-plan.json'),repair_driver_sha256=b.sha(Path(__file__)))
  b.save(d/'prepared.json',a)
  return a,prompt,env,d,host
 b.setup=setup
 case=next(c for c in cases if c['id']==x['case'])
 b.one({**case,'assignment':case['assignment']+'\n再作成時の修正指摘: '+x['feedback']},x['condition'],'comparison-repair-1')
