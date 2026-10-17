# Memory extraction coverage/v1

`coverage/v1` is an optional, review-only profile for `learning-extraction-proposal/v2`. It improves current-turn evidence selection and may make one additional provider request when important evidence remains. It does not write formal memory, change the v3 external-send stop, or add search summaries, aliases, hypotheses, lifecycle scoring, or automatic promotion.

## Default and activation boundary

The default is off at both boundaries:

- The Stop hook emits the legacy packet unless `ORGBRAIN_MEMORY_EXTRACTION_PROFILE=coverage/v1` is explicitly set.
- The API and cap-runner accept that packet only when `MEMORY_EXTRACTION_COVERAGE_ALLOWLIST_JSON` contains the exact tenant, project, and installation tuple. Empty configuration is the default. Wildcards do not match.

Example configuration (use non-production IDs when validating):

```json
{
  "entries": [
    {
      "tenant_id": "tenant-example",
      "project_id": "project-example",
      "installation_id": "installation-example"
    }
  ]
}
```

The client must send `extraction_profile="coverage/v1"` and `limits.calls=2`. The server never expands an old `calls=1` packet. An excluded coverage packet returns `memory_extraction_coverage_not_allowlisted`; it is not resubmitted through the one-pass route.

## Fixed execution contract

The profile keeps up to 16 current-turn sentence spans and 16 KiB of redacted evidence in its staging packet. Each span includes its parent ID, redacted-text offsets, SHA-256, order, role, and source. Dependency groups are ranked by correction/prohibition/exception, decision/constraint/preference, failure/remediation, verified procedure, then router fallback. A group is either included whole or omitted.

Each provider request contains at most eight spans, has a conservative 2,000-token input ceiling and an 800-token output ceiling, and returns at most three candidates. The run uses the provider and model recorded in the packet with no fallback. The run reserves 5,600 tokens before any provider call; legacy runs continue to reserve 2,800.

Pass 2 runs only after a valid pass-1 response when an important group was not presented or was presented but not used by a verified candidate. A timeout, provider error, or invalid JSON is terminal for that pass and is not treated as missed coverage. If pass 2 fails, valid pass-1 candidates remain in quarantine and the result records `coverage_status=failed`.

The verifier requires every content value to occur inside one cited span. It also checks human attribution, completed tool evidence for observed outcomes, qualifiers, and retrieved target-memory IDs. The shared merger deduplicates normalized candidates, rejects conflicting claims over the same atomic evidence, and records candidates beyond the final limit as `candidate_limit`.

## Checkpoints, accounting, and retention

Migration `0039_memory_extraction_coverage.sql` raises the reservation constraint to 5,600, stores the extraction profile and prompt/verifier/execution policy hashes, adds `memory_extraction_passes`, and changes the capability time budget to 90 seconds. The migration rebuilds the constrained tables while preserving rows, IDs, foreign keys, indexes, and token balances.

Each pass is claimed with a conditional `planned → running` update immediately before the external request. Only the claimant sends. The response and verification result are written to the deterministic R2 key `tenants/<tenant>/memory-extraction/passes/<run>/<pass>.json` before the D1 row becomes terminal. A redelivery reuses a succeeded pass. If a running pass has no recoverable result artifact, it becomes `outcome_unknown` and is not resent.

Unsent passes charge zero. Complete usage charges the measured input plus output tokens. A sent pass with unknown usage charges 2,800. Reported usage above a request ceiling is retained as measured, rejects that pass's candidates, and stops activation. The final result reports measured totals separately from conservative charges and includes pass states, coverage status, group omissions, verification reasons, conflicts, candidate-limit omissions, and duration through the existing capability result.

Pass artifacts use the run's existing capsule expiry. The retention sweep deletes their R2 objects and clears their result references. Logs should contain only IDs, hashes, reasons, and counts.

## A/B/C evaluation

Keep anonymized conversations, the re-identification map, and human labels outside Git. The input to `scripts/memory-extraction-coverage-evaluate.mjs` follows `scripts/memory-extraction-coverage-evaluation.schema.json`, uses schema `memory-extraction-coverage-evaluation/v1`, and records each case's split, category, provider/model, redacted packet, human gold atoms, and A/B/C pass outputs and judgments.

- A uses the current v2 input, verifier, and one pass.
- B uses the coverage input and shared verifier with one pass.
- C uses B plus the conditional second pass and shared merger.

Use 75 tuning cases (15 decision, 15 failure, 15 success, 30 non-persistent) before freezing. Use one unused fixed set of 425 cases (75 decision, 75 failure, 75 success, 200 non-persistent) for the decision:

```sh
pnpm memories:evaluate-extraction-coverage -- \
  --input /private/path/coverage-evaluation.json \
  --output /private/path/coverage-report.json \
  --split fixed
```

Every sent pass must include its actual input packet, provider/model and measured usage. The evaluator uses the same verifier as the runner before merging and verifies the final selection again. Generate the source and input freeze with `--freeze-only` before extraction, store the result in the input `freeze` field, and preserve that original manifest. The evaluator checks it against current source, input, model configuration and gold labels. The report also hashes the dataset and labels/judgments. It reports precision, recall, negation/retraction/condition/failure recall, measured tokens, unknown usage, and the three safety counterexamples. Missing cases, non-human labels, or unknown usage produce `evaluation_incomplete`; they cannot pass a gate.

