---
title: Org Brain Spec
doc_type: spec
status: approved
owner: org-brain-maintainers
last_updated: 2026-08-20
---

# Org Brain Spec

## Goal
Cloudflare上で、Memory/Artifactsに加えて組織Functionとして動くタスク/イベント駆動の通信バスを提供する。
加えて、task / event / artifact / memory を正本のまま維持しつつ、人間とエージェント向けの知識インターフェースとして interlinked markdown docs layer を提供する。

Consoleの主導線は `Decision -> Reason -> Evidence -> Artifact` とし、Skill
とNamed Agent Loadoutは、確認済みの知識を実務へ配布する層として扱う。

## Requirements

- R-PACK-001: a tenant MUST be able to preview and idempotently install a
  Domain Pack without loading its synthetic example fixtures.
- R-PACK-002: a Pack upgrade MUST NOT overwrite a custom metric, managed object
  type, or Dashboard.
- R-PACK-003: expired metric snapshots MUST be represented as `stale` or
  `unknown` with no numeric value.
- R-PACK-004: initial Domain Pack publication MUST reject `public`; only
  first-party and same-tenant `private`/`unlisted` releases are allowed.
- R-PACK-005: Pack Manifests MUST NOT contain executable code, secrets,
  arbitrary SQL, or unregistered derived operations.
- R-PACK-006: an installed Pack MUST expose a daily Workspace whose Current,
  Baseline, Outcome, and Target values follow Snapshot/Decision links and MUST
  remain `unknown` when the corresponding fact is absent.
- R-PACK-007: Connector metrics MUST install a non-secret source-binding
  placeholder and MUST accept future Connector observations through the
  existing immutable Snapshot API.
- R-PACK-008: a Pack-linked custom metric MUST remain visible in its Workspace
  after a Pack upgrade.
- R-RECALL-001: Domain Recall MUST filter tenant/project, ACL, object identity,
  exact required scope, validity, and personal suppression before deterministic
  scoring. High-assurance profiles MUST reject a partial scope match.
- R-RECALL-002: Recall output MUST be no larger than 6 KiB, MUST expose evidence
  metadata instead of evidence bodies, and MUST remove numeric values from stale
  or unknown metric snapshots.
- R-RECALL-003: existing Context Enrich behavior MUST remain unchanged unless
  `include_domain_recall=true`; `off|shadow|on` MUST gate Recall independently.
- R-RECALL-004: Recall telemetry MUST store the query SHA-256 instead of the raw
  prompt and MUST keep owner principal separate from runtime actor/client.
- R-RECALL-005: feedback MUST create session suppression, personal preference,
  or team review Proposal according to type and MUST NOT directly mutate a
  Decision or Knowledge Assertion.
- R-RECALL-006: portable import MUST verify canonical record and archive digests,
  reject same-ID/different-digest conflicts, and plan before apply. Cloud
  promotion MUST leave Local in read-cache plus proposal-outbox mode.
- R-DEC-001: Console MUST use `Decisions / Map / Skills / Agents / Reviews` as
  its primary navigation. Users, groups, storage, tasks, resources, memory, and
  operations MUST remain available under supporting or Manage navigation.
- R-DEC-002: Decision Briefing MUST identify new, changed, expired,
  unconfirmed, artifact-unlinked, and sharing-pending decisions, include a
  reason summary and next action, and let a user reach the full decision chain
  within two transitions.
- R-DEC-003: Decision Trace MUST return Decision, reasons, evidence Resources,
  artifacts, generated Skills, Agent bindings, and usage outcomes in one
  contract. Authorization filtering MUST happen before node, edge, and count
  aggregation.
- R-DEC-004: Decision Map MUST default to saved or confirmed relations, expose
  inferred relations only after explicit opt-in, cap responses at 150 nodes and
  300 edges, and mark truncation.
- R-DEC-005: Map navigation MUST provide keyboard operation, a 2D list,
  reduced-motion behavior, and a mobile timeline over the same authorized data.
- R-DEC-006: Map MUST retain a full readable-node view in addition to the
  representative view, expose the mode in the URL and UI, and mark truncation
  when the 1,500-node safety ceiling is reached.
- R-ACL-001: `resource_access_policies` MUST be the canonical policy for new
  APIs and MUST express `private|project|group|tenant|restricted`, owner,
  subjects, project, storage location, and policy version consistently across
  asset types.
- R-ACL-002: legacy visibility and permission columns MUST remain compatibility
  mirrors for at least one release. A shadow comparison MUST be observable
  before unified reads are enabled, and every authorization decision MUST fail
  closed.
- R-SKILL-001: shared Skill identity, lifecycle, immutable versions, and file
  metadata MUST be authoritative in D1; Skill file bodies MUST be stored in R2
  and verified by hash and size.
- R-SKILL-002: generation MUST receive only explicitly selected Decision,
  reason, Resource references, immutable version hashes, and user instructions.
  It MUST NOT discover raw conversations, unselected sources, repositories, or
  source code.
- R-SKILL-003: generated Skills MUST start as private drafts. Only the Owner or
  an administrator may Publish; provider, schema, R2, retry, or conflict failure
  MUST leave no partially published Skill.
