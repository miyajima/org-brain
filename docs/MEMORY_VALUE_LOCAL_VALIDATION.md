# Local memory value: capture, retrieval and usable context

## Result and scope

Three local bottlenecks are improved against `0c34324`: binding reusable lessons
to their own rationale/evidence, finding bounded natural task queries, and
actually delivering usable decisions instead of only their shortened headings.
This is an offline implementation and regression result. **Real session token,
turn, completion-time and billing reductions are not measured.**

No production memories, private session histories, external inference, runtime
activation, deployment or main merge are part of this change. The earlier
[live comparison](MEMORY_EFFICIENCY_LIVE_2026-09-23.md) required manually shortened
queries and curated memory hits; compaction alone did not establish whole-task
savings. Those limits are not replaced by the synthetic numbers below.

## Changes

- Capture binds immediately adjacent labeled/causal support to its own atomic
  statement, keeps multi-sentence labeled applicability, stops at another lesson
  or heading, and cleans sentence punctuation from file references. Support over
  the existing field bounds is explicitly review-only, never silently complete
- Rule-only procedures/pitfalls cannot fabricate success/failure confirmation
  fields from a summary. Actual observed lessons still pass their existing
  current-turn evidence verifier; decision confirmation remains available
- A separate bounded lexical subject lane handles Japanese segmentation, request
  scaffolding and simple plural alternatives. Every retained topic remains
  required; scope, ACL, final score floors, conflicts, source independence and
  context budgets stay authoritative
- Ordinary hook entries retain the actual stored body, rationale, applicability
  and sources. An oversized entry is omitted atomically and gets no injection
  receipt. Redaction and source-drift checks remain in place
- A full synthetic hook → delivery receipt → observed action test verifies that
  injection alone is not use, and use alone is not a positive effect

## Same-input component comparisons

| Criterion | Baseline | Candidate |
| --- | ---: | ---: |
| Extraction regression cases | 7/23 | 23/23 |
| Exact complete atomic lessons preserved | 0/10 | 10/10 |
| Actual Stop-path criteria | 8/9 | 9/9 |
| Unsupported failure confirmations | 1 | 0 |
| Qualified search hits at 3 | 4/15 | 12/15 |
| Delivered compact-context hits | 4/15 | 10/15 |
| Negative context abstentions | 15/15 | 15/15 |
| Usable hook-context or correct-omission criteria | 5/12 | 12/12 |
| Complete positive hook-context cases | 1/6 | 6/6 |

Sources: [capture replay](../artifacts/memory-efficiency/2026-10-02/lesson-capture-replay.json),
[retrieval replay](../artifacts/memory-value/2026-10-02/natural-query-replay.json),
[hook replay](../artifacts/memory-value/2026-10-02/context-replay.json).
They record source hashes and use disposable synthetic stores. These are authored
regressions, not independent held-out traffic. Both capture variants save/activate
zero memories and make zero network calls. Candidate eligibility is not approval.

The retrieval replay retains 100% precision among returned fixture items. Two
recovered searches remain withheld by the existing independent-source gate.
**All three original complex long questions still miss.** The [retrieval
report](MEMORY_NATURAL_QUERY_RECALL.md) describes exactly which task shapes improve.
The original [efficiency regression](../artifacts/memory-value/2026-10-02/efficiency-regression.json)
still passes all 5 extraction and 6 retrieval criteria on both revisions.

Context completeness can consume more injected tokens. Token changes in these
small fixtures, including randomized receipt identifiers, are not a session-cost
metric. Warm retrieval timings vary, and the recovered results add work compared
with an empty response. No general speedup is claimed.

## Broader regression and remaining weakness

The [existing-suite comparison](../artifacts/memory-value/2026-10-02/broad-regression.json)
uses 200 synthetic tasks × 5 adapter searches and a separate 100,000-record,
200-query scale fixture.

- Existing competitive retrieval hit rate stays 50% on both revisions, with zero
  tenant/permission leaks. Its personal cases all abstain and organization cases
  all hit. Diagnosis found that the legacy full-context route admits a low-score
  conflict from another fixture topic, then correctly refuses conflicted evidence
- This existing legacy-path weakness is retained rather than weakening conflict
  handling to improve a score. Its adapter calls are not actual model tasks, and
  its reported zero provider cost is not user-billing evidence
- Scale retrieval failures remain 0/200. Final warm p95 is 244.41 ms against the
  500 ms gate (baseline 290.68 ms). Shared-host contention and a single paired run
  do not establish a speed improvement

Unrestricted query decomposition, synonym-heavy requests, legacy full-context
conflict pollution, raw-search expiry filtering, low-floor regional false
positives, real capture coverage, agent adoption and controlled live
session savings remain unqualified. This work does not change the legacy full
response contract or turn Jev on. The new helper invalidates old implementation
qualifications through the existing source hash.

