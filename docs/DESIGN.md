# Org Brain Design (MVP)

## Topology

### Workers
- `open-brain-api-gateway`: Hono HTTP API, task creation, workflow trigger/status
- `open-brain-org-router`: org-bus consumer, capability queue routing, task.result materialization
- `open-brain-cap-runner`: capability consumers, DO lease/messaging, artifact/memory write
- `open-brain-orchestrator`: Workflow class host
- `open-brain-api-gateway` also hosts Remote MCP endpoint (`/mcp`) to remove extra network hop

### Console
- `open-brain-console`: Astro Pages app
- `functions/api/[[path]].ts`: same-origin API proxy to `open-brain-api-gateway` via service binding

## Data Model
- `tasks`: source of truth for task state
- `task_events`: append-only audit trail
- `capabilities`: concurrency and schema catalog
- `memories` + `memories_fts`: knowledge memory and search index (`source`, `external_key` for bridge sync)
- `retrieval_events`: raw retrieval telemetry with query text/hash, counts, latency, IDs, and BM25 scores
- `retrieval_daily_metrics`: daily retrieval/service rollups for long-term effectiveness reporting
- Capability runtime memory retrieval, `/v1/memories/search`, and `/v1/memories/profile` share one retrieval helper in `packages/shared/src/memory-retrieval.ts`
- Shared retrieval uses FTS5 lexical matching ranked by `bm25(memories_fts)` with `created_at` as a tie-breaker, optional rewrite variants, and optional `knowledge_docs_fts` fallback
- Retrieval is tier-aware: `canonical-memory` > `curated-memory` / `promoted-memory` > `memory-digest` > recent raw history
- Old noisy hook memories are compacted by maintenance into digest rows tagged as `memory-digest`; repeated durable memories are consolidated into `canonical-memory`; rows tagged `compacted` are removed from retrieval/profile flows
- `threads`: review-oriented conversation/thread capture
- `knowledge_docs`: knowledge doc metadata, structured frontmatter JSON, inline body or R2 ref
- `knowledge_links`: resolved inter-doc graph (`references`, `related`, `parent`, `child`)
- `knowledge_docs_fts`: doc lookup index across title / summary / tags / body excerpt

## Control Plane
- `LeaseDO`: tenant+capability concurrency gate and duplicate execution prevention
- `MailboxDO`: short-lived worker mailbox for operational event snapshots

## Orchestration
`SpecToCodeWorkflow` creates 3 tasks sequentially:
1. `plan_writer`
2. `code_gen`
3. `code_review`

Each step waits via `waitForEvent`, and `org-router` relays `task.result` to workflow instances via `sendEvent`.

## Reliability
- Queue consumer handles each message with explicit `ack/retry`
- Router validates envelope and result payload with Ajv
- Capability runner retries capacity/input-not-found failures and publishes terminal failed events
- Task creation idempotency via `tenant_id + idempotency_key`
- Memory upsert dedupes `external_key` inside one request and resolves existing IDs in batches before applying `memories` + `memories_fts` writes
- Retrieval telemetry is best-effort: failed writes are swallowed so task execution still completes

## Security
- Public API is API-key protected
- Browser never receives service API key directly; Pages Function injects it
- Remote MCP is protected by Worker-validated service token headers
- `/mcp` enforces per-token tenant grants and optional principal -> tenant mapping (`MCP_TENANT_POLICY_JSON`)

## Agent Hook Bridge
- Hook ingress: local agent hooks/plugins -> `scripts/hook-memory-bridge.mjs` -> `POST /v1/memories/upsert` -> D1
- Supported local sources: `codex`, `claude`, `cursor`, `openclaw`, `opencode`
- The bridge normalizes source-specific payloads into deterministic `external_key`, then classifies them as `promote|skip`
- Promoted hook memories are rewritten into distilled `# Reusable Memory` markdown with takeaway, evidence, and reuse-rule sections
- Hook execution is best-effort: missing env/config skips ingestion without failing the upstream agent hook

## OpenClaw Chunk Bridge
- `main.sqlite` is treated as local cache/index, not source of truth
- Import path: OpenClaw chunks -> `POST /v1/memories/upsert` -> D1
- Imported chunks carry the `curated-memory` tag so retrieval tiers depend on tags instead of source-specific names
- Export path: D1 (`source=org-brain`) -> `memory/org-brain-sync.md` -> `openclaw memory index`
- Sync entrypoint: `scripts/sync-openclaw-memory.mjs`

