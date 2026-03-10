# OrgBrain Remote MCP

## Architecture
- Endpoint: `https://<api-gateway-domain>/mcp`
- Host Worker: `apps/api-gateway` (`/mcp` is mounted in the same Worker)
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
cd /Users/miya/projects/org-brain
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
- [skills/org-brain-mcp/SKILL.md](/Users/miya/projects/org-brain/skills/org-brain-mcp/SKILL.md)