- R-SKILL-004: only configured OpenAI, Gemini, or Anthropic provider adapters
  may be shown. Their structured output MUST validate against the shared Skill
  schema before an immutable version is committed.
- R-AGENT-001: a Named Agent MUST have a stable `agent_key`, role, state,
  owner, optional source Decision, last-use time, and a named current Loadout.
- R-AGENT-002: Loadout bindings MUST support `always|auto|on_demand`, priority
  0-100, and `pinned|latest_published` version selection. Effective context MUST
  be previewable before activation.
- R-AGENT-003: Loadout resolution MUST evaluate current Agent, Loadout, Skill,
  version, expiry, publication, retirement, and access state on every request.
  Bindings MUST NOT grant access. `on_demand` MUST return a fetch handle without
  unconditionally injecting the Skill body.
- R-FLAG-001: `DECISION_CONSOLE_MODE` and `LOADOUT_RESOLUTION_MODE` MUST each
  support `off|beta|on`. Off MUST preserve the legacy Console/context path; beta
  MUST be staging-only.

- R-VER-001: Local verified ingestion MUST use `ExtractionProfileV1` and
  `VerifiedKnowledgeBundleV1` across CLI, MCP, HTTP, and seed paths. Profile
  resolution MUST be Agent -> Project -> Tenant -> built-in and MUST NOT alter
  evidence, ACL, signing, or promotion rules.
- The verified HTTP surface is `POST /v1/memory-collectors/keys`,
  `POST /v1/memory-collectors/keys/:id/revoke`,
  `GET /v1/memory-collectors/keys/:id/manifests`,
  `POST /v1/memory-ingestions/verified`, and
  `GET /v1/memory-ingestions/verified/:id`; the MCP mutation is
  `orgbrain_memory_commit_verified`.
- R-VER-002: A Bundle MUST be signed by a registered ECDSA P-256/SHA-256
  collector. Unknown, revoked, expired, cross-tenant, unsigned, tampered, or
  event-chain-invalid Bundles MUST be rejected or quarantined.
- R-VER-003: Automatic Active promotion MUST require explicit human decision,
  explicit reason, independent current evidence, a content-hashed artifact,
  100% field/edge provenance coverage, clean PII/schema checks, valid
  signatures, and `memory:attest` scope. Confidence MUST NOT decide promotion.
- R-VER-004: Identical `bundle_key + bundle_digest` submissions MUST be
  idempotent no-ops. Unsupported or incomplete material MUST remain a draft or
  quarantine record and MUST NOT overwrite an existing decision.
- R-VER-005: `VERIFIED_INGESTION_MODE=off|shadow|beta|on` and
  `VERIFIED_AUTO_PROMOTE=off|on` MUST be independently rollbackable. Shadow
  MUST retain audit manifests without changing existing memory/decision data.

- R-AUTO-001: uncertain ingestion MUST enter quarantine and be retried
  automatically; it MUST NOT wait for a human approval queue.
- R-AUTO-002: active promotion MUST pass deterministic verification and the
  configured independent AI consensus policy.
- R-AUTO-003: maintenance MUST respect mutation budgets and MUST roll back the
  scope on a hard violation or failed post-apply verification.
- R-AUTO-004: quality qualification MUST report independent route metrics,
  Wilson lower bounds, provenance, and hard-guardrail counts.

## Acceptance criteria

- A personal user can move from Decision Briefing to Decision, reason, evidence,
  and artifact in no more than two transitions.
- An organization user can share a Decision to a Group, generate a private
  draft, Publish it, attach it to a Named Agent, and inspect the effective
  context without losing the decision provenance.
- Cross-tenant, same-tenant unauthorized, immediately revoked, and departed
  Group access checks return zero protected nodes, edges, counts, files, or
  context bodies.
- Loadout resolution injects no unauthorized, retired, expired, unpublished, or
  invalid Skill version.
- A 100,000-decision fixture keeps local p95 below 500 ms; production p95 MUST
  remain below 1 second and each gzipped Decision Trace response below 250 KiB.
- The Console passes ja/en/zh desktop and mobile E2E coverage for keyboard,
  screen-reader semantics, reduced motion, and empty/error/stale states.
- Repeating the same offline Recall query over unchanged data produces the same
  candidate order and bundle ID; wrong object/scope returns no primary candidate.
- Existing Context Enrich callers receive no Recall fields until they explicitly
  opt in. Recall events contain no raw prompt or evidence body.

- A fresh workspace can install the autonomous scheduled runner and remain in
  fail-closed shadow mode until machine-reference and canary evidence qualify.
- Missing judge evidence, model disagreement, scope mismatch, privacy
  violation, or retrieval degradation produces quarantine/rollback with no
  active write.
- Re-running the same plan or maintenance run is idempotent and records the
  same candidate/run hashes without physical deletion.

