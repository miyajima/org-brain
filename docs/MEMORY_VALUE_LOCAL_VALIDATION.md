# Local memory value: capture, retrieval and usable context

## Scope and baseline

This work starts from `0c34324`. It targets three component bottlenecks in the
local memory path: grounded reusable lessons, natural task-query retrieval, and
preserving usable evidence in automatic context. Fixtures are synthetic and use
isolated disposable stores. No production memories, private session histories,
external inference, deployment or runtime enablement are part of this change.

The earlier [live comparison](MEMORY_EFFICIENCY_LIVE_2026-09-23.md) required
manually shortened queries and curated memory hits. It did not establish natural
query recall or automatic memory capture. Compaction alone did not establish a
whole-task token reduction. These limits remain important: retrieval quality,
complete-context delivery and verified-use bookkeeping are component measures,
not measured session token, turn, elapsed-time or billing savings.

## Verification plan

- Compare unchanged synthetic inputs on baseline and final source revisions
- Include unrelated, ambiguous, cross-project, stale and unsupported-evidence
  controls; preserve permission, confirmation and verification boundaries
- Keep all context within the existing whole-entry budget, record only delivered
  items, and never turn a retrieved item into a verified outcome
- Run relevant focused tests and applicable lint, type, aggregate, build and
  integration checks on the final code, recording failures and unrun checks
- Publish reproducible reports and a draft PR; no main merge or deployment

Results and commands will be added after running against the final implementation.
