---
title: Decision Console v2 release and rollback runbook
doc_type: runbook
status: approved
owner: org-brain-maintainers
last_updated: 2026-08-18
---

# Decision Console v2 release and rollback runbook

## Purpose

This runbook releases the Decision-first Console, shared Skill assets, Named
Agents, and Loadout resolution as one product release while validating each
layer behind independent feature flags.

## Release invariants

- Shared Skill and Agent data is authoritative in Cloud D1; Skill files are in
  R2 with D1 hash, size, and key metadata.
- `resource_access_policies` is the new API read authority. Legacy access fields
  remain compatibility mirrors for at least one release.
- Every generated Skill starts as a private draft. Provider execution never
  publishes.
- Agent and Loadout bindings never grant access. Revocation is evaluated on
  every preview and runtime context request.
- Migrations are additive and are not rolled down during product rollback.

## Flags

| Flag | `off` | `beta` | `on` |
| --- | --- | --- | --- |
| `DECISION_CONSOLE_MODE` | legacy Console/read path | staging v2 surfaces | production v2 surfaces |
| `LOADOUT_RESOLUTION_MODE` | existing context enrichment | staging ACL-first Loadout resolution | production ACL-first Loadout resolution |

Provider availability is independent. A provider is advertised only when its
server-side key and model configuration are present. Disable one provider by
removing or disabling only that provider's binding; existing immutable versions
remain readable.

## Preflight gates

1. Run `pnpm docs:validate`, `pnpm typecheck`, targeted package tests, Console
   Playwright, `pnpm lint`, and `pnpm build`.
2. Apply all migrations to a fresh local D1 database and run the migration
   smoke checks.
3. Run the 100,000-decision fixture. Require local p95 below 500 ms and gzip
   below 250 KiB.
4. Confirm generation failure tests for provider timeout, invalid schema,
   duplicate delivery, retry, R2 failure, and publish/revision conflict.
5. Confirm authorization tests for cross-tenant, same-tenant unauthorized,
   immediate revocation, and Group departure. Protected node, edge, count,
   Skill body, and effective-context leakage must all be zero.
6. Confirm ja/en/zh, desktop/mobile, keyboard, screen-reader semantics, reduced
   motion, and empty/error/stale states.
7. Confirm old Decision URLs preserve their query parameters and
   `tenant`, `project`, and `lang` when redirecting.

Do not start production rollout when any gate is missing, flaky, or failed.

## Staging sequence

1. Back up the current D1 schema and record current Worker/Page versions.
2. Apply migration 0034.
3. Deploy API Gateway and capability runner with
   `DECISION_CONSOLE_MODE=beta` and `LOADOUT_RESOLUTION_MODE=beta`.
4. Run API smoke for Briefing, Trace, Map, Skill generation, Publish, Agent
   preview, context resolution, Access Policy read/update, and policy shadow
   summary.
5. Deploy Console with `DECISION_CONSOLE_MODE=beta`.
6. Test empty, small, large, and mixed-access tenants. Inspect shadow
   differences; resolve all unexplained mismatches before production.
7. Run a staging generation with each configured provider and verify the draft
   remains private until an explicit Owner/admin Publish.

## Production sequence

Use one change window and keep the flags off until every component is present.

1. Apply the additive API migration.
2. Deploy API Gateway and capability runner with both feature flags `off`.
3. Deploy Console with `DECISION_CONSOLE_MODE=off`.
4. Run authenticated live API and Console smoke without changing the flags.
5. Change `DECISION_CONSOLE_MODE=on`.
6. Change `LOADOUT_RESOLUTION_MODE=on`.
7. Repeat the live smoke and watch access-policy shadow differences, task
   failures, provider failure rates, Decision API p95, response size, and
   context omission reasons.

## Live smoke checklist

- Decision Briefing opens and a Decision Trace is reachable in two transitions.
- Trace includes authorized reason, evidence, artifact, Skill, Agent, and
  outcome nodes with no dangling edges.
- Map defaults to explicit relations; inferred relations require the toggle.
- From `/map`, use `全知識を表示` (the `view=all` route) to switch from the
  representative view to the full readable-node view. The full mode requests
  `display=all` up to the 1,500-node API ceiling and surfaces any truncation.
- The selected Map preview shows status, incoming/outgoing connection counts,
  connected nodes, relation state, and a readable source link.
- A generated Skill is private and draft; Publish requires the correct role.
- R2 file bytes match D1 size and SHA-256 metadata.
- Agent preview separates injected, on-demand, and omitted items.
- Revoking a Skill policy removes it on the next preview/context request.
- Access Drawer reads and updates the same policy version across asset types.
- Old URLs and Manage/supporting pages remain reachable.

## Rollback

1. Set `LOADOUT_RESOLUTION_MODE=off` to restore existing context enrichment.
2. Set `DECISION_CONSOLE_MODE=off` to restore legacy Console/read behavior.
3. If one generator is failing, disable only that provider configuration.
4. If unified-policy results differ unexpectedly, return reads to the legacy
   compatibility path, inspect the shadow summary, repair/backfill policies,
   and rerun authorization tests before reenabling.
5. Keep migration 0034, Skill/Agent rows, usage records, generation records, and
   immutable R2 versions. Do not perform a down migration or delete evidence as
   part of application rollback.
6. Redeploy the last-known-good Worker/Page versions only if flags do not fully
   restore behavior, then repeat the legacy live smoke.

## Completion record

Record migration version, API/runner/Console deployment versions, feature-flag
timestamps, local and production p95, maximum gzip size, test commands/results,
configured provider list, shadow-difference count, live-smoke actor/tenant, and
rollback owner. Do not record credentials, Skill bodies, prompts, or protected
resource content.