## Scope
- API Gateway: Hono Worker
- Event Bus: Cloudflare Queues (`org-bus`, `cap-plan`)
- Coordination: Durable Objects (`LeaseDO`, `MailboxDO`)
- MCP: Cloudflare Access保護の`open-brain-mcp` thin proxyからservice bindingでAPI Gatewayのstateless `/mcp`へ接続
- Storage: D1 (`tasks`, `task_events`, `capabilities`, `memories`, `memories_fts`, `memory_versions`, `memory_edges`, `memory_deletions`, `entities`, `memory_entities`, `decision_rationales`, `decision_evidence`, `decision_memories`, `memory_confirmations`, `agent_messages`, `threads`, `retrieval_events`, `retrieval_daily_metrics`, `business_categories`, `memory_impact_events`, `memory_impact_daily_metrics`, `memory_usage_events`, `memory_usage_items`, `memory_effect_events`, `memory_effect_attributions`, `memory_failure_patterns`, `memory_effect_daily_metrics`, `retrieval_generations`, `retrieval_generation_assignments`, `retrieval_ranking_profiles`, `retrieval_units`, `retrieval_units_fts`, `retrieval_projection_jobs`, `retrieval_evaluation_events`, `knowledge_docs`, `knowledge_links`, `knowledge_docs_fts`, `principal_role_assignments`, `scoped_tokens`, `mcp_client_installations`, `audit_events`, `retention_policies`) + R2 artifacts
- Console: Astro on Cloudflare Pages + Functions proxy
- Domain Pack Platform: shared signed contracts, D1 install/metric registry,
      first-party function Packs, generic Dashboards, and Enterprise-only Builder.
    - Domain Recall: Local SQLite/CLI/hook, D1/API/MCP, Recall history/Trace,
      feedback review, and portable Local-to-Cloud authority transfer.
- Decision/Skill/Agent storage: D1 (`resource_access_policies`,
  `access_policy_shadow_diffs`, `skill_assets`, `skill_asset_versions`,
  `skill_asset_files`, `skill_generation_runs`, `agents`, `agent_loadouts`,
  `agent_loadout_bindings`, `asset_usage_events`) + R2 Skill files

## API
- `GET /v1/decision-briefing`
- `GET /v1/decisions/:id/trace`
- `GET /v1/decisions/:id/map`
- `GET /v1/skill-providers`
- `GET|POST /v1/skills`
- `GET /v1/skills/:id`
- `POST /v1/skills/:id/versions`
- `POST /v1/skills/:id/publish`
- `POST /v1/skills/:id/retire`
- `GET /v1/skills/:id/export`
- `POST /v1/skills/generate`
- `GET|POST /v1/agents`
- `GET|PATCH /v1/agents/:id`
- `PUT /v1/agents/:id/loadouts/:loadoutId`
- `POST /v1/agents/:id/context-preview`
- `GET|PUT /v1/access-policies/:resourceType/:resourceId`
- `GET /v1/ops/access-policy-shadow`
- `POST /v1/tasks`
- `GET /v1/tasks`
- `GET /v1/tasks/:taskId`
- `GET /v1/tasks/:taskId/events`
- `POST /v1/agent-messages`
- `GET /v1/agent-messages`
- `GET /v1/agent-messages/:messageId`
- `POST /v1/agent-messages/:messageId/read`
- `POST /v1/agent-messages/:messageId/ack`
- `POST /v1/memory-impact-executions`
- `POST /v1/memory-impact-executions/:externalRunId/report`
- `GET /v1/memory-impact-executions/:externalRunId`
- `GET /v1/memory-impact-summary`
- `GET /v1/metrics/memory-impact`
- `GET /v1/memories`
- `POST /v1/memories/upsert`
- `POST /v1/memories/capture`
- `POST /v1/memories/propose`
- `POST /v1/memories/confirm`
- `POST /v1/memories/revise`
- `POST /v1/memories/refresh`
- `POST /v1/memories/suppress`
- `POST /v1/memories/search`
- `POST /v1/memories/profile`
- `POST /v1/decision-memories`
- `POST /v1/decision-memories/search`
- `GET /v1/decision-memories/:id/context`
- `POST /v1/decision-memories/:id/revise`
- `POST /v1/decision-memories/:id/confirm`
    - `POST /v1/context/enrich`
    - `POST /api/context/enrich` (agent-facing alias)
    - `GET /v1/domain-recalls/:id`
    - `POST /v1/domain-recalls/:id/feedback`
    - `POST /v1/portable-imports`
    - `PUT /v1/portable-imports/:id/chunks/:sequence`
    - `POST /v1/portable-imports/:id/plan`
    - `POST /v1/portable-imports/:id/apply`
- `GET/POST/PATCH /v1/business-categories`
- `POST /v1/memory-usages` (idempotent local outbox ingestion)
- `POST /v1/memory-usages/state`
- `POST /v1/memory-effects`
- `GET/POST/PATCH /v1/memory-failure-patterns`
- `GET /v1/metrics/memory-impact`
- `POST /v1/retrieval-ranking-profiles`
- `POST /v1/retrieval-generations`
- `POST /v1/retrieval-generations/:id/backfill`
- `PATCH /v1/retrieval-generations/:id`
- `POST /v1/docs`
- `GET /v1/docs/:slug`
- `POST /v1/docs/search`
- `GET /v1/docs/:slug/context`
- Auth: `x-api-key`
- `POST /v1/tasks` は任意で `measurement_mode=true`、`measurement_session_id`、`measurement_unit=task|session`、`measurement_reference_model` を受け取り、同一入力から memory-off control と memory-on treatment の 2 task を作成する

