# Codex memory review implementation and rollout status

Scope: OrgBrain's Codex integration, including linked Git worktrees. Source baseline
is `a616d2ab08afb6671d5878dcaffd77bc81e5dc22`. Changes are in the `5d51` worktree.

## Implemented locally

- Silent Stop queues source-backed decision questions, including unknown rationale,
  without enabling provider extraction. Verified success/failure gates remain.
- Exact workspace overrides win over Git-common-repository inheritance.
- Prompt offers, actual question events, answers and canonical save receipts have
  distinct states. Async question ACKs and preselected options are not consent.
- One session receives at most one successful question batch, up to three items.
  Missing Remote schemas leave candidates pending. Mixed task/memory question
  answers retain their original index; late events cannot undo a saved receipt.
- Immutable private reviews retain the original candidate, source references,
  human answer, correction and receipt. Same-token retries return the receipt;
  changed answers require a new proposal. Corrections update body, summary and
  FTS content and do not retain undisplayed old reuse conditions.
- The existing reviews page supports viewing, correction and full paginated JSON
  export. The CLI exposes bounded local observations; these are not cloud truth.
- Capture and use share five usefulness axes. Missing outcomes remain unknown.
  Domain Recall feedback persists the assessment without another LLM call.
- `a-plus/v1` survives the normal one-call packet/parser path with source hashes.
  Coverage/v3 combinations are rejected. No extraction mode was enabled.

## Verification and same-parent review

The final same-parent review verdict is **pass for local implementation** after
fixing the review-context MCP length mismatch, stale reuse metadata, mixed-question
answer indexing and late-event state regression. Production acceptance is
**inconclusive** until Remote tools are available in the active task and the live canary below is completed. OAuth login and production deployment are complete.

Evidence retained locally under `/private/tmp/orgbrain-review-*`:

- API/shared/server-core broad suite: 436 cases covered across the root run and
  targeted reruns. Eleven tests required the API package cwd; two manifest count
  assertions were updated for the new routes. No unresolved test failures.
- Final changed API/MCP contracts and real SQLite persistence: 16/16 passed
  (`orgbrain-review-corrections-api.log`). Real SQLite applies the migrations and
  checks original evidence, corrected body/summary/FTS, receipt replay and privacy.
- Final context/confirmation tests: 13/13 passed
  (`orgbrain-review-corrections-cli.log`); the subsequently expanded mixed-question
  lifecycle suite passed 4/4 (`orgbrain-review-corrections-lifecycle.log`).
- Connector tests, local MCP protocol tests, turn-evidence tests and cap-runner
  extraction tests passed. API/cap-runner types, console check and standalone CLI
  build passed. Console check reported four existing hints and zero errors.
- Browser tests: 2/2 passed (`orgbrain-review-ui-final.log`), including literal
  untrusted text rendering, lost-response recovery without duplicate confirmation,
  and multi-page export. Render inspected at
  `/private/tmp/orgbrain-memory-review-history.png`.

## Production rollout completed on 2026-09-12

- Verified the actual Cloudflare Access application in the authenticated dashboard.
  Added only the API gateway `/oauth/authorize` hostname/path to OrgBrain Production;
  retained its two protected Workers and existing owner/service policies.
  Public OAuth discovery responds 200; unauthenticated authorization redirects to Access.
- Preserved live variables, bindings and secrets. Applied only migration 0040 and
  its migration ledger entry; unrelated migrations 0038/0039 remain unapplied.
  Postflight confirms 0037 and 0040 and zero review records.
- API production version: `e2fb66cd-2295-4112-8025-3b75c50463fc`.
  OAuth resource now targets `https://open-brain-api-gateway.miyazima.workers.dev/mcp`.
- Console production version: `21139ee3-0c9f-4193-950a-fccea20873b1`.
  Cloudflare build and deploy succeeded. The authenticated production reviews page
  loads successfully and displays an empty history.
- Codex is configured for Remote MCP with modern protocol support. Native OAuth
  login succeeded with only `orgbrain:read,orgbrain:write`. No broad admin consent
  was granted. Authentication is not proof of a successful tool invocation.

## Installed runtime and confirmation-only guard

Configuration backups are in
`~/.config/org-brain/backups/memory-review-20260912-131935`.
Seven existing Codex hook commands now use the versioned CLI runtime at
`~/.config/org-brain/runtime/memory-review-567d5841b59d`.
Its bundle SHA-256 is
`567d5841b59d790a5226b4e9df6ab3eb7701c86579b35779fcc02d82d7cd56f5`.
Required installed package dependencies are copied into this runtime, so it does
not depend on the worktree staying present. Installed doctor succeeds.

The main OrgBrain workspace has `memory_learning_mode=confirm`; linked worktrees
inherit it unless explicitly overridden. Existing explicit off overrides remain.
This mode queues local confirmation candidates and returns before cloud writes,
outbox delivery or provider extraction, even when conflicting environment flags
are present. It does not add hidden automatic observation instructions.

Automatic approval review rejected the initial `on` configuration because it could
automatically transmit future session data. That command did not execute. The
subsequent `confirm` implementation removes that behavior and its installation was
approved. No additional authorization is pending for the installed configuration.

The additional confirmation-only context/lifecycle tests passed 13/13, including
an actual Stop handler with conflicting cloud/extraction flags. Hook bridge and
workspace configuration regression tests passed 51/51. Evidence:
`/private/tmp/orgbrain-review-confirm-only-clean.log` and
`/private/tmp/orgbrain-review-confirm-only-regression.log`.
Same-parent inspection confirms the Stop guard precedes automatic cloud operations.

## Remaining acceptance gaps

- This already-running task has no callable OrgBrain Remote tools after the
  configuration update. Native login succeeded, but an isolated status query has
  no initialized tool runtime. Reconnect/reload the Codex MCP integration before
  checking schemas, destination and the real interaction.
- Executing the installed UserPromptSubmit hook returns `http_403` for
  `orgbrain_task_context_get`. Source inspection shows the installation allowlist
  permits only capture/extraction (or recall/feedback), not task-context retrieval.
  This is consistent with the observed failure; the response layer was not traced.
  No privilege expansion or local canonical fallback was introduced. Remote task
  commitments therefore remain unavailable through this hook.
- A real question → human answer → label → canonical save → retrieval canary is
  still pending. An empty production history and successful OAuth login do not
  establish that acceptance. Native hook trust/automatic dispatch is also unproven;
  manual invocation only proves the installed command runs.

No new model/provider call, held-experiment retry, canonical canary save,
main-checkout edit or commit was performed. Existing experiments remain preserved.

Recovery: an in-flight confirmation is reported as `processing`, never saved.
An interrupted worker that leaves this state requires investigation rather than
blind retry. A caught failure permits the same immutable request to retry. Rollback
of runtime/config must preserve review records and the additive migration data.
