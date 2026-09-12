# 利用履歴・文脈検索・C順位補正の検証

2026-09-12。Cを実際の検索へ適用する実装と、インストール可能なCLIを用意した。以下はローカルの実装検証であり、本番Cloudflare、実際のCodexセッション、人の受け入れを確認したものではない。

## 比較結果

固定fixture `scripts/fixtures/memory-use-history/abc-v1.json` の5問を使った。2問が文脈検索、1問が評価による順位変更、2問が重要事項の回帰確認。履歴の締切は2026-09-01、検索時点は2026-09-02。検索後の評価を学習側へ入れていない。実装はLocalMemoryStore、SQLite、hybrid_v4、dense providerなし。各モード200回の検索時間を測った。

| モード | Recall@5 | nDCG@5 | p95 ms | p95 / A |
|---|---:|---:|---:|---:|
| A 従来検索 | 0.400 | 0.400 | 3.397 | 1.000 |
| B 利用文脈を追加 | 1.000 | 0.779 | 3.405 | 1.003 |
| C 利用評価で補正 | 1.000 | 1.000 | 3.580 | 1.054 |

この小さな合成fixtureでは、Bの文脈問題のRecall改善、Cの評価問題のnDCG改善、重要事項の回帰0件、全体がA以上、p95がAの1.15倍以下を満たした。実利用の一般的な改善率とは解釈できない。Cloudネットワークを含むp95でもない。

実エージェントによる完了率、再調査回数、全モデル入出力トークン、キャッシュ、所要時間、再作業、受け入れ結果は未測定。結果JSONでは未知の値をnullとしている。モデル実行や既存の保留実験の再送は行っていない。

最初の試行はBのp95比1.263で不合格だった。検索内の元記憶・証拠検証をキャッシュし、条件別の事前集計と一括取得を用いて改善した。最初の結果を置き換えず、途中と最終の結果を別ファイルで保管した。

- [最初の試行](evidence/memory-use-history/abc-first.json)
- [最適化後の試行](evidence/memory-use-history/abc-optimized.json)
- [最終ランタイムの試行](evidence/memory-use-history/abc-final.json)

各結果にfixture・ランタイムのSHA-256、ポリシー、スナップショットID、時点、個別順位を記録している。再実行する場合は別の出力先を使う。

## 機能・安全性

`scripts/memory-use-history.test.mjs` の17件が成功。版・タスク・principal・プロジェクト・証拠ハッシュの不一致、偽のverified、証拠削除、ACL変更、版変更、未来の証拠、同一タスクの重複加点、訂正・失効、条件不一致、署名偽造、同期再試行、現在ターンの収集、文脈だけで見つかる記憶のhook注入を検証した。対象fixture内の漏えい・不正加点は0件であり、任意の実データで0件を保証する主張ではない。

`scripts/memory-use-cloud.test.ts` は実際のCloudサービスをSQLiteのD1 adapterへ接続し、Localと共有fixtureで比較。信頼設定のある署名受領記録と、なりすまし拒否を確認した。Cloudflare実機試験ではない。

既存LocalMemoryStoreとschema parityの31件、hook bridgeの43件、Context Engineの25件、効果登録の1件、API／MCP manifestの2件も成功。API gatewayのTypeScriptチェック成功。ConsoleはNode runtimeのAstroチェックでerror 0、warning 0、既存hint 4。新規ランタイム・collector・試験JSのESLint成功。CloudテストのTSファイルはESLint設定の対象外であり、Vitestで実行した。

同じ親タスクで変更範囲をレビューした。証拠解決はrequestから切り離し、権限を再確認し、未知を加点へ変換しないこと、Stopから通信しないこと、既定OFF、既存本文・utility_scoreの非変更を確認した。

## パッケージ検証

`pnpm build:standalone` から作った `orgbrain-0.1.0.tgz` を、一時ディレクトリへ `npm install --ignore-scripts` でインストールした。グローバルCLI・hook設定は変更していない。

SHA-256: `448dba08c64f11cc6329c460a17883ab5f1ffa342fa96fce91649ea94ea454ce`

インストール済みの `dist/orgbrain.mjs` を指定した `scripts/memory-use-install.test.mjs` が成功。C検索の順位補正と利用アイテムの対応、strict MCP接続、4つの利用履歴ツール、文脈取得、評価訂正、同じIDの再送、段階別履歴を確認した。Codex connector setupもdry runで成功した。

試用の手順、独立フラグ、Cloudの信頼設定、同期ワーカー、切り戻しは[操作ガイド](MEMORY_USE_HISTORY.md)を参照。本番マイグレーション・デプロイ・機能有効化・同期送信は未実施。
