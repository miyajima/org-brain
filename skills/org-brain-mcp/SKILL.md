---
name: org-brain-mcp
description: "Configure and use OrgBrain Remote MCP for initial setup, memory capture/search, task operations, agent handoffs, and lifecycle-hook verification. Prefer the stateless remote MCP over direct API calls or local SQLite access."
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
10. Interactive Codex, Claude Code, and Cursor access must use the client's Cloudflare Access Managed OAuth flow. Automatic hooks use one Access Service Token per client installation; never reuse it across clients or machines.
11. Treat hook, MCP, and skill as separate layers: hook selects when to run, MCP is the only preferred cloud transport, and this skill defines usage policy.
12. For automatic hook capture, call the known capture tool directly without `server/discover` or `tools/list`; this path must not invoke an LLM.

## Tool Map
- List memory: `orgbrain_memories_list`
- Propose memory save: `orgbrain_memories_propose`
- Confirm memory save: `orgbrain_memories_confirm`
- Non-interactive hook capture: `orgbrain_memories_capture_rationale`
- Upsert memory: `orgbrain_memories_upsert`
- Enrich task context: `orgbrain_context_enrich`
- Create decision memory: `orgbrain_decision_memories_create`
- Search decision memory: `orgbrain_decision_memories_search`
- Create task: `orgbrain_task_create`
- Get task: `orgbrain_task_get`
- Get events: `orgbrain_task_events`
- Start impact measurement: `orgbrain_memory_impact_start`
- Report impact measurement: `orgbrain_memory_impact_report`

## Initial setup

1. Confirm the endpoint is the Access-protected `open-brain-mcp` `/mcp` URL, not the Console or direct API Gateway URL.
2. For an interactive client, run `orgbrain connector setup <codex|claude|cursor> --mode remote-mcp --url <url>` as a dry run, then repeat with `--execute`. Codex additionally runs `codex mcp login orgbrain`; Claude Code and Cursor start OAuth on first connection. Leave OAuth credentials in the client credential store.
3. For an automatic hook, create a pending installation in the Console and copy its one-time, ten-minute enrollment code. Create a dedicated Cloudflare Access Service Token for this installation.
4. Review `orgbrain connector setup <client> --mode cloud-hooks --url <url> --workspace <path>` first. On `--execute`, enter the service-token Client ID, secret, and enrollment code through the masked TTY prompt or setup-only environment variables.
5. The installer writes a private installation-specific file, never a shared hook credential file:

```dotenv
ORGBRAIN_ENABLE_CLOUD_MEMORY=true
ORGBRAIN_ENABLE_ORG_SHARING=true
ORGBRAIN_MCP_URL=https://<access-protected-mcp-domain>/mcp
ORGBRAIN_MCP_CLIENT_ID=<service-token-client-id>
ORGBRAIN_MCP_CLIENT_SECRET=<service-token-client-secret>
ORGBRAIN_CLIENT_INSTALLATION_ID=<installation-id>
ORGBRAIN_HOOK_OUTBOX=~/.config/org-brain/clients/<installation-id>/outbox.jsonl
ORGBRAIN_TENANT_ID=default
```

   The actual path is `~/.config/org-brain/clients/<installation-id>/credentials.env` with mode `0600`.
6. Keep workspace-to-project routing in `~/.config/org-brain/workspaces.json`; never add repository paths to credential or audit metadata.
7. Verify interactive OAuth with discovery and a read-only call. Verify automatic hooks by calling only the known `orgbrain_memories_capture_rationale` tool; the hook identity must be rejected from every other tool.
8. Never print the client secret or enrollment code. Report only presence, installation ID, client type, and MCP hostname.

## Operational Notes
- OrgBrain master memory is Cloudflare D1.
- The primary remote endpoint implements MCP `2026-07-28` as stateless Streamable HTTP and keeps an ordinary legacy-tool compatibility lane.
- OpenClaw local memory remains cache/index.
- Retrieval impact should be measured primarily with D1 `retrieval_events` and opt-in measurement mode; the final-report impact note is a lightweight self-report for cases where memory avoided another lookup.
- For an eligible measured run, call `orgbrain_memory_impact_start` before retrieval and always call `orgbrain_memory_impact_report` at completion, including `memory_used=false`, `avoided_lookup=none`, or a failed outcome. Reuse stable `external_run_id` and idempotency keys across retries.
- `orgbrain_memories_upsert` remains for compatibility and non-interactive flows, but interactive assistant flows should use propose/confirm.
- For agent preflight, call `orgbrain_context_enrich` with `task.title`, `task.description`, `project_id`, and `task_type`; use returned `decisionContext`, `constraints`, and `knownPitfalls` as guidance, not as a replacement for source verification.
- If MCP returns auth errors, ask for:
  - interactive client: whether its OAuth login is active
  - hook: installation state and whether its private credential fields are present, never their values
  - optional tenant selection
