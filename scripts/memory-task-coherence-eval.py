"""Same real CLI protocol, with bound retained context and joined consistency checks."""
import argparse
import importlib.util
import json
import shutil
import subprocess
from pathlib import Path

spec=importlib.util.spec_from_file_location('human_eval',Path(__file__).with_name('memory-task-human-eval.py'))
base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
REPO=base.REPO;ROOT=REPO/'artifacts/memory-task-coherence-20261031';CHANNEL='task_coherence_v1';CAP=499;LIMIT=2.00
base.ROOT=ROOT;base.m.ROOT=ROOT;base.CHANNEL=CHANNEL;base.CAP=CAP;base.LIMIT=LIMIT;base.MAX_STARTS=18
base.CONFIG_OVERRIDES={'task_delta_consistency':'on','task_retained_fact_max_chars':1200}
original_prepare=base.prepare


def prepare():
    config=original_prepare()
    cases=base.load(ROOT/'cases.json')
    if any(x['route']!='delta' for x in cases):
        cases=[x for x in cases if x['route']=='delta']
        base.save(ROOT/'cases.json',cases)
    owned=['scripts/memory-task-coherence-eval.py','scripts/memory-task-human-eval.py','scripts/memory-task-full-eval.py','scripts/claude_reuse_execution.py','scripts/memory-task-human-host.mjs','scripts/memory-task-document-adapter.mjs']
    manifest={p:base.sha(REPO/p) for p in owned}
    if (ROOT/'coherence-driver-manifest.json').exists():
        if base.load(ROOT/'coherence-driver-manifest.json')!=manifest:raise RuntimeError('coherence_driver_changed_after_freeze')
    else:
        base.save(ROOT/'coherence-driver-manifest.json',manifest)
        for name in owned:
            target=ROOT/'originals'/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(REPO/name,target)
    return config


base.prepare=prepare


def main(action):
    prepare()
    if action=='prepare':
        print(json.dumps({'prepared':True,'model_starts':0,'required_comparison_pairs':6}));return
    approval=base.load(ROOT/'budget-proposal.json',{})
    if approval.get('approved_cumulative_cap')!=CAP or approval.get('approved_api_equivalent_usd')!=LIMIT:
        raise RuntimeError('explicit_budget_approval_required_no_model_start')
    auth=subprocess.run(['claude','auth','status'],capture_output=True,text=True)
    if json.loads(auth.stdout).get('loggedIn') is not True:raise RuntimeError('auth_preflight_failed_no_model_start')
    cases=base.load(ROOT/'cases.json')
    if action=='seed':
        for kind in ['research','analysis','document']:
            case=next(x for x in cases if x['kind']==kind)
            base.one({**case,'units':case['units'][:2]},'none','seed')
    else:
        for i,case in enumerate(cases):
            for condition in (['none','improved'] if i%2==0 else ['improved','none']):base.one(case,condition)


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('action',choices=['prepare','seed','run']);main(p.parse_args().action)
