# 評価用作成物と後処理

## Cloudflare

Cloudflare上の資源は作成・変更していない。新MCPホストと既存の明示的Access policy IDが監査環境へ提供されていないため、`cf provision --execute`、Managed OAuth、実ユーザーOAuth、cloud hook、別ユーザー共有は実行していない。

dry-runは非変更モードで実行し、custom hostname、Access self-hosted application、Managed OAuth、audience反映の計画だけを確認した。

## Local

- `.local/production-dump/local-state`: 既存の評価用ローカル状態を再利用。migrationは40/40適用済み、directory modeは0700。
- `apps/api-gateway/.dev.vars`: `.dev.vars.example`に記載された開発用API keyだけを設定。`.gitignore`対象で成果物には含めない。
- AI評価DB: `/private/tmp/orgbrain-ai-audit-*`へ実行ごとに新規作成し、終了時に削除。
- Playwright mock data: テストプロセス終了時に破棄。実ユーザー情報は使用していない。

失効が必要なCloudflare資格情報や、アーカイブ対象のCloudflare tenant/project/user/group/memoryは作成されていない。
