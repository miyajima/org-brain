---
title: Org Brain architecture
doc_type: architecture
status: approved
owner: org-brain-maintainers
last_updated: 2026-08-19
---

# Org Brain architecture

## System context

Org Brain sits between agent hooks/session stores, a local SQLite memory store,
and the Cloudflare API/D1 deployment. The autonomous controller is the policy
boundary for capture, qualification, maintenance, and rollback.

## Technology stack

Node.js CLI and SQLite provide local-first capture and maintenance. Hono on
Cloudflare Workers, D1, FTS, and scheduled workers provide the shared path.
Ed25519 metadata, SHA-256 content hashes, and versioned policy files provide
provenance without retaining transcripts or reasoning.

## Infrastructure and deployment topology

Local installations use hooks plus a daily macOS LaunchAgent (or an equivalent
scheduled local runner). Cloud installations use the cap-runner scheduled
worker. Both invoke the same policy, risk tiers, mutation budgets, and
post-apply rollback checks.

## Major components

- session importer and hook bridge: privacy-safe projections and routing;
- deterministic verifier and machine-reference council: qualification;
- local/cloud stores: quarantine, active memory, versions, and indexes;
- autonomy controller: policy, judge execution, maintenance, tuning, and
  circuit-breaker rollback;
- quality certifier: independent Wilson gates and hard guardrails.
- Domain Pack registry and installer: canonical, signed distribution of
  managed-object types, metric definitions, Dashboards, and external execution
  asset references; examples remain preview-only.
- Pack Workspace read model: scoped KPI, Decision rationale, evidence, Outcome,
  and non-secret Connector readiness over the installed registry and immutable
  Snapshot history; it does not execute Connectors or Workflows.

## External systems and integrations

Managed judges are optional and policy-selected. `local` uses a local model;
`deny` never promotes semantic candidates. Cloud writes require the existing
authenticated capture/learning transport and fail closed on missing authority.

## Data and control flow

Session events are projected without raw content, deterministically checked,
and written as active or quarantine candidates. Scheduled maintenance applies
bounded risk-tier mutations, verifies indexes and retrieval coverage, and
records a run hash. A violation moves the scope to shadow and restores the
last-known-good policy.

## Boundaries and dependencies

Tenant, project, workspace, Git common-directory, and retention boundaries are
immutable to AI tuning. The controller depends on deterministic verifiers and
the independent council but never on human signatures or approval state.

Domain metrics are an aggregate evidence layer, not a replacement TSDB. Pack
Manifests contain registered adapter/query-template IDs but no secrets or
executable code. Enterprise owns Pack Builder entitlements, review, signing,
tenant-private publication, and revocation; OSS owns install, custom metrics,
Dashboard consumption, and read-only MCP context.

## Cross-cutting operational concerns

All private artifacts use mode 0700 directories and 0600 files. Raw
transcripts, reasoning, credentials, absolute home paths, and command output
are excluded. Every automatic action carries a run ID, policy hash, input
hashes, judge metadata, and post-apply result.

## Alternatives

A human review queue remains only as a compatibility reader for old artifacts;
it is not an operational dependency. Physical deletion remains a separate,
explicit retention-policy operation rather than an AI quality action.
