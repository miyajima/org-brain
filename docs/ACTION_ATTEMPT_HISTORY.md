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
deduplicates by source key. Imported failures are verified *tool results*
with unknown failure kind; they do not create deterministic failure patterns.

Exit status 1 from a statically recognized `rg`/`grep` search-only command is
`inconclusive` when no explicit nonempty stderr is supplied: an empty search
does not establish failure, and a pipeline status does not prove every stage
succeeded. Literal query-only pipelines and lists are supported; expansion,
redirection, control flow and `rg --pre` are not reinterpreted. Status 2, explicit
stderr and non-search failures retain normal failure handling. Capture and
historical import share this classification.

The local pre-tool hook also rechecks old unknown-cause tool failures whose
summary is exactly `exit code 1`, using the matching proposed command. It warns
instead of blocking those ambiguous searches, while preserving original audit
records and any other unresolved failure. Key-only MCP preflight cannot perform
this command check. Inconclusive results never count as verified successes.
Reimporting an unchanged source checks the complete legacy row before appending
an idempotent correction for this classification change. The original stays
available, and different source evidence still raises a conflict.

## Retrieve and decide

`orgbrain_context_enrich` adds up to three `prior_attempts`, each with a dated
Japanese summary and evidence reference. It searches attempts independently of
memory work-type filtering. A named person appears only for a verified
principal with an active profile. An agent or unknown executor is labelled
accordingly. The project ID must resolve to the same workspace mapping used
for capture.

### Turn-start failure context

The existing local Codex prompt hook supplies at most two failure entries across
lessons and execution history. Complete verified lessons come first and retain
their applicability, failed approach, cause, correction, verified outcome, reuse
rule and evidence. Legacy or incomplete lessons are explicitly labelled as
reference material; an unknown tool failure never becomes a prohibition or an
inferred diagnosis. A dated failure does not establish that it remains unresolved.
The agent checks current conditions and subsequent success before retrying.

Entries sharing an explicit event/hash reference are deduplicated. Among retrieved
attempts with the same action, target, attempt type, known conditions and verification level, only the
latest result is presented. This is a bounded retrieval view, not an exhaustive
resolution of the action's history; existing action preflight remains separate.

Confirmed commitments and lifecycle instructions retain budget priority. Each
history entry is packed atomically, including its complete conditions; oversized
entries are omitted rather than truncated. The complete context, answer guidance
and usage receipt stay within 7,168 UTF-8 bytes. Only selected entries receive an
injection record. This means inclusion in hook output, not verified host delivery,
agent adoption or demonstrated failure avoidance. The Astra wrapper's existing
transcript-backed reuse remains unchanged.

Run `node --test scripts/hook-failure-context.test.mjs` for the focused checks.
To include the packaged hook subprocess test, build the standalone CLI and set
`ORGBRAIN_TEST_BUNDLE` to its absolute path when running that test file. The test
uses a private temporary database and fixture workspace, never the user's memory
database. Confirm native session delivery separately before claiming live use.
Optionally set `ORGBRAIN_TEST_CONTEXT_WRAPPER` to the configured Astra
`context_hook.py` to check the same packaged output through that adapter.

Before a proposed action, call `orgbrain_action_preflight` with a stable
`action_key`, project ID and concrete conditions. The result is one of:

| Decision | Meaning |
| --- | --- |
| `block` | An unresolved verified failure requires review, including imported tool failures with unknown cause or conditions. A deterministic intervention under identical known conditions cannot be released by a retry reason alone. |
| `warn` | Only reported evidence, an explicitly transient failure, or an opaque tool action is available; inspect the evidence and coverage gap. |
| `allow` | No unresolved verified failure prevents the action, a later verified success resolves it, or the local hook consumes a reviewed one-use retry. |

For a justified local retry, copy the hook's `retry_context` to
`orgbrain_action_preflight`, add a concrete `change_hypothesis` and
`retry_once: true`. Local schema 34 stores a ten-minute, one-use allowance bound
to tenant, project, task, exact action, current conditions and prior failure.
Changed conditions, a newer failure, expiry or consumption invalidate it.
Run reviewed retries as a single statically identifiable action; batches or
partly opaque wrappers cannot consume an allowance. Split those operations first.
This is a local review mechanism, not permission for external operations. The
shared preflight can evaluate a hypothesis without `retry_once`, but that does
not release the hook. Cloud does not issue local retry allowances.

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
Codex may expose the outer code-mode tool as bare `exec`. Both pre- and
post-tool hook matchers must include that exact name as well as `functions.exec`;
matching only a `.exec` suffix leaves actual operations outside hook coverage.
Project selection resolves the actual hook payload's `cwd` through the workspace
mapping. Verify native delivery and project attribution for the intended workdir;
do not infer them from an outer wrapper's input alone.
Changing a matcher changes Codex's hook definition hash. Review the modified
pre- and post-tool hooks through the native hook UI before acceptance testing;
enabled hooks with `trustStatus: modified` are skipped. Do not hand-edit trust
hashes or bypass hook trust to obtain a passing live test.
Static wrapper parsing supports literal `exec_command` arguments in direct
calls, top-level variable initializers, `text`/`notify`, and `Promise.all` or
`Promise.allSettled` arrays. It never executes JavaScript to inspect arguments.
Dynamic values remain coverage gaps. Batched calls are checked before execution;
PostToolUse records an outcome only when it can attribute it to one action.
For wrappers, result recording additionally requires the entire program to be
`text(await tools.exec_command({...}))`, or one awaited variable declaration
followed by `text(thatVariable)`, and one structured result with an integer exit
code. Wrapper success flags, unrelated printed JSON and ambiguous outputs do not
prove that the command succeeded.

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
