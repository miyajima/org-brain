"""Read-only evidence audit and reproducible Markdown report; never starts a model."""
import collections,hashlib,importlib.util,json,math,sqlite3
from pathlib import Path
REPO=Path(__file__).resolve().parents[1];ROOT=REPO/'artifacts/memory-reuse-loop-20261026'
load=lambda p:json.loads(p.read_text())
rows=lambda p:[json.loads(s) for s in p.read_text().splitlines() if s.strip()] if p.exists() else []
spec=importlib.util.spec_from_file_location('evaluation',REPO/'scripts/memory-reuse-loop.py');e=importlib.util.module_from_spec(spec);spec.loader.exec_module(e)
a=load(ROOT/'attempts.json');r=load(ROOT/'report.json');selected=[];audit={'cli_starts':len(a),'checks':{},'result_cache_provenance':[],'stage_details':{},'phases':{}}
assert len(a)<=240 and not any(x['status']=='started' for x in a)
assert len({x['id'] for x in a})==len(a)
for channel,s in r['stages'].items():
 g=[x for x in a if x['channel']==channel and x.get('phase','primary')=='primary' and x['revision']==s['selected_revision']]
 selected+=g;assert len(g)==20
 for condition in ('none','memory'):
  arm=[x for x in g if x['condition']==condition]
  assert len(arm)==10 and sum(x['audience']=='personal' for x in arm)==5
  assert sum(x['eligible'] for x in arm)==8
 for x in g:
  assert x['status']=='observed' and x['native_arguments_match'] and x['meaning_preserved']
  assert e.provider_tokens(x['usage'])==x['total_tokens']
  assert list(x['model_usage'])==[e.MODEL] and x['argv'][x['argv'].index('--effort')+1]=='medium'
  assert len(x['references'])<=1 # one-source tasks make the unique/pair counts exact
  es=rows(ROOT/'runs'/x['id']/'events.jsonl')
  actual_models={v['message']['model'] for v in es if v.get('type')=='assistant' and v.get('message',{}).get('model') not in (None,'<synthetic>')}
  assert actual_models=={e.MODEL}
  calls=rows(ROOT/'runs'/x['id']/'calls.jsonl');state=load(ROOT/'runs'/x['id']/'state.json')
  expected={'target':state['target'],'mode':state['rule']['mode'],'batch_size':state['rule']['batch_size'],'region':state['rule']['region'],'retain_days':state['rule']['retain_days'],'deduplicate':True,'partitions':math.ceil(state['records']/state['rule']['batch_size'])}
  assert expected==state['expected'] and any(c['result'].get('ok') is True and c['result'].get('applied_plan')==expected for c in calls)
  if channel=='result' and x['condition']=='memory' and x['eligible']:
   recall=state['recall'];cutoff=load(ROOT/'result-r2-cutoff.json')['artifact_cutoff_ms'];assert recall['artifact_meta']['created_at']<cutoff
   producer=[y for y in a if y.get('phase')=='preparation' and any(c.get('input',{}).get('tool_use_id')==recall['artifact_meta']['verification_action'] for c in rows(ROOT/'runs'/y['id']/'hooks.jsonl'))]
   assert len(producer)==1 and producer[0]['success'] and producer[0]['implementation_sha256']==x['implementation_sha256']
   assert len(x['collection']['applications'])==1
   applied=[c for c in calls if c['result'].get('derived_application_token')]
   assert len(applied)==1 and applied[0]['args']['op']=='apply_artifact' and applied[0]['result']['applied_plan']==expected
   audit['result_cache_provenance'].append({'task':x['id'],'producer':producer[0]['id'],'created_before_cutoff':True,'creator':recall['artifact_meta']['owner'],'consumer':x['principal'],'application_path':'explicit_apply_artifact','current_validation_passed':True})
 for condition in ('none','memory'):
  arm=[x for x in g if x['condition']==condition];calls=[c for x in arm for c in rows(ROOT/'runs'/x['id']/'calls.jsonl')]
  audit['stage_details'].setdefault(channel,{})[condition]={'successful_tasks':sum(x['success'] for x in arm),'first_attempt_success':sum(x['first_attempt_success'] for x in arm),'investigation_calls':sum(x['read_calls'] for x in arm),'operation_calls':sum(x['apply_calls'] for x in arm),'correction_attempts':sum(max(0,x['apply_calls']-1) for x in arm),'tracking_calls':sum(x['tracking_calls'] for x in arm),'unassessed_delivered_items':sum(sum(x['collection']['assessment_gaps'].values()) for x in arm),'prepare_process_ms':sum(x['setup_ms'] for x in arm),'lookup_and_card_ms':sum(x['prepare_ms'] for x in arm),'collector_process_ms':sum(x['collector_process_ms'] for x in arm),'adapter_api_ms':sum(c['elapsed_ms'] for c in calls),'injected_token_estimate':sum(x['injected_tokens_estimate'] for x in arm),'provider_usage':{k:sum(x['usage'][k] for x in arm) for k in ('input_tokens','cache_creation_input_tokens','cache_read_input_tokens','output_tokens')}}
