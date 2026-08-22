---
title: Org Brain System Design
doc_type: system_design
status: approved
owner: org-brain-maintainers
last_updated: 2026-08-21
---

# Org Brain System Design

## Scope and architecture alignment

This document defines the internal autonomous quality-control, memory capture,
maintenance, and rollback design described by `SPEC.md` and `ARCHITECTURE.md`.

## Decision-first execution plane

The human read model is anchored on the existing Decision original and follows
`Decision -> Reason -> Evidence -> Artifact -> Skill -> Agent -> Outcome`.
Decision Briefing, Trace, and Map are projections; they never become competing
sources of truth. Every candidate node is authorized before counts, edges, and
truncation are calculated. Hidden nodes therefore do not appear as placeholders
and do not leave dangling edges or observable hidden counts.

Decision Map includes saved and confirmed relations by default. An explicit
`include_inferred=true` request may add inferred relations. Responses are
deduplicated, limited to 150 nodes and 300 edges, and include a truncation flag.
The Console renders the same response through 3D, 2D list, and mobile timeline
adapters; keyboard selection and reduced-motion behavior do not change the data
contract.

### Unified access policy

`resource_access_policies` is the read authority for new APIs. A policy contains
tenant, resource type/id, `private|project|group|tenant|restricted` scope,
owner, project, group/restricted subjects, storage location, and a monotonically
increasing policy version. Update uses the expected policy version so concurrent
drawers cannot silently overwrite one another.

Legacy visibility and ACL data is backfilled and mirrored for compatibility.
`access_policy_shadow_diffs` records unified/legacy read differences using
identifiers and outcomes only. It does not store protected bodies. The new path
fails closed on missing or invalid policy; the compatibility flag can restore
legacy reads while operators repair shadow differences.

### Skill asset lifecycle

`skill_assets` owns mutable identity and lifecycle:
`draft -> published -> retired`. `skill_asset_versions` and
`skill_asset_files` are immutable. Each file is written to R2 and recorded in
D1 with path, media type, SHA-256 hash, byte size, and R2 key. Publish requires a
complete, schema-valid current version and Owner/admin authority.

Generation first creates a private draft and `skill_generation_runs` record,
then enqueues the existing task/capability path. The input object contains only
selected Decision/reason/Resource references, their version hashes, user
instructions, provider/model, and idempotency key. The runner rechecks ACL and
source hashes immediately before provider execution and before commit.

The common provider adapter returns structured output for the shared Skill
schema. Timeout, malformed output, duplicate delivery, exhausted retry, R2
failure, or concurrent revision marks the task failed. A version becomes
current only after every file is stored and the D1 commit succeeds; Publish is a
separate mutation, so a partial generation is never public.

### Named Agent and Loadout resolution

A Named Agent is selected by stable `(tenant_id, agent_key)` and points to one
current named Loadout. Each binding defines usage mode, priority, validity, and
version policy. Resolution orders by priority, resolves pinned or latest
published versions, and then intersects current policies and lifecycle states
for Agent, Loadout, Skill, and version.

`always` and selected `auto` items may include verified content. `on_demand`
items return name, summary, version, and a scoped fetch handle; the body is not
injected. Omitted rows include a non-sensitive reason code. Preview and runtime
resolution use the same resolver, while usage facts are append-only in
`asset_usage_events`. Permission revocation, Group departure, retirement, or
expiry therefore takes effect on the next resolution.

### Feature flags and compatibility

`DECISION_CONSOLE_MODE=off|beta|on` gates Decision Console read models and UI.
`LOADOUT_RESOLUTION_MODE=off|beta|on` independently gates `agent_key`
resolution. Legacy Decision URLs redirect to the new create/detail path while
preserving query parameters and `tenant`, `project`, and `lang`. Supporting
Memory, Resource, Task, and Operations URLs remain available for at least one
release.

## Decision Resource Intelligence

Resource identity, locations, immutable versions, relation assertions, and
version evidence form the canonical chain. URI resolution deduplicates within a
tenant, connector capture projects extracted text to stable retrieval units,
and confirmed assertions project to graph edges. Decision hydration remains an
adapter over the separate `decision_memories` and `decision_rationales`
originals.

Read traversal is authorization-intersection based: Resource-to-Decision must
authorize the Resource and every returned Decision; Decision-to-Artifact must
authorize the Decision and every returned Resource. Filtering happens before
grouping and coverage calculation so hidden counts are not observable.

