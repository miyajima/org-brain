# OrgBrain 全体機能・UX評価と96点到達状況

## 結論

結果は明確だった。現行commit `de5f9afa`をfreshに再評価し、同じ固定rubricで改善前86.2点から改善後92.7点へ上げた。重点4軸はすべて96点以上、coverageは97.3%、重大・高リスクfindingは3件から0件になった。

まだ96点ではない。未検証なのは次の四つである。

- Cloudflare live。
- Cloud AI parity。
- 別ユーザーのrevokeとaudit。
- 手動読み上げ。

Cloudflareは40.0点、AIは82.0点である。チーム適合は88.5点、総合は92.7点に留まる。dry-runやmockをlive証拠へ読み替えず、scorecardは暫定のままにした。

## 改善前後の点数

| 評価軸 | 改善前 | 改善後 | 差 | 合格線 | 状態 |
| --- | ---: | ---: | ---: | ---: | --- |
| わかりやすさ・メンタルモデル | 89.5 | 97.5 | +8.0 | 96 | 合格 |
| 画面のシンプルさ | 91.0 | 96.8 | +5.8 | 96 | 合格 |
| 操作のしやすさ | 91.5 | 96.3 | +4.8 | 96 | 合格 |
| 目的へのたどり着きやすさ | 87.4 | 98.1 | +10.7 | 96 | 合格 |
| 発見しやすさ・情報設計 | 94.5 | 96.5 | +2.0 | 90 | 合格 |
| 状態表示・エラー回復 | 79.5 | 96.0 | +16.5 | 90 | 合格 |
| 信頼・根拠・安全性 | 95.5 | 97.0 | +1.5 | 90 | 合格 |
| 一貫性・コピー・多言語 | 93.5 | 95.0 | +1.5 | 90 | 合格 |
| アクセシビリティ・レスポンシブ | 92.0 | 92.0 | 0.0 | 90 | 合格・自動証拠上限 |
| Local初回導入 | 73.6 | 96.1 | +22.5 | 90 | 合格 |
| Cloudflare初回導入 | 39.0 | 40.0 | +1.0 | 90 | 未達 |
| AI提案・失敗回避 | 81.0 | 82.0 | +1.0 | 90 | 未達 |
| 個人利用への適合 | 94.5 | 97.0 | +2.5 | 90 | 合格 |
| チーム利用への適合 | 82.5 | 88.5 | +6.0 | 90 | 未達 |
| **総合** | **86.2** | **92.7** | **+6.5** | **96** | **未達** |

差は6.5点だった。

## 実装した改善

1. fresh Localの起動順を直した。migration不足だけはprepare後に再検査し、`doctor -> start`を完遂できる。
2. `local:prepare`の成功出力を、3,544行から適用数・state dir・所要時間の短いJSONへ変えた。
3. SQLite権限エラーに、対象pathを含むcopy-paste可能な復旧操作を追加した。
4. 不正な`work-type`を成功扱いにせず、許容値をhelpへ列挙した。
5. connectorの`--cli-path`をNode実行pathとともに登録計画へ反映した。
6. Map描画後のstatusを消し、`aria-busy=false`と画面文言を一致させた。
7. Skill下書き生成後に結果へfocusし、「まだPublishされていない」状態と「下書きの内容を確認」を明示した。

公開APIとDB schemaは変更していない。既存のRemote MCP設定を保護するため、local connectorの`--execute`は行っていない。

影響範囲は絞った。

## 番号付き操作ステップと結果

### 個人の中心導線

1. ホームを開く。主Decisionと次操作を確認する。
2. Decisionを選ぶ。1遷移、235ms、後戻り0回で詳細へ到達した。
3. Reasonを選ぶ。1操作で理由を確認した。
4. Evidenceを選ぶ。1操作で根拠と現在性を確認した。
5. Artifactを選ぶ。1操作で成果物へ到達した。

ホームからDecisionは二遷移以内の条件を満たし、今回のfixtureでは1遷移だった。

後戻りは0回だった。

### Map、Skill、Agent

1. DecisionからMapを開く。修正後はcanvas 1件、`aria-busy=false`、status空を確認した。
2. 根拠を選んでSkill private draftを生成する。結果へfocusが移り、未Publish状態と次操作が表示された。
3. Agent Loadout previewを実行する。注入、on-demand、除外を分けて確認した。

### Local初回導入

1. fresh stateでdoctorを実行し、migration不足を確認する。
2. startを実行する。prepareと40 migrationの再検査を経て起動した。
3. captureでsynthetic記録を1件保存する。不正な`work-type`は非0で拒否された。
4. searchで同じ記録1件を取得する。
5. connector dry-runでNodeと指定CLI絶対pathを確認する。既存Remote設定を上書きしないため登録実行は止めた。

