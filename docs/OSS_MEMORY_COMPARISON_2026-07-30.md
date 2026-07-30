# OSS memory-layer comparison — 2026-07-30

## Conclusion

OrgBrain cannot currently substantiate a first-place claim for its production
implementation.

The LongMemEval-specific evaluation profile is competitive. The improved
product retrieval path now exceeds the cited public GBrain anchor numerically
in a development-guided diagnostic, but it is not yet ranking eligible:

| OrgBrain path | Dataset | Result |
| --- | --- | ---: |
| LongMemEval-specific evidence-card profile | LongMemEval-S, 500 questions | 96.8% answer accuracy, 100% evidence R@5 |
| Production `LocalMemoryStore.capture/search` | LongMemEval-S, 500 questions | 15.0% retrieval R@5 (75/500) |
| Production `hybrid_v3` sparse fallback diagnostic | LongMemEval-S, 500 questions, repeat 1 | 98.6% retrieval R@5 (493/500), p95 401.437 ms; not rank eligible |
| Fixed organization/personal suite | `competitive-memory-v1`, 200 tasks, repeat 5 | 100% accuracy, R@5, and pass^5 |

The fixed 200-task suite remains ranking-ineligible because the four external
systems were not executed through the same bridge, model budget, and hardware,
and the weighted capability evidence is incomplete.

## Gemini model

The 500-question answer-generation and judge run used
`gemini-3.6-flash` for both roles. This is the quality track: Gemini 3.6 Flash
is intended for complex reasoning and agentic work. Gemini 3.5 Flash-Lite is
better suited to a separate cost/throughput track such as extraction,
classification, and structured parsing.

The request payload does not send `temperature`, `top_p`, or `top_k`, which are
deprecated for these model generations.

## OrgBrain measurements

### LongMemEval-specific profile

- Questions: 500
- Answer accuracy: 96.8% (484/500)
- Evidence recall@5: 100.0% (500/500)
- Evidence coverage@5: 96.72%
- Context reduction: 99.54%
- Mean retrieval latency: 4,736.7 ms
- LLM/API errors: 0
- Failure breakdown: 2 evidence-present reasoning, 1 speaker confusion,
  3 temporal calculation, 4 aggregation, and 6 judge false negatives
- Raw checkpoint: `/tmp/orgbrain-gemini-36-longmemeval-500.jsonl`

This profile constructs compact, session-aware evidence cards and uses
LongMemEval-specific query and answer routing. It does not call the production
`LocalMemoryStore.search()` path.

### Production retrieval path

- Questions: 500
- Captured sessions: 23,867
- Retrieval recall@5: 15.0% (75/500)
- Misses: 425
- Search latency: p50 193.04 ms, p95 991.44 ms
- Raw rows: `/tmp/orgbrain-product-longmemeval-20260730.jsonl`
- SQLite database: `/tmp/orgbrain-product-longmemeval-20260730.sqlite`

Category retrieval recall@5:

| Category | Hits / questions | R@5 |
| --- | ---: | ---: |
| Knowledge update | 31/78 | 39.74% |
| Multi-session | 12/133 | 9.02% |
| Single-session assistant | 1/56 | 1.79% |
| Single-session preference | 3/30 | 10.00% |
| Single-session user | 18/70 | 25.71% |
| Temporal reasoning | 10/133 | 7.52% |

### Improved `hybrid_v3` diagnostic

- Questions: 500, one repeat
- Retrieval recall@5: 98.6% (493/500)
- Hash-selected 100-question partition: 99.0% (99/100)
- Search latency p95: 401.437 ms
- Dataset SHA-256:
  `35961662da991bec512124586e2e399a335e9e7c94272403e820eccc9946589e`
- Raw rows: `/tmp/orgbrain-product-longmemeval-final-500.jsonl`

| Category | Hits / questions | R@5 | Strict gate |
| --- | ---: | ---: | --- |
| Knowledge update | 78/78 | 100.00% | pass |
| Multi-session | 131/133 | 98.50% | fail (132 required) |
| Single-session assistant | 56/56 | 100.00% | pass |
| Preference | 30/30 | 100.00% | pass |
| Single-session user | 67/70 | 95.71% | fail (69 required) |
| Temporal reasoning | 131/133 | 98.50% | pass |

The full dataset was inspected during development, so the 100-question
partition is not treated as a sealed holdout. This repeat is quality evidence
for the implementation, not a leaderboard submission.

## Current official external anchors

These are official published results, not same-harness reruns. Only matching
datasets and metrics should be compared directly.

| System | Official result | Comparability |
| --- | --- | --- |
| GBrain | LongMemEval-S retrieval R@5 97.6% | Directly comparable to OrgBrain production retrieval R@5 |
| Supermemory | LongMemEval-S 95% overall with Recall@15 aggregation; about 720 mean tokens | Different top-k and answer pipeline |
| Mem0 OSS | LongMemEval answer accuracy 91.0% with GPT-5 extraction, answerer, and judge | Answer accuracy, different models and retrieval depth |
| Mem0 Platform | LongMemEval answer accuracy 94.8% at top 50 | Managed product, not OSS |
| Cognee | BEAM 100K score 0.79 | Different dataset and metric; excluded from LongMemEval ranking |

Sources:

- <https://github.com/garrytan/gbrain-evals>
- <https://supermemory.ai/research/longmembench/>
- <https://github.com/mem0ai/memory-benchmarks>
- <https://www.cognee.ai/research-and-evaluation-results>

Official repository revisions inspected:

- Supermemory: `1034e337bab8851e7d67bb1ad3a06a1629f7e4b2`
- GBrain: `c6dc0adf26a2d20df1147d2ec87c8922ca86d410`
- Cognee: `88aa09b4e3289e3dbf12c0c090080920816e2fb7`
- Mem0: `d4869d24ec01c65c26e2c9d7b8d946be5285766c`

## Decision

The improved product-path diagnostic is 1.0 percentage point above the cited
GBrain public retrieval anchor. It does not establish first place because it
was tuned with visibility into the dataset, has only one repeat, misses two
category gates, and has not rerun competitors under the same harness.

The session-aware projection, intent-limited temporal handling, RRF, dense
retrieval, and reranking are now implemented in the production path as
`hybrid_v3` and deployed in shadow mode. The next evidence target is an
untouched holdout and five-repeat run, then same-harness competitor bridges and
weighted capability evidence. Until those gates pass, the comparison remains
“numerically leading diagnostic, overall rank unproven.”
