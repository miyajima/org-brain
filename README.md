# org-brain

Cloudflare-based org bus MVP with Hono API and Astro console.

## Structure
- `apps/api-gateway` - Hono API Worker
- `apps/org-router` - org-bus Queue router Worker
- `apps/cap-runner` - capability workers + DOs
- `apps/mcp` - legacy Remote MCP Worker (kept for compatibility)
- `apps/console` - Astro Pages console
- `packages/shared` - shared types/schemas/utils
- `migrations` - D1 SQL migrations

## Quick Start
1. `pnpm install`
2. Configure `wrangler.toml` values (`database_id`, bucket, queues, API keys)
3. Apply migrations to D1 (`migrations/*.sql`)
4. Deploy workers/pages in dependency order:
   - cap-runner
   - org-router
   - api-gateway
   - mcp
   - console

## Local Development
The console can run locally without a Cloudflare service binding by using an API base URL fallback.

1. Copy the example vars files:
   - `cp apps/api-gateway/.dev.vars.example apps/api-gateway/.dev.vars`
   - `cp apps/console/.dev.vars.example apps/console/.dev.vars`
2. Set the same API key in both files:
   - `apps/api-gateway/.dev.vars` → `API_KEY`
   - `apps/console/.dev.vars` → `INTERNAL_API_KEY`
3. Point `apps/console/.dev.vars` at either:
   - a local API gateway (`API_BASE_URL=http://127.0.0.1:8787`)
   - or a deployed API gateway host
4. Start the console with `pnpm -C apps/console dev`
5. If you want the API gateway local too, prepare the local D1 database once:
   - `pnpm -C apps/api-gateway wrangler d1 migrations apply open-brain --local -c wrangler.local.toml`
6. Then run the local gateway in a second terminal:
   - `pnpm -C apps/api-gateway wrangler dev --port 8787 -c wrangler.local.toml`
7. Keep the same `API_KEY` value in both apps so the console proxy can authenticate against the API gateway

The console proxy will use the Cloudflare service binding when available and fall back to `API_BASE_URL` when the binding is missing.

## Commands
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm hook:bridge`
- `pnpm sync:openclaw-memory`
- `pnpm docs:seed`
- `pnpm memories:maintain`
- `pnpm usage:status`
- `pnpm metrics:report`
- `pnpm metrics:replay`
- `pnpm metrics:rollup`
- `pnpm measurement:report`

## Memory Search
Org Brain now exposes retrieval and profile endpoints on top of the D1 memory source of truth:

- `POST /v1/memories/search`
- `POST /v1/memories/profile`
- `POST /v1/memories/capture`
- `POST /v1/memories/propose`
- `POST /v1/memories/confirm`
- `POST /v1/memories/revise`
- `POST /v1/memories/refresh`
- `POST /v1/memories/suppress`

`/v1/memories/search` supports:
- `rewrite_query` for 4-way lexical query expansion
- `search_mode=memories|hybrid`
- `include_history` to append recency-ranked memories after lexical/doc hits
- rationale-aware filters: `entity_id`, `entity_role`, `decision_type`, `decision_status`, `confirmation_state`, `reason_text`

`/v1/memories/profile` returns:
- `durable` for summary-backed memories older than 24 hours
- `recent` for non-durable memories from the last 14 days
- `search_results` when `q` is provided

Both endpoints prioritize the current `project_id` when available, dedupe by normalized summary/title, and use the same retrieval helper as cap-runner.

Lifecycle v2 adds:
- `kind`: `episodic|semantic|org_knowledge`
- `lifecycle_state`: `active|suppressed|consolidated|promoted`
- immutable history in `memory_versions`
- best-effort refresh of `last_accessed_at` on retrieval

Compatibility:
- `POST /v1/memories/upsert` remains supported and now maps to the lifecycle capture path.
- Interactive memory saves should use `POST /v1/memories/propose` and `POST /v1/memories/confirm` so the user can verify inferred `結論` and `理由` before persistence.
- suppressed or expired memories are excluded from normal search/profile results.

## Knowledge Docs
Org Brain now includes a docs layer for interlinked markdown knowledge docs. This is a navigation and retrieval interface for humans and agents, not the system of record.

- D1 tables: `knowledge_docs`, `knowledge_links`, `knowledge_docs_fts`
- R2 stores long-form markdown bodies
- Required frontmatter: `id`, `title`, `scope`, `kind`, `tags`, `stability`, `updated_at`
- Supported scopes: `org`, `department`, `project`, `capability`, `workflow`, `policy`

API surface:
- `POST /v1/docs`
- `GET /v1/docs/:slug`
- `POST /v1/docs/search`
- `GET /v1/docs/:slug/context`

Storage rules:
- Short docs stay inline in D1 and are fully indexed
- Long docs store full markdown in R2 and keep only excerpt + metadata in D1
- `[[slug]]` wiki links are extracted on save and resolved into `knowledge_links`

Progressive disclosure:
- Start from MOC docs such as `ORG` or `capabilities/_index`
- Read summaries before full markdown
- Use `/v1/docs/:slug/context` or `loadContext()` for bounded 1-hop expansion

Seed the minimal stable docs set with:

```bash
pnpm docs:seed -- --tenant default
```

Template utility:

```ts
import { generateMocTemplates } from "@org-brain/shared";

