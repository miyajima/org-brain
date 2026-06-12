# OrgBrain Remote MCP

## Architecture
- Endpoint: `https://<api-gateway-domain>/mcp`
- Host Worker: `apps/api-gateway` (`/mcp` is mounted in the same Worker)
- Compatibility Worker: `apps/mcp` is retained only for legacy deployments that need an `API` service binding proxy.
- Auth: Worker-validated service tokens via `CF-Access-Client-Id` / `CF-Access-Client-Secret`
- Tenant control: per-token `tenants` plus optional `MCP_TENANT_POLICY_JSON`

## Why this shape
- No extra `mcp -> api-gateway` hop
- Access handles identity/session
- Worker enforces tenant-level authorization

## Required Worker Settings
Set on `apps/api-gateway`:
- `MCP_SERVICE_TOKENS_JSON` (JSON)
- optional `MCP_TENANT_POLICY_JSON` (JSON)

Example service token config:
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

Optional policy:
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

## Deploy
```bash
cd <repo-root>
pnpm install

# set secrets/vars for api-gateway
cd apps/api-gateway
pnpm wrangler secret put MCP_SERVICE_TOKENS_JSON
pnpm wrangler secret put MCP_TENANT_POLICY_JSON
pnpm wrangler deploy
```

## Auth Configuration
1. Generate a service token pair for your MCP client.
2. Store it in `MCP_SERVICE_TOKENS_JSON`.
3. Configure the MCP client to send the same headers.
4. If you later want interactive browser login, add Cloudflare Access in front of the MCP hostname and extend the Worker with Access JWT verification.

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
### Cursor (`.cursor/mcp.json`) with service token
```json
{
  "mcpServers": {
    "orgbrain": {
      "url": "https://open-brain-api-gateway.<account>.workers.dev/mcp",
      "headers": {
        "CF-Access-Client-Id": "<service-token-client-id>",
        "CF-Access-Client-Secret": "<service-token-client-secret>",
        "x-orgbrain-tenant": "default"
      }
    }
  }
}
```

### Human user flow
- This deployment defaults to service-token auth.
- Optionally include `x-orgbrain-tenant` for explicit tenant selection.
- Browser-based login can be added later by placing Cloudflare Access in front of the endpoint and wiring JWT verification.

## Skill
- `skills/org-brain-mcp/SKILL.md`

## Preflight Tools
Use these tools before implementation/review/debug work when shared org context may matter:

- `orgbrain_context_enrich`: returns decision context, constraints, known pitfalls, conflicts, and next actions for a task.
- `orgbrain_decision_memories_search`: searches decision-grade context directly.
- `orgbrain_decision_memories_create`: records a durable decision memory when an operator has confirmed the decision.

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
