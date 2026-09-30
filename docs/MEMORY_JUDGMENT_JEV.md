# Jev によるローカル記憶選別

抽出候補の将来の再利用性と、検索候補の今回の適用可能性を別々に評価する。既定は両方 `off`。Cloud 接続・追加学習・抽出モデル変更は含まない。

## 契約

- 共通処理: `packages/shared/src/memory-judgment-runtime.mjs`。OpenRouter Decisions API、`typesafe/jev-1.13`、5 秒、再試行なし。応答モデルも記録する。
- 候補本文・根拠・条件は組として扱う。候補 ID ごとの独立した質問を一括送信し、コードが retain/review/omit に変換する。既存quality経路は50候補・28,000 bytesを超えたら原文を切らず既存経路へ戻す。以下のcost経路は質問数とbytesで分割する。
- 訂正、明示保存、制約、未解決失敗、既知の競合は保護する。保護候補も他の候補を判断する根拠として送信する。未知の競合を検出した場合も要確認として残す。
- Stop はローカルキューへの投入まで。既存 learning candidates は通常の非同期 maintenance 内で判定し、根拠検証・確認・合議・昇格の条件は維持する。
- 利用側は検索後、top_k/投入予算前に判定する。権限・プロジェクト・期限を先に検査し、推論後にも再検査する。active では全文・条件を単位として予算内に収め、results と evidence_bundle に同じ選別を反映する。保護対象を収められないときは既存処理へ戻す。
- shadow は選別予測のみ記録する。予測を observed usefulness / 実際の利用実績に転記しない。不正応答・通信失敗・曖昧な判定で原文を破棄しない。

## 任意有効化

対象プロジェクトの明示とモード設定の両方が必要。各判断点は個別に OFF に戻せる。API キーの値はログや設定例に記載しない。

```sh
export ORGBRAIN_JEV_PROJECTS=org-brain
export ORGBRAIN_JEV_CAPTURE_MODE=shadow
export ORGBRAIN_JEV_USE_MODE=shadow
export ORGBRAIN_JEV_THRESHOLD=0.95
# OPENROUTER_API_KEY は既存の秘密管理経路で設定する
```

有効時は、必要な根拠本文を伏字化したコピーが OpenRouter に送られる。元の本文は変更しない。キャッシュには質問の回答と利用量を保存し、本文は保存しない。本文・条件・版・質問・モデル・コンテキストが変わればキャッシュは失効する。権限と期限はキャッシュとは別に毎回検査する。

ローカル DB の隣に `.jev.sqlite`（判定キャッシュと抽出キュー）、`.jev-metrics.jsonl`（本文なしの予測・費用・時間）を権限 0600 で保存する。キューの保留状態には復旧のため原文が残る。キューは 7 日後に保存対象として失効する。完了済みの期限切れ行は drain 時に削除する。保留行は自動再送しない。

## 分類・有用度・登録推奨の比較運用

追加の `memory-capture-assessment/v1` は既定 `off`。以下の設定で、capture の
既存6質問と分類・有用度の2質問を、同じリクエストで独立に評価する。
この設定例は明示的な有効化用であり、コード更新だけでは外部送信は始まらない。

```sh
export ORGBRAIN_JEV_PROJECTS=org-brain
export ORGBRAIN_JEV_CAPTURE_MODE=shadow
export ORGBRAIN_JEV_CAPTURE_ASSESSMENT_MODE=shadow
```

- `lesson_type` は Choice の `decision / success / failure / unknown`。
  根拠は候補に付属する証拠であり、4番目の学習種別ではない。
- `utility` は将来の適用条件が再び成立した場合の貢献予測。Score の4段階は、
  0: 再利用による貢献が確認できない、1: 小さな便宜・注意喚起、
  2: 具体的な再調査・手戻りを省く、3: 重大な再発や繰り返しの停滞を防ぐ。
  今の作業で不要でも、それだけで低く評価しない。
