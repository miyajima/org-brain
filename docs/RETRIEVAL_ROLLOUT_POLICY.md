# Retrieval v3/v4 rollout and retirement policy

`hybrid_v4` is the current promotion candidate and must remain available as an
explicit `search_mode=hybrid_v4` path in every rollout state. Turning off a
shadow or retiring v3 does not delete v4 code or v4 projections.

## Mode semantics

| Mode | Response path | Background work |
| --- | --- | --- |
| `off` | Existing default response | No shadow request |
| `shadow` | Existing default response | Deterministically sampled comparison only |
| `canary` | Sampled default requests use that version | No additional shadow for those requests |
| `on` | Default `memories` requests use that version | No legacy shadow unless separately configured |

Explicit `hybrid_v3` and `hybrid_v4` requests always use the requested version.
When both versions are eligible for default routing, v4 takes precedence. The
production default is v3 `off` and v4 `shadow` at 5%, avoiding permanent double
shadow and keeping a measured v4 promotion path.

## Promotion gates

Promotion from `shadow` to `canary` requires all of the following:

- projection parity fixture: identical v3/v4 unit IDs and deterministic top-5
  output between the SQLite and D1 logic for every committed fixture;
- at least 10,000 sampled production queries over seven consecutive days;
- shadow error rate below 0.1% and no statistically meaningful empty-result
  regression;
- p95 added latency within the service latency budget;
- no tenant, project, `at`, `include_suppressed`, permission, or redaction
  semantic mismatch;
- an owner and rollback procedure recorded in the release change.

Promotion from `canary` to `on` requires seven additional consecutive days,
no severity-1/2 retrieval incident, and no quality or latency regression at the
canary percentage. Increase canary traffic in bounded steps; do not jump from a
small shadow directly to `on`.

## Rollback and retirement

- Any gate failure returns the candidate to `shadow` or `off` immediately.
- Keep v3 rebuildable while v4 is in shadow or canary and for 30 days after v4
  reaches `on`.
- Retire v3 response routing only after the 30-day rollback window and a
  successful backup/restore drill.
- Delete v3 projection data only after routing is retired, queue producers are
  disabled, a row-count/digest snapshot is stored, and a rebuild test passes.
- v4 projection data is not deleted by v3 retirement. It is deleted only by a
  separately reviewed v4 replacement or data-retention operation.
