# Local memory efficiency

The target is lower total task cost and completion time without extra user work.
Fewer retrieved tokens are a component result, not proof that this target is met.

## Behavior

- Durable extraction evaluates the bounded turn's candidates before applying the
  three-candidate cap. Complete candidates with reasons, reuse conditions and
  verifiable references take priority over earlier incomplete notes. Existing
  sensitive-data screening, confirmation, verification and activation gates remain
  authoritative. Utility is a prediction, not an observed benefit.
- Local `orgbrain_context_enrich` uses compact context by default, with a default
  budget of 1,500 tokens. It retains complete content, rationale, reuse conditions,
  validity, source and version. Equivalent lessons are deduplicated; different
  conditions, independent comparisons and protected evidence remain distinct.
- The compact budget counts the entire serialized MCP text using local o200k_base,
  including JSON, metadata and usage receipts. It is a tokenizer estimate, not
  provider billing. Whole candidates that do not fit are skipped; a smaller later
  candidate can still fit. Conditions are never shortened to meet the budget.
- Only delivered evidence gets an injected usage item. Items start as `unknown`;
  injection, actual adoption and a verified outcome remain separate records.
- Conflicting evidence and insufficient independent sources cause abstention.
  Budget exhaustion is distinct from no matching evidence. These conditions must
  not create a new eager-learning gap or reuse an earlier gap in the turn.
- Japanese mixed-script queries can miss SQLite FTS token boundaries. The exact
  match contribution is restored only when **all** subject terms occur in an
  already retrieved, bounded, scoped candidate. Partial matches do not receive it.
- Jev shadow/fallback decisions do not change evidence. Active protected evidence
  must fit completely or the response abstains. The implementation hash includes
  the new packing module, invalidating stale qualifications.

`context_format="full"` preserves historical projections and the existing full
retrieval contract. Its legacy content estimate is not a complete-response limit.
The `answer-ux-readonly` profile and Domain Recall keep their existing full path;
explicit compact mode is rejected with those combinations. Their transformed or
appended output is outside the compact budget contract. Direct
`orgbrain_memory_retrieve_context` also keeps its existing full behavior.

## Verified replay

Run from the repository root with a separate checkout of the baseline revision:

```sh
node scripts/memory-efficiency-evaluate.mjs \
  --baseline-root /path/to/baseline-checkout \
  --output artifacts/memory-efficiency/2026-09-23/component-replay.json
```

The baseline for this implementation is
`c9d23aa23378aa11144464779a67816e0c08f4fb`. The report includes source hashes.
Each variant uses the same synthetic fixtures, a 1,500-token budget and five warm
requests after one first request. Fixtures use isolated disposable SQLite stores;
external judgment and dense embedding providers are disabled. The first request
is **not** process-cold startup; tokenizer/import initialization may already be warm.

The replay covers five extraction cases and six retrieval cases, including late
complete learning, unsupported/transient claims, Japanese applicability,
duplicates, oversized evidence, irrelevant queries and conflicts. In the recorded
comparison, extraction criteria improved from 4/5 to 5/5 and retrieval criteria
from 2/6 to 6/6. Returned tokens fell by about 63%. All six compact responses fit
the budget, compared with four baseline responses. Exact values and per-case
latencies are in the [replay artifact](../artifacts/memory-efficiency/2026-09-23/component-replay.json).

The final warm median was 5.36 ms before and 5.34 ms after; an earlier development
replay was slower (5.09 ms to 6.35 ms). This variation does not demonstrate a
retrieval-speed improvement, and complete-response tokenization adds work.
That component replay establishes neither end-to-end task-time nor billing savings. These are regression fixtures, not a held-out
quality evaluation. Parent-model usage, cache usage, output tokens, retries,
extraction cost and real task outcomes remain necessary for economic qualification.

A later [live Codex Pro comparison](MEMORY_EFFICIENCY_LIVE_2026-09-23.md) ran
18 real model tasks against frozen CLI/shared sources with curated memory hits.
Compared with no added memory, compact context reduced total task tokens by 24.5%
and uncached input by 15.3%; observed mean completion time fell 9.2%, although one
of three tasks became slower in both repetitions. The compact-versus-old-format
comparison remained incomplete because two old-format runs timed out. The four
completed pairs did not show a whole-task token reduction from compaction alone.
This does not qualify subscription-bill savings, production automatic capture,
natural-query retrieval coverage, or a general speed improvement.

## Live-local audit and remaining boundary

The [read-only local audit](../artifacts/memory-efficiency/2026-09-23/local-audit.json)
found one active unverified OrgBrain-project memory, zero verified-use contexts
and evaluations, and the project's latest stored hook activity on September 18.
Configuration and an existing executable do not establish that desktop lifecycle
hooks actually ran. No live memory was changed by the audit or fixture replay.

This improvement session's native transcript exposes outer `functions.exec`
calls, without separate nested tool events. The existing evidence verifier cannot
prove a nested retrieval miss or successful action from that shape. Diagnostics now
report `opaque_tool_wrappers`; eager Stop reports
`eager-native-tool-evidence-unavailable` when appropriate. Wrapper output is never
promoted into fabricated execution evidence. Native nested-call provenance or a
separately verified receipt contract is needed before automatic capture from this
execution mode can be claimed. Nine recent completed-answer samples produced no
eligible durable drafts; that small diagnostic sample is not precision/recall proof.

The checkout and standalone build are validated locally. The two configured local
CLI bundles were replaced atomically after backing up their prior contents; paths,
MCP configuration, hook trust settings and existing memories were preserved. The
[rollout receipt](../artifacts/memory-efficiency/2026-09-23/local-rollout-plan.json)
records exact hashes, targets and rollback files. Both installed locations passed
their six isolated integration checks. A newly started MCP process using the
configured legacy protocol returned compact context with intact conditions:
[installed smoke](../artifacts/memory-efficiency/2026-09-23/installed-smoke.json).

Already running MCP processes still need reconnection. A real desktop Stop hook
and automatic capture from code-mode transcripts remain unverified. The current
session's empty OrgBrain retrieval establishes no memory-use or cost-saving effect.
The evidence-assessment call cost $0.000058086; this is separate from parent-model
usage and is not part of the network-free component replay.

Published evidence replaces local absolute path prefixes with placeholders.
Original raw artifacts and frozen sources are preserved in a verified local
archive; see the [artifact notes](../artifacts/memory-efficiency/2026-09-23/README.md).
