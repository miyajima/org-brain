"""Offline cumulative accounting and independent native proof; no model calls."""
import importlib.util
import json
from pathlib import Path

REPO=Path(__file__).resolve().parents[1];ROOT=REPO/'artifacts/memory-task-breakeven-20261031';CHANNEL='task_breakeven_v2'
s=importlib.util.spec_from_file_location('coherence',REPO/'scripts/memory-task-coherence-report.py');proof=importlib.util.module_from_spec(s);s.loader.exec_module(proof)
proof.ROOT=ROOT;proof.base.ROOT=ROOT
load,save=proof.load,proof.save
KEYS={'total_tokens':'total_tokens','machine_ms':'total_ms','api_equivalent_usd':'api_equivalent_usd'}


def totals(rows):
    return {out:sum(a[key] for a in rows) if all(a.get(key) is not None for a in rows) else None for out,key in KEYS.items()}


def curve(rows,kinds):
    seeds=[a for a in rows if a['phase']=='seed' and a['kind'] in kinds]
    if not all(any(a['kind']==k and a.get('success') for a in seeds) for k in kinds):return []
    points=[]
    for n in range(1,19):
        group=[a for a in rows if a['phase'].startswith('comparison') and a['kind'] in kinds and int(a['case'].rsplit('-',1)[1])<=n]
        if not all(any(a['case']==f'{k}-delta-{i}' and a['condition']==c and a.get('success') for a in group) for i in range(1,n+1) for k in kinds for c in ['none','improved']):break
        b=totals([a for a in group if a['condition']=='none']);r=totals([a for a in group if a['condition']=='improved']);creation=totals(seeds)
        if any(x is None for obj in [b,r,creation] for x in obj.values()):break
        full={k:r[k]+creation[k] for k in KEYS};change={k:(full[k]/b[k]-1)*100 for k in KEYS}
        points.append({'reuse_per_prior':n,'tasks':n*len(kinds),'baseline':b,'reuse_only':r,'with_creation':full,'change_pct':change,'both_lower':full['total_tokens']<b['total_tokens'] and full['machine_ms']<b['machine_ms'],'net_machine_saved_ms':b['machine_ms']-full['machine_ms'],'estimated_net_saved_ms':{str(sec):b['machine_ms']-full['machine_ms']-sec*1000*n*len(kinds) for sec in [10,30,60]}})
    return points


def crossing(points):
    first=next((p['reuse_per_prior'] for p in points if p['both_lower']),None)
    confirmed=next((points[i]['reuse_per_prior'] for i in range(len(points)-2) if all(p['both_lower'] for p in points[i:])),None)
    return {'first_both_lower':first,'confirmed_after_two_more':confirmed,'minimum_six_complete':len(points)>=6}


def prefix_qualified(rows,kinds,n,quality):
    needed=[('seed',k) for k in kinds]+[('comparison',f'{k}-delta-{i}',c) for k in kinds for i in range(1,n+1) for c in ['none','improved']]
    latest={}
    for a in rows:
        if a['kind'] not in kinds:continue
        key=('seed',a['kind']) if a['phase']=='seed' else ('comparison',a['case'],a['condition'])
        latest[key]=a
    return all(key in latest and latest[key].get('success') and quality.get(latest[key]['id']) is True for key in needed)


def quality_rates(rows,quality):
    result={}
    for condition in ['none','improved']:
        group=[a for a in rows if a['phase'].startswith('comparison') and a['condition']==condition]
        initial=[a for a in group if a['phase']=='comparison']
        latest={a['case']:a for a in group}
        result[condition]={'initial_passed':sum(quality.get(a['id']) is True for a in initial),'initial_tasks':len(initial),'final_passed':sum(quality.get(a['id']) is True for a in latest.values()),'final_tasks':len(latest),'repair_starts':len(group)-len(initial)}
    return result


