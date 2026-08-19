---
title: Domain Pack Platform
doc_type: reference
status: approved
owner: org-brain-maintainers
last_updated: 2026-08-19
---

# Domain Pack Platform

## Purpose

Domain Packs install a business operating model as one reviewed unit: managed
object types, metric definitions, dashboards, registered Connector references,
Skill/Workflow/Playbook references, and Loadout templates. The first-party
function Packs are Build Engineering, SRE, Sales, and PdM for B2C marketplace
products.

The Pack is a distribution contract, not an execution environment. It cannot
contain SQL, JavaScript, secrets, or arbitrary executable code. A Connector
metric references an adapter ID and a registered query-template ID. Workflow
execution remains in an external Runner; OrgBrain records the reference,
result, evidence, and before/after metric snapshots.

## Data ownership

Managed objects and Knowledge Resources are separate. A service, repository,
campaign, cohort, or experiment is a managed object. Its dashboard, report,
interview, runbook, or analysis is a Knowledge Resource.

High-frequency source time series remain in the observability, CI, CRM, or
product-analytics system. OrgBrain stores immutable aggregate snapshots with
observation time, expiry, query digest, evidence reference, and dimensions.
An expired measured snapshot is returned as `stale` with `value: null`; it is
never converted to zero.

## Pack installation

`POST /v1/domain-packs/installations/plan` resolves exact dependencies and
returns a canonical plan digest, connector permissions, install/upgrade/no-op
actions, and custom-key conflicts. `POST /v1/domain-packs/installations`
requires the current plan digest when supplied and is idempotent by tenant,
Pack ID, and manifest digest.

Pack-provided definitions have `origin_type=pack`. Upgrade only creates new
versions for changed Pack definitions. A same-key custom object, metric, or
dashboard is preserved and reported in the preview. Examples under
`examples/story-v1.json` are Builder/E2E inputs and are never installed by the
normal path.

Domain Pack releases can be first-party or tenant-owned `private`/`unlisted`.
The initial platform has no public Domain Pack listing. Revoked releases cannot
be newly installed. Uninstall disables the installation record but preserves
metric snapshots, Decision links, audit history, and provenance.

## Custom metrics

Custom metrics use the same `metric_definitions` registry as Pack metrics and
are available in every edition. A definition has an immutable version history,
scope (`tenant`, `project`, or `managed_object`), source (`manual`, `connector`,
or `derived`), unit, aggregation window, dimensions, freshness, target
direction, evidence source, and audit actor.

Derived definitions allow only `count`, `sum`, `average`, `ratio`,
`percentile`, `duration`, and `distinct_count` over registered metric keys.
Arbitrary SQL and JavaScript are rejected by the contract. A custom metric can
be used in a custom Dashboard and linked to an experiment or Decision without
being present in an installed Pack Manifest.

Enterprise Pack Builder copies a custom definition into an
`organization_overlay` draft and records the source definition/version. It
does not edit or delete the source custom metric. Publication records the
promoted release ID so OSS can audit the promotion while retaining
`origin_type=custom` on the original.

## Pack Workspace

`/domain-workspaces` is the daily operating surface for installed Packs;
Catalog, installation, and Enterprise Builder remain separate control-plane
flows. `GET /v1/domain-packs/:packId/workspace` returns the selected managed
object scope, metric groups, the current Decision, linked evidence and
Workflow, and source readiness in one `DomainPackWorkspaceV1` envelope.

Workspace values are never inferred. Current is the latest Snapshot in the
selected scope; Baseline is the Snapshot linked by `triggered_by_metric`;
Outcome is linked by `verified_by_metric`; Target is the newest target active
at observation time. Missing values are `unknown`. An expired value is
`stale` with no number and retains its last observation time and reason.
Pack-linked custom metrics are resolved from the shared registry and survive
Pack upgrades.

Every Connector metric receives an `unconfigured` row in
`metric_source_bindings` at install time. The row contains only a registered
adapter ID, query-template ID, non-secret connection reference, external scope
reference, status, and attempt/success/error metadata. A future Connector can
attach its connection to this row and submit immutable values through the
existing `POST /v1/metric-snapshots` endpoint with `source_binding_id`.
Provider SDKs, OAuth, credentials, scheduling, arbitrary SQL, and manual value
entry in the Workspace are intentionally outside this release.

Workspace reads use:

- `GET /v1/domain-packs/:packId/workspace`
- `GET /v1/metric-snapshots/query`
- `GET /v1/metric-source-bindings`

## Decision trace

`knowledge_assertions` remains the relation source of truth. Confirmed or
proposed relations use these predicates:

- `about_object`
- `triggered_by_metric`
- `sets_metric_target`
- `implemented_by_asset_run`
- `verified_by_metric`

Together with Knowledge Resource evidence, they support:

`managed object -> metric change -> Decision -> rationale -> evidence -> Workflow reference -> external run result -> post metric`

## API and MCP boundaries

REST provides Pack catalog/plan/install, managed object creation/search,
custom metric definition/version/binding/target/snapshot/query, generic
Dashboards, and Decision-domain links. MCP exposes only read operations:
`orgbrain_domain_context`, `orgbrain_managed_object_search`, and
`orgbrain_metric_query`. Pack creation, signing, publication, and revocation are
never exposed through MCP.

## Rollout and rollback

- `DOMAIN_PACKS_MODE=off|catalog|install`
- `DOMAIN_METRICS_MODE=off|shadow|on`
- `DOMAIN_WORKSPACES_MODE=off|preview|on`
- Enterprise: `PACK_BUILDER_MODE=off|preview|on`

Rollback revokes or pins a release and disables new mutations. It does not
delete Decisions, snapshots, audit events, existing Packs, or custom metrics.
