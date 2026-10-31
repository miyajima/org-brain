"""Audit archived native evidence and independent source constraints, without a model."""
import importlib.util,json,hashlib,math,shlex
from pathlib import Path
spec=importlib.util.spec_from_file_location('actions_eval',Path(__file__).with_name('memory-reuse-actions-eval.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
e=m.e;ROOT=m.ROOT;KEYS=['input_tokens','cache_creation_input_tokens','cache_read_input_tokens','output_tokens']
def main():
 records=e.load(m.LEDGER);runs=[x for x in records if x['channel']==m.CHANNEL];assert len(records)<=m.CAP
 checks=[];rules=e.load(ROOT/'corpus.json')['rules'];cases=e.load(ROOT/'cases.json')
 for a in runs:
  assert a['status']=='observed' and not a['hook_errors'] and a['native_arguments_match']
  assert list(a['model_usage'])==[e.MODEL] and a['argv'][a['argv'].index('--effort')+1]=='medium'
  assert e.provider_tokens(a['usage'])==a['total_tokens']
  d=ROOT/'runs'/a['id'];config=e.load(d/'config.json');s=e.load(d/'state.json');c=next(x for x in cases[str(a['revision'])] if x['id']==a['case']);assert c['records']==s['records']
  rule=rules[c['target']];expected={'target':c['target'],'mode':rule['mode'],'batch_size':rule['batch_size'],'region':rule['region'],'retain_days':rule['retain_days'],'deduplicate':True,'partitions':math.ceil(c['records']/rule['batch_size'])}
  calls=e.rows(d/'calls.jsonl');assert any(x['args'].get('op')=='apply' and x['args'].get('plan')==expected and x['result'].get('ok') and x['result'].get('applied_plan')==expected for x in calls)
  assert not any(x['args'].get('op')=='apply_artifact' for x in calls)
  base=ROOT/'runtime'/a['runtime_variant'];manifest=e.load(base/'manifest.json');assert hashlib.sha256((base/'manifest.json').read_bytes()).hexdigest()==a['runtime_manifest_sha256']
  for f,h in manifest.items():assert hashlib.sha256((base/f).read_bytes()).hexdigest()==h
  assert hashlib.sha256(e.ADAPTER.read_bytes()).hexdigest()==a['adapter_sha256']
  events=e.rows(d/'events.jsonl');native=m.m.native_calls(events,{x['tool_use_id'] for x in a['permission_denials']});native_by_id={x['id']:x for x in native}
  observed=[x for tool in native for x in m.parsed_arguments(tool['input']['command'],a['id'])]
  assert sorted(json.dumps(x,sort_keys=True) for x in observed)==sorted(json.dumps(x['args'],sort_keys=True) for x in calls)
  journal=[v for p in (d/'native-evidence').glob('*.jsonl') for v in e.rows(p)]
  assert {v['payload']['call_id'] for v in journal if v['payload']['type']=='function_call'}<=set(native_by_id)
  injected=[v['payload']['content'] for v in journal if v.get('hook_context_references')]
  if a['condition']!='none' and a['eligible']:
   delivered=[]
   for event in events:
    if event.get('subtype')=='hook_response' and event.get('hook_event')=='UserPromptSubmit' and event.get('exit_code')==0:
     value=json.loads(event.get('output') or '{}');delivered.append(value.get('hookSpecificOutput',{}).get('additionalContext',''))
   assert len(injected)==1 and any(injected[0] in x for x in delivered)
  receipts=[x for x in e.load(d/'evidence-receipts.json') if x['context_id']]
  for receipt in receipts:
   use=json.loads(receipt['observation_json']);tool=native_by_id[use['action_call_id']]
   assert use['task_id']==a['id'] and use['project_id']=='org-brain'
   if a['condition'] in ('bundled','freshness'):
    argv=shlex.split(tool['input']['command']);assert argv[2]=='run';request=json.loads(argv[3]);assert use['usage_item_id'] in request['uses']
    assert request['task_id']==a['id'] and request['adapter']=='plan'
    invocations=[e.load(p) for p in (d/'invocations').glob('*.json')];r=next(x for x in invocations if x.get('native_call_id')==tool['id'])
    assert r['request']==request and receipt['id'] in r['receipts'] and r['output']['ok'] and r['scope']['principal_id']==a['principal']
    assert config['action_adapters']['plan']['argv']==[e.NODE,str(e.ADAPTER),'api',str(ROOT),a['id']]
    if request.get('freshness_profile'):
     proof=e.load(d/'freshness/plan.json');basis=proof['basis'];canonical=json.dumps(basis,ensure_ascii=False,separators=(',',':')).encode()
     assert hashlib.sha256(canonical).hexdigest()==proof['digest']
     assert basis['input']=={'target':c['target'],'records':c['records']} and basis['scope']['principal_id']==a['principal']
     assert r['freshness_check']['fresh'] and 'applied_plan' not in proof
     for f in basis['files']:assert hashlib.sha256(Path(f['path']).read_bytes()).hexdigest()==f['sha256']
     for f in basis['environment']['dependencies']:assert hashlib.sha256(Path(f['path']).read_bytes()).hexdigest()==f['sha256']
     primes=e.rows(d/'freshness/prime-events.jsonl');fresh_checks=e.rows(d/'freshness/check-events.jsonl')
     assert len(primes)==1 and primes[0]['primed'] and primes[0]['model_calls']==0
     assert {x['phase'] for x in fresh_checks}=={'before_action','native_completion','stop'} and all(x['fresh'] for x in fresh_checks)
  messages={v['message']['id']:v['message'] for v in events if v.get('type')=='assistant' and isinstance(v.get('message'),dict)}
  assert {k:sum(x['usage'].get(k,0) for x in messages.values()) for k in KEYS[:3]}=={k:a['usage'][k] for k in KEYS[:3]}
  checks.append({'label':a['label'],'actual_model':e.MODEL,'native_calls_matched':True,'independent_meaning_check':True,'verified_uses':len(receipts),'no_fabricated_tool_calls':True})
 for stage in [1,2]:
  for c in cases[str(stage)]:
   g=[a for a in runs if a['revision']==stage and a['case']==c['id']]
   if len(g)!=3:continue
   assert len({(ROOT/'runs'/a['id']/'prompt.txt').read_text().replace(a['id'],'SESSION') for a in g})==1
   rotation=(c['id']-1)%3;assert [a['condition'] for a in sorted(g,key=lambda x:x['order'])]==m.ARMS[stage][rotation:]+m.ARMS[stage][:rotation]
 m.summarize();report=e.load(ROOT/'report.json');decisions={}
 for stage in ['1','2']:
  arms=report['stages'][stage];candidate=arms['bundled' if stage=='1' else 'freshness'];reference=arms['inline' if stage=='1' else 'bundled']
  quality=candidate['n']==10 and candidate['success']==10 and candidate['meaning_preserved']==10 and candidate['unique_knowledge']>=3 and candidate['personal_uses']>=2 and candidate['team_uses']>=2 and not candidate['ineligible_uses'] and not candidate['missing_observation_tasks']
  decisions[stage]={'quality_and_reuse_pass':quality,'lower_tokens_than_previous':candidate['total_tokens']<reference['total_tokens'] if candidate['n']==reference['n']==10 else None,'lower_tokens_than_none':candidate['total_tokens']<arms['none']['total_tokens'] if candidate['n']==arms['none']['n']==10 else None}
 report['decisions']=decisions;e.save(ROOT/'report.json',report);e.save(ROOT/'audit.json',{'checks':checks,'fixed_provider_response_replay':False,'archived_native_evidence':True,'output_tokens':'final result usage; assistant fragments are partial','decisions':decisions})
 for stage,arms in report['stages'].items():
  for name,summary in arms.items():
   g=[a for a in runs if str(a['revision'])==stage and a['condition']==name]
   summary['delivered_without_attribution_tasks']=sum((a['collection'].get('delivered',0)>0 and a['collection'].get('recorded')==0) for a in g)
   summary['freshness_checks']=sum(a.get('freshness_checks',0) for a in g)
   summary['freshness_check_ms']=sum(a.get('freshness_check_ms',0) for a in g)
   summary['freshness_prime_ms']=sum((a.get('freshness_prime') or {}).get('elapsed_ms',0) for a in g)
   summary['freshness_prime_calls']=sum(a.get('freshness_prime') is not None for a in g)
   summary['usage']={k:sum(a['usage'][k] for a in g) for k in KEYS} if g else None
 report['all_cli_tokens']=m.m.strict_total(records,'total_tokens');report['all_cli_api_equivalent_usd']=m.m.strict_total(records,'api_equivalent_usd');e.save(ROOT/'report.json',report)
 lines=['# 利用報告の同梱と最新確認の段階比較（2026-10-27）','','追加60開始・累計330開始までを承認された範囲で、改善1→改善2の順に実装と比較を行った。各段階3条件×10回、個人5/模擬チーム5、4知識に8適用機会、対象外2。段階間は別の固定入力で、段階内は同じ原本・ツール・課題・成功条件、条件順を循環。モデルはclaude-sonnet-5-5/medium。固定モデル応答や計画回答の再生はしていない。','']
 for stage in ['1','2']:
  arms=report['stages'][stage];labels=['記憶なし','現行inline','改善1・同梱'] if stage=='1' else ['記憶なし','改善1・同梱','改善2・最新確認']
  lines += [f'## 段階{stage}','','|指標|'+'|'.join(labels)+'|','|---|---:|---:|---:|']
  for label,key in [('成功','success'),('必須条件保持','meaning_preserved'),('再利用知識数','unique_knowledge'),('確認済み利用課題','use_tasks'),('個人','personal_uses'),('模擬チーム','team_uses'),('対象外誤適用','ineligible_uses'),('観測ログ欠落','missing_observation_tasks'),('提示後の未評価','delivered_without_attribution_tasks'),('総トークン','total_tokens'),('モデル応答','model_responses'),('調査呼び出し','read_calls'),('独立report','report_calls'),('同梱操作','bundled_action_calls'),('最新確認','freshness_checks')]:
   lines.append('|'+label+'|'+'|'.join(str(arms[arm][key])+('/10' if key in ('success','meaning_preserved') else '') for arm in m.ARMS[int(stage)])+'|')
  lines.append('|平均秒|'+'|'.join(f"{arms[a]['total_ms']/arms[a]['n']/1000:.3f}" if arms[a]['n'] else '未測定' for a in m.ARMS[int(stage)])+'|')
  lines.append('|API換算USD・各10回合計|'+'|'.join(f"{arms[a]['api_equivalent_usd']:.6f}" if arms[a]['n'] else '未測定' for a in m.ARMS[int(stage)])+'|')
  candidate=arms['bundled' if stage=='1' else 'freshness'];base=arms['inline' if stage=='1' else 'bundled'];none=arms['none']
  if candidate['n']==base['n']==none['n']==10:
   lines += ['',f"直前方式比: 総トークン{100*(candidate['total_tokens']/base['total_tokens']-1):+.2f}%、総時間{100*(candidate['total_ms']/base['total_ms']-1):+.2f}%、API換算{100*(candidate['api_equivalent_usd']/base['api_equivalent_usd']-1):+.2f}%。記憶なし比の総トークン{100*(candidate['total_tokens']/none['total_tokens']-1):+.2f}%。",'']
 lines += ['## 変更と採否','','改善1は、管理された操作の引数にモデルが使用する記憶IDを明示し、ホストが実PostToolUseの操作ID・出力・タスク・版・権限と照合する。実在しないreportツール呼び出しは作らず、ホストの申告記録としてcollectorへ渡す。提示だけ・申告なし・対象違い・別利用者・失効/版変更・架空IDは確認済みにしない。通常のreport APIも維持する。','', '改善2は、成功したローカル検証の入力・出典バイト/版・環境・権限・期限を照合し、一致時には原本再取得を省ける経路を作った。計画は毎回モデルが生成する。チェックは操作直前・ネイティブ完了時・Stopで行い、最新性の確認不能や変更は未検証として扱う。事前検証とハッシュ読み取りも費用に含める。','', '改善1は品質と利用を維持し、独立reportの削減を確認してローカルへ暫定導入。既存2知識に接続するプロジェクト内のNodeテスト2操作に限定し、未対応操作は従来reportを利用する。改善2は調査呼び出しの減少と追加費用の回収を確認できなかったため、通常設定で無効にした。反映と戻し方はROLLOUT.md。', '', '改善2では最新性チェックが成功してもモデルが原本を再調査した。課題の調査指示や、原本の再取得が可能なツール設計が要因候補だが、因果寄与は分離していない。比較中の指示や実装を変更せず、不利な試行も含めた。再利用の確認が通ることと、調査が減ることは別に判定する。','', '## 費用・再現・限界','',f"追加CLI開始{report['new_cli_starts']}、累計{report['cumulative_cli_starts']}。追加API換算{report['new_api_equivalent_usd']:.6f} USD、累計{report['all_cli_api_equivalent_usd']:.6f} USD。見積約1.50 USD、停止基準2.00 USD。CLIの準備・失敗も開始前に台帳へ確保し、自動再送や追加の再比較はしない。",'', '総時間は各試行の準備＋CLIであり、検索・注入・同梱/独立report・最新確認・全フック・Stopを含む。原本は既存合成知識のコピーで、今回専用に追加した作成/更新プロバイダー呼び出し0。最新確認の事前検証は決定的なローカル処理で、CLI評価に数えず準備費として別記し、総時間へ二重加算しない。ローカルのsource_bytes_readと検証回数はモデル調査回数と分ける。初回のランタイム固定や依存解決の修正時間は未分離。実請求・親Codex実装費・ローカルCPU金額・別系統のWiki保守/自動抽出費用は未取得であり、完全な金銭的ROIを主張しない。','', '実モデル評価は同じ短い合成計画課題に限る。実データをClaudeへ送っておらず、実業務のClaude自然利用・実メンバーのチーム効果は未観測。原本ID・版を再利用し、派生物を別知識として数えない。クラウド展開・コミットなし。','', '- 台帳: artifacts/memory-reuse-loop-20261026/attempts.json','- 条件と上限: PROTOCOL.md / budget-proposal.json / cases.json','- 固定実装: runtime/*/manifest.json','- 実ログと出力、実操作、receipt、照合journal、最新性proof: runs/','- 再集計・監査（モデル0）: python3 scripts/memory-reuse-actions-report.py']
 candidate=report['stages']['2']['freshness']
 lines += ['', '## ローカル検証の内訳', '', f"改善2の事前検証は{candidate['freshness_prime_calls']}回、計{candidate['freshness_prime_ms']:.3f}ms。最新確認は{candidate['freshness_checks']}回、計{candidate['freshness_check_ms']:.3f}ms。これらは準備/CLI総時間の内数で、追加モデル0。"]
 prime_bytes=sum((a.get('freshness_prime') or {}).get('source_bytes_read',0) for a in runs)
 validator_bytes=sum((a.get('freshness_prime') or {}).get('validator_source_bytes_read',0) or 0 for a in runs)
 check_bytes=sum(a.get('freshness_source_bytes_read',0) for a in runs)
 lines += [f'出典読み取りはホスト事前検証{prime_bytes}バイト、検証器{validator_bytes}バイト、最新確認{check_bytes}バイト。モデルの調査20回が減らなかったうえに加わった処理として計上する。検証器の内部読み取り量が未報告なら未取得とする。', '', '通常のNodeテスト2操作のアダプターはモデル0で実行成功を確認したが、その結果をClaude自然利用の記憶再利用には数えない。実業務向けの最新確認プロファイルは未設定。']
 (ROOT/'REPORT.md').write_text('\n'.join(lines)+'\n')
 print(json.dumps({'audited':len(checks),'cumulative':len(records),'decisions':decisions},ensure_ascii=False))
if __name__=='__main__':main()
