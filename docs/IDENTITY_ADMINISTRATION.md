# Identity and organization administration

Tenant remains the provisioning and data-isolation boundary. The Console and
CLI do not create or delete tenants. Migration `0024_identity_organization.sql`
adds a directory around existing principals without rewriting actor, ACL, API
key, MCP, Access, or OIDC bearer history.

## Model and privacy

- New people use opaque `user:<stable-id>` principals. Existing principals are
  preserved.
- `display_name` is required and is the name used in ordinary UI, directory
  search, and decision history.
- `full_name` is optional. Only `/v1/auth/me` and tenant-admin `/v1/users`
  responses include it. `/v1/directory` never includes full name or email.
- `user_identities` links email and OIDC `issuer + subject` identities to a
  stable principal. A verified email may claim an exact pending invitation;
  an unverified OIDC email is never auto-linked.
- `organization_name` remains a compatibility profile field but is no longer
  editable in Profile. Organization settings are canonical.
- Local groups are editable. `source=scim` groups and memberships are read-only
  in shared UI and are populated only by Enterprise.

## Authentication

Email authentication is disabled by default. Configure the organization and an
initial `tenant_admin` through the existing API-key or OIDC path before setting
`EMAIL_AUTH_ENABLED=true`.

The public request endpoint always returns HTTP 202. Codes expire after ten
minutes, are consumed after five failed attempts, and are rate-limited per
email and IP hash with a sixty-second resend interval. Codes and session tokens
are stored only as SHA-256 hashes. The OSS sender posts a timestamped HMAC-
signed payload to an HTTPS webhook; tests use `InMemoryEmailSender`.

Sessions last twelve hours in a `Secure`, `HttpOnly`, `SameSite=Lax`,
`__Host-orgbrain_session` cookie. Cookie mutations require both
`SESSION_ALLOWED_ORIGIN` and the session CSRF token. An administrator can revoke
all tenant sessions with `POST /v1/ops/auth-sessions/revoke-all`.

## Administration surfaces

The Console exposes Login, Profile, Organization, Users, Groups/Group detail,
and Business Categories. Tenant admins can invite, suspend/reactivate, change a
tenant basic role, manage local group membership, and deactivate referenced
business categories. The fixed work-type contract remains:
`implementation`, `review`, `debug`, `proposal`, `support`, `research`,
`operations`, and `other`.

Local SQLite uses schema version 20 and provides matching unauthenticated local
commands: `profile`, `organization`, `user`, `group`, and `category`.

## Rollback

Do not down-migrate identity tables or rewrite historical principals. Disable
email authentication and continue through existing API-key/Access/OIDC paths.
New session state may be retained and revoked; business categories and user
profiles remain additive.
