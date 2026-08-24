# OrgBrain 全体機能・UX baseline評価

現行commit `de5f9afa`を過去点から独立して採点したbaselineは、総合86.2点、coverage 97.3%だった。重大・高リスクfindingは3件あり、96点到達とは判定しない。

## 軸別点数

| 軸 | 点 |
| --- | ---: |
| わかりやすさ・メンタルモデル | 89.5 |
| 画面のシンプルさ | 91.0 |
| 操作のしやすさ | 91.5 |
| 目的へのたどり着きやすさ | 87.4 |
| 発見しやすさ・情報設計 | 94.5 |
| 状態表示・エラー回復 | 79.5 |
| 信頼・根拠・安全性 | 95.5 |
| 一貫性・コピー・多言語 | 93.5 |
| アクセシビリティ・レスポンシブ | 92.0 |
| Local初回導入 | 73.6 |
| Cloudflare初回導入 | 39.0 |
| AI提案・失敗回避 | 81.0 |
| 個人利用への適合 | 94.5 |
| チーム利用への適合 | 82.5 |

## 最大の阻害要因

1. fresh Localの`start`がmigration適用前に停止した。
2. connectorの指定CLI pathが無視され、存在しないcommandを登録し得た。
3. Mapの描画完了とstatusが矛盾した。
4. Local復旧案内、prepare出力、Skill作成後の次操作が不十分だった。
5. Cloudflare live、Cloud AI parity、別ユーザーの取消と監査は未検証だった。

計算根拠は`measurement-input.json`、機械計算結果は`scorecard.json`、改善結果は`../improved/report.md`を参照する。
