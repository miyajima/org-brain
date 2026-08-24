# 実行計画: OrgBrain 全体機能・UX評価と96点到達

> 与件は `scope.md`、進捗は `tracker.md` を参照する。

---

## フェーズ構成

| Phase | 名称 | 目的 | 主な成果物 |
|-------|------|------|-----------|
| 1 | 与件固定 | 承認済み計画を評価契約へ変換 | scope、plan、tracker |
| 2 | fresh実査 | 現行点と最高影響findingを確定 | baseline artifacts |
| 3 | 改善 | 一つの利用者目的ずつ改善・再評価 | code、tests、iterations |
| 4 | 仕上げ | 最終scorecardと未検証境界をまとめる | report、summary |

## Phase 2: fresh実査

### タスク

- 評価方法、rubric、schema、validatorを実装する。
- Local、AI、Console個人／チームをfreshに操作・測定する。
- スクリーンショットを取得し、各ステップとfindingを結び付ける。
- Cloudflareはread-only/dry-runまで測定する。
- Pre-Mortemを記録する。

### Done シグナル

- 14軸すべてに点数またはunverified理由がある。
- scorecardをvalidatorで再計算できる。
- 重要フローごとにcurrent-runの画面証拠がある。

## Phase 3: 改善

### タスク

- 重大度、重点軸の点差、影響フロー数、修正規模の順にfindingを並べる。
- 最高影響の利用者目的を最小diffで改善する。
- focused testと影響フローの再撮影・再採点を行う。
- 全体scorecardを更新し、必要な次反復だけを行う。

### Done シグナル

- 重大・高findingが0件。
- ローカルで実証可能な重点軸が96点以上。
- 実装とテストの根拠がscorecardへ結び付く。

## Phase 4: 仕上げ

### タスク

- 最終レポート、scorecard、番号付き操作ステップ、証拠索引を確定する。
- typecheck、unit、Playwright、AI、build、lint、score再計算を通す。
- Cloudflare live承認パケットを作る。
- natural-japaneseのlintと目視レビューを通す。

### Done シグナル

- 結論、主要数値、方法、限界、次の一手がレポート冒頭で分かる。
- 実行済みと未実施が区別されている。
- 変更diffにunrelatedな内容や秘密値がない。

## 成果物一覧

### context/（中間成果物）

| # | ファイル | Phase | 内容 |
|---|---------|-------|------|
| 05 | `context/05_preflight.md` | 2 | Git、探索、モデル、環境 |
| 10 | `context/10_baseline_findings.md` | 2 | 現行findingと優先順位 |
| 15 | `context/15_pre_mortem.md` | 2 | 失敗シナリオと対策 |

### output/（確定成果物）

| # | ファイル | Phase | 内容 |
|---|---------|-------|------|
| 00 | `output/00_summary.md` | 4 | 全体サマリーと成果物導線 |

## レビュー設計

- Phase 2: scorecard schema・証拠coverage・画面証拠を自己レビューする。
- Phase 3: 各改善をfocused testと画面比較で確認する。
- Phase 4: 全体diff、score再計算、文書構造を通しで確認する。
- サブエージェントは現行の明示的委任制約により使用しない。

## Critical Files（参照点）

- `docs/CONCEPT.md`: Decision中心の製品約束と2遷移条件
- `apps/console/e2e/route-audit-cases.ts`: 既存画面状態・操作マトリクス
- `scripts/ux-improved-scorecard.mjs`: 置換対象の手入力scorecard生成