## Topology
- `open-brain-mcp`: Cloudflare Accessで保護されたthin proxy。signed Access assertionとMCP allowlist headerだけをservice bindingへ渡す。
- `open-brain-api-gateway`: Hono HTTP API、task creation、stateless Remote MCP `/mcp`、client installation管理。
- `open-brain-org-router`: org-bus consumer, capability queue routing, and task result materialization.
- `open-brain-cap-runner`: capability consumers, DO lease/messaging, artifact writes, and memory maintenance cron work.
- `open-brain-console`: Astro Pages app with same-origin API proxying to the gateway via service binding.

## Data Model
- `tasks`: task state source of truth.
- `task_events`: append-only audit trail.
- `capabilities`: concurrency and schema catalog.
- `memories` / `memories_fts`: current memory snapshot and search index.
- `memory_versions`: immutable lifecycle history for capture/revise/refresh/suppress.
- `memory_edges`: lightweight lineage graph between memory rows.
- `entities` / `memory_entities`: searchable subject graph for memories.
- `decision_rationales` / `decision_evidence`: confirmed conclusion/reason structure plus evidence references.
- `decision_memories`: agent-facing decision-grade context rows with constraints, pitfalls, source refs, validity, status, confidence, and permission metadata.
- `decision_memory_versions`: append-only decision memory edit/confirmation history for the human review editor.
- `memory_confirmations`: short-lived propose/confirm state for interactive saves.
- `agent_messages`: durable agmsg-style agent inbox rows with target, thread, read, and ack state.
- `retrieval_events` / `retrieval_daily_metrics`: telemetry and daily rollups.
- `memory_impact_events` / `memory_impact_daily_metrics`: run-level eligibility and terminal reporting. They provide the denominator for reporting, memory-use, and avoided-lookup rates.
- `business_categories`: tenant-defined primary business classification; memories snapshot one category and one fixed work type.
- `retrieval_generations` / `retrieval_generation_assignments` / `retrieval_ranking_profiles`: stable retrieval control plane.
- `retrieval_units` / `retrieval_units_fts`: generation-scoped projection shared by evidence and governance sources.
- `memory_usage_events` / `memory_usage_items`: deduplicated per-memory reference facts with classification snapshots. An optional `external_run_id` links this attribution layer to an eligible run without merging their different evidence semantics.
- `memory_effect_events` / `memory_effect_attributions` / `memory_failure_patterns` / `memory_effect_daily_metrics`: append-only impact evidence and rebuildable rollups.
- `measurement_runs` / `measurement_variants` / `measurement_comparisons`: opt-in memory savings AB measurements.
- `knowledge_docs` / `knowledge_links` / `knowledge_docs_fts`: the knowledge-doc layer and inter-doc graph.
- `threads`: review-oriented conversation capture.
- `mcp_client_installations`: 無人hookの導入単位をowner principalへ結び付ける独立control-plane table。memory、rationale、decisionの親子構造や検索indexには参加しない。
- `memory_quality_runs` / `memory_quality_measurements` / `memory_quality_cases`: privacy-safe regression metadata. Case rows store only hashes, routes, split, reason codes, parity, and related IDs; they never store session text, reasoning, absolute paths, or command output.
- `domain_pack_releases` / `domain_pack_installations` / `domain_pack_install_items`: tenant-safe Pack catalog, idempotent installation state, and provenance.
- `managed_object_types` / `managed_objects` / relations / external refs: operational subjects kept separate from Knowledge Resources.
- `metric_definitions` / immutable `metric_definition_versions` / bindings / targets / snapshots / `metric_source_bindings`: shared Pack and custom metric registry plus non-secret Connector readiness. Snapshot reads map expired measurements to `stale` and `null`.
- `domain_dashboards` / `dashboard_metric_widgets`: generic Dashboard definitions that resolve metric keys through the installed registry, including Manifest-external custom metrics.
- `GET /v1/domain-packs/:packId/workspace`: installed-Pack operating view with scoped KPI groups, Decision-linked Baseline/Outcome, evidence, Workflow, and Connector readiness.
- `GET /v1/metric-snapshots/query` / `GET /v1/metric-source-bindings`: immutable history and future-Connector preparation reads.
- `domain_recall_units` / FTS: Pack-scoped Decision projection used only after
  tenant, project, object, scope, ACL, validity, and personal-suppression gates.
- `domain_recall_events` / `domain_recall_event_candidates`: prompt-hash-only
  execution trace plus normalized Pack/candidate membership for Workspace
  history. Feedback and review proposals never rewrite Knowledge Assertions.
