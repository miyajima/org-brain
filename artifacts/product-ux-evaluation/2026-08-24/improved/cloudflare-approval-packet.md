# Cloudflare live実査 承認前パケット

## 現在の判定

`not ready for execute`。local validationとprovision dry-runは完了したが、次の二つが未確定である。

- managed MCP hostname: 未指定。既存のworkers.dev URLを、review済みmanaged DNS hostnameとは扱わない。
- Cloudflare Access policy ID: 未指定。allow-all policyを自動作成しない。

この二値が確定するまで、deployやCloudflare API mutationは実行しない。

## 承認時に固定する値

| 項目 | 承認値 |
| --- | --- |
| 対象account | `<CLOUDFLARE_ACCOUNT_IDを実行時に照合>` |
| MCP hostname | `<reviewed-managed-hostname>` |
| Access policy ID | `<existing-least-privilege-policy-id>` |
| synthetic tenant | `<ux-audit-YYYYMMDD>` |
| source commit | `de5f9afa649ec3da1e144652a7e9958a0c55b10d`と承認済み差分 |
| immutable artifact | `<build後のdigestを承認直前に記録>` |
| rollback owner | `<担当者>` |

## 変更予定資源

- D1 `open-brain`とadditive migrations。
- R2 `open-brain-bucket`。
- 6 queues。
- cap-runner、org-router、retrieval-projector、api-gateway、mcp、console Workers。
- `/mcp*`のAccess self-hosted application。指定済みpolicyだけを関連付ける。
- API Gatewayの`MCP_ACCESS_AUD` secret。
- synthetic tenant内だけの監査用ユーザー、group、共有、Decision、Skill、client enrollment。

## 実行順とstop条件

1. remote state、account、hostname、policy ID、source SHA、build digestをread-onlyで再確認する。
2. 同一artifactでdeployし、flagは既存状態を保持する。
3. unauthenticated 401、resource metadata、authorization metadata、audienceを確認する。
4. 承認済みユーザーOAuthと、一件のservice-token hookを確認する。
5. synthetic tenantでowner、admin、member、denied principalを分け、共有、期限切れ、revoke、audit readbackを行う。
6. LocalとCloudでAI 12 scenarioを各3回比較する。
7. 同じfresh条件で全scorecard gateを二回連続実行する。
8. 予期しないresource、cross-tenant可視化、401以外の認証逸脱、migration差分、digest不一致が一件でもあれば停止する。

## rollback

- feature flagを`off`へ戻し、直前のWorker versionへrollbackする。
- additive migrationはdownしない。新規authorityへの切替だけを戻す。
- synthetic tenantの作成物をmanifest IDでarchive/revokeし、terminal readbackを保存する。
- Access applicationは既存なら元の設定へ戻し、今回新規作成なら承認範囲内で削除する。

## 承認後に実行するcommand形

```bash
pnpm exec orgbrain cf provision --root . \
  --with-managed-oauth \
  --mcp-host <reviewed-managed-hostname> \
  --access-policy-id <existing-least-privilege-policy-id>
```

計画を再表示して差分を確認した後にだけ、同じ引数へ`--execute`を加える。
