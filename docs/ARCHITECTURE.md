---
title: Org Brain architecture
doc_type: architecture
status: approved
owner: org-brain-maintainers
last_updated: 2026-08-20
---

# Org Brain architecture

## System context

Org Brain is a decision and memory layer between people, agent clients,
workspace/session sources, and shared organizational systems. Its primary
human projection is the decision chain `Decision -> Reason -> Evidence ->
Artifact`; Skills and named Agent Loadouts distribute approved knowledge into
runtime work.

The Cloudflare deployment is the source of truth for shared P0 assets. Local
SQLite remains the source of truth for personal local memory, but it is not a
second authority for shared Skills or Agent Loadouts.

## Technology stack

- Astro on Cloudflare Pages provides the Console and same-origin API proxy.
- Hono on Cloudflare Workers provides the API Gateway and stateless MCP
  endpoint.
- D1 stores decisions, policies, immutable version metadata, named Agents,
  Loadouts, tasks, audit events, and usage facts.
- R2 stores Skill file bodies. D1 stores each object's R2 key, SHA-256 hash,
  media type, and byte size.
- Cloudflare Queues and the capability runner execute asynchronous Skill
  generation. Durable Objects retain existing concurrency controls.
- Ed25519 metadata, SHA-256 content hashes, and versioned policies preserve
  provenance without persisting transcripts or model reasoning.

## Infrastructure and deployment topology

```text
Browser -> Console Pages -> API Gateway -> D1
                                  |       -> R2
                                  |       -> Queue -> capability runner
Agent/MCP client -----------------+                    -> generation provider
```

The Console, MCP, and direct API surfaces converge on the same Gateway services
and unified authorization decision. Provider credentials remain server-side.

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
- Domain Recall plane: deterministic, ACL-first retrieval of Pack-scoped
  Decision units for Local CLI/hooks and opt-in Cloud API/MCP injection.
  Candidate events store a query SHA-256 and evidence metadata, never a raw
  prompt or evidence body.

## External systems and integrations

Connector providers, CI/observability/CRM/product-analytics systems, identity
providers, and external Workflow runners remain outside OrgBrain authority.
OrgBrain stores registered adapter/template references, aggregate snapshots,
execution references, and evidence metadata; it does not embed provider secrets
or execute arbitrary Pack code.

## Data and control flow

Writes preserve canonical records and immutable versions before producing FTS,
graph, Dashboard, Recall, or cache projections. Reads authorize candidates
before ranking and aggregation. Local-to-Cloud promotion verifies a portable
archive before changing authority, after which Local writes become proposals.
## Decision read plane

The Decision Briefing, Decision Trace, and Decision Map are bounded read models
over the existing decision, rationale, resource, artifact, Skill, Agent,
binding, and usage originals. The Gateway authorizes every candidate node
before aggregation. Unreadable nodes, their edges, and their counts are omitted
rather than returned as redacted placeholders.

The map returns at most 150 nodes and 300 edges and marks truncation. Confirmed
relations are the default; inferred relations are queried only when the caller
explicitly opts in. The Console renders the same authorized contract as a 3D
view, keyboard-operable 2D list, and mobile timeline.

## Knowledge distribution plane

`skill_assets` is the mutable Skill identity and lifecycle record.
`skill_asset_versions` and `skill_asset_files` are immutable version records.
Every generated Skill starts as a private draft, is validated against the
shared Skill schema, and becomes publishable only after all R2 writes and D1
metadata writes succeed.

Named Agents point to named Loadouts. Bindings select `always`, `auto`, or
`on_demand`, an explicit priority, and either a pinned version or the latest
published version. Runtime resolution evaluates Agent, Loadout, Skill, and
version state against the current policy. `on_demand` returns metadata and a
fetch handle, not the Skill body.

## Boundaries and dependencies

The following access, generation, runtime, and storage boundaries are explicit
dependencies of every Console, API, MCP, hook, and migration path.

## Access-policy boundary