- `portable_imports` / chunks / immutable records and
  `domain_authority_state`: staged Local-to-Cloud archive verification and the
  single-authority handoff.

## Domain Pack control plane

The API computes canonical JSON/SHA-256 digests, exact dependency order, a
dry-run install diff, and idempotent install/upgrade results. Pack upgrades can
mutate only definitions owned by the same Pack. Custom definitions and tenant
Dashboards are never overwritten. First-party Pack fixtures are validated from
the archive but never sent through the normal install data path.

The shared contract rejects unknown executable fields and limits Connector
queries to registered template IDs. Derived metrics use a fixed operation
allowlist. The three Domain MCP tools are read-only; Pack Builder and release
operations remain Enterprise HTTP/UI capabilities.

The Pack Workspace is a read-only daily surface. It joins installation
provenance, managed-object scope, the metric registry, immutable Snapshot
history, target versions, `knowledge_assertions`, Knowledge Resources, and
non-secret source bindings. Baseline and Outcome use only explicit
`triggered_by_metric` and `verified_by_metric` links. It does not execute a
Connector or Workflow and does not accept manual metric entry.

### Domain Recall

Each installed Pack may define a declarative `recall_profile`: assurance level,
threshold, intent aliases, permitted object types, required high-assurance
scope keys, and output budget. Profiles contain no prompts or executable code.
The scorer is deterministic: object `0.35`, intent `0.20`, scope/project
`0.15`, Decision link `0.10`, active-confirmed `0.08`, verified evidence
`0.07`, and fresh metric `0.05`. ACL, tenant/project, object identity, validity,
and suppression are hard filters before scoring. High-assurance SRE recall
requires exact service and dependency scope. Proposal and conflict state remain
visible; confirmation contributes only its bounded score.

Recall output is capped at 6 KiB, strips stale/unknown numeric values, exposes
evidence metadata rather than bodies, and links to `/domain-recalls/:id`.
`orgbrain_context_enrich` is unchanged unless Domain Recall is explicitly
requested. `orgbrain_prompt_recall` and feedback are available only to a
purpose=`recall` MCP installation; purpose=`capture` cannot cross that tool
boundary. Local hooks fail open on Recall errors and do not make a network call.

Feedback effects are separated: session dismissal is ephemeral, irrelevant or
wrong-scope creates a personal suppression, and outdated/incorrect-relation
creates a team review Proposal. None directly mutates a Decision or Knowledge
Assertion.

Portable archives are canonical JSONL with a header, per-record digests, and a
footer content digest. Cloud upload is chunked, then plan/apply; non-contiguous
chunks, digest mismatches, and same-ID/different-digest records are rejected.
After Cloud authority promotion, Local direct domain writes are blocked while
feedback and proposed changes enter an outbox.
- `resource_access_policies` / `access_policy_shadow_diffs`: unified access
  authority plus privacy-safe legacy comparison.
- `skill_assets` / `skill_asset_versions` / `skill_asset_files` /
  `skill_generation_runs`: Skill identity, immutable versions, R2 file
  references, and asynchronous generation state.
- `agents` / `agent_loadouts` / `agent_loadout_bindings`: Named Agent identity
  and version-aware Skill distribution configuration.
- `asset_usage_events`: append-only preview, resolution, injection, fetch, and
  outcome facts.

## Control Plane
- `LeaseDO`: tenant and capability concurrency gate.
- `MailboxDO`: short-lived operational mailbox for worker snapshots.
- Agent messages do not use `MailboxDO` as their source of truth; D1 remains the durable inbox and polling surface.

## Memory and Retrieval

### Local rationale backfill and grounding boundary

The CF/D1 `memory-rationale-backfill` planner and the local SQLite adapter are
deliberately separate persistence adapters. The CF/D1 planner writes
`decision_rationales` and `decision_evidence` rows selected by CF-specific
high-value tags. The local adapter reads `memories` through a read-only
connection, requires schema version 24, and selects only active AIma rationale
records with an existing stable `aima/...` artifact reference and SHA-256
digest. Missing conclusion, rationale, reuse condition, or evidence is skipped;
the planner never copies a transcript.

