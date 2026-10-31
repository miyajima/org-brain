"""Build local human cards from audited real outputs; never authors model answers."""
import hashlib
import json
from pathlib import Path

REPO=Path(__file__).resolve().parents[1];ROOT=REPO/'artifacts/memory-task-human-20261031';CHANNEL='task_human_v1'
def load(p):return json.loads(p.read_text())
def bind(card):return {**card,'digest':hashlib.sha256(json.dumps(card,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()}
def main():
    ledger=[a for a in load(REPO/'artifacts/memory-reuse-loop-20261026/attempts.json') if a.get('channel')==CHANNEL];routes=load(ROOT/'nonmodel-routes.json');cases=load(ROOT/'cases.json');cards=[]
    labels={'sufficient':'依頼の条件を満たし、この成果で十分','needs_fix':'修正が必要','uncertain':'十分か判断できない'}
    for kind in ['research','analysis','document']:
        a=next(x for x in ledger if x['phase']=='seed' and x['kind']==kind and x.get('success'));content=(ROOT/'runs'/a['id']/'deliverable.md').read_text()
        cards.append(bind({'id':'seed:'+kind,'stage':'seed_review','kind':kind,'title':'初回成果の確認：'+kind,'assignment':'初回に保存する2単位の成果が、出典・数値・制約を満たすか確認してください。この時間も初回作成費に含めます。画面外作業がなければ秒数欄に0を入れてください。','content':content,'allowed':list(labels),'labels':labels,'artifact_sha256':hashlib.sha256(content.encode()).hexdigest()}))
    for case in cases:
        a=next(x for x in ledger+routes if x['phase']=='comparison' and x['condition']=='improved' and x['case']==case['id'] and x.get('success'));d=ROOT/'runs'/a['id'];state=load(d/'state.json');q=state['question']
        config=load(d/'config.json');w=config['task_workflows'][case['workflow']]
        cards.append(bind({'id':'decision:'+case['id'],'case':case['id'],'stage':'decision','kind':case['kind'],'title':'候補の採否：'+w['title'],'assignment':case['assignment']+' 今回必要な範囲: '+ '、'.join(w['units'][u] for u in case['units']),'question':q['question'],'prior_content':state['prior']['content'],'allowed':['existing','delta','full'],'labels':{'existing':'既存成果で完了','delta':'差分だけ実施','full':'全体を実施'},'prior_id':state['prior']['id'],'prior_sha256':state['prior']['content_digest'],'expected_branch':case['route']}))
    for i,case in enumerate(cases):
        order=['none','improved'] if i%2==0 else ['improved','none']
        for j,condition in enumerate(order):
            a=next(x for x in ledger+routes if x['phase']=='comparison' and x['condition']==condition and x['case']==case['id'] and x.get('success'));d=ROOT/'runs'/a['id'];content=(d/'deliverable.md').read_text();cfg=load(d/'config.json');w=cfg['task_workflows'][case['workflow']]
            cards.append(bind({'id':'review:'+case['id']+':'+condition,'case':case['id'],'condition':condition,'stage':'review','kind':case['kind'],'title':'成果確認：'+w['title']+' '+('A' if j==0 else 'B'),'assignment':case['assignment']+' 必須の範囲: '+ '、'.join(w['units'][u] for u in case['units'])+'。原資料にない主張、数値・分母・単位、制約と未観測事項を確認してください。','content':content,'allowed':list(labels),'labels':labels,'artifact_sha256':hashlib.sha256(content.encode()).hexdigest()}))
    value={'title':'既存成果・差分の人を含む比較','purpose':'controlled_single_user_evaluation','origin':'solicited','cloud_deploy':False,'cards':cards,'limits':['Actual human choice is separate from the precomputed fixed benchmark branch.','User-controlled visible/focused timing is not proof of continuous cognitive attention.','Blank external work is missing; explicit user 0 is zero.','Repeated related cases can cause familiarity and fatigue.']}
    path=ROOT/'human-cards.json'
    if path.exists() and path.read_text()!=json.dumps(value,ensure_ascii=False,indent=2)+'\n':raise RuntimeError('human_cards_changed_after_freeze')
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n');path.chmod(0o600)
    print(json.dumps({'cards':len(cards),'seed_review':3,'adoption_decisions':12,'paired_final_review':24,'model_starts':0}))

if __name__=='__main__':main()
