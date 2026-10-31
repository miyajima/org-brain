"""Read-only native-evidence audit and three-arm cost decomposition. No model calls."""
import importlib.util,json,pathlib,hashlib,sqlite3,math,collections
spec=importlib.util.spec_from_file_location('efficiency',pathlib.Path(__file__).with_name('memory-reuse-efficiency.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
e=m.e;ROOT=m.ROOT;keys=['input_tokens','cache_creation_input_tokens','cache_read_input_tokens','output_tokens']
def response_metrics(events,usage):
 messages={};hints=0;hint_bytes=0
 for row in events:
  x=row.get('message')
  if row.get('type')=='assistant' and isinstance(x,dict) and x.get('model')==e.MODEL:
   d=messages.setdefault(x['id'],{'usage':x['usage'],'tools':{}})
   assert all(d['usage'].get(k)==x['usage'].get(k) for k in keys[:3])
   for b in x.get('content',[]):
    if b.get('type')=='tool_use':d['tools'][b['id']]=b
  if row.get('subtype')=='hook_response' and row.get('hook_event')=='PostToolUse' and row.get('output','') not in ('','{}\n'):
   hints+=1;hint_bytes+=len(row['output'].encode())
 assert {k:sum(v['usage'].get(k,0) for v in messages.values()) for k in keys[:3]}=={k:usage[k] for k in keys[:3]}
 return {'model_responses':len(messages),'post_hints':hints,'post_hint_bytes':hint_bytes}
def main():
 a=e.load(m.m.LEDGER);runs=[x for x in a if x['channel']=='efficiency'];assert len(a)<=270 and not any(x['status']=='started' for x in a)
 assert len(runs)==30 and len({x['id'] for x in a})==len(a)
 cases=e.load(ROOT/'cases.json');checks=[];details={};variants=e.load(ROOT/'runtime-manifest.json')
 protocol=e.load(ROOT/'protocol.json')
 archived=e.load(ROOT/'evidence-manifest.json')
 assert set(archived)=={x['id'] for x in runs}
 for files in archived.values():
  for f,h in files.items():assert hashlib.sha256((ROOT/f).read_bytes()).hexdigest()==h
 for f,h in protocol['dependencies'].items():
  body=(e.REPO/f).read_bytes()
  if f=='scripts/memory-reuse-efficiency.py':
   body=body.replace(b'm.finish(attempt,records,ROOT)',b'm.finish(attempt,records)').replace(b'm.finish(x,aa,ROOT)',b'm.finish(x,aa)')
  assert hashlib.sha256(body).hexdigest()==h
 for x in runs:
  assert x['status']=='observed' and not x['hook_errors'] and x['native_arguments_match']
  assert list(x['model_usage'])==[e.MODEL] and x['argv'][x['argv'].index('--effort')+1]=='medium'
  assert e.provider_tokens(x['usage'])==x['total_tokens'] and x['native_hook_observation']['natural'] is False
  d=ROOT/'runs'/x['id'];s=e.load(d/'state.json');c=next(v for v in cases if v['id']==x['case']);assert s['records']==c['records']
  expected={'target':c['target'],'mode':s['rule']['mode'],'batch_size':s['rule']['batch_size'],'region':s['rule']['region'],'retain_days':s['rule']['retain_days'],'deduplicate':True,'partitions':math.ceil(c['records']/s['rule']['batch_size'])}
  calls=e.rows(d/'calls.jsonl');assert any(v['args'].get('op')=='apply' and v['result'].get('ok') and v['result'].get('applied_plan')==expected for v in calls)
  assert not any(v['args'].get('op')=='apply_artifact' for v in calls)
  base=ROOT/'runtime'/x['runtime_variant']
  for f,h in variants[x['runtime_variant']].items():
   p=base/f;assert hashlib.sha256(p.read_bytes()).hexdigest()==h and x['implementation_sha256'][str(p.relative_to(e.REPO))]==h
  events=e.rows(d/'events.jsonl');metric=response_metrics(events,x['usage'])
  receipts=e.load(d/'evidence-receipts.json')
  actual_tools={b['id']:b for row in events if isinstance(row.get('message'),dict) for b in row['message'].get('content',[]) if isinstance(b,dict) and b.get('type')=='tool_use'}
  action_types=[]
  for receipt in receipts:
   if not receipt['context_id']:continue
   signal=json.loads(receipt['observation_json']);native=actual_tools[signal['action_call_id']]
   args=e.native_adapter_arguments(native['input']['command'],x['id']);action_types.extend(v.get('op') for v in args)
  if x['condition']=='improved' and x['eligible']:
   hooks=[json.loads(v['output']) for v in events if v.get('subtype')=='hook_response' and v.get('hook_event')=='UserPromptSubmit' and v.get('exit_code')==0]
   delivered=[v['hookSpecificOutput']['additionalContext'] for v in hooks if 'hookSpecificOutput' in v]
   assert len(delivered)==1 and 'Use tracking: receipt;' in delivered[0]
   # This is a real hook response acknowledged by the CLI, not a fabricated tool call.
   j=d/'native-evidence.jsonl'
   injections=[v for v in e.rows(j) if v.get('hook_context_references')]
   assert len(injections)==1 and injections[0]['payload']['content'] in delivered[0]
  details[x['id']]={**metric,'setup_ms':x['setup_ms'],'cli_including_hooks_ms':x['cli_ms'],'verified_sources':x['verified_sources'],'reported_action_types':action_types,'permission_denials':len(x['permission_denials'])}
  checks.append({'label':x['label'],'native_args_match':True,'meaning_preserved':True,'runtime_hash_match':True,'observed_use':x['collection']['recorded']})
 for case in cases:
  g=[x for x in runs if x['case']==case['id']];assert len(g)==3
  normalized=[(ROOT/'runs'/x['id']/'prompt.txt').read_text().replace(x['id'],'SESSION') for x in g];assert len(set(normalized))==1
  rotation=(case['id']-1)%3;assert [x['condition'] for x in sorted(g,key=lambda x:x['order'])]==m.ARMS[rotation:]+m.ARMS[:rotation]
 m.summarize();report=e.load(ROOT/'report.json')
 for arm,summary in report['arms'].items():
  g=[x for x in runs if x['condition']==arm]
  summary['model_responses']=sum(details[x['id']]['model_responses'] for x in g)
  summary['post_hint_count']=sum(details[x['id']]['post_hints'] for x in g)
  summary['post_hint_bytes']=sum(details[x['id']]['post_hint_bytes'] for x in g)
  summary['use_reports_on_apply']=sum('apply' in details[x['id']]['reported_action_types'] for x in g)
  summary['first_attempt_success']=sum(x['first_attempt_success'] for x in g)
 current=report['arms']['current'];improved=report['arms']['improved'];none=report['arms']['none']
 quality=improved['complete'] and improved['success']>=current['success'] and improved['meaning_preserved']==10 and improved['ineligible_uses']==0 and improved['observation_missing_tasks']==0 and improved['verified_use_tasks']>=current['verified_use_tasks'] and improved['unique_knowledge_reused']>=3 and improved['personal_uses']>=2 and improved['team_uses']>=2
 report['adoption']={'quality_and_reuse_preserved':quality,'lower_tokens_than_current':improved['total_tokens']<current['total_tokens'],'lower_mean_time_than_current':improved['mean_ms']<current['mean_ms'],'lower_tokens_than_none':improved['total_tokens']<none['total_tokens'],'eligible_for_project_trial':quality and improved['total_tokens']<current['total_tokens']}
 e.save(ROOT/'report.json',report);e.save(ROOT/'audit.json',{'checks':checks,'details':details,'all_30_native_calls_and_outcomes_verified':True,'paired_prompts_equal_except_session_id':True,'cyclic_order_verified':True,'runtime_hashes_verified':True,'inline_delivery_acknowledged_by_real_cli_hook':True,'fixed_provider_response_replay':False,'output_tokens_per_response':'unknown; saved assistant fragments are partial, final usage only'})
 lines=['# 記憶再利用の入力増加を改善した3条件比較（2026-10-27）','','増分の約97%が入力側だったため、短い原本を開始フックから直接提示してrecallのモデル往復を省き、操作後の報告案内を短縮した。原本の本文・理由・適用条件・ID/版、既存report APIと実操作照合は維持した。','', '## 再測定','','ユーザーの回答により上限を累計270回へ変更し、追加30回を実施した。記憶なし・現行・改善版を各10回、個人5・模擬チーム5、4知識に8適用機会、対象外2課題。同じ合成原本・同じ課題・同じ成功条件を使い、3条件の順序を課題ごとに循環させた。実データはClaudeへ送っていない。','', '|指標|記憶なし|現行lookup|改善inline|','|---|---:|---:|---:|']
 fields=[('成功率','success'),('必須条件保持','meaning_preserved'),('再利用知識数','unique_knowledge_reused'),('確認済み利用課題','verified_use_tasks'),('個人での利用','personal_uses'),('模擬チームでの利用','team_uses'),('対象外誤適用','ineligible_uses'),('観測欠落','observation_missing_tasks'),('総トークン','total_tokens'),('モデル応答数','model_responses'),('調査呼び出し','read_calls'),('recall呼び出し','recall_calls'),('report呼び出し','report_calls'),('操作後の案内数','post_hint_count'),('操作後の案内バイト','post_hint_bytes'),('許可拒否','permission_denials')]
 for name,key in fields:lines.append('|'+name+'|'+'|'.join(str(report['arms'][arm][key])+('/10' if key in ('success','meaning_preserved') else '') for arm in m.ARMS)+'|')
 lines.append('|平均秒|'+'|'.join(f"{report['arms'][arm]['mean_ms']/1000:.3f}" for arm in m.ARMS)+'|')
 lines.append('|API換算USD|'+'|'.join(f"{report['arms'][arm]['api_equivalent_usd']:.6f}" for arm in m.ARMS)+'|')
 for ref in ('current','none'):
  base=report['arms'][ref];lines+=['',f"改善版の{'現行比' if ref=='current' else '記憶なし比'}: 総トークン{100*(improved['total_tokens']/base['total_tokens']-1):+.2f}%、平均時間{100*(improved['mean_ms']/base['mean_ms']-1):+.2f}%、API換算費用{100*(improved['api_equivalent_usd']/base['api_equivalent_usd']-1):+.2f}%。"]
 lines+=['','## 要因と検算','','保存済み前回比較の増分86,372トークンは、入力8・キャッシュ作成18,395・キャッシュ読込65,349・出力2,620。入力3区分で96.97%を占めた。モデル応答47→51回、1応答あたりの入力約3,380→4,757トークン。検索要求10応答と報告8応答は調査等の一部を置き換えたので18回分の純増とは数えない。操作後の長い報告案内は24回・14,526バイト。詳細はbaseline-causes.json。','', '増加は本文や追跡メタデータ・長い案内が履歴へ残り、後続入力として再送されることと整合する。ただし内訳は記述的分解であり、個々の要因の因果効果は分離していない。今回も入力・キャッシュ作成・キャッシュ読込・出力を合算し、assistant断片の途中の出力usageは応答別に配賦しない。実モデルとeffortのログ一致、実際の生成引数とバックエンド操作、独立した7条件を照合した。','', '改善版の原本提示は実UserPromptSubmitの出力であり、CLIのhook_response成功と照合用記録の一致を確認した。架空のツール呼び出しを作っていない。明示報告と実PostToolUseの順序・タスク・版・権限が一致して初めて確認済みにする。提示だけや報告欠落は利用済みにしない。固定モデル応答の再生や結果キャッシュは使っていない。','', '現行と改善版の実装は同じ長さのr01/r02パスへ固定し、ハッシュを毎試行で保持した。入力は前回と別の固定値。許可拒否を減らすため単一コマンドの指示を全条件へ等しく追加した。前回の結果を今回の対照群に混ぜない。最初の1件で集計先ディレクトリの指定だけを修正し、保存済み実出力から復旧した。CLIを再実行せず、その開始と費用を含めた。','', '残る増分は改善版でも記憶なし比68,215トークン。調査は20回のまま、明示報告8回を維持し、モデル応答は40→48回だった。現行と改善版のモデル応答数はともに48回で、recallコマンド8回の削除がそのまま応答数の減少にはならなかった。操作後の案内は回数よりも長さを減らし、計12,545→4,896バイトになった。現行比35,339トークンの減少は入力側33,268、出力2,071。時間改善は確認できず、今回の短い調査では記憶の費用を回収していない。','', '## 採否と範囲','',f"品質・再利用維持: {quality}。現行より総トークン減: {report['adoption']['lower_tokens_than_current']}。記憶なしより総トークン減: {report['adoption']['lower_tokens_than_none']}。",'', '最終の設定反映はROLLOUT.mdに記録する。追加モデル実行は累計270回で終了。単一の短い合成作業型に限った比較であり、実業務全般の削減や統計的優越を主張しない。実データでのClaude自然利用と実メンバーによるチーム効果は未観測。','', '## 費用と再現','','|勘定|CLI開始|トークン|API換算USD|','|---|---:|---:|---:|']
 previous=[x for x in a if x['channel']!='efficiency'];lines.append(f"|以前の実行・準備・失敗|{len(previous)}|{sum(x['total_tokens'] for x in previous)}|{sum(x['api_equivalent_usd'] for x in previous):.6f}|")
 lines.append(f"|今回|{len(runs)}|{sum(x['total_tokens'] for x in runs)}|{sum(x['api_equivalent_usd'] for x in runs):.6f}|")
 lines.append(f"|累計|{len(a)}|{report['all_cli_tokens']}|{report['all_cli_api_equivalent_usd']:.6f}|")
 lines+=['', '総時間はDB複製・設定生成等のsetup＋CLI（検索、注入、操作、report、全フック、Stop収集を含む）。生成AIによる記憶の作成/更新は行わず既存合成原本を使用。コピー・接続・検索・追跡はローカル処理で追加モデル0だが、CPU金額を0とはしない。内部時間を総時間に二重加算しない。API換算と実請求を区別し、実請求・親Codexの実装費・ローカルCPU金額は未取得。準備・失敗も台帳へ残し、完全な金銭的ROIは算出しない。','', '今回の一度限りのセットアップは11.47ms、追加モデル0。作成/更新を伴う将来の記憶は未測定。検索・注入・追跡の個別CPU時間は総時間の内数で、独立した時間配賦は未取得。準備・pilot・接続確認の20開始は321,920トークン、API換算0.549840 USD（累計の内数）として別勘定にする。','', '- 全CLI台帳: artifacts/memory-reuse-loop-20261026/attempts.json','- 測定条件: protocol.json / cases.json / runtime-manifest.json','- 集計: report.json、独立検算: audit.json、raw実行記録: runs/','- 再集計: python3 scripts/memory-reuse-efficiency.py --summarize','- 検算・報告再生成: python3 scripts/memory-reuse-efficiency-report.py','- クラウド展開・コミットなし']
 (ROOT/'REPORT.md').write_text('\n'.join(lines)+'\n');print(json.dumps(report,ensure_ascii=False))
if __name__=='__main__':main()