## MCP
- Endpoint: `POST/GET /mcp` (streamable HTTP)
- 対話型Codex／Claude Code／Cursor: Cloudflare Access Managed OAuth。Access JWTの`sub`を既存`user_identities`へ解決し、既存RBACとmemoryの`propose -> confirm`規約を適用する
- 無人hook: `(マシン, クライアント)`単位のAccess Service Token。Access JWTのservice subject hashをactiveな`mcp_client_installations`へ解決し、owner principalと`client:<installation-id>` runtime actorを分離する
- `MCP_ACCESS_AUD`は必須でAPI用`ACCESS_AUD`と分離する。`MCP_AUTH_MODE`は`legacy|dual|access`、未設定はfail-closedな`access`
- thin proxyは`Cf-Access-Jwt-Assertion`とMCP protocol allowlist headerだけをservice bindingへ転送し、OAuth bearerと生のservice-token headerを転送しない
    - service-token hookが呼べるtoolは`orgbrain_memories_capture_rationale`だけで、task、message、管理toolを拒否する
    - purpose=`recall` installationは`orgbrain_prompt_recall`と
      `orgbrain_domain_recall_feedback`だけを追加で実行できる。purpose=`capture`
      installationとのcapability境界は交差しない
- 導入管理API: `POST|GET /v1/mcp-client-installations`、`DELETE /v1/mcp-client-installations/:id`、service-token activation用`POST /mcp/client-installations/activate`。activationは登録時の`client_type`と導入対象を原子的に照合し、不一致の登録コードを消費しない
- Tool surface:
  - memory list/upsert/search/profile
  - memory refresh/suppress/delete
  - task create/get/events
  - agent message send/inbox/get/read/ack
- `orgbrain_context_enrich` accepts optional `agent_key`. When Loadout
  resolution is enabled, the response separates injected `always|auto` content,
  `on_demand` metadata/handles, and omitted items with reason codes.
- Tenant isolation: Access userはAccess tenant policy、導入済みhookはinstallationの単一tenant、legacy/dual移行時だけ`MCP_TENANT_POLICY_JSON`をserver-sideで適用する

## Agent Messages
- `agent_messages` is the durable source of truth for agmsg-style agent-to-agent messages.
- Messages have one target per row: `principal`, `agent`, `project`, or `channel`.
- Inbox reads default to the authenticated principal target when `target_type` / `target_key` are omitted.
- Status is `unread -> read -> acked`; `archived` is reserved for later cleanup/UI flows.
- `idempotency_key` dedupes sends only when supplied; repeated messages without a key are stored as distinct messages.
- `thread_id` defaults to the root message id, and replies inherit the parent thread when `reply_to_message_id` is supplied.
- Message storage is not automatic memory capture. Messages can later be referenced from memories or decision memories as evidence.
- MCP exposes `orgbrain_messages_send`, `orgbrain_handoff_send`,
  `orgbrain_messages_inbox`, `orgbrain_messages_get`,
  `orgbrain_messages_read`, and `orgbrain_messages_ack`.
- `orgbrain_handoff_send` stores a versioned `orgbrain-handoff-v1` package with
  decisions, rationale/source references, unresolved items, and next actions in
  the durable agent inbox
- `pnpm agmsg` is a thin CLI wrapper over the HTTP API and uses `ORGBRAIN_API_URL` with `ORGBRAIN_API_BASE` as a compatibility alias.

