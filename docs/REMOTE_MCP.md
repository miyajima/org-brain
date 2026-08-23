# OrgBrain Remote MCP

## Architecture
- Endpoint: `ORGBRAIN_MCP_URL=https://mcp.<managed-domain>/mcp`
- Public edge: `apps/mcp`, protected by a Cloudflare Access self-hosted application on `/mcp*`
- Internal execution: `apps/api-gateway`, reached only through the `API` service binding
- Interactive auth: Cloudflare Access Managed OAuth (CIMD/DCR and PKCE)
- Unattended hooks: an explicit Access service token bound to a one-time OrgBrain client enrollment
- Tenant control: the Gateway verifies the Access JWT audience, resolves an existing identity or installation, and then applies tenant/project RBAC
- Protocol: MCP `2026-07-28` stateless Streamable HTTP, with stateless compatibility for ordinary 2025 clients

## Why this shape
- Access owns the OAuth challenge and discovery documents; OrgBrain stores no OAuth token.
- The public MCP hostname is independent from Console and never uses `/api` or `/api/mcp`.
- The edge forwards only the signed Access assertion and bounded MCP protocol headers.
- The Gateway remains the single authorization, tenant isolation, audit, and tool-execution boundary.
- No MCP protocol session or sticky routing is required for business state.

## MCP 2026-07-28

The primary endpoint uses Cloudflare Agents `createMcpHandler` and
`@modelcontextprotocol/server` v2. Each request carries its protocol version,
client identity, and capabilities. Modern requests do not send or receive
`Mcp-Session-Id`.

Required modern HTTP headers are preserved end-to-end:

- `MCP-Protocol-Version: 2026-07-28`
- `Mcp-Method`
- `Mcp-Name` for named tool operations

The handler also accepts ordinary legacy tool calls through its stateless
compatibility lane. Legacy session replay, standalone GET streams, and pushed
server-to-client requests are intentionally unsupported because OrgBrain tools
keep business state in D1 rather than MCP transport sessions.

## Required Worker Settings
Set on `apps/api-gateway`:

- `MCP_AUTH_MODE=access`
- `ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com`
- `MCP_ACCESS_AUD=<Access application audience>`
- the existing D1 and rate-limiter bindings

`cf provision --with-managed-oauth` writes only the Access audience as a Worker
secret after the Access application exists. It requires an existing
`--access-policy-id`; it does not create an allow-all policy.

For the one-release migration window only, `MCP_AUTH_MODE=dual` can retain the
legacy static-token configuration below. New installations must use Access;
after OAuth and hook migration is verified, set `MCP_AUTH_MODE=access` and
remove these legacy secrets.

```json
{
  "tokens": [
    {
      "client_id": "orgbrain-openclaw-xxxx",
      "client_secret": "replace-me",
      "principal": "service:openclaw-orgbrain",
      "tenants": ["default"]
    }
  ]
}
```

Legacy tenant policy:
```json
{
  "principals": {
    "alice@example.com": ["default", "team-a"],
    "service:8f5c...": ["default"],
    "*": ["default"]
  },
  "default_tenants": ["default"]
}
```

## Provision and deploy
```bash
pnpm exec orgbrain cf provision --root . \
  --with-managed-oauth \
  --mcp-host mcp.example.com \
  --access-policy-id <reviewed-policy-id>

# Review the plan, then repeat with --execute.
pnpm exec orgbrain cf doctor --root . --live \
  --mcp-url https://mcp.example.com/mcp
```

## Auth Configuration
1. Create a least-privilege Access policy and record its ID.
2. Provision the `/mcp*` self-hosted application with Managed OAuth enabled.
3. Run `codex mcp login orgbrain` for an existing OrgBrain user. Access handles
   the 401 challenge, protected-resource discovery, authorization-server
   discovery, DCR/CIMD, and PKCE.
4. For a cloud hook, create one client enrollment in Console and use a separate
   Access service token. Revoke the Access setup token after initial setup.

## API Key Principal Identity
For `/v1/*` and `/api/*` HTTP APIs, `API_TENANT_POLICY_JSON` `principal` values are the canonical identity for API-key authenticated requests.

- Use stable principal strings such as `user:alice@example.com`, `team:platform`, or `service:openclaw-orgbrain`.
- Issue separate API keys per user, team, or service when memory ownership must be distinguishable.
- If multiple people share one API key, Org Brain can only attribute writes and restricted reads to that shared key principal.
- API-key routes store normal memory writes with `actor_type="principal"` and `actor_id=<principal>`, ignoring caller-supplied actor fields.
- Decision memory restricted reads are evaluated against the authenticated principal, not caller-supplied `user_id` values.