An apply keeps the existing memory `id` and `external_key`, creates a new
`memory_versions` snapshot through `LocalMemoryStore.revise`, and writes only
the structured `reuse_rule`, `learning_json`, `verification_state`, and
backfill provenance fields. The learning object is a review candidate
(`schema_version=2`, `capture_intent=review`) with an explicit gap stating that
the source artifact was not re-verified during backfill. Such rows are marked
`partial` and never promoted to `verified`. Apply first creates a private
`VACUUM INTO` backup, stops on a stale id/version or failed revision, rebuilds
all retrieval projections, and runs `doctor`; the backup is the rollback input.
Dry-run does not initialize the store, change permissions, rebuild indexes, or
write a plan unless an explicit plan-output path is supplied. The implementation
is `scripts/local-memory-rationale-backfill.mjs`; the reviewable command is
`pnpm local:memory:rationale-backfill -- --project aima --dry-run --json`.
Apply is a separate explicit invocation only after a human approves the emitted
plan.

Local grounding uses ordinary MemoryRecord retrieval plus declarative Pack and
portable-archive projections. A local SQLite database does not emulate Cloud
Named Agent Loadouts: it has no Cloud ACL/resource authority, published Skill
version resolver, or revocation boundary. Pack manifests and portable archives
therefore carry the reusable domain context; authority, ACL, version pinning,
and loadout resolution remain Cloud-only until a separate local contract is
approved.

- Shared retrieval logic lives in `packages/shared/src/memory-retrieval.ts`.
- Shared rationale inference heuristics live in `packages/shared/src/rationale-extraction.ts`.
- Runtime-neutral memory quality assessment lives in `packages/shared/src/memory-quality-runtime.mjs`; the Cloud TypeScript facade and Node compatibility entry point both execute this single classifier.
- Realtime hook and initial import carry explicit `capture_route` and optional `capture_batch_id`. Candidate payloads stay route-neutral so formal observe hashes remain comparable.
- Context Engine MVP logic lives in `apps/api-gateway/src/context-engine-service.ts`.
- Lifecycle-aware write logic lives in `apps/api-gateway/src/memory-lifecycle-service.ts`.
- Interactive rationale confirmation lives in `apps/api-gateway/src/rationale-service.ts`.
- Non-interactive hook rationale capture is exposed as the stateless MCP tool `orgbrain_memories_capture_rationale`; its persistence logic lives in `apps/api-gateway/src/rationale-service.ts` and writes inferred rationale/evidence rows without a confirmation token. The REST route is retained only for bridge compatibility.
- Retrieval is tier-aware: `canonical-memory` > `curated-memory` / `promoted-memory` > `memory-digest` > recent raw history.
- Lifecycle-aware filtering excludes `suppressed` and expired memories from normal retrieval.
- `semantic` memories are preferred over `episodic` memories when durable/profile candidates are sorted.
- Compact rows tagged `compacted` are excluded from retrieval and profile flows.
- Daily memory maintenance compacts old hook memories into digest rows and creates per-project canonical rows. `quality-v2` canonical summaries must expose representative reusable guidance instead of count-only labels.
- Manual memory cleanup can physically remove low-signal memory rows after exporting a JSONL backup. Cleanup deletes associated FTS, lifecycle, edge, entity, and rationale rows, then lets maintenance rebuild `quality-v2` canonical rows from the remaining high-quality memories.
- MemoryRecord v2 is the common logical source-of-truth contract for local SQLite and Cloud D1. FTS, embedding, graph, and cache layers are projections that must be rebuildable and must never receive an independent dual-write.
- SQLite remains the local default and D1 remains the shared Cloudflare
  default. PostgreSQL with pgvector is a future opt-in backend for measured
  scale, concurrency, transaction, analytics, or private-network requirements;
  it is not expected to improve retrieval quality by storage substitution
  alone. The backend contract, activation criteria, migration rules, and parity
  gates are defined in [`STORAGE_BACKENDS.md`](STORAGE_BACKENDS.md).
- Local SQLite uses the Node-bundled driver, WAL, schema version 24, SHA-256
  content hashes, immutable JSON version snapshots,
  verified backup/restore, `quick_check`, read-only query connections, and
  POSIX-private file modes.
- Startup removes obsolete legacy FTS triggers after creating a private backup,
  then rebuilds the derived FTS projection so the application remains its sole
  writer.
- Local SQLite maintains a reconstructable sparse-vector feature projection and
  feature-frequency catalog for offline semantic candidates. Search fuses FTS,
  sparse-vector similarity, memory edges, time, authority, and utility; delete,
  restore tombstone replay, verify, and rebuild cover both FTS and the vector
  projection.