- `registration` は追加の予測であり、既存の `decision.action` を置き換えない。
  既存判定が review/omit ならその結果を維持する。retain でも分類不明・既存分類との
  不一致・有用度不明・有用度2未満なら review を推奨する。有用度だけで omit にはしない。
  閾値2と既存の confidence 閾値は比較運用の初期値であり、実データでの校正済み値ではない。
- 応答の元の確率・confidence・score を保持する。confidence が閾値未満なら分類は
  `effective_label=unknown`、有用度は `value=null`。不明を0点にしない。
- 記録するのは `capture_assessment` 内の `basis=prediction, applied=false` のみ。
  既存の lesson_type、kind、utility_score、検証状態、利用実績、保存可否を変更しない。
  保護候補は引き続き評価対象外で、他の候補の根拠としてのみ参照する。
- `use`、`active`、`off` では追加評価を実行しない。追加設定を `off` に戻せば、
  capture shadow の既存質問だけに戻る。Stop での推論も追加しない。
- 保存済み学習情報がある場合、候補アダプターは既存 lesson_type と、手順・観測結果・
  症状・原因・修正・回避条件の許可済み項目を添える。既存ラベルは正解として扱わない。
  追加情報も既存の伏字化・サイズ上限を通す。キャッシュとメトリクスに原文は残さない
  （復旧用キューの原文保持は既存契約のまま）。
- Choice/Score の型、選択肢、確率分布、confidence、score を検証する。
  不正応答は比較値を残さず既存経路へ戻り、再試行しない。未知の説明文やlegendは保存しない。

`pnpm test:memory-judgment` は追加の混在型応答、保護・保留、キャッシュ、ログ、キューの
非変更性をモックで検証する。日本語分類精度や有用性の改善は測定しない。
既存の12ケースの評価器は選別ポリシー用で、この追加評価を有効化しない。
実運用への適用には新たな人手確認済みの会話単位テストと、誤登録・重要記憶欠落・
実タスク貢献の検証が必要。コード・ポリシーハッシュ変更により旧 qualification は無効になる。

```sh
pnpm memory:judgment:queue status --project org-brain
pnpm memory:judgment:queue drain --project org-brain
pnpm memory:judgment:queue recover --project org-brain --id HELD_JOB_ID
```

recover は整合性・期限を検査し、既存保存経路を復元する。Jev は再呼び出ししない。processing の復旧は 5 分経過後のみ可能。外部キーによる既存の重複防止を使う。

## 評価

### 費用優先の経路（objective=cost）

Wikiと通常のcapture/useで、既存の判定・保存経路を共用する。
次の設定は比較運用であり、判定による除外や自動保存を有効にしない。

```sh
export ORGBRAIN_JEV_PROJECTS=org-brain
export ORGBRAIN_JEV_OBJECTIVE=cost
export ORGBRAIN_JEV_WIKI_MODE=shadow
export ORGBRAIN_JEV_CAPTURE_MODE=shadow
export ORGBRAIN_JEV_USE_MODE=shadow
export ORGBRAIN_JEV_THRESHOLD=0.95
orgbrain memory wiki assess --project-id org-brain --page wiki/topics/example.md --json
```

ローカルMCPの`orgbrain_wiki_assess`も同じ処理を呼ぶ。ページと指定された原資料だけを読み、
存在・ハッシュ・権限・期限・版をコードで検査する。Jevは種類、採用、行動と条件、
出典による支持、既存記憶との同等性・条件差・矛盾・明示修正を型付きで予測する。
6分類、最大3件の候補、必要な原文をまとめた`review_bundle`、重複しない出典抜粋を返す。
shadowでは全項目を親モデルに返す。activeでも候補・不明・修正・保護対象は親が判断し、
対話中の保存はpropose→明示確認→confirmを維持する。原資料の部分抜粋、変更、比較上限到達は保留する。