def render(r):
    lines=['# 過剰拒否の修正と初回作成費の回収', '',
        f"比較版: {CHANNEL}。この版{r['additional_starts']}開始、今回の全改善{r['phase_starts']}開始、累計{r['cumulative_starts']}開始。今回全体のAPI換算費用は{r['phase_cost_usd']:.7f} USD（追加上限10 USD・120開始）。この版は{r['all_evaluation']['api_equivalent_usd']:.7f} USD。実請求・親の実装監査費・人件費は未取得。クラウド展開なし。", '',
        'モデルはclaude-sonnet-5-5、effort medium。初回に調査・分析・文書作成の2単位ずつを実モデルで作成。同じ元成果へ追加1単位を求める別セッションを繰り返した。対照は毎回3単位を生成。原資料と成功条件を固定、順序を交互にした。選択のみ模擬。3種類の固定課題の反復であり、多様な課題や自然な利用者採用を表さない。', '',
        f"初回作成全額: {r['creation']['total_tokens']:,}トークン / {r['creation']['machine_ms']/1000:.2f}秒 / {r['creation']['api_equivalent_usd']:.7f} USD。累計再利用側へ一度だけ加算する。失敗・拒否・修正・再実行は除外しない。", '',
        f"独立した操作・出典監査は{r['audit_passed']}/{r['audited']}件整合。親による意味レビューは{r['quality_reviewed']}件、初回出力の意味不合格{r['quality_rejected']}件、未レビュー{r['quality_missing']}件。修復後を含めた最終品質の成立: {r['final_quality_qualified']}。新版利用者の受入れとは別の判定。", '',
        '## 品質条件を満たした回収点', '',
        '| 対象 | 両指標が初めて減少 | その後2回以上も維持した回収点 | 比較した回数/元成果 |', '|---|---:|---:|---:|']
    for k,label in [('research','調査'),('analysis','分析'),('document','文書作成'),('all','3種類合計')]:
        x=r['qualified_crossings'][k];lines.append(f"| {label} | {x['first_both_lower'] or '未到達/品質未達'} | {x['confirmed_after_two_more'] or '未確認'} | {len(r['curves'][k])} |")
    lines+=['', '3種類合計の回数は各元成果を同じ回数使った場合。最初の6回を完了後、必要なら追加する事前手順。停止が結果に依存するため、統計的な保証ではなく観測した記述値。', '',
        '## 費用の累計（品質不合格を含む生の数値）', '',
        '| 各成果の再利用回数 | 課題数 | 対照トークン | 初回費込みトークン | 増減 | 対照時間 | 初回費込み時間 | 増減 |', '|---|---:|---:|---:|---:|---:|---:|---:|']
    for x in r['curves']['all']:
        b,u,v=x['baseline'],x['with_creation'],x['change_pct'];lines.append(f"| {x['reuse_per_prior']} | {x['tasks']} | {b['total_tokens']:,} | {u['total_tokens']:,} | {v['total_tokens']:+.2f}% | {b['machine_ms']/1000:.2f}秒 | {u['machine_ms']/1000:.2f}秒 | {v['machine_ms']:+.2f}% |")
    lines+=['', '品質未達の数値を削減成功として扱わない。元成果ID・原資料と実装のハッシュ・権限・期限・引用位置・ネイティブ入力と実出力・完成ファイルを別コードで照合。自動矛盾検査は既知の事実と全体件数の限定的な検査であり、一般的な意味の正しさを保証しない。', '',
        f"CLI失敗{r['failed_starts']}件、操作拒否{r['denied_operations']}件。4区分の全トークン、ホスト準備＋CLI実時間を計上。検索・注入・検査・操作・追跡は中に含まれ、工程別時間を重ねて加算しない。評価用DB複製、実装、親レビューは別勘定。", '',
        '| 条件 | 初回の意味合格/課題数 | 修正後の意味合格/課題数 | 追加生成 |', '|---|---:|---:|---:|']
    for condition,label in [('none','記憶なし'),('improved','再利用')]:
        q=r['quality_rates'][condition];lines.append(f"| {label} | {q['initial_passed']}/{q['initial_tasks']} | {q['final_passed']}/{q['final_tasks']} | {q['repair_starts']}回 |")
    lines+=['', '初回の意味合格率が同等になったとは主張しない。親の指摘を添えて同じ資料から再生成した費用を、失敗した当該課題に加算した。親レビュー自体の作業時間と費用は未取得。最終値はこの修正を含む運用比較であり、一発生成だけの比較ではない。', '',
        '## 人の確認時間', '',
        '新版の利用判断と能動的な確認時間は欠測。旧版の初回成果確認86.84秒・9.98秒（ともに判断できない）は別の実測で、新版へ転用しない。未完了の30.43秒も完了測定にしない。以下は採否＋配分した初回人確認＋再利用側の成果確認/修正−対照側の成果確認/修正という純増人時間の感度分析。実測ではない。']
    if r['curves']['all']:
        x=r['curves']['all'][-1];lines+=['',f"最終{ x['tasks']}課題で機械時間の差は{x['net_machine_saved_ms']/1000:+.2f}秒。1再利用あたり純増人時間が平均{x['net_machine_saved_ms']/x['tasks']/1000:.2f}秒未満なら、人の時間を含む短縮も成立する計算。", '', '| 仮定した純増人時間/再利用 | 総時間の短縮（負は増加） |','|---|---:|']
        for sec,saved in x['estimated_net_saved_ms'].items():lines.append(f"| {sec}秒 | {saved/1000:+.2f}秒 |")
    if CHANNEL.endswith('v2'):
        lines+=['','v2初回作成中には0.022秒の集計テストimport失敗が重なった。その影響を取り除かず残す。対照・再利用比較中にはテストを実施していない。v2の追加過剰拒否と意味不合格を受け、新しいコホートv3へ進んだ。']
    else:lines+=['','v3のモデル計測中にはテスト・ビルド・Wiki処理を実施していない。v2の失敗と評価費は今回全体の準備・検証費に残し、v3の運用回収曲線へ混ぜない。']
    lines+=['','逐次実行中の短いログ読取・親による内容確認は並行した。通信や端末負荷のばらつきがあり、最初に閾値を下回った回数を一般的な保証としない。再利用した原成果は3件で、課題数は異なる知識の件数ではない。今回の比較は同じローカル利用者で、他メンバーの実利用効果は未観測。', '',
        '工程別の内訳は report.json の overhead_components_ms。ホスト準備、フック、検証、アダプター時間は包含関係があるため合算しない。注入の独立したトークン内訳は未取得だが、実CLIの入力・キャッシュ作成・キャッシュ読込・出力へ含めた。']
    lines+=['', '元データ: report.json、audit.json、quality-review.json、PROTOCOL.md、originals/、runs/。モデル0回の再集計: `python3 scripts/memory-task-breakeven-report.py --cohort '+('v3' if CHANNEL.endswith('v3') else 'v2')+'`。']
    (ROOT/'REPORT.md').write_text('\n'.join(lines)+'\n')