- Cloud hard delete removes the authoritative memory plus FTS, version, edge, entity, rationale, and evidence rows before returning success; only a content-free `memory_deletions` tombstone remains for audit correlation.
- `GET /v1/memory-quality/runs` and `GET /v1/memory-quality/runs/:runId` expose read-only run summaries, seven separate axes, and privacy-safe case metadata. Excluded cases never join memory content. The console enables `view=quality` with `MEMORY_QUALITY_UI_MODE=off|beta|on`; remediation links to the authorized Memory detail.
- Mac validation writes only to `.local/memory-quality/<run-id>/quality.sqlite` and private reports. The evaluator has no network client, ignores Cloud endpoint variables, reads only root user sessions, and reports `insufficient_evidence` instead of lowering thresholds or inventing judge output.
- Interactive saves use `propose -> user confirmation -> confirm` and create `decision_rationales` as `user_confirmed` or `user_corrected`.
- Non-interactive hook ingestion writes promoted memory rows plus inferred rationale/evidence rows with `confirmation_state=inferred_unconfirmed`; these rows are explicitly not human-confirmed.
- Decision memory rows are an additive context shaping layer over the existing memory/rationale model. They are used by `/v1/context/enrich`, `/v1/context/pre-action-gate`, and the decision review queue to score task-relevant organizational context.
- Context scoring combines task text overlap, recency, source authority, project proximity, task specificity, permission fit, and penalties for deprecated/superseded/expired context.
- Minimal conflict detection groups same-title decision memories and reports active versus deprecated/superseded/expired contradictions in the enrich response.
- Decision editor provenance is opt-in for agent APIs: `includeProvenance`, `authorityScoring`, and `verificationView` default to false so compact benchmark retrieval remains unchanged.
- Decision memory edit/confirm flows update the current `decision_memories` snapshot and append `decision_memory_versions` rows for reviewability.
- Stable retrieval keeps evidence (`memories`) and governance (`decision_memories`) as separate ranked channels. Tenant/project generation assignment is fail-closed in enforce mode and can be rolled back without rebuilding source data.
- Usage telemetry stores hashes and normalized identifiers, not prompt, query, or command bodies. Effect revisions supersede earlier evidence without destroying it; reports never mix evidence levels.
- Hook ingestion resolves tenant and project together from the versioned local `workspaces.json`. A mapped workspace wins over the single-tenant environment fallback, while an explicit payload project applies only to that event. First reusable use can confirm `basename(cwd)` and writes the private mapping atomically; low-signal skips do not create it.
- Organization sharing fails closed when neither a workspace mapping nor `ORGBRAIN_TENANT_ID` resolves a tenant. Legacy `project-names.json` entries migrate without source deletion, and operator backfill/snapshot/usage-status jobs consume the same workspace-to-project roots.
- Retrieval refresh is best-effort: cap-runner and API memory search/profile update `last_accessed_at` and append a `memory_versions` refresh snapshot for top memory hits without blocking task execution.
- Resource compatibility migration advances independently through `knowledge_docs`, `decision_evidence`, and `decision_memory_sources`; cursor plus batch digest make retry progress observable and assertion idempotency keys prevent duplicate links.
- Resource snapshot capture advances `current_version_id` only for a new digest. Confirmed source evidence remains pinned to its original version, while the Resource lifecycle becomes `stale` and an idempotent `resource_version_changed` Proposal is queued for governance review.
- Resource snapshot text is deterministically chunked with source spans before insertion into generation-scoped retrieval projections.
- Resource graph consumers read the rebuildable `confirmed_decision_resource_edges` view over active Confirmed relation assertions; Proposal and retired assertions never enter normal graph or impact retrieval.
- Measurement mode is isolated from normal execution. API task creation expands one logical request into raw-context control and compact-memory treatment task variants, cap-runner records estimated token/cost/duration usage per variant, and both variants run with memory writes disabled so measurement does not pollute future recall. Shared `measurement_session_id` values group multiple measured turns into one session report.

## Orchestration and Reliability
- Queue consumers use explicit ack/retry behavior.
- Org Bus and capability consumers route exhausted messages to configured DLQs;
  operators can inspect failed/dead-letter counts and recreate a task from its
  immutable `created` event through `POST /v1/ops/tasks/:id/replay`.
- Capability `max_concurrency` is enforced by the lease Durable Object as a
  per-tenant quota. `cost_limit_ms` is enforced after execution as a hard
  duration-cost ceiling; over-budget results are failed instead of published as
  successful.
