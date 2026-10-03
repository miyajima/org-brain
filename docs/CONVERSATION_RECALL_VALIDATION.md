# Conversation bridge and bounded natural recall validation

## Scope

This change adds an explicitly invoked, review-gated local conversation adapter,
CLI access to the existing proposal/confirmation/context path, a two-phase private
session receipt harness, and a conservative lexical lane for up to three repeated
English questions. It does not automatically connect to any chat platform,
activate unreviewed reports, establish trusted execution from supplied JSON, or
claim general semantic retrieval.

## Evidence

- Aggregate `pnpm test`: 681 Node pass executions and 907 Vitest pass executions,
  including repeated suites, with two existing packaged-hook skips. The affected
  import, installed-CLI ACL, review, receipt and retrieval suites were re-run after
  review fixes.
- Full ESLint, feature-surface snapshot and memory-contract checks passed.
- Node-mode workspace typecheck and build passed. The local runtime needed
  `ASTRO_TELEMETRY_DISABLED=1`, writable XDG config/cache paths and
  `ORGBRAIN_CONSOLE_RUNTIME=node`; these are validation environment settings,
  not product configuration changes.
- Standalone build and 11 packaged CLI tests passed, including actual
  stage → proposal → fixture approval → active ID/version → context receipt.
  Those approvals are explicitly synthetic test inputs, not user approvals.
- The private previously observed compound-query miss was replayed unchanged
  against the earlier implementation and this change. Expected delivered lessons
  improved from 0/2 to 2/2 at the same 0.065 floor and 1,500-token budget. Separate
  historical controls stayed 7/7 short-keyword hits and 6/6 negative abstentions;
  their two natural questions improved 0/2 to 2/2. Three repetitions preserved IDs,
  scores and content/rationale/reuse fields. This is a known-miss regression, not
  a held-out benchmark or actual current-task benefit.
- Independent review froze an invented 10-positive/10-negative natural-query set
  before one execution. Only **2/10 positives** returned the intended evidence;
  **10/10 negatives** abstained. A checksum identifies the private review artifact:
  `24156fc4e745bbb373799853f8bcc472346a7d7d2799023398a8767399ca9b51`.
  No tuning used those results. Ordinary paraphrases and cross-language recall
  still have important gaps. Three pre-existing long Japanese original-full
  prompts also still miss.

Only invented fixtures, generic replay tooling and aggregate results are in this
repository. Private project source excerpts, raw conversations, contact IDs,
phone numbers, session logs and actual-session report artifacts are excluded.
The replay requires an explicit external fixture directory and output path.

## Safety review

An independent reviewer reproduced three initial integration edge cases: missing
principal forwarding in the new CLI alias, incomplete absolute-path redaction,
and normalized text exceeding its input limit. All were fixed and regression
covered. The context CLI now requires an explicit principal. A metadata-date
screening edge case found during review was also fixed: all credential/email
checks use original bytes, while only an entire valid ISO date in a clean HTTPS
reference path is exempt from the phone-pattern check. Date-shaped credentials,
email, longer phone patterns, invalid dates and credential query strings reject.

A final aggregate rerun found a nondeterministic UUID/phone-redaction collision.
The repair preserves exact UUIDs only in schema identity fields, including source
spans and scope IDs, and preserves hashes only at defined hash fields. Actual
retrieve → reported-use tests use deterministic phone-like UUIDs. Arbitrary
reference/body text remains redacted. Numeric non-UUID importer identities that
would not round-trip are rejected explicitly before persistence.

Unknown or composite identifiers, uppercase scope acronyms, partial multi-topic
queries, unavailable clauses, ACL/tenant/project boundaries, future/expired
records, conflicts, source independence and whole-entry context budgets remain
covered. Incomplete compound-question evidence is omitted after packing and gets
no injection receipt. Supplied worker/tool sources remain unverified. Pending
conversation candidates are excluded from retrieval and automatic promotion.

- Final 100,000-record/200-query local retrieval gate passed with 0 failures and
  p95 201.42 ms. Both 100,000-record dashboard/decision performance gates passed.
  These timings were collected on a shared host; no speedup or production-latency
  claim is inferred.

## Remaining verification

Hosted CI must be checked for the exact pushed commit. No main merge, deployment,
production-memory mutation, real call, paid model, causal benefit, or saved tokens,
time or money is established by this validation. A live runtime must explicitly
submit authorized events and actually consume/use retrieved context before an
actual-session adoption can be reported.
