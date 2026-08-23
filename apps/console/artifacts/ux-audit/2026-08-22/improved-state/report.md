# OrgBrain UX改善後評価

## 結論

実装とローカル検証では、AI根拠判定、ローカル起動、個人／チーム管理画面、用語統一、アクセシビリティの主要改善が完了した。再計算値は **88.6点** だが、これは **暫定** であり完了判定には使わない。全項目coverageは88.0%、Cloudflare領域は42.9%に留まる。

| 領域 | 改善後 | coverage | 判定 |
| --- | ---: | ---: | --- |
| ローカルセットアップ | 90.0 | 100% | local確認済み |
| Cloudflareセットアップ | 90.0 | 42.9% | 暫定・dry-runのみ |
| AI提案・失敗回避 | 91.3 | 94.1% | Local確認済み、Cloud parity未検証 |
| 管理画面・一人利用 | 84.3 | 100% | mock-backed local確認済み |
| 管理画面・チーム利用 | 85.5 | 100% | mock-backed local確認済み |
| 総合 | 88.6 | 88.0% | **暫定・完了未認定** |

全75項目の点数／N/A、重み、再計算式は `scorecard.json` に記録した。N/Aは推測採点せず領域内で再正規化している。

## 実装結果

### P0 AI根拠判定

LocalとAPI Gatewayが共通のevidence dispositionを使用するようにし、`sufficient / degraded / insufficient / conflicted`を追加した。extractor縮退と低信頼度は回答可能な`degraded`、根拠なし・独立資料不足は`insufficient`、未解決競合は`conflicted`となる。棄却テンプレートは後者2状態だけに限定した。

freshな一時DBで12シナリオを各3回実行した。Localで適用可能な11シナリオは全検証に合格し、正常根拠3/3非棄却、根拠なし・期限切れのみ・複数資料不足・競合3/3棄却、低信頼度3/3非棄却、ACL外／別tenant 0件、3回のmemory ID集合一致を確認した。LocalにユーザーOAuth境界がない`auth_failure`はN/Aとした。

### P0 Remote MCP / Managed OAuth

専用`apps/mcp` edge、正式`/mcp` URL、Console `/api`経路の拒否、Managed OAuth provisioning plan、明示的Access policy必須化、discovery／401 challenge／audience／service tokenを分けたlive doctorを実装した。旧authは`dual`で1リリース互換とした。

ただし新MCPホストと明示的Access policy IDがないため、Cloudflareへ変更を適用していない。実ユーザー`codex mcp login`、cloud hook、期限切れOAuth、tenant拒否、別ユーザー共有は未検証で、P0の実装は完了していてもP0のlive証明は未完了である。

### P1 ローカル／CLI

`orgbrain cf`を正式namespaceとし、`cloud`は警告付きaliasにした。`version --json`へpackage version、commit、build日時を追加し、checkout差分と再インストールコマンドをdoctorで表示する。`local:prepare / local:doctor / local:start`を追加し、同じpersist先への冪等migration、前提条件とport確認、API/Console起動、health check、初回利用手順、Ctrl-C停止を一経路にした。

fresh実行では40/40 migration、保存先0700、API `:8787`、Console `:4321`、`/v1/auth/me`成功、次手順表示を確認した。

### P1 管理画面

`/v1/auth/me.data.console_context`へpersonal/team、実効権限、管理能力、tenant/project、active件数を追加した。personalでは組織管理メニューを隠して「チームで使う」へ集約し、teamでは現在地を常時表示する。旧APIは従来ナビへfallbackする。

ユーザー招待・権限変更・グループ所属・client revokeへ対象／影響／復旧可能性の確認dialogを追加した。enrollment成功画面は一度だけのcode、copy可能なCLI command、期限、接続確認、revoke復旧を同時表示する。

### P2 文言・アクセシビリティ・fixture

BaseLayout、Memories、Tasks、Domain Packs、Client installations、Organization、Groupsの文言を型付き`console-locale.ts`へ集約し、Usersは既存の型付き`admin-copy.ts`を使用する。日本語のTask／Pack／credential混在を主要導線で修正した。

公開APIだけを使う`ux-fixture.mjs`を追加し、owner/admin/6 members、3 groups、2 project IDs、共有・制限・競合・低信頼度・期限切れmemoryを冪等にapply/archiveできるようにした。秘密値はmanifestへ出力しない。

## 検証結果

- Shared: 22 files / 100 tests passed
- API Gateway: 48 files / 269 tests passed
- Console unit: 19 files / 98 tests passed
- CLI / Local / fixture focused: 53 tests passed
- Playwright指定4 suite: 70 tests passed
- axe対象route、390×844、200%／400%相当、forced colors、keyboard flow: passed
- 改善後スクリーンショット: 5枚取得して目視確認
- VoiceOver: N/A。自動検査と分離し、準拠とは判定していない

## 残る完了条件

1. reviewedなMCP hostnameと既存Access policy IDを指定し、同一buildをCloudflareへ投入する。
2. `cf doctor --live`で401 challenge、RFC discovery、audience、Codex user OAuth、service-token hook、tenant拒否、期限切れ復旧を完遂する。
3. cloud fixtureを限定tenantへapplyし、Local／Cloudflareの12シナリオ×3 parityと別ユーザー共有を実証後にarchiveする。
4. VoiceOverで読み上げ順、名称、状態変化、エラー通知を手動記録する。
5. 上記完了後にscorecardを再生成し、coverage 90%以上かつP0 live evidence gap 0件で初めて86点達成を確定する。

## 証拠索引

- `L-01`: `setup-metrics.csv`、`local:doctor`／`local:start` fresh実行
- `L-02`: focused CLI tests、README主経路
- `CF-01`: `cf provision` dry-run、cloud operation unit tests、`created-resources.md`
- `AI-01`: `ai-scenarios.json`
- `UI-01`: `screenshots/01`〜`05`
- `UI-02`: `browser-diagnostics.json`
- `FX-01`: `ux-fixture.mjs`とfixture tests
