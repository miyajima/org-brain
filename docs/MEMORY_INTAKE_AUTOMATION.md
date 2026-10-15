# Local memory intake and tracking

## Intake verification

Verifier v4 checks a relevant workspace file, its Git state and content digest,
and a successful command observed in the current turn. Existing unchanged code
can qualify; creating an artificial edit is unnecessary. Required lesson fields,
sensitivity checks, deduplication, native consensus and eager capture gates remain
in force. Interactive decisions retain propose → explicit confirmation → confirm.

Wiki citations use the configured personal Wiki CLI to resolve immutable
`source:UUID@VERSION` originals, optionally with verified line ranges. The adapter
requires a complete source read, matching version and SHA-256. Its result proves
source provenance only. A past report, missing original logs or a local test cannot
prove a past production or live-call outcome. Those claims remain on hold. Current
rechecks may establish a narrower reusable lesson without asserting the past result.

The source resolver follows the personal Wiki's `next_char_offset` with
`--char-offset`, reading at most 16,000 Unicode characters per page. Every page
must retain the requested source ID, version and original SHA-256. It rejects
missing, repeated or skipped cursors, inconsistent completion flags and changed
bytes. Evidence is emitted only after hashing the complete concatenated source.
Reads are bounded to 256 pages (4,096,000 characters); exceeding that limit stays
on hold. Line ranges are validated against the complete text, never a shortened
substitute source.

The independent normative fixture is versioned as
`memory-ingestion-oracle-v2.json` with its own lock. It accepts unchanged-file
verification and preserves all other gates. The v1 dataset and lock are retained;
old qualification reports do not certify verifier v4.

## Cleanup

Preview with `orgbrain memory prune-transient --tenant-id default` and apply with
`--apply`. Explicit decisions, constraints, preferences, failure lessons, reuse
rules and meaningful configuration or migration information are retained.
Only conservative transient completion notices are selected. Automatic observed
capture rejects new matching notices before storage.

Cleanup uses native suppression and rechecks the selected version and hash before
each change. The memory disappears from active retrieval; immutable versions,
audit records and usage events remain. Restore a selected original version through
`orgbrain memory restore-version ID --tenant-id default --version N` under the
normal native owner/reviewer permission check. This is recoverable removal from
retrieval, not physical erasure. Cleanup does not change historical contribution
denominators or rewrite unknown assessments.

## Tracking

`orgbrain usage report --tenant-id default` now includes `collection_metrics`.
The existing local SQLite database stores one idempotent record per scoped turn:

- completed tool calls, delivered memory items and use observations;
- verified use records and deliveries without a use observation;
- transcript/turn identity gaps and observation rejection reasons;
- tenant, principal, project, task, turn and creation time.

No transcript, command output or original source body is copied into these metrics.
Counts are aggregates of recorded turns; the same item delivered in separate turns
can count multiple times. Missing collection evidence is a gap, not zero use or
harm. `first_recorded_at` marks the start of collection; earlier missing observations
are not reconstructed. Confirmed usefulness still requires its own evidence.

The CLI and fresh Stop-hook processes load the installed standalone bundle.
An already-running MCP process must reconnect before it loads new code. Verify the
actual build with `orgbrain version --json`; the semver alone does not prove freshness.

## Distribution compatibility

`node scripts/build-standalone.mjs OUTPUT` now runs the pagination regressions
and functional compatibility checks against the exact output bundle. The latter
use isolated temporary databases to exercise `memory prune-transient` preview,
recoverable suppression, protected constraints, retained usage history and
`usage report` collection gaps. A failing check fails the build before installation.
Run the intake integration regressions with
`node --test scripts/memory-intake-and-tracking.test.mjs` as well.

After installing a checked bundle, verify the actual CLI launcher and the local
MCP/Stop-hook launch paths. Existing MCP processes need reconnecting to load new
code. Confirm that `collection_metrics` is present and that large fixed-version
Wiki originals resolve with `verification_scope=source_provenance`. A restored
command or source receipt does not confirm a pending memory save or a task benefit.

Build from the source revision matching the installed CLI before applying a repair.
The build compares against the installed `orgbrain` interface by default. Set
`ORGBRAIN_COMPAT_BASELINE_CLI` to pin a specific previous bundle. It requires
that every previous public command signature remains available. A source tree
with an older HEAD can pass focused feature tests while losing newer commands.
