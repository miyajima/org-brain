---
title: Knowledge Pack product roadmap
doc_type: roadmap
status: draft
owner: org-brain-maintainers
last_updated: 2026-08-31
---

# Knowledge Pack product roadmap

## 目的

Knowledge Packを「作って終わり」にせず、目標設定、導入、定期的なふりかえり、
指標確認までを一つの運用ループにする。

この文書でいうKnowledge Packは、既存のDomain Packを基礎に、テナント固有の
判断知識、対象範囲、目標指標、データソース設定を束ねた構成単位を指す。保存先の
正本は既存のDecision、Knowledge Resource、Metricのままとし、画面用の別コピーを
正本にしない。

## 現在の土台と不足

| 現在の土台 | 確認できる実装 | 今回埋める不足 |
| --- | --- | --- |
| Packのカタログ・導入 | `/domain-packs`、`POST /v1/domain-packs/installations/plan`、`POST /v1/domain-packs/installations` | 手順に沿って自動遷移するオンボーディング、導入前の目標設定、途中再開 |
| Pack Workspace | `/domain-workspaces`、`GET /v1/domain-packs/:packId/workspace` | 初回設定の入口と、目標・データソースの不足を解消する導線 |
| 指標レジストリ | `/domain-metrics`、`metric_targets`、`metric_snapshots`、`metric_source_bindings` | Pack目標を組織ダッシュボードで横断表示し、未計測値を入力・取り込みできる導線 |
| 判断知識・レビュー | `/reviews`、`POST /v1/decision-memories/review-queue`、`decision_memories` / `knowledge_assertions` | 1〜2週ごとのチーム単位の採用判断、採用履歴、ふりかえりの再開・完了管理 |
| ダッシュボード | `/overview` は活動の読み取り専用投影、`/dashboard` は現在タスク画面へリダイレクト | 判断事項・ルール・理由の件数と、Packの目標対現状を同じ画面で確認 |

既存の`dashboard/v1`、Domain Packの`metric/v1`、`Decision -> Reason -> Evidence ->
Artifact`の意味論は維持する。未計測・期限切れの値は`unknown` / `stale`として扱い、
ゼロに変換しない。

## ロードマップ全体

期間は実装規模の目安であり、カレンダー上のリリース約束ではない。

| フェーズ | 優先度 | 目安 | 成果 | 依存 |
| --- | --- | ---: | --- | --- |
| 0. 共通契約・基盤 | P0 | 1週 | オンボーディング、ふりかえり、組織ダッシュボードの契約と監査境界 | なし |
| 1. Knowledge Pack導入オンボーディング | P0 | 2週 | 目標設定からPack作成・導入完了までの再開可能なウィザード | フェーズ0、`DOMAIN_PACKS_MODE=install` |
| 2. チームふりかえり | P1 | 2週 | 判断事項・ルール・理由を一画面ずつ確認し、採用可否を記録する定期セッション | フェーズ0、フェーズ1のPack範囲 |
| 3. メトリクス・ダッシュボード | P1 | 2週 | 共通件数、Pack目標、現状、データ不足の解消を一つのダッシュボードへ | フェーズ0、フェーズ1の指標設定 |
| 4. パイロットと本番化 | P0 | 1週 | 1テナントで検証し、フラグ、性能、権限、ロールバックを確認 | フェーズ1〜3 |

依存関係は`0 → 1 → (2, 3) → 4`とする。フェーズ2と3は契約が固まれば並行実装
できるが、ユーザー向けの名称、スコープ、権限、状態表示は共通のままにする。

### 実装状況（2026-08-31）

- フェーズ0のうち、Knowledge Packオンボーディング契約、管理者権限、監査middleware、
  feature flag、前方migrationを実装済み。
- フェーズ1は、再開可能な7ステップ画面、計画ダイジェスト、tenant-private
  `organization_overlay`作成、既存Pack導入、目標、manual初期値、Connector参照、
  `unknown`完了、tenant／project単位の目標適用範囲、冪等な再送まで実装済み。
- フェーズ2は、7日／14日のschedule、最大20件の決定・理由候補、参加者回答、
  管理者による項目ごとの明示結果、digest・参加者ACL再確認後の原子的確定、採用Decisionの
  `reviewed`反映まで実装済み。
