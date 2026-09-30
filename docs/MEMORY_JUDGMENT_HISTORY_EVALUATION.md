# 過去セッションの記憶選択再評価

`scripts/memory-judgment-history-evaluate.mjs` は、Codexの過去ログから当時の検索引数と返却された記憶を復元し、現在のJevによる選択予測を確認する。親モデルを使った実タスクの2条件比較ではなく、active資格は発行しない。

```sh
node scripts/memory-judgment-history-evaluate.mjs \
  --project org-brain --limit 100 \
  --exclude-session CURRENT_SESSION_ID \
  --out .local/history-evaluation-NEW
```

既定ではAPIを呼ばない。新しい出力ディレクトリを使い、必要なときだけ `--live` を追加する。`OPENROUTER_API_KEY` のある環境では、Jevのshadow予測を1件の検索結果の判定全体5秒という既存制限で取得する。親モデルの再実行、記憶DBへの書込み、過去コマンドの実行は行わない。Jevの比較用料金0という仮定と、プロバイダー実料金は別に扱う。

対象は指定プロジェクトと同名のcwdを持つ、`source=vscode` のルートセッション。子エージェント・execバッチ・稼働中の指定セッションを除外する。`--sessions-root` でログ置き場を指定できる。動的な検索引数、未対応のCLI構文、返却本文が不完全な結果は推測で補わない。周辺のユーザー発言を検索文の代わりに使わず、判別できるUX監査の合成データも除外する。空の検索結果には判定APIを使わない。復元可能な検索を会話あたり1件、判定前に選ぶ。

`manifest.json` は元ログのハッシュ・復元件数、`cases.private.json` は当時の検索入力と記憶本文、`judgments.json` は本文を除いた予測、`report.json` は集計を保持する。ディレクトリは0700、ファイルは0600。privateファイルをWikiや公開資料へ取り込まない。構造化された返却ログの復元件数は、すべての実検索件数ではない。

2026-09-30の調査では72セッションから61返却ログを復元した。54件は空、5件は合成監査データ、1件は検索引数を復元できず、実データの1会話・1記憶のみを再評価した。Jevは根拠不足でreview、除外提案は0だった。実タスクの成功、必要記憶の欠落、誤適用、全体費用、追加遅延p95は未測定。開始状態、事前の成功条件、同条件のbaseline/jev成果物・検証・全体費用をそろえた20以上の独立した保留会話が、別途必要になる。既存の資格条件は維持する。

検証:

```sh
node --test scripts/memory-judgment-history-evaluate.test.mjs \
  scripts/memory-judgment-cost.test.mjs \
  scripts/memory-judgment-evaluation.test.mjs
```

関連28テストが成功。テストは原文・検索引数の復元、子セッション・合成データの除外、不明費用の保持、履歴予測から資格を作らないことを検証する。テスト成功はJevの実タスク品質を示すものではない。
