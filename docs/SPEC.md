# Org Brain Spec (MVP)

## Goal
Cloudflare上で、Memory/Artifactsに加えて組織Functionとして動くタスク/イベント駆動の通信バスを提供する。
加えて、task / event / artifact / memory を正本のまま維持しつつ、人間とエージェント向けの知識インターフェースとして interlinked markdown docs layer を提供する。

## Scope
- API Gateway: Hono Worker
- Event Bus: Cloudflare Queues (`org-bus`, `cap-plan`)
- Coordination: Durable Objects (`LeaseDO`, `MailboxDO`)
- MCP: Remote MCP endpoint on API Gateway (`/mcp`, service-token auth)
- Storage: D1 (`tasks`, `task_events`, `capabilities`, `memories`, `memories_fts`, `memory_versions`, `memory_edges`, `memory_deletions`, `entities`, `memory_entities`, `decision_rationales`, `decision_evidence`, `decision_memories`, `memory_confirmations`, `agent_messages`, `threads`, `retrieval_events`, `retrieval_daily_metrics`, `business_categories`, `memory_impact_events`, `memory_impact_daily_metrics`, `memory_usage_events`, `memory_usage_items`, `memory_effect_events`, `memory_effect_attributions`, `memory_failure_patterns`, `memory_effect_daily_metrics`, `retrieval_generations`, `retrieval_generation_assignments`, `retrieval_ranking_profiles`, `retrieval_units`, `retrieval_units_fts`, `retrieval_projection_jobs`, `retrieval_evaluation_events`, `knowledge_docs`, `knowledge_links`, `knowledge_docs_fts`, `principal_role_assignments`, `scoped_tokens`, `audit_events`, `retention_policies`) + R2 artifacts
- Console: Astro on Cloudflare Pages + Functions proxy

## API
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
- Auth: `CF-Access-Client-Id` + `CF-Access-Client-Secret`
- Tool surface:
  - memory list/upsert/search/profile
  - memory refresh/suppress/delete
  - task create/get/events
  - agent message send/inbox/get/read/ack
- Tenant isolation: per-token tenant grants with optional principal -> tenant mapping (`MCP_TENANT_POLICY_JSON`) enforced server-side

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
- `/v1/memories/capture-rationale` は非対話 hook 用に memory capture と推定 rationale/evidence 保存を 1 回で行う。保存される rationale は `confirmation_state=inferred_unconfirmed` とし、人間確認済みとは区別する
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
- `/`
- `/memories`
- `/decisions`
- `/tasks/new`
- `/tasks`
- `/tasks/[task_id]`

## Operator Workflow
- `pnpm -s usage:status` queries the D1 source of truth and reports a tenant usage snapshot for memory/thread counts. It intentionally does not query task rows.
- `pnpm agmsg` sends, lists, reads, and acks agent messages through the API Gateway.
- `pnpm hook:bridge <source>` normalizes hook payloads from coding agents and upserts them into `memories`.
- `pnpm hook:bridge` emits JSON with `memory_scope`, `cloud_memory_enabled`, `org_sharing_enabled`, and `shared_write`; `pnpm sync:agents-memory` prints the same mode before API import/export.
- hook/bridge 由来の自動保存は非対話 path として扱い、propose/confirm を要求しない。代わりに `/v1/memories/capture-rationale` で `decision_rationales` / `decision_evidence` を `inferred_unconfirmed` として保存する。
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
- SCIM/SAML provisioning and arbitrary custom role definitions
- Production evidence for the credential-gated cloud D1 restore drill
- Capability plugin marketplace
- Third-party SaaS connector ingestion
- Complete adversarial poisoning, multilingual PII, and redaction evaluation
- Raw agent transcript stores への直接書き込み統合
