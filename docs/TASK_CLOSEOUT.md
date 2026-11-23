# Local task closeout checkpoints

Save a small handoff when a substantive task pauses, changes hands, or closes
and the evidence trail would be expensive to reconstruct. This is optional
task state, not a routine activity log or a source of durable knowledge.

Run from an OrgBrain-mapped checkout (the normal private workspace map or
`.orgbrain.local.json` must supply both tenant and project). Reuse the same
explicit task ID and checkout when resuming. The Git worktree, tenant, project,
and task ID are all part of the lookup; a different worktree is not treated as
the same scope even when it inherits the same project configuration.

```sh
orgbrain task checkpoint save --task-id checkout-validation --input - <<'JSON'
{
  "scope": "Check the checkout before opening a PR",
  "completed": [
    {
      "work": "The targeted integration suite completed",
      "evidence": [{ "kind": "check", "ref": "receipt:integration-42" }]
    }
  ],
  "unverified": [
    { "reason": "not_run", "detail": "The live smoke test was not run" }
  ],
  "next_action": "Run the live smoke test if authorized"
}
JSON
orgbrain task checkpoint resume --task-id checkout-validation
```

- **Completed:** tie each summary to existing evidence identifiers. Evidence
  may be a check, a scoped read, a complete search, or an immutable source.
  Use the original identifier, not an invented receipt. A read or source is
  not proof that a test passed. The checkpoint records the type and pointer
  but does not independently verify the caller's claim or follow the reference.
  The sample reference above is illustrative.
- **Unverified:** record each check not run, failed, blocked, or missing
  evidence with `not_run`, `failed`, `blocked`, or `missing_evidence`.
- **Next action:** one concrete step or `null` when there is none. Resuming
  returns that step as text; it never executes it or grants permission.
- Pass compact, single-line summaries and opaque evidence identifiers only.
  The schema rejects extra fields and raw transcript/command-output containers;
  routine secret redaction still applies. Do not paste logs, credentials,
  full prompts, or identifying details into the summary fields.

The save command atomically replaces only the last closeout for this scope
in the existing private local task-context database (`ORGBRAIN_LOCAL_DB`,
or the normal local default; override explicitly with `--db`). The snapshot
expires after seven days. Resume reads the same database, returns
`found: false` for missing/expired/scoped-out checkpoints and
`verification: historical_not_reverified` for a match, even when there
were no unverified items at save time. Recheck anything that matters now.
No cloud sync, cross-device recovery, legacy hook changes, retrieval
indexing, sharing, memory capture, or deployment is implied.

## Applying the idea to everyday memory

Use the principle, not the whole task format. A durable memory should be an
atomic reusable decision, preference, constraint, or lesson with its source,
verification/confirmation state, scope, and reuse conditions. Keep uncertain
items on the existing review path, keep stale evidence distinct from a
fresh check, and don't force an artificial next action on a stable fact.

A checkpoint is deliberately not a promotions queue. To retain a useful
lesson, extract only the reusable claim with its source, rationale, and
reuse conditions and submit it separately through the
[existing memory contract](MEMORY_CONTRACT_V2.md). Its normal evidence,
sensitivity, review, and authority rules still apply. Saving or resuming a
checkpoint does not certify, extract, or promote anything.

## Read, use and effect statistics

`task checkpoint resume` records a successful scoped read and returns a
`read_id`. A missing, expired or invalid checkpoint is not counted. Use
`task checkpoint inspect` for a read-only inspection, including checking a
newly saved checkpoint. A read does not mean that the checkpoint was used.
Existing reads before this feature cannot be reconstructed.

After the work, explicitly report the outcome for the returned read ID, from
the same task and checkout:

```sh
orgbrain task checkpoint report --task-id checkout-validation --input - <<'JSON'
{"read_id":"read:REPLACE-WITH-RETURNED-ID","use":"used"}
JSON
orgbrain task checkpoint report --task-id checkout-validation --input - <<'JSON'
{"read_id":"read:REPLACE-WITH-RETURNED-ID","effect":"positive","evidence":"check:integration-42"}
JSON
orgbrain task checkpoint stats --task-id checkout-validation
```

Use is `used`, `not_used`, or `unknown`; the initial state is unknown.
An effect is `positive`, `neutral`, `negative`, or `unknown`, and
requires a reported use and an existing opaque evidence identifier. Both use
and effect are self-reports; an evidence identifier is not independently
verified. Do not infer an effect from a successful task or invent a reference.
An effect can be replaced by a later report. To correct a use report after an
effect was recorded, first submit `{"read_id":"...","effect":"clear"}`,
then report the corrected use state.

Stats aggregate read events across the mapped tenant and project, including
its worktrees. They distinguish unreported effects from explicitly unknown
ones. Records contain no checkpoint body, and are local, separate from memory
retrieval. Read metadata older than 90 days is removed on a subsequent tracked
read; it is not a guarantee of deletion at the exact expiry time. Closeout
content still expires after seven days. No reporting or task resumption is
automatic, and no result establishes a saved-time estimate.

## Propose one separately grounded lesson

When an existing local checkpoint leads to a reusable documented rule, use
`orgbrain task checkpoint propose-lesson --task-id <same-id> --input -`.
The input is a separate object, not the checkpoint:

```json
{
  "conclusion": "Require reviewer approval before changing the dispatch rule.",
  "rationale": "A shared dispatch rule affects every caller in this project.",
  "reuse_when": "When changing the rules of the same dispatch queue.",
  "source": { "path": "docs/dispatch.md", "start_line": 12, "end_line": 12 }
}
```

Use the exact wording of a single rule from up to four lines of a committed
Markdown or text file in the same Git checkout. OrgBrain independently reads
the regular Git blob at current HEAD, verifies the selected wording, and pins
the commit, line range, and content digest. Working-copy edits, checkpoint
receipt IDs, fabricated references, and incomplete reads cannot serve as
evidence. This proves only what the document says, not any claimed execution;
the rationale and reuse condition are also reviewed by the user.

**Proposal is not a save.** Present the lesson, rationale, reuse condition,
and cited scope to the user. Only after actual approval use the existing
`orgbrain memory confirm` command on the same local database with the
returned `tenant_id`, `confirmation_token`, `approved: true`, and the
user's actual `review_answer`. Until then, this lesson is not retrievable.
An edited lesson requires a new proposal against its supporting passage.
A confirmed lesson is project-scoped semantic memory with document
provenance and partial verification, never a verified execution result.
The checkpoint itself is not copied, shared, or indexed.
