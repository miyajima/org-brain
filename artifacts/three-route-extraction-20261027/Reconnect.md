# 接続済みOrgBrain MCPの再接続確認（2026-10-28）

既存接続の再接続は未完了。新runtimeからの新規MCP接続は再確認できたが、既存接続が新bundleを読み直した証拠は得られていない。抽出品質・再利用・トークン削減・時間短縮の改善は未検証。

## 確認結果

- `attempt-pilot-current` の参照先は `three-route-extraction-20261027`。CodexのOrgBrain MCP設定も、このruntimeを既存launcher経由で指定している。
- bundle SHA-256は `8931bd233c4490dd4add23b95cde4ca0a19cbfd95b863cd2e71319ddace32341`。bundle更新時刻は2026-10-28 00:06:36 JST。
- 2026-10-28 11:14 JSTのプロセス確認では、このruntimeパスを使うMCPプロセス19件、親app-serverは同一。4件はbundle更新前から起動していた。各プロセスとチャットの対応は未確認であり、現在のチャットが旧版を利用しているとは断定しない。
- 新規プロセスの隔離DBで `server/discover`、`tools/list`（49件）、読み取り専用の `orgbrain_memory_search` が成功。推論呼び出し0。この検査は終了時に自分が起動したプロセスだけを終了する。
- ホストに接続済みの `orgbrain_context_enrich` とWiki読み取りも成功した。応答成功は接続の健全性を示すが、接続中プロセスのbundle版や抽出品質を証明しない。

## 再接続を実行できなかった理由

公式app-server APIの `config/mcpServer/reload` はディスク上のMCP設定を再読込し、読み込み済みチャットの更新を予約する。`mcpServerStatus/list` はthreadId指定でそのチャットの接続を確認できる。

ただし、稼働中のデスクトップapp-serverは標準入出力接続で起動している。公式CLI `codex app-server daemon version` は既定の制御ソケットが存在せず失敗した。`codex mcp` に再接続コマンドはなく、利用可能なCodexツールにもMCP再接続操作がない。別app-serverを起動しても既存デスクトップの接続は更新されない。

CodexアプリへのComputer Useはネイティブの安全制約で拒否された。UI操作の代替手段による制約回避、既存MCPの一括終了、app-server終了は実施していない。

[公式app-server API](https://learn.chatgpt.com/docs/app-server#api-overview)

## 再開条件と再利用手順

アプリ側の正規の再接続操作、またはユーザーによるCodex再起動後に、接続済みMCPの応答とruntime読込を再確認する。MCP更新APIを使えるクライアントでは、更新要求の成功だけでなく、対象チャットの接続状態と読み取り成功まで確認する。設定ファイルの参照先変更だけでは、既存Nodeプロセスの再読込を証明できないため、この手順をruntime切替時に再利用する。

実モデルの抽出・審査・再利用評価は、既存の2026-11-01 09:10 JSTの予約を維持する。予算の増額、台帳リセット、off解除、一括有効化はしていない。今回の読み取り検査から効果量を推測しない。

## 検証資料

- `reconnect-runtime-check.json`: 現行参照先、bundleハッシュ、設定一致。
- `reconnect-process-check.json`: PID、親PID、開始時刻のみ。既存プロセスへのシグナル0。
- `reconnect-fresh-mcp-smoke.json`: 新規MCP接続の隔離検査。`existing_connections_restarted=false`。
