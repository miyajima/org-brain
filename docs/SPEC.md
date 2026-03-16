# Org Brain Spec (MVP)

## Goal
Cloudflare上で、Memory/Artifactsに加えて組織Functionとして動くタスク/イベント駆動の通信バスを提供する。
加えて、task / event / artifact / memory を正本のまま維持しつつ、人間とエージェント向けの知識インターフェースとして interlinked markdown docs layer を提供する。

## Scope
- API Gateway: Hono Worker
- Event Bus: Cloudflare Queues (`org-bus`, `cap-plan`, `cap-code`, `cap-review`)
- Coordination: Durable Objects (`LeaseDO`, `MailboxDO`)
- Orchestration: Cloudflare Workflows (`SpecToCodeWorkflow`)
- MCP: Remote MCP endpoint on API Gateway (`/mcp`, service-token auth)
- Storage: D1 (`tasks`, `task_events`, `capabilities`, `memories`, `memories_fts`, `threads`, `retrieval_events`, `retrieval_daily_metrics`, `knowledge_docs`, `knowledge_links`, `knowledge_docs_fts`) + R2 artifacts
- Console: Astro on Cloudflare Pages + Functions proxy

## API
- `POST /v1/tasks`
- `GET /v1/tasks`
- `GET /v1/tasks/:taskId`
- `GET /v1/tasks/:taskId/events`
- `GET /v1/memories`
- `POST /v1/memories/upsert`
- `POST /v1/docs`
- `GET /v1/docs/:slug`
- `POST /v1/docs/search`
- `GET /v1/docs/:slug/context`
- `POST /v1/workflows/spec-to-code`
- `GET /v1/workflows/spec-to-code/:instanceId`
- Auth: `x-api-key`

## MCP
- Endpoint: `POST/GET /mcp` (streamable HTTP)
- Auth: `CF-Access-Client-Id` + `CF-Access-Client-Secret`
- Tool surface:
  - memory list/upsert
  - task create/get/events
  - workflow start/status
- Tenant isolation: per-token tenant grants with optional principal -> tenant mapping (`MCP_TENANT_POLICY_JSON`) enforced server-side

## Memory Source of Truth
- Master data is Cloudflare D1 (`memories`, `memories_fts`)
- OpenClaw local DB (`~/.openclaw/memory/main.sqlite`) is cache/index only
- Agent hook連携はAPI (`/v1/memories*`) + hook bridge (`scripts/hook-memory-bridge.mjs`) で行う
- Hook bridge は low-signal な会話終了ログを原則保存せず、再利用価値のある内容だけを distilled memory として upsert する
- OpenClaw chunk連携はAPI (`/v1/memories*`) + sync script (`scripts/sync-openclaw-memory.mjs`) で行う
- Capability retrieval is lexical FTS5 search ranked by `bm25(memories_fts)` and falls back to latest memories when no terms match
- Capability retrieval emits best-effort raw telemetry into `retrieval_events` and lightweight `task_events(kind=memory.search)` for drill-down
- Daily cron on `open-brain-cap-runner` rolls up the previous UTC day into `retrieval_daily_metrics` and prunes raw telemetry older than 90 days

## Knowledge Docs Layer
- `knowledge_docs` は markdown knowledge docs の index であり、正本ではない
- 正本は引き続き `tasks` / `task_events` / artifacts / `memories`
- 各 doc は YAML frontmatter を持ち、`id`, `title`, `scope`, `kind`, `tags`, `stability`, `updated_at` を必須とする
- 各 doc は `[[slug]]` 形式の wiki link で相互参照できる
- 短文 doc は D1 に body を直接保存し、長文 doc は R2 に markdown 全文を保存する
- `knowledge_links` は resolved relation graph (`references`, `related`, `parent`, `child`) を保持する
- `POST /v1/docs` 保存時に tenant 単位で graph を再構築し、後から追加された doc に対しても未解決 wiki link を解消する

## Progressive Disclosure
- 初回コンテキスト取得は MOC から始める
- doc 本文の前に summary を優先して取得する
- `GET /v1/docs/:slug/context` は `current + parent_moc + related(max 3) + children(max 3)` を summary-only で返す
- cap-runner には `loadContext(tenantId, slug)` helper を持たせ、必要時だけ `includeBody` で全文展開する

## Task Lifecycle
`created -> queued -> running -> succeeded|failed`

## Event Types
- Queue envelope type: `task.created`, `task.result`
- Task events table kind: `created`, `queued`, `started`, `completed`, `failed`, `memory.search`

## Console Pages
- `/`
- `/tasks/new`
- `/tasks`
- `/tasks/[task_id]`
- `/workflows/spec-to-code`

## Operator Workflow
- `pnpm usage:status` queries the D1 source of truth and reports a tenant usage snapshot: task totals/statuses, active tasks, capability/project breakdowns, memory/thread counts, and recent tasks.
- `pnpm hook:bridge <source>` normalizes hook payloads from coding agents and upserts them into `memories`.
- `pnpm metrics:report` reports retrieval hit/fallback/latency plus service outcomes from D1 telemetry.
- `pnpm metrics:replay` replays recent task inputs against `legacy_recent_v1` and `bm25_v1` without persisting new rows.
- `pnpm metrics:rollup` backfills or recomputes one UTC day into `retrieval_daily_metrics`.

## Out of Scope (MVP)
- Advanced RBAC and tenant isolation policies
- DLQ replay UI
- Capability plugin marketplace
- Production observability dashboards
- Agent transcript stores への直接書き込み統合
