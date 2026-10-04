# Local / Cloud memory parity

This branch ports bounded memory contracts from main
`f7dcb58c5ee50cf4b9a3730fc0a27f3b695711bf` to Cloudflare code. It does not
deploy, migrate a real database, change authentication or replace a Mac runtime.
All verification inputs are synthetic. A caller-supplied conversation summary
is not automatic synchronization with dot, a native session or another platform.

| Area | Local main | Cloud after this change | Remaining difference |
| --- | --- | --- | --- |
| Storage | SQLite, schema 31, private workspace mapping | Existing D1 memories/reviews plus additive migrations 0046–0047 | No database copy or bidirectional replication |
| Review text | Original and NFKC screening; valid ISO dates and canonical dated repo references preserved | Shared normalization preserves fields, UUID spans, hashes and supplied roles; Cloud's existing instruction/secret screen also remains mandatory | Cloud additionally rejects text that its legacy screen would redact; this is not universal acceptance parity |
| Conversation capture | Explicit bounded file adapter, hash preview, pending proposals | Shared planner plus `orgbrain_conversation_memories_stage`; principal/project/tenant-bound, deterministic pending deduplication | No native transcript discovery; source excerpts and supplied tool outcomes stay unverified |
| Human review | Actual answer required before propose/confirm saves | Actual-answer confirm/status plus explicit atomic revision/cancel; new conversation confirmations require displayed hash/revision | Stage and CLI import do not approve or activate a memory |
| Search | Deterministic full-subject lexical task query; unknown subjects mandatory | Existing hybrid_v4 base retained; explicit task questions receive the shared lexical coverage gate, after use-history packing and before returned usage receipts | Narrow questions/instructions plus literal resume with explicit project/task/subject context; explicit generation, entity/decision filters, history and suppressed-record queries retain their existing contracts |
| QA | Public shared decision/search contracts plus separate local features | Existing Cloud decision/context functions remain available | Uncommitted private Mac QA implementation was not supplied; no claim of reproducing it |
| Retrieval receipts | Returned/injected item, source/version, explicit purpose | Existing Cloud usage event/item/version/purpose recording; new task lane records the final delivered result set | Returned tool JSON alone does not prove native delivery |
| Use observations | Scoped opaque receipt, then bounded trusted local transcript verification | Optional private opaque acknowledgement bound to authenticated principal/project/task/item and accessible current memory version | No trusted Cloud transcript collector or cross-turn delivery verifier; decision-memory observation receipt issuance is not ported |
| Effect/ranking | Evidence-backed, separately enabled | Existing trusted task-event/attestation resolvers remain unchanged; new acknowledgement is never accepted as verified-use evidence | No verified benefit, live token saving or automatic usefulness rating established |
| CLI transport | Explicit local backend remains the default | `memory import conversation --backend remote-mcp` uses modern MCP; dedicated `remote` commands add independently authorized OrgBrain login/refresh/logout and pinned search/stage/confirm/status | See [remote client boundaries](ORG_BRAIN_REMOTE_CLIENT.md): dedicated private profile, separately deployed identity endpoint required, headless server device grant and strict refresh reuse detection remain gaps; no silent local fallback |

## Explicit Cloud capture

An already authenticated MCP caller invokes `orgbrain_conversation_memories_stage`
with `conversation` matching `conversation-memory/v1`. Preview is the default.
Execute additionally needs `execute: true` and the unchanged `expected_plan_hash`.
The result reports pending proposal receipts and zero active memories created.
The tool requires the existing OAuth write scope and write permission for the
actual project. Restricted hook allowlists are not expanded.

The shared planner retains the existing limits: 64 KiB envelope, eight bounded
sources and three atomic candidates. It preserves declared roles and source
hashes as provenance, not verified execution evidence. Plan/candidate hashes are
identical between adapters for identical input. The stage token is an identifier,
not authorization: owner, tenant and project checks remain mandatory. Replaying
the same candidate does not renew an expired proposal or create another memory.