## Final local validation

[Validation record](../artifacts/memory-value/2026-10-02/validation.json) includes
source hashes and exact check status.

- Passed: aggregate `pnpm test`, lint, feature-surface and memory-contract checks
- Passed: all workspace type checks and build using supported
  `ORGBRAIN_CONSOLE_RUNTIME=node`, including Worker dry-run bundles
- Passed: standalone CLI build; packaged hook/strict MCP/use-receipt integration
  (12 tests). One optional external Python-wrapper test is unavailable
- Passed: both 100k dashboard performance gates and all paired offline replays
- Default Cloudflare console typecheck/build is locally blocked by
  `uv_interface_addresses` in this restricted runtime. No socket restriction was
  bypassed. Live Worker smoke is left to CI; in-process API integration passes
- No UI changes: browser E2E was not run and its workflow stays manual-only

The aggregate run reports 653 Node and 907 Vitest passes, including intentional
repeated suites, plus two standard packaging skips. The separate packaged run
covers the CLI skip; no live desktop-hook rollout or external wrapper is claimed.
The baseline corpus test's hardcoded `/workspace` paths were made hermetic so an
ambient parent Git repository cannot merge its two synthetic projects.

CI status is reported separately on the draft PR for its exact final commit.
The external personal harness-router file is unavailable in this cloud checkout;
repository bootstrap/compatibility fixtures pass and global harness files are
unchanged.

## Independent safety review

Read-only review found and verified fixes for three edge cases: a standalone
causal constraint could borrow support across lessons, US/IT acronyms could be
lost as pronouns, and indented applicability could lose a safety tail. Explicit
negative evidence declarations now also force review. Forty-two focused tests
and paired baseline repros passed after the fixes, with no remaining actionable
new defect identified in that review. References are still source pointers, not
semantic entailment or verified execution by themselves.

The full checks and replays above were rerun after these fixes. Raw-search expiry
and low-floor regional matches are explicitly retained as pre-existing limits;
compact-context negatives are not evidence of universal raw-search filtering.

## Reproduce

Use Node 22.13+ (recorded run: 24.19.0) and pnpm 10.16.1. Install the frozen lockfile
in this checkout and a separate baseline worktree. No provider credentials are
needed. Keep all database/output paths disposable and outside production stores.

```sh
git worktree add --detach /tmp/orgbrain-memory-baseline 0c34324
pnpm install --frozen-lockfile
(cd /tmp/orgbrain-memory-baseline && pnpm install --frozen-lockfile)
node scripts/memory-lesson-capture-evaluate.mjs --baseline-root /tmp/orgbrain-memory-baseline --output /tmp/capture.json
node scripts/natural-query-recall-evaluate.mjs --baseline-root /tmp/orgbrain-memory-baseline --output /tmp/recall.json
node scripts/memory-value-context-evaluate.mjs --baseline-root /tmp/orgbrain-memory-baseline --output /tmp/context.json
node scripts/memory-efficiency-evaluate.mjs --baseline-root /tmp/orgbrain-memory-baseline --output /tmp/efficiency.json
pnpm surface:check && pnpm contract:check && pnpm lint && pnpm test
ORGBRAIN_CONSOLE_RUNTIME=node pnpm typecheck
ORGBRAIN_CONSOLE_RUNTIME=node pnpm build
pnpm build:standalone
ORGBRAIN_TEST_BUNDLE="$PWD/dist/orgbrain.mjs" ORGBRAIN_TEST_CLI="$PWD/dist/orgbrain.mjs" node --test scripts/hook-failure-context.test.mjs scripts/memory-use-install.test.mjs
pnpm test:dashboard-performance
ORGBRAIN_LOCAL_EMBEDDING_PROVIDER=off ORGBRAIN_JEV_USE_MODE=off ORGBRAIN_JEV_SEARCH_MODE=off node packages/benchmarks/scripts/competitive-memory-benchmark.mjs --adapter orgbrain-local --db /tmp/orgbrain-competitive.sqlite --output /tmp/competitive.json
ORGBRAIN_LOCAL_EMBEDDING_PROVIDER=off ORGBRAIN_JEV_USE_MODE=off ORGBRAIN_JEV_SEARCH_MODE=off node packages/benchmarks/scripts/local-scale-benchmark.mjs --count 100000 --queries 200 --db /tmp/orgbrain-scale.sqlite --output /tmp/scale.json
```

Run the last two commands in each worktree with distinct disposable DB/output
paths for a comparison. The benchmark commands reset their selected fixture DB.
