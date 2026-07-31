# OSS memory-layer comparison — 2026-07-30

## Conclusion

OrgBrain's frozen product retrieval path passes the LongMemEval-S retrieval and
category gates, but the repository still cannot substantiate an overall
first-place claim.

| Evaluation | Frozen result | Status |
| --- | ---: | --- |
| LongMemEval-S product path, 500 questions × 5 | 499/500 in every repeat (R@5 99.8%) | retrieval gate pass |
| MemPalace upstream `hybrid_v4`, 500 questions × 1 | 491/500 (R@5 98.2%) | complete native-runner comparison |
| GBrain upstream keyword-only, 500 questions × 1 | 99/500 (R@5 19.8%) | complete native-runner comparison |
| LongMemEval-S category minimums across 5 repeats | all six gates pass | category gate pass |
| Hash-selected LongMemEval 100 partition | 100/100 in every repeat | not sealed; excluded from unseen claim |
| Independent LoCoMo evidence-session holdout | 92/100 (R@5 92.0%) | unseen cross-benchmark result |
| Full LoCoMo evidence-session set | 1,820/1,982 (R@5 91.83%) | complete exposed development run |
| BEAM 100K evidence retrieval | 245/355 any-source R@5 (69.01%) | complete retrieval-only run; not answer accuracy |
| PrecisionMemBench retrieval | 49/77 passed (63.64%) | official external-provider tests; exposed development evidence |
| PrecisionMemBench session turns | 7/12 passed (58.33%) | official external-provider session tests |
| `competitive-memory-v1`, OrgBrain, 200 tasks × 5 | accuracy/pass^5 94.5%, R@5 100% | complete |
| `competitive-memory-v1`, AgentMemory, 200 tasks × 5 | accuracy/pass^5 30.0%, R@5 100% | complete |
| `competitive-memory-v1`, Mem0, 200 tasks × 5 | accuracy 80.0%, pass^5 70.0%, R@5 100% | complete |
| `competitive-memory-v1`, GBrain keyword, 200 tasks × 5 | accuracy/pass^5 30.0%, R@5 100% | complete |
| Overall personal/organization ranking | ineligible | strict Supermemory/Cognee/MemPalace coverage and capability evidence incomplete |

The LongMemEval product-path score is numerically above the cited GBrain 97.6%
and MemPalace 98.4% public retrieval anchors. It is development-exposed and
therefore not presented as an unseen leaderboard result. The independent
LoCoMo holdout was opened once after commit `d9f9844` froze the retrieval
implementation; its 92.0% result was not used for further tuning.

## Frozen LongMemEval-S run

- Commit under test: `d9f9844`
- Dataset SHA-256:
  `35961662da991bec512124586e2e399a335e9e7c94272403e820eccc9946589e`
- Path: `LocalMemoryStore.capture()` then
  `LocalMemoryStore.search(search_mode="hybrid_v3")`
- Questions: 500 independent tenants
- Repeats: 5
- Top k: 5
- Worker concurrency: 8
- Hardware: Apple M2, 8 logical CPUs, 16 GiB RAM
- LLM in retrieval loop: none
- Errors: 0
- Best-of-N or failed-row exclusion: none

| Repeat | Hits | R@5 | p95 search latency |
| ---: | ---: | ---: | ---: |
| 1 | 499/500 | 99.8% | 278.070 ms |
| 2 | 499/500 | 99.8% | 182.185 ms |
| 3 | 499/500 | 99.8% | 222.849 ms |
| 4 | 499/500 | 99.8% | 224.175 ms |
| 5 | 499/500 | 99.8% | 171.046 ms |
| minimum / worst | 499/500 | 99.8% | 278.070 ms |

Category minimums across the five repeats:

| Category | Minimum hits | Gate | Result |
| --- | ---: | ---: | --- |
| Knowledge update | 78/78 | 78/78 | pass |
| Multi-session | 133/133 | 132/133 | pass |
| Single-session assistant | 56/56 | 56/56 | pass |
| Preference | 30/30 | 29/30 | pass |
| Single-session user | 70/70 | 69/70 | pass |
| Temporal reasoning | 132/133 | 129/133 | pass |

The one stable miss compares the dates of two events stored in two answer
sessions. Every other item was retrieved in every repeat.

The frozen raw artifact retains the runner's former `sealed_holdout` label.
That label is not accepted as an integrity claim in this report: the full
dataset had already been inspected during development. The runner now emits
`hash_holdout` and explicitly marks the partition as non-sealed. The 100/100
score is reproducibility evidence only.

## Independent holdout

The LoCoMo file was downloaded and only aggregate schema and counts were
inspected before the runner selected 100 evidence-bearing questions by
evaluation-ID hash. Questions, evidence annotations, and selected rows were
not inspected before commit `d9f9844`.

- Dataset SHA-256:
  `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`
