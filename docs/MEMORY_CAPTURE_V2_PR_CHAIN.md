# Memory Capture v2 chained pull requests

This change is intentionally split into five ordered, independently mergeable
pull requests. Public behavior stays off until the final rollout. Later PRs are
rebased on the preceding PR; they must not be merged out of order.

| PR | Scope | Default-safe boundary | Planned harness route |
|---|---|---|---|
| 1 | Private corpus/scorer, corrected command/compact fixtures | no runtime behavior change | Low: `gpt-5.6-terra/max` fallback |
| 2 | Stateless observe tool, hidden instruction, current-turn verifier and command attestation | `memory_learning_mode=off` | Medium: `gpt-5.6-terra/xhigh` |
| 3 | Migration 0030, attestor permission, verified persistence and decision link | additive API/schema; blocking remains off | High: `gpt-5.6-sol/high` |
| 4 | Verified-learning retrieval generation and Console provenance/dimensions | v4 remains assigned until explicit rollout | Medium: `gpt-5.6-terra/xhigh` |
| 5 | Canary/effect measurement, 95+ certifier, smoke and rollback runbook | flags and generation assignment provide immediate rollback | Low: `gpt-5.6-terra/max` fallback |

The requested `gpt-5.6-luna/max` route for PR 5 is unavailable in the current
model catalog, so PR 5 uses the documented `gpt-5.6-terra/max` fallback. The
implementation itself is parent-only because these PRs share contracts and are
order-dependent; no sub-agent or external runtime owns edits.

## Merge gates

1. PR 1: manifests contain no transcript text; all seven scores are independent
   and insufficient samples fail closed.
2. PR 2: at least 60 adversarial evidence cases produce zero false verified;
   Stop performs one known batch call and reads no more than 4 MiB.
3. PR 3: only a `memory:attest` principal can write verified state; legacy rows
   remain `legacy + unverified`; Local and Cloud hashes match.
4. PR 4: the five learning channels exclude synthetic/unverified rows; the
   300-query locked fixture must meet every 95% threshold before assignment.
5. PR 5: lint, typecheck, full test, build, restore drill, 200-request live smoke,
   24-hour canary, and seven-day non-blocking decision observation pass.

No PR applies a production migration, mutates production memory, changes a
generation assignment, or enables a public flag as part of source merge.