キャッシュは質問単位で、原文・条件・版・質問・モデル・コンテキストをキーにする。
incremental/contradictionは関連集合もキーに含める。集合が変わっても単体の出典質問は再利用できる。
処理中の同一質問を共有し、最大50質問・28,000 bytesで分割、同時実行2、操作全体のJev待ちを5秒に制限する。
入力や出典を上限に合わせて切って確定判定はしない。未知・時間切れ・不正応答では原文を親へ残し、失敗を自動再送しない。
検索は選別後に返却実績を記録し、audit/diagnostic/testは比較対象を除外しない。
抽出キューは同プロジェクトの最大20ジョブを一度に判断し、shadowジョブを再保存しない。

保留候補のmaintenanceは既存の外部ランナーが`runAutonomyJudgeBatch`を提供する場合、
`{action,candidates:[{id,candidate}],policy,workspace}`を一度に渡す。
返却は全IDに対応する`[{id,judgments}]`で、項目ごとに既存の根拠・署名・モデル系列・合議条件を検査する。
未対応ランナーは既存の`runAutonomyJudge`を使う。新しい親モデルプロセスや合議の免除は追加しない。

配布bundleは`node_modules/orgbrain/jev-settings.json`の許可済みORGBRAIN_JEVフラグを読み込める。
明示したプロセス環境変数が優先し、checkoutはこのファイルを読まない。認証情報のキーは受け付けない。
設定変更後の新規CLI/MCPプロセスに適用され、起動済みMCPには再接続が必要。

新しい費用評価はv2契約で、既存qualityのv1資格を変更しない。
0.80/0.90/0.95/0.98の境界は独立した開発資料で選ぶ。未校正の初期値0.95を校正済みとは報告しない。
以下は構成と評価資料を固定するだけで、モデルを呼ばず、親の成果・費用はnullのまま残す。

```sh
node scripts/memory-judgment-evaluate.mjs --objective cost --stages wiki,capture,use \
  --resolved-model typesafe/jev-1.13-20260917 --threshold 0.95 \
  --dataset /path/to/independent-dataset.json --out /path/to/new-frozen-run
node scripts/memory-judgment-evaluate.mjs --manifest /path/to/new-frozen-run/manifest.json \
  --outcomes /path/to/real-outcomes.json --out /path/to/new-qualification
```

同じ親モデル・設定・開始状態・予算のbaseline/jevの2条件を、20以上の独立した保留会話で比較する。
各観測は既存v1の成果物・テスト証拠に加え、構成hashと`cost`を持つ。
`cost.source`はproviderまたはprice_snapshot（後者はprice_snapshot_hashが必要）、
parent_usd/fallback_usd/review_usd/rework_usd/other_usdは有限の非負数とし、
jev_assumed_usd=0を比較前提にする。jev_actual_usdと実際のAPIログは別に保持する。
欠落料金は資格を満たさず、トークン削減だけで費用減としない。

項目ごとの成功退行・誤適用増加・重要記憶欠落・重大退行がなく、総費用が減り、
追加待ち時間p95が5秒以内なら、同品質でも資格を満たす。
activeにはORGBRAIN_JEV_RESOLVED_MODELと資格ファイルを設定し、
有効にする判断点の集合、閾値、モデル、実装hashが評価構成と一致することが必要。
コードや構成変更、証拠改変、モデル変更は失効する。不十分な結果はinconclusiveのまま比較運用を続ける。

寄与率と評価カバー率は実際の利用観測から算出する。予測や未評価を不寄与に変換しない。
Jev料金0は今回の比較仮定であり、実価格が無料という意味ではない。

### 継続的な振り返り

`memory-judgment-telemetry/v2` は本文を追加保存せず、判定日時・イベントID・
プロジェクト/テナントのハッシュ・候補ID/入力全体のハッシュ・ポリシー/ビルド情報を
既存の0600メトリクスへ記録する。候補入力のハッシュは後日の同一版照合用であり、
原文を復元できない。元データが消失・変更した場合は内容評価を未検証にする。

```sh
node scripts/memory-judgment-report.mjs --file /absolute/path/memory.sqlite.jev-metrics.jsonl --project org-brain --days 7 --out /absolute/path/new-report.json
```

