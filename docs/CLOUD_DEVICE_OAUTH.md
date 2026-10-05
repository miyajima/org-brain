# Headless Cloud device OAuth (draft)

OrgBrain's new `remote` namespace works without a Mac, inbound callback, managed Codex credential changes, or an environment access token. A mobile browser authenticates the user with the existing Cloudflare Access user policy and explicitly approves one tenant/project. Each Cloud obtains its own opaque credentials by RFC 8628 polling. Never copy codes, access tokens, or refresh tokens into chat.

## Approval record for each Cloud

Before issuing credentials, record the following separately for Cloud A and Cloud B:

| Item | Required choice |
| --- | --- |
| Account | Same authenticated Access user; do not substitute an agent/service principal |
| Resource | Exact canonical HTTPS API Gateway `/mcp` URL, without query or fragment |
| Client | `orgbrain-cloud-cli` (public client; no client secret) |
| Tenant/project | Explicit, existing authorized tenant and project IDs, identical for both Clouds; never inferred from a directory |
| Scope | `orgbrain:read orgbrain:write`; private (`mine`) project search and propose/confirm/status only; no admin/share/attest/export |
| Storage | An approved absolute private directory outside the Git checkout and `CODEX_HOME`; for example `/workspace/orgbrain-private/cloud-a/remote` and `/workspace/orgbrain-private/cloud-b/remote` in their respective environments |
| Mode | Directory `0700`, credential file `0600`, no symlinks, atomic replacement and exclusive lock; protect backups and snapshots as credentials |
| Expiry | Device request and device access token: 10 minutes. Refresh family: fixed 30 days from approval, not extended by rotation |
| Revocation | `remote logout` revokes the entire family in D1 and deletes that Cloud's file only after successful revocation. Replay revokes every access/refresh in that family immediately |
| Rollout | Apply migration `0048_device_oauth.sql` first; configure the resource and existing Access identity policy; protect `/oauth/device/verify` with the user Access app; explicitly enable `ORGBRAIN_DEVICE_OAUTH_ENABLED=true` in `dual`/`oauth` mode only after review |

All source configurations keep the flag false. No real credentials, DB changes, deploys, or memory imports are part of this draft. The new flag enables public start/poll endpoints and sensitive mobile consent: verify routing, user policy, scopes, D1 availability and rate limiting before enabling. Disabling the flag immediately blocks device bearer/refresh/revocation operations; revoke live families before disabling when possible. Existing KV OAuth and hook credentials remain separate.

D1 is authoritative for verified Access issuer/subject/email identity bindings and hashed device/user/access/refresh secrets, consent CSRF/owner/expiry, polling interval, token family, and replay tombstones. Every credential read uses a `first-primary` session when the runtime supports it. Transactions and conditional claims ensure one device exchange and one refresh winner. Concurrent refresh losers revoke the family. Before device exchange, bearer acceptance and refresh, primary D1 rechecks the registered identity, active profile, current tenant policy and project permissions. Loss of identity, suspension/deprovisioning or grant/role revocation rejects the request and revokes an issued family. Strict allowedProjectId filtering excludes both foreign-project and project-null memories in private search. KV contents cannot resurrect a device credential. The scheduled cleanup retains refresh tombstones until the family's expiry.

The existing `@cloudflare/workers-oauth-provider@0.10.3` still accepts its previous refresh-token ID. This draft deliberately bypasses that provider for device credentials; it does **not** claim to harden existing browser OAuth families. Do not use old KV OAuth credentials as the security proof for this rollout.

## Commands after approval (placeholders, not executed)

Use these commands independently in each Cloud. Replace IDs and the canonical URL with approved values. Set `--credential-dir` to that Cloud's approved private directory. No `CODEX_HOME` change is needed.

```sh
orgbrain remote login --mcp-url https://approved.example/mcp --tenant-id approved-tenant --project-id approved-project --credential-dir /workspace/orgbrain-private/cloud-a/remote
orgbrain remote status --mcp-url https://approved.example/mcp --tenant-id approved-tenant --project-id approved-project --credential-dir /workspace/orgbrain-private/cloud-a/remote
orgbrain remote search 'reviewed decision' --mcp-url https://approved.example/mcp --tenant-id approved-tenant --project-id approved-project --credential-dir /workspace/orgbrain-private/cloud-a/remote
```

Login displays the complete verification URL in the Cloud terminal. The bare verification URI also offers manual code entry. Open it on mobile, check the client, code, tenant/project and requested permissions, and approve only the session you started. The client polls at least every five seconds, adds five seconds permanently on `slow_down`, backs off on timeouts, and stops on denial/expiry/other failures.

`remote propose --input <reviewed-json-file>` uses `{ "source": "manual", "item": { "content": "..." } }`; it creates a pending candidate. The server binds actor identity and the selected project. Show the returned conclusion and reason to the user before confirmation. `remote confirmation-status --input <json-file>` takes `{ "confirmation_token": "..." }`. `remote confirm --input <json-file>` requires an explicit `approved` boolean and should include the user's `review_answer` and, for managed candidates, `expected_candidate_hash` and `expected_revision`. None of these commands fabricate human review. Staged/pending memories are not active until the explicit review decision succeeds.

`remote refresh` rotates both tokens; ordinary memory calls refresh near access expiry. A lost/ambiguous refresh response quarantines the local credential before transmission, so it cannot be retried automatically with the old token. Run logout and obtain a fresh approved login. Concurrent operations fail with `credential_operation_in_progress`. Status reports active, refresh_required, quarantined, expired or missing without printing credentials. A crashed operation may leave a lock directory: an operator must ensure the process has stopped before removing that lock; there is no automatic lock stealing.

## Specification and verification basis

- [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628), sections 3.2/3.5/5: device authorization, terminal errors, slowdown/backoff, expiry and brute-force resistance.
- [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700), section 4.14: public-client refresh rotation and family revocation on replay.
- [Cloudflare D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch): conditional updates/inserts in transactional batches.
- [Cloudflare D1 sessions](https://developers.cloudflare.com/d1/worker-api/d1-database/#withsession): primary reads for security state.

Synthetic tests cover two distinct Cloud token families sharing the same reviewed memory over actual MCP transport, tenant/project/user isolation, pending-before-confirm behavior, CSRF/origin/user binding, expiry/denial, persistent slowdown, concurrent consent/device exchange/refresh, replay family revocation, hashed rate limits, stale KV isolation, D1 outages, scope/tool allowlists, redacted errors and safe local credential storage. Access JWT cryptographic verification remains covered by the existing MCP security tests; the device consent test substitutes a synthetic authenticated identity. Live Access routing and production D1 behavior require a separately approved canary. The initial independent review identified missing identity lifecycle checks, incomplete search project filtering and the manual code-entry route; these were corrected and regression-tested. Final independent review results are recorded with the release evidence. An approved live canary is still required before enabling the flag.
