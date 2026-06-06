---
name: org-brain-mcp
description: "Use OrgBrain Remote MCP tools for memory/task operations. Prefer MCP over direct API calls or local SQLite access."
metadata:
  {
    "openclaw": {
      "emoji": "brain",
      "requires": { "mcpServers": ["orgbrain"] }
    },
  }
---

# OrgBrain MCP Skill

Use this skill when the user asks to read/write OrgBrain memory, create tasks, or inspect task events.

## Rules
1. Prefer MCP tools over direct HTTP calls.
2. Never use local `~/.openclaw/memory/main.sqlite` as source of truth.
3. Use `tenant_id="default"` unless the user explicitly specifies another tenant.
4. For OpenClaw-derived memory writes, set `source="openclaw"` and stable `external_key`.
5. For interactive memory saves, do not write directly with `orgbrain_memories_upsert`. Call `orgbrain_memories_propose`, show the inferred `結論` and `理由`, confirm they are correct, and only then call `orgbrain_memories_confirm`.
6. If the user corrects the inferred conclusion or reason, pass the corrected fields to `orgbrain_memories_confirm` so the stored rationale is marked as corrected.
7. When reporting results, include tool names and key IDs (`task_id`, `instance_id`, `external_key`, `confirmation_token`, `rationale_id`).
8. When OrgBrain memory lets you avoid source search, web search, or past-context lookup, include a compact impact note in the final report:
   - `memory_used: yes`
   - `avoided_lookup: source_search|web_search|past_context|none`
   - `memory_basis: <memory_id or brief memory summary>`
   - `confidence: low|medium|high`
9. If memory was consulted but did not replace another lookup, report `memory_used: yes` and `avoided_lookup: none` only when the detail is relevant to the user-visible outcome.
10. Auth must go through the configured `CF-Access-*` service token headers, not static bearer tokens.

## Tool Map
- List memory: `orgbrain_memories_list`
- Propose memory save: `orgbrain_memories_propose`
- Confirm memory save: `orgbrain_memories_confirm`
- Upsert memory: `orgbrain_memories_upsert`
- Enrich task context: `orgbrain_context_enrich`
- Create decision memory: `orgbrain_decision_memories_create`
- Search decision memory: `orgbrain_decision_memories_search`
- Create task: `orgbrain_task_create`
- Get task: `orgbrain_task_get`
- Get events: `orgbrain_task_events`

## Operational Notes
- OrgBrain master memory is Cloudflare D1.
- OpenClaw local memory remains cache/index.
- Retrieval impact should be measured primarily with D1 `retrieval_events` and opt-in measurement mode; the final-report impact note is a lightweight self-report for cases where memory avoided another lookup.
- `orgbrain_memories_upsert` remains for compatibility and non-interactive flows, but interactive assistant flows should use propose/confirm.
- For agent preflight, call `orgbrain_context_enrich` with `task.title`, `task.description`, `project_id`, and `task_type`; use returned `decisionContext`, `constraints`, and `knownPitfalls` as guidance, not as a replacement for source verification.
- If MCP returns auth errors, ask for:
  - service token headers (`CF-Access-Client-Id`, `CF-Access-Client-Secret`)
  - optional `x-orgbrain-tenant` header