- フェーズ3は、`/knowledge-dashboard`、手入力snapshot、GitHub Actionsの5指標を
  取り込む専用Queue、import run、軽量な改善アクション、実装後の再計測と
  `metric-improvement/v1`比較まで実装済み。Connector資格情報は`tenant_id`に固定し、
  import runはleaseと5分ごとの回収を持つ。実行がない指標は0にせず`unknown`を保存する。
- 本番フラグは既定で`off`。migration適用、Worker secret設定、Queue作成、pilot tenantでの
  live取り込み・権限混在検証はフェーズ4の運用境界として未実施。

## 実装対象と実装順序

| 領域 | 現行モジュール | 追加・変更する対象 |
| --- | --- | --- |
| 契約・共有ポート | `packages/contracts/src/domain-pack.ts`、`packages/server-core/src/ports.ts` | Onboarding／Retrospective／Organization Dashboardのschema、型、route port |
| API Gateway | `apps/api-gateway/src/domain-pack-service.ts`、`domain-metric-service.ts`、`domain-workspace-service.ts` | `knowledge-pack-onboarding-service.ts`、`retrospective-service.ts`、`organization-dashboard-service.ts`、フラグと監査連携 |
| Connector import | `metric_source_bindings` と既存のsnapshot契約 | 登録済みadapterだけを呼ぶ `metric-import-service.ts`、import run状態、Queue／runner境界 |
| Shared routes | `packages/server-core/src/domain-routes.ts`、`dashboard-access-routes.ts` | 上記APIの認証・tenant／project境界・冪等性・契約検証 |
| Console | `apps/console/src/pages/domain-packs.astro`、`domain-workspaces/*`、`domain-metrics.astro`、`overview.astro`、`layouts/BaseLayout.astro` | `/knowledge-packs/onboarding`、`/retrospectives/*`、`/dashboard/knowledge`、共通locale・ナビゲーション |
| 永続化 | `migrations/0034_domain_pack_platform.sql`〜`0037_verified_knowledge_ingestion.sql`の次の番号 | セッション、項目、回答の前方migration。既存Metric／Decision正本は再利用 |
| 検証 | `packages/*/test`、`apps/api-gateway/test`、`apps/console/e2e`、`scripts/*smoke*` | 契約、ACL、冪等性、UI状態、性能、live smoke |

実装順序は次のとおりとする。

1. 契約、状態遷移、権限表、監査イベント、フラグを固定する。
2. 前方migrationとAPIの読み取りを追加し、空データ・ACL混在での応答を先に検証する。
3. Onboardingの保存・計画・完了を実装し、既存Pack installerとMetric target/snapshotへ接続する。
4. Retrospectiveの項目生成・回答・close・次回生成を実装し、明示的な採用公開だけを正本へ反映する。
5. Organization Dashboardの集計と不足値アクションを実装し、既存`/overview`と詳細画面へ接続する。
6. Consoleのキーボード／モバイル／多言語状態を仕上げ、preview→pilot→onの順で検証する。

## フェーズ0: 共通契約・基盤

### 契約

`packages/contracts`に次のバージョン付き契約を追加する。リクエストの
`tenant_id`、`project_id`、`idempotency_key`、`plan_digest`は既存の認証・監査規約に
合わせ、秘密値や生のプロンプトは受け付けない。

- `KnowledgePackOnboardingV1`: セッション状態、現在ステップ、選択Pack、対象範囲、
  目標指標、データソース状態、計画ダイジェスト。
- `RetrospectiveSessionV1` / `RetrospectiveItemV1`: セッション期間、参加者スコープ、
  対象の出典、Decision/Rule/Reasonの種別、証拠状態。
- `RetrospectiveResponseV1`: `adopt`、`do_not_adopt`、`defer`のいずれか一つ。
- `OrganizationDashboardV1`: 判断・ルール・理由・Packの件数、目標指標の現状、
  freshness、入力・取り込み可能性。

### D1の追加

最新migration番号を確認したうえで、次のような前方移行を追加する。既存テーブルの
削除・down migrationは行わない。