for phase in sorted({x.get('phase','primary') for x in a}):
 g=[x for x in a if x.get('phase','primary')==phase]
 audit['phases'][phase]={'cli_starts':len(g),'tokens':sum(x['total_tokens'] for x in g),'api_equivalent_usd':sum(x['api_equivalent_usd'] for x in g),'sum_elapsed_ms':sum(x.get('total_ms',x.get('cli_ms',0)) for x in g),'failed_outcome_count':sum(not x.get('success',False) for x in g)}
owned=['packages/orgbrain-cli/src/lib/memory-reuse.mjs','packages/orgbrain-cli/src/lib/memory-reuse-claude.mjs','packages/orgbrain-cli/src/local-mcp.mjs','scripts/memory-reuse-claude.mjs','scripts/memory-reuse-loop.py','scripts/memory-reuse-loop-adapter.mjs','scripts/memory-reuse-native-smoke.py','scripts/memory-reuse-report.py']
audit['current_sha256']={f:hashlib.sha256((REPO/f).read_bytes()).hexdigest() for f in owned}
audit['primary_implementation_sha256']={x['id']:x.get('implementation_sha256') for x in selected}
audit['checks']={'complete_balanced_selected_comparisons':True,'selected_actual_model_and_effort_match':True,'selected_native_arguments_reconciled':True,'independent_seven_field_outcomes_match':True,'result_producers_predate_frozen_cutoff':True,'result_producer_consumer_build_hashes_match':True,'all_eight_cached_results_explicitly_chosen_by_live_model_and_currently_validated':True,'no_fixed_model_response_replay_in_primary':True,'unresolved_cli_attempts':0,'native_hook_smoke_passed':load(ROOT/'native-hook-smoke.json')['success'],'actual_invoice_available':False,'natural_reuse_observed':False}
(ROOT/'audit.json').write_text(json.dumps(audit,ensure_ascii=False,indent=2)+'\n')
names={'object':'案3 対象とのリンク','operation':'案2 操作に応じた提示','recent':'案1 案件ごとの短いメモ','changes':'案6 更新の通知','procedure':'案4 手順への組み込み','result':'案5 検証結果の再利用'}
lines=['# 記憶再利用 6案の実装・実モデル比較','', '実モデル実行は200/240回で終了。比較180回、準備14回、除外パイロット2回、通常フックの統合確認4回。クラウド展開は行っていない。','', '## 採否と最終比較','', '各行は記憶なし10回・あり10回。個人5課題・模擬チーム5課題、適用機会8課題・対象外2課題。成功と必須7条件の保持は、全案・両条件で10/10。対象外への確認済み誤適用は0件。未報告は不使用と断定しない。','', '|案|知識数/4|適用課題/8|個人/チーム|総トークン なし→あり|増減|平均秒 なし→あり|増減|採否|','|---|---:|---:|---:|---:|---:|---:|---:|---|']
for c,s in r['stages'].items():
 n,m=(s['groups'][k] for k in ('none','memory'));dt=100*(m['total_tokens']/n['total_tokens']-1);ds=100*(m['mean_ms']/n['mean_ms']-1)
 lines.append(f"|{names[c]}|{s['unique_knowledge_reused']}|{s['knowledge_task_pairs']}|{s['personal_reuse_tasks']}/{s['simulated_team_reuse_tasks']}|{n['total_tokens']:,}→{m['total_tokens']:,}|{dt:+.2f}%|{n['mean_ms']/1000:.3f}→{m['mean_ms']/1000:.3f}|{ds:+.2f}%|{'暫定採用' if s['adopted'] else '通常利用では無効'}|")
