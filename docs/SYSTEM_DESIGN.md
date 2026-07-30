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
- `entities` / `memory_entities`: searchable subject graph for memories.
- `decision_rationales` / `decision_evidence`: confirmed conclusion/reason structure plus evidence references.
- `decision_memories`: agent-facing decision-grade context rows with constraints, pitfalls, source refs, validity, status, confidence, and permission metadata.
- `decision_memory_versions`: append-only decision memory edit/confirmation history for the human review editor.
- `memory_confirmations`: short-lived propose/confirm state for interactive saves.
- `agent_messages`: durable agmsg-style agent inbox rows with target, thread, read, and ack state.
- `retrieval_events` / `retrieval_daily_metrics`: telemetry and daily rollups.
- `measurement_runs` / `measurement_variants` / `measurement_comparisons`: opt-in memory savings AB measurements.
- `knowledge_docs` / `knowledge_links` / `knowledge_docs_fts`: the knowledge-doc layer and inter-doc graph.
- `threads`: review-oriented conversation capture.

## Control Plane
- `LeaseDO`: tenant and capability concurrency gate.
- `MailboxDO`: short-lived operational mailbox for worker snapshots.
- Agent messages do not use `MailboxDO` as their source of truth; D1 remains the durable inbox and polling surface.

## Memory and Retrieval
- Shared retrieval logic lives in `packages/shared/src/memory-retrieval.ts`.
- Shared rationale inference heuristics live in `packages/shared/src/rationale-extraction.ts`.
- Context Engine MVP logic lives in `apps/api-gateway/src/context-engine-service.ts`.
- Lifecycle-aware write logic lives in `apps/api-gateway/src/memory-lifecycle-service.ts`.
- Interactive rationale confirmation lives in `apps/api-gateway/src/rationale-service.ts`.
- Non-interactive hook rationale capture also lives in `apps/api-gateway/src/rationale-service.ts` and writes inferred rationale/evidence rows without a confirmation token.
- Retrieval is tier-aware: `canonical-memory` > `curated-memory` / `promoted-memory` > `memory-digest` > recent raw history.
- Lifecycle-aware filtering excludes `suppressed` and expired memories from normal retrieval.
- `semantic` memories are preferred over `episodic` memories when durable/profile candidates are sorted.
- Compact rows tagged `compacted` are excluded from retrieval and profile flows.
- Daily memory maintenance compacts old hook memories into digest rows and creates per-project canonical rows. `quality-v2` canonical summaries must expose representative reusable guidance instead of count-only labels.
- Manual memory cleanup can physically remove low-signal memory rows after exporting a JSONL backup. Cleanup deletes associated FTS, lifecycle, edge, entity, and rationale rows, then lets maintenance rebuild `quality-v2` canonical rows from the remaining high-quality memories.
- MemoryRecord v2 is the common logical source-of-truth contract for local SQLite and Cloud D1. FTS, embedding, graph, and cache layers are projections that must be rebuildable and must never receive an independent dual-write.
- SQLite remains the local default and D1 remains the shared Cloudflare
  default. PostgreSQL with pgvector is a future opt-in backend for measured
  scale, concurrency, transaction, analytics, or private-network requirements;
  it is not expected to improve retrieval quality by storage substitution
  alone. The backend contract, activation criteria, migration rules, and parity
  gates are defined in [`STORAGE_BACKENDS.md`](STORAGE_BACKENDS.md).
- Local SQLite uses the Node-bundled driver, WAL, schema version 15 (aligned
  with Cloud D1), SHA-256 content hashes, immutable JSON version snapshots,
  verified backup/restore, `quick_check`, read-only query connections, and
  POSIX-private file modes.
- Local SQLite maintains a reconstructable sparse-vector feature projection and
  feature-frequency catalog for offline semantic candidates. Search fuses FTS,
  sparse-vector similarity, memory edges, time, authority, and utility; delete,
  restore tombstone replay, verify, and rebuild cover both FTS and the vector
  projection.
- Cloud hard delete removes the authoritative memory plus FTS, version, edge, entity, rationale, and evidence rows before returning success; only a content-free `memory_deletions` tombstone remains for audit correlation.
- Interactive saves use `propose -> user confirmation -> confirm` and create `decision_rationales` as `user_confirmed` or `user_corrected`.
- Non-interactive hook ingestion writes promoted memory rows plus inferred rationale/evidence rows with `confirmation_state=inferred_unconfirmed`; these rows are explicitly not human-confirmed.
- Decision memory rows are an additive context shaping layer over the existing memory/rationale model. They are used by `/v1/context/enrich`, `/v1/context/pre-action-gate`, and the decision review queue to score task-relevant organizational context.
- Context scoring combines task text overlap, recency, source authority, project proximity, task specificity, permission fit, and penalties for deprecated/superseded/expired context.
- Minimal conflict detection groups same-title decision memories and reports active versus deprecated/superseded/expired contradictions in the enrich response.
- Decision editor provenance is opt-in for agent APIs: `includeProvenance`, `authorityScoring`, and `verificationView` default to false so compact benchmark retrieval remains unchanged.
- Decision memory edit/confirm flows update the current `decision_memories` snapshot and append `decision_memory_versions` rows for reviewability.
- Hook ingestion derives a default project name from `basename(cwd)` and, on first use per workspace, can confirm and cache a user-provided project name locally for later upserts.
- Retrieval refresh is best-effort: cap-runner and API memory search/profile update `last_accessed_at` and append a `memory_versions` refresh snapshot for top memory hits without blocking task execution.
- Measurement mode is isolated from normal execution. API task creation expands one logical request into raw-context control and compact-memory treatment task variants, cap-runner records estimated token/cost/duration usage per variant, and both variants run with memory writes disabled so measurement does not pollute future recall. Shared `measurement_session_id` values group multiple measured turns into one session report.