## Memory Source of Truth
- Master data is Cloudflare D1 (`memories`, `memories_fts`)
- OpenClaw local DB (`~/.openclaw/memory/main.sqlite`) is cache/index only
- Local agent hooks and sync scripts do not write to Cloudflare unless `ORGBRAIN_ENABLE_CLOUD_MEMORY=true`; organization sharing additionally requires `ORGBRAIN_ENABLE_ORG_SHARING=true`.
- Agent hook連携はAPI (`/v1/memories*`) + hook bridge (`packages/orgbrain-cli/src/hook-memory-bridge.mjs`) で行う
- hook bridge は新しい workspace で最初に reusable memory を保存する際、`~/.config/org-brain/workspaces.json` に `tenant_id` と `project_id` を一体で保存する。project の既定値は `basename(cwd)` とし、organization sharing では workspace mapping と `ORGBRAIN_TENANT_ID` のどちらからも tenant を解決できない場合は fail closed とする
- local-only で tenant が明示されていない場合、runtime は互換上 `default` scope を使うが mapping には `tenant_id: null` を保存する。これにより後日 organization sharing を有効化した際に暗黙の `default` が明示 tenant より優先されることを防ぐ
- 旧 `project-names.json` は最初の対象 hook で tenant fallback を付与して移行し、元ファイルは削除・変更しない。workspace 設定は directory `0700` / file `0600`、lock-serialized read-modify-write、atomic replace で保存する
- Hook bridge は low-signal な会話終了ログを原則保存せず、再利用価値のある内容だけを distilled memory として upsert する
- Memory quality の分類・要約・utility/confidence・expiry・suppression 判定は `packages/shared/src/memory-quality-runtime.mjs` を単一の実装元とし、Cloudflare Worker、hook bridge、backfill、cleanup、usage report は同じ判定を使う。TypeScript Worker は `memory-quality.ts` facade、Node operator script は `packages/orgbrain-cli/src/lib/memory-quality.mjs` compatibility re-export を経由する
- Agent memory sync は API (`/v1/memories*`) + sync script (`scripts/sync-agents-memory.mjs`) で行う
- `/v1/memories/upsert` は request 内 `external_key` を last-write-wins で dedupe し、既存 key lookup + `memories_fts` 更新を batch 化する
- memory lifecycle v2 では `memories` を current snapshot、`memory_versions` を immutable 履歴、`memory_edges` を lightweight lineage relation として扱う
- `memories` と `decision_memories` は別の原本として維持し、自動同期しない。共通検索投影と効果計測だけを共有する
- 新規保存はtenant定義の `business_category_id` と固定 `work_type` を明示入力し、内容から推論しない。移行中のNULLは未分類としてKPIから除外する
- MemoryRecord v2 は local SQLite と Cloud D1 で tenant/project/kind/state/scope、content/summary/tags/entities、source references、actor、作成・更新・有効期間、confidence/utility/content hash/version、rationale/evidence/conflicts/permissions を共通の論理契約として持つ
- `MemoryStore` は capture/revise/suppress/delete/get/search/version/export/rebuild/verify の正本インターフェースであり、FTS・embedding・graph retrieval index は再構築可能な派生データとして扱う
- rationale confirmation v1 では `decision_rationales` を確認済み結論・理由の構造化層、`memory_confirmations` を propose/confirm の短期トークン保管として扱う
- context engine MVP では `decision_memories` を agent preflight 用の decision-grade context 正規化層として扱い、decision/rationale/rejected alternatives/constraints/known pitfalls/sourceRefs/validity/status/confidence/permission metadata を保持する
- `memories` は `kind`, `lifecycle_state`, `scope_type`, `scope_key`, `actor_type`, `actor_id`, `confidence_score`, `utility_score`, `current_version`, `last_accessed_at`, `suppressed_at`, `expires_at` を持つ
- `/v1/memories/capture` は lifecycle write API で、`/v1/memories/upsert` は後方互換入口としてこれにマップされる
- `/v1/memories/propose` は raw text から `結論` と `理由` を heuristic に推定し、確認 token と一緒に返す
- `/v1/memories/confirm` は確認 token を消費し、approved 時だけ `memories` + `decision_rationales` + entity/evidence rows を永続化する
- MCP tool `orgbrain_memories_capture_rationale` は非対話 hook 用に memory capture と推定 rationale/evidence 保存を 1 回で行う。保存される rationale は `confirmation_state=inferred_unconfirmed` とし、人間確認済みとは区別する。`/v1/memories/capture-rationale` は旧bridge互換として維持する
- `/v1/memories/revise` は current snapshot を更新しつつ `memory_versions` に `operation=revise` を追加する
- `/v1/memories/refresh` は `last_accessed_at` と optional な `confidence_delta` を更新し、想起イベントを version 履歴に残す
- `/v1/memories/suppress` は memory を物理削除せず通常 retrieval から外し、`lifecycle_state=suppressed` と `suppressed_at` を記録する
- `DELETE /v1/memories/:memoryId` は認証済み principal と tenant grant を使用し、memory、version、FTS、edge、entity/rationale/evidence 関連を削除して、本文を含まない deletion tombstone のみを残す
- 固定 role は `tenant_admin`, `project_owner`, `contributor`, `reader`, `service_agent`, `auditor`、分離 permission は `read`, `write`, `share`, `admin`, `delete`, `export` とする
- `/v1/*`, `/api/*`, Remote MCP tool は tenant grant に加えて固定 role / project scope の permission check を通す。単一 `API_KEY` の self-host operator は `tenant_admin`、policy付きAPI keyは既定 `service_agent`、Access loginはpolicy未指定時 `reader` とする
- `GET|PUT|DELETE /v1/role-assignments` は tenant admin 用の role assignment surface、`GET /v1/audit-events` と `/v1/audit-events/verify` は auditor 用の監査・hash chain検証 surface とする
- API mutation は本文・secretを保存せず、principal、tenant/project、action、resource、outcome、request id、permission、statusだけを SHA-256 hash chain付き `audit_events` に記録する
- `/v1/memories/search` と cap-runner retrieval は共有 helper を使い、`bm25_v1`、`bm25_rewrite_v1`、`hybrid_memory_docs_v1`、`hybrid_v2` を切り替える
- `rewrite_query=true` は phrase / token OR / split token OR / singularized token OR の最大 4 変種で lexical FTS5 を引き、memory id 単位で best rank を採用する
- `search_mode=hybrid` は dedupe 後の lexical memory hit が 3 件未満のときに `knowledge_docs_fts` を追加検索し、memory/doc を summary/title 単位で dedupe して返す
- `search_mode=hybrid_v2` は lexical / semantic / graph / time / authority /
  utility を融合し、ACL と validity を順位付け前に適用する。semantic
  provider 未設定時は null と degraded metadata を返し、擬似 score を作らない。
  個人SQLiteモードは外部通信を行わない `local-sparse-feature-hash-v2`
  投影を既定で構築し、CloudモードはWorkers AI + Vectorizeを任意選択できる
- `search_mode=hybrid_v3` は session/turn/atomic projection をFTSとsemantic
  RRFで統合し、親memoryへ集約してからrerankする。会話の前置きを除いた主題語、
  限定的な形態・概念展開、明示された相対日時・話者・unit typeだけをboostし、
  通常質問にはrecencyを加えない
