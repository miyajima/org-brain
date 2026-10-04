# Cloud parity review and bounded playbook follow-up

Review baseline: unpublished `d5b5a45e4a4a86c927d211ec32611348eea4f91c`,
parent base `f7dcb58c5ee50cf4b9a3730fc0a27f3b695711bf`.
All cases below use synthetic fixtures. No operational memory, private session,
production DB, new credential, public push or Mac runtime is involved.

## Reproduced and fixed

| Priority | Finding | Change and evidence |
| --- | --- | --- |
| P1 | NFKC credential spellings in review reference/role metadata could enter pending storage | Inspect original and NFKC for every review field, without replacing original hashes/roles/date values. Two provenance regressions failed before the fix and pass after it. |
| P2 | Full-row lexical coverage could be reported although preview truncation removed required subjects | Check actual delivered preview/summary, safely read malformed legacy reference JSON, then recheck clause coverage after delivery limit. A truncation regression failed before the fix. |
| P2 | Context top_k/projection/budget/disposition could drop subjects while retaining search's covered metadata | Choose a matching projection for natural task queries; recheck final injected text before disposition and receipts. Missing coverage delivers no excerpt and no injected usage items. Existing all-zero ordinary hits still abstain; independently matched natural-lane hits do not need a positive base-v4 score. |
| P2 | A reviewed conversation capsule's first sentence omitted command, optional-check distinction and stop/refresh conditions | In the narrow natural lane, deliver current-version canonical conversation content atomically within the existing budget. Oversized capsules are omitted. Supplied/unverified provenance is a packing discriminator, never a command attestation. A synthetic capsule initially lost its later conditions; the regression now passes. |

A native local Worker REST probe additionally found a primary `atomic` projection
containing only reason/reuse lines while the matching subject was in a `segment`.
Selecting the matching projection retains normal extraction/disposition metadata.
No semantic providers, evidence gate or source-independence gate were disabled.
This does not guarantee answer correctness or complete general playbook semantics.

## Review intent and pending lifecycle

An explicit request to remember a lesson establishes capture intent. It does not
approve an assistant-written capsule that has not been displayed and reviewed.
The synthetic intent source therefore yields pending proposals and zero searchable
or injected memories until an actual fixture category choice is supplied. Choice
`3` approves only that displayed failure capsule; it does not verify its command.

The follow-up implements explicit revision and cancellation; see
[CLOUD_MEMORY_LIFECYCLE.md](CLOUD_MEMORY_LIFECYCLE.md) for the contract. Revision
inserts a successor and supersedes its predecessor in one D1 batch. Confirm claims
pending→processing in an atomic batch against the exact payload/revision. Cancel
only claims current pending. Superseded/cancelled tokens cannot activate memory.
Every operation checks owner, tenant, actual project and current permission. New
conversation candidates require displayed hash/revision as well as an actual
answer; independent stage events do not imply replacement or guessed lineage.

Synthetic regressions cover stale token/hash/version, identical/distinct concurrent
revision, confirm versus revision/cancel/double confirm, revoked role, bound REST
project, OAuth write scope, unchanged hook allowlist, final-receipt recovery and
pre-0047 pending/saved data. Migration 0047 keeps old payloads/tokens and immutable
review receipts. Pre-existing/direct legacy proposals retain unguarded compatibility;
explicitly revised successors enter the guarded contract. No real pending row was
revised or cancelled.

## Scope and actionable playbooks

Optional typed fields extend `conversation-memory/v1` without changing hashes for
old envelopes. A project playbook stores bounded prerequisite, source pointer with
caller-supplied version/digest, exact read-template argv, tool version, expected
output, stop/failure branch and refresh condition. Canonical context packs the full
reviewed capsule atomically. The validator accepts only three current placeholder
read templates, rejects fixed targets, shell syntax and unsupported writes, and
marks commands/source claims unverified. It never executes commands, fetches source
bodies or attests freshness. Review approval is not execution authorization.

A separately supplied `task_constraint` requires a user-decision source and explicit
tenant/project/task/expiry. After exact-content review it enters `task_commitments`,
with bounded typed limits and no execution grant; it does not enter durable memories
or FTS. Other task/project and expired lookups return no constraint. The legacy
local queue rejects these new typed playbook/task records on execute; use the Cloud
backend for that contract. No automatic free-prose mixed-scope splitter or trusted
command/source verifier is claimed.

