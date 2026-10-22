# Memory Capture / Harness Compatibility

This repository owns all memory extraction and quality decisions. The shared Astra Harness does not own memory extraction or persistence.

## Contract

- A harness does not emit a dedicated JSON memory envelope and does not call a
  memory API.
- Workspace identity is resolved by project code from the explicit private
  workspace map, then a private repository-root `.orgbrain.local.json` containing only
  `version`, `tenant_id`, and `project_id`. The harness does not read or invent
  this identity; an unmapped project stays unmapped until configured.
- When durable learning occurs, the agent may call the stateless
  `orgbrain_memory_observe` tool up to three times. This is an internal tool
  event, not a user-facing JSON envelope and not a persisted memory write.
- `memory_learning_mode=eager` consumes verified `orgbrain_memory_observe`
  events even when no retrieval miss occurred. This is the preferred generic
  bridge for source-backed knowledge maintenance: observe only an atomic
  confirmed decision or reusable execution lesson with rationale, reuse
  conditions and current-turn evidence. Never mirror the page body or raw source
  corpus into OrgBrain. Existing evidence verification, sensitivity screening,
  deduplication and the three-candidate turn limit remain mandatory.
- Optional LLM Wiki backfill is isolated in the `org-brain-llm-wiki-import`
  skill. Its discovery helper is read-only and returns a successful no-op when
  LLM Wiki is not configured, disabled or its vault is unavailable. Neither
  OrgBrain runtime nor LLM Wiki runtime imports or invokes the other.
- The optional integrated local Knowledge Wiki is a separate feature/model/DB
  under `features.llm_wiki.enabled`, default OFF. It does not import, enable,
  disable or rewrite an external LLM Wiki installation. Its separate maintenance
  context is bounded guidance only, never a transcript reader or generation call.
  See [Local Knowledge Wiki](LOCAL_KNOWLEDGE_WIKI.md).
- The Stop hook scans only the current turn of the existing transcript (from a
  backwards read capped at 4 MiB), verifies successful observe calls against
  real tool/file/user evidence, and sends at most one batch to the known
  capture tool. It does not invoke an LLM, `tools/list`, or tool discovery.
- Stop remains silent when no confirmation candidate exists. When confirm mode
  queues at least one candidate, Codex Stop returns one blocking continuation so
  the same turn can present the confirmation; `stop_hook_active` suppresses any
  second continuation. Fully supported success/failure candidates and source-backed
  decision questions have separate eligibility gates. Decision questions may
  explicitly show unknown rationale or reuse conditions; this does not attest a
  command or adopt the candidate as verified learning. It queues at most three redacted
  confirmation candidates in the private local hook database. The automatic
  continuation or next substantive UserPromptSubmit for that task may inject
  one confirmation batch,
  and no session receives more than one batch.
- Interactive confirmation uses `request_user_input` in Plan mode and
  `request_user_input_async` in ordinary work. An offer is not a shown question,
  and a shown asynchronous question is not an answer. Only successful question
  events consume the one-batch session slot. Save and corrected
  answers must follow `orgbrain_memories_propose` then
  `orgbrain_memories_confirm`; skip answers perform no memory write. Structured
  user choices already held as task commitments are excluded from this prompt.
- Explicit user decision search is a deterministic, candidate-only OR lane in
  the project router. It does not persist memory, invoke an LLM in the hook, or
  add a hook batch; the existing safety screen and verifier remain mandatory.
- Native question-tool answers have a separate deterministic local path in
  `memory_learning_mode=eager`: successful submitted answers become searchable
  task-scoped decisions through the existing local capture store. Replay is
  idempotent and corrected answers revise the same decision. Merely showing a
  question never saves a decision. Asynchronous questions wait for an actual
  matching answer on UserPromptSubmit. This path performs no model inference,
  cloud fallback or transcript read. Confirm/off retain their existing consent
  behavior. See [Question-answer memory](QUESTION_ANSWER_MEMORY.md).
- The optional `coverage/v1` extraction profile changes provider work inside
  that same batch to at most two calls. The Stop hook still invokes no LLM and
  sends at most one batch. See `MEMORY_EXTRACTION_COVERAGE_V1.md`.