- `knowledge_pack_onboarding_sessions`: `tenant_id`、`project_id`、`state`、
  `current_step`、検証済み`answers_json`、`plan_digest`、作成者、完了日時、監査用時刻。
  `answers_json`には接続先の秘密値を保存せず、`connection:...`形式の非秘密
  `connection_ref`だけを保存する。接続の実在性と疎通はConnector層の検証境界とする。
- `retrospective_sessions`: セッション期間、7日または14日のcadence、参加者グループ、
  `open/closed/cancelled`、未回答数、公開状態、完了者。
- `retrospective_items`: セッション内の出典（Decision / Assertion / Rationale）、
  参照バージョン、項目種別、表示順、証拠・権限のスナップショット。
- `retrospective_responses`: セッション・項目・principalごとの一意な回答、回答時刻、
  監査情報。再送は同じidempotency keyで同じ結果を返す。
- `metric_source_import_runs`: `binding_id`、`queued/running/succeeded/failed`、
  attempt、request digest、snapshot id、error code、開始・完了時刻を記録する。秘密値や
  Connector応答本文は保存しない。

目標の値そのものは新しいコピーを持たず、既存の`metric_bindings`、`metric_targets`、
`metric_snapshots`を使用する。ダッシュボードの件数も原則として既存正本から読み取り、
大きな集計が必要になった場合だけ後続フェーズで計測用の投影を検討する。

### 権限と状態の共通ルール

- Packの作成・計画・導入と目標変更は、既存の管理権限とテナント境界を適用する。
- ふりかえり項目は、作成時と表示時の両方でDecision / ResourceのACLとGroup membershipを
  評価する。閲覧できない項目は件数にも含めない。
- `adopt`はチームの採用判断であり、既存Decisionの内容を自動上書きしない。正本への
  反映はセッション完了時の明示的な公開操作と監査イベントで行う。
- すべての書き込みは監査イベント、競合時の409、再送時の冪等性を備える。

## フェーズ1: Knowledge Pack導入オンボーディング

### 画面

表示名はKnowledge Pack、既存のDomain Packはテンプレート／配布単位として表示する。
新しい入口は`/knowledge-packs/onboarding`とし、`tenant_id`、`project_id`、`lang`を
引き継ぐ。

1. **目的**: Packで改善したい業務を言語化する。
2. **テンプレート**: 利用可能なFirst-party Packまたはテナント内のPackを選ぶ。
3. **範囲**: 目標値と観測値をtenant全体または1つのprojectへ適用する。Knowledge Pack自体は
   tenant-privateとし、この画面でGroup ACLを設定できるとは表現しない。
4. **目標**: 1〜3個の指標、方向（増加／減少／維持／範囲）、目標値、期限を設定する。
5. **データソース**: Connectorを設定するか、初回値を既存のmanual snapshot契約で入力する。
6. **確認**: Pack manifest digest、競合、目標の適用範囲、未接続の指標、fixtureを追加しないことを表示する。
7. **完了**: 明示的な確認後にPack作成・導入、目標保存、初期値保存を実行し、Workspaceと
   Pack管理画面へ遷移する。組織ダッシュボードへの導線はフェーズ3で追加する。

入力が妥当になったステップは自動的に次へ進む。ただし戻る、再読込後の再開、キーボード
操作、明示的なスキップ（未計測のまま`unknown`にする）は可能にする。Connectorの認証など
外部画面へ移る場合だけは自動送信せず、戻り先のステップを保持する。

### API候補

- `POST /v1/knowledge-pack-onboardings`: 現在の未完了セッションを再利用または新規作成。
- `GET /v1/knowledge-pack-onboardings/:id`: 現在ステップと検証済み回答を返す。
- `PATCH /v1/knowledge-pack-onboardings/:id/steps/:step`: 1ステップを保存し、次のステップを返す。
- `POST /v1/knowledge-pack-onboardings/:id/plan`: 既存のPack installation planと目標・適用範囲を
  合成し、`plan_digest`を返す。
- `POST /v1/knowledge-pack-onboardings/:id/complete`: 現在のdigestを要求し、Packの
  organization overlay、installation、metric target、許可された初期snapshotを冪等に確定する。