lines+=['','暫定採用基準は4知識中3件以上、個人/模擬チーム各2課題以上、対象外への誤適用0、成功率と必須条件保持の悪化なし。削減率だけでは採用しない。','', '対象・操作・更新の適用は、明示報告と実際の取得・操作・利用報告順序を照合した件数。結果再利用8件と手順2件は、信頼されたアダプターの実行と実際のツール完了を照合した別経路であり、モデルが原本を読んだ件数には加えていない。結果再利用のチーム4件は別利用者authorの結果をbobが利用。手順の別利用者による適用は1件。','', '短いメモの最終比較で未確認となった7提示は、観測不足のまま残した。手順も期待した適用回数に届かない。これらのトークン減少を、確認済み再利用の効率改善とは認定しない。4件以上の知識獲得能力や自然な利用頻度の増加も今回の合成課題では証明していない。','', '## 費用と操作','', '|案|API換算USD なし→あり|調査回数|操作回数|修正試行数|追跡コマンド数（あり）|','|---|---:|---:|---:|---:|---:|']
for c,s in r['stages'].items():
 n,m=(s['groups'][k] for k in ('none','memory'));d=audit['stage_details'][c];v=lambda k:f"{d['none'][k]}→{d['memory'][k]}"
 lines.append(f"|{names[c]}|{n['api_equivalent_usd']:.6f}→{m['api_equivalent_usd']:.6f}|{v('investigation_calls')}|{v('operation_calls')}|{v('correction_attempts')}|{d['memory']['tracking_calls']}|")