`resource_access_policies` is the canonical shared-access policy for decisions,
memories, knowledge resources, Skills, Agents, and Loadouts. It uses the common
scopes `private`, `project`, `group`, `tenant`, and `restricted`, together
with owner, allowed subjects, project, storage location, and policy version.

Legacy visibility and permission fields remain compatibility mirrors during
the migration. New APIs read only the unified policy. Shadow comparisons record
differences without leaking content; operators can temporarily restore the
legacy read path while repairing policy rows.

Domain metrics are an aggregate evidence layer, not a replacement TSDB. Pack
Manifests contain registered adapter/query-template IDs but no secrets or
executable code. Enterprise owns Pack Builder entitlements, review, signing,
tenant-private publication, and revocation; OSS owns install, custom metrics,
Dashboard consumption, and read-only MCP context.

## Cross-cutting operational concerns

## Skill-generation boundary

The generation task receives only selected Decision, reason, and Resource
references plus immutable version hashes and explicit user instructions. The
runner does not discover raw conversations, unselected sources, repository
content, or source code.

A common provider interface supports configured OpenAI, Gemini, and Anthropic
adapters. Only configured providers are advertised to the Console. Timeout,
invalid structured output, duplicate execution, retry exhaustion, R2 failure,
and publish conflict all fail the task without publishing a partial version.

## Runtime context boundary

`orgbrain_context_enrich` accepts an optional `agent_key`. When present and the
Loadout feature flag is active, resolution is ACL-first and uses the current
published state at request time. Revocation therefore takes effect on the next
request. When absent or disabled, the existing context path remains unchanged.

Domain Recall is a second, explicitly gated enrichment. The local hook uses
`DOMAIN_RECALL_MODE=off|shadow|on`; Cloud uses the same flag and adds
`DOMAIN_RECALL_HOOK_MODE=off|personal|team`. Existing Context Enrich responses
remain byte-shape compatible unless `include_domain_recall=true` is supplied.
Recall MCP installations use purpose `recall`; capture installations remain
restricted to the capture tool. Runtime actor and owner principal are recorded
separately, and authorization is evaluated against the owner.

Local SQLite is authoritative until a verified portable JSONL archive is
accepted by Cloud. Promotion changes Local to read-cache plus proposal-outbox
mode; it does not dual-write mutable domain knowledge. Import records are
canonicalized, SHA-256 verified, planned before apply, and reject an existing
ID with a different digest.

## Existing subsystems

Session ingestion, deterministic verification, quarantine, retrieval,
maintenance, agent messages, tasks, Resources, and Operations remain separate
authoritative subsystems. Memory Explorer and Resources are supporting views
from a decision; Tasks and Operations move under Manage without being removed.

## Cross-cutting concerns

- Tenant, project, workspace, Git common-directory, and retention boundaries
  are immutable to AI tuning.
- Browser traffic uses the Pages proxy; service credentials never reach the
  client.
- Raw transcripts, reasoning, credentials, absolute home paths, and command
  output are excluded from generation and audit records.
- Every mutation records actor, tenant, action, outcome, request ID, hashes, and
  version metadata without storing protected content in audit metadata.
- Additive migrations are not rolled down. Feature flags disable reads and
  runtime resolution while preserving Skill, Agent, policy, usage, and R2
  version data.

## Rollout topology

`DECISION_CONSOLE_MODE=off|beta|on` gates the new read and Console surfaces;
`LOADOUT_RESOLUTION_MODE=off|beta|on` independently gates Agent context
resolution. `DOMAIN_RECALL_MODE`, `DOMAIN_RECALL_HOOK_MODE`, and
`PORTABLE_ARCHIVE_MODE` independently gate Recall and authority migration.
Beta is staging-only. After migrations and shadow comparison, the
deployment order is API migration, API/runner, then Console. Production changes
to `on` only after security, performance, accessibility, migration, and live
smoke gates pass.

## Alternatives

A separate Skill store or permission system was rejected because it would
create competing authorities. A Loadout-time permission snapshot was rejected
because it would delay revocation. Physical rollback of additive migrations was
rejected because disabling readers and resolvers is safer while preserving
immutable versions and audit evidence.
