# iteration 2の検証資源

## Localで作成した資源

- synthetic tenant: `ux-audit-20260824-i2`。
- ユーザー8件、グループ3件、ロール割り当て8件、メモリ6件。
- 監査manifest: `team-local-manifest.json`。
- in-app Browserの当日スクリーンショット8枚。

## 片付け結果

- メモリ6件をtrashへ移した。
- ロール割り当て8件を削除した。
- グループ3件をarchiveし、一覧0件を確認した。
- ユーザー8件を利用解除し、全件の再読込結果を確認した。
- archive結果は合計25件で、manifestへ保存した。
- Local API、Console、監査用Browser tabは停止・終了した。

## 作成・変更していない資源

- Cloudflare Worker、D1、R2、Queue、Access application、OAuth client、hook、service token。
- 既存のCodex Remote MCP設定。
- 本番または共有tenantのデータ。

Cloudflare側の変更は0件である。
