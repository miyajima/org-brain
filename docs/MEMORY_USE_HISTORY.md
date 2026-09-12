# 証拠付き利用履歴とCモード

取得した記憶と、実際の判断・行動・結果を結び付ける機能です。Cは文脈検索と利用評価による順位補正を実際の検索に適用します。既定値はすべてOFFです。本番の移行・デプロイ・有効化はこの作業では実行していません。

## インストールとローカル試用

Node.js 22.13以上を使用します。この作業で作ったパッケージを指定してインストールできます。

```sh
npm install --global /Users/miyajimakazuhiro/.codex/worktrees/b03c/org-brain/.local/releases/local-confirmation-v27-final/orgbrain-0.1.0.tgz
orgbrain usage configure --mode c --collect
orgbrain usage status
```

`--db /absolute/path/memory.sqlite` または `ORGBRAIN_LOCAL_DB` で試用先を指定できます。既存DBにはスキーマ27の追加テーブルが作られます。記憶本文・既存のutility_score・過去の実験結果は変更しません。

| モード | 文脈検索 | 利用評価による補正 |
|---|---|---|
| `a` | OFF | OFF |
| `b` | ON | OFF |
| `c` | ON | ON |
| `off` | OFF | OFF |

`--collect`と`--sync`は独立した設定です。`configure`は指定した設定全体を保存します。環境変数の指定はDBの設定より優先されます。

```sh
orgbrain memory search '接続が切れた処理の再実行' --tenant-id TENANT --project-id PROJECT --work-type implementation --task-id CURRENT_TASK
orgbrain usage history --tenant-id TENANT --project-id PROJECT --limit 20
```

Cの補正にはプロジェクト・作業種別・タスクIDが必要です。不明な場合は補正ゼロです。作業種別は `implementation/review/debug/proposal/support/research/operations/other`。条件付きの履歴には `--conditions` と `--constraints` で一致する条件を渡します。履歴・抑制済み記憶を明示して検索する場合は従来の経路を使います。

ローカルの保存確認から保存・再検索までの手順と検証は[ローカル保存確認](LOCAL_MEMORY_CONFIRMATION.md)を参照してください。

## Codexでの自動収集

既存のCodex連携で、UserPromptSubmitの実行先をこのパッケージの`hook codex-context`、Stopの実行先を`hook codex-stop`にします。現在の設定と変更案は次のdry runで確認できます。

```sh
orgbrain connector setup codex --mode minimal-hooks --cli-path "$(command -v orgbrain)"
```

連携設定を適用する場合は、このコマンドの案を確認して`--execute --approve-hooks`を追加します。既存のAstra Harness／AGENTS.mdは維持します。

ワークスペース設定の該当エントリーに、既存の`tenant_id`・`project_id`と`default_work_type`を指定します。例：

```json
{"version":1,"workspaces":{"/absolute/repository":{"tenant_id":"TENANT","project_id":"PROJECT","default_work_type":"implementation"}}}
```

設定ファイルは既存の`ORGBRAIN_WORKSPACES_FILE`を使います。注入された検索結果には、利用ID・アイテムID・取得時の版が付きます。実際に利用した場合だけ、既存の`orgbrain_memory_observe`へ`use_observation`を出します。必要な現在タスクのスコープも隠し指示で渡します。

Stopは現在ターンの4MiB以内を読み、実在する検索・ツール結果・observeを照合します。ターン境界が不明なら収集しません。埋め込まれたコードや引用を実行済みツールとして解析しません。追加のLLM呼び出し、ツール探索、Cloud送信はありません。生のコマンドや会話全文を送信キューへ保存せず、ツール結果と引数のハッシュを含む検証受領記録を使います。

取得、採用、実行、結果確認は別の状態です。ツール失敗も、構造化された最終結果があれば「結果確認」にはなります。それだけでは負の評価になりません。新しい記憶の提案・人による確認は既存フローのままです。

## 評価・訂正・失効

Consoleの記憶詳細に「利用履歴と証拠」を追加しています。履歴の状態、条件、証拠、評価を確認し、寄与と根拠を記録できます。評価はCLI／MCPでも同じ契約です。

```sh
orgbrain usage evaluate '{"id":"rating-unique-id","context_id":"USE_ID","feedback":{"contribution":"positive","statement":"この記憶を使って重複処理を避けた。照合結果で確認した。"}}' --tenant-id TENANT
```

`contribution`は`positive/negative/unknown`です。行動・結果の検証済み証拠がなければ、positiveを送っても順位補正はありません。単なるタスク成功、保存への同意、未使用、未知は加減点しません。collectorが会話から評価を取る場合は、実行後の明示的な`MEMORY_ID: 役立った`または`MEMORY_ID: 有害だった`という一文だけを認めます。否定文やassistantの自己評価は採用しません。

評価を訂正する場合は、新しい`id`と直前の評価の`supersedes_id`を指定します。履歴の文脈を訂正する場合は、`usage context`で新しい`id`と元の利用文脈の`supersedes_id`を指定します。再送時は同じID・同じ内容を使います。

```sh
orgbrain usage revoke USE_ID --tenant-id TENANT
orgbrain usage rebuild '{"project_id":"PROJECT","work_type":"implementation"}' --tenant-id TENANT
```

訂正・版変更・権限変更・証拠失効は、検索投影と評価集計に反映されます。検索時にも元の記憶と証拠の権限・有効性を確認します。過去の評価を現在版へ自動的に付け替えません。

## APIとMCP

