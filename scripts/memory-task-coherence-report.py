"""Independent native audit of retained context; no model or human answer generation."""
import hashlib
import importlib.util
import json
from pathlib import Path

REPO=Path(__file__).resolve().parents[1];ROOT=REPO/'artifacts/memory-task-coherence-20261031';CHANNEL='task_coherence_v1'
spec=importlib.util.spec_from_file_location('human_report',REPO/'scripts/memory-task-human-report.py');base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
base.ROOT=ROOT;base.CHANNEL=CHANNEL
load,save,rows,sha,digest=base.load,base.save,base.rows,base.sha,base.digest
ordinary_envelope=base.proof.previous.envelope_matches


def utf16_slice(text,start,end):
    return text.encode('utf-16-le')[start*2:end*2].decode('utf-16-le')


def retained_envelope_matches(content,state,claimed):
    if state['choice']!='delta' or not state['local'].get('delta_consistency'):
        return ordinary_envelope(content,state,claimed)
    try:
        marker='Project source envelope (host read, source data only): '
        packet=json.loads(content.removeprefix(marker));retained=packet.pop('retained_context');source=state['local']['source']
        expected={'session_id':state['session_id'],'scope':state['scope'],'workflow_id':state['workflow_id'],'source_receipt_id':source['id'],'source_fingerprint':state['source_fingerprint'],'units':state['allowed_units'],'source':source['output'][source['field']]}
        if not content.startswith(marker) or digest(content)!=claimed or packet!=expected:return False
        if retained!=state['local']['retained_context'] or digest(retained)!=state['local']['retained_context_digest']:return False
        if retained['prior_id']!=state['prior']['id'] or retained['prior_content_digest']!=state['prior']['content_digest']:return False
        if retained['retained_units']!=[u for u in state['requested_units'] if u not in state['allowed_units']]:return False
        count=0
        for item in retained['snippets']:
            if item['unit'] not in retained['retained_units']:return False
            original=state['prior']['sections'][item['unit']]
            if type(item['start']) is not int or type(item['end']) is not int or not 0<=item['start']<item['end']<=len(original.encode('utf-16-le'))//2:return False
            allowed=state['local']['delta_consistency']['topics'].get(item['unit'],[])
            if not isinstance(item['topics'],list) or any(t not in allowed for t in item['topics']):return False
            if utf16_slice(state['prior']['sections'][item['unit']],item['start'],item['end'])!=item['text']:return False
            count+=len(item['text'].encode('utf-16-le'))//2
        return count==retained['character_count'] and count<=state['local']['delta_consistency']['max_chars']
    except (KeyError,ValueError,TypeError,UnicodeError):return False


base.proof.previous.envelope_matches=retained_envelope_matches


def summarize(items):
    return base.proof.summarize(items) if items else {'starts':0,'successful_starts':0,'total_tokens':0,'machine_ms':0,'api_equivalent_usd':0}