Do not enable a real tuple until C improves recall over A by at least five points, has at least 98% precision and no lower precision than A, preserves each required category's recall, stays within 1.5 times A's average measured tokens, and has zero wrong-human-attribution, fabricated-evidence, or sensitive-leak cases.

## Release and rollback

Release in this order: apply migration 0039, deploy the API and cap-runner, then ship the client setting while leaving it off. Enabling an actual tuple and running the external evaluation are separate operational actions.

For a limited rollout, add one exact tuple and keep outputs in quarantine. Observe at least seven days and 100 runs, extending to at most 14 days if needed. Do not widen the rollout if 100 runs are unavailable. Turn the profile off immediately after any duplicate send, evidence misattribution, tenant crossing, or budget violation.

Rollback by removing the exact allowlist tuple and clearing `ORGBRAIN_MEMORY_EXTRACTION_PROFILE` on clients. Running passes finish result storage and accounting; planned second passes remain unsent. Existing memories are not rewritten, and audit rows remain available under their normal retention policy.

Local implementation validation:

```sh
pnpm exec vitest run packages/shared/test/memory-extraction-coverage.test.ts
node --test scripts/turn-evidence-v1.test.mjs scripts/memory-extraction-coverage-evaluate.test.mjs
pnpm exec vitest run apps/api-gateway/test/memory-extraction-enqueue-service.test.ts
pnpm exec vitest run apps/cap-runner/test/memory-extraction.test.ts
pnpm --filter @org-brain/api-gateway typecheck
pnpm --filter @org-brain/cap-runner typecheck
pnpm contract:check
```

These checks prove local code, contracts, migration behavior, and fake-provider execution. They do not prove fixed-set quality, deployment, runtime enablement, or platform acceptance.

## Input preservation and policy compatibility

The logical turn reader retains consecutive `turn_context` records with the same
turn ID, including evidence before compaction. A different turn ID starts a new
bounded group; reusing an ID after another turn never joins the groups. The 8 MiB
limit applies to the whole logical group. Requested-turn reads do not accumulate
unrelated historical groups. Cross-workspace changes within a logical group fail
closed. Instruction roles, internal reasoning, child sessions, and direct agent
coordination results are excluded. Opaque wrappers remain an evidence coverage gap.

Stop requires a final-answer record. A strict offline reader can additionally
require the actual `task_complete` marker; Stop does not require that marker,
because native completion delivery can precede its append. Neither signal
attests the truth of an assistant's claimed execution outcome.

Coverage combines consecutive human decisions with explicitly introduced human
reasons/exceptions. Tool recovery groups require the same operation name and
nonempty argument hash, a failed result and a later completed successful result.
An intervening explicit human correction can join that group. An unrelated
successful operation and an assistant's proposed rationale cannot supply that
human dependency. Groups remain all-or-nothing under pool and input limits.

The shared packer now budgets the actual selected group metadata and only the
events matching selected tool call IDs. Hook and cap-runner use the same request
shape with no extra 256-byte group reservation; the provider envelope reserve
inside the conservative bound remains unchanged. Full pool provenance and event
records remain in staging and verification. Long group IDs remain in checkpoints
but are omitted from the model prompt; supplied span IDs remain unchanged.

Coverage and A+ prompts include the existing rationale, why_it_worked, reuse_when,
reason_rejected and avoidance_rule fields. Missing reasons remain gaps. Counts of
clipped parents, bounded snippets/events, packed/omitted evidence and read
exclusions are diagnostics, not human quality labels or verified outcomes.

Enqueue fingerprints the executable prompt serialization and strict schema rather
than trusting a caller's prompt-version label. Coverage execution policy is v2.
Before an external call, the worker checks all policy hashes against its current
implementation. An old-policy queued run is rejected without sending or altering
its reservations/checkpoints; a mismatch cannot prove that a previous pass was
unsent. Already-settled results remain readable. Never repair a held run by
rewriting its hashes. Before a future deployment, pause admission and drain or
retain old runs with their matching worker; deploy compatible API/worker versions
with all activation gates off before considering new runs.

The production input/output/candidate/call ceilings remain 2,000/800/3/2. Offline
copies used for 4,000/8,000 input-bound comparisons do not alter those settings.
See [input budget diagnostics](MEMORY_EXTRACTION_INPUT_BUDGETS.md).

## Review priority signals

Coverage packets now attach current-turn `coverage-review-signals/v1` diagnostics.
Only successful, structured OrgBrain memory-search responses with an explicit
matching project and an empty `results` array count as recall misses. Unknown
output, search errors and cross-project searches do not count as misses. A later
search hit clears the pending gap. No past sessions are fetched.

Explicit user correction/stop phrases, structured tool rejection and failed tool
results supply friction signals. Repeated failures with the same tool name and arguments get extra
weight; success resets that sequence. Tool signals boost only the matching call ID
result; explicit human corrections can receive their own boost. An unrelated next
message remains diagnostic-only and receives no failure boost. A preceding miss adds a bounded
boost. Query text and tool output are not copied into diagnostics.

The boost breaks ties within the existing five priority classes, before recency,
and is also used by final candidate selection and the evaluator. It never changes
router admission or evidence verification. Missing signals retain ordinary ranking.
The result exposes group scores/reasons for review; correctness still requires the
original evidence. Scope is the captured current turn, so earlier-session searches
are intentionally unavailable. No extra model request is introduced.
