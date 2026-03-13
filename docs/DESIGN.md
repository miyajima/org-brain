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
- Capability runtime memory retrieval uses FTS5 lexical matching ranked by `bm25(memories_fts)` with `created_at` as a tie-breaker
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

## Security
- Public API is API-key protected
- Browser never receives service API key directly; Pages Function injects it
- Remote MCP is protected by Worker-validated service token headers
- `/mcp` enforces per-token tenant grants and optional principal -> tenant mapping (`MCP_TENANT_POLICY_JSON`)

## Agent Hook Bridge
- Hook ingress: local agent hooks/plugins -> `scripts/hook-memory-bridge.mjs` -> `POST /v1/memories/upsert` -> D1
- Supported local sources: `codex`, `claude`, `cursor`, `openclaw`, `opencode`
- The bridge normalizes source-specific payloads into `summary`, `tags`, `project_id`, and deterministic `external_key`
- Hook execution is best-effort: missing env/config skips ingestion without failing the upstream agent hook

## OpenClaw Chunk Bridge
- `main.sqlite` is treated as local cache/index, not source of truth
- Import path: OpenClaw chunks -> `POST /v1/memories/upsert` -> D1
- Export path: D1 (`source=org-brain`) -> `memory/org-brain-sync.md` -> `openclaw memory index`
- Sync entrypoint: `scripts/sync-openclaw-memory.mjs`

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
- `pnpm usage:status` is the root alias for the same workflow and defaults to remote D1 with `tenant_id=default`.

## Future Enhancements
- Fine-grained RBAC beyond principal -> tenant mapping
- Full E2E with Miniflare/remote test account
- DLQ triage and replay console
- Capability-specific worker sharding
