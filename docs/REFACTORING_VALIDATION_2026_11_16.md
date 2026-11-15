# OrgBrain R0〜R10 リファクタリング検証記録

検証日: 2026-11-16。比較元: `2a93737197c5fec4281b0ac482ceacf3bee657fd`。
検証対象のソース最終コミット: `905e1cc07334e49b8b0616e2ed6d74cbd2cac5ba`。
作業はローカルの実装・テスト・コミットまで。push、公開、本番デプロイ、インストール済みランタイムの差し替えはしていない。

## 変更した構成

| 段階 | 結果 | 主なコミット |
| --- | --- | --- |
| R0 | 通常テストの対象漏れと既存のテストデータを修正 | `2fba4ca2` |
| R1・R2 | スキーマ、派生インデックス、レコード変換、保存処理を分離。公開ストアがトランザクションを所有 | `1fab4859`, `4fc43bad` |
| R3 | 検索処理を分離し、候補抽出時の期限切れ除外を修正 | `81555917`, `e45788d4` |
| R4 | フックの候補判定と送信・再送を分離。確認待ちの送信抑止を検証 | `6acfc84e` |
| R5 | MCP登録を用途別に分離。更新する3ツールの権限を修正 | `34dbcda8`, `68348193` |
| R6 | HTTPサービス間の型を明確化。未知の権限と不正入力を安全に拒否 | `34213007`, `9ab069ed`, `7ee343e5`, `5fcfda56` |
| R7 | Context Engineの記憶操作と応答組み立てを分離。予算で省略しても禁止判断を維持 | `a5cb6568` |
| R8 | 3Dマップ、記憶・判断フォーム、Wikiの状態と終了処理を整理。CSRF、表示、再送、未保存内容の問題も修正 | `3116d793`〜`bb73f663`（関連コミットを含む） |
| R9 | CLIの共有コード参照84か所をパッケージ経由に変更。実際の配布ファイルを検証 | `84bd2c7d` |
| R10 | 統合検証、比較、文書更新。評価スクリプトとmacOS用テストの不具合も修正 | `d6a7f7a4`, `905e1cc0`、本記録を含む文書コミット |

