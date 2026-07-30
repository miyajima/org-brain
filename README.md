# OrgBrain

**AIが動くたび、組織が学ぶ。**

**Every time AI agents work, the organization learns.**

OrgBrain is the organizational memory layer for AI agents.

It turns every agent action, decision, handoff, and failure into reusable context,
so the next agent does not start from zero.

AI agents are already good at individual tasks.

OrgBrain is for what happens between tasks: why a decision was made, what failed last time,
which teams are working on related problems, and how today's work affects tomorrow's plan.

The future we are building is simple:

**every organization should have a memory that AI agents can read, update, and use to move work forward.**

OrgBrain includes reproducible memory retrieval benchmarks. See [Benchmarks](#benchmarks) for details.

## What is OrgBrain?

OrgBrain is local-first, self-hostable infrastructure for shared AI-agent memory.

Start with a private SQLite database on your laptop. When memory becomes team infrastructure,
run the Cloudflare stack yourself. If you want the operations handled for you, use the managed SaaS.

The product goal is bigger than long-term memory for one agent. OrgBrain is designed to help teams
turn agent work into organizational learning: decisions, lessons, warnings, project facts,
handoffs, and dependency context that can be reused across tools and over time.

## The Problem

AI agents are powerful, but they still behave like new hires every morning.

They usually do not know:

- what was decided yesterday
- why a plan changed
- what failed in another team
- which project depends on this one
- whether another agent is solving the same problem
- what organizational context should shape the next action

This makes agent workflows fragile. Context disappears between runs, teams repeat mistakes,
and useful knowledge remains scattered across chats, docs, tickets, pull requests, and human memory.

## The Future

With OrgBrain, every agent run can make the organization smarter.

- Yesterday's decisions become today's context.
- One team's failure becomes another agent's warning.
- Related projects and dependencies are connected automatically.
- Agents across tools can share the same organizational memory.
- The organization learns as AI agents work.

OrgBrain is built for a future where agents do not just execute tasks.
They help the organization remember, connect, and improve.

## What OrgBrain Does

OrgBrain gives AI agents a shared memory loop:

1. **Capture**

   Record useful context from agent runs, human decisions, project updates, and handoffs.

2. **Distill**

   Convert raw activity into reusable memories: decisions, lessons, warnings, project facts, and dependencies.

3. **Connect**

   Link related projects, teams, failures, documents, and agent work across the organization.

4. **Recall**

   Retrieve the right memory before the next agent acts.

5. **Improve**

   Every agent run makes the organization easier for future agents to understand.

## Example Use Cases

### Morning project briefing

Ask an agent what changed overnight.

OrgBrain helps it answer:

- what decisions were made yesterday
- why they were made
- which tasks are now blocked
- what needs attention today

### Cross-team collaboration

When two teams or agents are solving related problems,
OrgBrain can surface the overlap and make collaboration easier to notice before work is duplicated.

### Project planning with dependencies

When an agent creates a plan,
OrgBrain can bring in related projects, timelines, constraints, and critical paths
so the plan reflects the broader organization, not just the current task.

### Failure-aware execution

When an agent is about to repeat a risky pattern,
OrgBrain can recall previous failures and surface warnings, checklists, or review requirements.

## Why It Matters

Most AI agents forget the organization around them.

They do not know:

- what was decided yesterday
- why a plan changed
- what failed in another team
- which project depends on this one
- when two agents are solving the same problem

OrgBrain gives agents shared organizational memory.

That means:

- fewer repeated mistakes
- better handoffs between agents and humans
- project context that survives context windows
- reusable lessons across teams
- AI workflows that get smarter over time

## Why OrgBrain is Different

OrgBrain is not just a vector database or a personal memory plugin.

It is designed around organizational memory:

- **Local-first**: start with memory you can inspect and own.
- **Agent-agnostic**: work across different AI tools and harnesses.
- **Decision-aware**: preserve not just what happened, but why it happened.
- **Failure-aware**: turn mistakes into reusable warnings and checklists.
- **Team-ready**: move from local memory to a shared memory bus when teams need it.
- **Portable**: keep memory exportable and compatible with Markdown/Git-style workflows.

The goal is not only to help one agent remember.
The goal is to help the organization learn.

## Choose Your Mode

| Mode | Best for | Storage | Sharing |
| --- | --- | --- | --- |
| Local | personal or project-level agent memory | SQLite | private |
| Self-hosted | team memory bus | Cloudflare stack | tenant-scoped |
| Managed | teams that do not want to operate infrastructure | hosted OrgBrain | managed |

## Quick Start: Local Memory

Use this when you want free personal memory without Cloudflare.

Requires Node.js 22.13 or newer. The CLI uses the SQLite driver bundled with Node;
the external `sqlite3` command is not required.

```bash
pnpm install
pnpm exec orgbrain init
pnpm exec orgbrain doctor
printf '{"summary":"Use UTC for backend validation","content":"In astronomy backend tests, run Maven with TZ=UTC to avoid timezone-sensitive failures.","project_id":"astronomy","kind":"constraint","tags":["testing","memory"]}' | pnpm exec orgbrain memory capture
pnpm exec orgbrain memory search "timezone validation"
pnpm exec orgbrain memory export --format markdown
```

By default the database is stored at `~/.org-brain/memory.sqlite`. Override it with:

```bash
export ORGBRAIN_LOCAL_DB="$HOME/.org-brain/memory.sqlite"
```

The local database uses WAL, schema migrations, content hashes, immutable version
snapshots, and private filesystem modes (`0700` directory, `0600` database and
backups). Operational commands:

```bash
pnpm exec orgbrain index rebuild
pnpm exec orgbrain backup create
pnpm exec orgbrain backup verify --from ~/.org-brain/backups/<backup>.sqlite
pnpm exec orgbrain backup restore --from ~/.org-brain/backups/<backup>.sqlite
pnpm exec orgbrain migrate --from /path/to/legacy-memory.sqlite
pnpm exec orgbrain serve
pnpm exec orgbrain mcp
```

`orgbrain serve` binds to `127.0.0.1` by default and local mode makes no external
network requests. `orgbrain mcp` is a stdio MCP server over the same SQLite
MemoryStore, so Codex, Claude, and OpenCode can use local capture and search
without a second daemon or cloud account. See [Local migration and recovery](docs/LOCAL_MIGRATION.md) and
the [threat model](docs/THREAT_MODEL.md).

Generate a reviewable MCP registration plan for any supported agent, then add
`--execute` only when you want the CLI to change that agent's configuration:

```bash
orgbrain connector setup codex
orgbrain connector setup claude --scope user
orgbrain connector setup opencode --scope project
orgbrain connector setup openclaw

orgbrain connector setup codex --execute
```

Codex, Claude Code, and OpenCode use their documented MCP CLI registration
commands. OpenClaw returns the exact `mcp.servers` JSON to merge and its config
validation command because its configuration is managed as a bundle/config
surface. References: [Codex MCP](https://developers.openai.com/codex/mcp/),
[Claude Code MCP](https://docs.anthropic.com/en/docs/claude-code/mcp),
[OpenCode MCP](https://opencode.ai/v2/docs/mcp-servers), and
[OpenClaw MCP](https://docs.openclaw.ai/cli/mcp).

The common hook bridge accepts Codex, Claude, OpenCode, and OpenClaw events.
When cloud memory is disabled (the default), distilled durable entries are
written directly to local SQLite; raw transcripts are not stored:

```bash
printf '%s' '{"type":"agent-turn-complete","project_id":"my-project","memory_entry":{"type":"project-fact","trigger":"A release is planned","decision":"Require approval before production","reason":"Keep releases auditable","evidence":"ADR-42","action":"Run the approval gate","result":"Policy confirmed","reuse":"Apply before every release","validity":"Until ADR-42 is superseded","tags":"policy,release"}}' \
  | pnpm exec orgbrain event ingest codex
```

Use `claude`, `opencode`, or `openclaw` in place of `codex`; the bridge
normalizes each native event envelope to the same durable-memory contract.
Set `ORGBRAIN_LOCAL_HOOK_CAPTURE=false` to disable this local automatic capture.

After enabling Cloudflare-backed memory in one of the modes below, you can import/export existing local agent memory through the API bridge:

```bash
pnpm sync:agents-memory
```

OpenClaw currently has an import path from `~/.openclaw/memory/main.sqlite`; other agents receive markdown exports.

### Supported local runtime

| Component | Supported |
| --- | --- |
| Node.js | 22.13 or newer |
| macOS | Current supported releases, arm64 and x64 |
| Linux | glibc-based arm64 and x64 distributions |
| Windows | Native Node CLI; private-mode checks follow platform capabilities |
| Storage | SQLite bundled with Node, no external database required |

Docker Compose exposes the container only on host loopback and persists data in
a named volume:

```bash
docker compose up --build
curl http://127.0.0.1:8788/health
```

Release assets also include `orgbrain.mjs`, a single-file executable bundle for
users who already have Node.js 22.13 or newer and do not want to install the npm
package:

```bash
chmod +x orgbrain.mjs
./orgbrain.mjs init
./orgbrain.mjs memory search "release policy"
```

`pnpm build:standalone` reproduces the bundle locally. Tagged releases publish
its SHA-256 checksum and include the bundle in the build-provenance attestation.

## Quick Start: Self-hosted Team Memory

Use this when you want team memory sharing, Remote MCP, the console, and the organization bus.

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Copy local env examples:

   ```bash
   cp .env.example .env
   cp apps/api-gateway/.dev.vars.example apps/api-gateway/.dev.vars
   cp apps/console/.dev.vars.example apps/console/.dev.vars
   ```

3. Configure Cloudflare resources in each `wrangler.toml`: D1, R2, Queues, Durable Objects, and service bindings.

   The CLI can inspect the checkout and produce the complete provisioning plan
   without changing Cloudflare or local configuration:

   ```bash
   pnpm exec orgbrain cloud doctor --root .
   pnpm exec orgbrain cloud provision --root . --with-vectorize
   ```

   After reviewing that JSON plan, provide a narrowly scoped Cloudflare token
   and opt in to execution:

   ```bash
   export CLOUDFLARE_ACCOUNT_ID="<account-id>"
   export CLOUDFLARE_API_TOKEN="<provisioning-token>"
   pnpm exec orgbrain cloud provision --root . --with-vectorize --execute
   ```

Execution creates missing D1, R2, Queue/DLQ, and optional Vectorize
   resources, synchronizes the resulting D1 UUID across the three Worker
   configurations, applies remote migrations, and deploys services in
   dependency order. It does not create application API keys, OIDC policy, or
   production secrets. Run `cloud doctor --live` to verify Cloudflare
authentication separately.

`.github/workflows/cloud-restore-drill.yml` provides the staging recovery gate.
With the `cloud-staging` environment configured with
`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and optionally
`ORGBRAIN_STAGING_D1_NAME`, it exports the staging D1 database, restores into an
isolated run-specific database, verifies counts and ordered content hashes,
checks RPO ≤ 5 minutes and RTO ≤ 60 minutes, then deletes the drill database in
an `always()` cleanup step. Until that workflow has a successful staging
artifact, the targets are configured but not production evidence.

4. If you did not use `cloud provision --execute`, apply D1 migrations manually:

   ```bash
   pnpm -C apps/api-gateway wrangler d1 migrations apply open-brain --local -c wrangler.local.toml
   ```

5. Run the local gateway and console in two terminals:

   ```bash
   pnpm -C apps/api-gateway wrangler dev --port 8787 -c wrangler.local.toml
   pnpm -C apps/console dev
   ```

6. For production self-hosting, deploy in dependency order:

   ```bash
   pnpm -C apps/cap-runner build
   pnpm -C apps/org-router build
   pnpm -C apps/api-gateway build
   pnpm -C apps/mcp build
   pnpm -C apps/console build
   ```

## Agent Integrations

OrgBrain is agent-agnostic by design. It can connect Codex, Claude Code, Cursor, OpenClaw,
OpenCode, and other agent workflows through reusable memory exports and hooks.

Cloudflare-backed memory and organization sharing are both OFF by default. With the default env values,
`pnpm local:memory` stores personal memory locally and `pnpm hook:bridge` / `pnpm sync:agents-memory`
do not write to the Cloudflare API.

```bash
ORGBRAIN_ENABLE_CLOUD_MEMORY=false
ORGBRAIN_ENABLE_ORG_SHARING=false
```

To use personal portable memory on your own Cloudflare deployment, enable Cloudflare memory but keep organization sharing OFF:

```bash
export ORGBRAIN_ENABLE_CLOUD_MEMORY=true
export ORGBRAIN_ENABLE_ORG_SHARING=false
export ORGBRAIN_API_URL="http://127.0.0.1:8787"
export ORGBRAIN_API_KEY="dev-org-brain-api-key"
export ORGBRAIN_TENANT_ID="personal"

pnpm hook:bridge -- codex '{"type":"agent-turn-complete","cwd":"<repo-root>","last-assistant-message":"..."}'
pnpm sync:agents-memory
```

In this mode hook output includes `memory_scope:"personal_cloud"` and `shared_write:false`.

To share memory with an organization, enable both settings and use a team tenant:

```bash
export ORGBRAIN_ENABLE_CLOUD_MEMORY=true
export ORGBRAIN_ENABLE_ORG_SHARING=true
export ORGBRAIN_API_URL="https://<your-worker>.<account>.workers.dev"
export ORGBRAIN_API_KEY="<team-api-key>"
export ORGBRAIN_TENANT_ID="<team-tenant>"
```

For organization sharing, configure tenant grants in the gateway with `API_TENANT_POLICY_JSON` and,
for MCP clients, `MCP_TENANT_POLICY_JSON`. In this mode hook output includes
`memory_scope:"organization"` and `shared_write:true`, and `pnpm sync:agents-memory` prints a `[mode]`
line with the active scope, sharing flag, and tenant before import/export.

Agent messages provide an agmsg-style inbox over the same API credentials:

```bash
pnpm agmsg send --to agent:codex --subject "Review needed" --body "Please check the latest plan."
pnpm agmsg inbox --target agent:codex
pnpm agmsg ack <message-id> --target agent:codex
```

The CLI uses `ORGBRAIN_API_URL`, `ORGBRAIN_API_KEY`, and `ORGBRAIN_TENANT_ID`.
`ORGBRAIN_API_BASE` remains a compatibility alias when `ORGBRAIN_API_URL` is unset.

Identity is explicit. API-key requests are owned by the `principal` configured for that key, such as
`user:alice@example.com`, `team:platform`, or `service:openclaw-orgbrain`. Cloudflare Access login requests
are owned by `user:<access-sub>`. Optional profile fields such as display name, email, company name,
and organization name are for display only; sharing uses tenant-scoped groups and resource ACLs, so groups
can span companies, departments, projects, or any other collaboration unit.

## Memory APIs

The self-hosted API gateway exposes:

- `GET /v1/auth/me`
- `PUT /v1/auth/me/profile`
- `GET|PUT|DELETE /v1/role-assignments`
- `GET|POST|DELETE /v1/scoped-tokens`
- `GET|PUT /v1/retention-policies`
- `POST /v1/retention-policies/apply` (dry-run unless `execute=true`)
- `GET /v1/audit-events`
- `GET /v1/audit-events/verify`
- `GET /v1/groups`
- `POST /v1/groups`
- `PUT /v1/resource-shares`
- `POST /v1/agent-messages`
- `GET /v1/agent-messages`
- `GET /v1/agent-messages/:messageId`
- `POST /v1/agent-messages/:messageId/read`
- `POST /v1/agent-messages/:messageId/ack`
- `POST /v1/memories/search`
- `POST /v1/memories/profile`
- `POST /v1/memories/capture`
- `POST /v1/memories/propose`
- `POST /v1/memories/confirm`
- `POST /v1/memories/revise`
- `POST /v1/memories/refresh`
- `POST /v1/memories/suppress`
- `DELETE /v1/memories/:memoryId`
- `POST /v1/retrieval-index/rebuild`
- `GET /v1/ops/status`
- `POST /v1/ops/tasks/:id/replay` (failed/dead-letter task replay)
- `POST /v1/decision-memories/search`
- `POST /v1/decision-memories/review-queue`
- `GET /v1/decision-memories/:id/context`
- `POST /v1/decision-memories/:id/revise`
- `POST /v1/decision-memories/:id/confirm`
- `POST /v1/context/pre-action-gate`
- `POST /v1/context/review-check`
- `POST /v1/context/debt/scan`
- `/mcp` for Remote MCP clients

Memory search supports lexical query expansion, hybrid memory/docs retrieval, recent history,
lifecycle states, and rationale-aware filters. `search_mode=hybrid_v2` fuses lexical,
semantic, graph, time, authority, and utility signals and returns a score breakdown.
When Workers AI and Vectorize are not bound, semantic scoring is explicitly reported
as unavailable and the response sets `meta.retrieval.degraded=true`; it is never
simulated with lexical overlap.
Decision memory APIs support opt-in provenance and trust review for the Console decision editor
without changing default memory retrieval profiles.

Personal mode uses `local-sparse-feature-hash-v1` by default. It builds a
reconstructable SQLite sparse-vector projection from normalized terms, local
concept aliases, and CJK trigrams; no model download or network request occurs.
Local search fuses FTS, cosine-style sparse-vector similarity, memory edges,
recency, authority, and utility. `orgbrain index rebuild` recreates both FTS and
the local vector projection, while `doctor` and backup verification compare
their row counts with the authoritative records.
`orgbrain serve` also creates a verified startup backup and repeats it every
five minutes by default. Set `ORGBRAIN_AUTO_BACKUP=false` to disable it or
`ORGBRAIN_AUTO_BACKUP_INTERVAL_MS` to change the interval (minimum one minute).

For real semantic search, create a 384-dimensional cosine Vectorize index, add
`AI` and `MEMORY_VECTOR_INDEX` bindings, then call the admin-only
`POST /v1/retrieval-index/rebuild` endpoint. New and revised memories are then
projected automatically, while suppression and deletion remove their vectors.

Cloud deployments accept API keys, Cloudflare Access JWTs, or generic RS256 OIDC
JWTs. Generic OIDC uses `OIDC_ISSUER`, `OIDC_AUD`, optional
`OIDC_JWKS_JSON`, and `OIDC_TENANT_POLICY_JSON`. Admins can issue short-lived
`obp_` scoped tokens; only a SHA-256 token hash is stored and the clear token is
returned once. Retention enforcement is dry-run by default, and matching legal
holds block hard deletion.

Cloud deployments may additionally bind `API_RATE_LIMITER` using a Workers
Rate Limiting binding. Requests are keyed by authenticated tenant, principal,
and route; rejected requests return HTTP 429 and are recorded as denied audit
events. The binding is optional so local/self-hosted development remains
dependency-free:

```toml
[[ratelimits]]
name = "API_RATE_LIMITER"
namespace_id = "1001"

  [ratelimits.simple]
  limit = 1500
  period = 60
```

## Benchmarks

OrgBrain's reproducible LongMemEval-S run is intentionally reported as an evidence-backed benchmark,
not a vague claim. Public anchors are not same-harness measurements, but they provide useful context.

| System / Track | Accuracy | Evidence recall@5 | Token reduction |
| --- | ---: | ---: | ---: |
| OrgBrain reproducible run | 99.4% | 100.0% | 99.54% |
| Zep public answer-accuracy anchor | 90.2% | n/a | n/a |
| gbrain public retrieval anchor | n/a | 97.6% | n/a |
| agentmemory public retrieval anchor | n/a | 95.2% | 99.13% |

Method: LongMemEval-S 500 questions, Gemini judge enabled, single final answer per item,
no best-of-N picking, compact evidence-card context, local token estimator for prompt accounting.
The benchmark command and comparison report live in `scripts/memory-token-benchmark.mjs`.

The fixed `competitive-memory-v1` suite adds 100 personal and 100 organization
tasks covering coding, preferences, permissions, staleness, contradictions,
decisions, evidence, policy, and cross-tenant isolation. Personal cases are
explicitly labeled as LongMemEval-style or LoCoMo-style; governed multi-step
cases are labeled STATE-Bench-style. These labels describe the fixed task
shape, not results on the upstream datasets. The separate 500-question
LongMemEval-S run above remains the upstream-dataset result.

The suite runs each task five times and records raw per-task results, task
completion, pass^5, turn count, adapter-reported cost, context size, provenance,
leaks, and latency. External systems use the same `/reset`, `/capture`,
`/search` benchmark bridge contract; `/search` may return either a results array
or `{ "results": [...], "usage": { "turns": 1, "cost_usd": 0.0 } }`.
Every request includes the declared shared harness. Bridges may also implement
`POST /capabilities`, or operators may pass an evidence file, to supply the
remaining weighted dimensions. A capability score is ignored unless it has at
least one non-empty evidence reference.
The benchmark workflow also downloads the upstream LongMemEval-S dataset and
publishes all 500 deterministic retrieval/context item rows plus its summary as
a separate CI artifact.

```bash
pnpm benchmark:competitive -- --adapter orgbrain-local
pnpm benchmark:competitive -- \
  --adapter all \
  --evidence ./benchmark-evidence.json \
  --model-id shared-model \
  --budget-usd 5 \
  --hardware-id shared-runner
pnpm benchmark:scale -- --count 100000 --queries 200
```

The evidence file is keyed by adapter. Each component uses the same
`{ "score": 0..100, "evidence": ["artifact or report reference"] }` shape:

```json
{
  "adapters": {
    "orgbrain-local": {
      "personal": {
        "setup_and_daily_ux": {
          "score": 95,
          "evidence": ["artifacts/orgbrain-setup-timing.json"]
        }
      },
      "organization": {
        "availability_and_recovery": {
          "score": 90,
          "evidence": ["artifacts/orgbrain-staging-restore.json"]
        }
      }
    }
  }
}
```

Current OrgBrain local baseline on the development machine (2026-07-30):

| Suite | Accuracy | R@5 | pass^5 | Avg context | p95 | Leaks | Provenance |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| competitive-memory-v1, 200 tasks | 100% | 100% | 100% | 366.86 tokens | 3.17 ms | 0 | 100% |
| local-scale-v1, 100,000 memories | 100% retrieval | 100% | n/a | n/a | 20.82 ms | 0 | 100% indexed |

These are OrgBrain baselines, not a first-place claim. Supermemory, GBrain,
Cognee, and Mem0 results are only comparable when their bridge URLs are
configured and all adapters run on the same model budget and hardware. CI
uploads the complete settings and per-task JSON as artifacts. The JSON also
contains the plan's personal and organization weighted scorecards. Any
unmeasured dimension is `null`, the complete weighted score stays `null`, and
ranking remains ineligible until every dimension and every same-harness
competitor is measured. A first-place claim is emitted only when all five
adapters are complete, OrgBrain has a strict lead in both weighted scorecards,
and it does not trail any competitor in a critical dimension.

Token-only smoke:

```bash
pnpm benchmark:tokens -- \
  --leaderboard-profile org_brain_repro \
  --dataset-path /tmp/org-brain-longmemeval-s.json \
  --limit 500 \
  --skip-llm \
  --compare-public
```

Full LLM-judged run:

```bash
pnpm benchmark:tokens -- \
  --leaderboard-profile org_brain_repro \
  --retrieval-profile longmemeval_session \
  --answerer-profile worksheet_router \
  --dataset-path /tmp/org-brain-longmemeval-s.json \
  --limit 500 \
  --token-budget 650 \
  --context-char-limit 900 \
  --estimate-tokens \
  --compare-public \
  --write-results-jsonl /tmp/org-brain-longmemeval-results.jsonl
```

Set `GEMINI_API_KEY` or `GOOGLE_API_KEY` before running LLM judging.

## What Is Included

- `scripts/local-memory.mjs`: personal SQLite memory CLI.
- `scripts/hook-memory-bridge.mjs`: reusable-memory capture from local agent hooks.
- `scripts/sync-agents-memory.mjs`: import/export bridge for local agent memory.
- `apps/api-gateway`: Hono API Worker for memory, docs, tasks, measurement, and Remote MCP.
- `apps/org-router`: queue router for the organization bus.
- `apps/cap-runner`: capability workers, maintenance jobs, and Durable Objects.
- `apps/mcp`: compatibility Remote MCP Worker.
- `apps/console`: Astro console for browsing and operating memory.
- `packages/shared`: shared schemas, retrieval helpers, lifecycle types, and knowledge-doc utilities.
- `migrations`: D1 SQL migrations for the self-hosted Cloudflare stack.

### Console Preview

The decision knowledge editor defaults to English and supports Japanese and Chinese through the in-page language switcher
or `?lang=ja` / `?lang=zh`.

![Decision Knowledge Editor desktop view](docs/assets/decision-editor-desktop.png)

## Managed SaaS

Self-hosting is free under Apache-2.0. The official managed SaaS is paid because it provides:

- hosted Cloudflare deployment and upgrades
- authentication and team administration
- monitoring, backups, and operational support
- managed Remote MCP endpoints
- reliability work that most teams do not want to own

The public repo does not include official SaaS billing systems, customer administration, production secrets,
or official domain configuration.

## License

OrgBrain is licensed under the Apache License 2.0. See `LICENSE` for the full license text.

The OrgBrain name, official hosted service, official domains, billing operations, and managed service branding
are not granted by the source license.

## Project Status

Initial public release target: `0.1.0`. Product versioning is tracked with SemVer in `CHANGELOG.md`
and GitHub Releases. Feature-level labels such as internal prototype versions are not part of the public release story.
