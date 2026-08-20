---
title: Domain Pack Platform
doc_type: reference
status: approved
owner: org-brain-maintainers
last_updated: 2026-08-20
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

`/domain-workspaces` is the human review and collaboration surface for
installed Packs. Daily questions, Recall feedback, and requests for an
explanation happen in the connected AI client. People open the Workspace when
they need to inspect the authoritative Decision and evidence, or review that
Decision together. Catalog, installation, and Enterprise Builder remain
separate control-plane flows. `GET /v1/domain-packs/:packId/workspace` returns
the selected managed object scope, metric groups, the current Decision, linked
evidence and Workflow, and source readiness in one
`DomainPackWorkspaceV1` envelope.

The Workspace presents information in this order:

1. current confirmed Decision and rationale;
2. evidence provenance and verification state;
3. outcome and follow-up Decision;
4. progressively disclosed metric and connector detail;
5. a collapsed AI activity log for audit-only use.

The Decision statement is the page title. Pack and view names are navigation
context, not hero copy or badges. The standard view does not repeat the Pack
name in an explanatory heading and does not keep usage instructions on screen.
A compact help menu explains the AI-versus-Workspace boundary on demand, while
the visual order and the Decision rail communicate the normal reading path.
Domain switching stays one-step on desktop and uses one native select on small
screens. Meeting view and link copying live in a single Share menu.

`view=meeting` provides a share-oriented view that keeps Decision, rationale,
evidence, outcome, and Pack context while hiding operational filters, metric
inspection, connector readiness, and AI activity. The Workspace generates a
copyable meeting-view link without creating a new share authority or changing
ACLs. Recall Trace links carry a validated same-application `return_to` path so
reviewers can return to the authoritative Workspace with tenant and language
context preserved.

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
Dashboards, Decision-domain links, opt-in Recall, and portable import. MCP
exposes domain reads plus bounded Recall feedback:
`orgbrain_domain_context`, `orgbrain_managed_object_search`, and
`orgbrain_metric_query`; a purpose=`recall` installation additionally exposes
`orgbrain_prompt_recall` and `orgbrain_domain_recall_feedback`. Pack creation,
signing, publication, and revocation are never exposed through MCP.

## Domain Recall

`recall_profile` is a declarative part of the Manifest. It selects an assurance
level, relevance threshold, known intent aliases, allowed managed-object types,
required scope keys, and an output budget. It cannot contain raw prompts,
customer data, code, SQL, or secrets. First-party story fixtures provide
positive, wrong-scope, conflict, stale-metric, and forbidden-customer-field
acceptance cases but remain validation-only inputs.

Recall filters ACL, tenant/project, managed-object identity, validity, and
personal suppression before applying the fixed weighted scorer. SRE uses
high-assurance exact `service` and `dependency` scope. Confirmation is a small
ranking signal, not a truth shortcut, so proposals and conflicts remain visible.
The response is at most 6 KiB, removes numeric values for stale/unknown metrics,
and includes evidence metadata only.

Automatic AI context is business-readable Japanese rather than a raw ranking
dump. It includes the confirmed Decision and rationale, rejected alternatives,
constraints, success conditions, human-readable metrics, evidence provenance,
Workflow, follow-up Decision, and a Trace link. Internal ranking keys and
feedback enums are not exposed in the answer copy. When an AI uses the memory,
its response contract requires a compact `参照した記憶` line and invites the
user to correct it conversationally with `範囲が違う`, `古い`, or `関係ない`.
Recall-purpose MCP tool descriptions map those phrases to bounded feedback
operations without mutating the underlying Decision.

The Workspace includes a Pack-filtered AI Recall history. Each event links to a
Trace showing why candidates were selected, their Scope and score, Decision
state, metric freshness, evidence metadata, and feedback. The event stores the
query SHA-256, owner/runtime identities, client installation, mode, and
candidate links; it never stores the raw prompt.

Local CLI supports Pack install/validation, metric snapshot ingest, Recall
preview/feedback, portable export/import, and Cloud-authority promotion. Normal
install never imports story fixtures and never overwrites a custom metric.
Portable imports require a successful digest/conflict plan before apply.

## Rollout and rollback

- `DOMAIN_PACKS_MODE=off|catalog|install`
- `DOMAIN_METRICS_MODE=off|shadow|on`
- `DOMAIN_WORKSPACES_MODE=off|preview|on`
- `DOMAIN_RECALL_MODE=off|shadow|on`
- `DOMAIN_RECALL_HOOK_MODE=off|personal|team`
- `PORTABLE_ARCHIVE_MODE=off|plan|on`
- Enterprise: `PACK_BUILDER_MODE=off|preview|on`

Rollback revokes or pins a release and disables new mutations. It does not
delete Decisions, snapshots, audit events, existing Packs, or custom metrics.