def main(cohort='v2'):
    global ROOT,CHANNEL
    CHANNEL='task_breakeven_'+cohort
    ROOT=REPO/('artifacts/memory-task-breakeven-v3-20261031' if cohort=='v3' else 'artifacts/memory-task-breakeven-20261031')
    proof.ROOT=ROOT;proof.base.ROOT=ROOT
    ledger=load(REPO/'artifacts/memory-reuse-loop-20261026/attempts.json');attempts=[a for a in ledger if a.get('channel')==CHANNEL]
    seeds=[a for a in attempts if a['phase']=='seed'];ids={r['id'] for a in seeds if a.get('success') for r in load(ROOT/'runs'/a['id']/'state.json')['created_results']}
    audits=[]
    for a in attempts:
        if 'success' not in a:raise RuntimeError('active_or_unaccounted_start')
        v=proof.base.audit(a,ids)
        if a['condition']=='improved' and a.get('success'):
            state=load(ROOT/'runs'/a['id']/'state.json');receipt=state['created_results'][-1].get('consistency_check',{})
            required={'research':{'measured_effect'},'analysis':{'sample_size','denominator'},'document':{'configuration_paths'}}[a['kind']]
            v['checks']['joined_version_receipt']=receipt.get('version')=='known-fact-consistency/'+cohort and receipt.get('status')=='passed' and required.issubset(receipt.get('checked_topics',[])) and not receipt['issues'] and a['task_completion'].get('consistency_check')==receipt
            v['passed']=all(v['checks'].values())
        audits.append(v)
    save(ROOT/'audit.json',audits)
    curves={k:curve(attempts,[k]) for k in ['research','analysis','document']};curves['all']=curve(attempts,['research','analysis','document'])
    quality=load(ROOT/'quality-review.json',{'status':'pending'});reviews=quality.get('attempts',{});verified={}
    import hashlib
    for a,v in zip(attempts,audits):
        q=reviews.get(a['id'],{});path=ROOT/'runs'/a['id']/'deliverable.md'
        verified[a['id']]=v['passed'] and q.get('passed') is True and path.exists() and q.get('deliverable_sha256')==hashlib.sha256(path.read_bytes()).hexdigest()
    qualified={k:[p for p in points if prefix_qualified(attempts,['research','analysis','document'] if k=='all' else [k],p['reuse_per_prior'],verified)] for k,points in curves.items()}
    phase=ledger[496:]
    report={'cumulative_starts':len(ledger),'additional_starts':len(attempts),'phase_starts':len(phase),'phase_cost_usd':sum(a['api_equivalent_usd'] for a in phase),'api_cap_usd':10,'additional_cap':120,'all_evaluation':totals(attempts),'creation':totals(seeds),'curves':curves,'crossings':{k:crossing(v) for k,v in curves.items()},'qualified_crossings':{k:crossing(v) for k,v in qualified.items()},'final_quality_qualified':bool(qualified['all']) and qualified['all'][-1]==curves['all'][-1],'audit_passed':sum(x['passed'] for x in audits),'audited':len(audits),'quality':quality,'quality_reviewed':len(reviews),'quality_rejected':sum(q.get('passed') is False for q in reviews.values()),'quality_missing':len(attempts)-len(reviews),'denied_operations':sum(x['native_denied'] for x in audits),'failed_starts':sum(not a.get('success') for a in attempts),'actual_billing_usd':None,'new_human_attention_ms':None,'cloud_deployed':False,'origin':'Fixed real-project tasks, simulated branch choice, fresh sessions referencing same seed; no natural human or team adoption.'}
    report['quality_rates']=quality_rates(attempts,verified)
    report['reuse_counts']={'distinct_prior_results':len({a['expected_prior_id'] for a in attempts if a['condition']=='improved'}),'logical_result_task_pairs':len({a['case'] for a in attempts if a['condition']=='improved'}),'native_reuse_starts_including_repairs':sum(a['condition']=='improved' for a in attempts),'original_model_memory_use_claims':0,'real_team_adoption':None}
    report['overhead_components_ms']={}
    for key,group in [('creation',seeds),('none',[a for a in attempts if a['phase'].startswith('comparison') and a['condition']=='none']),('improved',[a for a in attempts if a['condition']=='improved'])]:
        report['overhead_components_ms'][key]={'host_preparation_included':sum(a['setup_ms'] for a in group),'evaluation_fixture_setup_excluded':sum(a['harness_setup_ms'] for a in group),'hooks_included_overlapping':{phase:sum(a['phase_times_ms'].get(phase,0) for a in group) for phase in ['context','pre','post','stop']},'native_invocations':sum(len(a.get('invocation_timings',[])) for a in group),'adapter_validation_included_overlapping':{name:sum(t.get(name,0) for a in group for t in a.get('invocation_timings',[]) if t) for name in ['validation_ms','adapter_ms','helper_body_ms']},'four_token_bins':{name:sum(a['usage'][name] for a in group) for name in ['input_tokens','cache_creation_input_tokens','cache_read_input_tokens','output_tokens']}}
    save(ROOT/'report.json',report);render(report)
    print(json.dumps({k:report[k] for k in ['cumulative_starts','additional_starts','phase_starts','phase_cost_usd','all_evaluation','audit_passed','audited','qualified_crossings','denied_operations','final_quality_qualified','quality_rejected','quality_missing']},ensure_ascii=False))


if __name__=='__main__':
    import argparse
    p=argparse.ArgumentParser();p.add_argument('--cohort',choices=['v2','v3'],default='v2');main(p.parse_args().cohort)
