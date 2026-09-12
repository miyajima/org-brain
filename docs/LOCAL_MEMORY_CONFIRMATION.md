# Codexのローカル保存確認

2026-09-12。グローバルのAstra Harnessを変更せず、既存のUserPromptSubmit hookが接続先に合った確認手順を渡す。ローカルMCPにreview_context、回答検証、confirmation_statusと永続受領記録を追加した。

## 有効な動作

1. 作業中の証拠とobserveから、Stopが再利用候補をローカルに蓄積する。
2. 同じセッションの次の実質的な入力で、hookが保存確認を提案する。
3. エージェントが作業の区切りで質問し、実際の回答を待つ。
4. 「保存する」または明示的な修正回答の後、ローカルMCPが記憶と受領記録を同一SQLiteトランザクションで保存する。
5. 以降のローカル検索で記憶を再利用できる。

質問は毎回ではなく、対象候補がある場合に一セッション最大一バッチ、最大3件。保存しない・未決定・曖昧な回答では記憶を保存しない。質問ツールの受付だけでも保存しない。保存結果が不明なら同じtokenのstatusを読み、同じ確認の再送には同じ受領記録を返す。回答の変更は新しい提案が必要。

## この環境に適用した設定

- CodexのOrgBrain MCPと7つのhookは、最新版のローカルCLIを実行する。
- DBは `~/.org-brain/memory.sqlite`、スキーマ27。更新前のDBバックアップを保持する。
- OrgBrainプロジェクトとそこから派生したworktreeは `memory_learning_mode=confirm`、`default_work_type=implementation`。
- 明示的にOFFにしたworkspaceは維持する。未登録の別プロジェクトを一括で有効にはしない。
- 利用履歴収集・文脈検索・C順位補正はON、Cloud同期はOFF。Cloudの既存記憶はコピーしない。

CodexがローカルMCPの設定と新しいツール一覧を読み込む必要がある。既に開いているセッションのツールが切り替わったことは、この検証では証明していない。確認ツールが見えなければ候補を保留し、別の保存経路へ勝手に切り替えない。

## 検証

`local-memory-confirmation-flow.test.mjs` の実行では、実際のhookサブプロセス、strict MCP接続、プロセス再起動を使用した。通信は失敗するsentinelに置き換え、その呼び出しが0回であることを検証。質問回答は試験fixtureであり、人が実際のCodex画面で質問を受けた証拠とは区別する。

- インストール済みCLIでStop → 次のprompt → 提案 → 質問受付 → 回答 → 保存 → status → 再検索が成功。
- 修正・拒否・未決定・曖昧な承認・別tenantの参照・回答変更の拒否・同一確認の再送を検証。
- LocalMemoryStore／prompt hook／schema parityの40件、MCP／確認ライフサイクル／C CLIの9件、Stop bridgeの43件が成功。
- 保存された日本語の方針は日本語の質問で再検索できた。英単語単独の部分検索（このfixtureのOAuth）では見つからず、任意の検索語の再現率改善は主張しない。

配布物 `.local/releases/local-confirmation-v27-final/orgbrain-0.1.0.tgz`

SHA-256: `4a463cc8ac7dc63949554554f3608c27aebdd5e40ecc71532630ab427dad49c2`

インストール済み `dist/orgbrain.mjs` SHA-256: `0e45000bc9c741929183d496ee835284692e47f2d8a683320e57b5e908e25c71`
