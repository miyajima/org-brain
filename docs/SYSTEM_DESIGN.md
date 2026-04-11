# Org Brain System Design

## Topology
- `open-brain-api-gateway`: Hono HTTP API, task creation, and Remote MCP on `/mcp`.
- `open-brain-org-router`: org-bus consumer, capability queue routing, and task result materialization.
- `open-brain-cap-runner`: capability consumers, DO lease/messaging, artifact writes, and memory maintenance cron work.
- `open-brain-console`: Astro Pages app with same-origin API proxying to the gateway via service binding.

## Data Model
- `tasks`: task state source of truth.
- `task_events`: append-only audit trail.
- `capabilities`: concurrency and schema catalog.
- `memories` / `memories_fts`: current memory snapshot and search index.
- `memory_versions`: immutable lifecycle history for capture/revise/refresh/suppress.
- `memory_edges`: lightweight lineage graph between memory rows.
- `retrieval_events` / `retrieval_daily_metrics`: telemetry and daily rollups.
- `knowledge_docs` / `knowledge_links` / `knowledge_docs_fts`: the knowledge-doc layer and inter-doc graph.
- `threads`: review-oriented conversation capture.

## Control Plane
- `LeaseDO`: tenant and capability concurrency gate.
- `MailboxDO`: short-lived operational mailbox for worker snapshots.

## Memory and Retrieval
- Shared retrieval logic lives in `packages/shared/src/memory-retrieval.ts`.
- Lifecycle-aware write logic lives in `apps/api-gateway/src/memory-lifecycle-service.ts`.
- Retrieval is tier-aware: `canonical-memory` > `curated-memory` / `promoted-memory` > `memory-digest` > recent raw history.
- Lifecycle-aware filtering excludes `suppressed` and expired memories from normal retrieval.
- `semantic` memories are preferred over `episodic` memories when durable/profile candidates are sorted.
- Compact rows tagged `compacted` are excluded from retrieval and profile flows.
- Daily memory maintenance compacts old hook memories into digest rows and creates per-project canonical rows.
- Retrieval refresh is best-effort: cap-runner updates `last_accessed_at` and appends a `memory_versions` refresh snapshot for top search hits without blocking task execution.

## Orchestration and Reliability
- Queue consumers use explicit ack/retry behavior.
- Router validates envelopes and task results before materializing state.
- Memory upsert deduplicates `external_key` inside one request and resolves existing IDs in batches.
- Retrieval telemetry is best-effort so memory writes do not block task execution.

## Security
- Public API is API-key protected.
- Browser traffic uses the Pages proxy; the service API key never reaches the client.
- Remote MCP uses worker-validated service token headers with per-token tenant grants.
- MCP lifecycle mutations store the authenticated service-token `principal` as the memory actor for audit visibility.

## Operator Workflows
- `pnpm -s usage:status` reports task and memory usage from D1.
- `pnpm memories:maintain` compacts old raw hook memories and collapses duplicates.
- `pnpm metrics:report`, `pnpm metrics:replay`, and `pnpm metrics:rollup` manage retrieval effectiveness and daily rollups.
- `pnpm hook:bridge` and `pnpm sync:openclaw-memory` are the two memory ingress/egress bridges.

## Console Surfaces
- `/`: dashboard
- `/tasks/new`: task creation
- `/tasks`: task list
- `/tasks/[task_id]`: task detail
- `/memories`: memory explorer and maintenance view

## Current State
- The API gateway exposes operator utilities, including `pnpm -s usage:status`, which queries the `open-brain` D1 database through Wrangler.
- The usage-status wrapper retries transient Wrangler/D1 failures before returning a fatal error, so operator snapshots are less sensitive to one-off remote blips.