| API | MCP | CLI |
|---|---|---|
| POST `/v1/memory-use-contexts` | `orgbrain_memory_use_context_record` | `usage context` |
| GET `/v1/memory-use-contexts` | `orgbrain_memory_use_history` | `usage history` |
| POST `/v1/memory-use-evaluations` | `orgbrain_memory_use_evaluate` | `usage evaluate` |
| POST `/v1/memory-use-contexts/:id/revoke` | `orgbrain_memory_use_revoke` | `usage revoke` |

MCPは`tenant_id`と`payload`を受け取ります。文脈登録のpayloadは以下の形です。参照先をサーバーが検証できなければ`unverified`になります。クライアントから`verified`を指定しても認定しません。

```json
{"id":"use-unique-id","usage_item_id":"ITEM_ID","project_id":"PROJECT","task_id":"TASK","work_type":"implementation","context":{"task":"課題","target":"対象","constraints":"制約","conditions":"適用条件"},"evidence":[{"role":"action","ref_type":"local_event","ref_id":"PROOF_ID","span_start":0,"span_end":40,"content_hash":"SHA256_OF_COMPLETE_PROOF_TEXT"}]}
```

既存の効果登録にも`use_evaluation`を付けられます。既存の効果イベントと当該利用アイテムの帰属を確認してから、追加の証拠評価を行います。既存の`effect_outcome`や`evidence_level`を指定するだけではCの加点になりません。

検索は`use_context`と`use_snapshot_id`を受け取り、`use_history`に補正前後のスコア、評価件数、集計時点、スナップショットID、最大1件の短い利用例を返します。取得結果の`meta.usage_items`が、利用アイテムと記憶ID・版の対応表です。Local HTTPの検索は収集ON時に`{results,meta}`を返し、収集OFF時は既存の配列応答を維持します。

## Cloudと同期

Cloudでは追加マイグレーション`0041_memory_use_history.sql`を先に適用し、次の独立フラグを設定します。この作業では本番に適用していません。

- `ORGBRAIN_USE_COLLECT=on`
- `ORGBRAIN_USE_CONTEXT=on`
- `ORGBRAIN_USE_RANKING=on`
- Local送信側の`ORGBRAIN_USE_SYNC=on`（または`configure --sync`）

Cloudは通常のLocal受領記録を信頼しません。Cloud側の専用タスクイベントを確認できる場合、または明示的に設定した収集元のHMAC検証証明を確認できる場合だけ検証済みにします。後者では32文字以上の鍵を送信側とCloudの`ORGBRAIN_USE_ATTESTATION_KEY`に秘密設定し、Cloud側に`ORGBRAIN_USE_ATTESTATION_TENANT`と`ORGBRAIN_USE_ATTESTATION_PRINCIPAL`を指定します。送信側の`ORGBRAIN_USE_PRINCIPAL`はCloudの認証principalと一致させます。鍵をリポジトリやワークスペースJSONに書きません。信頼設定がない受領記録はCloudでは未検証のままです。

同期の前提は、元の記憶が同じIDでCloudに存在することです。専用ワーカーは利用イベント／アイテムを先に同期し、その後に文脈・評価・失効を送ります。署名済みの送信内容は再試行でも固定します。鍵の失効は検索時の再検証に反映され、Localでの削除・失効は送信キューを通じて反映されます。オフライン中の失効反映は同期完了後です。

```sh
orgbrain usage configure --mode c --collect --sync
# ORGBRAIN_API_URL、ORGBRAIN_API_KEYを送信先に合わせて設定した環境で実行
orgbrain usage sync --tenant-id TENANT
orgbrain usage sync --tenant-id TENANT --watch --interval 60
```

`--watch`が自動同期ワーカーです。Stopとは別プロセスで実行します。送信失敗はキューに保持し、HTTPステータス等の限定された理由だけを残します。上記ワーカーや本番送信は、この作業では起動していません。

## 順位補正と比較検証

`memory-use-ranking/v1`は、同じprincipal・プロジェクト・作業種別・記憶版の最新の有効評価を、タスクごとに最大1件数えます。制約・適用条件ごとに事前集計し、90日半減期で重み付けします。

`final = base × (1 + 0.1 × (P − N)/(P + N + 5))`

集計時点はスナップショットに固定します。再集計で新しい時点の重みを反映します。現在のタスクが含まれる集計、版不明、証拠失効、予算超過では補正を行いません。集計・検証情報の取得失敗も補正ゼロとし、degraded理由を返します。決定・制約のgovernance優先順位は数値評価で追い越しません。Cloudの決定文脈候補は既存governanceの確認状態・権限・競合処理を通します。

固定比較データは`scripts/fixtures/memory-use-history/abc-v1.json`、実行器は`scripts/memory-use-abc.mjs`です。過去の試行は上書きしません。比較結果と証拠範囲は[検証結果](MEMORY_USE_HISTORY_VALIDATION.md)を参照してください。実際のエージェント作業における完了率・再調査・全トークン・所要時間の改善は未確認です。

## 切り戻し

```sh
orgbrain usage configure --mode off
unset ORGBRAIN_USE_COLLECT ORGBRAIN_USE_CONTEXT ORGBRAIN_USE_RANKING ORGBRAIN_USE_SYNC
```

同期ワーカーも停止します。Cloud側は対応するフラグをOFFにします。追加テーブルと履歴を保持したまま、従来検索へ戻せます。DBのダウングレードや記憶の再抽出は不要です。
