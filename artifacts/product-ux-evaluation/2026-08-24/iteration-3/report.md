# OrgBrain 全体機能・UX評価 iteration 3

## 結論

前回92.8点を現状値として改善し、93.0点になった。重点4軸はすべて96点以上、coverageは97.3%、critical/high findingは0件である。Cloud liveを未検証のまま96点へ丸めず、固定rubric、証拠上限、重大度上限をそのまま適用した。

96点には未到達である。Cloudflare初回導入40.0点とAI提案82.0点が未達で、Cloud live、Cloud AI parity、別principal、期限切れ、権限拒否、rollbackの実操作証拠が必要である。

## 全軸の点数

| 評価軸 | iteration 2 | iteration 3 | 合格線 | 状態 |
| --- | ---: | ---: | ---: | --- |
| わかりやすさ・メンタルモデル | 97.5 | 97.5 | 96 | 合格 |
| 画面のシンプルさ | 96.8 | 97.0 | 96 | 合格 |
| 操作のしやすさ | 96.3 | 96.5 | 96 | 合格 |
| 目的へのたどり着きやすさ | 98.1 | 98.3 | 96 | 合格 |
| 発見しやすさ・情報設計 | 96.5 | 96.5 | 90 | 合格 |
| 状態表示・エラー回復 | 96.0 | 96.0 | 90 | 合格 |
| 信頼・根拠・安全性 | 97.0 | 97.0 | 90 | 合格 |
| 一貫性・コピー・多言語 | 95.0 | 96.0 | 90 | 合格 |
| アクセシビリティ・レスポンシブ | 92.0 | 92.0 | 90 | 合格・自動証拠上限 |
| Local初回導入 | 97.1 | 97.1 | 90 | 合格 |
| Cloudflare初回導入 | 40.0 | 40.0 | 90 | 未達 |
| AI提案・失敗回避 | 82.0 | 82.0 | 90 | 未達 |
| 個人利用への適合 | 97.0 | 97.0 | 90 | 合格 |
| チーム利用への適合 | 92.5 | 92.5 | 90 | 合格 |
| **総合** | **92.8** | **93.0** | **96** | **未達** |

## 実装した改善

1. 決定一覧、決定の道筋、レビュー、資料、アクセス設定の主要語を日本語優先へ統一した。
2. Mapで検索結果や決定リンクを選んだ後、ページを再読込せずMap部分だけを更新するようにした。ページmarkerを保持し、scroll差分を16px以下にした。
3. resource詳細と管理確認のmodalを画面中央へ配置した。アクセス設定はmodalではなく既存設計の右drawerとして維持した。
4. skip linkの移動先をURL fragmentだけでなく`main`の実フォーカスへ同期した。
5. 構成済みorganizationでは、active user/groupが0件になっても暗黙に個人scopeへ切り替えず、チームscopeと管理導線を維持した。
6. 390pxと320pxでpage-level横overflowがなく、主要CTAと最初の決定が初期viewport内にあることを確認した。

公開APIとDB schemaは変更していない。

## 主要フローと健康状態

1. 決定一覧: 良好。目的、主CTA、最初の決定を初期表示内で理解できる。
2. 決定詳細: 良好。1遷移で到達し、決定から結果までを同じ画面で追える。
3. Map検索・ノード選択: 良好。部分更新で文脈とscroll位置を維持する。
4. 共有範囲: 良好。日本語ラベルで自分、project、group、team、指定対象を区別できる。
5. mobile: 良好。390px/320pxともpage-level横scrollなし。
6. チームarchive後: 良好。scopeが個人へ誤って切り替わらない。
7. Cloud OAuth・hook・別principal: 未検証。承認前なので実行していない。

## 残るfinding

| ID | 重大度 | 内容 | 完了条件 |
| --- | --- | --- | --- |
| F-I3-01 | low | 管理・技術詳細を含む全ja画面の用語監査は未完了 | 全ja画面へ用語規約を適用 |
| F-I3-02 | low | 実Codex設定への登録とreadbackは未実施 | 隔離設定または明示承認で登録 |
| F-I3-03 | medium | OAuthとcloud hookが未実査 | reviewed host/policyでlive完遂 |
| F-I3-04 | medium | Cloud否定系とrollbackが未実査 | 同一artifactで2回連続合格 |
| F-I3-05 | medium | Cloud AI parityが未実査 | 同一scenarioを各3回比較 |
| F-I3-06 | medium | 別principal本人としての共有・audit未実査 | principalを分離してreadback |
| F-I3-07 | medium | 期限切れ招待とdenied principalが未実査 | 否定系と復旧を別fixtureで確認 |

iteration 2のF-I2-08は修正済みである。

## 96点までの残り

Cloudflare live実査で`cloudflare_setup`を90以上、Cloud AI parityで`ai_safety`を90以上にし、別principalと否定系を完遂する。その後、VoiceOverの代表フローとfresh環境2回連続合格を確認する。実行条件は`cloudflare-approval-packet.md`へ固定した。

axeの自動検査をWCAG準拠とは表現しない。VoiceOver、Cloudflare live、別principal本人としての操作は未実施である。
