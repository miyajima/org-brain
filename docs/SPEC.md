# Org Brain Spec (MVP)

## Goal
Cloudflare上で、Memory/Artifactsに加えて組織Functionとして動くタスク/イベント駆動の通信バスを提供する。

## Scope
- API Gateway: Hono Worker
- Event Bus: Cloudflare Queues (`org-bus`, `cap-plan`, `cap-code`, `cap-review`)
- Coordination: Durable Objects (`LeaseDO`, `MailboxDO`)
- Orchestration: Cloudflare Workflows (`SpecToCodeWorkflow`)
- MCP: Remote MCP endpoint on API Gateway (`/mcp`, service-token auth)
- Storage: D1 (`tasks`, `task_events`, `capabilities`, `memories`, `memories_fts`, `threads`) + R2 artifacts
- Console: Astro on Cloudflare Pages + Functions proxy

## API
- `POST /v1/tasks`
- `GET /v1/tasks`
- `GET /v1/tasks/:taskId`
- `GET /v1/tasks/:taskId/events`
- `GET /v1/memories`
- `POST /v1/memories/upsert`
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
- OpenClaw chunk連携はAPI (`/v1/memories*`) + sync script (`scripts/sync-openclaw-memory.mjs`) で行う
- Capability retrieval is lexical FTS5 search ranked by `bm25(memories_fts)` and falls back to latest memories when no terms match

## Task Lifecycle
`created -> queued -> running -> succeeded|failed`

## Event Types
- Queue envelope type: `task.created`, `task.result`
- Task events table kind: `created`, `queued`, `started`, `completed`, `failed`

## Console Pages
- `/`
- `/tasks/new`
- `/tasks`
- `/tasks/[task_id]`
- `/workflows/spec-to-code`

## Operator Workflow
- `pnpm usage:status` queries the D1 source of truth and reports a tenant usage snapshot: task totals/statuses, active tasks, capability/project breakdowns, memory/thread counts, and recent tasks.
- `pnpm hook:bridge <source>` normalizes hook payloads from coding agents and upserts them into `memories`.

## Out of Scope (MVP)
- Advanced RBAC and tenant isolation policies
- DLQ replay UI
- Capability plugin marketplace
- Production observability dashboards
- Agent transcript stores への直接書き込み統合
