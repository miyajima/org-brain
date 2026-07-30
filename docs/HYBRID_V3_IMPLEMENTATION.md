# Hybrid v3 retrieval

Status: additive shadow rollout. This implementation is not yet eligible for a
first-place claim.

## Product path

`hybrid_v3` uses the same `capture` and `search` lifecycle as ordinary OrgBrain
records. The authoritative `MemoryRecord` is unchanged. Capture, revision,
suppression, deletion, backup restore, and index rebuild maintain a rebuildable
`memory_retrieval_units` projection.

The projection contains session text; user, assistant, system, and tool turns;
deterministic fact, update, preference, event, and quantity fallback units; and
a short synopsis. Units keep their parent memory, project, speaker, validity,
event time, source reference, extractor/version, content hash, extraction
state, and degraded reason.

When configured, `orgbrain-retrieval-projector` receives only tenant ID, memory
ID, content hash, and request time. It reloads the current authoritative record,
rejects stale jobs, and uses `gemini-3.5-flash-lite` structured output for
quality-mode atomic extraction. No benchmark question, expected answer, or
expected source ID is available to the projector.

## Retrieval

The Cloudflare product path retrieves up to 50 FTS units and 50 Vectorize units,
fuses ranks with RRF, aggregates units into up to 20 parent memories, and
reranks those parents with `@cf/baai/bge-reranker-base`. The provisional shadow
candidate is `@cf/qwen/qwen3-embedding-0.6b` in a separate 1024-dimensional
Vectorize index. It must still beat BGE Small and BGE-M3 on the development
split before it can be frozen. The prior 384-dimensional integration remains
untouched.

Time, speaker, and unit-type boosts are only enabled by generic query intent.
Normal questions do not receive a recency or authority boost. Parent ACL and
validity checks run before results are returned.

Query framing words are removed before FTS candidate generation so subject
terms are not displaced by conversational phrasing. Bounded morphology and a
small general concept lexicon improve the network-free sparse fallback.
Explicit relative-time queries add time-windowed lexical candidates and rank
them by temporal distance before BM25; ordinary queries remain relevance-first.

`meta.retrieval` reports provider versions, lexical/semantic/parent candidate
counts, projection lag, and degraded reasons while preserving the existing
result shape.

## Operations

- Migration: `migrations/0016_retrieval_units_v3.sql`
- Vectorize: `orgbrain-memory-units-v3-1024`
- Queue: `orgbrain-retrieval-projection-v3`
- Dead letter queue: `orgbrain-retrieval-projection-v3-dlq`
- Backfill: `POST /v1/retrieval-index/v3/backfill`
- Runtime status: `GET /v1/ops/status`
- Rollout mode: `HYBRID_V3_MODE=shadow`

Backfill is checkpointed per tenant/project. Rebuilds delete prior Vectorize
unit IDs before replacing D1 projections, so changed unit IDs cannot leave
stale semantic hits. Shadow events store only a query hash and aggregate
overlap/empty/degraded/latency fields.

### Live verification — 2026-07-30

- API Worker version: `16f37ec8-ccff-405c-aaa4-3264805389d3`
- Projector Worker version: `282352cf-8ba4-4410-beb4-2d9e0b72e781`
- Active memories projected: 543/543 (100%)
- Retrieval units: 3,448
- Backfill: complete, 542 memories and 3,443 units in the checkpointed pass
- Vectorize errors: 0 in the completed pass
- Metadata indexes: `project_id`, `speaker`, `unit_type`
- Live smoke: capture 201, search 200/hit, cross-tenant 403, unauthenticated
  MCP 401, delete 200, and no post-delete search result
- Runtime providers: `@cf/qwen/qwen3-embedding-0.6b` and
  `@cf/baai/bge-reranker-base`

All 3,448 units are currently marked degraded because the Gemini extraction
secret has not been uploaded to Cloudflare. Full-text and turn projections are
available; quality-mode atomic extraction is not. Shadow mode remains enabled.

## Reproducible benchmark

```bash
pnpm benchmark:product-longmemeval -- \
  --dataset-path /path/to/longmemeval_s_cleaned.json \
  --repeat 5 \
  --top-k 5 \
  --concurrency 8 \
  --output /path/to/raw-results.jsonl
```

Each question uses an independent tenant. The runtime boundary receives only
the query and source sessions. Expected source IDs are retained by the scorer
and applied after search. Errors are written as failed rows; they are never
excluded. Concurrency uses an independent SQLite database per question, so
parallel evaluations do not share retrieval state.

The frozen 2026-07-30 local sparse fallback implementation scored 493/500
(98.6% R@5) in one full product-path run, with 99/100 in the hash-selected
holdout partition and 401.437 ms search p95. Dataset SHA-256:
`35961662da991bec512124586e2e399a335e9e7c94272403e820eccc9946589e`.
Raw rows: `/tmp/orgbrain-product-longmemeval-final-500.jsonl`.

Category results were knowledge update 78/78, multi-session 131/133,
single-session assistant 56/56, preference 30/30, single-session user 67/70,
and temporal reasoning 131/133. Multi-session and single-session-user therefore
missed their strict category gates.

This is a development-guided, single-repeat diagnostic: the dataset was
inspected during tuning, so the 100-question partition is not claim-worthy as
a sealed holdout. Canary and first-place claims remain blocked until an
untouched holdout, five repeats, every category/cost/latency gate, and the
cross-benchmark and same-harness competitor runs pass.
