# Competitive benchmark bridges

These loopback-only servers adapt pinned competitor revisions to
`competitive-memory-v1`:

- `POST /reset`
- `POST /capture`
- `POST /search`
- optional `POST /capabilities`

Bridges may translate the competitor's native identifier or tenant mechanism,
but must not add retrieval, ACL, or governance behavior that the competitor
does not implement.

## Cognee

The Cognee bridge buffers native `cognee.add` captures, runs `cognee.cognify`
once before the first query with `gemini-3.5-flash-lite`, and retrieves through
native `SearchType.CHUNKS` with local FastEmbed. Tenant IDs map to Cognee
datasets. Because cognify requires an ingest LLM and the harness does not
measure capture cost, the bridge reports search cost as unknown and its result
is not eligible for the zero-LLM strict ranking track.

## GBrain

The bridge uses GBrain's PGLite engine, `importFromContent`, and
`searchKeyword`. It is a keyword-only run and makes no embedding or LLM calls.
Point `GBRAIN_ROOT` at a checkout whose dependencies are installed:

```bash
GBRAIN_ROOT=/path/to/gbrain-evals PORT=8791 \
  bun scripts/benchmark-bridges/gbrain.ts

GBRAIN_BENCHMARK_URL=http://127.0.0.1:8791 \
  pnpm benchmark:competitive -- \
  --adapter gbrain \
  --repeat 5 \
  --model-id none-retrieval-only \
  --budget-usd 0 \
  --hardware-id mac-local-arm64
```

The bridge intentionally does not filter by tenant or principal because the
tested keyword API does not accept those filters.

## Mem0

The bridge uses Mem0 OSS `Memory`, embedded Qdrant, and FastEmbed
`BAAI/bge-small-en-v1.5`. It calls `Memory.add(..., infer=False)`, so the
declared `gemini-3.5-flash-lite` extractor is not invoked and search cost is
zero. `GEMINI_API_KEY` is still required by the Mem0 Gemini client constructor;
the value must stay in the local environment and must never be committed.

```bash
MEM0_ROOT=/path/to/mem0 PORT=8790 \
  /path/to/mem0/.venv/bin/python scripts/benchmark-bridges/mem0.py

MEM0_BENCHMARK_URL=http://127.0.0.1:8790 \
  pnpm benchmark:competitive -- \
  --adapter mem0 \
  --repeat 5 \
  --model-id none-retrieval-only \
  --budget-usd 0 \
  --hardware-id mac-local-arm64
```

OrgBrain tenant IDs map to Mem0 `user_id` filters. The bridge does not add
same-tenant record ACL filtering, so permission failures remain visible.

## Upstream LongMemEval runners

The upstream GBrain and MemPalace LongMemEval runners are kept separate from
`competitive-memory-v1`; their native row formats can be normalized only after
all 500 unique question IDs are present:

```bash
node scripts/summarize-competitor-longmemeval.mjs \
  --adapter <adapter> \
  --revision <commit> \
  --dataset /path/to/longmemeval_s_cleaned.json \
  --input /path/to/shard-0.jsonl \
  --input /path/to/shard-1.jsonl \
  --output-dir artifacts/benchmarks/<date>/<adapter>-longmemeval-500 \
  --expected 500
```

MemPalace's default Chroma ONNX embedder creates independent native thread
pools in every shard. Reproducible parallel runs must fix BLAS, Rayon, and ONNX
Runtime to one thread per process and disable spin waiting. The 2026-07-31 run
used four 125-question shards, `hybrid_v4`, session granularity, the default
MiniLM embedding model, and these scheduling-only controls:

```text
OMP_NUM_THREADS=1
OPENBLAS_NUM_THREADS=1
MKL_NUM_THREADS=1
NUMEXPR_NUM_THREADS=1
VECLIB_MAXIMUM_THREADS=1
RAYON_NUM_THREADS=1
TOKENIZERS_PARALLELISM=false
onnxruntime intra_op_num_threads=1
onnxruntime inter_op_num_threads=1
onnxruntime session.intra_op.allow_spinning=0
onnxruntime session.inter_op.allow_spinning=0
```

These controls do not alter the model, corpus, retrieval mode, candidate
ranking, or metric calculation. They must still be reported in the summary's
`execution_profile` because they affect latency and resource use.
The ONNX Runtime session-only change is recorded in
`patches/chromadb-onnx-single-thread.patch`; apply it to the ChromaDB package in
the isolated benchmark environment, never to an application dependency.
