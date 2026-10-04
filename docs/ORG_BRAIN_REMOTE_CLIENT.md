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
Existing RBAC tenant roles and fallback-role semantics still apply. Device grants
also pin the project on the server. Ordinary native authorization-code grants
retain the client profile boundary and existing server ACLs.

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

## Opt-in device server and strict refresh families

Compared with client commit `97494e3`, the server now adds RFC8628 discovery,
public device registration, authorization, browser consent, polling and redemption.
`--mode device --execute` displays a verification URI and short user code in the
user's native terminal. The browser may run on another machine; no Cloud loopback,
manual authorization-code exchange or credential transfer is involved.

The source flag `ORGBRAIN_OAUTH_SECURITY_V2` remains **false** in all three Wrangler
profiles. This is an explicit **public-client** mode with `token_endpoint_auth_method=none`
and read/write scopes. Confidential registration, consent and refresh are rejected
when enabled; the metadata advertises only public authentication. Existing deployments
using confidential or other-scope clients must not enable it without a separate
compatibility design. Default-off legacy native-client behavior stays available.
No SDK upgrade, new role, shared principal, real credential or live configuration
change is included.

Apply additive migration `0048_oauth_device_security.sql` before separately enabling
the flag. Cutover requires fresh V2 consent: old refresh tokens and authorization
codes without the V2 marker are rejected while enabled. Existing V2 grant families
keep their durable access/refresh/revocation checks when the flag is later disabled.
Device client registration remains marked in the SDK and cannot enter public
native auth-code issuance or exchange, even after disabling the flag. Flag-off native
reauthorization durably revokes earlier matching V2 families before SDK revocation,
so stale KV and in-flight refresh cannot revive them. The additive tables must remain
available while any marked V2 credential could still be valid; removing the flag is
not permission to drop security state.

`POST /oauth/device` requires explicit tenant, project and canonical principal,
exact read/write scopes and the canonical resource. Device credentials contain
256 random bits; the eight-symbol base32 user code has 40 random bits. Only hashes
are stored. Requests expire after ten minutes. Polling starts at five seconds;
early polls increase the interval by five seconds, including all subsequent polls.
Atomic state/version transitions enforce pending, denied, expired and one-use
redemption. A crash after consumption requires new authorization.

The verification page is `/oauth/authorize/device`, within the existing
Access-protected `/oauth/authorize*` login boundary. It verifies the actual Access
user assertion and registered active OrgBrain identity, never a service token.
It displays client, resource, principal, tenant, project, scopes and the matching
user code. GET never approves. Same-origin POST needs the bound one-use CSRF nonce,
secure cookie and explicit confirmation checkbox. CSP denies framing and external
form actions. Authorization and redemption both check existing project permissions.
The global principal/IP attempt budgets include unknown user-code guesses; device
registration, authorization and polling are also bounded. The existing platform
limiter and D1 are required and fail closed, independently of other fail-open flags.

Device grants permit only search, conversation stage, confirm/status and basic MCP
discovery. Search requires the exact project, `strict_project=true` and the evidence
lane; staging checks the envelope project, and confirm/status resolve the project
from the authoritative confirmation receipt. The identity endpoint has the same
project check. Existing user activity, scopes and ACLs remain mandatory. These
checks apply on the server even if a caller bypasses the dedicated client.

The pinned `@cloudflare/workers-oauth-provider` **0.10.3** has no device grant handler.
The adapter composes its exported `getOAuthApi`, client registration and
`completeAuthorization` helpers: only after durable consent/consumption, it creates
an internal S256 PKCE authorization code and exchanges it directly through the
actual SDK token endpoint. The internal code/verifier are never displayed, persisted
in the D1 device row or accepted from a public caller. The SDK still encrypts grants,
issues bearer tokens and verifies their cryptography; no parallel token system or
private SDK API is used.

The SDK accepts its previous refresh token; a strongly consistent D1 ledger now
closes that allowance for V2 families. It registers hashes before returning issued
tokens, atomically consumes each refresh hash before SDK rotation, and revokes the
family on a known used-hash replay. Full-token hashes identify a replay; unverified
prefixes can only cause denial, never family mutation. Replacement hashes are
inserted only while the family remains active. The partial unique index permits
one active refresh hash per family; a competing
native auth-code exchange fails closed and revokes the conflicting family.
Protected requests check SDK-verified user/grant/client and immutable
tenant/principal/project bindings against D1, including
active user status. Revocation remains authoritative even if KV is stale or a
concurrent SDK operation writes the old grant back. Uncertain rotation/storage
failures require fresh authorization. Normal D1 binding reads use the primary;
this security lane must not be changed to unconstrained replica reads.

Used refresh hashes and family denial rows are retained for at least their full
30-day family lifetime; they must not be discarded while replay remains possible.
Device expiry and attempt windows are logical validity bounds. This change installs
no cleanup cron or production retention mutation; operators must separately plan
expired-state cleanup without shortening security retention.

## Verification and primary specifications

Node fixtures verify private storage, PKCE callback validation, rotation,
redaction, unsupported-device failure, RFC8628 polling and CLI dry-run isolation.
The provider integration executes the actual pinned provider source and modern
MCP handlers over synthetic in-memory KV/D1, with an explicit synthetic trusted
authorization helper for the older native-flow fixtures. The new device tests use
signed synthetic Access JWTs and the actual verification GET/POST, public DCR,
SDK exchange and two independent headless JS clients. They stage/review/confirm/read
the same project, reject direct escapes to another project, refresh and log out
one client while the other remains usable. Tests also cover consent/expiry/rate
limits, concurrent redemption, refresh/replay and reauthorization races, stale KV,
storage failure and flag transitions.
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