- The additional-extraction reader combines consecutive context records for the
  same turn ID before applying the logical-turn byte limit. It excludes instruction
  roles, internal reasoning and direct child coordination and requires a final
  record at Stop. It never joins a different turn or silently crosses workspace
  scope. This changes no harness bootstrap, hook command, external-send gate,
  confirmation protocol, or installed runtime. Read/packing diagnostics are counts
  and reason codes only; they do not establish successful execution or human consent.
- Optional Jev capture selection runs only in local candidate maintenance or
  the separate capture queue worker. Stop performs no Jev inference. Capture
  and retrieval default independently to OFF; verification, confirmation and
  consensus remain authoritative. See [MEMORY_JUDGMENT_JEV.md](MEMORY_JUDGMENT_JEV.md).
- `Status`, `Conclusion`, `Evidence`, and `Gaps` headings are optional hints,
  not a required wire format. Responses without headings follow the same path.
- `Conclusion` and `Evidence` remain useful fallback hints, but final-answer
  claims never attest commands. `Gaps` always sends a learning event to review.
- At most three atomic `decision`, `constraint`, `pitfall`, `preference`, or
  `fact` candidates can be emitted from one hook event.
- Current-turn recall misses, explicit human corrections, tool rejection, and
  repeated identical-operation failures are collected as redacted trigger
  diagnostics in every capture mode. They break ties inside the existing
  semantic priority classes but never establish a decision, outcome, or durable
  memory by themselves. A tool failure is closed automatically only by a later
  successful execution with the same tool name and argument hash; otherwise
  textual or structured outcome evidence remains required.
- Verifier v4 accepts unchanged, relevant workspace code when a current-turn
  successful verification command is observed. A new edit is not evidence of
  reuse. The optional `source:ID@VERSION#Lx-Ly` resolver checks immutable source
  bytes through the configured personal Wiki CLI. This proves source provenance
  only; it never upgrades a historical success report into execution evidence.
- Local schema 32 stores per-turn collection counts and missing-evidence reasons
  in the existing SQLite database. Known fulfilled tool-result envelopes are
  decoded, but wrapper code is never interpreted. Delivery and use remain
  distinct; no observation is not a negative assessment.
- Native PostToolUse may return the actual completed call identifier through
  `hookSpecificOutput.additionalContext` when local use collection is enabled
  and the same scoped task has an unknown reference. Missing/conflicting IDs
  produce no hint. This exposes no raw tool input/output, makes no attribution,
  adds no model call and changes no harness bootstrap or Stop verification gate.
- `tenant_id` on the observe tool is transport routing, not a learning-body
  field. The local MCP adapter removes only that routing key before strict
  validation. Stop receives the authoritative workspace tenant and checks any
  explicit routing tenant before removal; missing or conflicting scope remains
  review-only. Other unknown fields and evidence gaps retain their old gates.
- Automatic capture rejects transient completion reports. Conservative legacy
  cleanup uses native suppression, preserves versions and usage history, and
  never removes explicit decisions, preferences, constraints, or reusable lessons.
- `PreCompact` checkpoints task commitments only; it is not a new-memory
  activation boundary.
- Candidate hashes, category IDs, TTLs, redaction, and rejection reason codes
  are generated by project code and must be identical for local, API, and
  cap-runner adapters.

## Compatibility fixture

[`packages/shared/test/fixtures/memory-capture-v2.json`](../packages/shared/test/fixtures/memory-capture-v2.json)
contains both a harness-shaped response and an ordinary response. It is consumed
by the shared extractor tests and the Stop-hook bridge tests. The cap-runner
parity test also hashes the shared candidate JSON produced from the fixture,
so Local, hook/API, and maintenance adapters cannot silently drift.

The fixture fixes these behaviors:

1. Harness `Evidence` becomes references.
2. Harness `Gaps` lowers confidence.
3. Ordinary responses need no harness envelope.
4. Transient completion reports and unverified self-reported commands produce
   no active candidate.
5. `rationale` and `reuse_rule` remain separate persisted fields.

Ordinary prose may bind labeled reason, reuse/applicability, and evidence lines
to the immediately preceding atomic statement, within the existing three-following-
block context bound. A new heading or durable statement ends that scope. Labeled
support is not a second lesson. Multi-sentence labeled fields stay together;
rationale beyond 1,000 characters or reuse conditions beyond 500 characters retain
the existing storage bounds and receive `support_fields_truncated` in their gaps,
so the unchanged strict-profile gap gate sends them to review. Prose references
remain references, never command attestations.