- `hybrid_v3` / `hybrid_v4` は移行用aliasである。通常クライアントは `retrieval_profile` を使い、安定した `retrieval_generations` / `retrieval_units` 契約から実際のschema・extractor・ranking・embedding profileを `meta.retrieval` で受け取る
- `search_scope=evidence|governance|both` は通常memoryとdecision memoryを別チャネルで返す。`both`でも両者を一つの順位へ混ぜない
- 全検索・context結果は `meta.usage_id` を返し、効果はappend-only `memory_effect_events` と重み付きattributionへ記録する。詳細契約は [`RETRIEVAL_GENERATIONS_AND_MEMORY_IMPACT.md`](RETRIEVAL_GENERATIONS_AND_MEMORY_IMPACT.md) に定義する
- `memory_impact_events`は実行単位のeligible/assessed/failedと報告率の正本、`memory_usage_*` / `memory_effect_*`はメモリ単位の参照・利用・効果帰属の正本とする。任意の`external_run_id`で接続するが、両者の分母やevidence semanticsは合算しない
- `GET /v1/ops/status` はadmin専用で、memory競合・期限切れ、decision review、
  task失敗、監査、token、legal hold、検索品質、索引構成、RPO/RTO目標を返す。
  未計測の検索指標は0ではなくnullを返す
- `tags_json` に `compacted` を持つ memory は retrieval/profile の対象外とし、古い raw hook memory は digest memory へ圧縮して検索ノイズを下げる
- lifecycle-aware retrieval は `suppressed` と expired row を通常検索から除外し、`semantic` row を `episodic` より優先する
- Primary lexical search の対象は `canonical-memory`、`curated-memory`、`promoted-memory`、`memory-digest` に絞る。recent raw hook memory は recent/history 用に保持する
- Maintenance は再利用されやすい durable memory を project/category 単位で `canonical-memory` に再編し、長期記憶を 4 段階で扱う: canonical / curated-promoted / digest / recent-raw
- `quality-v2` canonical summary は件数ラベルではなく、代表的な再利用ルール、原因/対処、コマンド、検証結果を含む検索用要約にする
- `/v1/memories/profile` は 1 call で `durable`、`recent`、`search_results` を返す
- `GET /v1/memories` は `limit` / `offset` を受け取り、`paginated=1` の場合は `items + meta(total, has_next, has_prev, canonical_count, digest_count, compacted_count)` を返せる
- `POST /v1/memories/search` は `entity_id`, `entity_role`, `decision_type`, `decision_status`, `confirmation_state`, `reason_text` で rationale-aware filtering できる
- `POST /v1/context/enrich` と alias の `POST /api/context/enrich` は `orgId`/`projectId`/`agentId`/`userId`/`taskType`/`task` を受け取り、decision context、constraints、known pitfalls、conflicts、recommended next actions、confidence、human-review flag を返す
- `POST /v1/context/enrich` は `includeProvenance` / `authorityScoring` / `verificationView` を opt-in として受け取れる。既定値はすべて false で、benchmark 用 compact context には新しい provenance/trust fields を含めない
- context enrich は source authority、freshness、project proximity、task specificity、permission fit、status/staleness penalty を含む score breakdown で decision memory を並べ替える
- context enrich は restricted decision memory と sourceRefs の `allowedPrincipals` を user/agent principal に対してフィルタし、権限外ソースを返さない
- Cloudflare Access login auth resolves a stable `user:<sub>` principal. Optional profile fields (`company_name`, `organization_name`) are display-only.
- Tenant-scoped arbitrary groups can be created independently of profile company/organization metadata, and can be used in resource ACLs for decision memories and knowledge docs.
- context enrich は active/deprecated/superseded/expired の同一topic decision memoryを最小限の conflict として明示する
- context enrich は `maxTokens` の概算上限を守るため、pitfalls/actions/constraints/decisionContext の順に圧縮する
- pre-action gate は高 severity の active decision conflict を block、
  低信頼または未確認文脈を review、それ以外を allow として返す
- decision review queue は unconfirmed / uncertain / stale / expiring /
  conflicting を decision debt として集計する
- decision memory editor v1 では `reviewer_refs_json`, `confirmation_state`, `confirmation_note`, `confirmed_at`, `decision_memory_versions` を使い、判断の編集・確認・履歴・信頼根拠を memory retrieval 本体とは分離して扱う
- `GET /v1/decision-memories/:id/context` は判断者、確認者、source refs、適用文脈、履歴、同一 topic conflict、trust signals を返す
- `POST /v1/decision-memories/search` は `person_id`, `reviewer_id`, `confirmation_state`, `valid_at`, `has_conflicts`, `task_context`, `include_provenance`, `authority_scoring`, `verification_view` を optional filter/flag として扱う
- `durable` は `summary` を持つ 24 時間以上前の memory を同一 project 優先 + `policy > diagnosis > command-result > workaround > untagged` の順で返す
- `durable` は lifecycle v2 以降 `semantic` kind を優先し、旧 tag tier は互換ソートとして残す
- `recent` は `durable` に採用していない 14 日以内の memory を同一 project 優先 + recency 順で返す
- Capability retrieval emits best-effort raw telemetry into `retrieval_events` and lightweight `task_events(kind=memory.search)` for drill-down
- Measurement mode is opt-in only. It creates paired control/treatment task variants, disables memory writes for both variants, loads recent raw memory content as the control baseline, uses compact memory retrieval for treatment, and records token/cost/duration deltas in `measurement_runs`, `measurement_variants`, and `measurement_comparisons`.
- Daily cron on `open-brain-cap-runner` rolls up the previous UTC day into `retrieval_daily_metrics` and prunes raw telemetry older than 90 days
- A second daily cron on `open-brain-cap-runner` compacts old hook memories into digest rows and marks old duplicates as `compacted`
- cap-runner retrieval と API memory search/profile は search hit 上位 memory に対して best-effort で `refresh` 相当の `last_accessed_at` 更新と version 履歴追加を行う