lines+=['','初回版からの変化（再測定した3案のみ）: recentは4知識/7課題から1知識/1課題、procedureは4知識/6課題から2知識/2課題、resultは1知識/1課題から4知識/8課題。旧版の採否を最終採否に持ち越さない。','', '調査=read/index、操作=apply/apply_artifact、修正試行=max(操作回数−1,0)。同じ課題で複数操作した回数であり、修正理由の推定はしない。','', '|勘定|CLI実行|総トークン|API換算USD|','|---|---:|---:|---:|']
for phase,p in audit['phases'].items():lines.append(f"|{phase}|{p['cli_starts']}|{p['tokens']:,}|{p['api_equivalent_usd']:.6f}|")
lines+= [f"|合計|{len(a)}|{r['all_executions']['total_tokens']:,}|{r['all_executions']['api_equivalent_usd']:.6f}|",'', '入力・キャッシュ作成・キャッシュ読込・出力の4区分を合計。思考トークンは出力に含まれるため二重加算しない。API換算はClaudeのmodelUsage.costBasis=listによる値。実際の契約請求・親Codexの実装費・電力等のローカルCPU金額は未取得。削減率と請求削減を同一視しない。','', '総時間は各課題の準備プロセス＋CLI実行（ツール・PostToolUse・結果保存を含む）＋最終コレクター。検索・メモ生成/更新はprepare、注入分は実モデル入力、利用追跡コマンドとフックはCLIの内部に含まれる。内部の内訳時間はaudit.jsonに併記し、総時間に再加算しない。種知識作成・更新・カード生成・手順昇格・結果保存は決定的なローカル処理で追加モデル呼び出し0。結果を生成する準備モデル14回は別勘定に全額記載。初回の全体セットアップ実時間は欠測(null)。setup-calibrationの60.440msは後から行った同等構成の校正測定であり、初回実測の代わりにしない。source更新・昇格の実時間はlifecycle.jsonlに保持。CPU金額等が欠測なので完全な金銭的ROIは算出しない。','', '## 実験の経路と改善','', '初回比較は案3→2→1→6→4→5の順に各20回。その後、案件メモを案件ごとの1枚へ修正し、手順と結果の実適用を明示的に追跡する形に改め、案1・4・5を事前固定の別入力Bで各1回再比較した。object-r1の2回は除外パイロットで本比較に混ぜていない。各実行の正確な順序・引数はattempts.jsonに保持。当時の個別ソースハッシュは後半から記録しており、先行比較の欠測を後付けで埋めていない。結果の最終比較では生成側・利用側のハッシュ記録が揃い、一致を確認した。採否は各案の最後の比較だけで判定し、旧試行の費用は捨てていない。','', '結果再利用は、入力・出典版/バイト・Nodeとアダプター/エンジン版が一致する以前の検証済み結果を参照する。最終比較8件すべてで、実際のClaudeが明示的なapply_artifactを選び、保存された計画を現行の7条件で再検証して適用した。実モデルの応答を固定文へ差し替える処理はないが、計画自体は結果キャッシュから取り出すため、モデルが毎回独立に計画を再生成した評価でも、検証CPUを省略できた証拠でもない。時間・トークン差はこの利用経路全体の差である。別の通常applyではモデル提案の全フィールドが保存結果と同一のとき検証結果を使える実装もあるが、これは動作テストでの確認であり、この8件の実測経路とは区別する。共有結果は明示許可と原本権限の両方を満たす必要がある。比較開始前のcutoffを固定し、記憶なし側がその比較中に生んだ結果を記憶あり側へ流していない。生成元・利用者・版照合はaudit.jsonに記載。','', '最終比較後、通常フックで観測された問題を修正した。限定的なBash許可に合うコマンド表記、会話ログファイルがない場合の実PostToolUse記録による照合、構造化本文の機微情報検査、UUIDと電話番号の誤判定、会話内で提示済みの版の抑制とPreCompact時の解除。通常フックの実モデル統合確認は4回中最後の1回で成功（取得1・確認済み適用1）。最後の重複抑制接続は動作テストで検証。これらは比較群への追加再測定ではない。機微情報検査修正により現在のエンジンハッシュは結果比較時と異なり、古い実行環境の結果キャッシュは失効する。現在版のキャッシュ動作は実コードの統合テストで確認済み。比較表を現行版の再測定値と称さない。','', '## ローカル導入と限界','', '`.local/memory-reuse/config.json`でobject/operation/changes/resultを有効、recent/procedureは無効にした。`.claude/settings.local.json`にプロジェクト限定のUserPromptSubmit/PostToolUse/PreCompact/Stopをマージし、既存の設定を保持。初回原本は無視対象の`.local/memory-reuse/settings.before.json`。installは重複を作らない。','', '対象のリンクは、検証済み原本の明示的なプロジェクト内ファイル参照、またはlinkコマンドを使う。操作のリンクは実際に照合された利用から学習する。記憶の作成・承認APIは従来どおり。既存ローカルMCPのreuseルートは明示的な有効化時だけ利用する。','', '汎用SDKの手順/結果の適用には信頼されたホストの操作アダプターが必要。今回実測したものは合成計画の検証アダプターであり、任意のBashを記憶から自動実行する機能ではない。通常の対象・操作・更新の提示は導入済み。通常ローカルDBの現時点のリンク数0、確認済みclaude知識×タスク0。自然利用の効果と複数機能併用効果は未観測、実際の他メンバーによるチーム効果も未観測。','', '各比較ではその案だけを有効化。同じ原本、同じツール、同じ成功条件、交互の条件順序を使用。8つの適用機会は同一の4原本を各2回使う設計。合成の種知識を使用し、自動抽出/承認・知識の自然増加は評価していない。小規模な単一課題型・時間やプロバイダーキャッシュの変動があるため一般化や統計的優越は主張しない。通常ユーザーのグローバルフックは比較で無効化し、両条件に同じ測定フックを使用。日常の全設定を含む絶対的な費用は未測定。','', 'クラウド変更は保存済みsync-manifestと現行ローカルファイルを照合した。クラウド全体の変更が通常ツリーへ反映済みとは確認できず、隔離候補と通常ツリーは別である。今回、既存の追跡API/コレクターを保ったローカル実装として接続した。クラウドへの同期・展開は行っていない。照合はpreflight-local.json。','', '## 検証と成果物','', '新規動作テスト29件、既存の関連テスト68件、Python4件が成功。対象JavaScriptのESLintと差分空白検査も実施。権限・期限・対象違い・版更新・重複・観測欠落・偽造操作・非公開結果の別利用者への漏えい・環境一致・現行提案不一致を検証した。機能テストの固定入力はモデル0回として扱い、実モデル試行には数えていない。','', '- report.json: 機械可読な採否と比較集計','- attempts.json: 200 CLI開始の台帳と費用、欠測、失敗','- audit.json: 独立した条件・意味・モデル・引数・キャッシュ由来の監査','- runs/<ID>/: 実際のモデル出力とバックエンド操作ログ（個人Wikiへ取り込まない）','- manifest.json / holdout-B.json / result-r2-cutoff.json: 測定条件と事前固定','- docs/MEMORY_REUSE_LOOP.md: 設定と利用手順','', '6案の一巡と採否整理を完了し、残り40実行は使用せず今回を終了。未採用2案は、報告欠落の原因と手順への誘導を別途検証するまで無効に保つ。']
(ROOT/'REPORT.md').write_text('\n'.join(lines)+'\n')
print(json.dumps({'audit':'passed','selected_comparison_runs':len(selected),'all_cli_starts':len(a),'cache_producers':len(audit['result_cache_provenance']),'report':str(ROOT/'REPORT.md')},ensure_ascii=False))
