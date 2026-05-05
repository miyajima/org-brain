# Repository Survey: Context Engine MVP

## Language and Frameworks
- Monorepo using TypeScript, pnpm workspaces, and Cloudflare Workers.
- API Gateway is a Hono Worker in `apps/api-gateway`.
- Shared retrieval and schema utilities live in `packages/shared`.
- Remote MCP is implemented in `apps/api-gateway/src/mcp.ts` using `@modelcontextprotocol/sdk` and `agents/mcp`.

## DB and Migration Model
- Primary persistence is Cloudflare D1.
- Migrations are plain SQL files under `migrations/`.
- R2 is available for large artifacts through `OPEN_BRAIN_BUCKET`, but current memory and context metadata are D1-backed.
- Existing schema uses additive migrations; current style does not include down migrations.

## Existing Memory Schema
- `memories` is the current snapshot table.
- `memories_fts` provides FTS5 lexical search.
- `memory_versions` stores lifecycle history.
- `memory_edges` stores lightweight lineage.
- `entities` and `memory_entities` add subject graph metadata.
- `decision_rationales` and `decision_evidence` already store conclusion, rationale, evidence refs, confirmation state, and supersession references.
- Existing memory lifecycle states are `active`, `suppressed`, `consolidated`, and `promoted`; they do not directly model `deprecated`, `superseded`, `uncertain`, rejected alternatives, validity windows, constraints, or known pitfalls as one decision-grade object.

## Existing Search / RAG / Vector Search
- Shared search is in `packages/shared/src/memory-retrieval.ts`.
- Search is currently FTS/BM25 plus optional query rewriting and hybrid fallback into `knowledge_docs_fts`.
- There is no Vectorize-backed retrieval in the current source tree.
- Existing ranking favors same project, semantic memory kind, canonical/curated/promoted/digest tiers, lexical rank, tag priority, and recency.

## Existing API Routes
- `POST /v1/memories/upsert`
- `POST /v1/memories/capture`
- `POST /v1/memories/propose`
- `POST /v1/memories/capture-rationale`
- `POST /v1/memories/confirm`
- `POST /v1/memories/revise`
- `POST /v1/memories/refresh`
- `POST /v1/memories/suppress`
- `POST /v1/memories/search`
- `POST /v1/memories/profile`
- `POST /v1/docs`
- `POST /v1/docs/search`
- `GET /v1/docs/:slug/context`
- Task APIs under `/v1/tasks`.
- MCP endpoint is mounted at `/mcp`.

## Auth and Permission Model
- Public `/v1/*` API is protected by `x-api-key`.
- MCP has service-token auth with tenant grants and optional tenant policy.
- Existing data access is tenant-scoped and project-biased.
- Fine-grained permission-aware source filtering is not present for memory/context responses.

## MCP / Agent Adapter
- Existing MCP tools cover memory list/propose/confirm/upsert/search/profile/refresh/suppress and task create/get/events.
- There is not yet a context-engine MCP tool such as `enrich_context`, `review_check`, or `search_decisions`.

## Test Environment
- Vitest is used for tests.
- API Gateway tests use small in-memory fake D1 classes rather than Miniflare.
- Workspace commands:
  - `pnpm --filter @org-brain/api-gateway test`
  - `pnpm --filter @org-brain/api-gateway typecheck`
  - `pnpm -r --if-present test`

## Design Fit Notes
- The repo already treats org-brain as an organization memory hub, not a personal agent simulation.
- Cloudflare-native D1/R2/Workers architecture is central and should be preserved.
- The current best extension point is an additive context-engine service over D1 memory/rationale rows, not a replacement of memory retrieval.