## Knowledge Docs Layer
- `knowledge_docs` は markdown knowledge docs の index であり、正本ではない
- 正本は引き続き `tasks` / `task_events` / artifacts / `memories`
- 各 doc は YAML frontmatter を持ち、`id`, `title`, `scope`, `kind`, `tags`, `stability`, `updated_at` を必須とする
- 各 doc は `[[slug]]` 形式の wiki link で相互参照できる
- 短文 doc は D1 に body を直接保存し、長文 doc は R2 に markdown 全文を保存する
- `knowledge_links` は resolved relation graph (`references`, `related`, `parent`, `child`) を保持する
- `POST /v1/docs` 保存時に tenant 単位で graph を再構築し、後から追加された doc に対しても未解決 wiki link を解消する

## Knowledge Resources and Decision Artifacts
- `knowledge_resources` はURIから独立したResource identity、`knowledge_resource_locations` はcanonical/mirror/source URI、`knowledge_resource_versions` はconnector取得版のimmutable provenanceを保持する
- 任意URLをAPIが直接fetchしない。`fetch_enabled` locationへ明示的に束縛されたconnectorだけが `/v1/resources/:id/refresh` へsnapshotを投入できる
- DecisionとResourceのN:N関係は `knowledge_assertions(assertion_type=relation)` を正本とし、APIの`DecisionResourceLink`とGraph Edgeはprojectionとする
- link roleは `conclusion_source`, `rationale_source`, `contradiction`, `input`, `implementation_artifact`, `output_artifact`, `verification_artifact` に固定する
- confirmed source linkは`knowledge_assertion_evidence`でResource Versionとlocatorへ固定し、Resourceの新版が旧根拠を暗黙に差し替えない
- proposed/retired relationはResource起点の理由検索、Decision起点の成果物探索、通常Graphへ混入させない
- `orgbrain_resource_search`, `orgbrain_resource_decisions`, `orgbrain_decision_resources` はread-only MCP surfaceとし、登録・版取込・link確認・retireは監査対象HTTP管理面に限定する
- `GET /v1/decision-resource-links/review-queue` と `POST /v1/decision-resource-links/:id/confirm` はACL交差済みProposal review面であり、確認時は旧Confirmed linkをretireして新しい版・locator・digestへ固定する
- Consoleの「資料・成果物」はResource取込、明示link、Proposal confirm/reject、retireを同じ監査対象APIへ接続し、`conclusion_source` と `input` を別表示する
- `retrieval_units.source_type=knowledge_resource_version` のsource span付きchunk、Resource FTS、`confirmed_decision_resource_edges` viewを検索/Graph projectionとして扱い、Resource/Version/Assertionから再構築できる
- DecisionとResourceの両ACLを満たす結果だけを返し、権限外Resource/Decisionの存在や件数をcoverageへ漏らさない
- `POST /v1/resources/backfill` はadmin限定の再開可能な3段階処理とし、`knowledge_docs`のinline/R2本文、`decision_evidence`、`decision_memories.source_refs_json`を順に正規化する。各batchはcursor、件数、完了状態、source ID digestを返す
- `decision_evidence`は旧relationと親Decisionのconfirmationを維持し、曖昧な`source_refs_json`は`input`へ移す。同じ旧参照は同じnormalized URIへ解決し、N:Nを維持する
- 新しいcontent hashの取得は旧evidenceを差し替えず、Confirmed sourceが旧版へ固定されたResourceを`stale`にし、影響Assertionごとの再確認Proposalを冪等に作る
- canonical Confirmed AssertionをResource graph edgeとして投影し、別の正本edge tableは作らない
- `KNOWLEDGE_RESOURCE_INGESTION_ENABLED`, `DECISION_RESOURCE_LINKS_ENABLED`, `RESOURCE_RELATION_EXTRACTION_ENABLED` は既定offとし、metadata、shadow index、明示link、Proposal reviewの順で有効化する

## Progressive Disclosure
- 初回コンテキスト取得は MOC から始める
- doc 本文の前に summary を優先して取得する
- `GET /v1/docs/:slug/context` は `current + parent_moc + related(max 3) + children(max 3)` を summary-only で返す
- cap-runner には `loadContext(tenantId, slug)` helper を持たせ、必要時だけ `includeBody` で全文展開する

## Task Lifecycle
`created -> queued -> running -> succeeded|failed`