再試行は0回だった。

### チーム管理

1. 個人modeでは管理navが抑制され、「チームで使う」が入口になることを確認した。
2. owner fixtureでユーザー招待を入力した。
3. 確認dialogで対象、影響、復旧方法を確認した。
4. 適用後に完了通知を確認した。

招待以降の別ユーザーreadback、拒否、取消、監査はmockで合格扱いにせず残した。

## 画面証拠

- baseline 18枚、改善後2枚を当日runで取得した。
- Desktop 1440x900、1280x720、mobile 390x844、320 CSS px、200%・400%相当、forced colors、reduced motionを確認した。
- jaを実査言語にし、en/zhは構造、CTA、横scrollを自動回帰した。
- 390x844のホームは横overflowなし。主カード下端は初期viewportから8.3px下だったが、Decision title linkは初期表示内で操作できた。

in-app Browserのfull-page画像は、高DPI合成の都合で右側に余白が入る場合がある。DOM計測と複数viewportの自動検査では横overflowなしを確認しており、画像だけをlayout合格の根拠にはしていない。

画像だけには頼っていない。

## 残るfinding

| ID | 重大度 | 内容 | 完了条件 |
| --- | --- | --- | --- |
| F-I01 | low | 日本語画面に英語プロダクト用語が一部残る | 用語規約と初出補助をja全体へ適用 |
| F-I02 | low | connector登録実行は既存設定保護のため未実施 | 隔離した設定領域または明示承認で登録とreadback |
| F-I03 | medium | OAuthとcloud hookが未実査 | reviewed host/policyでlive完遂 |
| F-I04 | medium | Cloud否定系とrollbackが未実査 | synthetic tenantで二回連続合格 |
| F-I05 | medium | AIのCloud parityが未実査 | 12 scenarioをLocal/Cloud各3回一致 |
| F-I06 | medium | 別ユーザーhandoffとauditがfixture止まり | owner/admin/memberの永続readback |
| F-I07 | medium | revoke、期限切れ、権限拒否が未実査 | 作成・取消・監査を同じmanifestで確認 |

## 92.7点から96点以上へ進める計画

優先順位は、安全、完遂不能、重点軸の点差、影響利用者数、修正規模の順とする。

1. **承認入力を固定する。** managed MCP hostname、既存Access policy ID、synthetic tenant名、rollback owner、source SHA、build digestを`cloudflare-approval-packet.md`へ確定する。
2. **同一artifactを限定投入する。** local validationとdry-runを再実行し、明示承認後だけdeployする。想定外のresource、digest差、policy差があれば停止する。
3. **認証と復旧を一件ずつ実査する。** 401 discovery、user OAuth、service-token hook、期限切れ、tenant拒否、revoke、rollbackを番号順に確認する。
4. **チーム境界を実証する。** owner、admin、member、denied principalを分け、招待、group、共有、handoff、取消、audit terminal readbackを保存する。
5. **AI parityを実証する。** 同じ12 scenarioをLocalとCloudで各3回実行し、関連性、抑制、競合、ACL外、期限切れの一致を確認する。
6. **読み上げを人手で確認する。** Decision導線、Skill完了、招待確認、エラー復旧の名称、順序、状態通知を記録する。axe合格とは分ける。
7. **二回連続gateを通す。** fresh環境を作り直し、全56指標を再計算する。重点4軸各96以上、他軸各90以上、総合96以上、coverage 95%以上、高リスク0を二回連続で満たす。

残る4軸を各96点へ上げる。他軸が現状を維持した場合の見込み総合点は約96.7である。これは目標値であり、live証拠取得前の実績点ではない。

二反復連続で点が上がらない場合は、同じUI修正を重ねない。阻害要因を次の四つに分け、証拠付きで独立issueへ切り出す。

- Cloudflare権限。
- synthetic tenantの分離。
- 認証provider。
- screen-reader検証環境。

## 証拠と限界

- 評価方法: `docs/PRODUCT_UX_EVALUATION_METHOD.md`
- 固定rubric: `docs/product-ux-evaluation-rubric-v1.json`
- 入力: `measurement-input.json`
- 機械計算: `scorecard.json`
- 測定値: `metrics.json`
- 検証: `test-results.md`
- 資源: `resources.md`
- Cloud承認前確認: `cloudflare-approval-packet.md`

VoiceOverは未実施である。axe 67件の自動検査合格をWCAG準拠とは表現しない。Cloudflareはread-onlyとdry-runまでで、remote資源の作成・変更・削除は0件である。

参考実行した`docs:validate`には、今回未変更の`SYSTEM_DESIGN.md`と`SPEC.md`に由来する既存失敗が2件ある。UX評価の指定gateは合格しており、この作業では無関係な文書改訂を混ぜなかった。
