# Org Brain Spec (MVP)

## Goal
Cloudflare上で、Memory/Artifactsに加えて組織Functionとして動くタスク/イベント駆動の通信バスを提供する。
加えて、task / event / artifact / memory を正本のまま維持しつつ、人間とエージェント向けの知識インターフェースとして interlinked markdown docs layer を提供する。

## Scope
- API Gateway: Hono Worker
- Event Bus: Cloudflare Queues (`org-bus`, `cap-plan`, `cap-code`, `cap-review`)
- Coordination: Durable Objects (`LeaseDO`, `MailboxDO`)
- MCP: Remote MCP endpoint on API Gateway (`/mcp`, service-token auth)
- Storage: D1 (`tasks`, `task_events`, `capabilities`, `memories`, `memories_fts`, `memory_versions`, `memory_edges`, `entities`, `memory_entities`, `decision_rationales`, `decision_evidence`, `memory_confirmations`, `threads`, `retrieval_events`, `retrieval_daily_metrics`, `knowledge_docs`, `knowledge_links`, `knowledge_docs_fts`) + R2 artifacts
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
- `POST /v1/docs`
- `GET /v1/docs/:slug`
- `POST /v1/docs/search`
- `GET /v1/docs/:slug/context`
- Auth: `x-api-key`

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
- Agent hook連携はAPI (`/v1/memories*`) + hook bridge (`scripts/hook-memory-bridge.mjs`) で行う
- Hook bridge は low-signal な会話終了ログを原則保存せず、再利用価値のある内容だけを distilled memory として upsert する
- OpenClaw chunk連携はAPI (`/v1/memories*`) + sync script (`scripts/sync-openclaw-memory.mjs`) で行う
- `/v1/memories/upsert` は request 内 `external_key` を last-write-wins で dedupe し、既存 key lookup + `memories_fts` 更新を batch 化する
- memory lifecycle v2 では `memories` を current snapshot、`memory_versions` を immutable 履歴、`memory_edges` を lightweight lineage relation として扱う
- rationale confirmation v1 では `decision_rationales` を確認済み結論・理由の構造化層、`memory_confirmations` を propose/confirm の短期トークン保管として扱う
- `memories` は `kind`, `lifecycle_state`, `scope_type`, `scope_key`, `actor_type`, `actor_id`, `confidence_score`, `utility_score`, `current_version`, `last_accessed_at`, `suppressed_at`, `expires_at` を持つ
- `/v1/memories/capture` は lifecycle write API で、`/v1/memories/upsert` は後方互換入口としてこれにマップされる
- `/v1/memories/propose` は raw text から `結論` と `理由` を heuristic に推定し、確認 token と一緒に返す
- `/v1/memories/confirm` は確認 token を消費し、approved 時だけ `memories` + `decision_rationales` + entity/evidence rows を永続化する
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
- `/v1/memories/profile` は 1 call で `durable`、`recent`、`search_results` を返す
- `GET /v1/memories` は `limit` / `offset` を受け取り、`paginated=1` の場合は `items + meta(total, has_next, has_prev, canonical_count, digest_count, compacted_count)` を返せる
- `POST /v1/memories/search` は `entity_id`, `entity_role`, `decision_type`, `decision_status`, `confirmation_state`, `reason_text` で rationale-aware filtering できる
- `durable` は `summary` を持つ 24 時間以上前の memory を同一 project 優先 + `policy > diagnosis > command-result > workaround > untagged` の順で返す
- `durable` は lifecycle v2 以降 `semantic` kind を優先し、旧 tag tier は互換ソートとして残す
- `recent` は `durable` に採用していない 14 日以内の memory を同一 project 優先 + recency 順で返す
- Capability retrieval emits best-effort raw telemetry into `retrieval_events` and lightweight `task_events(kind=memory.search)` for drill-down
- Daily cron on `open-brain-cap-runner` rolls up the previous UTC day into `retrieval_daily_metrics` and prunes raw telemetry older than 90 days
- A second daily cron on `open-brain-cap-runner` compacts old hook memories into digest rows and marks old duplicates as `compacted`
- cap-runner retrieval は search hit 上位 memory に対して best-effort で `refresh` 相当の `last_accessed_at` 更新と version 履歴追加を行う

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
- `/tasks/new`
- `/tasks`
- `/tasks/[task_id]`

## Operator Workflow
- `pnpm -s usage:status` queries the D1 source of truth and reports a tenant usage snapshot: task totals/statuses, active tasks, capability/project breakdowns, memory/thread counts, and recent tasks.
- `pnpm hook:bridge <source>` normalizes hook payloads from coding agents and upserts them into `memories`.
- hook/bridge 由来の自動保存は非対話 path として扱い、propose/confirm を要求しない。
- `pnpm docs:seed` upserts the minimal stable knowledge-doc set via the Pages/API proxy.
- `pnpm memories:maintain` compacts old raw hook memories into digest rows and collapses old duplicates.
- `pnpm metrics:report` reports retrieval hit/fallback/latency plus service outcomes from D1 telemetry.
- `pnpm metrics:replay` replays recent task inputs against `bm25_v1`, `bm25_rewrite_v1`, and `hybrid_memory_docs_v1` without persisting new rows.
- `pnpm metrics:rollup` backfills or recomputes one UTC day into `retrieval_daily_metrics`.

## Out of Scope (MVP)
- Advanced RBAC and tenant isolation policies
- DLQ replay UI
- Capability plugin marketplace
- Production observability dashboards
- Agent transcript stores への直接書き込み統合
