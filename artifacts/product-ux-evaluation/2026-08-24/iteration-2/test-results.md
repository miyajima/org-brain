# iteration 2 検証結果

## 合格

| 区分 | 結果 |
| --- | --- |
| scorecard・connector・fixture unit | 28/28 passed |
| Console unit | 19 files、98 tests passed |
| Console typecheck | 0 errors、既存hint 4件 |
| Decision E2E | 25/25 passed |
| Node suite | 165 passed、0 failed |
| Console build | passed。500 KiB超chunk warningあり |
| lint | passed、warning 0 |
| Natural Japanese lint | 0 findings、reading-load 0 |
| git diff check | passed |
| Local D1 team実査 | 停止、再読込、復旧、archive、terminal readback passed |
| score再計算 | 92.8、coverage 97.3%、high 0 |

## 実査上の制約

- 初回のtypecheckとE2Eはsandboxのローカルport制限で起動できず、同じcommandを制限外で再実行して合格した。
- 復旧後のlocator取得は3秒で一度timeoutした。直後のsnapshotで保存完了通知と`active`を確認した。
- Cloudflare deploy、OAuth、hook、remote data変更は実施していない。
- VoiceOverは実施していない。
