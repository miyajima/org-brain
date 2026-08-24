# iteration 3 検証結果

## 合格

| 区分 | 結果 |
| --- | --- |
| API Gateway | 50 files、274 tests passed |
| Console unit | 19 files、98 tests passed |
| Console typecheck | 0 errors、0 warnings、既存hint 4件 |
| Decision重点E2E | 28/28 passed |
| Console全体E2E | 120 passed、画面保存専用2件 skipped |
| Console build | passed。500 KiB超chunk warningあり |
| lint | passed、warning 0 |
| scorecard unit | 6/6 passed |
| Local AI | 12/12 scenario passed、各3回 |
| Cloudflare local doctor | passed |
| Cloudflare provision dry-run | passed、mutation 0件 |
| score再計算 | 93.0、coverage 97.3%、critical/high 0 |

## 実操作で確認したこと

1. 1440×900で決定一覧から詳細へ1遷移で到達した。
2. 決定、理由、根拠、成果物、スキル、利用するエージェント、結果を同じ画面で確認した。
3. Map検索後はページを再読込せず対象部分だけを更新し、scroll差分を16px以下に保った。
4. 390×844と320pxでpage-level横スクロールが発生しなかった。
5. skip linkから`main`へキーボードフォーカスが移動した。
6. 利用中ユーザーが0人でも、構成済みorganizationはチームscopeと管理導線を維持した。

## 制約

- axeの自動検査結果をWCAG準拠とは表現しない。VoiceOverによる代表フローの手動読み上げは未実施である。
- Cloudflare deploy、OAuth、hook、remote synthetic tenant作成は実施していない。
- Cloud AI parity、別principal、期限切れ、権限拒否、rollbackのlive証拠はない。
