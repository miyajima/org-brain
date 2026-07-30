# OSS memory-layer comparison — 2026-07-30

## Conclusion

OrgBrain's frozen product retrieval path passes the LongMemEval-S retrieval and
category gates, but the repository still cannot substantiate an overall
first-place claim.

| Evaluation | Frozen result | Status |
| --- | ---: | --- |
| LongMemEval-S product path, 500 questions × 5 | 499/500 in every repeat (R@5 99.8%) | retrieval gate pass |
| LongMemEval-S category minimums across 5 repeats | all six gates pass | category gate pass |
| Hash-selected LongMemEval 100 partition | 100/100 in every repeat | not sealed; excluded from unseen claim |
| Independent LoCoMo evidence-session holdout | 92/100 (R@5 92.0%) | unseen cross-benchmark result |
| `competitive-memory-v1`, OrgBrain, 200 tasks × 5 | accuracy/pass^5 94.5%, R@5 100% | complete |
| `competitive-memory-v1`, AgentMemory, 200 tasks × 5 | accuracy/pass^5 30.0%, R@5 100% | complete |
| Overall personal/organization ranking | ineligible | five bridges and capability evidence missing |

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

## Same-harness competitor rerun

Harness: `competitive-memory-v1`, 100 personal plus 100 organization tasks,
five attempts per task, `model_id=none-retrieval-only`, budget USD 0, and
`hardware_id=mac-local-arm64`.

| Adapter | Accuracy | R@5 | pass^5 | Personal accuracy | Organization accuracy | Leakage | p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| OrgBrain | 94.5% | 100% | 94.5% | 100% | 89% | 0 | 33.38 ms |
| AgentMemory | 30.0% | 100% | 30.0% | 60% | 0% | 40 | 12.27 ms |

AgentMemory was run through its actual `SearchIndex` BM25 implementation.
The bridge deliberately added no tenant or ACL filtering, so the 40 leakage
events reflect the tested implementation contract rather than bridge masking.

Supermemory, GBrain, Cognee, Mem0, and MemPalace did not have runnable
same-harness bridge URLs and are recorded as unavailable in the raw report.
MemPalace's own `hybrid_v4` LongMemEval runner was also attempted at revision
`aa89bd82272f55381206c83b6f306e79351824eb`, but stopped at 266/500 to avoid
contaminating OrgBrain latency measurements; it is incomplete and excluded.

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

No dataset files or secrets are committed.

External sources:

- <https://github.com/xiaowu0162/longmemeval>
- <https://github.com/garrytan/gbrain-evals>
- <https://github.com/mem0ai/memory-benchmarks>
- <https://www.cognee.ai/research-and-evaluation-results>
