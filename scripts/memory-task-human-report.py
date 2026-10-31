"""Offline audit, one-time creation allocation, and observed human-time accounting."""
import hashlib
import importlib.util
import json
import math
from pathlib import Path

REPO=Path(__file__).resolve().parents[1];ROOT=REPO/'artifacts/memory-task-human-20261031';LEDGER=REPO/'artifacts/memory-reuse-loop-20261026/attempts.json';CHANNEL='task_human_v1'
spec=importlib.util.spec_from_file_location('proof',REPO/'scripts/memory-task-full-report.py');proof=importlib.util.module_from_spec(spec);spec.loader.exec_module(proof)
load,save,rows,sha,digest=proof.load,proof.save,proof.rows,proof.sha,proof.digest


def human_total(record):
    fields=[record.get('active_ms'),record.get('rework_ms')]
    return sum(fields) if all(type(x) in (int,float) and math.isfinite(x) and x>=0 for x in fields) else None


def human_answer_matches(record,expected_digest,choice):
    return record.get('complete') is True and record.get('digest')==expected_digest and record.get('value')==choice and not record.get('skipped') and not record.get('interrupted')


def effective_sections(state,inp):
    allowed=state['allowed_units']
    if set(inp.get('sections',{}))!=set(allowed) or inp.get('units')!=allowed:
        raise ValueError('unapproved_sections')
    if state['choice']=='delta':
        if inp.get('op')!='patch':raise ValueError('patch_required')
        return {u:inp['sections'][u] if u in allowed else state['prior']['sections'][u] for u in state['requested_units']}
    if inp.get('op')!='write' or allowed!=state['requested_units']:raise ValueError('full_write_required')
    return inp['sections']


def audit(a,seeds):
    d=ROOT/'runs'/a['id'];state=load(d/'state.json');checks={};errors=[]
    prior=state.get('prior')
    if prior:
        checks['real_seed_provenance']=prior['id'] in seeds and a['expected_prior_id']==prior['id'] and sha(REPO/prior['path'])==prior['content_digest'] and all(sha(ROOT/'originals'/x['path'])==x['sha256'] for x in prior['file_sources'])
        checks['fixed_test_choice_not_human_adoption']=state['decision_source']=='simulated_local_user'
    if a.get('model_starts')==0:
        checks['existing_no_model_or_operation']=a['id'].startswith('host:') and state['choice']=='existing' and not state['operations'] and not state['created_results'] and a['total_tokens']==0 and a['api_equivalent_usd']==0
        checks['complete_requested_scope']=set(state['requested_units']).issubset(prior['covered_units']) and a['task_completion']['status']=='completed_with_existing_result'
        checks['same_real_prior_file']=sha(d/'deliverable.md')==prior['content_digest']
        return {'id':a['id'],'passed':all(checks.values()),'checks':checks,'errors':errors,'native_completed':0,'native_denied':0,'model':None}
    events,result=rows(d/'events.jsonl'),load(d/'result.json');tokens,usage=proof.token_usage(result);init=next(x for x in events if x.get('subtype')=='init')
    checks['actual_model_four_bins']=tokens is not None and tokens==a['total_tokens'] and usage==a['usage'] and init['model']==proof.MODEL and init['tools']==['Bash'] and a['argv'][a['argv'].index('--effort')+1]=='medium'
    marker='Project source envelope (host read, source data only): ';appended=a['argv'][a['argv'].index('--append-system-prompt')+1];packet=appended[appended.index(marker):]
    checks['complete_scope_bound_envelope']=proof.previous.envelope_matches(packet,state,a['source_envelope_digest']) and state['local']['source']['input']['units']==state['allowed_units']
    native={b['id']:b for e in events if e.get('type')=='assistant' for b in e.get('message',{}).get('content',[]) if b.get('type')=='tool_use'}
    outputs={b['tool_use_id']:b for e in events if e.get('type')=='user' for b in e.get('message',{}).get('content',[]) if b.get('type')=='tool_result'}
    completed=denied=0;cfg=load(d/'config.json');checks['test_isolation']=cfg['observation_purpose']=='test' and cfg['db_path'].startswith(str(ROOT))
    for call,b in native.items():
        try:
            out=outputs[call]
            if out.get('is_error'):
                meta=[m for e in events if e.get('type')=='user' for m in e.get('tool_result_meta',[]) if m.get('id')==call]
                assert any(m.get('non_execution_kind')=='permission-rule' and m.get('permission_decision',{}).get('source')=='hook' for m in meta)
                assert not any(x['native_call_id']==call for x in state['operations']+state['created_results']);denied+=1;continue
            value=json.loads(out['content']);private=load(d/(value['reuse_invocation_id']+'.json'));backend=proof.verified_backend(private,value,call)
            prefix=[cfg['action_adapters'][state['adapter']]['argv'][0],str(REPO/'scripts/memory-reuse-claude.mjs')];authored,raw=proof.decode_command(b['input']['command'],prefix,state['session_id']);request=private['request']
            assert b['name']=='Bash' and request['task_id']==a['id']==state['task_id'] and request['adapter']==state['adapter'] and request['uses']==[]
            assert raw is not None and private['request_protocol']=={'kind':'task_sections_stdin','raw_stdin':raw} and authored==request['input']['sections'] and json.loads(private['rawRequest'])==request
            assert private['scope']==state['scope'] and private['work_source_fingerprint']==state['source_fingerprint']
            assert effective_sections(state,request['input'])==backend['artifact']['sections']
            artifact=backend['artifact'];created=next(x for x in state['created_results'] if x['native_call_id']==call)
            assert sha(REPO/artifact['path'])==artifact['sha256']==value['artifact']['sha256']==created['content_digest']==sha(d/'deliverable.md');completed+=1
        except (AssertionError,KeyError,TypeError,ValueError,FileNotFoundError) as e:errors.append({'call':call,'error':type(e).__name__+':'+str(e)})
    checks['all_native_input_output_files']=not errors and completed+denied==len(native)
    checks['delivered_or_verified_failure']=completed>0 if a.get('success') else completed==0 and not state['created_results']
    if state['choice']=='delta':checks['retained_units_attributed_correctly']=a['task_completion']['reused_units']==[u for u in state['requested_units'] if u not in state['allowed_units']]
    return {'id':a['id'],'passed':all(checks.values()),'checks':checks,'errors':errors,'native_completed':completed,'native_denied':denied,'model':init['model'],'cli_version':init['claude_code_version']}


