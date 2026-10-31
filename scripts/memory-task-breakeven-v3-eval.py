"""Bounded real CLI reuse sequence; all starts remain in the existing ledger."""
import argparse
import importlib.util
import json
import shutil
import subprocess
from pathlib import Path

spec=importlib.util.spec_from_file_location('human_eval',Path(__file__).with_name('memory-task-human-eval.py'))
base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
REPO=base.REPO;ROOT=REPO/'artifacts/memory-task-breakeven-v3-20261031';CHANNEL='task_breakeven_v3'
base.ROOT=ROOT;base.m.ROOT=ROOT;base.CHANNEL=CHANNEL;base.CAP=616;base.LIMIT=7.2149105;base.MAX_STARTS=81
base.CONFIG_OVERRIDES={'task_delta_consistency':'on','task_retained_fact_max_chars':1200}
original_prepare=base.prepare


def prepare():
    c=original_prepare()
    if not (ROOT/'sequence-manifest.json').exists():
        cases=[]
        for n in range(1,19):
            for kind in ['research','analysis','document']:
                w=c['task_workflows']['project-'+kind]
                cases.append({'id':kind+'-delta-'+str(n),'round':n,'kind':kind,'workflow':'project-'+kind,'route':'delta','units':w['default_units'],'assignment':w['assignment']+(' コマンド例の引用符も保持してください。' if n%2==0 else '')})
        base.save(ROOT/'cases.json',cases)
        base.save(ROOT/'sequence-manifest.json',{'max_rounds':18,'cases_sha256':base.sha(ROOT/'cases.json'),'initial_rounds':6})
    elif base.load(ROOT/'sequence-manifest.json')['cases_sha256']!=base.sha(ROOT/'cases.json'):
        raise RuntimeError('sequence_cases_changed')
    files=['scripts/memory-task-breakeven-v3-eval.py','scripts/memory-task-human-eval.py','scripts/memory-task-full-eval.py','scripts/claude_reuse_execution.py','scripts/memory-task-human-host.mjs','scripts/memory-task-document-adapter.mjs']
    manifest={p:base.sha(REPO/p) for p in files}
    if (ROOT/'controller-manifest.json').exists():
        if base.load(ROOT/'controller-manifest.json')!=manifest:raise RuntimeError('controller_changed_after_freeze')
    else:
        base.save(ROOT/'controller-manifest.json',manifest)
        for p in files:
            d=ROOT/'originals'/p;d.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(REPO/p,d)
    return c


base.prepare=prepare
original_one=base.one

def one(case,condition,phase='comparison'):
    # Every start since the human-approved phase boundary shares one budget.
    phase_rows=base.load(base.LEDGER)[496:]
    if len(phase_rows)>=120 or any(a.get('api_equivalent_usd') is None for a in phase_rows) or sum(a['api_equivalent_usd'] for a in phase_rows)+0.30>10.0:
        raise RuntimeError('shared_phase_budget_stop')
    return original_one(case,condition,phase)

base.one=one


def main(action,rounds):
    if not 1<=rounds<=18:raise ValueError('rounds_must_be_1_to_18')
    prepare()
    if action=='prepare':print(json.dumps({'prepared':True,'model_starts':0}));return
    approval=base.load(ROOT/'budget-proposal.json',{})
    if approval.get('approved_cumulative_cap')!=616 or approval.get('approved_api_equivalent_usd')!=base.LIMIT:
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
            if case['round']>rounds:continue
            for condition in (['none','improved'] if i%2==0 else ['improved','none']):base.one(case,condition)


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('action',choices=['prepare','seed','run']);p.add_argument('--rounds',type=int,default=6);a=p.parse_args();main(a.action,a.rounds)