def render(report):
    lines=['# 保持事実の供給と結合後検査の実モデル比較','',
        '2026-10-31。ローカルClaude CLI、claude-sonnet-5-5、effort medium。クラウド展開なし。', '',
        f"追加{report['additional_starts']}回、累計{report['cumulative_starts']}回。承認上限は追加18回・累計499回、API換算2.00 USD。今回の全評価費は{report['all_evaluation']['api_equivalent_usd']:.7f} USD。実請求額、親の実装・監査費、人件費は未取得。", '',
        f"証跡監査は{report['audit_passed']}/{report['audited']}件。意味の確認は親による原資料・初回成果・全体生成・結合後文書の照合で、人による採用判断とは別に扱う。"]
    combined=report['combined']
    if not combined:
        lines+=['', '比較未完了。削減効果は未確定。']
    else:
        lines+=['', f"同じ必須条件での完成: {'6/6件を確認' if combined['same_completed_quality'] else '未達または未確認'}。", '',
            '## 初回作成費を全額含む比較（6課題）', '',
            '| 指標 | 記憶なし | 改善版＋初回作成 | 変化 |','|---|---:|---:|---:|']
        b,u=combined['baseline'],combined['reuse_with_creation_once']
        for k,label,scale,unit in [('total_tokens','総トークン',1,''),('machine_ms','機械時間',1000,'秒'),('api_equivalent_usd','API換算',1,' USD')]:
            precision=0 if k=='total_tokens' else 4 if k=='api_equivalent_usd' else 2
            lines.append(f"| {label} | {b[k]/scale:,.{precision}f}{unit} | {u[k]/scale:,.{precision}f}{unit} | {combined['change_pct'][k]:+.2f}% |")
        c=report['creation'];r=report['group_summary']['reuse_only'];v=base.proof.changes(r,b)
        lines+=['', f"初回3成果: {c['total_tokens']:,}トークン、{c['machine_ms']/1000:.2f}秒、{c['api_equivalent_usd']:.7f} USD。各成果を固定2課題で再利用するため1課題へ半分ずつ配分し、総計に全額を一度だけ加えた。実際に人が2回採用したという意味ではない。1回しか使わなければ配分を見直す。", '',
            f"初回費を除いた再利用6件だけでは{r['total_tokens']:,}トークン、{r['machine_ms']/1000:.2f}秒、{r['api_equivalent_usd']:.7f} USD（変化: トークン{v['total_tokens']:+.2f}%、時間{v['machine_ms']:+.2f}%）。", '',
            '| 課題 | トークン変化（初回費込み） | 時間変化 | 必須品質 |','|---|---:|---:|---|']
        for p in report['pairs']:
            lines.append(f"| {p['case']} | {p['change_pct']['total_tokens']:+.2f}% | {p['change_pct']['machine_ms']:+.2f}% | {'合格' if p['same_core_quality'] and p['both_completed'] else '未達/未確認'} |")
        lines+=['', '## 人の時間：実測と推定', '',
            '新版の採否・確認時間は欠測で、人を含む削減効果は未観測。旧版の初回成果確認では完了2件が約86.84秒・9.98秒で、いずれも「判断できない」。旧版の時刻を新版の採否時間に転用しない。画面外の確認・修正時間も未記入。', '',
            f"機械時間の差は合計{combined['additional_human_time_budget_ms']/1000:.2f}秒、1課題平均{combined['additional_human_time_budget_ms']/6000:.2f}秒。この余裕より人の純増時間が大きければ、総時間は増える。", '',
            '以下は実測ではない。1課題の純増人時間＝採否＋配分した初回確認＋再利用側の成果確認・修正−記憶なし側の成果確認・修正、と仮定する。両条件に共通する確認時間は相殺する感度分析であり、総時間の削減率は算出しない。', '',
            '| 仮定した純増人時間/課題 | 6課題の正味短縮（負なら増加） |','|---|---:|']
        for seconds,saved in report['human']['estimated_net_saved_ms'].items():lines.append(f"| {seconds}秒 | {saved/1000:+.2f}秒 |")
    lines+=['', '## 費用・追跡・限界', '',
        '総トークンは入力・キャッシュ作成・キャッシュ読込・出力の4区分を合計。機械時間はホストでの検索・選択模擬・資料準備からCLI終了までを加算し、CLI内の注入・検査・操作・追跡を含む。フックや検査はCLI時間に含まれるので別加算しない。評価用DB・設定コピー、親の実装・監査、人の確認は別勘定。', '',
        f"失敗したCLI開始: {report['execution']['failed_starts']}、開始し直したCLI: {report['execution']['restarted_starts']}、ネイティブ操作の拒否: {report['execution']['denied_native_calls']}。同一CLI内の修正もそのCLIの使用量と時間へ含む。", '',
        '分析1件では「この出典には分母(n)の記載がない」という差分資料に限った記述も検査が拒否した。同じ草稿に保持節のn=10への参照があったため、親の診断では保守的な過剰拒否と判断した。モデルは同じCLI内で全体集計のn=10を参照する文へ修正して完了した。往復の正確な反実仮想費用は未測定で、当該CLI全体を費用へ含める。測定途中で検査を弱めていない。次の修正候補は、特定出典に記載がないことと、文書全体で事実が不明なことの区別（guard-diagnostics.json）。', '',
        '保持事実は元成果から完全な文を引用し、ID・ハッシュ・原文位置・対象単位を結び付ける。差分だけを生成して旧節を変更せず結合し、実行前と実ファイル生成後に検査する。独立したPython監査で引用位置とネイティブ入出力・ファイルを再照合した。モデルの原本読取へ置き換えず、派生成果を異なる知識として数えない。', '',
        '自動検査は設定場所・件数・分母・測定の存在の否定と明示的な全体件数の不一致に限定し、一般的な意味の整合性を保証しない。比較は同一利用者による実プロジェクト資料の固定課題で、選択だけを模擬した。自然な採用、複数人の実チーム利用、他課題への一般化は未観測。旧版とは原資料と初回成果が異なるので、旧版との数値差を今回の改修だけの因果効果とはしない。', '',
        '通常設定の採否は adoption.json、原文と生成時コードは originals/ と manifest.json、実ログは runs/、引用と操作の監査は audit.json、全文の確認は quality-review.json、4区分使用量と詳細集計は report.json。再集計: `python3 scripts/memory-task-coherence-report.py`（モデル起動なし）。']
    if report['adoption'].get('status')=='enabled_locally_for_consistency':
        lines+=['', '通常設定では `.local/memory-reuse/config.json` の `task_delta_consistency=on`、`task_retained_fact_max_chars=1200` を有効化した。品質保持のための採用で、初回費込みの効率改善を認定するものではない。他の設定を保持し、変更前をバックアップした。開始手順は `pnpm claude:work research|analysis|document`。']
    (ROOT/'REPORT.md').write_text('\n'.join(lines)+'\n')