def main():
    ledger=load(LEDGER);attempts=[a for a in ledger if a.get('channel')==CHANNEL];routes=load(ROOT/'nonmodel-routes.json',[]);cases=load(ROOT/'cases.json');seeds=[a for a in attempts if a['phase']=='seed'];seed_ids={r['id'] for a in seeds if a.get('success') for r in load(ROOT/'runs'/a['id']/'state.json')['created_results']}
    audits=[audit(a,seed_ids) for a in attempts+routes];save(ROOT/'audit.json',audits)
    cards=load(ROOT/'human-cards.json',{}).get('cards',[]);cardmap={c['id']:c for c in cards};human=load(ROOT/'human/human-records.json',{})
    quality=load(ROOT/'quality-review.json',{})
    core_ok=lambda case:quality.get('cases',{}).get(case,{}).get('baseline_core_pass') is True and quality.get('cases',{}).get(case,{}).get('reuse_core_pass') is True
    adopted_by_kind={kind:0 for kind in ['research','analysis','document']}
    for case in cases:
        ids=['decision:'+case['id'],'review:'+case['id']+':improved','seed:'+case['kind']]
        if core_ok(case['id']) and all(k in cardmap and human_answer_matches(human.get(k,{}),cardmap[k]['digest'],case['route'] if i==0 else 'sufficient') for i,k in enumerate(ids)):
            adopted_by_kind[case['kind']]+=1
    pairs=[]
    for case in cases:
        baseline=[a for a in attempts if a['phase']=='comparison' and a['case']==case['id'] and a['condition']=='none'];reuse=[a for a in attempts+routes if a['phase']=='comparison' and a['case']==case['id'] and a['condition']=='improved'];creation=[a for a in seeds if a['kind']==case['kind']]
        if not baseline or not reuse:continue
        b,u,seed=proof.summarize(baseline),proof.summarize(reuse),proof.summarize(creation)
        decision_id='decision:'+case['id'];review_ids=['review:'+case['id']+':none','review:'+case['id']+':improved'];seed_review='seed:'+case['kind']
        answer=human.get(decision_id,{});decision_matches=decision_id in cardmap and human_answer_matches(answer,cardmap[decision_id]['digest'],case['route'])
        accepted=all(k in cardmap and human_answer_matches(human.get(k,{}),cardmap[k]['digest'],'sufficient') for k in review_ids+[seed_review])
        bt=human_total(human.get(review_ids[0],{}));dt=human_total(answer);rt=human_total(human.get(review_ids[1],{}));st=human_total(human.get(seed_review,{}))
        human_values=[bt,dt,rt,st];net=None
        uses=adopted_by_kind[case['kind']]
        if core_ok(case['id']) and decision_matches and accepted and all(x is not None for x in human_values) and uses:
            net={'baseline_ms':b['machine_ms']+bt,'reuse_ms':u['machine_ms']+dt+rt+(seed['machine_ms']+st)/uses,'creation_allocation_observed_uses':uses}
            net['saved_ms']=net['baseline_ms']-net['reuse_ms']
        allocated={k:u[k]+seed[k]/4 for k in ['total_tokens','machine_ms','api_equivalent_usd']}
        pairs.append({'case':case['id'],'kind':case['kind'],'route':case['route'],'same_core_quality':core_ok(case['id']),'baseline':b,'reuse':u,'creation_quarter':{k:seed[k]/4 for k in ['total_tokens','machine_ms','api_equivalent_usd']},'with_creation':allocated,'change_with_creation_pct':proof.changes(allocated,b),'human':{'choice':answer.get('value'),'choice_matches_fixed_route':decision_matches,'all_human_reviews_sufficient':accepted,'baseline_final_ms':bt,'reuse_decision_ms':dt,'reuse_final_ms':rt,'seed_review_ms':st,'net_with_creation':net},'machine_only_incremental_human_allowance_ms':b['machine_ms']-allocated['machine_ms']})
    by_route={}
    for route in ['existing','delta']:
        group=[p for p in pairs if p['route']==route]
        if not group:continue
        aggregate=lambda name:{k:sum(p[name][k] for p in group) for k in ['total_tokens','machine_ms','api_equivalent_usd']}
        baseline,reuse,allocated=aggregate('baseline'),aggregate('reuse'),aggregate('with_creation');matched=[p['human']['net_with_creation'] for p in group if p['human']['net_with_creation']]
        creation_total=proof.summarize(seeds);standalone={k:reuse[k]+creation_total[k] for k in ['total_tokens','machine_ms','api_equivalent_usd']}
        by_route[route]={'n':len(group),'baseline':baseline,'reuse_only':reuse,'with_creation_half_shared':allocated,'change_vs_none_with_creation_pct':proof.changes(allocated,baseline),'standalone_full_creation':standalone,'standalone_change_pct':proof.changes(standalone,baseline),'human_complete_pairs':len(matched),'human_net_complete_only':{'baseline_ms':sum(x['baseline_ms'] for x in matched),'reuse_ms':sum(x['reuse_ms'] for x in matched),'saved_ms':sum(x['saved_ms'] for x in matched)} if matched else None,'human_all_pairs_result':None if len(matched)!=len(group) else {'saved_ms':sum(x['saved_ms'] for x in matched)}}
    report={'cumulative_starts':len(ledger),'additional_model_starts':len(attempts),'model_start_limit':484,'additional_start_limit':24,'api_usd_limit':3.60,'all_evaluation':proof.summarize(attempts),'creation':proof.summarize(seeds),'existing_routes':len(routes),'audit_passed':sum(x['passed'] for x in audits),'audited':len(audits),'pairs':pairs,'by_route':by_route,'human_records':len(human),'human_required_cards':len(cards),'human_completed_cards':sum(bool(x.get('complete')) for x in human.values()),'human_adopted_by_kind':adopted_by_kind,'human_missing_is_not_zero':True,'quality_review':load(ROOT/'quality-review.json',{'status':'pending'}),'actual_billing_usd':None,'human_hourly_rate':None,'implementation_audit_money':None,'origin':'Fixed branches on solicited real-project tasks; separate controlled single-person human evaluation; not organic or team use.','creation_allocation':'Fixed technical reference: four opportunities per prior, one quarter per case and one half per route. Human-qualified subset: divide by observed matching accepted uses, never assume four real adoptions. Aggregate charges creation once.','human_scope_warning':'Time is user-controlled focus-visible interaction plus separately reported external work, not a complete attention measurement. Different choice or insufficient review does not qualify a fixed branch as actual adoption.','cloud_deployed':False}
    if len(pairs)==12:
        base={k:sum(p['baseline'][k] for p in pairs) for k in ['total_tokens','machine_ms','api_equivalent_usd']}
        used={k:sum(p['with_creation'][k] for p in pairs) for k in ['total_tokens','machine_ms','api_equivalent_usd']}
        report['combined_fixed_twelve']={'baseline':base,'reuse_including_creation_once':used,'change_pct':proof.changes(used,base)}
    report['status']='machine_complete_human_input_pending' if not human else 'human_observations_partial_or_quality_not_qualified'
    report['usage_all_evaluation']={k:sum(a['usage'][k] for a in attempts) for k in ['input_tokens','cache_creation_input_tokens','cache_read_input_tokens','output_tokens']}
    report['validation']=load(ROOT/'validation.json',{})
    save(ROOT/'report.json',report)
    render(report)
    print(json.dumps({k:report[k] for k in ['status','cumulative_starts','additional_model_starts','all_evaluation','existing_routes','audit_passed','audited','by_route','human_completed_cards','human_required_cards']},ensure_ascii=False))


