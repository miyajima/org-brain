# baselineで使用した検証資源

- `local-cli/orgbrain.sqlite`: fresh Local CLIのsynthetic記録1件を含む監査専用SQLite。成果物として保持。
- `.dev.vars`: Local Worker用の開発値。gitignore対象で、秘密値は成果物へ記録していない。
- `.wrangler/state`: Local D1へ40 migrationを適用。Cloudflare remote資源ではない。
- Console mock APIの招待・Skill下書き・Agent preview: process内fixtureであり、remoteまたは永続資源を作成していない。
- Cloudflare: `doctor`とprovision dry-runのみ。作成・更新・削除したremote資源は0件。