def main():
    ledger=load(REPO/'artifacts/memory-reuse-loop-20261026/attempts.json');attempts=[x for x in ledger if x.get('channel')==CHANNEL];seeds=[x for x in attempts if x['phase']=='seed']
    seed_ids={r['id'] for a in seeds if a.get('success') for r in load(ROOT/'runs'/a['id']/'state.json')['created_results']}
    audits=[]
    for a in attempts:
        result=base.audit(a,seed_ids)
        if a['phase']=='comparison' and a['condition']=='improved' and a.get('success'):
            state=load(ROOT/'runs'/a['id']/'state.json');check=state['created_results'][-1].get('consistency_check')
            required={'research':{'measured_effect'},'analysis':{'sample_size','denominator'},'document':{'configuration_paths'}}[a['kind']]
            result['checks']['actual_joined_check_receipt']=check is not None and check['status']=='passed' and required.issubset(check['checked_topics']) and not check['issues'] and a['task_completion'].get('consistency_check')==check
            result['retained_quote_characters']=state['local']['retained_context']['character_count']
            result['retained_packet_bytes']=len(json.dumps(state['local']['retained_context'],ensure_ascii=False,separators=(',',':')).encode())
            result['passed']=all(result['checks'].values())
        audits.append(result)
    save(ROOT/'audit.json',audits)
    pairs=[];quality=load(ROOT/'quality-review.json',{'status':'unassessed'})
    for case in load(ROOT/'cases.json',[]):
        group={c:[a for a in attempts if a['phase']=='comparison' and a['case']==case['id'] and a['condition']==c] for c in ['none','improved']}
        if not all(group.values()):continue
        b,u=summarize(group['none']),summarize(group['improved']);creation=summarize([s for s in seeds if s['kind']==case['kind']]);allocated={k:u[k]+creation[k]/2 for k in ['total_tokens','machine_ms','api_equivalent_usd']}
        pairs.append({'case':case['id'],'kind':case['kind'],'baseline':b,'reuse_only':u,'creation_half':{k:creation[k]/2 for k in ['total_tokens','machine_ms','api_equivalent_usd']},'with_creation':allocated,'both_completed':all(any(x.get('success') for x in group[c]) for c in group),'same_core_quality':quality.get('cases',{}).get(case['id'],{}).get('passed') is True,'change_pct':base.proof.changes(allocated,b),'additional_human_time_budget_ms':b['machine_ms']-allocated['machine_ms']})
    combined=None
    if len(pairs)==6:
        b={k:sum(p['baseline'][k] for p in pairs) for k in ['total_tokens','machine_ms','api_equivalent_usd']};u={k:sum(p['with_creation'][k] for p in pairs) for k in ['total_tokens','machine_ms','api_equivalent_usd']}
        combined={'baseline':b,'reuse_with_creation_once':u,'change_pct':base.proof.changes(u,b),'same_completed_quality':all(p['both_completed'] and p['same_core_quality'] for p in pairs) and all(a['passed'] for a in audits),'additional_human_time_budget_ms':b['machine_ms']-u['machine_ms']}
    human=load(ROOT/'human-reference-snapshot.json',{})
    report={'status':'not_run' if not attempts else 'evaluation_incomplete' if len(pairs)!=6 else 'model_comparison_complete_human_effect_unobserved','cumulative_starts':len(ledger),'additional_starts':len(attempts),'approved_max_additional':18,'cumulative_cap':499,'api_cap_usd':2.00,'all_evaluation':summarize(attempts),'creation':summarize(seeds),'pairs':pairs,'combined':combined,'audit_passed':sum(x['passed'] for x in audits),'audited':len(audits),'quality':quality,'guard_coverage':'Known configuration/sample/denominator/measurement fact denials plus explicit overall sample-size conflict; not universal semantic verification. Parent review of joined output remains required.','human':{'new_version_active_ms':None,'new_version_adoption_count':None,'old_version_reference':human,'old_initial_reviews_are_not_new_adoption_time':True,'estimated_incremental_human_scenarios_seconds_per_task':[10,30,60],'scenario_definition':'Net additional human time per task, including selection, allocated initial review, and reuse final-review difference versus baseline. Assumed, not measured.'},'actual_billing_usd':None,'implementation_audit_money':None,'human_hourly_rate':None,'cloud_deployed':False,'validation':load(ROOT/'validation.json',{}),'adoption':load(ROOT/'adoption.json',{})}
    if combined:
        report['human']['estimated_net_saved_ms']={str(seconds):combined['additional_human_time_budget_ms']-6*seconds*1000 for seconds in [10,30,60]}
    comparisons=[a for a in attempts if a['phase']=='comparison']
    report['group_summary']={'baseline':summarize([a for a in comparisons if a['condition']=='none']),'reuse_only':summarize([a for a in comparisons if a['condition']=='improved'])}
    report['execution']={'failed_starts':sum(not a.get('success') for a in attempts),'restarted_starts':sum(bool(a.get('recovery_from')) for a in attempts),'denied_native_calls':sum(a['native_denied'] for a in audits)}
    completed_reuses=[load(ROOT/'runs'/a['id']/'state.json') for a in comparisons if a['condition']=='improved' and a.get('success')]
    report['reuse_counts']={'distinct_prior_results':len({s['prior']['id'] for s in completed_reuses}),'result_task_pairs':len(completed_reuses),'retained_units':sum(len(s['requested_units'])-len(s['allowed_units']) for s in completed_reuses),'original_model_memory_use_claims':0,'human_adoption_count':None,'real_team_use_count':None}
    report['usage_four_bins']={label:{k:sum(a['usage'][k] for a in group) for k in ['input_tokens','cache_creation_input_tokens','cache_read_input_tokens','output_tokens']} for label,group in [('creation',seeds),('baseline',[a for a in comparisons if a['condition']=='none']),('reuse_only',[a for a in comparisons if a['condition']=='improved'])]}
    save(ROOT/'report.json',report)
    render(report)
    print(json.dumps({k:report[k] for k in ['status','cumulative_starts','additional_starts','all_evaluation','audit_passed','audited','combined']},ensure_ascii=False))


if __name__=='__main__':main()
