---
title: OrgBrain product UX evaluation method
status: approved
owner: org-brain-maintainers
last_updated: 2026-08-24
method_version: 1.0.0
---

# OrgBrain product UX evaluation method

## この評価で判断すること

OrgBrainの評価は、機能が存在するかだけでは決まらない。利用者が目的を理解し、迷わず操作し、結果と根拠を確認し、失敗しても自力で戻れるところまでを一つの機能として扱う。

評価対象はLocal、Cloudflare、AI提案、Consoleの個人利用とチーム利用である。Consoleの中心導線は、正式コンセプトに従って `Decision -> Reason -> Evidence -> Artifact` とし、ホームから決定の全体像まで二遷移以内を目標にする。

## 評価対象と利用者

次の利用者と目的を、同じrunの中で分けて測る。

| 利用者 | 主な目的 |
| --- | --- |
| 初回の個人利用者 | Localを起動し、最初の記録と検索を成功させる |
| 継続利用する個人 | 必要な決定、理由、根拠、成果物へ短く到達する |
| チームowner/admin | 組織、ユーザー、グループ、共有、接続を安全に管理する |
| チームmember | 自分に許可された知識を探し、根拠と現在性を確認する |
| AIを利用する人 | 関連する提案を受け、根拠不足や競合を誤認しない |

## 14の評価軸

各軸は100点満点で採点する。重みはmethod versionの変更なしにrunごとに変えてはならない。

| ID | 評価軸 | 重み | 重点 |
| --- | --- | ---: | --- |
| clarity | わかりやすさ・メンタルモデル | 12% | yes |
| simplicity | 画面のシンプルさ | 12% | yes |
| operability | 操作のしやすさ | 11% | yes |
| goal_reachability | 目的へのたどり着きやすさ | 13% | yes |
| discoverability | 発見しやすさ・情報設計 | 7% | no |
| recovery | 状態表示・エラー回復 | 7% | no |
| trust | 信頼・根拠・安全性 | 7% | no |
| consistency | 一貫性・コピー・多言語 | 5% | no |
| accessibility | アクセシビリティ・レスポンシブ | 6% | no |
| local_setup | Local初回導入 | 5% | no |
| cloudflare_setup | Cloudflare初回導入 | 5% | no |
| ai_safety | AI提案・失敗回避 | 5% | no |
| personal_fit | 個人利用への適合 | 2% | no |
| team_fit | チーム利用への適合 | 3% | no |

下位指標と固定重みの正本は `product-ux-evaluation-rubric-v1.json` とする。

## 点数の意味

| 点 | 状態 |
| ---: | --- |
| 100 | 迷い、追加説明、無駄な操作、重大な不安なく完遂できる |
| 96 | 完遂に影響しない軽微な問題が一つまである |
| 90 | 小さな摩擦はあるが、利用者がその場で自力回復できる |
| 80 | 読み直し、後戻り、余分な遷移が必要になる |
| 60 | 文書参照または再試行が必要になる |
| 30 | 頻繁に失敗するか、危険な誤解が起きる |
| 0 | 完遂不能、または安全に利用できない |

実査担当者は下位指標ごとに0から100の整数でraw scoreを記録する。中間値を使う場合は、操作数、遷移数、時間、再試行、表示状態、または具体的な観察をnotesへ残す。

## 証拠方式による上限

点数は主張の強さを超えてはならない。複数の証拠がある場合は、最も強い方式の上限を使う。

| 証拠方式 | 上限 | 意味 |
| --- | ---: | --- |
| interactive-live | 100 | 認証や共有を含む対象環境で実操作した |
| interactive-local | 100 | freshなローカル環境で実操作した |
| automated | 92 | E2E、unit、axe、計測スクリプトで確認した |
| rendered | 90 | current runの画面を保存・目視確認した |
| static | 80 | コード、仕様、テスト定義だけを確認した |
| unverified | 0 | 必要条件がなく確認できていない |

96点以上には、その下位指標の目的を実際に完遂したinteractive evidenceが必要になる。過去runの画像、録画、scorecardは今回のraw scoreを支える証拠にしない。

## findingによる上限

findingは一つの主軸へだけ課点し、同じ問題を複数軸へ重複加算しない。波及先はfindingの`affected_axes`で追跡する。

| 重大度 | 下位指標の上限 | 例 |
| --- | ---: | --- |
| critical | 79 | データ漏えい、権限境界の破綻、不可逆な危険操作 |
| high | 79 | 主目的を完遂できない、誤った結果を正常に見せる |
| medium | 89 | 後戻り、再試行、説明参照が必要になる |
| low | 96 | 完遂には影響しない軽微な迷い、表記、余白 |
| none | 100 | findingなし |