- Router validates envelopes and task results before materializing state.
- Memory upsert deduplicates `external_key` inside one request and resolves existing IDs in batches.
- Retrieval telemetry is best-effort so memory writes do not block task execution.
- Agent message sends dedupe only when clients provide `idempotency_key`, so repeated natural-language messages are not collapsed accidentally.

## Security
- Public API supports API keys, Cloudflare Access, generic RS256 OIDC, and
  hash-only stored scoped bearer tokens.
- Browser preflight requests for `/v1/*` and `/api/*` are handled before API-key auth, while non-OPTIONS requests still require `x-api-key`.
- Browser traffic uses the Pages proxy; the service API key never reaches the client.
- Remote MCPの対話クライアントはAccess Managed OAuth、無人hookは導入単位のAccess Service Tokenを使う。Gatewayはsigned assertionだけを検証し、本文や任意headerのprincipalを信用しない。
- MCP JWTは必須の`MCP_ACCESS_AUD`と`ACCESS_TEAM_DOMAIN`由来issuer/JWKSでAPI用OIDCから独立して検証する。`MCP_AUTH_MODE`未設定は`access`、明示した移行期間だけ`dual`を許可する。
- Service-token assertionはactive installationへhash lookupし、owner principalが現在もactiveであることを各認証時に確認する。owner principalと`client:<installation-id>` runtime actorを監査上分離し、hook capabilityは`orgbrain_memories_capture_rationale`だけに限定する。
- HTTP and mutating MCP calls append hash-chained outcome audit events.
- Fixed-role RBAC, record ACLs, scoped tokens, retention, and legal holds are
  enforced server-side; identity fields in request bodies never override the
  authenticated principal.
- An optional Workers `API_RATE_LIMITER` binding applies tenant + principal +
  route limits after authentication and before authorization; 429 outcomes enter
  the same denied audit chain.
- MCP監査はowner principal、runtime actor、installation ID、client type、auth sourceだけを構造metadataとして記録し、会話内容やpathを記録しない。`last_used_at`は同じ導入につき最大15分に一度だけbest-effort更新する。
- hook outboxはinstallation単位のlockとclaim fileでappend/flushを安全に分離する。明示されたinstallation credential fileは継承された旧認証環境変数より優先し、各hook processは初回capture前にmetadata-only status endpointでinstallation ID一致を検証する。401/403後のrowはcaptureへ送らず、同じinstallation IDが再検証できた場合だけ再送可能に戻す。
- Context shaping also applies per-row and per-source allowed-principal
  filtering after the common fixed-role RBAC and tenant/project gate.
- API Gateway can resolve principals from API keys or verified Cloudflare Access JWTs. Login profile fields such as company and organization names are display-only metadata.
- Tenant-scoped arbitrary groups and `resource_acl` entries provide group sharing for decision memories and knowledge docs without coupling access to company or organization labels.
- Decision, Skill, Agent, Loadout, generation, preview, Trace, and Map paths use
  the unified policy service. A binding never grants permission and filtering
  always precedes response aggregation.
- Skill generation excludes raw conversation, unselected sources, repository
  content, source code, secrets, and model reasoning. Provider keys and R2
  credentials remain Worker bindings and are never exposed by provider
  discovery.

## Operator Workflows
- `pnpm -s cf:usage:status` reports memory/thread usage from D1 without querying task rows.
- `pnpm agmsg` is the local CLI for sending, listing, reading, and acking agent messages through the API Gateway.
- `pnpm cf:memory:maintain` compacts old raw hook memories and collapses duplicates.
- `orgbrain maintenance run` applies the same deterministic consolidation policy to personal local SQLite. On macOS, the opt-in `connector setup codex --mode minimal-hooks --maintenance daily --execute` path installs a user LaunchAgent; it never installs from package lifecycle scripts, makes no LLM or cloud calls, excludes manual-source memories from automatic compaction, and retains suppressed originals.
- `pnpm cf:memory:cleanup` reports or applies physical cleanup of low-signal memory rows; `--apply` requires `--export`.
- `pnpm cf:memory:quality-backfill`, cleanup, hook ingestion, usage reporting, and Cloud maintenance share the same memory quality classifier; changing its policy requires parity tests for the Cloud and Node entry points.
- `pnpm cf:memory:rationale-backfill -- --remote` reports or applies inferred unconfirmed rationale/evidence rows for high-value existing D1 memories, skipping memories that already have rationale rows.
- `pnpm cf:metrics:report`, `pnpm cf:metrics:replay`, and `pnpm cf:metrics:rollup` manage retrieval effectiveness and daily rollups.
- `pnpm cf:measurement:report` reports opt-in measurement runs and their control/treatment deltas.
- Agent final reports can include qualitative memory impact notes when memory avoided source search, web search, or past-context lookup; these notes do not replace D1 retrieval telemetry or measurement-mode comparisons.
- `pnpm hook:bridge` and `pnpm sync:agents-memory` are the two memory ingress/egress bridges.