## Event Types
- Queue envelope type: `task.created`, `task.result`
- Task events table kind: `created`, `queued`, `started`, `completed`, `failed`, `memory.search`

## Console Pages
- `/`: Decision Briefing
- `/decisions`: decision search and index
- `/decisions/new`: decision creation
- `/decisions/:id`: Decision Trace and same-screen preview
- `/map`: Decision Trace Map
- `/skills`: Skill generation, inventory, version, Publish, and Access Drawer
- `/agents`: Named Agents, Loadouts, effective-context preview, and Access Drawer
- `/reviews`: unconfirmed, expired, missing-artifact, and sharing review queues
- `/tasks/new`
- `/tasks`
- `/tasks/[task_id]`
- `/memories`, `/resources`, and `/operations` remain supporting or Manage
  surfaces. Existing URLs remain valid for at least one release.

## Operator Workflow
- `pnpm -s usage:status` queries the D1 source of truth and reports a tenant usage snapshot for memory/thread counts. It intentionally does not query task rows.
- `pnpm agmsg` sends, lists, reads, and acks agent messages through the API Gateway.
- `pnpm hook:bridge <source>` normalizes hook payloads from coding agents and upserts them into `memories`.
- `orgbrain connector setup <codex|claude|cursor> --mode remote-mcp --url <Access-protected-MCP-URL>`は各クライアントのuser-level remote MCP/OAuth設定を登録する。`--mode cloud-hooks`は一度きりの登録コードでservice tokenを導入へ結び付け、`~/.config/org-brain/clients/<installation-id>/credentials.env`へ`0600`で保存する。両方ともdry-runが既定で変更には`--execute`を要求する。hookファイルを書き換えるexecuteは対象file・eventを表示して対話的な`yes`を要求し、非対話実行は事前review済みの`--approve-hooks`がなければ失敗する。
- cloud hookは既存の決定的promote/skip判定だけを使い、LLMやtranscript readerを起動しない。送信対象は重要なmemory/rationaleだけで、prompt、回答全文、reasoning、tool I/O、transcript path、絶対pathをaudit/observation metadataへ含めない。
- 認証失敗・offline時はクライアントを停止せず導入別`0600` JSONL outboxへ保持し、`SessionStart`／`Stop`／`SessionEnd`で最大100件を再送する。principalを確定できないデータは`identity_unresolved`としてserverへ送らない。
- `pnpm hook:bridge` emits JSON with `memory_scope`, `cloud_memory_enabled`, `org_sharing_enabled`, and `shared_write`; `pnpm sync:agents-memory` prints the same mode before API import/export.
- hook/bridge 由来の自動保存は非対話 path として扱い、propose/confirm を要求しない。MCP `2026-07-28` の既知tool `orgbrain_memories_capture_rationale` をdiscoveryなしで直接呼び、`decision_rationales` / `decision_evidence` を `inferred_unconfirmed` として保存する。旧REST endpointは移行互換のみとする。
- `pnpm docs:seed` upserts the minimal stable knowledge-doc set via the Pages/API proxy.
- `pnpm memories:maintain` compacts old raw hook memories into digest rows and collapses old duplicates.
- 個人ローカルSQLiteでは `orgbrain maintenance run` が同じ決定的な整理方針を適用する。macOSの日次LaunchAgent登録は `connector setup codex --mode minimal-hooks --maintenance daily --execute` の明示指定時だけ行い、LLM・Cloud書き込み・manual sourceの自動抑制・物理削除は行わない。`status` とrecoverableな `uninstall --execute` を提供する。
- `pnpm memories:cleanup` dry-runs by default, can export a JSONL backup, physically removes low-signal memory rows and related memory tables on `--apply`, and promotes structured `project-fact` rows to curated semantic memory.
- `pnpm memories:backfill-rationales` dry-runs by default and can add inferred unconfirmed rationale/evidence rows for active high-value memories (`project-fact`, `curated-memory`, `promoted`, `canonical-memory`) with `--apply`.
- `pnpm metrics:report` reports retrieval hit/fallback/latency plus service outcomes from D1 telemetry.
- `pnpm metrics:replay` replays recent task inputs against `bm25_v1`, `bm25_rewrite_v1`, and `hybrid_memory_docs_v1` without persisting new rows.
- `pnpm metrics:rollup` backfills or recomputes one UTC day into `retrieval_daily_metrics`.
- `pnpm measurement:report` reports opt-in measurement runs comparing raw-context control tasks with compact-memory treatment tasks, with optional `--session-id` aggregation for multi-turn sessions.
- Agent-facing memory impact notes are persisted as `memory_impact_events` when the integration reports every eligible run. `avoided_lookup` remains an agent self-report and a qualitative supplement; causal quantitative evaluation remains measurement mode plus business outcome metrics.

## Out of Scope (MVP)

## Out of scope

The specification does not authorize AI-driven physical deletion, changes to
tenant boundaries, or bypassing deterministic and hard-guardrail checks.
- SCIM/SAML provisioning and arbitrary custom role definitions
- Production evidence for the credential-gated cloud D1 restore drill
- Capability plugin marketplace
- Third-party SaaS connector ingestion
- Complete adversarial poisoning, multilingual PII, and redaction evaluation
- Raw agent transcript stores への直接書き込み統合
- Code graph construction, repository ingestion, and local-only Skill storage
