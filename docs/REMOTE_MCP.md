# OrgBrain Remote MCP

## Architecture
- Endpoint: `ORGBRAIN_MCP_URL=https://mcp.<managed-domain>/mcp`
- Interactive public edge and execution: `apps/api-gateway`, routed directly on the canonical MCP hostname
- Hook migration edge: `apps/mcp`, a separate Access-protected proxy to the API service binding
- Interactive auth: OrgBrain's MCP OAuth provider (CIMD/DCR, authorization code, PKCE), with Cloudflare Access as the upstream user login
- Unattended hooks during migration: an explicit Access service token bound to a one-time OrgBrain client enrollment on the separate hook edge
- Tenant control: OAuth authorization stores the Access-authenticated principal and granted scopes; each tool call then applies tenant/project RBAC. Hook calls resolve their existing installation identity separately.
- Protocol: MCP `2026-07-28` stateless Streamable HTTP; the Remote endpoint rejects older protocol eras

## Why this shape
- The MCP OAuth provider owns resource/authorization discovery and keeps OAuth state in the dedicated `OAUTH_KV`; OrgBrain's business database stores no OAuth token.
- The public MCP hostname is independent from Console and never uses `/api` or `/api/mcp`.
- OAuth bearer tokens terminate at API Gateway; they are not forwarded through the Access hook proxy.
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

The handler is configured with `legacy: "reject"`; it does not silently
downgrade. A client without MCP `2026-07-28` support must use the explicit
local `2025-11-25` compatibility command with a required deadline of at most
90 days. Legacy session replay, standalone GET streams, and pushed
server-to-client requests are not part of the Remote product profile because
OrgBrain tools keep business state in D1 rather than MCP transport sessions.

## Required Worker Settings
Set on `apps/api-gateway` for the OAuth-only target:

- `MCP_AUTH_MODE=oauth`
- `ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com`
- `MCP_ACCESS_AUD=<Access application audience used for upstream user login>`
- `MCP_HOOK_ACCESS_AUD=<separate hook Service Auth application audience>`
- `MCP_OAUTH_RESOURCE=https://mcp.<managed-domain>/mcp`
- `OAUTH_KV=<dedicated KV namespace binding>`
- the existing D1 and rate-limiter bindings

`cf provision --with-managed-oauth` routes API Gateway on the canonical hostname,
routes the thin hook worker on a distinct hook hostname, and uses one
user Access application for `/oauth/authorize*` plus a separate Service Auth
application for that hook hostname. Before
`--execute`, `apps/api-gateway/wrangler.toml` must already contain the dedicated
`OAUTH_KV` binding and the exact `MCP_OAUTH_RESOURCE`; otherwise provisioning
stops before any Cloudflare mutation. It does not create an allow-all policy.

During migration, `MCP_AUTH_MODE=dual` keeps existing Access service-token hooks
working while interactive clients move to OAuth. Do not switch to `oauth` until
every unattended hook has an approved OAuth-capable replacement or has been
retired; OAuth-only mode intentionally rejects the old hook credential path.
The older static-token configuration below is a separate auth migration path,
not MCP protocol compatibility.

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
  --hook-host hooks.example.com \
  --access-policy-id <reviewed-user-policy-id> \
  --hook-access-policy-id <reviewed-service-auth-policy-id>

# Review the plan, then repeat with --execute.
pnpm exec orgbrain cf doctor --root . --live \
  --mcp-url https://mcp.example.com/mcp \
  --hook-url https://hooks.example.com/mcp
```

## Auth Configuration
1. Create a least-privilege Access policy and record its ID.
2. Provision a user Access application covering only
   `mcp.example.com/oauth/authorize*` and a distinct Service Auth application
   covering `hooks.example.com/*`. They use separate audiences and policies.
   The provisioner detects and migrates the legacy `mcp.example.com/mcp*`
   application to the hook hostname rather than leaving overlapping Access
   protection on the OAuth resource endpoint.
3. Run `codex mcp login orgbrain` for an existing OrgBrain user. The MCP OAuth
   provider handles the 401 challenge, protected-resource discovery,
   authorization-server discovery, DCR/CIMD, and PKCE; Access authenticates the
   browser only at the authorization endpoint.
4. For a cloud hook, create one client enrollment in Console and configure
   `https://hooks.example.com/mcp` with a separate Access service token. Revoke
   the Access setup token after initial setup.

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
- The client's MCP OAuth flow is the default. The API Gateway owns OAuth
  discovery, registration, authorization-code/PKCE exchange, and bearer-token
  validation; Cloudflare Access protects only the upstream browser login at
  `/oauth/authorize*`.
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
