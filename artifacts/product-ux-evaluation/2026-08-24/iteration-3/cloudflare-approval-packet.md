# Cloudflare live実査 承認前パケット（iteration 3）

## 現在の判定

`not ready for execute`。local doctorとprovision dry-runは合格し、Cloudflare resource変更は0件だった。次の値が未確定のため、deploy、OAuth、hook、remote data作成は実行しない。

- managed MCP hostname
- 既存のleast-privilege Access policy ID
- rollback owner
- 全Workerを同一buildで固定したimmutable artifact digest

## 現在確認できた値

| 項目 | 値 |
| --- | --- |
| Cloudflare account | `a29b6624dfc165268c04d67222afe1b2` |
| synthetic tenant候補 | `ux-audit-20260824-cloud-i3` |
| source commit | `de5f9afa649ec3da1e144652a7e9958a0c55b10d` |
| tracked worktree diff digest | `sha256:3b073e2ecc1d7e4a5c7988527ecd5dffe20bdc2691ec06c857272089a81d68e3` |
| current Console build contents digest | `sha256:330449f4b2c999ad5713f8ac9bb8387a45aef530fdf25af339d154b981bb6850` |
| MCP hostname | `<reviewed-managed-hostname>` |
| Access policy ID | `<existing-least-privilege-policy-id>` |
| rollback owner | `<担当者>` |

tracked diffとConsole digestは承認前の識別値であり、deploy対象の最終immutable artifact digestではない。未追跡の評価artifactをdeploy対象へ含めない。実行直前に全Worker buildを固定し、digestを再提示する。

## dry-runで確認した変更予定資源

- D1 `open-brain`とadditive migrations。
- R2 `open-brain-bucket`。
- queues: `org-bus`、`org-bus-dlq`、`cap-plan`、`cap-plan-dlq`、`orgbrain-retrieval-projection-v3`、`orgbrain-retrieval-projection-v3-dlq`。
- Workers: cap-runner、org-router、retrieval-projector、api-gateway、mcp、console。
- managed OAuthを有効にする場合だけ、`/mcp*`のAccess self-hosted application、指定済みpolicy、`MCP_ACCESS_AUD` secret。
- synthetic tenant内だけの監査用user、group、共有、Decision、Skill、client enrollment。

## 実行順とstop条件

1. account、hostname、policy ID、source SHA、全artifact digest、remote resource差分をread-onlyで再確認する。
2. 同一artifactをdeployする。既存flagは変更しない。
3. unauthenticated 401、resource metadata、authorization metadata、audienceを確認する。
4. 承認済みuser OAuthと1件のservice-token hookを確認する。
5. synthetic tenantでowner、admin、member、denied principalを分け、共有、期限切れ、revoke、audit readbackを行う。
6. LocalとCloudでAI 12 scenarioを各3回比較する。
7. fresh条件で全scorecard gateを2回連続実行する。
8. 予期しないresource、cross-tenant可視化、認証逸脱、migration差分、digest不一致が1件でもあれば停止する。

## rollback

- feature flagを`off`へ戻し、直前のWorker versionへrollbackする。
- additive migrationはdownしない。新規authorityへの切替だけを戻す。
- synthetic tenantの作成物をmanifest IDでarchive/revokeし、terminal readbackを保存する。
- Access applicationは既存なら元設定へ戻す。今回新規作成する場合は、承認範囲内で削除する。

## 承認後に再表示するcommand

```bash
pnpm exec orgbrain cf provision --root . \
  --with-managed-oauth \
  --mcp-host <reviewed-managed-hostname> \
  --access-policy-id <existing-least-privilege-policy-id>
```

このdry-runとremote差分を再提示した後にだけ、同じ引数へ`--execute`を加える。