- Selected-ID SHA-256:
  `6dcba8eb25b20db3052f5c5aca1cafe7b7dd52b6a964ac5edb231b203be32af5`
- Result: 92/100 R@5
- Errors: 0
- p95 search latency: 84.285 ms
- Post-result tuning: none

This is a genuine unseen cross-benchmark holdout, but it is not a substitute
for an unseen LongMemEval-S partition and is not compared directly with the
LongMemEval 98% holdout target.

## Cross-benchmark expansion

The complete evidence-bearing LoCoMo set contains 1,982 questions. The normal
`LocalMemoryStore.capture()` → `search(search_mode="hybrid_v3")` path retrieved
at least one evidence session for 1,820 questions (R@5 91.83%), with zero
errors and 27.073 ms p95 search latency. This full-set score differs from the
previously unopened 100-question result by only -0.17 percentage points,
providing evidence that the 92/100 result was not caused by favorable
selection.

BEAM 100K was run across all 20 conversations. Forty abstention questions and
five questions without `source_chat_ids` were excluded from retrieval scoring;
the remaining 355 questions were scored only against their source-message
annotations. The initial product path retrieved any required source for
243/355 questions. A generic standing-instruction retrieval unit and limited
implementation-intent candidate path improved that to 245/355 (R@5 69.01%)
without changing PrecisionMemBench's 49/77 result. Knowledge update was 39/40,
temporal reasoning 40/40, and contradiction resolution 40/40. Instruction
following remains the clearest gap at 6/40. This is evidence retrieval, not
BEAM's official generated-answer accuracy.

PrecisionMemBench was executed through its unmodified 77-case retrieval and
12-turn session evaluation files using a loopback bridge over OrgBrain's
normal local product path. A caller-selected `minimum_total_score=0.065`
removed the low-relevance result tail: retrieval passed cases improved from
16/77 to 49/77, mean precision from 20.64% to 61.01%, while mean recall moved
from 96.12% to 83.72%. The session evaluation passed 7/12 turns with 81.48%
mean precision and 66.67% mean recall.

The PrecisionMem score floor was selected on the exposed retrieval cases, so
the result is development evidence. In addition, the static upstream external
adapter sends only `beliefId` and `scope` during seeding; it does not send
`pinned`, `type`, `superseded_by`, or `resolved_at`. OrgBrain cannot reproduce
those structural semantics without improperly reading scorer fixtures.
Session ingestion does send the available type and supersession metadata, and
the bridge maps inactive/open-question records to suppressed.

## Same-harness competitor rerun

Harness: `competitive-memory-v1`, 100 personal plus 100 organization tasks,
five attempts per task, `model_id=none-retrieval-only`, budget USD 0, and
`hardware_id=mac-local-arm64`.

| Adapter | Accuracy | R@5 | pass^5 | Personal accuracy | Organization accuracy | Leakage | p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| OrgBrain | 94.5% | 100% | 94.5% | 100% | 89% | 0 | 33.38 ms |
| Mem0 | 80.0% | 100% | 70.0% | 80% | 80% | 20 | 266.10 ms |
| AgentMemory | 30.0% | 100% | 30.0% | 60% | 0% | 40 | 12.27 ms |
| GBrain keyword | 30.0% | 100% | 30.0% | 60% | 0% | 40 | 95.20 ms |

AgentMemory was run through its actual `SearchIndex` BM25 implementation.
The bridge deliberately added no tenant or ACL filtering, so the 40 leakage
events reflect the tested implementation contract rather than bridge masking.

Mem0 was run through its actual OSS `Memory` implementation at revision
`74f6dc6f0d60906c4babf762fc8d14b7169c196c`, using `infer=False`, embedded
Qdrant, and `BAAI/bge-small-en-v1.5`. Tenant IDs were mapped to Mem0 `user_id`
filters, but the bridge added no record ACL filtering. All 20 leakage events
came from the same-tenant permission category; cross-tenant isolation passed.

GBrain was run through its actual PGLite `importFromContent` and
`searchKeyword` APIs at revision
`565b80754ffa6abb9afb041026f2fab048aa7553`. The bridge added no tenant or ACL
filtering. This is explicitly the no-embedding keyword track; it is not a
reproduction of GBrain's published hybrid result.

The same revision's upstream LongMemEval runner also completed all 500 rows in
keyword-only mode: 99/500 (R@5 19.8%), zero errors, p50 7,951 ms, and p95
17,390 ms. The four modulo shards resumed from per-question checkpoints after
wall-budget stops. This result validates the bridge's weak lexical baseline,
but it must not be compared as if it reproduced GBrain's published hybrid
97.6% configuration.

Cognee's native `add` → `cognify` → `SearchType.CHUNKS` bridge passed a
two-memory live retrieval smoke using `gemini-3.5-flash-lite` for ingest and
local `BAAI/bge-small-en-v1.5` embeddings. A full zero-budget same-harness
result is ineligible: cognify requires an ingest LLM, while the current harness
only meters search and therefore cannot prove equal total cost.