## Console Surfaces
- `/`: Decision Briefing
- `/decisions/new`: decision creation
- `/decisions/[id]`: persistent decision trace rail and same-screen preview
- `/map`: decision-centered 3D map, 2D list, and mobile timeline
- `/skills`: private draft generation, inventory, Publish, export, retire, and
  access policy
- `/agents`: Named Agent inventory, Loadout editor, effective context preview,
  and access policy
- `/reviews`: decision review queues
- `/tasks/new`: task creation
- `/tasks`: task list
- `/tasks/[task_id]`: task detail
- `/memories`: supporting memory explorer and maintenance view
- `/decisions`: decision index and search
- `/operations`: memory/decision debt, queue, audit, retrieval quality, token,
  retention, and SLO status.
- `/client-installations`: 本人のCodex／Claude Code／Cursor hook導入一覧、one-time enrollment表示、導入単位の失効。

### Administration UX internals

The decision surfaces use additive versioned read contracts and migration 0034;
existing administration contracts remain compatible. Presentation state is
normalized internally with `AdminPageState`, operator actions with
`AdminAction`, and route-quality coverage with `RouteAuditCase`. Shared page
headers, sections, status panels, action lists, and live notices live under
`apps/console/src/components/admin`; decision-specific components live under
`apps/console/src/components/decision`; common locale copy and
scope-preserving URL helpers live under `apps/console/src/lib`.

The route audit matrix covers every administration route in English, Japanese,
and Chinese. Chromium automation enforces WCAG A/AA Axe results, responsive
reflow, keyboard completion for the five primary workflows, forced-colors and
reduced-motion behavior, and the 12px metadata floor. Screenshot evidence is
generated from the same mock state at desktop and mobile widths. The knowledge
constellation additionally verifies both an actual WebGL canvas and the
non-WebGL list/trace fallback.

The constellation uses one combobox for graph filtering and keyboard node
selection. Its six-result suggestion surface overlays the workspace instead of
adding document height, closes after selection, and returns focus to the
combobox. The four-stage decision path is part of the map workspace above the
WebGL/fallback surface, so changing decision, reason, evidence, or artifact
keeps the graph and trace inspector in view. Node selection remains synchronized
with the URL, graph highlighting, active path stage, and localized live status.

## Current State
- The API gateway exposes operator utilities, including `pnpm -s cf:usage:status`, which queries the `open-brain` D1 database through Wrangler without reading task rows.
- The usage-status wrapper retries transient Wrangler/D1 failures before returning a fatal error, so operator snapshots are less sensitive to one-off remote blips.

## Autonomous quality control

## Internal components

The session importer, deterministic verifier, machine-reference council,
autonomy policy module, local/cloud maintenance runners, and quality certifier
are separate boundaries. The CLI and scheduled worker are adapters over the
same policy functions.

## Interfaces and contracts

`autonomy` policy entries are versioned and hashed. Candidate external keys,
maintenance run IDs, plan hashes, and machine-reference hashes are idempotency
boundaries. Legacy `review` fields remain read-compatible but new uncertain
records serialize as `quarantine`.

## Data and state

Candidates transition `quarantine -> verified|rejected|expired`; memories use
versioned active/suppressed states. Policy state stores the last run and
last-known-good policy. Raw transcripts and reasoning are never persisted.

## Algorithms and control logic

Risk tier 0 operations are deterministic; tier 1 and tier 2 operations require
the configured AI critic or unanimous multi-family consensus. Mutation ratio
and count budgets are enforced before transactional application. Canary and
qualification gates use Wilson lower bounds and hard guardrails.

## Error handling and resilience

Judge denial, provider failure, disagreement, index failure, or post-apply
coverage loss leaves candidates quarantined and moves the scope to shadow.
Scheduled retries re-evaluate due quarantine candidates; expired candidates
are suppressed rather than deleted.

## Security and privacy

Private directories are mode 0700 and artifacts mode 0600. Candidate
projections redact credentials, PII, absolute home paths, command output, and
reasoning. Tenant, workspace, scope, and retention boundaries are not tunable.