Rule-complete pitfalls and procedures do not become success/failure confirmation
questions by copying their summary into an outcome. That lane requires the
existing structured observation and current-turn verification. Source-backed
decision questions remain eligible for human review without claiming verified
execution. See the [synthetic lesson replay](MEMORY_EFFICIENCY.md#atomic-lesson-support-replay-2026-10-02).

The UserPromptSubmit hook supplies the optional internal observe instruction.
Changing the global harness remains unnecessary and outside this contract.

The local prompt hook formats relevant failure lessons and past attempts inside
the existing context budget. Verified lessons preserve complete reuse conditions;
legacy lessons and tool exits remain historical references. Packing precedes use
receipts, so omitted entries are not marked injected. No new harness instruction,
LLM call, capture boundary or persistence schema is introduced. See
[turn-start failure context](ACTION_ATTEMPT_HISTORY.md#turn-start-failure-context).

## Human review feedback

`memory_learning_mode=confirm` is the initial Codex rollout setting. Stop stores
only local confirmation candidates for new-memory learning and never captures
new memory, writes its capture outbox, or enqueues extraction, even if extraction
is enabled in the environment.
The subsequent interactive MCP write requires the actual human answer. The
configured backend determines whether that write is local or remote.

`memory-review-feedback/v1` links the immutable confirmation ID, candidate hash,
original source spans/roles/hashes, actual answer, correction, and save receipt.
`not_needed`, `incorrect`, `not_decided`, `deferred`, and `unknown` are separate
labels; only `accepted` or an explicit `修正: …` answer authorizes persistence.
The confirmation API updates body, summary and search text together. Repeating
the same answered confirmation returns its receipt; a different answer requires
a new proposal. Read `orgbrain_memories_confirmation_status` after uncertainty.
For Cloud mode, Remote schema support is required before asking; failure never
silently falls back to a local write. Explicit local mode uses the local MCP's
review-aware propose/confirm/status contract. UserPromptSubmit selects the matching
instructions. Global Astra Harness instructions remain unchanged.

`GET /v1/memory-reviews` returns only the caller's history, optionally scoped by
project, with a stable cursor. The existing `/reviews` page exposes original
text, sources, correction and a paginated JSON export. `orgbrain memory reviews`
shows bounded **local hook observations**, not the canonical cloud history.
`doctor` exposes effective Git-common-repository mapping, runtime paths, hook
activity and phase counts without dumping answer text. Exact workspace overrides
win, including explicit off settings.

`memory-usefulness/v2` uses grounding, applicability, task contribution,
incremental value and information amount for capture and use. Prediction,
human confirmation and observed results are distinct. Unknown is never zero;
a save receipt does not establish task success. Domain Recall feedback persists
this assessment alongside the existing feedback event.

`ORGBRAIN_MEMORY_REFINEMENT_PROFILE=a-plus/v1` carries the profile and the
existing one-to-three source snippets through the one-call v2 path. It cannot be
combined with coverage or v3. Extraction remains off unless separately enabled;
v3's external execution stop and prior held experiments remain unchanged.

Deploy migration `0040_memory_confirmation_reviews.sql` before the updated API.
It adds the private review/receipt table and the Domain Recall assessment column.
Local verification does not establish a deployed, trusted or authenticated hook.

## Evidence-backed use history

The independently opt-in `ORGBRAIN_USE_COLLECT` branch observes use of existing
memories; it does not authorize new-memory capture or turn save confirmation into
a usefulness score. The observe tool accepts `use_observation`
with retrieval/item/version IDs and actual current-turn action/outcome call IDs.
Stop checks those events within the same bounded transcript read, writes local
receipts, and may enqueue sanitized use references only when `ORGBRAIN_USE_SYNC`
is also enabled. Stop performs no additional LLM, discovery, signing, or network
work. The separate `usage sync` worker handles transport and optional attestations.

Retrieval, adoption, execution, and confirmed outcome remain distinct. Ranking
requires verified evidence and explicit contribution assessment; an observed
command failure does not itself mean the memory was harmful. Missing turn markers,
unknown versions, unverified Cloud receipts, and lost source permissions fail
closed. Existing confirmation limits and held experiments remain unchanged.
See [use-history operation](MEMORY_USE_HISTORY.md) and
[validation](MEMORY_USE_HISTORY_VALIDATION.md). Migration `0041` and Local schema
26 are additive. Global harness instructions require no changes.

Local schema 31 adds scoped observation receipts and transcript delivery receipts
to the existing database, plus an explicit usage purpose on retrieval events.
Wrapped MCP calls are recognized only through an opaque receipt issued by the
local MCP handler and present in a completed outer tool result. The collector
never interprets JavaScript or quoted tool invocations. Direct MCP calls remain
supported. Only developer delivery receipts after the latest compaction may
cross a turn boundary (at most 32); action and assessment evidence must still be
from the current turn. The 4 MiB read bound, task identity, source version and
principal checks remain mandatory. Missing evidence remains unassessed.
Receipt issuance is bookkeeping, not memory capture, verified use or a benefit
evaluation. The hook invokes no model or new network call. Existing commitments,
confirmation controls and bootstrap contract do not change.

## Local confirmation receipts (schema 27)

Local `orgbrain_memories_propose` preserves the displayed conclusion, reason,
reuse conditions and source references in `review_context`. The matching confirm
requires the actual `review_answer`; a save selection does not authorize changing
the displayed content. Explicit corrections require corrected content. Decline,
undecided and ambiguous answers never authorize a write.

The memory and its immutable receipt are committed in one SQLite transaction.
The same token and answer return the same receipt after restart; changing the
answer requires a new proposal. `orgbrain_memories_confirmation_status` reads
pending/expired proposals or completed receipts. Raw confirmation tokens are not
stored in these tables. Existing hook receipt processing correlates the candidate,
question, answer and save result for both backends.

`confirm` mode also injects the stateless observe instruction. Stop remains silent
and queues candidates only; the next substantive prompt may offer one batch of up
to three questions per session. This is conditional collection, not a question on
every turn and not approval-free storage. The current session must have loaded the
configured local MCP before it can execute the local tools.

`scripts/local-memory-confirmation-flow.test.mjs` exercises actual hook subprocesses
and strict local MCP across restarts with network access replaced by a failing
sentinel. Question answers in this test are fixtures, not evidence that a live
Codex user has seen or accepted a question.

## Action attempt history (Local schema 29 / Cloud migration 0043)

Action attempts are append-only records separate from extracted memories and
confirmation candidates. A record has an action and target, normalized conditions,
actual time and outcome, distinct requester and executor fields, and references to
the source event and its hash. Corrections append a new record with `supersedes_id`;
the original remains available for audit. Only a trusted collector with a source
result can mark an attempt verified. Public MCP reports stay reported and cannot
assert another person's identity. Imported Codex tool results are verified as
*tool outcomes*, not as failed interventions; they have unknown failure kind and
never create deterministic failure patterns by themselves. The ConsentSide
import first writes a private, hashed dry-run plan and checks that plan again
before applying it. Raw command output and full conversation text are excluded.

`orgbrain_context_enrich` returns a bounded, independently searched
`prior_attempts` list in addition to memories. Its `returned` event is separate
from the optional injection event and from later adoption, execution and checked
result. Each context query records whether history was returned. Preflight
decisions retain an event ID for correct/false block feedback. Reported feedback
and source-verified false blocks are separate counts. The project report also
exposes confirmed same-condition reexecutions, verified adoption and opaque hook coverage; rates
remain unknown when their denominator is zero. Only source-backed, verified uses
may establish an actual effect.
`orgbrain_action_preflight` shares the same decision code between Local and Cloud:
a verified deterministic intervention failure with identical known conditions
blocks until later verified success or correction; changed conditions require a
stated hypothesis. Missing conditions, reported failures and opaque tool actions
warn instead. "No accessible prior attempt" describes only visible records.

The Codex PreToolUse/PostToolUse adapter covers direct supported tools and a
statically inspectable subset of wrapper calls. It records a structured failed
tool result immediately, even if the task later succeeds. Opaque operations are
counted as coverage gaps, not counted as prevented failures. This adapter does
not change Stop capture, the global Astra Harness, or interactive memory
confirmation. It is enabled only for project IDs explicitly listed in the local
`ORGBRAIN_ATTEMPT_HOOK_PROJECTS` environment setting. Cloud activation requires a trusted event collector, migration,
permission checks and a successful local pilot before deployment.

## Agent activity observation (Local schema 30)

The optional local Jev cost profile adds Wiki assessment and dependency-scoped
question batching to existing capture/use. Stop still queues only and does not
run inference. Search records returned items after qualified selection;
audit/diagnostic/test keep the complete comparison set. Uncertainty and provider
failure preserve originals. A batch-capable external quarantine runner may
review eligible candidates together, retaining per-candidate verification and
consensus. This adds no Cloud tool or migration and changes no harness bootstrap
or confirmation contract. See [Jev cost profile](MEMORY_JUDGMENT_JEV.md).

`agent-activity/v1` adds an append-only, metadata-only timeline beside memory and
action-attempt history. It normalizes session, tool, command, file, approval,
MCP, model and token observations from supported harnesses. Prompt bodies, raw
commands, absolute paths, tool arguments and tool output are never written to
the activity table; only bounded classifications, byte counts and hashes are
retained. A configured hook is not considered live until a matching event is
observed.

Activity events may be cited as source references, but do not authorize a
memory write or make an extracted claim true. Same-tenant and same-project
validation is mandatory. Skill preview/install likewise accepts only verified
or explicitly user-confirmed memory and never overwrites an existing file by
default. See [Agent activity v1](AGENT_ACTIVITY_V1.md) for the event contract,
CLI, connector inventory, security fixtures and rollout gates.

## Explicit conversation-event adapter

The separately invoked local `conversation-memory/v1` importer stages bounded
caller-supplied source summaries for review. It cannot read dot/task-platform
conversation events and installing Stop hooks does not enable that access.
Pending candidates are not active memories. Existing propose/actual-human-answer/
confirm gates remain in force, and supplied worker/tool excerpts do not become
verified execution evidence. See [explicit bridge](CONVERSATION_MEMORY_BRIDGE.md).

### Extraction support retention (2026-10-18)

Rule extraction keeps adjacent reasons and limiting exceptions in the existing
rationale/reuse fields. Explicit reported verification is carried separately as
`learning.reported_verification` with state `unverified`; the capture payload
uses the API's existing top-level `verification_state: unverified`. This is
reported context, not a tool attestation. Existing hooks, bootstrap, confirmation,
eager retrieval/action gates and provider default-off/allowlist gates stay intact.

V2 provider candidates are checked again after normalization, including length
limits. A cited reason, qualifier, result or supplied content value that disappears
causes an explicit rejection. Multiple exact quotations in scalar content fields
are preserved together. This does not activate or change the held v3 profile.
See `artifacts/extraction-retention-20261018/Report.md` for the fixed real-data
replay, controlled conversion tests and unverified model/production quality gates.

### 2026-10-19: 共通セッション再抽出

- `extraction-hooks` の Stop は Claude/Cursor/Codex 共通の非公開キューに渡す。フックから生成APIを直接呼ばず、ローカルの別ワーカー/既存autonomy実行がHaiku 5.5 mediumを呼ぶ。Codex CLIは不要。導入時のSonnet 5.5 lowによる測定は過去の記録として保持する。
- 本文の無いLLM候補を共有検証器で拒否する。任意の空項目は他の有効な本文を消さない。`reported_verification` は契約v2の任意の本文項目で、常にunverified。共有検証器版はv5、スキーマと契約ハッシュを更新した。
- キューはinput/contractの版を照合し、不明な呼び出しを自動再送しない。理由・条件を含む関連文は切り詰めず、上限超過を保留にする。保存時の安全処理で本文が変わる候補も保留にする。
- この経路の候補はquarantineかつautomatic_promotion=false。既存の自律メンテナンスからも自動昇格しない。既存の確認済み記憶を書き換える移行処理はない。
- 設定、クライアント終了イベント、API呼び出し、候補保存、実行証明、active化は別の状態。[実データ比較](../artifacts/shared-extraction-20261019/Report.md)を参照。

### 共通抽出ワーカーのStop後自動起動

`ORGBRAIN_SESSION_EXTRACTION_AUTORUN=true` は明示的なローカル設定で、既定は無効。通常Stopはキュー投入後に導入済みNode/CLIの別プロセスを起動するだけで、フック内の推論・ネットワーク禁止、confirmモード、対象allowlist、秘密除外を維持する。ワーカーの排他は手動/autonomy経路にも共通で、終了時の未処理確認と解除を原子的に行う。不明なrunningジョブを再送せず、API失敗・予算切れ・例外は自動継続しない。自動化は候補のactive化やグローバルハーネス変更を含まない。
