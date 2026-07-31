# BEAM scale and unseen LongMemEval report — 2026-07-31

## Decision

The requested BEAM 500K, 1M, and 10M product-path retrieval plus official-rubric
answer/judge evaluations completed with zero excluded failures. A separately
sealed 100-question LongMemEval custom-history holdout also completed five
retrieval repeats and one answer/judge pass.

OrgBrain does **not** pass the first-place acceptance gates on this evidence.
The unseen retrieval result is 92/100 rather than 98/100, its answer accuracy
is 74/100 rather than 96.8/100, and BEAM degrades materially with scale.

## Results

| Evaluation | Questions | Retrieval any R@5 | Retrieval all R@5 | Search p95 | Answer result | Errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| BEAM 500K | 700 (629 scorable) | 58.35% | 34.02% | 193.211 ms | 32.24% rubric; 29.43% full compliance | 0 |
| BEAM 1M | 700 (625 scorable) | 57.12% | 16.32% | 1,235.124 ms | 30.33% rubric; 22.14% full compliance | 0 |
| BEAM 10M | 200 (176 scorable) | 43.75% | 14.77% | 25,536.242 ms | 20.93% rubric; 25.50% full compliance | 0 |
| Sealed LongMemEval custom-history 100 | 100 × 5 | 92.00% in every repeat | not gated | 739.996 ms worst repeat | 74.00% correct | 0 |

BEAM retrieval denominators exclude questions with no source-message labels,
primarily the abstention category. Answer evaluation includes every question
and every rubric item; failed rows are not excluded.

For the sealed LongMemEval set, repeat-one retrieval and answer outcomes were:
74 retrieval-hit/answer-correct, 18 retrieval-hit/answer-wrong, 8
retrieval-miss/answer-wrong, and 0 retrieval-miss/answer-correct. Conditional
answer accuracy after a retrieval hit is therefore 74/92 (80.43%).

LongMemEval category results:

| Category | Retrieval minimum | Answer accuracy |
| --- | ---: | ---: |
| Knowledge update | 16/16 | 14/16 (87.50%) |
| Multi-session | 25/26 | 17/26 (65.38%) |
| Single-session assistant | 11/11 | 10/11 (90.91%) |
| Preference | 1/6 | 1/6 (16.67%) |
| Single-session user | 13/14 | 12/14 (85.71%) |
| Temporal reasoning | 26/27 | 20/27 (74.07%) |

## Protocol and integrity boundary

- BEAM source revision:
  `3e12035532eb85768f1a7cd779832b650c4b2ef9`
- LongMemEval source revision:
  `9e0b455f4ef0e2ab8f2e582289761153549043fc`
- Product path: `LocalMemoryStore.captureBatch()` followed by
  `LocalMemoryStore.search(search_mode="hybrid_v3")`, top 5
- BEAM answer model: `gemini-3.6-flash`
- BEAM judge model: `gemini-3.6-flash`
- LongMemEval answer model: `gemini-3.6-flash`
- LongMemEval judge model: `gemini-3.6-flash`
- Answer prompts receive retrieved context and question only. Gold source IDs,
  rubric items, reference answers, and question IDs are not exposed to the
  answer model.
- Retrieval runtime inputs do not contain question IDs, gold source IDs, or
  reference answers.
- Total observed Gemini tokens across the four answer/judge runs: 15,382,053.
  A monetary cost is not asserted because the repository does not freeze a
  provider price for these model identifiers.
- Hardware: Apple M2, 8 logical CPUs, 16 GiB RAM.

The LongMemEval dataset was selected before evaluation with seed
`orgbrain-longmemeval-unseen-v2`. Its dataset SHA-256 is
`8aa532fe3e52de3e61b005fd1f0f8716fbf83da8c6049ee8dc8cbf0a2004b5ec`;
the selected question-ID SHA-256 is
`96bb8a0b57a9745293952189daa1ca2e43a99b5b64134f241b9fd3f502e160ac`;
overlap with the public final 500 is zero. The source pool marks 31 selected
questions human-validated true, 69 unreviewed, and zero rejected false. This is
a reproducible custom-history holdout, not an official unpublished
LongMemEval-S test set.

## Runner corrections discovered during execution

The official BEAM 10M chat files contain plan-grouped batches, and batch
numbers repeat between groups. The retrieval runner now flattens those groups
and includes the group key in each source ID, preserving all logical turns
without collisions. Batch capture remains atomic and keeps one memory record
per logical turn while rebuilding projections in bulk.

The first 10M answer attempt also revealed that the answer runner had not
adopted the same plan-group expansion and therefore supplied empty context.
That invalid 4.03% rubric result was overwritten. The valid rerun uses
plan-group-aware context, is covered by a regression test, and produced the
20.93% result reported above.

## Acceptance gates and next improvements

| Gate | Target | Actual | Result |
| --- | ---: | ---: | --- |
| Sealed LongMemEval 100 R@5 | at least 98.0% | 92.0% | fail |
| Gemini answer/judge accuracy | at least 96.8% | 74.0% | fail |
| Search p95 | at most 500 ms | 193 ms / 1,235 ms / 25,536 ms on BEAM | 500K pass; 1M/10M fail |
| LLM/API errors | 0 | 0 | pass |

The highest-value improvements are:

1. Preference-aware query expansion and retrieval units, because sealed
   LongMemEval preference retrieval is only 1/6.
2. Evidence compression and category-aware answer synthesis, because 18 of 92
   correctly retrieved unseen questions still fail answer judging.
3. Incremental or indexed projection search for million-token histories,
   because current local SQLite candidate generation reaches 25.5 seconds p95
   at BEAM 10M.

`competitor-eligibility.json` remains strict: completion of these previously
missing runs removes two evidence blockers, but failed gates and incomplete
same-harness competitor/capability coverage still prohibit an overall
first-place claim.
