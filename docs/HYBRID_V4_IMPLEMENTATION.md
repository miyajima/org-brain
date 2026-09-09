# Hybrid v4 implementation and leadership gate

> Compatibility note: `hybrid_v4` is now the migration alias for the
> `structured_context` retrieval generation. New clients and operations use
> stable generation/profile names. See
> [`RETRIEVAL_GENERATIONS_AND_MEMORY_IMPACT.md`](RETRIEVAL_GENERATIONS_AND_MEMORY_IMPACT.md).

## Product contract

`hybrid_v4` is retained as the promotion candidate. `hybrid_v3` remains
rebuildable for rollback during the policy window; this does not make both
versions permanent shadows. See
[`RETRIEVAL_ROLLOUT_POLICY.md`](RETRIEVAL_ROLLOUT_POLICY.md).

The v4 ingestion projection contains generic atomic units, profile facets,
state-ledger updates, timeline events, and bounded record segments. Gemini
`gemini-3.5-flash-lite` is permitted only in the ingestion projector. When its
credential or model is unavailable, the deterministic projection is stored
with an explicit degraded reason. Product retrieval contains no generative
model call.

Local SQLite fuses lexical, sparse, profile, timeline, and segment channels
with weighted reciprocal-rank fusion. Sparse candidates use one
`feature_hash IN (...)`/`GROUP BY unit_id` statement, not one statement per
feature. Segment search is capped at 24 and parent candidates at 50. Authority
is only a final equal-relevance tie-break. Multi-evidence queries reserve
different source sessions when possible.

D1 uses the same deterministic v4 unit IDs, metadata, intent rules, and v4
candidate channel as SQLite. Its Qwen3 0.6B embeddings are stored in
the existing Vectorize binding under a distinct `tenant:hybrid_v4` namespace,
and the BGE reranker is applied to the parent candidate set. Migration
`0017_retrieval_units_v4.sql` is additive and the v4 backfill records a
checkpoint, counts, and a unit digest.

Repository runtime configs now default to `HYBRID_V3_MODE=off` and
`HYBRID_V4_MODE=on`. API, local CLI, MCP, profile, Context Engine, cap-runner,
and console search defaults therefore use v4; callers can still request an
explicit compatibility mode where the public contract exposes one. The
retrieval projection queue is enabled when either v3 or v4 is in `canary` or
`on`, so promoting v4 while retaining v3 as an off rollback path does not skip
the asynchronous quality projection.

This repository setting is not proof that a deployed Worker has the same
variables or complete projections. Before deployment, verify v4 projection
coverage and digest, then run the live API smoke test required by the project
instructions. Stable generation routing remains `legacy` until assignments and
their migration evidence are ready.

## Evidence bundle

`MemoryStore.retrieveContext()` and
`POST /v1/memories/retrieve-context` expose a bounded evidence contract on top
of the v4 search path. They return:

- bounded source spans with speaker, session date, and source reference;
- current profile/state and prior values where version history exists;
- normalized timeline entries and their delta from the question time;
- conflicts, missing evidence, and an abstention recommendation.

The default budget is 8,000 estimated tokens and the hard maximum is 16,000.
LongMemEval, BEAM, LoCoMo, and PrecisionMem runners now consume this public
path. Answer and judge runners remain pinned to `gemini-3.6-flash`; scorer
labels do not cross the runtime boundary.

## Reproducible evaluation policy

The frozen contract is
[`config/memory-leadership-v1.json`](../config/memory-leadership-v1.json).
The public repositories and exact heads resolved for this cycle are frozen in
[`config/competitive-memory-revisions-2026-07-31.json`](../config/competitive-memory-revisions-2026-07-31.json).
Published competitor values remain reference-only. The ranked comparison is
frozen to Mem0, Hindsight, and Mnemosyne; the other inspected systems remain
reference-only. A ranking requires the same model, top-k, budget, and hardware
declarations, complete personal and organization scorecards, and a strict
OrgBrain lead over all three ranked adapters.

The opened public 500 and custom-history 100 are development data. The final
200-row seal command enforces the exact quotas, zero development-ID overlap,
unique IDs, and independent review of every question, answer, and evidence
session. The workspace does not contain an independently audited 200-row
payload, so no dataset hash has been fabricated. Current status is recorded in
`artifacts/benchmarks/2026-07-31/orgbrain-final-sealed-200-status.json`.

## Verification completed in this change

- SQLite schema 17 rebuild, v3/v4 coexistence, ACL, suppression, delete, hash,
  FTS, and embedding-count verification.
- The isolated 100k local v4 scale benchmark rebuilds only the v4 projection
  (`legacy_v3_projection: false`) and clears any reused v3/v4 derived rows;
  normal local index rebuilds retain the additive v3/v4 coexistence default.
- Shared and API typechecks; shared, API, MCP, projector, and Node tests.
- Static checks excluding benchmark names, scorer IDs, gold sources, and
  generative calls from product retrieval.
- A 1,000-record v4 performance regression: 0 retrieval failures, 35.60 ms
  warm p95, 42.61 ms cold, and successful projection digest verification.
- Fixed-revision same-harness repeat-5 development runs for OrgBrain, Mem0,
  and Mnemosyne. On the 2026-07-31 revision, the measured v4 OrgBrain result
  was 72.5% accuracy and 80% recall@5, so that historical competitive
  acceptance gate failed.
- A 2026-09-09 default-path rerun after v4 promotion completed 200 development
  tasks x 5 with 100% accuracy, 100% recall@5, 100% pass^5, zero permission or
  cross-tenant leakage, zero failed rows, 65.68 average injected context
  tokens, and 61.87 ms search p95. The benchmark now measures the injected
  evidence bundle rather than serialized storage records. See
  [`artifacts/benchmarks/2026-09-09/orgbrain-v4-default-repeat5-summary.json`](../artifacts/benchmarks/2026-09-09/orgbrain-v4-default-repeat5-summary.json).

The 2026-09-09 rerun is a single-adapter development-set result, not a 10M
result, and does not satisfy the leadership gates. The 10M run, ONNX model
selection, audited final 200, complete scorecard evidence, and same-harness
competitor runs remain required before the product may output the scoped claim
`Mem0・Hindsight・Mnemosyneとの同一ハーネス比較で総合一位`.