def render(report):
    lines=['# 既存完了・差分作業の再比較と人の確認時間','', '2026-10-31。クラウド展開なし。実モデルはclaude-sonnet-5-5、effort medium。固定応答の再生なし。', '', f"追加実モデル{report['additional_model_starts']}回、累計{report['cumulative_starts']}回（承認上限24回・累計484回）。API換算{report['all_evaluation']['api_equivalent_usd']:.7f} USD（上限3.60 USD、事前見積約1.80 USD）。実請求額、親の実装・監査費用、人の単価は未取得。", '', '**既存完了は6件とも元成果の範囲と内容を保持した。差分は6件とも既存節をそのまま保持したが、追加節と保持節の意味の整合性に5件の修正・明確化が必要。差分の使用量の減少を、同品質の効率改善として認定しない。人の判断・成果確認は実回答待ちである。**', '', '## 実行と検証', '', '現在の通常設定と同じ本文の標準入力・短い完了応答を使い、初回成果3件、既存完了と対応する記憶なし各6件、差分と対応する記憶なし各6件、改善版の差分6件を測定した。全21モデル実行が完了し、失敗・再実行は0。既存完了6件はモデルを起動しない。各条件で同じ原資料・版・要求単位を用い、実行順を交互にした。評価設定・DBを隔離し、通常DBへ試験成果を移していない。時間計測中にテストやWiki整備を行っていない。', '', f"実引数、実出力、ネイティブ呼出ID、元成果のID・ハッシュと原資料、完成ファイルを照合し{report['audit_passed']}/{report['audited']}が整合した。既存完了は新規操作なし、差分は不足1単位だけをモデルが生成し、既存2単位の文字列を保持した。元記憶をモデルが読んだという主張へ置き換えない。新しい計測・監査テスト8件が通過し、変更していない製品の機能・回帰108件の通過証拠を再利用した。", '', '## 初回作成費を含む機械側の参考値', '', '| 分岐（各6課題） | 記憶なしトークン | 改善版＋作成費半分 | トークン変化 | 時間変化 | API換算変化 |','|---|---:|---:|---:|---:|---:|']
    for route,label in [('existing','既存成果で完了'),('delta','差分（意味の品質未達）')]:
        if route not in report['by_route']:continue
        x=report['by_route'][route];v=x['change_vs_none_with_creation_pct'];lines.append(f"| {label} | {x['baseline']['total_tokens']:,} | {x['with_creation_half_shared']['total_tokens']:,.0f} | {v['total_tokens']:+.2f}% | {v['machine_ms']:+.2f}% | {v['api_equivalent_usd']:+.2f}% |")
    creation=report['creation'];lines+=['', f"初回作成3件は{creation['total_tokens']:,}トークン・{creation['machine_ms']/1000:.2f}秒・{creation['api_equivalent_usd']:.7f} USD。各元成果を既存完了2件と差分2件、計4回の固定機会へ使うため、上表では1課題につき4分の1、各分岐に半分ずつ配分した。両分岐の総計へ初回費を一度だけ加えた参考値であり、人による4回の実採用を仮定した実効果ではない。", '', '| 単独導入を想定し初回費を全額配分 | トークン変化 | 時間変化 | API換算変化 |','|---|---:|---:|---:|']
    for route,label in [('existing','既存完了6件だけ'),('delta','差分6件だけ（品質未達）')]:
        if route in report['by_route']:
            v=report['by_route'][route]['standalone_change_pct'];lines.append(f"| {label} | {v['total_tokens']:+.2f}% | {v['machine_ms']:+.2f}% | {v['api_equivalent_usd']:+.2f}% |")
    lines+=['', '後者2行は別々の導入想定なので足し合わせない。差分だけで初回費を負担する場合、機械時間の差は合計約0.54秒、1件約0.09秒にとどまる。作成費、検索、提示、資料注入、検証・追跡は総トークンとホスト＋CLI時間へ含めた。工程は重複加算しない。評価専用の設定・DBコピー、実装・監査、人の確認画面のCPU金額は未取得。', '', '## 内容の保持と不足', '', '親が原資料・初回成果・追加節・結合後の文書を照合した。記憶なし12件、既存完了6件は中心となる数値・分母・範囲と制約を保持。差分はresearch-delta-1のみ結合後の整合性を確認でき、残る5件は修正・明確化が必要だった。', '', '- research-delta-2: 保持節にはAPI換算・機械時間の実測があるが、追加節で広く「削減効果は未検証」とした。人や実請求を含む効果に限定する必要がある。','- analysis-delta-1: 保持節にn=10があるのに、追加節で対象件数不明とした。','- analysis-delta-2: 保持節に対照値とn=10があるのに、追加節で分母が無いとした。','- document-delta-1・2: 保持節に設定ファイルの場所があるのに、追加節で場所が不明とした。', '', '原因は、追加節のモデルへ差分資料だけを渡し、保持節の既知の事実を渡していないこと。ホストによる文字列保持だけでは、結合後の意味の整合性は保証されない。原出力を後から修正・置換して成功扱いにはしていない。次の実装候補は、保持済み事実を短い出典付き一覧として渡し、結合後の文書を検査すること。今回、その修正の効果は実測していない。', '', '## 人の判断と成果確認', '', f"実回答の保存済み項目: {report['human_completed_cards']}/{report['human_required_cards']}。初回成果確認3件、採否12件、両条件の成果確認24件。人の時刻や判断をモデル・テスト操作で代行しない。未開始・中断・未記入を0にしない。", '', 'ローカル画面の開始・一時停止・回答をサーバーの単調時計で測定する。別画面へ移ると一時停止し、表示内容を隠す。再読込やサーバー再起動で不明区間が生じれば欠測にする。画面外の原本確認・修正は本人の別計測申告とし、何も行わなかった場合に本人が0を記入したものだけ0にする。画面の表示時間は完全な注意の測定ではない。', '', '技術比較の分岐は指定して先に実行し、人の実際の採否は別に記録する。選択が違う、成果を不十分と判定した、親の内容確認で品質未達、または時間欠測の場合は、その分岐の人を含む削減を認定しない。実採用が4回未満なら、その実採用件数へ初回費を配分し直す。反復による慣れ・疲労がある1人の統制評価で、自然利用や実チーム利用ではない。', '', '人を含む比較式は、記憶なし＝機械時間＋成果確認・修正、再利用＝機械時間＋採否＋成果確認・修正＋初回モデル作成と初回人確認の配分。欠測を含む合計はnull。人件費単価がないため秒とAPI換算USDを別に示す。', '', '| 分岐 | 人を含む有効比較 | 削減時間 |','|---|---:|---:|']
    for route,label in [('existing','既存完了'),('delta','差分')]:
        if route in report['by_route']:
            x=report['by_route'][route];v=x['human_all_pairs_result'];lines.append(f"| {label} | {x['human_complete_pairs']}/{x['n']} | "+('未確定' if v is None else f"{v['saved_ms']/1000:+.2f}秒")+' |')
    lines+=['', '## 再開手順と根拠', '', '計測画面は `human-server.json` のURL。必要なら `python3 scripts/memory-task-human.py --root artifacts/memory-task-human-20261031` で起動する。記録済み回答は保持するが、中断していた項目の時間は欠測にする。`python3 scripts/memory-task-human-report.py` は新しいモデルを起動せずに集計・報告を更新する。', '', '原資料の測定時点の版は `originals/` と `manifest.json`。実CLI台帳は `artifacts/memory-reuse-loop-20261026/attempts.json`。条件は [PROTOCOL.md](PROTOCOL.md)、集計は [report.json](report.json)、系譜と実操作は [audit.json](audit.json)、意味の不足は [quality-review.json](quality-review.json)。通常設定・クラウドは今回変更していない。']
    (ROOT/'REPORT.md').write_text('\n'.join(lines)+'\n')


if __name__=='__main__':main()
