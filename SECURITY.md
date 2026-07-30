# Security Policy

## Supported Versions

Org Brain is pre-1.0. Security fixes are tracked for the current `0.x` release line.

## Reporting a Vulnerability

Please do not open public issues for vulnerabilities. Report security concerns privately to the project maintainers. Include:

- affected component or command
- reproduction steps
- expected and actual behavior
- any relevant logs with secrets removed

## Secrets and Tenant Data

Never include these in issues, pull requests, benchmark files, or examples:

- API keys, Cloudflare tokens, service tokens, client secrets, or cookies
- customer, tenant, or organization exports
- production D1/R2 identifiers tied to the official managed service
- private MCP credentials

Use `.env.example` and `.dev.vars.example` for configuration shape only.

## API Key Identity

For API-key authenticated endpoints, `API_TENANT_POLICY_JSON` `principal` values are treated as the canonical request identity. Use separate API keys for users, teams, and services when memory ownership or restricted memory access must be distinguishable. A shared API key is attributed only to that shared principal.

Cloudflare Access and generic OIDC login identity use the verified JWT subject
as `user:<sub>`. Generic OIDC is restricted to RS256, an exact HTTPS issuer,
configured audience, and trusted JWKS. Email, company name, and organization
name are profile/display metadata only and must not be used for authorization.
Resource sharing should use principals, tenant-scoped groups, or tenant-wide visibility.

## Roles and permissions

Organization mode uses fixed roles: `tenant_admin`, `project_owner`,
`contributor`, `reader`, `service_agent`, and `auditor`. Authorization checks
separate `read`, `write`, `share`, `admin`, `delete`, and `export`. Project
owners are valid only for an explicit project scope. API and Remote MCP
operations both pass through this role/permission check after tenant grant
validation.

Mutating API requests append a content-free audit event containing the
authenticated principal, tenant/project, operation, resource, outcome, request
identifier, permission, and status. Audit entries form a SHA-256 chain that can
be checked with `GET /v1/audit-events/verify`.

Scoped `obp_` tokens are stored only as SHA-256 hashes, have mandatory expiry,
and are checked against tenant, optional project, and explicit permissions on
every request. Retention policies dry-run by default; matching legal holds
block hard deletion. Local restores reapply deletion tombstones so older
backups cannot resurrect intentionally deleted memories.

## Self-hosting Notes

Self-hosters are responsible for their own Cloudflare account security, access controls, backups, logging, and tenant policies. The managed SaaS offering provides those operations as a paid service.