APIを呼ばず、直近7日とその前の7日を集計する。モデル・ポリシー・ビルド・判断点が
異なるものは分離する。費用不明を0にせず、キャッシュとAPI時間を分離する。
旧ログは日時やプロジェクトを推測せず集計対象外とする。出力先は新規ファイルのみ。
判定回数と候補の異なる版の件数を区別し、食い違い・除外推奨の照合用ハッシュを最大10件出す。
ログ欠落はデータ不足であり、正常稼働や効果ゼロの証拠ではない。

保留率・分類不一致・費用は運用指標であって精度ではない。既存ラベルも正解ではない。
精度には元の同一版と人手評価、タスク改善には条件を揃えた比較と成果物が必要。
shadow中の作業成果をJevの効果とみなさず、レポートの精度・成功率改善はnullを維持する。
定期確認でも自動の閾値変更・active化・再API評価・記憶書き換えは行わない。

```sh
pnpm test:memory-judgment
pnpm memory:judgment:evaluate --dataset scripts/fixtures/memory-judgment-v1.json --out /tmp/jev-fixture-new
pnpm memory:judgment:evaluate --dataset scripts/fixtures/memory-judgment-v1.json --out /tmp/jev-live-new --live
```

出力先は新規ディレクトリのみ。既存の保留実験を変更しない。会話単位で dev/holdout を分離し、dev で 0.80/0.90/0.95/0.98 を比較してから manifest を固定する。重要記憶の欠落ゼロを優先し、誤適用が同じなら保留が多い境界を選ぶ。

同梱 12 ケースは公開の合成例であり、選別ポリシー単体の契約確認に使う。5 条件（記憶なし、現行、抽出のみ、利用のみ、両方）を再生するが、実際の検索・予算配分・親モデル実行を再現するベンチマークではない。生成前から欠けた知見は upstream_missing に分ける。成果物による成功率・再調査・確認負担をこの再生から推定しない。

実タスク比較では同じ親モデル・設定・開始状態・予算で全 5 条件を実行し、成果物とテスト結果を保存する。`--manifest FILE --outcomes FILE --out NEW_DIR` で実測結果を取り込める。outcomes は JSON 配列で、各行に以下を持つ。

- case_id / conversation_id / split=holdout / arm
- parent_model / settings_hash / start_state_hash / budget_hash
- task_success、false_application、required_memory_missing、critical_regressions
- parent_usage: input_tokens / cached_input_tokens / output_tokens、task_elapsed_ms
- verification: artifact_path / artifact_hash / test_path / test_hash（SHA-256）

テスト receipt は case_id / arm / passed / artifact_hash を持つ JSON。ファイルは outcomes と同じディレクトリ以下に置く。取り込み時と有効化時にハッシュ・対応を再検査する。確認に要した時間・トークンは親モデルとタスク全体の測定に含め、再調査・再作業・確認回数も実験成果物に記録する。Jev の費用・推論時間は judgments/report へ分離する。未測定値は null とする。

active には `ORGBRAIN_JEV_QUALIFICATION_FILE=/absolute/path/qualification.json` が必要。20 会話以上の全条件対応済み holdout、現行より成功率改善、誤適用・重要記憶欠落の非悪化、重大回帰ゼロを検査する。20 は初期の最低件数で、統計的有意性を保証する数ではない。合格した判断点のみ有効化できる。両方の併用は併用結果も合格が必要。モデル・質問・閾値・実装ファイルのハッシュが変われば再評価が必要。ソースを含まないバイナリ配布ではこの qualification は使用できず、active は既存経路へ戻る。

現時点では実タスク有用性は未確認。合成再生だけでは qualification を発行しない。

参考: [記事](https://x.com/tetumemo/status/2100908369594741046)、[fast-jev-compaction 固定版](https://github.com/tamaratran/fast-jev-compaction/tree/e3f262a7f4d42bd8dd32ced30d26176f7cb545b0)、[OpenRouter Decisions API](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request)。削減率を成功指標へ流用しない。