After displaying the review, use the existing `orgbrain_memories_confirm` with
the actual human answer and the receipt’s `expected_candidate_hash` and
`expected_revision` (required for newly staged/revised conversation proposals).
Missing, declined or ambiguous answers do not authorize
saving. Re-read `orgbrain_memories_confirmation_status` after uncertainty. Synthetic
test approvals are not evidence of live human review.

CLI preview example, operating only on an explicitly supplied summary file:

```sh
orgbrain memory import conversation --backend remote-mcp --input reviewed-summary.json
```

Execution adds `--execute --expected-plan-hash <preview-hash>`. It consumes
`ORGBRAIN_MCP_URL` (or `--mcp-url`) and an existing access token through
`ORGBRAIN_MCP_OAUTH_ACCESS_TOKEN`. The endpoint must be HTTPS `/mcp`, with no
credentials, query or fragment; redirects are rejected. Transport is bounded
and validates tenant, project, plan and candidate receipts. `remote_receipt_validated`
means transport/receipt consistency only. It does not verify claims or benefit.
Inputs containing fields the preview redacted must be explicitly cleaned and
previewed again before remote execution; their raw forms are not uploaded.

## Natural task search

The additional lane uses lexical morphology and literal identity, with no model
call, invented synonyms or embedding provider. ACL, tenant, project, validity,
lifecycle, source drift, conflicts and business classification constrain the FTS
query before its 50-row bound. Every mandatory subject and every explicit repeated
question must be covered; unknown subjects or insufficient delivery budget yield
an empty result. `task_query.coverage` describes lexical coverage only and
`requires_parent_review` stays true. A question over the existing 500-character
bound is rejected rather than silently dropping its later subjects.

No new claim of recall quality on an unseen corpus or measured token saving is
made. The earlier separate holdout (2/10 positives; all 10 negatives abstained)
does not establish Cloud or QA parity and has not been replaced by this branch's
synthetic contract tests.

For a literal `再開して`, supply `task_context: { project_id, task_key,
subject_query }` and the matching request project/task. Bare or mismatched context
abstains. This explicit subject contract does not discover session state.

## Observation acknowledgement

Deploy additive migration `0046_cloud_use_observation_receipts.sql` before
separately enabling `ORGBRAIN_USE_COLLECT`. The flag remains off by default.
Stateless observe behavior remains available with collection disabled. With it
enabled, `orgbrain_memory_observe.use_observation` creates a private 24-hour opaque
acknowledgement only after validating the exact retrieval item and current source
permissions/version. Extra fields are not stored. It creates no memory, verified
use, effect evaluation or trusted delivery record. Expiry limits validity; no
new cleanup schedule is installed.

`pending_trusted_event_verification` is an explicit gap. Existing Cloud evidence
resolvers accept dedicated canonical task events or already configured scoped
attestations; they do not trust these acknowledgements or a caller's assertion
that execution/delivery occurred. No signing key is configured by this branch.

## Validation boundaries

The automated D1 fixtures apply all checked-in migrations to synthetic in-memory
SQLite and exercise stage/confirm/status, duplicate replay, actual-answer gates,
owner/tenant/project/ACL/version boundaries, natural v4 retrieval and observation
acknowledgements. They do not prove a live D1 migration, native session activation
or real OAuth connectivity. Browser smoke uses the local console and synthetic
mock API; it does not substitute for live authenticated Worker E2E. FFmpeg video
capture remains unavailable under the observed environment download restriction.
The original default local Worker launch failed creating Wrangler's registry in
managed read-only HOME. A subsequent review verified Wrangler's explicit vendor
`WRANGLER_REGISTRY_PATH` setting and started native workerd with its registry in
the writable workspace, without changing HOME/trust/security. Isolated local D1
migrations through 0047 and synthetic REST lifecycle/race/context smoke succeeded. `/mcp` still returns
401 under existing authentication; authenticated real MCP E2E is unverified.
See [review findings and staged playbook design](CLOUD_MEMORY_REVIEW.md) for the
review fixes, implemented lifecycle and typed scope contracts, and precise boundaries.

Production deployment, public push, real DB transfer, Mac dirty-runtime integration,
private QA porting and a trusted Cloud event collector are separate unresolved
steps. No permission or authentication grants were broadened here.
