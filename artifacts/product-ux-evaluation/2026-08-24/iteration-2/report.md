# OrgBrain 全体機能・UX評価 iteration 2

## 結論

現行点は92.8点だった。計算には固定rubricを使った。前進はした。baseline 86.2点、iteration 1の92.7点から、Local初回導入を97.1点、チーム適合を92.5点へ上げた。重点4軸はすべて96点以上、coverageは97.3%、重大・高リスクfindingは0件である。

96点には未到達である。合否は保留した。壁はCloud側にある。Cloudflare初回導入は40.0点、AI提案は82.0点だった。Cloud liveとCloud AI parityに加え、別principalの認証、期限切れ、権限拒否が未検証である。dry-runやLocal D1をCloud liveへ読み替えていない。

## 全軸の点数

| 評価軸 | baseline | iteration 1 | iteration 2 | 合格線 | 状態 |
| --- | ---: | ---: | ---: | ---: | --- |
| わかりやすさ・メンタルモデル | 89.5 | 97.5 | 97.5 | 96 | 合格 |
| 画面のシンプルさ | 91.0 | 96.8 | 96.8 | 96 | 合格 |
| 操作のしやすさ | 91.5 | 96.3 | 96.3 | 96 | 合格 |
| 目的へのたどり着きやすさ | 87.4 | 98.1 | 98.1 | 96 | 合格 |
| 発見しやすさ・情報設計 | 94.5 | 96.5 | 96.5 | 90 | 合格 |
| 状態表示・エラー回復 | 79.5 | 96.0 | 96.0 | 90 | 合格 |
| 信頼・根拠・安全性 | 95.5 | 97.0 | 97.0 | 90 | 合格 |
| 一貫性・コピー・多言語 | 93.5 | 95.0 | 95.0 | 90 | 合格 |
| アクセシビリティ・レスポンシブ | 92.0 | 92.0 | 92.0 | 90 | 合格・自動証拠上限 |
| Local初回導入 | 73.6 | 96.1 | 97.1 | 90 | 合格 |
| Cloudflare初回導入 | 39.0 | 40.0 | 40.0 | 90 | 未達 |
| AI提案・失敗回避 | 81.0 | 82.0 | 82.0 | 90 | 未達 |
| 個人利用への適合 | 94.5 | 97.0 | 97.0 | 90 | 合格 |
| チーム利用への適合 | 82.5 | 88.5 | 92.5 | 90 | 合格 |
| **総合** | **86.2** | **92.7** | **92.8** | **96** | **未達** |

## 実装した改善

1. 日本語のスキル画面を日本語優先にし、生成サービス、非公開の下書き、公開、書き出しという行動語へ統一した。
2. 日本語のエージェント画面を、名前付きエージェント、利用構成、使い方、権限と優先度、最大トークン数へ統一した。内部値は変えていない。
3. connector実行処理へ検証用runnerを注入できるようにし、実クライアント設定を変更せずに`--execute`と`--cli-path`の最終argvを検証した。
4. Local D1のsynthetic tenantで、ユーザー、グループ、役割、共有状態を永続化した。
5. メンバーを一時停止し、再読込後も停止状態であることを確認した。同じ画面から利用中へ戻し、再読込後の復旧も確認した。
6. 検証資源をarchiveし、25件の結果、全8ユーザーの利用解除、グループ0件を確認した。
7. グループ詳細の各削除ボタンへ対象principalを含む読み上げ名を付け、同名ボタンを区別できるようにした。

公開APIとDB schemaは変更していない。

## 番号付き操作ステップ

### connector

1. `--cli-path`を指定した登録計画を作る。
2. `--execute`の実行先を監査runnerへ差し替える。
3. `codex mcp add orgbrain -- <node> <絶対CLI path> mcp`のargvを確認する。
4. 検証用のreadback commandが返ることを確認する。

実際のCodex設定は変更していない。

### チーム状態変更と復旧

1. Local D1へsynthetic tenantを作成する。
2. ユーザー画面で8件のユーザーと役割を確認する。
3. Member 1を一時停止へ変更する。
4. 確認画面で対象、影響範囲、復旧方法を確認する。
5. 変更後に再読込し、`suspended`を確認する。
6. 同じ画面から利用中へ戻す。
7. 再読込し、`active`を確認する。
8. グループ詳細で所有者、管理者、メンバーを確認する。
9. manifestを使って検証資源をarchiveする。
10. 全ユーザーの`deprovisioned`とグループ0件を確認する。

再試行は、復旧後の画面要素取得で待機時間超過が1回あった。直後の画面snapshotでは保存完了通知と`active`を確認できたため、操作自体の再実行はしていない。

## 残るfinding

| ID | 重大度 | 内容 | 完了条件 |
| --- | --- | --- | --- |
| F-I2-01 | low | 全ja画面の用語監査は未完了 | 用語規約をja全画面へ適用 |
| F-I2-02 | low | 実Codex設定への登録とreadbackは未実施 | 隔離設定または明示承認で登録 |
| F-I2-03 | medium | OAuthとcloud hookが未実査 | reviewed host/policyでlive完遂 |
| F-I2-04 | medium | Cloud否定系とrollbackが未実査 | 同一artifactで二回連続合格 |
| F-I2-05 | medium | Cloud AI parityが未実査 | 同一scenarioを各三回比較 |
| F-I2-06 | medium | 別principal本人としての共有・audit未実査 | principalを分離してreadback |
| F-I2-07 | medium | 期限切れ招待とdenied principalが未実査 | 否定系と復旧を別fixtureで確認 |
| F-I2-08 | low | 全ユーザー利用解除後にscope表示がチームから個人へ変わる | archive状態またはチームscopeを明示 |

## 96点への次の反復

1. managed hostname、Access policy ID、synthetic tenant、rollback owner、source SHA、artifact digestを承認packetへ固定する。
2. 明示承認後だけ、同一artifactをCloudflareへ投入する。
3. user OAuth、service-token hook、期限切れ、tenant拒否、revoke、rollbackを実査する。
4. owner、admin、member、denied principalを別sessionにし、共有とauditを本人視点で確認する。
5. LocalとCloudで同じAI scenarioを各三回実行する。
6. VoiceOverで代表フローの名称、順序、状態通知を確認する。
7. fresh環境で全gateを二回連続して通す。

Cloudflareでは、別の明示承認があるまで何も変更しない。deploy、OAuth、hook、remote data作成が対象である。

## 証拠と限界

- 機械計算: `scorecard.json`。
- 採点入力: `measurement-input.json`。
- 測定値: `metrics.json`。
- 検証資源: `resources.md`。
- 画面証拠: `screenshots/`。
- archive結果: `team-local-manifest.json`。

axe合格をWCAG準拠とは表現しない。VoiceOver、Cloudflare live、別principal本人としての操作は未実施である。