const templates = generateMocTemplates({
  updatedAt: "2026-03-13",
  departmentSlugs: ["engineering", "support"],
  projectSlugs: ["project-x"]
});
```

Each template returns a `slug`, repo-style docs `path`, and rendered markdown for initial MOC scaffolding.

## Usage Snapshot
For a current operator view of Org Brain usage, query Cloudflare D1 directly:

```bash
pnpm -s usage:status
pnpm -s usage:status -- --tenant default --json
```

The snapshot reports memory/thread counts and first/last timestamps. Task rows are operational internals and are intentionally excluded.

## Memory Maintenance
Older raw hook memories can be compacted into digest memories so search/profile calls stay focused on reusable content.

```bash
pnpm memories:maintain -- --tenant default --apply --remote
pnpm memories:maintain -- --tenant default --json
```

Maintenance behavior:
- consolidates repeated durable memories into `canonical-memory` rows for project/category level long-term recall
- compacts old non-promoted hook memories into searchable digest rows
- collapses older exact-summary duplicates by keeping the newest searchable row
- marks compacted rows with a `compacted` tag and removes them from retrieval/profile queries
- the same maintenance now runs automatically on Cloudflare every day at `03:30 JST` via `open-brain-cap-runner`

Memory stages:
- `canonical-memory`: synthesized long-term memory maps, searched first
- `curated-memory` / `promoted-memory`: reusable durable memories selected by tags, not by source name
- `memory-digest`: compressed episodic summaries
- recent raw hook memories: excluded from primary lexical search and used only for recent/history context

## Retrieval Metrics
Retrieval telemetry is stored in D1 as `retrieval_events`, with day-level rollups in `retrieval_daily_metrics`.

- `memory.search` task events are appended for per-task drill-down
- raw retrieval telemetry is retained for 90 days
- `open-brain-cap-runner` rolls up the previous UTC day at `09:05 JST`, and runs memory maintenance at `03:30 JST`

Examples:

```bash
pnpm metrics:report
pnpm metrics:report -- --tenant default --days 14 --json
pnpm metrics:replay -- --tenant default --limit 20 --json
pnpm metrics:rollup -- --day 2026-03-10 --json
```

`metrics:report` focuses on retrieval hit/fallback/latency plus service success and duration.
`metrics:replay` compares `bm25_v1`, `bm25_rewrite_v1`, and `hybrid_memory_docs_v1` against the current D1/R2 snapshot without persisting anything.
`metrics:rollup` recomputes one UTC day idempotently into `retrieval_daily_metrics`.

For lightweight human-readable impact tracking, agents should add a compact note when Org Brain memory avoids another lookup:

```text
memory_used: yes
avoided_lookup: source_search|web_search|past_context|none
memory_basis: <memory_id or brief memory summary>
confidence: low|medium|high
```

Use this self-report only as a qualitative signal. For quantitative evaluation, prefer `retrieval_events.search_count`, hit/fallback rates, referenced memory IDs, and measurement mode comparisons.

## Measurement Mode
Memory savings measurement is opt-in. Add `measurement_mode=true` to a task create request to create paired variants from the same input:

- `control`: memory retrieval disabled, with recent raw memory content loaded as a baseline context stand-in
- `treatment`: memory retrieval enabled, using compact durable/recent/search summaries

Both variants run with memory writes disabled so the measurement does not change future recall. Results are stored in:

- `measurement_runs`
- `measurement_variants`
- `measurement_comparisons`

Example task request:

```json
{
  "tenant_id": "default",
  "project_id": "org-brain",
  "capability": "memory_measurement",
  "input_ref": "Measure this task",
  "measurement_mode": true,
  "measurement_session_id": "session-2026-04-27-a",
  "measurement_unit": "session",
  "measurement_reference_model": "estimated_tokens_v1"
}
```

Report recent measurement runs with:

```bash
pnpm measurement:report -- --tenant default
pnpm measurement:report -- --tenant default --session-id session-2026-04-27-a
pnpm measurement:report -- --tenant default --run-id <measurement_run_id> --json
```

The current runtime records deterministic `estimated_tokens_v1` values because the bundled capabilities do not call an external LLM directly yet. The schema is ready for provider usage tokens once real model calls are wired in.
For multi-turn work, pass the same `measurement_session_id` to each measured task and use `--session-id` to report aggregate session savings.

## OpenClaw Memory Bridge
Cloudflare D1 is the source of truth. OpenClaw `main.sqlite` remains a local cache/index.

Set env vars and run:

```bash
export ORGBRAIN_API_BASE="https://<api-gateway-host>"
export ORGBRAIN_API_KEY="<x-api-key>"
pnpm sync:openclaw-memory
```

Optional env vars:
- `SYNC_DIRECTION=both|import|export` (default: `both`)
- `OPENCLAW_MEMORY_DB=~/.openclaw/memory/main.sqlite`
- `OPENCLAW_WORKSPACE=~/clawd`
- `ORGBRAIN_TENANT_ID=default`

Imported OpenClaw chunks are tagged with `curated-memory`, so retrieval tiers stay source-agnostic.

## Agent Hook Bridge
`pnpm hook:bridge` is the shared upsert bridge used by local agent hooks.

```bash
export ORGBRAIN_API_BASE="https://open-brain-console.pages.dev/api"
export ORGBRAIN_API_KEY="via-pages-proxy"
export ORGBRAIN_TENANT_ID="default"