Example API key tenant policy:
```json
{
  "keys": [
    {
      "api_key": "replace-me",
      "principal": "user:alice@example.com",
      "tenants": ["default", "team-a"]
    }
  ]
}
```

## Login Identity And Groups
HTTP APIs also accept Cloudflare Access login identity through `cf-access-jwt-assertion`.

Required settings for login auth:
- `ACCESS_TEAM_DOMAIN`
- `ACCESS_AUD`
- optional `ACCESS_TENANT_POLICY_JSON`

Login principals use the stable Access subject:
```text
user:<cloudflare-access-sub>
```

Example login tenant policy:
```json
{
  "principals": {
    "user:access-sub-123": ["default"]
  },
  "email_domains": {
    "example.com": ["default"]
  },
  "default_tenants": ["default"]
}
```

User profile fields such as display name, company name, and organization name are display metadata only. They do not grant tenant, group, or resource access.

Groups are tenant-scoped arbitrary collaboration units. A group can represent a project, customer, cross-company effort, department, guild, or any other sharing boundary. Group membership is independent from company and organization display fields.

Initial group sharing applies to:
- decision memories
- knowledge docs

Raw/episodic memories are not group-published in this phase.

## Client Configuration
### Interactive client
```json
{
  "mcpServers": {
    "orgbrain": {
      "url": "https://mcp.example.com/mcp"
    }
  }
}
```

### Human user flow
- Browser-based login through Cloudflare Access Managed OAuth is the default.
- Optionally include `x-orgbrain-tenant` for explicit tenant selection; the
  Gateway rejects tenants not present in the verified identity grant.
- The user must already exist in OrgBrain; MCP login does not JIT-create an identity.

## Skill
- `skills/org-brain-mcp/SKILL.md`

The skill also contains the initial setup and verification workflow. Use it to
configure the remote endpoint and the deterministic lifecycle hook without
introducing a second local source of truth.

## Lifecycle hook over MCP

`hook-memory-bridge` can call the known
`orgbrain_memories_capture_rationale` tool directly. It does not call
`server/discover`, fetch the tool catalog, or invoke an LLM, so automatic
capture adds no model tokens.

```dotenv
ORGBRAIN_ENABLE_CLOUD_MEMORY=true
ORGBRAIN_ENABLE_ORG_SHARING=true
ORGBRAIN_MCP_URL=https://mcp.<managed-domain>/mcp
ORGBRAIN_MCP_CLIENT_ID=<service-token-client-id>
ORGBRAIN_MCP_CLIENT_SECRET=<service-token-client-secret>
ORGBRAIN_TENANT_ID=default
```

If no `ORGBRAIN_MCP_*` variable is present, the bridge retains the legacy REST
API-key path for compatibility. A partially configured MCP credential set
fails closed and does not silently fall back to REST.

## Preflight Tools
Use these tools before implementation/review/debug work when shared org context may matter:

- `orgbrain_context_enrich`: returns decision context, constraints, known pitfalls, conflicts, and next actions for a task.
- `orgbrain_decision_memories_search`: searches decision-grade context directly.
- `orgbrain_decision_memories_create`: records a durable decision memory when an operator has confirmed the decision.

## Agent Message Tools
Use these tools for agmsg-style agent inbox workflows:

- `orgbrain_messages_send`: send a durable message to `principal`, `agent`, `project`, or `channel`.
- `orgbrain_messages_inbox`: list active inbox messages; without a target it reads the authenticated MCP principal inbox.
- `orgbrain_messages_get`: fetch a single message for the requested or default target.
- `orgbrain_messages_read`: mark a message as read.
- `orgbrain_messages_ack`: acknowledge a message.

Example send input:

```json
{
  "tenant_id": "default",
  "project_id": "org-brain",
  "target_type": "agent",
  "target_key": "codex",
  "subject": "Review needed",
  "body": "Please check the latest implementation plan.",
  "idempotency_key": "review-needed-2026-07-08"
}
```

Example `orgbrain_context_enrich` input:

```json
{
  "tenant_id": "default",
  "project_id": "org-brain",
  "task_type": "implementation",
  "task": {
    "title": "Add memory sharing preflight",
    "description": "Expose shared decision context through MCP",
    "target_files": ["apps/api-gateway/src/mcp.ts"]
  }
}
```