## Orchestration and Reliability
- Queue consumers use explicit ack/retry behavior.
- Org Bus and capability consumers route exhausted messages to configured DLQs;
  operators can inspect failed/dead-letter counts and recreate a task from its
  immutable `created` event through `POST /v1/ops/tasks/:id/replay`.
- Capability `max_concurrency` is enforced by the lease Durable Object as a
  per-tenant quota. `cost_limit_ms` is enforced after execution as a hard
  duration-cost ceiling; over-budget results are failed instead of published as
  successful.
- Router validates envelopes and task results before materializing state.
- Memory upsert deduplicates `external_key` inside one request and resolves existing IDs in batches.
- Retrieval telemetry is best-effort so memory writes do not block task execution.
- Agent message sends dedupe only when clients provide `idempotency_key`, so repeated natural-language messages are not collapsed accidentally.

## Security
- Public API supports API keys, Cloudflare Access, generic RS256 OIDC, and
  hash-only stored scoped bearer tokens.
- Browser preflight requests for `/v1/*` and `/api/*` are handled before API-key auth, while non-OPTIONS requests still require `x-api-key`.
- Browser traffic uses the Pages proxy; the service API key never reaches the client.
- Remote MCP uses worker-validated service token headers with per-token tenant grants.
- HTTP and mutating MCP calls append hash-chained outcome audit events.
- Fixed-role RBAC, record ACLs, scoped tokens, retention, and legal holds are
  enforced server-side; identity fields in request bodies never override the
  authenticated principal.
- An optional Workers `API_RATE_LIMITER` binding applies tenant + principal +
  route limits after authentication and before authorization; 429 outcomes enter
  the same denied audit chain.
- MCP lifecycle mutations store the authenticated service-token `principal` as the memory actor for audit visibility.
- Context shaping also applies per-row and per-source allowed-principal
  filtering after the common fixed-role RBAC and tenant/project gate.
- API Gateway can resolve principals from API keys or verified Cloudflare Access JWTs. Login profile fields such as company and organization names are display-only metadata.
- Tenant-scoped arbitrary groups and `resource_acl` entries provide group sharing for decision memories and knowledge docs without coupling access to company or organization labels.

## Operator Workflows
- `pnpm -s usage:status` reports memory/thread usage from D1 without querying task rows.
- `pnpm agmsg` is the local CLI for sending, listing, reading, and acking agent messages through the API Gateway.
- `pnpm memories:maintain` compacts old raw hook memories and collapses duplicates.
- `pnpm memories:cleanup` reports or applies physical cleanup of low-signal memory rows; `--apply` requires `--export`.
- `pnpm memories:backfill-rationales` reports or applies inferred unconfirmed rationale/evidence rows for high-value existing memories, skipping memories that already have rationale rows.
- `pnpm metrics:report`, `pnpm metrics:replay`, and `pnpm metrics:rollup` manage retrieval effectiveness and daily rollups.
- `pnpm measurement:report` reports opt-in measurement runs and their control/treatment deltas.
- Agent final reports can include qualitative memory impact notes when memory avoided source search, web search, or past-context lookup; these notes do not replace D1 retrieval telemetry or measurement-mode comparisons.
- `pnpm hook:bridge` and `pnpm sync:agents-memory` are the two memory ingress/egress bridges.

## Console Surfaces
- `/`: dashboard
- `/tasks/new`: task creation
- `/tasks`: task list
- `/tasks/[task_id]`: task detail
- `/memories`: memory explorer and maintenance view
- `/decisions`: decision knowledge search, editor, confirmation, and trust/provenance review.
- `/operations`: memory/decision debt, queue, audit, retrieval quality, token,
  retention, and SLO status.

## Current State
- The API gateway exposes operator utilities, including `pnpm -s usage:status`, which queries the `open-brain` D1 database through Wrangler without reading task rows.
- The usage-status wrapper retries transient Wrangler/D1 failures before returning a fatal error, so operator snapshots are less sensitive to one-off remote blips.
