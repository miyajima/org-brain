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

```bash
pnpm install
pnpm local:memory init
printf '{"summary":"Use UTC for backend validation","content":"In astronomy backend tests, run Maven with TZ=UTC to avoid timezone-sensitive failures.","project_id":"astronomy","tags":["testing","memory"]}' | pnpm local:memory upsert
pnpm local:memory search "timezone validation"
pnpm local:memory export-markdown
```

By default the database is stored at `~/.org-brain/memory.sqlite`. Override it with:

```bash
export ORGBRAIN_LOCAL_DB="$HOME/.org-brain/memory.sqlite"
```

After enabling Cloudflare-backed memory in one of the modes below, you can import/export existing local agent memory through the API bridge:

```bash
pnpm sync:agents-memory
```

OpenClaw currently has an import path from `~/.openclaw/memory/main.sqlite`; other agents receive markdown exports.

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

4. Apply D1 migrations:

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

Identity is explicit. API-key requests are owned by the `principal` configured for that key, such as
`user:alice@example.com`, `team:platform`, or `service:openclaw-orgbrain`. Cloudflare Access login requests
are owned by `user:<access-sub>`. Optional profile fields such as display name, email, company name,
and organization name are for display only; sharing uses tenant-scoped groups and resource ACLs, so groups
can span companies, departments, projects, or any other collaboration unit.

## Memory APIs

The self-hosted API gateway exposes:

- `GET /v1/auth/me`
- `PUT /v1/auth/me/profile`
- `GET /v1/groups`
- `POST /v1/groups`
- `PUT /v1/resource-shares`
- `POST /v1/memories/search`
- `POST /v1/memories/profile`
- `POST /v1/memories/capture`
- `POST /v1/memories/propose`
- `POST /v1/memories/confirm`
- `POST /v1/memories/revise`
- `POST /v1/memories/refresh`
- `POST /v1/memories/suppress`
- `POST /v1/decision-memories/search`
- `GET /v1/decision-memories/:id/context`
- `POST /v1/decision-memories/:id/revise`
- `POST /v1/decision-memories/:id/confirm`
- `/mcp` for Remote MCP clients

Memory search supports lexical query expansion, hybrid memory/docs retrieval, recent history,
lifecycle states, and rationale-aware filters.
Decision memory APIs support opt-in provenance and trust review for the Console decision editor
without changing default memory retrieval profiles.

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