詳しい担当範囲と互換性の修正は [ARCHITECTURE.md](ARCHITECTURE.md#source-ownership) を参照。
R9の48ファイルは、84個のimport/export参照文字列を元に戻すと変更前の本文と完全一致した。ビルド時にファイルを読む4個の相対パスは変更していない。

## 統合検証

| 確認 | 結果と範囲 |
| --- | --- |
| `pnpm install --offline --frozen-lockfile` | 成功。ロックファイルと依存関係が一致 |
| `pnpm lint` / `pnpm typecheck` | 成功。型チェックはR9の最終TypeScript・依存関係に対する結果を再利用。その後は配布設定、JavaScriptテストと文書だけを変更し、lintを再実行 |
| `pnpm test` | 最後まで成功。Nodeテスト、MCP適合性、ルーター、スクリプト、各パッケージを含む通常経路 |
| `pnpm surface:check` / `pnpm contract:check` | 成功。公開機能と記憶契約のハッシュを確認 |
| `pnpm test:dashboard-performance` | 2件成功。既存の10万件性能基準を変更せず確認 |
| `pnpm build` → `pnpm build:wiki` → `pnpm build:standalone` | 順に成功。Cloudflareのビルドはdry-run |
| `pnpm test:wiki` | Rust 38件成功。Node 80件成功、Linux専用9件はMacでは既存条件によりスキップ |
| Consoleの通常Playwright設定 | 230件成功。既存の任意スクリーンショット2件と専用fixtureを要するTeam Knowledge 1件はスキップ |
| Wiki専用Playwright設定 | 実際の一時WikiとHTTPハンドラー、ビルド済み画面で10件成功 |
| 一時D1でのAPI smoke | 全移行を適用し成功。保存201、検索200、読取専用トークンの更新403、別テナント読取403、未認証MCP401、legal holdによる削除拒否409、削除後の検索復活0件、監査チェーン13件正常 |
| 実際のpnpm tarball | リポジトリ外に展開。ヘルプ、保存、候補検索、固定版の本文取得が成功。MCP 5件、Wiki起動・保存・読取・スキル配置の1件も成功 |

実行環境はmacOS arm64、Node 26.12.1、pnpm 10.16.1、Rust 1.99.1。
CIに設定済みのLinux/Rust 1.89.0は維持したが、この作業ではリモートCIを実行していない。実機VoiceOverや本番API、外部埋め込み・モデルを使う検索の成功を示す記録ではない。
Wikiのキャッシュ復帰テストはブラウザーイベントによる検証で、実際に戻る・進むキャッシュへ入る条件すべてを保証するものではない。

## 見つけた問題と修正

- 検索候補に期限切れの記憶が残る問題を修正し、期限の直前・ちょうど・直後と期限切れ候補が多数ある場合を検証した。
- 書き込み用MCP 3ツールのread権限、未知のfallback role、不正なHTTP本文で500になる経路を修正した。
- 応答予算で禁止方針が落ちると判定までallowになる問題、メタデータを含めると予算を超える問題、返さない項目の利用記録を修正した。
- 記憶・判断フォームのCSRF送信漏れを、実際のGatewayとproxyを通るテストで確認して修正した。APIの保護は外していない。
- 画面終了後の応答、評価の再送ID、未保存表示、狭い画面での入力欄、Wiki保存中の追加入力・無効化時の未保存内容を修正した。
- 評価スクリプトが「ホストの選択待ち」を検索失敗として0点にする問題を修正した。不完全な応答は`incomplete_retrieval`で停止し、候補を採用済みの結果へ変換しない。
- pnpmのtarballでWikiエンジンが0644となり起動に失敗する問題を再現。`publishConfig.executableFiles`で実行権限を保持し、同じ実物テストで失敗から成功へ変わることを確認した。
- macOSの`/var`リンクを含む一時パスでWikiの保護に拒否される3件を、テスト用ディレクトリーの`realpath`解決で修正した。製品のリンク拒否は維持した。

各段階で親が差分と必要性をレビューした。権限・入力・Context Engine・CSRFの変更には独立レビューも実施し、指摘された問題を修正してから次へ進んだ。純粋な移動には本文比較と前後の動作テスト、不具合には失敗する条件と修正後の同じ条件を使った。

## 検索の変更前後比較

同じMac・Node版・固定データ・設定で、比較元と変更後を測定した。有料モデルを使う比較は追加していない。速度は各版1回の測定であり、小さな差を一般的な高速化の証明とはしない。

| 指標 | 変更前 | 変更後 |
| --- | ---: | ---: |
| 10万件・200検索: 95%点の時間 | 79.97 ms | 77.68 ms |
| 同: 中央値 | 71.78 ms | 70.94 ms |
| 同: 検索失敗 | 0 | 0 |
| 同: 既存基準（95%点500 ms以内ほか） | 合格 | 合格 |
| 200課題×5回: 期待する記憶が先頭に出る率 | 90% | 90% |
| 同: recall@5 / pass^5 | 90% / 90% | 90% / 90% |
| 同: 他テナント・権限外の漏えい | 0 | 0 |
| 同: 95%点の検索時間 | 8.78 ms | 8.63 ms |
| 同: 平均応答トークン数 | 435.97 | 435.97 |

10万件の比較では`hybrid_v4`、既存のローカル縮退埋め込みを使用。スキーマ版33、データ件数、内容と派生データのダイジェストが一致した。
200課題の比較では既存設定の`ORGBRAIN_LOCAL_RELEVANCE_PROVIDER=off`、`ORGBRAIN_LOCAL_EMBEDDING_PROVIDER=off`、`ORGBRAIN_JEV_PROJECTS=''`を両版に適用した。これはホストによる選択を無効にした検索比較であり、通常のAI選択まで含む利用体験や、実際の仕事の完了率ではない。`task_completion_rate`も検索結果から計算する代理指標である。

各カテゴリーの値は両版で一致した。矛盾カテゴリー20課題は一致率0%だが、最初の課題の実応答は`evidence_status=conflicted`、`response_mode=abstain`で、矛盾する情報の採用を控えていた。この指標の0%を「誤った答えを返した」とは解釈しない。他の9カテゴリーは各100%。

再現する場合は両版で新しい一時DBを指定する。通常の個人DBを指定しない。

```sh
node packages/benchmarks/scripts/local-scale-benchmark.mjs --count 100000 --queries 200 --db <一時DB> --output <結果JSON>
ORGBRAIN_LOCAL_RELEVANCE_PROVIDER=off ORGBRAIN_LOCAL_EMBEDDING_PROVIDER=off ORGBRAIN_JEV_PROJECTS='' \
  node packages/benchmarks/scripts/competitive-memory-benchmark.mjs --adapter orgbrain-local --repeat 5 --db <別の一時DB> --output <結果JSON>
```

原結果は検証時に`/private/tmp/orgbrain-r10-{baseline,final}-scale/report.json`と`/private/tmp/orgbrain-r10-{baseline,final}-competitive-off/report.json`へ出力した。比較用DBは検証後に削除できる一時データである。

## 外部契約と残る確認範囲

DB移行ファイル、記憶スキーマと確認受領証の形式は変更していない。APIのルート一覧とツールの入出力一覧を維持した。ただし次の動作修正は意図した互換性の変更である。

- `orgbrain_attempt_record` / `orgbrain_attempt_use_record` / `orgbrain_action_preflight_feedback` はwrite scopeが必要。read-only tokenで利用していた呼び出し元は権限を取得し直す必要がある。
- 検証対象の不正本文は500から400へ変更。未知の権限は拒否する。
- 必須の空応答さえ予算に入らない場合は400 `token_budget_too_small`を返す。

配布物はこのMac上の実物を確認した。対応OS・Node全版の実行、Linux専用の中断回復9件、リモートCI、本番反映は未確認。デプロイを行う場合は別途その環境で確認する。