内部では既存の`planDomainPackInstallation` / `installDomainPacks`を再利用する。新規の
organization overlayはprivate/unlistedの構成として扱い、任意のSQL、JavaScript、秘密値、
story fixtureをPackに含めない。計画が変わった場合は完了せず、再プレビューを要求する。

### 完了条件

- 必須ステップを満たした管理者が、途中でブラウザを閉じても同じセッションから再開できる。
- 完了後にPack installation、目標、データソース状態、監査イベントが確認できる。
- 初期値がない場合は`unknown`のまま完了でき、手入力または登録Connectorの取り込みへ進める。
- 競合、権限不足、digest不一致、D1書き込み失敗は成功表示に置き換えず、再試行可能な失敗として表示する。
- 完了レスポンスと再送レスポンスが同じinstallation／targetを指し、重複Packや重複snapshotを作らない。

## フェーズ2: チームふりかえり

### 体験

新しい画面は`/retrospectives`（一覧）と`/retrospectives/:id`（実施）とする。1回の画面で
大量の文章を読ませず、Decision、Rule、Reason、Evidenceの要約と出典リンクを一枚ずつ示す。
参加者は各カードで「採用」「見送る」「保留」を一度選ぶだけでよい。自由記述はMVPの必須操作に
しない。

管理者は7日または14日のcadence、対象Project／Group、開始・完了を設定する。チームの場合は
回答済み人数、未回答人数、採用率を表示し、管理者が未回答を残したまま完了する場合はその状態を
記録する。参加者が管理者一人だけの場合も同じAPI・画面で完了できる。

### API候補

- `POST /v1/retrospectives`: 管理者が期間、Pack、Project、参加Group、cadenceを指定して作成。
- `GET /v1/retrospectives`: 開催中、次回予定、過去セッションを一覧。
- `GET /v1/retrospectives/:id`: ACLで絞った項目、出典、回答集計、未回答者数を返す。
- `PUT /v1/retrospectives/:id/items/:itemId/response`: 回答を冪等に保存。
- `POST /v1/retrospectives/:id/close`: 管理者が集計を確定し、採用結果を監査付きで公開する。

候補項目は、Packの対象範囲にあるDecision、`knowledge_assertions`のルール関係、
`decision_rationales`の理由を、未確認・変更・期限切れ・競合・新規の順で選ぶ。出典がない、
閲覧不能、または期限切れの数値を「採用済み」と表示しない。

`adopt`の公開は、既存の`confirmDecisionMemory`または明示的な`knowledge_assertions`の
確認経路へ接続する。ただし自動でDecision本文を改変せず、どのセッション、誰の回答、どの
バージョンを根拠にしたかを記録する。`defer`は次回候補へ戻し、`do_not_adopt`は今回の採用対象から
外すだけで、元のDecisionを削除しない。

### 定期実施

既存の`scheduled_job_runs`とWorkerのscheduled entrypointを利用し、期限到来したセッションを
冪等に作成する。MVPの通知はConsole内の未実施表示までとし、メールや外部チャット通知は、通知先・
同意・再送制御を別途定義してから追加する。

### 完了条件

- Group参加者は、自分が読める項目だけを見て一回の操作で回答できる。
- 同じ項目の再送は一つの回答として扱われ、別テナント・別Groupのデータが混ざらない。
- 管理者一人のセッションが同じ手順で完了し、チーム時は回答数と未回答数が正しく表示される。
- 完了後も元のDecision、理由、Evidence、履歴を閲覧でき、採用結果の監査リンクが残る。
- 7日／14日の次回セッションが重複作成されず、失敗したスケジュール実行は再試行できる。

## フェーズ3: メトリクス・ダッシュボード

### 画面と表示

既存の活動画面`/overview`に要約カードを追加し、詳細は`/dashboard/knowledge`で表示する。
既存のタスク用`/dashboard`リダイレクトは、フラグを切り替えるまで変更しない。

上部に次の共通件数を表示する。

- 確認済み／要確認のDecision数
- 採用済み／保留中のRule数
- 理由（Rationale）の登録数
- インストール済みKnowledge Pack数
- 開催中・未完了のふりかえり数

