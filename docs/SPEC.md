# Org Brain Spec (MVP)

## Goal
Cloudflare上で、Memory/Artifactsに加えて組織Functionとして動くタスク/イベント駆動の通信バスを提供する。
加えて、task / event / artifact / memory を正本のまま維持しつつ、人間とエージェント向けの知識インターフェースとして interlinked markdown docs layer を提供する。

## Scope
- API Gateway: Hono Worker
- Event Bus: Cloudflare Queues (`org-bus`, `cap-plan`)
- Coordination: Durable Objects (`LeaseDO`, `MailboxDO`)
- MCP: Remote MCP endpoint on API Gateway (`/mcp`, service-token auth)
- Storage: D1 (`tasks`, `task_events`, `capabilities`, `memories`, `memories_fts`, `memory_versions`, `memory_edges`, `entities`, `memory_entities`, `decision_rationales`, `decision_evidence`, `decision_memories`, `memory_confirmations`, `threads`, `retrieval_events`, `retrieval_daily_metrics`, `knowledge_docs`, `knowledge_links`, `knowledge_docs_fts`) + R2 artifacts
- Console: Astro on Cloudflare Pages + Functions proxy

## API
- `POST /v1/tasks`
- `GET /v1/tasks`
- `GET /v1/tasks/:taskId`
- `GET /v1/tasks/:taskId/events`
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
  - memory refresh/suppress
  - task create/get/events
- Tenant isolation: per-token tenant grants with optional principal -> tenant mapping (`MCP_TENANT_POLICY_JSON`) enforced server-side

## Memory Source of Truth
- Master data is Cloudflare D1 (`memories`, `memories_fts`)
- OpenClaw local DB (`~/.openclaw/memory/main.sqlite`) is cache/index only
- Local agent hooks and sync scripts do not write to Cloudflare unless `ORGBRAIN_ENABLE_CLOUD_MEMORY=true`; organization sharing additionally requires `ORGBRAIN_ENABLE_ORG_SHARING=true`.
- Agent hook連携はAPI (`/v1/memories*`) + hook bridge (`scripts/hook-memory-bridge.mjs`) で行う
- hook bridge は新しい workspace で最初に reusable memory を保存する際、project 名を確認し、既定値には `basename(cwd)` を使う
- Hook bridge は low-signal な会話終了ログを原則保存せず、再利用価値のある内容だけを distilled memory として upsert する
- Agent memory sync は API (`/v1/memories*`) + sync script (`scripts/sync-agents-memory.mjs`) で行う
- `/v1/memories/upsert` は request 内 `external_key` を last-write-wins で dedupe し、既存 key lookup + `memories_fts` 更新を batch 化する
- memory lifecycle v2 では `memories` を current snapshot、`memory_versions` を immutable 履歴、`memory_edges` を lightweight lineage relation として扱う
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
- `/v1/memories/search` と cap-runner retrieval は共有 helper を使い、`bm25_v1`、`bm25_rewrite_v1`、`hybrid_memory_docs_v1` を切り替える
- `rewrite_query=true` は phrase / token OR / split token OR / singularized token OR の最大 4 変種で lexical FTS5 を引き、memory id 単位で best rank を採用する
- `search_mode=hybrid` は dedupe 後の lexical memory hit が 3 件未満のときに `knowledge_docs_fts` を追加検索し、memory/doc を summary/title 単位で dedupe して返す
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
- `pnpm hook:bridge <source>` normalizes hook payloads from coding agents and upserts them into `memories`.
- `pnpm hook:bridge` emits JSON with `memory_scope`, `cloud_memory_enabled`, `org_sharing_enabled`, and `shared_write`; `pnpm sync:agents-memory` prints the same mode before API import/export.
- hook/bridge 由来の自動保存は非対話 path として扱い、propose/confirm を要求しない。代わりに `/v1/memories/capture-rationale` で `decision_rationales` / `decision_evidence` を `inferred_unconfirmed` として保存する。
- `pnpm docs:seed` upserts the minimal stable knowledge-doc set via the Pages/API proxy.
- `pnpm memories:maintain` compacts old raw hook memories into digest rows and collapses old duplicates.
- `pnpm memories:cleanup` dry-runs by default, can export a JSONL backup, physically removes low-signal memory rows and related memory tables on `--apply`, and promotes structured `project-fact` rows to curated semantic memory.
- `pnpm memories:backfill-rationales` dry-runs by default and can add inferred unconfirmed rationale/evidence rows for active high-value memories (`project-fact`, `curated-memory`, `promoted`, `canonical-memory`) with `--apply`.
- `pnpm metrics:report` reports retrieval hit/fallback/latency plus service outcomes from D1 telemetry.
- `pnpm metrics:replay` replays recent task inputs against `bm25_v1`, `bm25_rewrite_v1`, and `hybrid_memory_docs_v1` without persisting new rows.
- `pnpm metrics:rollup` backfills or recomputes one UTC day into `retrieval_daily_metrics`.
- `pnpm measurement:report` reports opt-in measurement runs comparing raw-context control tasks with compact-memory treatment tasks, with optional `--session-id` aggregation for multi-turn sessions.
- Agent-facing memory impact notes (`memory_used`, `avoided_lookup`, `memory_basis`, `confidence`) are qualitative supplements only; quantitative evaluation remains `retrieval_events` plus measurement mode.

## Out of Scope (MVP)
- Advanced RBAC and tenant isolation policies
- DLQ replay UI
- Capability plugin marketplace
- Production observability dashboards
- Agent transcript stores への直接書き込み統合
