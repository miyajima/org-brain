# 3Dマップ・モーダル・部分更新の追実査

実査日: 2026-08-24  
対象: OrgBrain Console（1440×900、ja）

## 結果

- 全ノード表示: `/memories/constellation?view=all` で閲覧可能なノードを表示。fixtureでは62/62件、`truncated=false`。
- モーダル: 成果物詳細ダイアログは修正前に左上（left=0, top=0）、修正後に画面中央（left=384, top=205.898、672×488.196）。
- 3Dマップ内検索: ノード選択後もスクロール位置を維持し、インスペクターとURLだけを更新。
- Decisionマップ検索: 通常クリックを部分更新に変更。ページ上のJavaScriptマーカーが維持され、URL・見出し・マップを更新。手動スクロール不要（実測 scrollY 0→12px）。
- 修飾キー付きクリックと新規タブ操作は通常リンクとして維持。

## 画面証拠

1. `01-all-nodes-baseline.png`: 62/62件の全ノード表示。
2. `02-modal-baseline.png`: 修正前の左上配置。
3. `03-modal-centered.png`: 修正後の中央配置。
4. `04-partial-map-update.png`: Decision選択後の部分更新。

## 検証ゲート

- Console typecheck: PASS（0 errors / 0 warnings、既存hint 4件）
- Console build: PASS
- Console unit: PASS（98 tests）
- Decision Console Playwright: PASS（26 tests）
- Dashboard visualization Playwright: PASS（37 tests）
- Root lint: PASS
- `git diff --check`: PASS

## 制約

「全ノード」は権限上閲覧可能なノードが対象。APIの一回あたり上限は1,500件で、それを超える場合は省略表示を明示する。
