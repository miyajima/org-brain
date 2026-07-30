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

Backfill is checkpointed per tenant/project. Shadow events store only a query
hash and aggregate overlap/empty/degraded/latency fields.

## Reproducible benchmark

```bash
pnpm benchmark:product-longmemeval -- \
  --dataset-path /path/to/longmemeval_s_cleaned.json \
  --repeat 5 \
  --top-k 5 \
  --output /path/to/raw-results.jsonl
```

Each question uses an independent tenant. The runtime boundary receives only
the query and source sessions. Expected source IDs are retained by the scorer
and applied after search. Errors are written as failed rows; they are never
excluded.

The 2026-07-30 local sparse fallback smoke scored 8/10 R@5 with 73.38 ms search
p95. This is diagnostic only: it is not the 500-question acceptance result and
does not satisfy the 98.6% gate. Canary and first-place claims remain blocked
until the sealed holdout, five repeats, category gates, cost/latency gates, and
cross-benchmark/competitor runs pass.
