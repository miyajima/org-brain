# Tracker: OrgBrain 全体機能・UX評価と96点到達

> 進捗、決定、論点、検証結果を時系列で記録する。

---

## 進捗サマリー

| Phase | 名称 | 状態 | 完了日 |
|-------|------|------|--------|
| 1 | 与件固定 | 完了 | 2026-08-24 |
| 2 | fresh実査 | 完了 | 2026-08-24 |
| 3 | 改善 | 完了 | 2026-08-24 |
| 4 | 仕上げ | 完了・Cloud liveと認証分離のみ承認待ち | 2026-08-24 |

## 決定ログ

| # | 日付 | 決定 | 根拠 | 却下した代替案 |
|---|------|------|------|--------------|
| DC-01 | 2026-08-24 | 14軸と重みを固定 | 過去評価とのスコープdriftを止める | 実査後の重み変更 |
| DC-02 | 2026-08-24 | current-run証拠だけで現行点を算出 | 過去画像による誤認を防ぐ | 過去scoreの流用 |
| DC-03 | 2026-08-24 | Cloudflare liveを別承認にする | 外部変更とsynthetic dataの境界 | 暗黙のdeploy |
| DC-04 | 2026-08-24 | 親エージェントが全工程を担当 | 明示的委任がないため | サブエージェント分割 |
| DC-05 | 2026-08-24 | iteration 2も親エージェントがbounded continuationとして担当 | 開発者のmulti-agent禁止を優先し、harnessの委任は例外記録 | 子エージェント生成 |

## 論点（イシュー）

| # | 日付 | 論点 | 優先度 | 状態 | 解決 |
|---|------|------|--------|------|------|
| Q-01 | 2026-08-24 | 現行点はいくつか | H | 解決 | baseline 86.2、iteration 1は92.7、iteration 2は92.8 |
| Q-02 | 2026-08-24 | 最高影響のUX摩擦は何か | H | 解決 | fresh Local start、connector path、復旧案内 |
| Q-03 | 2026-08-24 | Cloudflare liveの対象は何か | H | 入力待ち | managed hostnameとAccess policy IDが未指定 |
| Q-04 | 2026-08-24 | 96点未達の残差は何か | H | 解決 | Cloud live、AI parity、別principal本人readback、期限切れ・拒否、manual reading |

## Pre-Mortem ログ

### 2026-08-24: Phase 2開始時

1. 手入力点数が残り評価が再現できない → rubric、schema、validatorを先に作る。
2. mock画面だけで高得点を付ける → interactive-local、automated、staticを分離し証拠上限を適用する。
3. Cloudflare未検証を再配分で隠す → unverifiedをcoverage不足として残し、live承認ゲートを分離する。
4. 見た目だけ直して主目的が改善しない → 操作数、遷移、完遂、復旧をfindingの受け入れ条件にする。

## タスク完了ログ

| 日付 | タスク | Phase | 成果物 |
|------|--------|-------|--------|
| 2026-08-24 | 承認済み計画を作業契約へ変換 | 1 | brief、scope、plan、tracker |
| 2026-08-24 | 固定rubricと機械計算を実装 | 2 | method、rubric、schema、score script、tests |
| 2026-08-24 | current-runのfresh実査を完了 | 2 | baseline 86.2、画像18枚、metrics、AI Local |
| 2026-08-24 | 最高影響findingを修正 | 3 | Local start、connector、Map、Skill、recovery |
| 2026-08-24 | 改善後の再採点と全gate検証 | 4 | 92.7、画像2枚、test results、report |
| 2026-08-24 | Cloudflare承認前パケットを作成 | 4 | hostname/policy未指定のstop条件とrollback |
| 2026-08-24 | iteration 2のローカル改善と再採点 | 4 | 日本語用語、connector実行path、Local D1 team停止・復旧・archive、92.8 |

## Archive

### Archive: Phase 1（2026-08-24 完了）

- 評価範囲、14軸、score gate、Cloudflare境界を固定した。

### Archive: Phase 2（2026-08-24 完了）

- 過去点を流用せず、56下位指標をcurrent-run evidenceで採点した。
- baselineは86.2点、coverage 97.3%、high 3件だった。

### Archive: Phase 3（2026-08-24 完了）

- 公開APIとDB schemaを変えず、high findingを3件から0件にした。
- 重点4軸をすべて96点以上、Local初回導入を73.6から96.1へ改善した。

### Archive: Phase 4（2026-08-24 完了・外部承認待ち）

- 改善後は92.7点。未検証をliveとして扱わず、最終認定を保留した。
- Cloudflare remote資源は変更していない。次回はmanaged hostnameとAccess policy IDの確定が開始条件。
- iteration 2ではLocal初回導入97.1点、チーム適合92.5点、総合92.8点になった。
- synthetic Local資源はmanifestでarchiveし、Cloudflare資源は引き続き0件である。