printf '{"type":"agent-turn-complete","cwd":"/tmp/demo"}' | pnpm hook:bridge codex
```

The hook bridge now promotes only reusable memories. Generic `agent-turn-complete` chatter is skipped with
`{"ok":true,"skipped":"low-signal-memory"}` instead of being upserted. Promoted records are distilled into
`# Reusable Memory` entries with takeaway, evidence, and reuse-rule sections to keep FTS noise low.

The bridge also loads fallback env files from:
- `~/.config/org-brain/hooks.env`
- `~/.openclaw/.env`
- `~/.agents/.env`

On the first reusable-memory upsert for a new workspace, the hook bridge now asks for the project name and defaults to `basename(cwd)`. The selected name is cached per workspace in `~/.config/org-brain/project-names.json` and reused on later runs.

When `ORGBRAIN_API_BASE` points at the console proxy (`...pages.dev/api`), the incoming `x-api-key` is ignored and replaced by the Pages secret, so the local `ORGBRAIN_API_KEY` value only needs to be non-empty.

Hook-enabled clients currently wired for Org Brain memory upserts:
- Codex
- Claude Code
- Cursor
- OpenClaw
- OpenCode

Antigravity was not wired because no stable user hook entrypoint was confirmed in the installed app/config.

## Remote MCP
Remote MCP is served directly by `api-gateway` at `/mcp`.

1. Configure `api-gateway` secrets/vars:
   - `MCP_SERVICE_TOKENS_JSON` (service token JSON with `client_id`, `client_secret`, `principal`, `tenants`)
   - optional `MCP_TENANT_POLICY_JSON` (principal -> tenant mapping JSON)
2. Configure your MCP client to send `CF-Access-Client-Id`, `CF-Access-Client-Secret`, and `x-orgbrain-tenant`.
3. Deploy `api-gateway`.

Optional: if you want browser login later, you can layer Cloudflare Access in front of the hostname and add the corresponding JWT verification settings then.

Memory tools now include:
- `orgbrain_memories_list`
- `orgbrain_memories_upsert`
- `orgbrain_memories_search`
- `orgbrain_memories_profile`
- `orgbrain_memories_refresh`
- `orgbrain_memories_suppress`

See [docs/REMOTE_MCP.md](/Users/miya/projects/org-brain/docs/REMOTE_MCP.md) for client config and skill usage.
See [skills/org-brain-usage-status/SKILL.md](/Users/miya/projects/org-brain/skills/org-brain-usage-status/SKILL.md) for the project skill that reports the same usage snapshot without querying task rows.