Supermemory local is distributed through `npx supermemory local`, while the
pinned source checkout documents but does not contain that self-hosted binary.
Its Gemini provider is also fixed to `gemini-3.1-flash-lite-preview` and is not
model-overridable in the inspected revision. A hosted API key was not
available. Installing an unpinned external binary or silently using the older
model would violate the revision and model controls, so no strict result is
reported.

MemPalace's upstream `hybrid_v4` LongMemEval runner at revision
`aa89bd82272f55381206c83b6f306e79351824eb` completed all 500 rows against the
same dataset hash. It retrieved 491/500 (R@5 98.2%) with zero runner errors:

| Category | MemPalace hits | MemPalace R@5 | OrgBrain hits |
| --- | ---: | ---: | ---: |
| Knowledge update | 78/78 | 100% | 78/78 |
| Multi-session | 131/133 | 98.50% | 133/133 |
| Single-session assistant | 56/56 | 100% | 56/56 |
| Preference | 27/30 | 90.00% | 30/30 |
| Single-session user | 69/70 | 98.57% | 70/70 |
| Temporal reasoning | 130/133 | 97.74% | 132/133 |
| **Overall** | **491/500** | **98.20%** | **499/500 (99.80%)** |

This gives OrgBrain an eight-question, 1.6 percentage-point lead on the same
LongMemEval-S file. It is a native-runner comparison, not a shared API harness:
MemPalace's runner reports no per-query latency and has only one complete
repeat, while OrgBrain has five. MemPalace used session granularity, its
default MiniLM embedder, no LLM reranker, four 125-question shards, and fixed
BLAS/Rayon/ONNX thread scheduling. A `competitive-memory-v1`
organization/ACL bridge is still required separately.

The weighted personal and organization scorecards remain `null` because
required capability evidence is incomplete for both completed adapters.
Consequently `first_place_claim_allowed` is `false`.

Competitor revisions inspected:

- GBrain: `565b80754ffa6abb9afb041026f2fab048aa7553`
- Mem0: `74f6dc6f0d60906c4babf762fc8d14b7169c196c`
- Cognee: `88aa09b4e3289e3dbf12c0c090080920816e2fb7`
- Supermemory: `1034e337bab8851e7d67bb1ad3a06a1629f7e4b2`
- MemPalace: `aa89bd82272f55381206c83b6f306e79351824eb`
- AgentMemory: `8c90741c633c020d5d24c34b6aa0ba53e2dd2226`

## Gemini model boundary

The earlier 500-question answer-generation and judge run used
`gemini-3.6-flash` for both roles and scored 96.8% (484/500). The current
retrieval rerun did not invoke Gemini. `gemini-3.5-flash-lite` remains limited
to asynchronous structured extraction when configured; the search loop itself
does not use a generation model.

## Reproduction artifacts

Committed under `artifacts/benchmarks/2026-07-30/`:

- `orgbrain-longmemeval-500-repeat5.jsonl` — all 2,500 rows
- `orgbrain-locomo-unseen-100.jsonl` — all 100 unseen rows
- `competitive-memory-all-repeat5.json` — settings, all attempts, scorecards,
  unavailable adapters, and ranking blockers
- `../2026-07-31/competitive-memory-mem0-repeat5.json` — Mem0's 1,000 raw
  same-harness attempts
- `../2026-07-31/competitive-memory-gbrain-keyword-repeat5.json` — GBrain
  keyword's 1,000 raw same-harness attempts
- `../2026-07-31/mempalace-hybrid-v4-longmemeval-500/rows.jsonl` — MemPalace's
  500 normalized native-runner rows
- `../2026-07-31/mempalace-hybrid-v4-longmemeval-500/summary.json` — strict
  completeness, hash, overall, category, and failure summary
- `../2026-07-31/gbrain-keyword-longmemeval-500/rows.jsonl` — GBrain
  keyword-only's 500 normalized native-runner rows
- `../2026-07-31/gbrain-keyword-longmemeval-500/summary.json` — strict
  completeness, latency, category, and failure summary
- `../2026-07-31/orgbrain-locomo-full-1982.jsonl` and its summary — all 1,982
  full-set product-path retrieval rows
- `../2026-07-31/orgbrain-beam-100k-retrieval.jsonl` and
  `orgbrain-beam-100k-retrieval-v4.jsonl` — BEAM retrieval baseline and
  instruction-intent improvement
- `../2026-07-31/precisionmem-orgbrain/` — official upstream retrieval and
  session reports plus revision, hashes, and the exposed-development boundary

No dataset files or secrets are committed.

External sources:

- <https://github.com/xiaowu0162/longmemeval>
- <https://github.com/garrytan/gbrain-evals>
- <https://github.com/mem0ai/memory-benchmarks>
- <https://www.cognee.ai/research-and-evaluation-results>