Packごとの目標カードには、指標名、目標方向・値・期限、最新の現状値、差分、観測時刻、
`measured / unknown / stale`、データソース状態を表示する。未計測・期限切れは数値を表示せず、
「値を入力」または「Connectorから取り込む」だけを提示する。

### API候補

- `GET /v1/dashboard/organization`: `OrganizationDashboardV1`を返す。Decision／Rule／Reasonの
  件数は、要求されたProjectと現在のACLで絞る。
- `GET /v1/dashboard/organization/metrics`: Pack目標と最新snapshotを返す。
- `POST /v1/dashboard/organization/metrics/:metricKey/snapshot`: UIの手入力を既存の
  `POST /v1/metric-snapshots`へ接続し、scope・expires_at・evidence_refを検証する。
- `POST /v1/metric-source-bindings/:bindingId/import`: 管理者またはmetric write権限を持つ
  principalが、登録済みbindingの取り込みを明示的に起動する。`x-idempotency-key`ごとに一つの
  import runを作り、`202`とrun idを返す。

Connector importの実行境界を次のように固定する。

`GITHUB_METRIC_CONNECTIONS_JSON`はWorker secretとして、各entryに必ず`tenant_id`を持たせる。
例: `{"primary":{"tenant_id":"tenant-a","token":"<secret>","owner":"acme","repo":"web","workflow":"ci.yml","deployment_workflow":"deploy.yml"}}`。
GatewayとRunnerはいずれも`tenant_id`と`connection_ref`の完全一致を要求し、一覧APIはtokenを返さない。

1. Gatewayはbindingのtenant、scope、adapter ID、query-template IDが登録済みであることを検証し、
   `metric_source_import_runs=queued`を作ってQueue／runnerへ渡す。ブラウザは資格情報を渡さない。
2. Runnerはサーバー側のbindingへ解決した資格情報だけで一回のadapter呼び出しを行い、返却値を
   `metricSnapshotSchema`（`source_binding_id`、`observed_at`、`expires_at`、`query_digest`、
   `evidence_ref`を含む）で検証してから既存の`POST /v1/metric-snapshots`相当の内部処理へ渡す。
3. 状態は`queued → running → succeeded|failed`とし、同じrequest digestの再送は同じrun／snapshotを
   返す。失敗は最大3回まで同じrunで再試行し、最後のerror codeをUIと監査へ残す。失敗を`unknown`や
   成功に置き換えない。
4. GitHub Actionsは1ページ100件、最大10ページまで取得する。10ページ目も満杯なら過少集計せず
   `github_pagination_limit_exceeded`で失敗させる。デプロイ系指標には専用の`deployment_workflow`を必須とする。
5. 監査イベントにはtenant、binding、adapter、template、run id、結果状態、snapshot idだけを記録し、
   資格情報、応答本文、不要な生データは記録しない。

Connector取り込みは既存の`metric_source_bindings`と登録済みadapter/query templateだけを使用する。
任意SQL、任意JavaScript、ブラウザからの秘密値送信は許可しない。

新しい集計表を正本にしない。件数の再計算が重いと判明した場合は、先にクエリ計画とACLフィルタを
測定し、必要な投影だけを前方移行で追加する。

### 完了条件

- Dashboardの件数がDecision／Assertion／Rationale／Pack installationの正本と一致する。
- Pack目標は、現状値がある場合だけ数値とfreshnessを表示し、ない場合は`unknown`／`stale`を明示する。
- 手入力はidempotency key付きで一度だけ保存され、取り込みは登録済みConnectorの状態と失敗理由を表示する。
- Connector取り込みは`202`のrun状態を表示し、成功時だけ`source_binding_id`付きsnapshotを反映し、失敗時は原因と再試行状態を表示する。
- tenant、project、Group ACLの境界を越える件数・目標・Evidenceが返らない。
- 空、疎、密、混在アクセスのデータで、空状態、truncated状態、エラー状態が誤って成功表示にならない。

## フェーズ4: パイロットと本番化

### フラグ

次の独立フラグを追加し、既存のフラグと組み合わせる。

