# Explicit conversation memory bridge

`orgbrain memory import conversation` is a local, opt-in bridge for a runtime that
already has authorized access to a selected user message, worker report or tool
result. It does **not** connect to dot/cloud tasks, scan a session directory,
subscribe to conversations, alter the installed Stop hook, call a model, or grant
persistent access. The calling runtime must supply each bounded event explicitly.
A standalone installation alone cannot capture conversations it cannot observe.

## States and trust

1. Preview validates one explicit JSON file (64 KiB maximum, 1–3 candidates,
   1–8 short sources) without creating candidates.
2. `--execute --expected-plan-hash HASH` persists redacted candidates in OrgBrain's
   private confirmation queue. Repeated identical candidates are idempotent. They
   are pending review, excluded from active retrieval and autonomous promotion.
3. Call the existing proposal API (or `memory propose`) with the returned proposal.
   Show the exact conclusion, rationale, reuse conditions and source status to
   the user. Only a real answer may be passed to `memory confirm`; silence,
   worker approval, a request to build this integration, or a successful tool
   command is not confirmation of a newly inferred lesson.
4. An accepted confirmation stores an active memory and returns its ID/version.
   Human confirmation and deterministic execution verification remain distinct:
   supplied conversation/tool excerpts remain `unverified`, including a claimed
   successful test or an imported `role: tool` source.
5. `memory context` retrieves and packs context using the normal score floor,
   scope, conflict, source-independence and whole-entry budget gates. Its usage
   item IDs identify delivered evidence; they do not prove adoption or benefit.
6. Use the [two-phase session harness](CONVERSATION_SESSION_EVALUATION.md) to bind
   exported context and subsequent explicitly reported adoption to the same
   tenant/project/task/version. Effects and savings remain unknown without
   independent evidence.

The input distinguishes `user_decision`, `worker_claim`, `assistant_claim`, and
`tool_result`. Each requires a matching source role. Role names and content hashes
are provenance, never authenticity or attestation. Raw transcripts, arbitrary
extra fields and caller-supplied verification flags are rejected. The bridge
redacts email, phone and home-directory details before persistence; credentials
are rejected rather than retained. Sensitive-data redaction is not blanket
permission to send or save health, financial or personal information. Keep the
input to minimal approved operational facts.

A retained contact/configuration fact should include environment, purpose,
observation date, source and revalidation conditions. Prefer an internal record ID
instead of a phone number. Do not treat a remembered ID, an earlier budget, or a
past permission as authorization for a new call. Re-read current source records
and applicable test policy before acting.

## Example (invented fixture data only)

```json
{
  "schema_version": "conversation-memory/v1",
  "tenant_id": "example",
  "project_id": "demo-project",
  "session_id": "parent-session",
  "event_id": "event-one",
  "occurred_at": "2026-10-03T09:00:00Z",
  "producer": "dot",
  "sources": [{
    "id": "user-choice",
    "role": "user",
    "ref": "fixture:user-choice-one",
    "text": "Use the synthetic staging contact ID 42 for the identity scenario; check the fixture digest again before each run."
  }],
  "candidates": [{
    "id": "contact-reference",
    "kind": "fact",
    "claim_type": "user_decision",
    "conclusion": "The synthetic staging identity test uses contact ID 42.",
    "rationale": "The fixture owner selected this record for the identity scenario.",
    "reuse_rule": "Only for synthetic staging. Revalidate the current fixture digest and permission before each run. This memory is not call authorization.",
    "source_ids": ["user-choice"],
    "work_type": "implementation"
  }]
}
```

`kind` is classification requested by the producer, not a verified extraction
judgment. `occurred_at` is caller-supplied observation time. Full provenance is
kept with the pending candidate; accepted records retain source role, original
reference, span/event/session references, content hashes and a timestamp marker.
Canonical UUID identities (including modern UUID versions) are preserved in
known identity fields. Other identities that would be mistaken for phone data
are rejected; use a stable non-sensitive label and a safe source reference.
Rationale/reuse fields are never inferred by the bridge. Limits reject oversized
fields rather than silently truncating a safety condition.

Interactive proposal and confirmation prose accepts calendar-valid ISO dates,
including the date portion of an ISO timestamp. The exception covers only a
complete phone-pattern match: invalid dates, a leading `+`, additional phone
digits, and `tel:`/`mailto:` values still reject. Credential/email checks inspect
the original prose and its NFKC form without replacing date text first. Oversized
interactive prose rejects before truncation could create a valid date prefix.
Source references allow dates only within a clean HTTPS path or a canonical
`repo:<project-id>/<relative-path>` reference. Repository paths contain non-empty
segments of letters, numbers, dot, underscore or hyphen; `.`/`..`, absolute or
backslash paths, URI arguments/fragments and percent encoding are rejected.
Repository references must already be NFKC-normalized (the bridge normalizes
supplied text). A date in the project identifier has no exception. The exact
source reference is preserved through review and retrieval; arbitrary references
and longer phone candidates do not gain a date exception.

```sh
# Choose the intended private local database explicitly.
orgbrain memory import conversation --input event.json --db memory.sqlite > plan.json
# Review plan.json, then use its unchanged plan_hash.
orgbrain memory import conversation --input event.json --db memory.sqlite \
  --expected-plan-hash HASH_FROM_PLAN --execute > staged.json
# Send one returned candidates[i].proposal as JSON on stdin.
orgbrain memory propose --db memory.sqlite < proposal.json > proposal-receipt.json
# confirmation.json must contain the real answer and matching token, never a
# default approval generated by a script. Use the existing propose/confirm schema.
orgbrain memory confirm --db memory.sqlite < confirmation.json
orgbrain memory confirmation-status --db memory.sqlite < token.json
orgbrain memory context 'staging identity contact' --tenant-id example \
  --project-id demo-project --task-id next-task --principal-id local-reader --db memory.sqlite
```

The confirmation CLI reconciles its actual MCP result into the pending queue and
retains the canonical confirmation receipt. Check status after an uncertain
result before retrying. CLI review commands use local storage explicitly; they do
not silently substitute for a configured remote backend.

## Installation and coexistence

Build `node scripts/build-standalone.mjs dist/orgbrain.mjs` in an exact-commit
worktree. `node dist/orgbrain.mjs version --json` reports the embedded source SHA.
Verify the artifact hash and run the packaged tests before switching a runtime.
Keep existing workspace maps, database, connector settings and user-authored hook
customizations. Back up the database and current runtime first. If an installed
checkout has uncommitted behavior, a clean upstream build does not include it:
reconcile in a separate worktree, validate both features, and label the combined
artifact's base SHA and patch digest honestly. Never overwrite a dirty checkout
or claim that a mixed build is byte-identical to upstream.
