# OrgBrain remote OAuth client

`orgbrain remote` is an explicit OrgBrain client for one authenticated user,
tenant and project. It adds login, refresh, logout, search and the existing
conversation stage/review/confirm lifecycle. It does not copy a SQLite database,
discover transcripts, synchronize platform conversations, or install hooks.

This change needs a separately reviewed server deployment before live use: it
adds the authenticated `GET /mcp/identity` endpoint and fixes the OAuth direct
MCP transport route. The existing access-policy mirror now records its canonical
memory owner in `memories.owner_principal`, so newly confirmed memories appear in
that owner's `mine` searches. It creates no grant or historical data backfill.
The primary lexical lane includes the existing `conversation-event` tag;
pending proposals still create no memory, and all ordinary ACL/validity filters
remain in place. Without this tag, ordinary keyword search excluded the newly
confirmed conversation memories even after ownership was correct.
No production deployment, new credential issuance, real
user login or private data transfer was performed during implementation.

## Commands and explicit review

Use the canonical HTTPS API Gateway `/mcp` resource. Resolve the tenant, project
and canonical principal from the user's existing identity; never guess them
from a checkout name. Login requires both `orgbrain:read` and `orgbrain:write`.
There is no admin scope option or saved-profile identity override.

```sh
orgbrain remote login --mcp-url https://example.org/mcp \
  --tenant-id <tenant> --project-id <project> --principal-id <principal>
```

The default is a local plan: it creates no profile and makes no network call.
Repeat with `--execute` only in the user's own native terminal. Both stdin and
stderr must be TTYs. The user opens the displayed authorization URL in a browser
that can reach **this host's** loopback. The browser returns directly to the
random-port `127.0.0.1` callback. The client accepts no authorization code or
callback URL through chat, arguments, stdin or files. Do not extract another
client's tokens, browser cookies, Mac Keychain, Personal Vault or Codex store.

```sh
orgbrain remote status
orgbrain remote search 'synthetic'
orgbrain remote stage --input reviewed-summary.json
orgbrain remote stage --input reviewed-summary.json \
  --execute --expected-plan-hash <preview-hash>
orgbrain remote confirmation-status --confirmation-token <receipt-id>
orgbrain remote confirm --input actual-review.json
orgbrain remote refresh
orgbrain remote logout
```

`stage` reads only the explicitly supplied bounded `conversation-memory/v1`
envelope, and checks its tenant/project against the authenticated profile.
Preview returns the existing deterministic plan. Execution requires its unchanged
hash and already cleaned input; it creates pending candidates and zero active
memories. The response contains the review text, candidate hash and revision.
Show the actual review to the user before creating a confirmation input:

```json
{
  "confirmation_token": "<receipt-id>",
  "expected_candidate_hash": "<displayed-candidate-hash>",
  "expected_revision": 1,
  "approved": true,
  "review_answer": "<actual user's answer to this displayed review>"
}
```

This example is a schema, not consent. Never manufacture the answer or treat a
generic upload request as an answer to undisplayed candidates. A changed answer
or content needs the existing revise/new-review workflow; this minimal client
does not implement content correction, cancellation or revision. The server
classifies the actual answer and owns lifecycle, expiry, scope and ACL checks.
After an uncertain stage/confirm result, read status instead of automatically
retrying the mutation. The confirmation identifier is not authorization.

Search fixes `scope=mine`, `strict_project=true`, explicit project and the lexical `memories` mode.
The optional MCP `strict_project` argument applies the existing project read
boundary before search limits; older callers retain their project ranking
contract. This option requires a project and the evidence search lane.
It bounds query/limit and validates the returned tenant/project. It does not
request model inference, all-project results or administrative history lanes.

## Credential lifecycle and boundaries

The dedicated POSIX default is
`~/.config/org-brain/remote/<profile>.json`, directory `0700`, file `0600`,
owned by the current UID. Use `--profile <name>` on each command for another
independently authorized profile. `--remote-directory <private-directory>` is
an explicit user-controlled path; it does not modify HOME or CODEX_HOME. The
initial implementation fails closed on Windows; it does not claim Keychain,
Credential Manager or encrypted-at-rest storage. A plaintext private file is
the current storage backend. Do not put it in Git or shared artifacts.

Symlinks, permissive existing directories/files and nonregular credentials are
rejected. Updates use an exclusive `0600` temporary file, fsync, atomic rename
and directory fsync. An exclusive profile lock serializes operations. Abandoned
locks are not silently expired or removed; recover only after independently
confirming the owning process is gone. Read-only status does not create files.

