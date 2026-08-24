# iteration 3 検証資源

## 作成した証拠

- `measurement-input.json`: 固定rubricへの採点入力。
- `scorecard.json`: 証拠上限と重大度上限を適用した機械計算結果。
- `metrics.json`: 改善前後、操作測定、検証数。
- `ai-local.json`: fresh synthetic SQLiteによる12シナリオ各3回の結果。
- `screenshots/01`〜`06`: 当日のin-app Browser実査画像。

## 検証用fixture

- `archived-team-e2e`: active user/group/projectが0でも、構成済みorganizationをチームscopeとして表示するfixture。
- AI監査用SQLite: 一時directoryに作成し、監査終了時に削除。永続データなし。

## 外部資源

- Cloudflare resource変更: 0件。
- OAuth・hook変更: なし。
- 実Codex client設定変更: なし。
- production tenantデータ変更: なし。

## 削除・復旧

削除した利用者資源はない。Local synthetic team資源のarchive結果はiteration 2のmanifestへ保存済みである。