- `KNOWLEDGE_PACK_ONBOARDING_MODE=off|preview|on`
- `RETROSPECTIVE_MODE=off|preview|on`
- `ORGANIZATION_DASHBOARD_MODE=off|preview|on`
- `METRIC_IMPORT_MODE=off|preview|on`
- `IMPROVEMENT_ACTIONS_MODE=off|preview|on`
- `KNOWLEDGE_LOOP_PREVIEW_WRITE_TENANTS_JSON=["<pilot-tenant-id>"]`

`on`にする前に、`DOMAIN_PACKS_MODE=install`、`DOMAIN_METRICS_MODE=on`、
`DOMAIN_WORKSPACES_MODE=on`の依存を確認する。

### 検証ゲート

1. 新しいmigrationを新規D1に適用し、既存のmigration検証、契約テスト、型チェック、lint、buildを実行する。
2. Onboardingの空、既存Pack、custom競合、Connector未設定、途中再開、digest競合、二重送信を検証する。
3. Retrospectiveのsolo、Group、ACL混在、未回答、競合、スケジュール再実行を検証する。
4. Dashboardの件数照合、目標達成／未達、unknown／stale、手入力、登録済みテストConnectorのqueued／success／retry／failed、空状態を検証する。
5. ja/en/zh、デスクトップ／モバイル、キーボード、スクリーンリーダー、reduced motionを確認する。
6. API p95、payload size、D1クエリ数、5xx／429、監査イベントをpreview期間中に基準値と比較する。
7. 1テナントでpreviewを24時間以上観測し、成功率・未完了率・採用率・目標値入力率を確認してから`on`へ進める。

### 実行コマンド

既存チェックに加えて、実装時に次のターゲットを追加する。

```bash
pnpm docs:validate
pnpm packs:validate
pnpm test:domain-packs
pnpm --filter @org-brain/contracts test
pnpm --filter @org-brain/api-gateway test
pnpm --filter @org-brain/console typecheck
pnpm --filter @org-brain/console test:e2e
pnpm lint
pnpm build
pnpm smoke:knowledge-pack-onboarding
pnpm smoke:retrospectives
pnpm smoke:organization-dashboard
```

Live smokeは、移行、API、Consoleの各デプロイ後に認証済みの読み取りから開始する。設定値、
preview、モック、fixture、デプロイ完了だけでは本番成功と扱わず、実際のレスポンス、状態、件数、
監査イベントを再読して確認する。

## ロールバック

1. Gatewayの`KNOWLEDGE_LOOP_PREVIEW_WRITE_TENANTS_JSON=[]`を先に反映し、新規writeとenqueueを停止する。
   Runner側のallowlistは維持し、停止前に受理済みのqueued/running importを完遂させる。
2. D1とQueueの未完了が0件になったことを確認してからRunnerの`METRIC_IMPORT_MODE=off`を反映する。
3. `IMPROVEMENT_ACTIONS_MODE=off`、`RETROSPECTIVE_MODE=off`、
   `KNOWLEDGE_PACK_ONBOARDING_MODE=off`、`ORGANIZATION_DASHBOARD_MODE=off`の順に設定し、新しい導線とpollingを停止する。
4. 既存の`/domain-packs`の計画・導入、`/domain-workspaces`、`/domain-metrics`、Decision画面を
   既存モードへ戻す。
5. セッション、回答、目標、snapshot、監査イベントは削除せず、失敗セッションは再開または管理者が
   明示的にcancelできる状態で保持する。
6. down migrationは実行しない。問題のある集計やindexは、原因確認後に次の前方migrationで修正する。
7. フラグで復旧しない場合だけ、直前のAPI／Consoleリビジョンへ戻し、同じ読み取り専用live smokeを再実行する。

## 最終的な完了定義

次の4点を同じテナントで確認できた時点をロードマップの完了とする。

- 管理者がウィザードを完了すると、Knowledge Pack、目標、初期データソース状態、Workspaceへの導線が揃う。
- 1〜2週ごとのふりかえりで、メンバーまたは管理者一人がDecision／Rule／Reasonの採用可否を短時間で確定できる。
- Dashboardで共通知識の件数とPack目標の現状を確認でき、値がなければ安全に入力・取り込みへ進める。
- 3機能すべてが同じ正本、ACL、監査、冪等性、unknown／stale意味論、フラグ付きロールバックを共有する。
