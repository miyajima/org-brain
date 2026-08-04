# Hybrid v3 retrieval

Status: retained rollback path; production default `HYBRID_V3_MODE=off`.
This implementation is not eligible for a first-place claim.

## Product path

`hybrid_v3` uses the same `capture` and `search` lifecycle as ordinary OrgBrain
records. The authoritative `MemoryRecord` is unchanged. Capture, revision,
suppression, deletion, backup restore, and index rebuild maintain a rebuildable
`memory_retrieval_units` projection.

The projection contains session text; user, assistant, system, and tool turns;
deterministic fact, update, preference, instruction, event, and quantity
fallback units; and a short synopsis. Units keep their parent memory, project, speaker, validity,
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
Generic implementation requests may also reserve user-authored standing
instruction units. A caller can set `minimum_total_score` for high-precision
uses that prefer an empty result to a low-relevance tail; omitting it preserves
the previous result behavior. The option is available through
`MemoryStore.search()` and the local MCP search tool.

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
- Rollout mode: `HYBRID_V3_MODE=off`
- Promotion/retirement policy: `docs/RETRIEVAL_ROLLOUT_POLICY.md`

Backfill is checkpointed per tenant/project. Rebuilds delete prior Vectorize
unit IDs before replacing D1 projections, so changed unit IDs cannot leave
stale semantic hits. Shadow events store only a query hash and aggregate
overlap/empty/degraded/latency fields.

### Live verification — 2026-07-30

- API Worker version: `2bd13173-3e7e-46a0-8cd4-bb6e6c2b2cb1`
- Projector Worker version: `177937a4-5156-4da9-8da5-239a1601f70f`
- Active memories projected: 560/560 (100%)
- Retrieval units: 3,564
- Backfill: complete; live projection coverage remains 100%
- Vectorize errors: 0 in the completed pass
- Rebuild batching: 16 documents per embedding call and 100 IDs per delete
- Metadata indexes: `project_id`, `speaker`, `unit_type`
- Live smoke: capture 201, `hybrid_v2` and direct `hybrid_v3` search 200/hit,
  scoped-token write 403, cross-tenant read 403, legal-hold delete 409, delete
  200, no post-delete result in either retrieval mode, audit chain valid
- MCP gate: unauthenticated request 403 at Cloudflare Access. Authenticated MCP
  search was not run because no `CF-Access-*` service token is configured
- Runtime providers: `@cf/qwen/qwen3-embedding-0.6b` and
  `@cf/baai/bge-reranker-base`

At the time of the 2026-07-30 verification, all 3,564 units were marked
degraded because the Gemini extraction secret had not been uploaded to
Cloudflare. Full-text and turn projections were available; quality-mode atomic
extraction was not. This historical snapshot does not describe the current
rollout default.

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

The retrieval implementation was frozen at commit `d9f9844` before the
independent holdout was opened. It scored 499/500 (99.8% R@5) in every one of
five full product-path repeats, with zero errors and a worst-repeat p95 of
278.070 ms. Dataset SHA-256:
`35961662da991bec512124586e2e399a335e9e7c94272403e820eccc9946589e`.
All 2,500 raw rows are committed at
`artifacts/benchmarks/2026-07-30/orgbrain-longmemeval-500-repeat5.jsonl`.

Category minimums across the five repeats were knowledge update 78/78,
multi-session 133/133, single-session assistant 56/56, preference 30/30,
single-session user 70/70, and temporal reasoning 132/133. Every category gate
passed.

The LongMemEval dataset was inspected during tuning, so its hash-selected
100-question partition is not claim-worthy as a sealed holdout despite scoring
100/100 in every repeat. A separately selected, previously unopened LoCoMo
100-question evidence-session holdout scored 92/100 with zero errors and
84.285 ms p95. It was not used for post-result tuning.

The full 1,982-question evidence-bearing LoCoMo set subsequently scored
1,820/1,982 (91.83% R@5), within 0.17 percentage points of the unopened
100-question result. BEAM 100K evidence retrieval scored 245/355 any-source
R@5 (69.01%); instruction-intent retrieval improved the initial 243/355
result. PrecisionMemBench's exposed official external-provider tests improved
from 16/77 to 49/77 passed after using `minimum_total_score=0.065`.

The retrieval and category gates pass, but canary and first-place claims remain
blocked. A sealed 100-question custom-history LongMemEval holdout has now been
executed, but its repeat-five R@5 is 92.0% against a 98.0% target and its
Gemini 3.6 Flash answer/judge accuracy is 74.0% against a 96.8% target.
BEAM 500K/1M/10M answer and official-rubric judge runs are also complete and
show material quality and latency degradation at scale. Same-harness eligible
runs for Cognee, Supermemory, and MemPalace and weighted capability evidence
remain incomplete. AgentMemory, Mem0, and GBrain keyword have completed
`competitive-memory-v1` repeat-five runs. MemPalace additionally completed its
native LongMemEval-S `hybrid_v4` runner at 491/500 (98.2%), below OrgBrain's
499/500 (99.8%). See `docs/OSS_MEMORY_COMPARISON_2026-07-30.md`.
