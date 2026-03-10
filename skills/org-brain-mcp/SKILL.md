---
name: org-brain-mcp
description: "Use OrgBrain Remote MCP tools for memory/task/workflow operations. Prefer MCP over direct API calls or local SQLite access."
metadata:
  {
    "openclaw": {
      "emoji": "brain",
      "requires": { "mcpServers": ["orgbrain"] }
    },
  }
---

# OrgBrain MCP Skill

Use this skill when the user asks to read/write OrgBrain memory, create tasks, inspect task events, or run/check spec-to-code workflows.

## Rules
1. Prefer MCP tools over direct HTTP calls.
2. Never use local `~/.openclaw/memory/main.sqlite` as source of truth.
3. Use `tenant_id="default"` unless the user explicitly specifies another tenant.
4. For OpenClaw-derived memory writes, set `source="openclaw"` and stable `external_key`.
5. When reporting results, include tool names and key IDs (`task_id`, `instance_id`, `external_key`).
6. Auth must go through the configured `CF-Access-*` service token headers, not static bearer tokens.

## Tool Map
- List memory: `orgbrain_memories_list`
- Upsert memory: `orgbrain_memories_upsert`
- Create task: `orgbrain_task_create`
- Get task: `orgbrain_task_get`
- Get events: `orgbrain_task_events`
- Start workflow: `orgbrain_workflow_spec_to_code_start`
- Check workflow: `orgbrain_workflow_spec_to_code_status`

## Operational Notes
- OrgBrain master memory is Cloudflare D1.
- OpenClaw local memory remains cache/index.
- If MCP returns auth errors, ask for:
  - service token headers (`CF-Access-Client-Id`, `CF-Access-Client-Secret`)
  - optional `x-orgbrain-tenant` header