## Test design

Node and Vitest suites cover blind generation, council stability and signatures,
Wilson gates, quarantine re-evaluation, mutation budgets, idempotency,
failure-injection rollback, local/cloud parity, privacy, contract checks, and
scheduled-job smoke paths.

Decision Console coverage additionally includes policy backfill/shadow parity,
cross-tenant and same-tenant denial, immediate revocation, Group departure,
Loadout lifecycle filtering, generation timeout/schema/idempotency/retry/R2 and
publish conflicts, 100,000-decision performance, gzip size, ja/en/zh E2E,
keyboard and screen-reader semantics, mobile layout, empty/error/stale states,
fresh migration smoke, and live staging API/Console smoke.

## Rollout and migration

New installations schedule the autonomous controller in shadow mode. Evidence
advances scopes to guarded and autonomous; any hard violation automatically
returns the scope to shadow. Migration 0032 adds quarantine while preserving
legacy review reads.

Decision Console migration is additive. Migration 0034 creates and backfills
unified access, Skill, Agent, Loadout, generation, and usage tables without
dropping legacy columns. Rollout uses `beta` in staging, then deploys production
in the order migration, API/runner, Console, and finally changes both flags to
`on` after all gates pass. Rollback sets `DECISION_CONSOLE_MODE=off` and
`LOADOUT_RESOLUTION_MODE=off`; it does not roll down the migration. Skill/Agent
rows and immutable R2 versions remain intact, and each generation provider can
be disabled independently. Policy inconsistencies return reads to the legacy
path until shadow differences are repaired.

Autonomous memory control is a versioned policy layer shared by the local
SQLite adapter and the Cloud D1 scheduled worker. The state machine is
`shadow → guarded → autonomous`; it advances only from machine-reference,
canary, observed-outcome, and rollback evidence. Deterministic guardrails are
authoritative. Risk-tiered AI judges may approve semantic promotion only when
the configured profiles and model-family minimum agree; outages and
disagreement write a private `quarantine` candidate for automatic retry.

Every maintenance run carries a run ID, policy hash, candidate hashes, judge
metadata, mutation budget, post-apply doctor result, and rollback pointer.
Index repairs and retention calculations are deterministic. AI quality logic
cannot physically delete a memory; deletion is available only to an explicit,
versioned retention policy. The public CLI exposes status, explanation,
configuration, freeze, rollback, and dry-run controls, but normal operation
requires no human approval or queue processing.

## Evidence-chain verified ingestion

The local evidence-chain path is additive to the legacy capture and AI-review
paths. A local session is grouped by `(project, task, decision thread)`, then
bounded to at most ten new-input events, five background events, and 24 KiB per
turn-boundary batch. Background events can resolve a scene but cannot satisfy
an evidence receipt.

`ExtractionProfileV1` is resolved in the fixed order Agent, Project, Tenant,
then built-in. It can change terminology, candidate priorities, exclusions,
few-shot examples, and scene hints only. It cannot change schemas, ACLs,
provenance rules, signing, or the Active gate.

`VerifiedKnowledgeBundleV1` is the shared CLI/MCP/HTTP/seed contract. Its
canonical JSON projection is hashed and signed with ECDSA P-256/SHA-256 by a
registered local collector. Field and edge bindings point to minimized,
masked source spans and evidence receipts. A local model is optional, is
called only when rule extraction is incomplete, and is cached by source digest,
profile hash, extractor schema, and model ID. Model output cannot supply an ID,
hash, ACL, confidence, version, or promotion decision; candidates must match a
new-input source span or they are discarded/quarantined.

The deterministic Active gate requires an explicit human/principal decision,
an explicit reason, independent current evidence, a real artifact reference
with content hash, complete field/edge coverage, valid collector and event-chain
signatures, clean PII/injection/schema checks, and `memory:attest` permission.
Missing support becomes `verified_draft`; forged, contradictory, invalid, or
unsafe material becomes `quarantined`; same bundle digest is a no-op. The
server stores only the signed manifest, masked excerpt locators, digest, and
provenance bindings in migration 0035; it never calls an LLM.

Feature flags are independent: `VERIFIED_INGESTION_MODE=off|shadow|beta|on`
and `VERIFIED_AUTO_PROMOTE=off|on`. Shadow records manifests without changing
existing data. Rollback disables auto-promotion and retains manifests,
quarantine, drafts, and provenance for audit.