The literal resume instruction “再開して” or “resume [this/the task]” now requires
explicit `task_context` project/task/subject. Missing context, mismatch, unknown
subject or unsupported filters returns empty evidence. The bounded shared lexical
planner uses only the supplied subject, with ACL/source/expiry gates and final
injected coverage checks. Context is caller supplied, not discovered or trusted
conversation state. General imperative parsing remains unsupported.

The earlier separate holdout remains 2/10 positives with all 10 negatives
abstaining. Synthetic delivery does not establish actual task token savings;
complete outcome/token/refresh costs and trusted use evidence remain unmeasured.

## Supported local Worker experiment

The installed Wrangler 4.80.0 exposes `WRANGLER_REGISTRY_PATH` via its exported
variable factory. The exact tagged primary source is
[workers-utils misc variables](https://github.com/cloudflare/workers-sdk/blob/wrangler%404.80.0/packages/workers-utils/src/environment-variables/misc-variables.ts).
This setting is implemented and described in vendor source; it is not listed on
Wrangler's general system-variable manual. No future-version stability is assumed.

Setting only `WRANGLER_REGISTRY_PATH` to an allowed workspace directory, plus
workspace logs/isolated local persistence, starts native workerd with the existing
local config. All local migrations through 0047 apply successfully. HOME, trust,
sandbox and credential policy remain unchanged. No remote DB migration is run.
Synthetic REST uses only the pre-existing local development key. `/mcp` rejects
that key with 401 under its existing authentication contract. OAuth connectivity
and authenticated real MCP stage remain unverified; no new credential/grant was
introduced to get around the rejection.

Console Playwright verification used installed Chromium and mock API:
6 tests, 7 PNGs and 6 traces; it does not prove native authenticated Worker UI E2E.
Standard FFmpeg download was denied (403), so video capture remains unverified.

## Parallel protocol investigation

The five-file Node regression group reproduced ERA_NEGOTIATION_FAILED under
parallel execution (40 passed/1 failed), while another run passed all 41. Optional
`ORGBRAIN_PROTOCOL_TIMING=1` diagnostics preserve SDK sibling probes, pin
2026-07-28 and timeout 2000 ms. They log only elapsed/first-stdout/version-mention
metadata, never raw messages. Failed connect now closes both client/transport.

Three simultaneous replicas of the updated 42-test group, each with file
concurrency 5, produced 41/1, 41/1 and 42/0. Both failures occurred after
2056–2061 ms with no stdout observed. The installed SDK classifies stdio timeout
as legacy and then rejects it in pinned mode; this explains the generic error,
not evidence that the server actually advertised a different version. Successful
ordinary instrumented runs respond within roughly 0.5–1.2 seconds. The observed
condition is an overloaded startup/probe deadline; the exact slow startup phase
is not profiled and no runtime performance fix or increased timeout is claimed.
Serial Node verification passes with the original pin/deadline.

During that explicit stress experiment, an API dashboard HTTP test also exceeded
its existing 5-second deadline and its late callback affected the next spy check.
This is recorded separately from the uncontended final regression; no dashboard
code, deadline or assertion was relaxed.

## Publication preflight follow-up

Inventory explains the older 698 vs deduplicated 655 Node result as
`698 - (8 + 3 + 5 + 34) + (6 + 1) = 655`. All 96 default root Node files
remain present; the review-lifecycle file adds six selected cases, and the local
typed-queue guard adds one. This is component coverage, not a one-shot execution
of `pnpm test` or every optional repository suite. The configured Astra wrapper
test remains unavailable; the actual packaged hook test was subsequently enabled
and passed without providing a substitute wrapper.

Extra negative resume checks reproduced a history request bypass: the lower v4
response normalized away include_history. The unsupported-context gate now checks
the original request flag, so explicit history resume abstains before returned or
injected usage items. Ordinary keyword/history retrieval keeps its existing
contract. Supported literal Japanese/English resumes are rechecked with explicit
project/task/subject context; arbitrary imperatives remain outside this contract.

A dedicated read-command validation suite retains all three allowlisted templates
as unverified and rejects writes, IAM mutation, fixed targets, added flags, shell
execution/substitution/separators/newlines, Unicode separators and caller-provided
verified state. These are synthetic validation checks, never command execution.