criticalまたはhighが一件でも残るrunは、総合点にかかわらず不合格とする。

## 計算方法

1. 下位指標点は `min(raw score, evidence cap, severity cap)` とする。
2. 未検証の必須指標は0点とし、同時にcoverageを下げる。確認済み項目だけで再正規化しない。
3. 軸点は固定された下位指標重みの加重和とする。
4. 総合点は14軸の固定重みの加重和とする。
5. coverageは、証拠がある下位指標の全体重みの合計とする。
6. 表示は小数第一位へ丸めるが、合否は丸める前の値で判定する。

## 合格条件

次の条件をすべて満たしたときだけ96点到達と認定する。

- 重点4軸がそれぞれ96点以上。
- その他10軸がそれぞれ90点以上。
- 総合点が96点以上。
- coverageが95%以上。
- criticalとhighのfindingが0件。
- fresh環境で二回連続して同じゲートを通過する。
- AIシナリオが各三回で期待結果と一致する。
- Cloudflare live必須フローを承認済み環境で完遂し、`cloud_live_verified=true` とする。
- 代表フローの読み上げをVoiceOverで手動確認し、`voiceover_manually_verified=true` とする。

Cloudflare liveが未承認または未実施なら、Cloudflare必須指標はunverifiedのままにする。dry-run、認証済みCLI、ローカルmockは、OAuth、hook、別ユーザー共有、権限失効のlive証明にはならない。

## 必須フロー

1. fresh Local: prerequisites、doctor、start、capture、search、connector、復旧。
2. 個人: ホームからDecision、Reason、Evidence、Artifactへ二遷移以内。
3. Map: keyboard、2D list、reduced motion、WebGL fallbackで同じ対象を確認。
4. Skill: 選択済みの根拠からprivate draftを作り、公開前状態を確認。
5. Agent: Loadoutとeffective contextを事前確認し、除外理由を理解。
6. AI: 正常、根拠なし、競合、期限切れ、低信頼、ACL外を各三回。
7. team: owner、admin、member、招待、group、共有、拒否、revoke、audit。
8. Cloudflare: permission、doctor、provision plan、OAuth、hook、共有、expiry、parity。外部変更は別承認後。

## 画面とアクセシビリティの確認条件

- Desktop: 1440x900、1280x720。
- Mobile: 390x844、320 CSS px。
- 200%と400%相当のreflow、forced colors、reduced motion。
- keyboard、可視focus、44px操作領域、状態通知、横スクロール。
- jaを主監査言語とし、enとzhは構造、欠落copy、主要CTAを回帰確認。
- axeの合格をWCAG準拠とは表現しない。読み上げ順と名称は別証拠として記録する。

## run成果物

各runは `artifacts/product-ux-evaluation/YYYY-MM-DD/<state>/` に次を保存する。

- `measurement-input.json`: raw score、証拠方式、finding、測定値。
- `scorecard.json`: 機械計算した軸点、総合点、coverage、gate結果。
- `report.md`: 結論、主要数値、方法、finding、限界、次の一手。
- `screenshots/`: current runで取得し、目視確認した番号付き画像。
- `metrics.json`: 操作数、遷移、時間、scroll、viewport、再試行。
- `test-results.md`: 実行したcheckと結果。
- `resources.md`: 作成・変更・片付けた検証資源。秘密値は記録しない。

scorecardにはmethod version、commit、環境、証拠IDを必ず含める。評価軸や重みを変更する場合はmethod versionを上げ、旧runを同一系列として直接比較しない。

`measurement-input.json` は [product-ux-scorecard.schema.json](./product-ux-scorecard.schema.json) に適合する候補をrun外で作成し、次のコマンドで新しいphaseへ一度だけ登録する。既存phaseは上書きせず、訂正が必要な場合は新しいphaseを作る。

```sh
pnpm ux:audit:register -- --input /path/to/candidate.json --phase iteration-4
pnpm ux:score -- --input artifacts/product-ux-evaluation/YYYY-MM-DD/iteration-4/measurement-input.json --output artifacts/product-ux-evaluation/YYYY-MM-DD/iteration-4/scorecard.json
```

登録処理と採点処理は同じ公開JSON Schemaを検証する。履歴runを作り直すscore配列や、既存artifactを暗黙に更新する生成処理は置かない。