## Memory Search + Profile
- `POST /v1/memories/search` returns deduped `memory|doc` results with `rewrite_query`, `search_mode`, and optional `include_history`
- Rewrite mode emits up to 4 lexical variants: full phrase, raw token OR, split token OR, singularized token OR
- Hybrid mode adds up to 2 `knowledge_docs_fts` results only when deduped lexical memory hits are fewer than 3
- `POST /v1/memories/profile` returns `durable`, `recent`, and optional `search_results`
- `durable` is derived from memories older than 24 hours with non-empty summaries, same-project preference, and tag priority `policy > diagnosis > command-result > workaround > untagged`
- `recent` is derived from non-durable memories from the last 14 days, same-project preference, recency ordering, and summary-level dedupe

## Knowledge Docs Layer
- API ingress: `POST /v1/docs` parses YAML frontmatter, extracts wiki links, decides inline-vs-R2 storage, then updates D1 + FTS
- Inline docs: `body_text` stores the full markdown body for direct retrieval and FTS
- Long docs: markdown full text is stored in R2 under `tenants/<tenant>/knowledge-docs/<doc-id>/content.md`, while D1 keeps summary, frontmatter, tags, and body excerpt for FTS
- Link rebuild: every doc save triggers tenant-scoped reconstruction of `knowledge_links` so unresolved `[[slug]]` references become resolved once the target doc exists
- Structural links: parent/child edges are synthesized from slug hierarchy (`ORG`, `capabilities/_index`, `projects/<slug>/_index`, `departments/<slug>/_index`)

## Progressive Disclosure Retrieval
- `GET /v1/docs/:slug/context` is the read-optimized API for agent bootstrap
- Response shape is summary-only: `current`, `parent_moc`, `related`, `children`, `direct_links`
- Expansion limits are hard-coded to small values (`related <= 3`, `children <= 3`) to avoid accidental context blow-up
- `apps/cap-runner/src/capabilities/knowledge-context.ts` provides `loadContext()` with the same policy and only fetches markdown when `includeBody` is explicitly requested

## Operator Snapshot
- `skills/org-brain-usage-status/scripts/report-usage-status.mjs` runs Wrangler D1 queries against `open-brain` and formats an operator-facing usage summary.
- `pnpm -s usage:status` is the root alias for the same workflow and defaults to remote D1 with `tenant_id=default`.
- The usage-status wrapper retries transient Wrangler/D1 query failures before surfacing an error, so one-off remote blips do not fail the whole snapshot.
- `scripts/seed-knowledge-docs.mjs` seeds the minimal stable MOC/reference docs set through the console/API proxy.
- `scripts/memory-maintenance.mjs` compacts old raw hook memories into digest rows and removes compacted rows from retrieval by deleting their FTS entries.
- Maintenance also builds per-project, per-category `canonical-memory` rows so long-term recall can stay compact without relying on raw episodic logs.
- `scripts/retrieval-metrics-report.mjs` reports retrieval and service effectiveness metrics from raw + rolled-up telemetry.
- `scripts/retrieval-metrics-replay.mjs` re-evaluates recent inputs with `bm25_v1`, `bm25_rewrite_v1`, and `hybrid_memory_docs_v1` against the current D1/R2 snapshot.
- `scripts/retrieval-metrics-rollup.mjs` backfills one UTC day into `retrieval_daily_metrics`.

## Retrieval Telemetry Flow
- `runCapability()` calls `buildTenantMemoryProfile()` with `rewrite_query=true` and `search_mode=hybrid`, then records a raw row in `retrieval_events` plus `task_events(kind=memory.search)`.
- Rewrite-only hits are stored as `search_strategy=bm25_rewrite_v1`.
- Hybrid memory/doc lookups are stored as `search_strategy=hybrid_memory_docs_v1`.
- Search misses with no lexical/doc results are stored as `search_strategy=fallback_recent_v1`.
- `open-brain-cap-runner` runs two daily crons: `09:05 JST` for retrieval rollup/prune and `03:30 JST` for memory maintenance/digest compaction.

## Future Enhancements
- Fine-grained RBAC beyond principal -> tenant mapping
- Full E2E with Miniflare/remote test account
- DLQ triage and replay console
- Capability-specific worker sharding
