---
title: Org Brain architecture
doc_type: architecture
status: approved
owner: org-brain-maintainers
last_updated: 2026-08-18
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

## Deployment topology

```text
Browser -> Console Pages -> API Gateway -> D1
                                  |       -> R2
                                  |       -> Queue -> capability runner
Agent/MCP client -----------------+                    -> generation provider
```

The Console, MCP, and direct API surfaces converge on the same Gateway services
and unified authorization decision. Provider credentials remain server-side.

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

## Access-policy boundary

`resource_access_policies` is the canonical shared-access policy for decisions,
memories, knowledge resources, Skills, Agents, and Loadouts. It uses the common
scopes `private`, `project`, `group`, `tenant`, and `restricted`, together
with owner, allowed subjects, project, storage location, and policy version.

Legacy visibility and permission fields remain compatibility mirrors during
the migration. New APIs read only the unified policy. Shadow comparisons record
differences without leaking content; operators can temporarily restore the
legacy read path while repairing policy rows.

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
resolution. Beta is staging-only. After migrations and shadow comparison, the
deployment order is API migration, API/runner, then Console. Production changes
to `on` only after security, performance, accessibility, migration, and live
smoke gates pass.

## Alternatives

A separate Skill store or permission system was rejected because it would
create competing authorities. A Loadout-time permission snapshot was rejected
because it would delay revocation. Physical rollback of additive migrations was
rejected because disabling readers and resolvers is safer while preserving
immutable versions and audit evidence.
