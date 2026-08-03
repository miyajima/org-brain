# Global Codex Harness Bridge

Use the shared harness at:
- `/Users/miya/.agents/AGENTS.md`
- `/Users/miya/.agents/harness/rules/00-core.md`
- `/Users/miya/.agents/harness/rules/10-execution.md`
- `/Users/miya/.agents/harness/rules/12-ui-design.md`
- `/Users/miya/.agents/harness/rules/15-model-routing.md`
- `/Users/miya/.agents/harness/rules/20-quality-gates.md`
- `/Users/miya/.agents/harness/rules/30-prompt-injection.md`
- `/Users/miya/.agents/harness/rules/40-learning-loop.md`
- `/Users/miya/.agents/harness/skills/INDEX.md`

Also read:
- `/Users/miya/.codex/RTK.md`

If instructions conflict, use this priority:
1. Direct user request
2. Safety or platform policy
3. Tool adapter file in this workspace
4. Shared harness rules
5. Project notes below

Dispatcher contract:
- `claude -p` は使わない。
- 軽量実装は `inline_current_agent` を既定とする。
- 非自明な実装は `/Users/miya/.agents/harness/bin/run-quality-workflow.sh` で `codex_cli_roles` として役割分担する。
- Codex App の組み込み sub-agent は `codex_app_subagents` と呼び、明示的に delegate できる並列/補助作業に限る。
- 最終報告の route 表示は、別エージェントや外部 runtime に委譲した場合だけ明記する。

## Project Notes

- Context Engine と harness preflight の変更は、共有ハーネス側の bootstrap 影響も確認してください。
- `ORGBRAIN_API_URL` が canonical env 名です。`ORGBRAIN_API_BASE` は互換 alias として扱ってください。
- Cloudflare deploy を頼まれた場合は、ローカル確認だけでなく live API smoke まで実行してください。

## Cursor Cloud specific instructions

OrgBrain is a pnpm (v10.16.1) monorepo on Node 22.13+. The startup update script only runs `pnpm install`; everything below is run manually per session.

### Node / SQLite FTS5 gotcha (read this first)

The default `node` on PATH is `/exec-daemon/node`, whose bundled SQLite is compiled **without the FTS5 module**. Because the memory store relies on FTS5, using it makes `pnpm test`, the local `orgbrain` CLI, and benchmarks fail with `no such module: fts5` (about 20 node --test failures). The nvm-managed Node (v22.22.x) has FTS5. A `~/.bashrc` prepend is in place as a best-effort fix; if `command -v node` still points at `/exec-daemon/node`, run this once per shell before any Node/pnpm command:

```bash
export PATH="$HOME/.nvm/versions/node/$(ls ~/.nvm/versions/node | sort -V | tail -1)/bin:$PATH"
```

Quick check: `node -e "new (require('node:sqlite').DatabaseSync)(':memory:').exec('CREATE VIRTUAL TABLE t USING fts5(c)')"` exits 0 on the correct Node.

### Services and how to run them

Standard commands live in `README.md`, `CONTRIBUTING.md`, `package.json` scripts, and `.github/workflows/ci.yml`. Non-obvious notes:

- **Lint**: `pnpm lint` is a no-op (no package defines a `lint` script). `pnpm typecheck` (tsc + `astro check`) is the real static gate.
- **Local memory CLI (core product)**: the `orgbrain` bin is not linked, so `pnpm exec orgbrain` fails with "Command not found". Run `node ./scripts/local-memory.mjs <cmd>` or `pnpm local:memory -- <cmd>`. DB defaults to `~/.org-brain/memory.sqlite`; override with `ORGBRAIN_LOCAL_DB`.
- **API gateway Worker** (`apps/api-gateway`): apply D1 migrations, then `pnpm exec wrangler dev --port 8797 -c wrangler.local.toml --var API_KEY:dev-org-brain-api-key` (see CI). There are no `.dev.vars.example` files despite the README; pass the key via `--var`. Semantic retrieval is intentionally reported as `degraded`/unavailable locally because Workers AI + Vectorize are not bound. Smoke it with `ORGBRAIN_SMOKE_API_KEY=dev-org-brain-api-key ORGBRAIN_SMOKE_URL=http://127.0.0.1:8797 node scripts/api-integration-smoke.mjs`.
- **Console** (`apps/console`, Astro): `pnpm -C apps/console dev` binds to `localhost` which resolves to IPv6 `::1` — curl `http://localhost:4321`, not `http://127.0.0.1:4321` (the latter returns 000). To wire it to a live gateway, run `pnpm -C apps/console exec astro dev --host 127.0.0.1 --port 4321` with `API_BASE_URL=http://127.0.0.1:8797` and `INTERNAL_API_KEY=dev-org-brain-api-key` (plus `CLOUDFLARE_INCLUDE_PROCESS_ENV=true`).
- **Console e2e**: `pnpm -C apps/console test:e2e` needs a browser; run `pnpm -C apps/console exec playwright install chromium` first (browsers are not part of `pnpm install`). It manages its own mock API + dev server.
- Worker `build` scripts are `wrangler deploy --dry-run` (no real deploy). The `pnpm install` "Ignored build scripts" warning (esbuild/workerd/sharp) is harmless — wrangler and astro work without approving them.
