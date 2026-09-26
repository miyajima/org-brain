# メモリの報告・関係・エージング候補

この機能は記憶の版を基準に評価する。報告や関係の提案だけで検索結果を書き換えない。自動handoffは含まない。

## ファイル操作の保存前除外

`apply_patch` の対象パスを TurnEvidenceV1 の生成前に検査し、除外対象を含む呼び出しと対応する結果を丸ごと除く。これにより除外対象のパス・差分・ツール結果は抽出用のスニペットやイベントに入らない。既定では `.env`、`.env.*`、`.ssh/`、`secrets/`、鍵ファイル拡張子を除外する。

ワークスペース固有の設定は `<workspace>/.orgbrain/capture-exclusions.json` に置く。

```json
{"version":1,"include_paths":["src/**","docs/**"],"exclude_paths":["src/private/**","docs/confidential.md"]}
```

パターンはワークスペース相対パス。`include_paths` は省略可能で、省略時はすべてのパスを候補とする。`exclude_paths` が優先する。設定が壊れている場合、収集処理は失敗し、除外設定を無視して保存を続けない。`apply_patch` 以外のファイル操作を収集対象に追加するときは、同じ保存前判定に対象パスを渡す。

## 「古い・誤り」の報告

報告には `memory_id`、`memory_version`、`kind` (`stale` / `wrong`)、理由、1件以上の証拠参照を必須とする。報告は `reported` として保存し、検索結果には反映しない。書き込み権限を持つレビュー担当者が確認・却下する。判断・好み・制約に関する記憶は所有者の確認を必須とする。

確認済みの `wrong` は、報告対象がなお現在版である場合だけ抑制する。古い版への報告で修正版を抑制しない。確認済みの `stale` は監査と未解決一覧に出す。報告の証拠本文は監査結果に出さない。

Cloud API: `POST /v1/memories/feedback`、`POST /v1/memories/feedback/:feedbackId/review`、`GET /v1/memory-quality/issues?project_id=...`。同じ操作はMCPの `orgbrain_memory_feedback_report`、`orgbrain_memory_feedback_review`、`orgbrain_memory_integrity_issues` から使える。ローカルCLIは `orgbrain memory feedback report`、`orgbrain memory feedback review <id> --decision confirm|reject`、`orgbrain memory issues`。

## 矛盾・修正の関係

`contradicts` / `fixes` は両端の現在版を指定して証拠付きで提案する。同じテナント・プロジェクト内に限定し、版が変わった提案は確認できない。提案段階では検索順位や本文を変更しない。書き込み権限を持つレビュー担当者が確認・却下し、判断・好み・制約は所有者が確認する。確認済みの未解決矛盾は監査と未解決一覧に記憶IDだけを表示し、通常検索の結果に `unresolved_contradiction` を付ける。修正の関係は証拠として記録し、元の記憶を自動削除しない。

Cloud API: `POST /v1/memories/relations`、`POST /v1/memories/relations/:relationId/review`。MCPの `orgbrain_memory_relation_propose` / `orgbrain_memory_relation_review`、ローカルCLIの `orgbrain memory relation propose` / `orgbrain memory relation review <id> --decision confirm|reject|resolve` も使える。

## エピソード記憶の利用実績に基づく候補

`orgbrain memory aging-plan --project-id <id>` または `GET /v1/memory-quality/aging-plan?project_id=<id>` でシャドー評価を読む。MCPは `orgbrain_memory_aging_plan`。対象は有効な `episodic` のみ。最後の活動日は作成日時と、現在版に紐づく検証済み利用評価の日時の遅い方とする。検索に返された回数、自己申告の利用、未検証評価は活動日としない。

- 活動から30日で `cold_candidate`、180日で `compaction_candidate`。
- 法的保全、期限切れ、現在版の未解決報告・矛盾は候補から除く。期限切れは既存の期限ポリシーが優先する。
- 現段階は `mode: shadow` で、記憶の変更件数は常に0。候補と実際の再利用を観察してから自動圧縮を有効化する。
- 既存のmaintenanceによるdigest・重複整理は別経路で動く。明示的に `episodic` と分類された記憶は、この従来の年齢基準だけの圧縮から除外する。型が不明な旧データなど従来の対象は継続する。利用実績に基づく自動圧縮を導入する前に、両経路の対象と優先順位を統合する。
- ローカルで既に抑制された記憶は `orgbrain memory restore-version <memory-id> --version <n>` で指定版の本文・根拠などを新しい版として復元できる。所有者の操作が必要。現在のプロジェクト・公開範囲・権限は復元時にも維持する。

Cloudの保存層には `migrations/0044_memory_integrity.sql` を追加した。デプロイと本番移行は別作業。
