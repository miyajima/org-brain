# Jev によるローカル記憶選別

抽出候補の将来の再利用性と、検索候補の今回の適用可能性を別々に評価する。既定は両方 `off`。Cloud 接続・追加学習・抽出モデル変更は含まない。

## 契約

- 共通処理: `packages/shared/src/memory-judgment-runtime.mjs`。OpenRouter Decisions API、`typesafe/jev-1.13`、5 秒、再試行なし。応答モデルも記録する。
- 候補本文・根拠・条件は組として扱う。候補 ID ごとの独立した質問を一括送信し、コードが retain/review/omit に変換する。上限 50 候補・28,000 bytes を超えたら原文を切らず既存経路へ戻す。
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

```sh
pnpm memory:judgment:queue status --project org-brain
pnpm memory:judgment:queue drain --project org-brain
pnpm memory:judgment:queue recover --project org-brain --id HELD_JOB_ID
```

recover は整合性・期限を検査し、既存保存経路を復元する。Jev は再呼び出ししない。processing の復旧は 5 分経過後のみ可能。外部キーによる既存の重複防止を使う。

## 評価

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
