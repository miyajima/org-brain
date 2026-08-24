# 2026-08-24 検証結果

## 合格した検証

| 区分 | 実行内容 | 結果 |
| --- | --- | --- |
| score計算 | `node --test scripts/product-ux-scorecard.test.mjs` | 6/6 passed |
| Local CLI | `node --test scripts/local-memory.test.mjs` | 26/26 passed |
| connector | `node --test scripts/connector-setup.test.mjs` | 19/19 passed |
| Console typecheck | `pnpm --filter @org-brain/console typecheck` | 0 errors、既存hint 4件 |
| Console unit | `pnpm --filter @org-brain/console test` | 19 files、98 tests passed |
| Decision E2E | `CONSOLE_E2E_DECISION_MODE=beta pnpm --filter @org-brain/console test:e2e:decision` | 25/25 passed |
| 管理・keyboard・axe | `playwright test identity-administration keyboard-flows accessibility` | 67/67 passed |
| Node suite | `pnpm test:node` | 164 passed、0 failed |
| Console build | `pnpm --filter @org-brain/console build` | passed。500 KiB超chunk warningあり |
| lint | `pnpm lint` | passed、warning 0 |
| AI Local | `node scripts/ai-evidence-audit.mjs` | 12 validation entries passed、対象scenarioは各3回 |
| Cloud local preflight | `pnpm cf:doctor` | passed。live optionなし |
| Cloud plan | `pnpm cf:provision` | dry-run passed。変更は未実行 |
| score再計算 | `pnpm ux:score --input ... --output ...` | baseline 86.2、improved 92.7 |
| 日本語lint | `uv run scripts/lint.py --json --genre business --reading-load` | report 0 findings、0 reading-load findings。methodと承認packetは0 lint findings |

axeで自動検出違反がなかったことを、WCAG準拠とは表現しない。keyboardはPlaywright、画面状態はin-app Browser、読み上げは未実施として証拠を分離した。

## 実操作で確認したこと

- fresh Localでmigration 40/40、doctor、start、capture、searchを完遂した。
- connectorは指定CLI pathを含むdry-runまで確認した。既存Remote MCP設定を上書きしないため`--execute`は実施していない。
- ホームからDecisionは1遷移。Reason、Evidence、Artifactは各1操作で到達した。
- Mapは修正後に`aria-busy=false`、status空、canvas 1件を同時に確認した。
- Skill下書きは作成後に結果へfocusし、非公開状態と次操作を確認した。
- 個人nav、チーム招待の対象・影響・復旧・完了通知を確認した。

## 未実施

- Cloudflare deploy、D1/R2/Queueの作成・更新、Managed OAuth、cloud hook。
- synthetic tenantの作成、別ユーザー共有、招待取消、期限切れ、権限拒否のlive readback。
- Cloud側AI scenarioの各3回実行。
- VoiceOverなどによる代表フローの手動読み上げ。

これらはローカル検証の失敗ではなく、承認または専用実査条件が未充足のため未検証である。

## 対象外の既存失敗

`pnpm docs:validate`は5件中2件が失敗した。`docs/SYSTEM_DESIGN.md`の`last_updated`が既存testの期待日より古いことと、`docs/SPEC.md`に既存testが要求する`/v1/decision-briefing`表記がないことが原因である。今回この2文書には変更を加えておらず、UX評価の最終ゲートにも含まれていないため、無関係な文書改訂は行わなかった。