The client pins the same HTTPS issuer and origin for discovery, registration,
authorization, token, revocation and optional device endpoints. Protected-resource
metadata must name the selected `/mcp` resource and exactly that authorization
server. Token requests include the resource indicator. Public registration uses
`token_endpoint_auth_method=none`; PKCE uses S256, random verifier/state and an
exact callback host/path. State uses constant-time byte comparison; duplicate
state/code and mismatched issuer are rejected. An advertised authorization
response issuer is required. The callback is bounded, one-use and expires.

The new OAuth-only identity endpoint returns authenticated principal, tenant,
explicit project, resource and **effective access-token scopes**, with no-store.
It checks the active user and existing read permission, plus existing write
permission when the token grants write. It creates no new roles or tenant grants.
Existing RBAC tenant roles and fallback-role semantics still apply. Project
pinning is a client request boundary, not a new project-bound OAuth grant.

Refresh persists a token-free `reauthentication_required` tombstone **before**
rotation, requires a different refresh token and checks identity/scopes again.
A crash or uncertain response does not leave a reusable old token on disk. Any
failure requires fresh login; freshly returned invalid credentials are revoked
best-effort. No mutation or old refresh token is automatically replayed. Logout
requests RFC7009 revocation and clears the local file even offline; its
`remote_revoked` flag reports whether that remote request succeeded, not whether
an unreachable server eventually revoked it. Errors/status never return tokens,
codes, verifiers, response bodies or raw transport exception messages. Responses
and explicit input files are bounded; redirects and timeouts fail closed.

## Cloud headless blocker and server requirements

The pinned `@cloudflare/workers-oauth-provider` **0.10.3** supports authorization
code/refresh and RFC7009 revocation at `/oauth/token`. It has no RFC8628 device
grant. A browser on a Mac cannot reach a remote Cloud machine's loopback.
`--mode device --execute` is a standards-based **client** implementation, enabled
only when discovery explicitly advertises the device endpoint and grant. With
the current server it fails before registration or credential issuance. There
is no manual code-exchange workaround, credential transfer or alternate trust path.

To support headless Cloud, a separate server change must provide all of:

1. RFC8628 device authorization endpoint and grant metadata; exact scopes and
   canonical resource enforcement; independently registered public clients.
2. High-entropy device credentials stored as hashes in atomic state, bounded
   user-code attempts/rate limits, short TTL and client/resource binding.
3. A browser verification page behind the existing user-login boundary. Show
   client, resource, user/tenant and exact scopes. GET never approves; consent
   POST requires CSRF/session binding and explicit human consent.
4. Atomic pending/approved/denied/expired/consumed transitions and single-use
   polling redemption, interval/slow_down handling and concurrent poll tests.
5. Issuance through the same provider's token/grant verification path. Its current
   public helpers do not provide device redemption; review a supported provider
   extension/version before implementation. Do not build a parallel token system.
6. Existing user/tenant/project ACL checks, rotation/revocation, expiry and
   secret-free logs; synthetic end-to-end tests followed by separately authorized
   live deployment/authentication.

Another server limitation is independently measured: 0.10.3 accepts its immediately
preceding refresh token, including repeated reuse in the tested sequence. Client
rotation checks/tombstones do **not** fix server replay tolerance. Strict refresh
reuse detection and grant-family revocation need a reviewed server/provider
change with atomic state. No dependency upgrade or live OAuth config change is
included here.

## Verification and primary specifications

Node fixtures verify private storage, PKCE callback validation, rotation,
redaction, unsupported-device failure, RFC8628 polling and CLI dry-run isolation.
The provider integration executes the actual pinned provider source and modern
MCP handlers over synthetic in-memory KV/D1, with an explicit synthetic trusted
authorization helper. Two independent clients stage/review/confirm/read the same
project, another project abstains, and logout of one leaves the other usable.
Downscoped access tokens are rejected from writes even though original grant
props retain wider scopes. A Node shim provides only the provider's
`WorkerEntrypoint` handler type check. This is neither real browser consent nor
native workerd, production D1 or live authentication evidence.

Primary references: [RFC8252](https://www.rfc-editor.org/rfc/rfc8252),
[RFC8628](https://www.rfc-editor.org/rfc/rfc8628),
[RFC9700](https://www.rfc-editor.org/rfc/rfc9700),
[RFC7009](https://www.rfc-editor.org/rfc/rfc7009),
[RFC8707](https://www.rfc-editor.org/rfc/rfc8707),
[RFC8414](https://www.rfc-editor.org/rfc/rfc8414),
[MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization),
and the [provider source](https://github.com/cloudflare/workers-oauth-provider).
The installed 0.10.3 implementation was inspected directly; latest upstream
documentation is not proof of its capabilities.
