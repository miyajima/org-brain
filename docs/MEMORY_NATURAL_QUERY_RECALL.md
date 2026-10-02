# Local natural-task query recall

This change improves deterministic local `hybrid_v4` retrieval for bounded
Japanese/English task queries without an LLM, provider call, schema change,
embedding migration, or capture change. It does not establish task-time, task-token,
or billing savings, and it does not solve unrestricted natural-language recall.

## Retrieval behavior

`local-task-query.mjs` creates a separate lexical subject lane:

- Normalize NFKC and case; segment Japanese/Latin mixed-script words using the
  runtime's `Intl.Segmenter` instead of treating a complete Japanese sentence as
  one FTS token
- Remove explicit request scaffolding and phrases such as “in this repository”
  and “このプロジェクトで”; keep unknown subjects, identifiers, and extra topics
- Put a simple English plural and its singular in one OR group, while requiring
  **every** subject group with AND. No synonym expansion or translation is added
- Require 2–16 distinct subject groups and at most 8,192 input characters; disable
  this lane outside those bounds instead of dropping later query subjects
- Retrieve at most 50 scoped FTS candidates. Check complete word-boundary coverage
  against content, summary, rationale, and reuse conditions before adding the
  exact-match contribution. Fully matching existing bounded sparse candidates can
  receive the same contribution when Japanese FTS boundaries missed them

The existing v3 candidate score floor still applies to partial and intent-only
matches, including the lower-floor automatic prompt hook. Only completely covered
task subjects may survive that intermediate floor before v4 fusion. The final
caller-specified score threshold remains mandatory. Removing the intermediate
floor for all candidates was rejected during development because it admitted an
unrelated weather query in the hook; that regression has an explicit test.

Tenant/project scope, ACL checks, lifecycle/validity filtering, result limits,
source independence, conflict abstention, full reuse conditions, and compact
budget checks remain in place. A retrieval does not change verification state.
The helper is included in the local judgment implementation hash, which also
feeds standalone builds. Jev remains disabled unless separately configured and
qualified; this change neither enables it nor weakens its qualification.

## Offline paired replay

Run with Node 24 and installed repository dependencies:

```sh
git worktree add --detach /tmp/orgbrain-recall-baseline 0c34324
# Install the lockfile dependencies in that worktree, or reuse local dependencies.
node scripts/natural-query-recall-evaluate.mjs \
  --baseline-root /tmp/orgbrain-recall-baseline \
  --output artifacts/memory-value/2026-10-02/natural-query-replay.json
```

The [recorded replay](../artifacts/memory-value/2026-10-02/natural-query-replay.json)
compares baseline `0c34324` with the integrated candidate, recording full Git IDs,
source hashes, fixture hashes, Node/ICU versions, per-case ranked results, and
abstention reasons. Both sides use the same eight synthetic lessons in isolated
disposable SQLite stores, default MCP score floor 0.065, top-k 3, and 1,500-token
budget. Dense embedding and judgment providers are disabled; attempted fetch calls
fail. A first request and three warm requests are retained for each case.

Six lessons and all three original full questions come unchanged from the
published [live-study manifest](../artifacts/memory-efficiency/2026-09-23/live-codex/manifest.json).
The SQLite and Japanese Cloudflare lessons come from the existing component
replay. Eight natural-query variants and negative controls are synthetic
development fixtures, not held-out traffic or evidence of current production
memory quality. Historical lesson claims are not re-certified by this test.

| Metric | Baseline | Candidate |
| --- | ---: | ---: |
| Qualified search hits at 3 | 4/15 | 12/15 |
| Macro qualified search recall at 3 | 26.7% | 80.0% |
| Mean reciprocal rank at 3 | 0.267 | 0.800 |
| Precision among returned search items | 100% | 100% |
| Delivered compact-context hits | 4/15 | 10/15 |
| Natural-query variants: search hits | 0/8 | 8/8 |
| Natural-query variants: delivered context | 0/8 | 6/8 |
| Original full live-study question hits | 0/3 | 0/3 |
| Negative context abstentions | 13/13 | 13/13 |

Two recovered searches remain withheld because the unchanged evidence rule treats
“and” as requiring independent sources. The workspace lessons share one source,
and the SQLite fixture has only one source. This is reported separately from
retrieval recall rather than bypassing the gate. Negative controls cover unknown
topics/identifiers, added topics, mixed-script partial matches, tenant/project
boundaries, conflicts, ACLs, suppressed, future, invalid, and expired lessons.
All returned lists are stable across repetitions and compact responses fit budget.

Warm MCP timings are diagnostic, not speed qualification: the improved path can
return and tokenize evidence where baseline abstained. Small local samples and
shared-host timing variation cannot establish an efficiency improvement. No
parent-model task execution, real-world recall denominator, user effort,
provider billing, or whole-task time/tokens were measured.

## Regression checks and remaining limits

```sh
node --test scripts/natural-query-recall.test.mjs \
  scripts/codex-memory-context.test.mjs scripts/local-memory.test.mjs \
  scripts/memory-efficiency.test.mjs scripts/memory-judgment-cost.test.mjs
```

The 73-test focused run passes, including 55 partial-word distractors, word-boundary
negatives, high custom thresholds, low-floor automatic hook abstention, complete
reuse conditions, scope/permission/lifecycle gates, conflicts, and qualification.
Focused ESLint and `git diff --check` pass. These checks do not replace the full
repository test suite or large-corpus retrieval benchmarking.

The three original long, multi-clause questions still miss. This implementation
does not discard arbitrary clauses or unknown subjects to force a match. Query
decomposition, language translation, synonym-heavy requests, large-corpus
candidate starvation, and production coverage need separate evaluation. This
change preserves the historical `hybrid_v3` and legacy search implementations.
