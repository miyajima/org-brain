# Action attempt history

Action attempts are independent of durable memories. A `pitfall` memory is not
automatically a verified failed attempt. Each attempt records an action key and
label, target, normalized conditions, time, requester, executor, outcome and
evidence references. Corrections use `supersedes_id` and leave the source event
available for audit. A public MCP write is a report; only a trusted collector
with source evidence can mark an outcome or executor verified.

## Local historical import

Use `orgbrain memory import codex-attempts --workspace <path> --output <private-plan.json>`
to inspect the dry-run summary. It scans only matching Codex sessions, accepts
structured tool results, and omits opaque output. The plan contains hashes and
bounded action labels, not raw command output or conversation text. Review the
candidate and exclusion counts before applying:

```
orgbrain memory import codex-attempts --workspace <path> \
  --plan <private-plan.json> --expected-plan-hash <sha256> --execute
```

The apply step verifies the matching source snapshots and target again. New
unrelated sessions do not invalidate the plan. Repeating the same import
deduplicates by source key. Imported nonzero exits are verified *tool results*
with unknown failure kind; they do not create deterministic failure patterns.

## Retrieve and decide

`orgbrain_context_enrich` adds up to three `prior_attempts`, each with a dated
Japanese summary and evidence reference. It searches attempts independently of
memory work-type filtering. A named person appears only for a verified
principal with an active profile. An agent or unknown executor is labelled
accordingly. The project ID must resolve to the same workspace mapping used
for capture.

Before a proposed action, call `orgbrain_action_preflight` with a stable
`action_key`, project ID and concrete conditions. The result is one of:

| Decision | Meaning |
| --- | --- |
| `block` | A verified deterministic intervention failed under identical known conditions and no later verified success resolves it. |
| `warn` | Conditions, evidence or failure cause are insufficient; inspect the returned prior attempts. |
| `allow` | No accessible matching failure prevents the action, or changed conditions include a stated hypothesis. |

The planner can send alternative action keys; the preflight returns candidates
that have no accessible prior attempt. This is not proof that nobody has ever
tried them. A verification or reproduction action should be labelled separately
from an improvement intervention. Public `orgbrain_attempt_record` calls stay
reported, even if they include an evidence hash.

## Hook coverage and metrics

The Codex PreToolUse/PostToolUse adapter is enabled only for project IDs in
`ORGBRAIN_ATTEMPT_HOOK_PROJECTS`. It checks direct `exec_command`, `apply_patch`
and a static subset of `functions.exec` calls. PostToolUse records a structured
failed tool result immediately. Opaque wrappers and missing result structure
are counted as coverage gaps; a generic nonzero exit is never promoted to a
deterministic intervention failure.

`orgbrain_attempt_metrics_report` reports context queries with history, verified
adoption per returned item, preflight blocks, reported and verified false-block
feedback, confirmed same-condition reexecutions, and opaque hook coverage.
`orgbrain_attempt_use_report` retains the separate returned, injected, adopted,
executed and result-checked counts. Use `orgbrain_action_preflight_feedback`
with the `preflight_event_id` to report an incorrect block; a public report is
not counted as verified. Rates are `null` until a denominator exists. Showing
history alone never proves that it changed an action or result.

Local schema 29 and Cloud migration `0043_action_attempts.sql` use the shared
normalization and decision code. Cloud MCP checks the existing project read or
write permission for every operation. Enable Cloud after a local pilot verifies
actual use, false blocks and coverage, and after a trusted Cloud event collector
can attest outcomes and executors.
