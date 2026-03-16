# org-brain

Cloudflare-based org bus MVP with Hono API and Astro console.

## Structure
- `apps/api-gateway` - Hono API Worker
- `apps/org-router` - org-bus Queue router Worker
- `apps/cap-runner` - capability workers + DOs
- `apps/orchestrator` - Workflow host
- `apps/mcp` - legacy Remote MCP Worker (kept for compatibility)
- `apps/console` - Astro Pages console
- `packages/shared` - shared types/schemas/utils
- `migrations` - D1 SQL migrations

## Quick Start
1. `pnpm install`
2. Configure `wrangler.toml` values (`database_id`, bucket, queues, API keys)
3. Apply migrations to D1 (`migrations/*.sql`)
4. Deploy workers/pages in dependency order:
   - orchestrator
   - cap-runner
   - org-router
   - api-gateway
   - console

## Commands
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm hook:bridge`
- `pnpm sync:openclaw-memory`
- `pnpm usage:status`
- `pnpm metrics:report`
- `pnpm metrics:replay`
- `pnpm metrics:rollup`

## Knowledge Docs
Org Brain now includes a docs layer for interlinked markdown knowledge docs. This is a navigation and retrieval interface for humans and agents, not the system of record.

- D1 tables: `knowledge_docs`, `knowledge_links`, `knowledge_docs_fts`
- R2 stores long-form markdown bodies
- Required frontmatter: `id`, `title`, `scope`, `kind`, `tags`, `stability`, `updated_at`
- Supported scopes: `org`, `department`, `project`, `capability`, `workflow`, `policy`

API surface:
- `POST /v1/docs`
- `GET /v1/docs/:slug`
- `POST /v1/docs/search`
- `GET /v1/docs/:slug/context`

Storage rules:
- Short docs stay inline in D1 and are fully indexed
- Long docs store full markdown in R2 and keep only excerpt + metadata in D1
- `[[slug]]` wiki links are extracted on save and resolved into `knowledge_links`

Progressive disclosure:
- Start from MOC docs such as `ORG` or `capabilities/_index`
- Read summaries before full markdown
- Use `/v1/docs/:slug/context` or `loadContext()` for bounded 1-hop expansion

Template utility:

```ts
import { generateMocTemplates } from "@org-brain/shared";

const templates = generateMocTemplates({
  updatedAt: "2026-03-13",
  departmentSlugs: ["engineering", "support"],
  projectSlugs: ["project-x"]
});
```

Each template returns a `slug`, repo-style docs `path`, and rendered markdown for initial MOC scaffolding.

## Usage Snapshot
For a current operator view of Org Brain usage, query Cloudflare D1 directly:

```bash
pnpm usage:status
pnpm usage:status -- --tenant default --json
```

The snapshot reports task totals/statuses, active tasks, capability/project breakdowns, memory/thread counts, and recent tasks with JST timestamps.

## Retrieval Metrics
Retrieval telemetry is stored in D1 as `retrieval_events`, with day-level rollups in `retrieval_daily_metrics`.

- `memory.search` task events are appended for per-task drill-down
- raw retrieval telemetry is retained for 90 days
- `open-brain-cap-runner` rolls up the previous UTC day and prunes old raw events on a daily cron

Examples:

```bash
pnpm metrics:report
pnpm metrics:report -- --tenant default --days 14 --json
pnpm metrics:replay -- --tenant default --limit 20 --json
pnpm metrics:rollup -- --day 2026-03-10 --json
```

`metrics:report` focuses on retrieval hit/fallback/latency plus service success and duration.
`metrics:replay` compares `legacy_recent_v1` versus `bm25_v1` against the current D1/R2 snapshot without persisting anything.
`metrics:rollup` recomputes one UTC day idempotently into `retrieval_daily_metrics`.

## OpenClaw Memory Bridge
Cloudflare D1 is the source of truth. OpenClaw `main.sqlite` remains a local cache/index.

Set env vars and run:

```bash
export ORGBRAIN_API_BASE="https://<api-gateway-host>"
export ORGBRAIN_API_KEY="<x-api-key>"
pnpm sync:openclaw-memory
```

Optional env vars:
- `SYNC_DIRECTION=both|import|export` (default: `both`)
- `OPENCLAW_MEMORY_DB=~/.openclaw/memory/main.sqlite`
- `OPENCLAW_WORKSPACE=~/clawd`
- `ORGBRAIN_TENANT_ID=default`

## Agent Hook Bridge
`pnpm hook:bridge` is the shared upsert bridge used by local agent hooks.

```bash
export ORGBRAIN_API_BASE="https://open-brain-console.pages.dev/api"
export ORGBRAIN_API_KEY="via-pages-proxy"
export ORGBRAIN_TENANT_ID="default"

printf '{"type":"agent-turn-complete","cwd":"/tmp/demo"}' | pnpm hook:bridge codex
```

The hook bridge now promotes only reusable memories. Generic `agent-turn-complete` chatter is skipped with
`{"ok":true,"skipped":"low-signal-memory"}` instead of being upserted. Promoted records are distilled into
`# Reusable Memory` entries with takeaway, evidence, and reuse-rule sections to keep FTS noise low.

The bridge also loads fallback env files from:
- `~/.config/org-brain/hooks.env`
- `~/.openclaw/.env`
- `~/.agents/.env`

When `ORGBRAIN_API_BASE` points at the console proxy (`...pages.dev/api`), the incoming `x-api-key` is ignored and replaced by the Pages secret, so the local `ORGBRAIN_API_KEY` value only needs to be non-empty.

Hook-enabled clients currently wired for Org Brain memory upserts:
- Codex
- Claude Code
- Cursor
- OpenClaw
- OpenCode

Antigravity was not wired because no stable user hook entrypoint was confirmed in the installed app/config.

## Remote MCP
Remote MCP is served directly by `api-gateway` at `/mcp`.

1. Configure `api-gateway` secrets/vars:
   - `MCP_SERVICE_TOKENS_JSON` (service token JSON with `client_id`, `client_secret`, `principal`, `tenants`)
   - optional `MCP_TENANT_POLICY_JSON` (principal -> tenant mapping JSON)
2. Configure your MCP client to send `CF-Access-Client-Id`, `CF-Access-Client-Secret`, and `x-orgbrain-tenant`.
3. Deploy `api-gateway`.

Optional: if you want browser login later, you can layer Cloudflare Access in front of the hostname and add the corresponding JWT verification settings then.

See [docs/REMOTE_MCP.md](/Users/miya/projects/org-brain/docs/REMOTE_MCP.md) for client config and skill usage.
See [skills/org-brain-usage-status/SKILL.md](/Users/miya/projects/org-brain/skills/org-brain-usage-status/SKILL.md) for the project skill that wraps the same workflow.
