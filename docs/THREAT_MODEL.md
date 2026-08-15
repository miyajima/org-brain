# Threat model

## Resource connector and provenance threats

- Resource URIs are identifiers, not network authorization. Arbitrary live URL
  fetching is prohibited; connector bindings are fail closed.
- `KNOWLEDGE_RESOURCE_CONNECTORS_JSON` binds connector ids to explicit service
  principals, optional media types, and maximum extracted-text byte sizes.
- Connector adapters must reject embedded credentials, loopback/private/link-
  local destinations, unsafe redirects, oversized responses, unexpected media
  types, and timeouts before snapshot submission.
- Confirmed source links pin immutable version digests and locators. Content
  drift creates stale review work rather than silently moving evidence.
- Cross-tenant Resource, Version, Assertion, and Evidence references are denied
  by tenant-scoped service queries and Enterprise composite foreign keys/RLS.
- Authorization filtering precedes result grouping, counts, and coverage to
  avoid Resource or Decision existence side channels.

## Security objectives

OrgBrain must preserve tenant isolation, memory confidentiality, provenance,
integrity, lifecycle state, and deletion guarantees. A retrieved memory is
untrusted input until its source, authority, validity, and permissions have been
checked.

## Protected assets

- authoritative memory and decision records
- source references, rationale, evidence, and conflict history
- tenant, project, group, and principal authorization data
- API, MCP, OIDC, and service credentials
- backups, exports, indexes, caches, and audit events
- usage/effect attribution, failure-pattern fingerprints, and verification references

## Trust boundaries

Local mode trusts the operating-system account and binds only to loopback.
There is no network authentication in local mode. Cloud mode crosses API/MCP,
Cloudflare Access or API-key authentication, D1, R2, Queue, and Durable Object
boundaries. Identity must come from verified authentication context, never from
an actor or principal supplied in the request body.

## Primary threats and controls

| Threat | Required control |
| --- | --- |
| Cross-tenant access | Tenant grant check on every API and MCP operation; tenant included in all storage keys and queries |
| Body impersonation | Replace body actor fields with the authenticated principal; reject ungranted tenant IDs |
| MCP credential confusion | Put Managed OAuth users and service-token hooks behind Access, validate exact MCP audience/issuer/signature/expiry, and never forward bearer or raw service-token secrets from the thin proxy |
| Inherited hook credential confusion | Treat the explicitly selected installation credential file as authoritative for MCP identity fields and verify its installation ID through the metadata-only status endpoint before first capture |
| Hook over-privilege | Resolve the service subject hash to one active client installation and allow only `orgbrain_memories_capture_rationale`; revocation is per installation |
| Enrollment replay | Store only a SHA-256 enrollment hash, expire it after ten minutes, clear it atomically on activation, and reject reuse or rebinding of an active Access subject |
| Memory poisoning | Proposed state for inferred decisions, provenance, evidence, confidence, conflict review, and input quality filters |
| Prompt injection in memory | Treat content and source text as data, preserve source labels, and never execute retrieved instructions without a policy gate |
| Secret or personal-data capture | Pre-capture redaction and durable-only extraction; raw transcripts are opt-in |
| Unauthorized export or deletion | Separate `export` and `delete` permissions, principal-scoped tokens, and auditable operations |
| Stale or conflicting decisions | Validity windows, lifecycle state, authority scoring, and explicit conflict results |
| Index resurrection after deletion | Delete from FTS, vectors, caches, exports, and edges before acknowledging; retain only a content-free tombstone |
| Backup disclosure | Private file modes, encrypted storage guidance, scoped restore access, and restore verification |
| Audit tampering | Append-only, hash-chained audit records with protected retention |
| Telemetry leakage | Store query hashes and normalized identifiers only; never store raw prompts, queries, or commands in impact telemetry |
| Agent-session leakage | Hooks never read full transcripts or invoke an LLM; prompt, answer, reasoning, tool I/O, transcript path, and absolute paths are excluded from observation and audit metadata |
| Cross-tenant polymorphic reference | Validate source existence and tenant ownership in the service before writing retrieval or usage items |
| Inflated effectiveness claims | Keep evidence levels separate, require attribution weights to total 1.0, retain negative net savings, and sample verification deterministically |
| Availability loss | Verified backups, restore drills, bounded queues, DLQ replay, and documented RPO/RTO |
| Resource SSRF | Fetch-enabled HTTP/Git HTTP registration rejects credentials and loopback/private/link-local IP literals; connectors must repeat resolved-address and redirect-hop checks and enforce size, media type, and timeout limits |

## Local-mode controls in 0.1

- Node-bundled SQLite; no shell interpolation or external `sqlite3` process
- `0700` database and backup directories on POSIX
- `0600` database, WAL, SHM, and backup files on POSIX
- WAL, synchronous full writes, schema versioning, `quick_check`, SHA-256 content
  hashes, immutable version snapshots, verified backup/restore, and FTS rebuild
- loopback-only HTTP serving and no external network requests
- hard delete removes authoritative records, versions, edges, and FTS rows while
  retaining only a content-free tombstone
- privacy purge removes source-linked usage items, effect attributions, and
  rebuildable daily metrics without storing raw prompt/query/command bodies

## Implemented organization controls

- generic RS256 OIDC and Cloudflare Access verification with exact issuer and
  audience checks
- MCP-specific Access audience validation separated from API/OIDC configuration,
  installation-scoped service identities, one-time enrollment, and per-client revocation
- offline hook capture uses private installation-specific outboxes and never
  blocks the host AI client; unresolved identity is retained locally and is not uploaded
- outbox flushes claim rows atomically under an installation-scoped lock, and
  unresolved rows require a metadata-only same-installation status check before
  their memory payload can be retried
- a suspended or deprovisioned owner cannot continue using an otherwise-active
  service-token installation
- active scoped-token issuance, project/permission restriction, rotation,
  revocation, expiration, and hash-only storage
- retention dry-runs, explicit execution, and tenant/project legal holds that
  block hard deletion
- vector projection updates and deletion propagation when Workers AI and
  Vectorize bindings are configured
- hash-chained outcome auditing for HTTP and mutating MCP operations
- deterministic durable-memory extraction with common secret, email, and phone
  redaction plus prompt-injection rejection

Local SQLite restore drills run weekly in CI and publish counts, version counts,
content digests, and observed RPO/RTO as an artifact.

## Required adversarial regression suite

The release gate maps each required attack class to an executable regression:

| Attack class | Expected result | Regression evidence |
| --- | --- | --- |
| Prompt injection | unsafe instruction is excluded before candidate creation | `packages/shared/test/memory-extractor.test.ts` |
| Memory poisoning | plausible untrusted policy remains a sourced `proposed` candidate and is not persisted by the extractor | `packages/shared/test/memory-extractor.test.ts` |
| Privilege escalation | an assigned lower role overrides a more powerful fallback and cannot escape project scope | `apps/api-gateway/test/rbac-audit.test.ts` |
| Body impersonation | body `user_id`/actor fields cannot replace the authenticated principal | `apps/api-gateway/test/context-engine-service.test.ts` |

The cross-tenant and permission benchmark additionally requires zero forbidden
records across five independent retrieval attempts.

## Known gaps before organization-grade 1.0

- successful scheduled staging D1 drill artifacts and production RPO/RTO evidence
- complete adversarial poisoning, multilingual PII, and redaction evaluation
- OIDC algorithms other than RS256 and external KMS-managed application-layer
  encryption

These gaps must remain visible in release notes and must not be represented as
implemented security guarantees.
