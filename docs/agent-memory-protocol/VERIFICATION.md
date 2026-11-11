# AMP 0.1 検証記録

確認日: 2026-11-09。対象はこのチェックアウトのローカル参照実装。稼働中の既存MCP設定の切替、クラウドへの配備、外部標準としての承認は実施していない。

## 自動テスト

`node --test scripts/agent-memory-protocol.test.mjs scripts/wiki-mcp-protocol.test.mjs scripts/wiki-memory-pipeline-intake.test.mjs scripts/wiki-preservation.test.mjs scripts/wiki-recall.test.mjs`

43件成功、0件失敗。うちAMPテストは19件（入れ子の境界試験を含む）。実装前には未実装による失敗を確認。レビュー時に追加した「件数制限時の省略数」と「用途外のCLIオプション拒否」も失敗を確認してから修正し、同じ試験の成功を確認した。

確認範囲: 条件一致/不明/不一致、例外、非active、古いhash、参照ID/版/範囲の不一致、原本切詰め、所有プロジェクトとパス範囲、直接検索、論理ID重複、出力予算、未知のフィールド、全参照の検査、CLI/MCPの経路、機能OFF。既存のWiki受付・保存・検索の対象回帰試験も含む。

## ビルドとMCP

`node scripts/build-standalone.mjs /private/tmp/orgbrain-amp-build/dist/orgbrain.mjs` が成功。依存Zodのコメント解釈と循環依存に関するRollupの警告あり。ビルド済みCLIを別プロセスのMCPサーバーとして起動し、SDKクライアントから新しい2ツールの公開と検索応答を確認した。実行時の記憶DBは一時領域、読み取り対象は設定済み個人Wiki。

結果は [mcp-smoke.json](../../examples/agent-memory-protocol/mcp-smoke.json) に保存。`orgbrain-intake-state` が先頭、条件一致、原本照合成功。`writes_performed:false`、意味検証は未実施のまま。これは常駐MCPへの更新証拠ではない。

## 個人Wikiの実データ

`amp/indexes/memory-intake.md` の検査で、下層5ページのID・保存hashと、全原本の版・SHA-256・行範囲が一致。`valid:true`、`gaps:[]`。実行報告は報告として扱い、実装からの推論と分離した。

`path_prefix:"amp/"`, `token_budget:4000`で次の5問を検索し、先頭が想定したメモリと一致した。

| 質問 | 先頭のメモリ | 主なfacts |
|---|---|---|
| 起動したら記憶は使える？ | orgbrain-intake-state | runtime=local |
| Stop から共通抽出に入る条件は？ | orgbrain-stop-intake | runtime=local、抽出on、local取込true、学習eager、完了ターンあり |
| 分類自動保存は検証済み？ | orgbrain-classified-save | runtime=local、classified_auto_save=true、source_changed=false |
| Wikiの保存でキューに入る？ | orgbrain-wiki-intake | runtime=local、route=wiki_mcp、projectあり、hash一致 |
| Cursorの実セッションでどこまで確認できた？ | orgbrain-cursor-stop-report | client=Cursor、experiment_date=2026-10-19 |

すべて複数候補があり、予算による省略で`truncated:true`。先頭一致は回答の網羅性ではない。今回の5メモリを作成した上で選んだ例示質問であり、未知の質問による独立評価・従来方式との品質比較・作業時間の削減測定ではない。一般的な精度の百分率として報告しない。
